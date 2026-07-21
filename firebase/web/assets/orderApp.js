import {
  addDoc,
  auth,
  collection,
  db,
  doc,
  functions,
  getDoc,
  getDocs,
  httpsCallable,
  onAuthStateChanged,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch
} from "./firebaseClient.js";
import {
  buildCustomerId,
  buildDepositEventId,
  buildOrderId,
  buildPaymentId,
  computeDepositBreakdown,
  containerReturnProofProblem,
  containerReturnProofType,
  describeDepositBalanceProblem,
  formatCurrency,
  isBrokenDepositBalance,
  localDateKey,
  mergeThresholds,
  normalizePhone,
  paymentStatusFor,
  requireRole,
  setDeliveryWindow,
  todayKey,
  withSubmitLock
} from "./shared.js";
import { attachQrToPreview, buildEmailShare, buildWhatsAppShare, generateInvoicePdf, invoiceContext, renderInvoiceHtml } from "./invoice.js";
import { uploadContainerReturnProof, uploadPaymentProof, validateProofFile } from "./storageUploads.js";
import { mapsApiKey } from "./firebaseWebConfig.js";
import { createEditOrderAddressController } from "./editOrderAddress.js";

const el = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value == null ? "" : value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const orderId = new URLSearchParams(location.search).get("id") || "";
const mergeCustomersFn = httpsCallable(functions, "mergeCustomers");
const recordOrderRefundFn = httpsCallable(functions, "recordOrderRefund");
const resolveOrderCancellationFn = httpsCallable(functions, "resolveOrderCancellation");
let currentInvoiceContext = null;
const state = {
  order: null,
  customer: {},
  items: [],
  payments: [],
  deposits: [],
  cancellationCases: [],
  products: [],
  drivers: [],
  thresholds: mergeThresholds({})
};

function humanize(value) { return String(value || "Not recorded").replace(/_/g, " "); }
function dateValue(value) {
  if (!value) return "Not recorded";
  if (typeof value?.toDate === "function") return value.toDate().toLocaleString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleString();
}
function empty(text) { return `<div class="card muted order-record-empty">${escapeHtml(text)}</div>`; }
function eventCard(title, fields, actions = "") {
  return `<article class="card order-event-card"><strong>${escapeHtml(title)}</strong><dl>${fields.filter(([, value]) => value !== null && value !== undefined && value !== "").map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl>${actions ? `<div class="button-row">${actions}</div>` : ""}</article>`;
}

function safeExternalUrl(value) {
  const candidate = String(value || "").trim();
  if (!candidate) return "";
  try {
    const parsed = new URL(candidate, location.href);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : "";
  } catch {
    return "";
  }
}

function documentUrl(documentRecord) {
  return safeExternalUrl(documentRecord?.downloadUrl) || safeExternalUrl(documentRecord?.driveLink);
}

function documentLabel(documentType) {
  const labels = {
    invoice: "Invoice",
    order_confirmation: "Order confirmation",
    payment_proof: "Payment proof"
  };
  return labels[documentType] || humanize(documentType || "Document");
}

function humanFileSize(value) {
  if (value === null || value === undefined || value === "") return null;
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function renderDocumentCard(documentRecord) {
  const label = documentLabel(documentRecord.documentType);
  const url = documentUrl(documentRecord);
  const isImage = /^image\//i.test(documentRecord.contentType || "") || documentRecord.documentType === "payment_proof";
  const fileName = String(documentRecord.storagePath || "").split("/").filter(Boolean).pop() || null;
  const openLabel = documentRecord.documentType === "payment_proof" ? "Open proof" : "Open document";
  const action = url ? `<a class="button-link secondary" href="${escapeHtml(url)}" target="_blank" rel="noopener">${openLabel}</a>` : "";
  const preview = isImage && url ? `<div class="order-invoice-preview"><a href="${escapeHtml(url)}" target="_blank" rel="noopener"><img src="${escapeHtml(url)}" alt="${escapeHtml(label)} ${escapeHtml(documentRecord.id)}" loading="lazy" style="display:block;max-width:100%;max-height:70vh;margin:0 auto;object-fit:contain"></a></div>` : "";
  const source = documentRecord.downloadUrl ? "Firebase Storage" : documentRecord.driveLink ? "Google Drive" : "Link unavailable";
  return `<article class="card order-event-card">
    <div class="order-record-heading"><div><span class="pill">${escapeHtml(label)}</span><strong>${escapeHtml(fileName || documentRecord.id)}</strong></div>${action}</div>
    ${preview}
    <dl>${[["Document ID", documentRecord.id], ["Uploaded", dateValue(documentRecord.uploadedAt)], ["Payment ID", documentRecord.paymentId], ["File type", documentRecord.contentType], ["Size", humanFileSize(documentRecord.sizeBytes)], ["Source", source], ["Notes", documentRecord.notes]].filter(([, value]) => value !== null && value !== undefined && value !== "").map(([fieldLabel, value]) => `<div><dt>${escapeHtml(fieldLabel)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl>
    ${url ? "" : `<p class="muted">This record has no usable web link.</p>`}
  </article>`;
}

async function loadLinkedDocuments(orderDocumentsSnap, payments) {
  const linked = orderDocumentsSnap.docs
    .map((row) => ({ id: row.id, ...row.data() }))
    .filter((row) => !row.entityType || row.entityType === "order");
  const proofPaymentByDocumentId = new Map();
  payments.forEach((payment) => {
    if (payment.proofDocumentId) proofPaymentByDocumentId.set(payment.proofDocumentId, payment.id);
  });
  const proofSnaps = await Promise.all([...proofPaymentByDocumentId.keys()].map((documentId) => getDoc(doc(db, "documents", documentId))));
  proofSnaps.forEach((snapshot) => {
    if (!snapshot.exists()) return;
    const data = snapshot.data();
    linked.push({ id: snapshot.id, ...data, paymentId: proofPaymentByDocumentId.get(snapshot.id) || data.entityId || null });
  });
  const resolvedById = new Map(linked.map((row) => [row.id, row]));
  payments.forEach((payment) => {
    if (!payment.proofUrl) return;
    const resolved = payment.proofDocumentId ? resolvedById.get(payment.proofDocumentId) : null;
    if (resolved) {
      resolved.paymentId = resolved.paymentId || payment.id;
      if (!documentUrl(resolved)) resolved.downloadUrl = payment.proofUrl;
      return;
    }
    linked.push({
      id: payment.proofDocumentId || `payment-proof-${payment.id}`,
      entityType: "payment",
      entityId: payment.id,
      paymentId: payment.id,
      documentType: "payment_proof",
      downloadUrl: payment.proofUrl,
      uploadedAt: payment.createdAt || payment.paymentDate || null,
      notes: "Payment record link"
    });
  });
  return [...new Map(linked.map((row) => [row.id, row])).values()];
}

async function loadOrderRecord() {
  if (!orderId) throw new Error("No order ID was provided.");
  const orderSnap = await getDoc(doc(db, "orders", orderId));
  if (!orderSnap.exists()) throw new Error("Order not found.");
  const order = { id: orderSnap.id, ...orderSnap.data() };
  const [itemsSnap, paymentsSnap, depositsSnap, returnsSnap, correctionsSnap, orderDocumentsSnap, customerSnap, settingsSnap, productsSnap, driversSnap, cancellationCasesSnap] = await Promise.all([
    getDocs(query(collection(db, "orderItems"), where("orderId", "==", orderId))),
    getDocs(query(collection(db, "payments"), where("orderId", "==", orderId))),
    getDocs(query(collection(db, "depositEvents"), where("orderId", "==", orderId))),
    getDocs(query(collection(db, "returns"), where("orderId", "==", orderId))),
    getDocs(query(collection(db, "orderCorrections"), where("orderId", "==", orderId))),
    getDocs(query(collection(db, "documents"), where("entityId", "==", orderId))),
    order.customerId ? getDoc(doc(db, "customers", order.customerId)) : Promise.resolve(null),
    getDoc(doc(db, "settings", "business")),
    getDocs(query(collection(db, "products"), where("active", "==", true))),
    getDocs(query(collection(db, "drivers"))),
    getDocs(query(collection(db, "orderCancellations"), where("orderId", "==", orderId)))
  ]);
  const customer = customerSnap?.exists() ? customerSnap.data() : {};
  const items = itemsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const payments = paymentsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const deposits = depositsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const settings = settingsSnap.exists() ? settingsSnap.data() : {};
  const documents = await loadLinkedDocuments(orderDocumentsSnap, payments);
  state.order = order;
  state.customer = customer;
  state.items = items;
  state.payments = payments;
  state.deposits = deposits;
  state.products = productsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  state.drivers = driversSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  state.cancellationCases = cancellationCasesSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  state.thresholds = mergeThresholds(settings.thresholds);
  await renderOrder(order, customer, items, payments, deposits, returnsSnap.docs.map((d) => ({ id: d.id, ...d.data() })), correctionsSnap.docs.map((d) => ({ id: d.id, ...d.data() })), documents, settings);
}

async function renderOrder(order, customer, items, payments, deposits, returns, corrections, documents, settings) {
  const status = order.status || "unknown";
  const payStatus = order.paymentStatus || "unpaid";
  el("order-headline").textContent = order.id;
  el("order-subline").textContent = `Order for ${order.customerName || customer.name || "Unknown customer"} · delivery ${order.deliveryDate || "not scheduled"}`;
  const customerHref = order.customerId ? `./customer.html?id=${encodeURIComponent(order.customerId)}` : "";
  el("order-summary").innerHTML = `
    <div class="order-record-heading"><div><span class="badge status-${escapeHtml(status)}">${escapeHtml(humanize(status))}</span> <span class="badge pay-${escapeHtml(payStatus)}">${escapeHtml(humanize(payStatus))}</span></div><div class="button-row">${customerHref ? `<a class="button-link primary" href="${customerHref}">Open customer</a>` : ""}</div></div>
    <div class="order-record-grid"><div><span>Customer</span><strong>${escapeHtml(order.customerName || customer.name || "Unknown")}</strong><small>${escapeHtml(order.phone || customer.phone || "No phone")}${order.email || customer.email ? `<br>${escapeHtml(order.email || customer.email)}` : ""}</small></div><div><span>Delivery</span><strong>${escapeHtml(order.deliveryDate || "Not scheduled")}</strong><small>${escapeHtml(order.deliveryWindow || "No window")}</small></div><div class="order-record-address"><span>Delivery address</span><strong>${escapeHtml(order.address || "Not recorded")}</strong></div></div>
    ${order.notes ? `<div class="order-record-notes"><span>Order notes</span><p>${escapeHtml(order.notes)}</p></div>` : ""}`;
  renderOrderActions(order);
  renderCancellationPanel();
  el("order-item-rows").innerHTML = items.length ? items.map((item) => `<tr><td>${escapeHtml(item.productName || item.productId || "Unknown item")}<div class="muted">${escapeHtml(item.productId || "")}</div></td><td style="text-align:right">${Number(item.quantity || 0)}</td><td style="text-align:right">${escapeHtml(formatCurrency(item.unitPrice))}</td><td style="text-align:right"><strong>${escapeHtml(formatCurrency(item.lineTotal))}</strong></td></tr>`).join("") : `<tr><td colspan="4" class="muted">No item records found.</td></tr>`;
  el("order-money").innerHTML = [["Subtotal", order.subtotal], ["Container deposits", order.depositTotal], ["Paid", order.amountPaid], ["Balance due", order.balanceDue]].map(([label, value]) => `<div><span>${label}</span><strong>${escapeHtml(formatCurrency(value))}</strong></div>`).join("");
  const documentsById = new Map(documents.map((documentRecord) => [documentRecord.id, documentRecord]));
  el("order-payments").innerHTML = payments.length ? payments.sort((a,b) => String(b.paymentDate || b.createdAt || "").localeCompare(String(a.paymentDate || a.createdAt || ""))).map((p) => {
    const proofUrl = safeExternalUrl(p.proofUrl) || documentUrl(documentsById.get(p.proofDocumentId));
    const action = proofUrl ? `<a class="button-link secondary" href="${escapeHtml(proofUrl)}" target="_blank" rel="noopener">Open payment proof</a>` : "";
    return eventCard(`${formatCurrency(p.amount)} · ${humanize(p.method)}`, [["Payment ID", p.id], ["Date", p.paymentDate || dateValue(p.createdAt)], ["Reference", p.reference], ["Received by", p.receivedBy], ["Proof document ID", p.proofDocumentId], ["Notes", p.notes]], action);
  }).join("") : empty("No payment events recorded.");
  el("order-documents").innerHTML = documents.length ? [...documents].sort((a, b) => eventTime(b.uploadedAt) - eventTime(a.uploadedAt)).map(renderDocumentCard).join("") : empty("No uploaded invoices or payment proofs are linked to this order.");
  el("order-deposits").innerHTML = deposits.length ? deposits.map((d) => eventCard(`${humanize(d.eventType)} · ${Number(d.qty || 0)} ${humanize(d.containerType)}`, [["Event ID", d.id], ["Date", d.eventDate || dateValue(d.createdAt)], ["Amount", formatCurrency(d.amount)], ["Notes", d.notes]])).join("") : empty("No container deposit events recorded.");
  el("order-returns").innerHTML = returns.length ? returns.map((r) => eventCard(`${Number(r.qty || 0)} ${humanize(r.containerType)} returned`, [["Return ID", r.id], ["Returned", r.returnedAt || r.returnDate], ["Condition", humanize(r.condition)], ["Notes", r.notes]])).join("") : empty("No returns recorded for this order.");
  renderAuditTimeline(order, payments, deposits, returns, corrections, documents);
  const metadata = [["Order ID", order.id], ["Customer ID", order.customerId], ["Source", humanize(order.sourceChannel)], ["Created", dateValue(order.createdAtServer || order.createdAt)], ["Updated", dateValue(order.updatedAt)], ["Assigned driver ID", order.assignedDriverId], ["Auth UID", order.authUid], ["Delivery location", order.deliveryLocation ? `${order.deliveryLocation.lat}, ${order.deliveryLocation.lng}` : null], ["Cancellation reason", order.cancellationReason]];
  el("order-metadata").innerHTML = metadata.filter(([, value]) => value !== null && value !== undefined && value !== "").map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("");
  currentInvoiceContext = invoiceContext({ order, items, settings, payments, deposits });
  const invoiceSlot = el("order-invoice-preview");
  invoiceSlot.innerHTML = renderInvoiceHtml(currentInvoiceContext);
  await attachQrToPreview(currentInvoiceContext, invoiceSlot);
  el("order-invoice-download").disabled = false;
  const emailHref = buildEmailShare(currentInvoiceContext);
  el("order-invoice-email").classList.toggle("hidden", !emailHref);
  const whatsappHref = buildWhatsAppShare(currentInvoiceContext);
  el("order-invoice-whatsapp").classList.toggle("hidden", !whatsappHref);
  if (whatsappHref) el("order-invoice-whatsapp").href = whatsappHref;
  el("order-load-status").textContent = "";
}

function setActionStatus(message, isError = false) {
  const node = el("order-action-status");
  node.textContent = message || "";
  node.style.color = isError ? "var(--danger, #b3261e)" : "var(--muted)";
}

function phoneDialHref(phone) {
  const raw = String(phone || "").trim();
  const digits = raw.replace(/\D/g, "");
  if (!digits) return "";
  return `tel:${raw.startsWith("+") ? "+" : ""}${digits}`;
}

function driverOptions(order) {
  return `<label class="muted" style="display:flex;align-items:center;gap:6px">Driver
    <select data-order-driver aria-label="Assigned driver">
      <option value="">Unassigned</option>
      ${state.drivers.map((driver) => `<option value="${escapeHtml(driver.id)}" ${driver.id === order.assignedDriverId ? "selected" : ""}>${escapeHtml(driver.driverName)}</option>`).join("")}
    </select>
  </label>`;
}

function renderOrderActions(order) {
  const actionsNode = el("order-actions");
  const cancellationNode = el("order-cancellation-request");
  const editButton = `<button class="ghost" type="button" data-order-action="edit">Edit details</button>`;
  const invoiceButton = `<button class="ghost" type="button" data-order-action="invoice">Invoice</button>`;
  const cancelButton = `<button class="ghost" type="button" data-order-action="cancel">Cancel order</button>`;
  const callHref = phoneDialHref(order.phone || state.customer.phone);
  const callButton = callHref ? `<a class="button-link secondary" href="${escapeHtml(callHref)}">Call customer</a>` : "";

  cancellationNode.innerHTML = order.cancellationRequested ? `
    <div class="cancellation-request" style="margin-bottom:12px">
      <strong>Cancellation requested</strong>${order.cancellationRequestReason ? ` — ${escapeHtml(order.cancellationRequestReason)}` : ""}
      <div class="button-row" style="margin-top:8px">
        <button class="primary" type="button" data-order-action="approve-cancel">Approve cancel</button>
        <button class="ghost" type="button" data-order-action="dismiss-cancel">Dismiss</button>
      </div>
    </div>` : "";

  switch (order.status) {
    case "pending_approval":
      actionsNode.innerHTML = `<button class="primary" type="button" data-order-action="approve">Approve</button>${editButton}${invoiceButton}${cancelButton}`;
      break;
    case "new":
      actionsNode.innerHTML = `${driverOptions(order)}${editButton}${invoiceButton}${cancelButton}`;
      break;
    case "assigned":
      actionsNode.innerHTML = `${driverOptions(order)}<button class="primary" type="button" data-order-action="out-for-delivery">Send out for delivery</button>${editButton}${invoiceButton}${cancelButton}`;
      break;
    case "out_for_delivery":
      actionsNode.innerHTML = `<button class="primary" type="button" data-order-action="deliver">Mark delivered &amp; record payment</button>${invoiceButton}${cancelButton}${callButton}`;
      break;
    case "delivered":
      actionsNode.innerHTML = `<span class="muted">Delivered</span>${invoiceButton}`;
      break;
    case "cancelled":
      actionsNode.innerHTML = `<span class="muted">Cancelled${order.cancellationReason ? ` — ${escapeHtml(order.cancellationReason)}` : ""}</span>`;
      break;
    default:
      actionsNode.innerHTML = `<span class="muted">Unknown status: ${escapeHtml(order.status)}</span>`;
  }

  actionsNode.querySelector("[data-order-driver]")?.addEventListener("change", async (event) => {
    await runActionControl(event.currentTarget, "Updating driver…", async () => {
      await assignDriver(event.currentTarget.value);
      await loadOrderRecord();
      setActionStatus("Driver updated.");
    });
  });

  document.querySelectorAll("[data-order-action]").forEach((button) => {
    button.addEventListener("click", handleOrderAction);
  });
}

function setCancellationStatus(message, isError = false) {
  const node = el("order-cancellation-status");
  if (!node) return;
  node.textContent = message || "";
  node.style.color = isError ? "var(--danger, #b3261e)" : "var(--muted)";
}

function refundMethodOptions() {
  return [["refund_bank", "Bank transfer"], ["refund_qr", "QR code"], ["refund_cash", "Cash"], ["refund_wallet", "Wallet"]]
    .map(([value, label]) => `<option value="${value}">${label}</option>`).join("");
}

// Read-only display of the order's cancellation case(s) plus the owner refund
// actions. Additive — does NOT touch the existing cancel/emitDepositReversalsFor
// flow. The cancel-creation switch waits on server-side deposit charge_reversed.
function renderCancellationPanel() {
  const panel = el("order-cancellation-panel");
  const body = el("order-cancellation-body");
  if (!panel || !body) return;
  const cases = state.cancellationCases || [];
  if (!cases.length) {
    panel.hidden = true;
    body.innerHTML = "";
    return;
  }
  panel.hidden = false;

  const refundsByCase = {};
  (state.payments || []).forEach((p) => {
    if (p.cancellationCaseId) {
      (refundsByCase[p.cancellationCaseId] = refundsByCase[p.cancellationCaseId] || []).push(p);
    }
  });

  body.innerHTML = [...cases]
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    .map((c) => renderCancellationCase(c, refundsByCase[c.id] || []))
    .join("");

  body.querySelectorAll("form[data-refund-case]").forEach((form) => form.addEventListener("submit", handleRecordRefund));
  body.querySelectorAll("[data-resolve-case]").forEach((btn) => btn.addEventListener("click", handleResolveCase));
}

function renderCancellationCase(c, refunds) {
  const required = Number(c.refundRequired || 0);
  const remaining = Number(c.refundRemaining || 0);
  const deltas = Array.isArray(c.lineDeltas) ? c.lineDeltas.filter((d) => d && Number(d.delta) < 0) : [];
  const removed = deltas.length
    ? `<div class="muted" style="margin-top:6px">Removed: ${deltas.map((d) => `${Math.abs(Number(d.delta))}× ${escapeHtml(d.name || d.productId || "item")}`).join(", ")}</div>`
    : "";

  const refundRows = [...refunds]
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    .map((p) => `<div class="muted">${escapeHtml(formatCurrency(Math.abs(Number(p.amount || 0))))} · ${escapeHtml(humanize(p.method))}${p.reference ? ` · ${escapeHtml(p.reference)}` : ""} · ${escapeHtml(p.paymentDate || dateValue(p.createdAt))} · ${p.proofDocumentId ? "proof ✓" : "proof missing"}</div>`)
    .join("");
  const refundList = refundRows ? `<div class="stack" style="margin-top:8px">${refundRows}</div>` : "";

  const meta = [
    ["Case", c.id], ["Kind", humanize(c.kind)], ["Decision", humanize(c.decisionStatus)],
    ["Refund status", humanize(c.refundStatus)], ["Evidence", humanize(c.evidenceStatus)],
    ["Source", humanize(c.source)], ["Reason", c.reason]
  ].filter(([, v]) => v != null && v !== "")
    .map(([k, v]) => `<div><span>${escapeHtml(k)}</span><strong>${escapeHtml(v)}</strong></div>`).join("");

  const money = required > 0
    ? `<div class="order-record-money" style="margin-top:8px"><div><span>Refund required</span><strong>${escapeHtml(formatCurrency(required))}</strong></div><div><span>Refund remaining</span><strong>${escapeHtml(formatCurrency(remaining))}</strong></div></div>`
    : "";

  let actions = "";
  if (c.decisionStatus === "requested") {
    actions = `<div class="button-row" style="margin-top:10px">
      <button class="primary" type="button" data-resolve-case="${escapeHtml(c.id)}" data-decision="approve">Approve cancellation</button>
      <button class="ghost" type="button" data-resolve-case="${escapeHtml(c.id)}" data-decision="dismiss">Dismiss request</button>
    </div>`;
  } else if (c.decisionStatus === "approved" && remaining > 0) {
    actions = `<form class="button-row" data-refund-case="${escapeHtml(c.id)}" style="margin-top:10px;flex-wrap:wrap;gap:8px;align-items:flex-end">
      <label class="muted" style="display:flex;flex-direction:column;gap:2px">Amount<input type="number" name="amount" min="1" max="${remaining}" step="1" required style="width:130px"></label>
      <label class="muted" style="display:flex;flex-direction:column;gap:2px">Method<select name="method">${refundMethodOptions()}</select></label>
      <label class="muted" style="display:flex;flex-direction:column;gap:2px">Reference<input type="text" name="reference" maxlength="300" placeholder="optional"></label>
      <button class="primary" type="submit">Record refund</button>
    </form>`;
  }

  return `<div style="border:1px solid var(--border,#e2e2e2);border-radius:10px;padding:12px">
    <div class="order-record-grid">${meta}</div>${removed}${money}${refundList}${actions}
  </div>`;
}

async function handleRecordRefund(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const caseId = form.dataset.refundCase;
  const amount = Math.floor(Number(form.elements.amount.value || 0));
  const method = form.elements.method.value;
  const reference = (form.elements.reference?.value || "").trim() || null;
  if (!(amount > 0)) {
    setCancellationStatus("Enter a positive refund amount.", true);
    return;
  }
  const submitBtn = form.querySelector("button[type=submit]");
  await runActionControl(submitBtn, "Recording refund…", async () => {
    const refundId = (self.crypto && self.crypto.randomUUID)
      ? self.crypto.randomUUID()
      : `rf-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    await recordOrderRefundFn({ caseId, refundId, amount, method, reference });
    await loadOrderRecord();
    setCancellationStatus("Refund recorded.");
  });
}

async function handleResolveCase(event) {
  const btn = event.currentTarget;
  const caseId = btn.dataset.resolveCase;
  const decision = btn.dataset.decision;
  const verb = decision === "approve" ? "Approve" : "Dismiss";
  if (!confirm(`${verb} this cancellation request?`)) return;
  await runActionControl(btn, `${verb === "Approve" ? "Approving" : "Dismissing"}…`, async () => {
    await resolveOrderCancellationFn({ caseId, decision });
    await loadOrderRecord();
    setCancellationStatus(`Cancellation ${decision === "approve" ? "approved" : "dismissed"}.`);
  });
}

async function runActionControl(control, busyMessage, action) {
  if (control?.disabled) return;
  if (control) control.disabled = true;
  setActionStatus(busyMessage);
  try {
    await action();
  } catch (error) {
    setActionStatus(error.message || String(error), true);
  } finally {
    if (control && document.contains(control)) control.disabled = false;
  }
}

async function handleOrderAction(event) {
  const control = event.currentTarget;
  const action = control.dataset.orderAction;
  if (action === "invoice") {
    document.querySelector(".order-invoice-section")?.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  if (action === "edit") {
    await openEditDialog(state.order);
    return;
  }
  if (action === "deliver") {
    await openDeliveryPaymentDialog(state.order);
    return;
  }
  if (action === "cancel") {
    const reason = prompt("Reason for cancelling this order? (optional — leave blank if none). It is stored on the order for audit review.");
    if (reason === null) return;
    await runActionControl(control, "Cancelling order…", async () => {
      await cancelOrder(reason);
      await loadOrderRecord();
      setActionStatus("Order cancelled.");
    });
    return;
  }
  if (action === "approve-cancel") {
    if (!confirm("Approve the customer's cancellation request? The order will be marked cancelled.")) return;
    await runActionControl(control, "Approving cancellation…", async () => {
      await approveCancellationRequest();
      await loadOrderRecord();
      setActionStatus("Cancellation approved.");
    });
    return;
  }
  if (action === "dismiss-cancel") {
    if (!confirm("Dismiss the cancellation request? The order stays active — you should follow up with the customer.")) return;
    await runActionControl(control, "Dismissing request…", async () => {
      await dismissCancellationRequest();
      await loadOrderRecord();
      setActionStatus("Cancellation request dismissed.");
    });
    return;
  }
  if (action === "approve") {
    await runActionControl(control, "Approving order…", async () => {
      await approveOrder();
      await loadOrderRecord();
      setActionStatus("Order approved.");
    });
    return;
  }
  if (action === "out-for-delivery") {
    await runActionControl(control, "Updating order…", async () => {
      await updateOrderStatus("out_for_delivery");
      await loadOrderRecord();
      setActionStatus("Order is out for delivery.");
    });
  }
}

function canLinkAuthUidToCustomer(order, existingData) {
  return Boolean(order.authUid) && (!existingData || existingData.authUid === order.authUid);
}

async function upsertCustomerFromOrder(order) {
  // P0-04: key on the order's uid-anchored customerId (set by submitPublicOrder
  // from the auth uid), NOT a phone-derived id. Mirrors the dashboard approval
  // path in adminApp.js — re-deriving from order.phone let a typo point approval
  // at a stranger's record and overwrite their profile.
  const customerId = order.customerId
    || (order.authUid ? `CUS-${order.authUid}` : buildCustomerId(order.phone));
  if (!customerId) return { customerId: "", createdNew: false, linkedAuthUid: false };
  const ref = doc(db, "customers", customerId);
  const existing = await getDoc(ref);
  const existingData = existing.exists() ? existing.data() : null;
  // Never overwrite a record that belongs to a different sign-in (belt-and-braces
  // — the uid anchoring above already prevents it). Surfaces to the approve catch.
  if (existingData && existingData.authUid && order.authUid && existingData.authUid !== order.authUid) {
    throw new Error(`This order resolves to customer ${customerId}, which belongs to a different sign-in. Approval stopped to avoid overwriting another customer — investigate a possible id/phone collision.`);
  }
  const canLinkAuthUid = canLinkAuthUidToCustomer(order, existingData);
  const payload = {
    name: order.customerName,
    billingName: null,
    phone: normalizePhone(order.phone),
    secondaryPhone: null,
    taxId: null,
    address: order.address,
    area: null,
    addressHistory: order.address,
    notes: null,
    lastSourceChannel: order.sourceChannel,
    lastOrderAt: order.deliveryDate,
    orderCount: 1,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  };
  // Ownership-sensitive identity fields use the same proof gate as the
  // dashboard approval path. Never link an arbitrary signed-in orderer's uid
  // or verified email onto an existing, unclaimed phone-keyed customer.
  if (order.email && canLinkAuthUid) payload.email = order.email;
  if (canLinkAuthUid) payload.authUid = order.authUid;
  await setDoc(ref, payload, { merge: true });
  return { customerId, createdNew: !existingData, linkedAuthUid: canLinkAuthUid };
}

async function foldSelfServeStubInto(customerId, authUid) {
  const stubId = `CUS-${authUid}`;
  if (!authUid || stubId === customerId) return;
  try {
    const stubSnap = await getDoc(doc(db, "customers", stubId));
    if (!stubSnap.exists()) return;
    const stub = stubSnap.data() || {};
    if (stub.archived === true || stub.authUid !== authUid) return;
    await mergeCustomersFn({ fromId: stubId, toId: customerId });
  } catch (error) {
    console.warn(`Could not fold stub ${stubId} into ${customerId}:`, error?.message || error);
  }
}

const mapsSdkState = { ready: false, geocoder: null, loadPromise: null };

function loadMapsSdk() {
  if (mapsSdkState.ready) return Promise.resolve();
  if (mapsSdkState.loadPromise) return mapsSdkState.loadPromise;
  if (!mapsApiKey) return Promise.reject(new Error("no-maps-api-key"));
  if (window.google?.maps) {
    mapsSdkState.ready = true;
    return Promise.resolve();
  }
  mapsSdkState.loadPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?${new URLSearchParams({ key: mapsApiKey, v: "weekly" }).toString()}`;
    script.async = true;
    script.defer = true;
    script.onload = () => { mapsSdkState.ready = true; resolve(); };
    script.onerror = () => reject(new Error("Maps SDK failed to load"));
    document.head.appendChild(script);
  });
  return mapsSdkState.loadPromise;
}

function geocodeAddress(address) {
  if (!mapsSdkState.geocoder) mapsSdkState.geocoder = new google.maps.Geocoder();
  return new Promise((resolve) => {
    mapsSdkState.geocoder.geocode({ address, region: "vn" }, (results, status) => {
      if (status === "OK" && results?.length) {
        const loc = results[0].geometry.location;
        resolve({ lat: loc.lat(), lng: loc.lng(), formattedAddress: results[0].formatted_address });
      } else resolve(null);
    });
  });
}

// ---- Edit-order address re-confirmation -----------------------------------
// Changing an order's address forces the new pin onto the map for a manual
// eyeball before save — the same checkpoint the new-customer and public-order
// flows enforce. Seeded from the order's existing pin on open, so an unchanged
// address saves without a re-check.
const editAddressState = {
  map: null,
  marker: null,
  pending: null,
  confirmed: null,        // { lat, lng, formattedAddress, geocodedAt }
  confirmedForAddress: "" // the trimmed address string `confirmed` belongs to
};

function setEditAddressStatus(message, isError = false) {
  const node = el("edit-address-status");
  if (!node) return;
  node.textContent = message || "";
  node.style.color = isError ? "var(--danger, #b3261e)" : "var(--muted)";
}

function resetEditAddressConfirm(order) {
  editAddressState.pending = null;
  const wrap = el("edit-address-map-wrap");
  if (wrap) wrap.hidden = true;
  const existing = order?.deliveryLocation;
  if (existing && typeof existing.lat === "number" && typeof existing.lng === "number") {
    editAddressState.confirmed = { ...existing };
    editAddressState.confirmedForAddress = String(order.address || "").trim();
    setEditAddressStatus("Pin on file. If you change the address, re-check it on the map.");
  } else {
    editAddressState.confirmed = null;
    editAddressState.confirmedForAddress = "";
    setEditAddressStatus("Find the address on Google Maps to confirm the delivery pin.");
  }
}

async function findEditAddress() {
  const address = el("edit-address").value.trim();
  if (address.length < 5) {
    setEditAddressStatus("Enter a fuller delivery address first.", true);
    return;
  }
  const button = el("edit-address-verify");
  button.disabled = true;
  setEditAddressStatus("Searching Google Maps...");
  editAddressState.confirmed = null;
  editAddressState.confirmedForAddress = "";
  try {
    await loadMapsSdk();
    const geocoder = new google.maps.Geocoder();
    const match = await new Promise((resolve, reject) => {
      geocoder.geocode({
        address,
        region: "vn",
        componentRestrictions: { country: "vn" },
        bounds: new google.maps.LatLngBounds({ lat: 15.90, lng: 108.05 }, { lat: 16.20, lng: 108.35 })
      }, (results, status) => {
        if (status === "OK" && results?.[0]) resolve(results[0]);
        else reject(new Error("We couldn't find that address. Add a district or nearby landmark and try again."));
      });
    });
    const position = match.geometry.location;
    const wrap = el("edit-address-map-wrap");
    wrap.hidden = false;
    editAddressState.map = editAddressState.map || new google.maps.Map(el("edit-address-map"), {
      center: position,
      zoom: 17,
      streetViewControl: false,
      mapTypeControl: false,
      fullscreenControl: false
    });
    editAddressState.map.setCenter(position);
    google.maps.event.trigger(editAddressState.map, "resize");
    if (editAddressState.marker) editAddressState.marker.setMap(null);
    editAddressState.marker = new google.maps.Marker({ map: editAddressState.map, position, draggable: true });
    const capture = (pin) => {
      editAddressState.pending = {
        lat: pin.lat(),
        lng: pin.lng(),
        formattedAddress: match.formatted_address || address,
        geocodedAt: new Date().toISOString()
      };
      editAddressState.confirmed = null;
      setEditAddressStatus("Check the pin, drag it to the exact entrance if needed, then use this location.");
    };
    capture(position);
    editAddressState.marker.addListener("dragend", () => capture(editAddressState.marker.getPosition()));
  } catch (error) {
    editAddressState.pending = null;
    el("edit-address-map-wrap")?.setAttribute("hidden", "");
    setEditAddressStatus(error.message || String(error), true);
  } finally {
    button.disabled = false;
  }
}

function confirmEditAddress() {
  if (!editAddressState.pending) return;
  editAddressState.confirmed = { ...editAddressState.pending };
  editAddressState.confirmedForAddress = el("edit-address").value.trim();
  setEditAddressStatus("✓ Delivery location confirmed on Google Maps.");
}

const editAddressController = createEditOrderAddressController({ loadMaps: loadMapsSdk });

async function resolveDeliveryLocation(order, customerId) {
  const confirmed = order?.deliveryLocation;
  if (confirmed && typeof confirmed.lat === "number" && typeof confirmed.lng === "number") return confirmed;
  const address = String(order?.address || "").trim();
  if (address) {
    try {
      await loadMapsSdk();
      const geo = await geocodeAddress(address);
      if (geo) return { ...geo, geocodedAt: new Date().toISOString() };
    } catch (error) {
      console.warn(`Geocode failed for order ${order?.id || orderId}:`, error?.message || error);
    }
  }
  if (customerId) {
    try {
      const snap = await getDoc(doc(db, "customers", customerId));
      const loc = snap.exists() ? snap.data().location : null;
      if (loc && typeof loc.lat === "number" && typeof loc.lng === "number") {
        return { lat: loc.lat, lng: loc.lng, formattedAddress: loc.formattedAddress || address || null, geocodedAt: new Date().toISOString(), sourceCustomerId: customerId };
      }
    } catch (_) {
      // Approval and edits remain usable even if a fallback pin cannot load.
    }
  }
  return null;
}

async function ensureDepositCharge(order) {
  if (state.deposits.some((event) => event.eventType === "charged")) return;
  const productsById = Object.fromEntries(state.products.map((product) => [product.id, product]));
  const breakdown = computeDepositBreakdown(state.items, productsById);
  if (!breakdown.length) return;
  const customerId = order.customerId || buildCustomerId(order.phone) || null;
  const batch = writeBatch(db);
  breakdown.forEach((entry) => {
    batch.set(doc(db, "depositEvents", buildDepositEventId()), {
      orderId: order.id,
      customerId,
      authUid: order.authUid || null,
      containerType: entry.containerType,
      qty: entry.qty,
      amount: entry.amount,
      eventType: "charged",
      eventDate: order.deliveryDate || todayKey(),
      linkedDocumentId: null,
      notes: "Auto-charged on approval"
    });
  });
  await batch.commit();
}

async function approveOrder() {
  const order = state.order;
  if (!order) return;
  // P0-04: warn on a phone that already belongs to a different customer record
  // (usually a typo). The order still routes to the customer's own account.
  const phoneId = buildCustomerId(order.phone);
  if (phoneId && phoneId !== (order.customerId || "")) {
    try {
      const otherSnap = await getDoc(doc(db, "customers", phoneId));
      if (otherSnap.exists() && otherSnap.data().archived !== true) {
        const other = otherSnap.data();
        const proceed = confirm(
          `The phone on this order (${order.phone}) already belongs to a different customer: ${other.name || phoneId}.\n\n`
          + `Approving will NOT touch that customer — this order stays on ${order.customerName || "this customer"}'s own account. `
          + `If the phone was a typo, Cancel and fix it with Edit details first.\n\nApprove anyway?`
        );
        if (!proceed) return;
      }
    } catch (_) {
      // A failed lookup must not block a legitimate approval.
    }
  }
  const { customerId, createdNew, linkedAuthUid } = await upsertCustomerFromOrder(order);
  const deliveryLocation = await resolveDeliveryLocation(order, customerId);
  await updateDoc(doc(db, "orders", order.id), {
    status: "new",
    customerId: customerId || null,
    deliveryLocation,
    updatedAt: new Date().toISOString()
  });
  await ensureDepositCharge({ ...order, customerId });
  if (customerId && createdNew && linkedAuthUid) await foldSelfServeStubInto(customerId, order.authUid);
}

async function emitDepositReversalsFor(order) {
  const snap = await getDocs(query(collection(db, "depositEvents"), where("orderId", "==", order.id)));
  const netByType = {};
  snap.docs.forEach((row) => {
    const event = row.data();
    const type = event.containerType || "other";
    if (!netByType[type]) netByType[type] = { qty: 0, amount: 0 };
    const direction = event.eventType === "charged" ? 1 : ["refunded", "credited", "forfeited"].includes(event.eventType) ? -1 : 0;
    netByType[type].qty += direction * Number(event.qty || 0);
    netByType[type].amount += direction * Number(event.amount || 0);
  });
  const batch = writeBatch(db);
  let wrote = false;
  Object.entries(netByType).forEach(([type, net]) => {
    if (net.qty <= 0 && net.amount <= 0.01) return;
    batch.set(doc(db, "depositEvents", buildDepositEventId()), {
      orderId: order.id,
      customerId: order.customerId || null,
      authUid: order.authUid || null,
      containerType: type,
      qty: Math.max(0, net.qty),
      amount: Math.max(0, net.amount),
      eventType: "refunded",
      eventDate: todayKey(),
      linkedDocumentId: null,
      notes: "Order cancelled — deposit reversed"
    });
    wrote = true;
  });
  if (wrote) await batch.commit();
}

async function cancelOrder(reason) {
  const order = state.order;
  const trimmed = String(reason || "").trim();
  await updateDoc(doc(db, "orders", order.id), {
    status: "cancelled",
    cancellationReason: trimmed || null,
    cancelledAt: new Date().toISOString(),
    cancelledBy: "owner",
    updatedAt: new Date().toISOString()
  });
  await emitDepositReversalsFor(order);
}

async function approveCancellationRequest() {
  const order = state.order;
  await updateDoc(doc(db, "orders", order.id), {
    status: "cancelled",
    cancellationReason: order.cancellationRequestReason || null,
    cancelledAt: new Date().toISOString(),
    cancelledBy: "owner_via_request",
    cancellationRequested: null,
    cancellationRequestReason: null,
    cancellationRequestedAt: null,
    updatedAt: new Date().toISOString()
  });
  await emitDepositReversalsFor(order);
}

async function dismissCancellationRequest() {
  await updateDoc(doc(db, "orders", state.order.id), {
    cancellationRequested: null,
    cancellationRequestReason: null,
    cancellationRequestedAt: null,
    updatedAt: new Date().toISOString()
  });
}

async function assignDriver(driverId) {
  const order = state.order;
  const nextStatus = driverId ? (["new", "assigned"].includes(order.status) ? "assigned" : order.status) : (order.status === "assigned" ? "new" : order.status);
  await updateDoc(doc(db, "orders", order.id), { assignedDriverId: driverId || null, status: nextStatus, updatedAt: new Date().toISOString() });
}

async function updateOrderStatus(nextStatus) {
  await updateDoc(doc(db, "orders", state.order.id), { status: nextStatus, updatedAt: new Date().toISOString() });
}

const editState = { items: [] };

function computeEditTotals() {
  return editState.items.reduce((totals, item) => {
    const quantity = Number(item.quantity || 0);
    totals.subtotal += quantity * Number(item.unitPrice || 0);
    totals.depositTotal += quantity * Number(item.defaultDepositAmount || 0);
    return totals;
  }, { subtotal: 0, depositTotal: 0 });
}

function renderEditTotals() {
  const totals = computeEditTotals();
  el("edit-totals").innerHTML = `
    <div class="card"><span class="muted">Subtotal</span><strong>${formatCurrency(totals.subtotal)}</strong></div>
    <div class="card"><span class="muted">Deposit</span><strong>${formatCurrency(totals.depositTotal)}</strong></div>
    <div class="card"><span class="muted">Total due</span><strong>${formatCurrency(totals.subtotal + totals.depositTotal)}</strong></div>`;
}

function renderEditItems() {
  const container = el("edit-items-list");
  if (!editState.items.length) {
    container.innerHTML = `<p class="muted">No items yet. Add a product below.</p>`;
    return;
  }
  container.innerHTML = editState.items.map((item, index) => `
    <div class="card"><div class="order-top">
      <div><strong>${escapeHtml(item.productName)}</strong><div class="muted">${formatCurrency(item.unitPrice)} each · deposit ${formatCurrency(item.defaultDepositAmount || 0)}</div></div>
      <div class="button-row" style="gap:6px"><button class="ghost" type="button" data-edit-qty-minus="${index}">-</button><span class="qty-value">${Number(item.quantity || 0)}</span><button class="ghost" type="button" data-edit-qty-plus="${index}">+</button><button class="ghost" type="button" data-edit-remove="${index}">Remove</button></div>
    </div></div>`).join("");
  container.querySelectorAll("[data-edit-qty-minus]").forEach((button) => button.addEventListener("click", () => changeEditQty(Number(button.dataset.editQtyMinus), -1)));
  container.querySelectorAll("[data-edit-qty-plus]").forEach((button) => button.addEventListener("click", () => changeEditQty(Number(button.dataset.editQtyPlus), 1)));
  container.querySelectorAll("[data-edit-remove]").forEach((button) => button.addEventListener("click", () => removeEditItem(Number(button.dataset.editRemove))));
}

function changeEditQty(index, delta) {
  const next = Math.max(0, Number(editState.items[index].quantity || 0) + delta);
  if (next === 0) editState.items.splice(index, 1);
  else editState.items[index].quantity = next;
  renderEditItems();
  renderEditTotals();
}

function removeEditItem(index) {
  editState.items.splice(index, 1);
  renderEditItems();
  renderEditTotals();
}

function addEditItem() {
  const select = el("edit-add-item-select");
  const product = state.products.find((row) => row.id === select.value);
  if (!product) return;
  const existing = editState.items.find((item) => item.productId === product.id);
  if (existing) existing.quantity = Number(existing.quantity || 0) + 1;
  else editState.items.push({
    productId: product.id,
    productName: product.productName,
    quantity: 1,
    unitPrice: Number(product.unitPrice || 0),
    defaultDepositAmount: Number(product.defaultDepositAmount || 0)
  });
  select.value = "";
  renderEditItems();
  renderEditTotals();
}

async function openEditDialog(order) {
  const dialog = el("edit-order-dialog");
  if (!dialog || typeof dialog.showModal !== "function") return;
  el("edit-order-id").value = order.id;
  el("edit-customer-name").value = order.customerName || "";
  el("edit-phone").value = order.phone || "";
  el("edit-address").value = order.address || "";
  editAddressController.reset(order);
  el("edit-delivery-date").value = order.deliveryDate || "";
  setDeliveryWindow(el("edit-delivery-window"), order.deliveryWindow || "");
  el("edit-notes").value = order.notes || "";
  el("edit-status").textContent = "";
  el("edit-add-item-select").innerHTML = '<option value="">Choose a product to add...</option>'
    + state.products.map((product) => `<option value="${escapeHtml(product.id)}">${escapeHtml(product.productName)} — ${formatCurrency(product.unitPrice)}</option>`).join("");
  editState.items = state.items.map((item) => {
    const product = state.products.find((row) => row.id === item.productId);
    return {
      productId: item.productId,
      productName: item.productName || product?.productName || "",
      quantity: Number(item.quantity || 0),
      unitPrice: Number(item.unitPrice || product?.unitPrice || 0),
      defaultDepositAmount: Number(product?.defaultDepositAmount || 0)
    };
  });
  renderEditItems();
  renderEditTotals();
  dialog.showModal();
}

async function saveEditedOrder(event) {
  event.preventDefault();
  const statusNode = el("edit-status");
  if (!editState.items.length) {
    statusNode.textContent = "Order needs at least one item.";
    statusNode.style.color = "var(--danger, #b3261e)";
    return;
  }

  const order = state.order;
  const newAddress = el("edit-address").value.trim();
  const addressChanged = newAddress !== String(order.address || "").trim();
  const confirmedEditLocation = editAddressController.confirmedFor(newAddress);
  const locationReconfirmed = editAddressController.hasFreshConfirmationFor(newAddress);
  // A changed address must be re-verified on the map before it can be saved —
  // no silent geocode. The confirmed pin has to belong to the address as it
  // now reads in the field, so editing after confirming forces another check.
  if (addressChanged && !confirmedEditLocation) {
    statusNode.textContent = "Confirm the new address on Google Maps before saving.";
    statusNode.style.color = "var(--danger, #b3261e)";
    editAddressController.setStatus("Find the new address on the map and confirm the pin.", true);
    el("edit-address-verify")?.focus();
    return;
  }

  await withSubmitLock(event, async () => {
    try {
      statusNode.textContent = "Saving...";
      statusNode.style.color = "";
      const amountPaid = Number(order.amountPaid || 0);
      const totals = computeEditTotals();
      const balanceDue = totals.subtotal + totals.depositTotal - amountPaid;
      const deliveryLocationPatch = (addressChanged || locationReconfirmed)
        ? { deliveryLocation: confirmedEditLocation }
        : {};
      const batch = writeBatch(db);
      const existingItems = await getDocs(query(collection(db, "orderItems"), where("orderId", "==", order.id)));
      existingItems.docs.forEach((row) => batch.delete(doc(db, "orderItems", row.id)));
      editState.items.forEach((item) => {
        const quantity = Number(item.quantity);
        const unitPrice = Number(item.unitPrice);
        batch.set(doc(db, "orderItems", buildOrderId("ITEM")), {
          orderId: order.id,
          authUid: order.authUid || null,
          productId: item.productId,
          productName: item.productName,
          quantity,
          unitPrice,
          lineTotal: quantity * unitPrice
        });
      });

      const productsById = Object.fromEntries(state.products.map((product) => [product.id, product]));
      const newBreakdown = computeDepositBreakdown(editState.items, productsById);
      const newByType = Object.fromEntries(newBreakdown.map((entry) => [entry.containerType, entry]));
      const existingByType = {};
      state.deposits.forEach((deposit) => {
        const type = deposit.containerType || "other";
        if (!existingByType[type]) existingByType[type] = { qty: 0, amount: 0 };
        const direction = deposit.eventType === "charged" ? 1 : ["refunded", "credited", "forfeited"].includes(deposit.eventType) ? -1 : 0;
        existingByType[type].qty += direction * Number(deposit.qty || 0);
        existingByType[type].amount += direction * Number(deposit.amount || 0);
      });
      const allTypes = new Set([...Object.keys(existingByType), ...Object.keys(newByType)]);
      allTypes.forEach((type) => {
        const need = newByType[type] || { qty: 0, amount: 0 };
        const have = existingByType[type] || { qty: 0, amount: 0 };
        const deltaQty = need.qty - have.qty;
        const deltaAmount = need.amount - have.amount;
        if (deltaQty === 0 && Math.abs(deltaAmount) < 0.01) return;
        const eventType = deltaQty > 0 || (deltaQty === 0 && deltaAmount > 0) ? "charged" : "refunded";
        batch.set(doc(db, "depositEvents", buildDepositEventId()), {
          orderId: order.id,
          customerId: order.customerId || null,
          authUid: order.authUid || null,
          containerType: type,
          qty: Math.abs(deltaQty),
          amount: Math.abs(deltaAmount),
          eventType,
          eventDate: todayKey(),
          linkedDocumentId: null,
          notes: eventType === "charged" ? "Order edit — increased containers" : "Order edit — reduced containers"
        });
      });

      batch.update(doc(db, "orders", order.id), {
        customerName: el("edit-customer-name").value.trim(),
        phone: el("edit-phone").value.trim(),
        address: newAddress,
        ...deliveryLocationPatch,
        deliveryDate: el("edit-delivery-date").value,
        deliveryWindow: el("edit-delivery-window").value.trim(),
        notes: el("edit-notes").value.trim(),
        subtotal: totals.subtotal,
        depositTotal: totals.depositTotal,
        balanceDue,
        paymentStatus: paymentStatusFor(amountPaid, balanceDue),
        updatedAt: new Date().toISOString()
      });
      await batch.commit();
      el("edit-order-dialog").close();
      await loadOrderRecord();
      setActionStatus("Order changes saved.");
    } catch (error) {
      statusNode.textContent = error.message || String(error);
      statusNode.style.color = "var(--danger, #b3261e)";
    }
  });
}

function daysFromToday(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return localDateKey(date);
}

const CONTAINER_LABELS = {
  glass_crate: "Glass crates",
  "18_9l_jug": "18.9 L jugs",
  "19l_jug": "19 L jugs",
  "20l_jug": "20 L jugs",
  mixed: "Mixed containers"
};
const deliveryDialogState = { heldContainers: {}, customerId: null, balanceDue: 0, amountOverridden: false };

function humanizeContainerType(key) {
  return CONTAINER_LABELS[key] || String(key || "Other").replace(/_/g, " ");
}

async function loadHeldContainersForCustomer(customerId) {
  if (!customerId) return {};
  const snap = await getDocs(query(collection(db, "depositEvents"), where("customerId", "==", customerId)));
  const byType = {};
  snap.docs.forEach((row) => {
    const event = row.data();
    const type = String(event.containerType || "other");
    if (!byType[type]) byType[type] = { qty: 0, amount: 0, totalChargedAmount: 0, totalChargedQty: 0 };
    const quantity = Number(event.qty || 0);
    const amount = Number(event.amount || 0);
    if (event.eventType === "charged") {
      byType[type].qty += quantity;
      byType[type].amount += amount;
      byType[type].totalChargedAmount += amount;
      byType[type].totalChargedQty += quantity;
    } else if (["refunded", "credited", "forfeited"].includes(event.eventType)) {
      byType[type].qty -= quantity;
      byType[type].amount -= amount;
    }
  });
  // Types that net to a clean zero are dropped; negatives are deliberately kept
  // so renderHeldContainers can flag them. Filtering them out here is what let a
  // broken balance masquerade as "nothing on file".
  return Object.fromEntries(Object.entries(byType)
    .filter(([, info]) => info.qty !== 0 || Math.abs(info.amount) >= 1)
    .map(([type, info]) => [type, {
      qty: info.qty,
      outstandingAmount: info.amount,
      depositPerUnit: info.totalChargedQty > 0 ? info.totalChargedAmount / info.totalChargedQty : 0
    }]));
}

// The dialog only ever offers returns and write-offs against containers the
// customer is genuinely holding, so every consumer splits the map the same way.
function heldTypesFrom(held) {
  return Object.keys(held).filter((type) => Number(held[type]?.qty || 0) > 0);
}

function brokenBalancesFrom(held) {
  return Object.entries(held)
    .filter(([, info]) => isBrokenDepositBalance(info.qty, info.outstandingAmount))
    .map(([type, info]) => ({ type, qty: Number(info.qty || 0), amount: Number(info.outstandingAmount || 0) }));
}

function brokenBalanceWarningHtml(broken) {
  if (!broken.length) return "";
  const lines = broken.map((row) => `<li><strong>${escapeHtml(humanizeContainerType(row.type))}</strong> — ${escapeHtml(describeDepositBalanceProblem(row.qty, row.amount))}</li>`).join("");
  return `<div class="card" style="border:2px solid var(--danger,#b3261e)">
    <strong style="color:var(--danger,#b3261e)">This customer's container record is wrong</strong>
    <ul class="muted" style="margin:6px 0 0;padding-left:18px">${lines}</ul>
    <div class="muted top-gap">Deliver and take payment as normal — but don't record returns or write-offs against this customer until it's corrected, or the next deposit they pay will vanish into the gap. Check their deposit history on the customer page.</div>
  </div>`;
}

// Reads the return rows into a normalized list. Shared by the live COD recalc
// and the save path so both see exactly the same credit/refund split.
function collectDeliveryReturns() {
  const returns = [];
  document.querySelectorAll("[data-return-qty]").forEach((input) => {
    const type = input.dataset.returnQty;
    const returnedQty = Number(input.value || 0);
    if (returnedQty <= 0) return;
    const handling = document.querySelector(`[data-return-handling="${type}"]`)?.value || "keep";
    if (handling === "keep") return;
    // Clamp to what they actually hold. The input carries a max, but a balance
    // can only ever be pushed below zero by a write that outran the ledger, so
    // the number is re-checked here rather than trusted from the DOM.
    const heldQty = Number(deliveryDialogState.heldContainers[type]?.qty || 0);
    if (heldQty <= 0) return;
    returns.push({
      type,
      returnedQty: Math.min(returnedQty, heldQty),
      handling,
      depositPerUnit: deliveryDialogState.heldContainers[type]?.depositPerUnit || 0
    });
  });
  return returns;
}

// Live "cash to collect" math for the delivery dialog. A credit return reduces
// what the customer owes on THIS order (modelled as a deposit_credit payment at
// save time); a refund is cash handed back, tracked separately and never nets
// against the order balance. Auto-fills the amount-collected field with the
// residual cash unless the owner has typed their own figure. Also shows/hides
// the mandatory return-photo field: any physical return (credit or refund) must
// be photographed before the order can close.
function recalcDeliveryCod() {
  const returns = collectDeliveryReturns();
  const creditTotal = returns.filter((r) => r.handling === "credit").reduce((s, r) => s + r.returnedQty * r.depositPerUnit, 0);
  const refundTotal = returns.filter((r) => r.handling === "refund").reduce((s, r) => s + r.returnedQty * r.depositPerUnit, 0);
  const due = Number(deliveryDialogState.balanceDue || 0);
  const cashToCollect = Math.max(0, due - creditTotal);
  if (!deliveryDialogState.amountOverridden) {
    el("delivery-payment-amount").value = cashToCollect;
  }
  const collected = document.querySelector('input[name="collected"]:checked')?.value === "collected";
  const cashPaid = collected ? Number(el("delivery-payment-amount").value || 0) : 0;
  const overCredit = Math.min(creditTotal, Math.max(0, cashPaid + creditTotal - due));

  const summary = el("delivery-cod-summary");
  if (creditTotal > 0 || refundTotal > 0) {
    const lines = [`<div><span>Order due</span><strong>${escapeHtml(formatCurrency(due))}</strong></div>`];
    if (creditTotal > 0) lines.push(`<div><span>− Deposit credit applied</span><strong>−${escapeHtml(formatCurrency(creditTotal))}</strong></div>`);
    lines.push(`<div class="delivery-cod-total"><span>Cash to collect</span><strong>${escapeHtml(formatCurrency(cashToCollect))}</strong></div>`);
    if (refundTotal > 0) lines.push(`<div><span>Cash to refund (separate)</span><strong>${escapeHtml(formatCurrency(refundTotal))}</strong></div>`);
    if (overCredit > 0) lines.push(`<div><span class="muted" style="grid-column:1/-1">Choose below whether to refund the ${escapeHtml(formatCurrency(overCredit))} excess or carry it forward.</span></div>`);
    summary.innerHTML = lines.join("");
    summary.classList.remove("hidden");
  } else {
    summary.innerHTML = "";
    summary.classList.add("hidden");
  }

  // Photo is mandatory whenever a container physically changed hands.
  el("delivery-return-proof-field").classList.toggle("hidden", returns.length === 0);
  el("delivery-overcredit-field").classList.toggle("hidden", overCredit <= 0);
  el("delivery-overcredit-amount").textContent = formatCurrency(overCredit);
}

function renderHeldContainers(held) {
  const container = el("delivery-containers-list");
  const help = el("delivery-containers-help");
  const types = heldTypesFrom(held);
  const warning = brokenBalanceWarningHtml(brokenBalancesFrom(held));
  if (!types.length) {
    help.textContent = warning
      ? "Nothing can be returned here until the record below is corrected."
      : "This customer isn't holding any containers, so there's nothing to return and nothing to write off. If they hand one back anyway, take it — but there's no deposit of theirs to give back, so note it on the order instead.";
    container.innerHTML = warning;
    recalcDeliveryCod();
    return;
  }
  help.textContent = "Enter qty returned this trip and pick how to handle the deposit. Leave qty 0 for containers that stayed with the customer.";
  container.innerHTML = warning + types.map((type) => {
    const info = held[type];
    return `<div class="card"><div class="order-top">
      <div><strong>${escapeHtml(humanizeContainerType(type))}</strong><div class="muted">${Number(info.qty || 0)} held · ${formatCurrency(info.outstandingAmount)} deposit outstanding</div></div>
      <div class="button-row" style="gap:6px;flex-wrap:wrap">
        <label class="muted" style="gap:4px;display:flex;align-items:center">Returned <input type="number" data-return-qty="${escapeHtml(type)}" min="0" max="${Number(info.qty || 0)}" step="1" value="0" style="width:64px"></label>
        <select data-return-handling="${escapeHtml(type)}"><option value="credit">Apply to this order</option><option value="refund">Refund cash now</option><option value="keep">Owner will decide later</option></select>
      </div>
    </div></div>`;
  }).join("");
  container.querySelectorAll("[data-return-qty], [data-return-handling]").forEach((node) => {
    node.addEventListener("input", recalcDeliveryCod);
    node.addEventListener("change", recalcDeliveryCod);
  });
  recalcDeliveryCod();
}

// Only containers the customer is actually holding can be written off. Listing
// every product type here is what allowed a loss report against a customer who
// held nothing — a 0 VND forfeit that drove their balance below zero.
function populateLossTypeSelect() {
  const select = el("delivery-loss-type");
  const checkbox = el("delivery-loss-checkbox");
  const held = deliveryDialogState.heldContainers;
  const heldTypes = heldTypesFrom(held);
  select.innerHTML = heldTypes.map((type) => `<option value="${escapeHtml(type)}">${escapeHtml(humanizeContainerType(type))} (${Number(held[type].qty)} held)</option>`).join("");
  select.onchange = syncLossQtyMax;
  const nothingToWriteOff = heldTypes.length === 0;
  checkbox.disabled = nothingToWriteOff;
  if (nothingToWriteOff) checkbox.checked = false;
  const help = el("delivery-loss-help");
  if (help) help.textContent = nothingToWriteOff ? "Nothing to write off — this customer has no containers on file." : "";
  syncLossQtyMax();
  toggleLossFields();
}

// Keeps the qty ceiling in step with the selected type, so five jugs can't be
// written off against a customer holding two.
function syncLossQtyMax() {
  const heldQty = Number(deliveryDialogState.heldContainers[el("delivery-loss-type").value]?.qty || 0);
  const qtyInput = el("delivery-loss-qty");
  qtyInput.max = heldQty > 0 ? heldQty : 1;
  if (Number(qtyInput.value || 0) > heldQty) qtyInput.value = heldQty > 0 ? heldQty : 1;
}

function toggleLossFields() {
  el("delivery-loss-fields").classList.toggle("hidden", !el("delivery-loss-checkbox").checked);
}

function toggleDeliveryPaymentFields() {
  const collected = document.querySelector('input[name="collected"]:checked')?.value === "collected";
  el("delivery-collected-fields").classList.toggle("hidden", !collected);
  el("delivery-deferred-fields").classList.toggle("hidden", collected);
  el("delivery-payment-amount").required = collected;
}

async function openDeliveryPaymentDialog(order) {
  const dialog = el("delivery-payment-dialog");
  if (!dialog || typeof dialog.showModal !== "function") return;
  el("delivery-payment-order-id").value = order.id;
  el("delivery-payment-customer").textContent = order.customerName || "customer";
  el("delivery-payment-due").textContent = formatCurrency(order.balanceDue);
  el("delivery-payment-amount").value = Number(order.balanceDue || 0);
  el("delivery-payment-method").value = "cash";
  el("delivery-payment-reference").value = "";
  el("delivery-payment-proof").value = "";
  el("delivery-return-proof").value = "";
  // Same stale-carryover trap as the photo: last order's explanation must not
  // become this order's proof.
  if (el("delivery-return-note")) el("delivery-return-note").value = "";
  el("delivery-return-proof-field").classList.add("hidden");
  el("delivery-cod-summary").classList.add("hidden");
  el("delivery-overcredit-field").classList.add("hidden");
  document.querySelector('input[name="delivery-overcredit"][value="carry"]').checked = true;
  deliveryDialogState.balanceDue = Number(order.balanceDue || 0);
  deliveryDialogState.amountOverridden = false;
  el("delivery-deferral-reason").value = "customer_said_next_time";
  el("delivery-follow-up").value = daysFromToday(state.thresholds.followUpDays);
  el("delivery-deferral-notes").value = "";
  el("delivery-loss-checkbox").checked = false;
  el("delivery-loss-qty").value = 1;
  el("delivery-loss-note").value = "";
  document.querySelector('input[name="collected"][value="collected"]').checked = true;
  toggleLossFields();
  toggleDeliveryPaymentFields();
  deliveryDialogState.heldContainers = {};
  deliveryDialogState.customerId = order.customerId || null;
  renderHeldContainers({});
  populateLossTypeSelect();
  el("delivery-payment-status").textContent = "";
  dialog.showModal();
  try {
    const held = await loadHeldContainersForCustomer(order.customerId);
    deliveryDialogState.heldContainers = held;
    renderHeldContainers(held);
    populateLossTypeSelect();
    if (state.customer.emptiesPickupRequested === true) {
      el("delivery-containers-help").innerHTML = `<strong style="color:#0b7a63">♻ The customer asked for an empties pickup this delivery.</strong> ${escapeHtml(el("delivery-containers-help").textContent)}`;
    }
  } catch (error) {
    el("delivery-containers-help").textContent = `Could not load container balance: ${error.message || error}`;
  }
}

async function saveDeliveryPayment(event) {
  event.preventDefault();
  const statusNode = el("delivery-payment-status");
  const collected = document.querySelector('input[name="collected"]:checked')?.value === "collected";
  const now = new Date().toISOString();
  const today = todayKey();
  const paymentId = buildPaymentId();
  let paymentSnapshot;

  if (collected) {
    const amount = Number(el("delivery-payment-amount").value || 0);
    if (amount < 0) {
      statusNode.textContent = "Amount cannot be negative.";
      statusNode.style.color = "var(--danger, #b3261e)";
      return;
    }
    const proofFile = el("delivery-payment-proof").files?.[0] || null;
    if (proofFile) {
      const problem = validateProofFile(proofFile);
      if (problem) {
        statusNode.textContent = problem;
        statusNode.style.color = "var(--danger, #b3261e)";
        return;
      }
    }
    paymentSnapshot = {
      collected: true,
      amount,
      method: el("delivery-payment-method").value || "cash",
      reference: el("delivery-payment-reference").value.trim() || null,
      proofFile
    };
  } else {
    paymentSnapshot = {
      collected: false,
      reason: el("delivery-deferral-reason").value || "other",
      followUpBy: el("delivery-follow-up").value || daysFromToday(state.thresholds.followUpDays),
      notes: el("delivery-deferral-notes").value.trim() || null
    };
  }

  const containerReturns = collectDeliveryReturns();
  const overCreditChoice = document.querySelector('input[name="delivery-overcredit"]:checked')?.value || "carry";

  // A container that physically changed hands must leave a record before the
  // order can close — a credit/refund with no account of it is exactly how a
  // deposit goes missing (driver credits it but forgets to take the empty).
  // Photo OR written note, per containerReturnProofProblem: a photo of an empty
  // floor proves nothing, so the note is a real alternative rather than a lesser
  // one. Shared rule so this screen and the dashboard cannot drift apart.
  const returnProofFile = el("delivery-return-proof").files?.[0] || null;
  const returnNote = String(el("delivery-return-note")?.value || "").trim();
  if (containerReturns.length > 0) {
    const proofProblem = containerReturnProofProblem({ hasPhoto: !!returnProofFile, note: returnNote });
    if (proofProblem) {
      statusNode.textContent = proofProblem;
      statusNode.style.color = "var(--danger, #b3261e)";
      return;
    }
    if (returnProofFile) {
      const problem = validateProofFile(returnProofFile);
      if (problem) {
        statusNode.textContent = problem;
        statusNode.style.color = "var(--danger, #b3261e)";
        return;
      }
    }
  }
  const returnProofType = containerReturns.length > 0
    ? containerReturnProofType({ hasPhoto: !!returnProofFile, note: returnNote })
    : null;
  const returnProofNote = containerReturns.length > 0 && returnNote ? returnNote : null;

  // A write-off has to come out of a balance that exists. Without these guards a
  // loss report against a customer holding nothing books a 0 VND forfeit and
  // leaves their ledger below zero, where it silently swallows the next real
  // deposit they pay.
  let lossReport = null;
  if (el("delivery-loss-checkbox").checked) {
    const lossType = el("delivery-loss-type").value;
    const lossQty = Number(el("delivery-loss-qty").value || 0);
    const heldForLoss = deliveryDialogState.heldContainers[lossType];
    const heldQty = Number(heldForLoss?.qty || 0);
    if (!lossType || heldQty <= 0) {
      statusNode.textContent = "This customer has no containers on file, so there is nothing to report lost.";
      statusNode.style.color = "var(--danger, #b3261e)";
      return;
    }
    if (lossQty <= 0 || lossQty > heldQty) {
      statusNode.textContent = `Qty lost must be between 1 and ${heldQty}.`;
      statusNode.style.color = "var(--danger, #b3261e)";
      return;
    }
    lossReport = {
      lossType,
      lossQty,
      depositPerUnit: heldForLoss.depositPerUnit || 0,
      lossNote: el("delivery-loss-note").value.trim() || null
    };
  }

  await withSubmitLock(event, async () => {
    try {
      statusNode.textContent = "Saving...";
      statusNode.style.color = "";
      let proofDocumentId = null;
      let proofUrl = null;
      if (paymentSnapshot.collected && paymentSnapshot.proofFile) {
        statusNode.textContent = "Uploading proof photo…";
        const proof = await uploadPaymentProof({ orderId, paymentId, file: paymentSnapshot.proofFile });
        proofDocumentId = proof.documentId;
        proofUrl = proof.downloadUrl;
        statusNode.textContent = "Saving...";
      }
      let returnProofDocumentId = null;
      if (containerReturns.length > 0 && returnProofFile) {
        statusNode.textContent = "Uploading container photo…";
        const returnProof = await uploadContainerReturnProof({ orderId, file: returnProofFile });
        returnProofDocumentId = returnProof.documentId;
        statusNode.textContent = "Saving...";
      }

      await runTransaction(db, async (transaction) => {
        const orderRef = doc(db, "orders", orderId);
        const orderSnap = await transaction.get(orderRef);
        if (!orderSnap.exists()) throw new Error("Order no longer exists.");
        const order = orderSnap.data();
        // Guard the non-idempotent amountPaid increment: a delivered order must
        // not be re-run through this dialog (the UI only offers it while
        // out_for_delivery, but a stale tab could still submit).
        if (order.status === "delivered") throw new Error("This order is already delivered.");
        const receivedBy = auth.currentUser?.email || "owner";
        const total = Number(order.subtotal || 0) + Number(order.depositTotal || 0);

        // Returned deposits handled as a credit reduce what's owed on THIS order.
        // We model that as a non-cash payment so the balance formula and the
        // nightly reconciliation (both sum payments) stay correct with no server
        // change. A refund is cash handed back — a deposit event only, it never
        // touches the order balance.
        const creditTotal = containerReturns
          .filter((r) => r.handling === "credit")
          .reduce((s, r) => s + r.returnedQty * r.depositPerUnit, 0);
        const cashPaid = paymentSnapshot.collected ? paymentSnapshot.amount : 0;
        const grossAmountPaid = Number(order.amountPaid || 0) + cashPaid + creditTotal;
        const grossBalance = total - grossAmountPaid;
        const refundableExcess = Math.min(creditTotal, Math.max(0, -grossBalance));
        const excessRefund = overCreditChoice === "refund" ? refundableExcess : 0;
        const newAmountPaid = grossAmountPaid - excessRefund;
        const newBalance = total - newAmountPaid;

        if (paymentSnapshot.collected) {
          transaction.set(doc(db, "payments", paymentId), {
            orderId,
            customerId: order.customerId || null,
            authUid: order.authUid || null,
            paymentDate: today,
            method: paymentSnapshot.method,
            amount: cashPaid,
            reference: paymentSnapshot.reference,
            receivedBy,
            proofDocumentId,
            proofUrl,
            notes: "Collected at delivery",
            deferred: false,
            createdAt: now
          });
        } else {
          transaction.set(doc(db, "payments", paymentId), {
            orderId,
            customerId: order.customerId || null,
            authUid: order.authUid || null,
            paymentDate: today,
            method: "deferred",
            amount: 0,
            reference: null,
            receivedBy,
            proofDocumentId: null,
            proofUrl: null,
            notes: paymentSnapshot.notes,
            deferred: true,
            deferralReason: paymentSnapshot.reason,
            followUpBy: paymentSnapshot.followUpBy,
            createdAt: now
          });
        }

        // Deposit credit as its own payment line — deterministic id so a re-save
        // overwrites rather than double-credits. Carries whichever proof was
        // given; the note is spelled into `notes` when there is no photo, so a
        // credit closed on someone's word is visible in payment history and on
        // the invoice breakdown without anyone having to go looking for it.
        if (creditTotal > 0) {
          transaction.set(doc(db, "payments", `${orderId}-deposit-credit`), {
            orderId,
            customerId: order.customerId || null,
            authUid: order.authUid || null,
            paymentDate: today,
            method: "deposit_credit",
            amount: creditTotal,
            reference: null,
            receivedBy,
            proofDocumentId: returnProofDocumentId,
            proofUrl: null,
            proofType: returnProofType,
            proofNote: returnProofNote,
            notes: returnProofDocumentId
              ? "Deposit credit from containers returned at delivery"
              : `Deposit credit from containers returned at delivery — no photo, recorded on note: "${returnProofNote}"`,
            deferred: false,
            createdAt: now
          });
        }

        // Refunds are immutable reversing payment lines. The positive deposit
        // credit and this cash-out line net to the amount actually applied, so
        // both reconciliation paths independently arrive at the same zero.
        if (excessRefund > 0) {
          transaction.set(doc(db, "payments", `${orderId}-deposit-excess-refund`), {
            orderId,
            customerId: order.customerId || null,
            authUid: order.authUid || null,
            paymentDate: today,
            method: "deposit_refund",
            amount: -excessRefund,
            reference: null,
            receivedBy,
            proofDocumentId: returnProofDocumentId,
            proofUrl: null,
            proofType: returnProofType,
            proofNote: returnProofNote,
            notes: "Cash refund of excess returned-container deposit credit",
            deferred: false,
            createdAt: now
          });
        }

        // Order money is now written on BOTH paths: a deferral that still
        // returned containers reduces the balance instead of silently losing the
        // credit when the customer later pays.
        const orderUpdate = {
          status: "delivered",
          deliveryPaymentEventId: paymentId,
          amountPaid: newAmountPaid,
          balanceDue: newBalance,
          paymentStatus: paymentStatusFor(newAmountPaid, newBalance),
          depositOverCreditDisposition: refundableExcess > 0 ? overCreditChoice : null,
          depositOverCreditAmount: refundableExcess,
          updatedAt: now
        };
        if (!paymentSnapshot.collected) orderUpdate.followUpBy = paymentSnapshot.followUpBy;
        transaction.update(orderRef, orderUpdate);

        containerReturns.forEach((returned) => {
          // Deterministic id per order+type keeps a re-save idempotent.
          transaction.set(doc(db, "depositEvents", `${orderId}-ret-${returned.type}`), {
            orderId,
            customerId: order.customerId || null,
            authUid: order.authUid || null,
            containerType: returned.type,
            qty: returned.returnedQty,
            amount: returned.returnedQty * returned.depositPerUnit,
            eventType: returned.handling === "refund" ? "refunded" : "credited",
            eventDate: today,
            linkedDocumentId: returnProofDocumentId,
            proofType: returnProofType,
            proofNote: returnProofNote,
            notes: `Returned at delivery — ${returned.handling === "refund" ? "refunded cash" : "applied to this order"}`,
            createdAt: now
          });
        });
        if (lossReport) {
          transaction.set(doc(db, "depositEvents", buildDepositEventId()), {
            orderId,
            customerId: order.customerId || null,
            authUid: order.authUid || null,
            containerType: lossReport.lossType,
            qty: lossReport.lossQty,
            amount: lossReport.lossQty * lossReport.depositPerUnit,
            eventType: "forfeited",
            eventDate: today,
            linkedDocumentId: null,
            notes: lossReport.lossNote || "Reported lost or destroyed at delivery",
            createdAt: now
          });
        }
      });

      if (deliveryDialogState.customerId && state.customer.emptiesPickupRequested === true) {
        updateDoc(doc(db, "customers", deliveryDialogState.customerId), { emptiesPickupRequested: false, emptiesPickupRequestedAt: null, updatedAt: now })
          .catch((error) => console.warn("Could not clear empties-pickup flag:", error));
      }
      el("delivery-payment-dialog").close();
      await loadOrderRecord();
      // Delivery is the moment the numbers are final — deposit credit/refund and
      // cash are now settled. Nudge the owner to the finalized invoice (draft
      // before this point couldn't capture the last-second return) instead of
      // relying on them to remember to re-open it.
      setActionStatus("Order delivered. The finalized invoice is ready below — send it to the customer.");
      document.querySelector(".order-invoice-section")?.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (error) {
      statusNode.textContent = error.message || String(error);
      statusNode.style.color = "var(--danger, #b3261e)";
    }
  });
}

function eventTime(value) {
  if (!value) return 0;
  if (typeof value?.toMillis === "function") return value.toMillis();
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

function renderAuditTimeline(order, payments, deposits, returns, corrections, documents) {
  const events = [];
  events.push({ time: order.createdAtServer || order.createdAt, type: "Order created", detail: `${humanize(order.sourceChannel)} · ${order.customerName || "Unknown customer"}` });
  if (order.updatedAt) events.push({ time: order.updatedAt, type: "Order updated", detail: `Current status: ${humanize(order.status)}` });
  if (order.deliveredAt) events.push({ time: order.deliveredAt, type: "Delivered", detail: order.assignedDriverId ? `Driver ${order.assignedDriverId}` : "Delivery completed" });
  if (order.cancelledAt || order.status === "cancelled") events.push({ time: order.cancelledAt || order.updatedAt, type: "Order cancelled", detail: order.cancellationReason || "No reason recorded" });
  payments.forEach((p) => events.push({ time: p.paymentDate || p.createdAt, type: "Payment recorded", detail: `${formatCurrency(p.amount)} · ${humanize(p.method)}${p.reference ? ` · ${p.reference}` : ""}` }));
  deposits.forEach((d) => events.push({ time: d.eventDate || d.createdAt, type: `Deposit ${humanize(d.eventType)}`, detail: `${Number(d.qty || 0)} ${humanize(d.containerType)} · ${formatCurrency(d.amount)}` }));
  returns.forEach((r) => events.push({ time: r.returnedAt || r.returnDate || r.createdAt, type: "Container return", detail: `${Number(r.qty || 0)} ${humanize(r.containerType)} · ${humanize(r.condition)}` }));
  corrections.forEach((c) => events.push({ time: c.createdAt || c.createdAtIso, type: humanize(c.category || "Correction note"), detail: c.note, actor: c.createdByEmail || c.createdByUid }));
  documents.forEach((documentRecord) => events.push({ time: documentRecord.uploadedAt, type: `${documentLabel(documentRecord.documentType)} uploaded`, detail: documentRecord.paymentId ? `Linked to payment ${documentRecord.paymentId}` : `Document ${documentRecord.id}` }));
  events.sort((a, b) => eventTime(b.time) - eventTime(a.time));
  el("order-audit-timeline").innerHTML = events.map((event) => `<article class="order-audit-event"><div class="order-audit-dot" aria-hidden="true"></div><div><div class="order-audit-event-head"><strong>${escapeHtml(event.type)}</strong><time>${escapeHtml(dateValue(event.time))}</time></div><p>${escapeHtml(event.detail || "")}</p>${event.actor ? `<small>Recorded by ${escapeHtml(event.actor)}</small>` : ""}</div></article>`).join("");
}

async function appendCorrection(event) {
  event.preventDefault();
  const note = el("order-correction-note").value.trim();
  const status = el("order-correction-status");
  if (note.length < 10) { status.textContent = "Explain the correction in at least 10 characters."; return; }
  const button = event.submitter;
  button.disabled = true;
  status.textContent = "Appending permanent note…";
  try {
    await addDoc(collection(db, "orderCorrections"), {
      orderId,
      category: el("order-correction-category").value,
      note,
      createdAt: serverTimestamp(),
      createdAtIso: new Date().toISOString(),
      createdByUid: auth.currentUser?.uid || null,
      createdByEmail: auth.currentUser?.email || null
    });
    el("order-correction-form").reset();
    status.textContent = "Correction appended.";
    await loadOrderRecord();
  } catch (error) { status.textContent = `Could not append correction: ${error.message || error}`; }
  finally { button.disabled = false; }
}

async function downloadInvoice() {
  if (!currentInvoiceContext) return;
  const status = el("order-invoice-status");
  try {
    status.textContent = "Building PDF…";
    const pdf = await generateInvoicePdf(currentInvoiceContext);
    pdf.save(`invoice-${currentInvoiceContext.invoiceNumber}.pdf`);
    status.textContent = "Invoice downloaded.";
  } catch (error) { status.textContent = `Could not create PDF: ${error.message || error}`; }
}

async function emailInvoice() {
  if (!currentInvoiceContext) return;
  const href = buildEmailShare(currentInvoiceContext);
  if (!href) return;
  const status = el("order-invoice-status");
  try {
    status.textContent = "Preparing PDF and email…";
    const pdf = await generateInvoicePdf(currentInvoiceContext);
    pdf.save(`invoice-${currentInvoiceContext.invoiceNumber}.pdf`);
    setTimeout(() => { location.href = href; }, 350);
    status.textContent = "PDF downloaded. Attach it to the email draft.";
  } catch (error) { status.textContent = `Could not prepare email: ${error.message || error}`; }
}

el("order-invoice-download").addEventListener("click", downloadInvoice);
el("order-invoice-email").addEventListener("click", emailInvoice);
el("order-correction-form").addEventListener("submit", appendCorrection);
el("edit-order-form").addEventListener("submit", saveEditedOrder);
el("edit-cancel-button").addEventListener("click", () => el("edit-order-dialog").close());
el("edit-add-item-button").addEventListener("click", addEditItem);
el("delivery-payment-form").addEventListener("submit", saveDeliveryPayment);
el("delivery-payment-cancel-button").addEventListener("click", () => el("delivery-payment-dialog").close());
document.querySelectorAll('input[name="collected"]').forEach((radio) => radio.addEventListener("change", () => {
  toggleDeliveryPaymentFields();
  recalcDeliveryCod();
}));
el("delivery-loss-checkbox").addEventListener("change", toggleLossFields);
// A hand-typed amount stops the live recalc from overwriting it. Emptying the
// field hands control back to the auto-fill.
el("delivery-payment-amount").addEventListener("input", () => {
  deliveryDialogState.amountOverridden = el("delivery-payment-amount").value.trim() !== "";
  recalcDeliveryCod();
});

onAuthStateChanged(auth, async (user) => {
  if (!user) { el("auth-view").classList.remove("hidden"); el("app-view").classList.add("hidden"); return; }
  if (!(await requireRole(user, "owner"))) return;
  el("auth-view").classList.add("hidden"); el("app-view").classList.remove("hidden");
  el("order-load-status").textContent = "Loading complete order record…";
  try { await loadOrderRecord(); } catch (error) { el("order-headline").textContent = "Order unavailable"; el("order-load-status").textContent = error.message || String(error); }
});

import { addDoc, auth, collection, db, doc, getDoc, getDocs, onAuthStateChanged, query, serverTimestamp, where } from "./firebaseClient.js";
import { formatCurrency, requireRole } from "./shared.js";
import { attachQrToPreview, buildEmailShare, buildWhatsAppShare, generateInvoicePdf, invoiceContext, renderInvoiceHtml } from "./invoice.js";

const el = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value == null ? "" : value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const orderId = new URLSearchParams(location.search).get("id") || "";
let currentInvoiceContext = null;

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
  const [itemsSnap, paymentsSnap, depositsSnap, returnsSnap, correctionsSnap, orderDocumentsSnap, customerSnap, settingsSnap] = await Promise.all([
    getDocs(query(collection(db, "orderItems"), where("orderId", "==", orderId))),
    getDocs(query(collection(db, "payments"), where("orderId", "==", orderId))),
    getDocs(query(collection(db, "depositEvents"), where("orderId", "==", orderId))),
    getDocs(query(collection(db, "returns"), where("orderId", "==", orderId))),
    getDocs(query(collection(db, "orderCorrections"), where("orderId", "==", orderId))),
    getDocs(query(collection(db, "documents"), where("entityId", "==", orderId))),
    order.customerId ? getDoc(doc(db, "customers", order.customerId)) : Promise.resolve(null),
    getDoc(doc(db, "settings", "business"))
  ]);
  const customer = customerSnap?.exists() ? customerSnap.data() : {};
  const payments = paymentsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const documents = await loadLinkedDocuments(orderDocumentsSnap, payments);
  await renderOrder(order, customer, itemsSnap.docs.map((d) => ({ id: d.id, ...d.data() })), payments, depositsSnap.docs.map((d) => ({ id: d.id, ...d.data() })), returnsSnap.docs.map((d) => ({ id: d.id, ...d.data() })), correctionsSnap.docs.map((d) => ({ id: d.id, ...d.data() })), documents, settingsSnap.exists() ? settingsSnap.data() : {});
}

async function renderOrder(order, customer, items, payments, deposits, returns, corrections, documents, settings) {
  const status = order.status || "unknown";
  const payStatus = order.paymentStatus || "unpaid";
  el("order-headline").textContent = order.id;
  el("order-subline").textContent = `Order for ${order.customerName || customer.name || "Unknown customer"} · delivery ${order.deliveryDate || "not scheduled"}`;
  const customerHref = order.customerId ? `./customer.html?id=${encodeURIComponent(order.customerId)}` : "";
  const boardHref = `./admin.html?date=${encodeURIComponent(order.deliveryDate || "")}`;
  el("order-summary").innerHTML = `
    <div class="order-record-heading"><div><span class="badge status-${escapeHtml(status)}">${escapeHtml(humanize(status))}</span> <span class="badge pay-${escapeHtml(payStatus)}">${escapeHtml(humanize(payStatus))}</span></div><div class="button-row">${customerHref ? `<a class="button-link primary" href="${customerHref}">Open customer</a>` : ""}<a class="button-link secondary" href="${boardHref}">Open delivery board</a></div></div>
    <div class="order-record-grid"><div><span>Customer</span><strong>${escapeHtml(order.customerName || customer.name || "Unknown")}</strong><small>${escapeHtml(order.phone || customer.phone || "No phone")}${order.email || customer.email ? `<br>${escapeHtml(order.email || customer.email)}` : ""}</small></div><div><span>Delivery</span><strong>${escapeHtml(order.deliveryDate || "Not scheduled")}</strong><small>${escapeHtml(order.deliveryWindow || "No window")}</small></div><div class="order-record-address"><span>Delivery address</span><strong>${escapeHtml(order.address || "Not recorded")}</strong></div></div>
    ${order.notes ? `<div class="order-record-notes"><span>Order notes</span><p>${escapeHtml(order.notes)}</p></div>` : ""}`;
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
  currentInvoiceContext = invoiceContext({ order, items, settings });
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

onAuthStateChanged(auth, async (user) => {
  if (!user) { el("auth-view").classList.remove("hidden"); el("app-view").classList.add("hidden"); return; }
  if (!(await requireRole(user, "owner"))) return;
  el("auth-view").classList.add("hidden"); el("app-view").classList.remove("hidden");
  el("order-load-status").textContent = "Loading complete order record…";
  try { await loadOrderRecord(); } catch (error) { el("order-headline").textContent = "Order unavailable"; el("order-load-status").textContent = error.message || String(error); }
});

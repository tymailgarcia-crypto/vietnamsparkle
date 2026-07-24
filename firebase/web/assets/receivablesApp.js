import {
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
  signOut,
  where
} from "./firebaseClient.js";
import { buildPaymentId, collectedPaymentProblem, formatCurrency, initPhotoSourceInputs, mergeThresholds, paymentEvidenceProblem, requireRole, THRESHOLD_DEFAULTS, todayKey, withSubmitLock } from "./shared.js";
import {
  invoiceContext,
  renderInvoiceHtml,
  attachQrToPreview,
  generateInvoicePdf,
  buildEmailShare,
  buildWhatsAppShare
} from "./invoice.js";
import {
  ensureInvoicePdfUploaded,
  uploadPaymentProof,
  validateProofFile
} from "./storageUploads.js";

const state = {
  rows: [],
  search: "",
  thresholds: { ...THRESHOLD_DEFAULTS }
};

// P0-09: the money write moved server-side (fresh status/balance re-read,
// zero→deferred routing, acknowledged overpay credit, cancelled/undelivered
// rejection) — same pattern as approval/cancellation/delivery-commit.
const recordPaymentFn = httpsCallable(functions, "recordPayment");

function el(id) {
  return document.getElementById(id);
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function setStatus(message) {
  const node = el("list-status");
  if (node) node.textContent = message || "";
}

function daysSince(dateString) {
  if (!dateString) return 0;
  const then = new Date(dateString);
  if (Number.isNaN(then.getTime())) return 0;
  const diffMs = Date.now() - then.getTime();
  return Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
}

function phoneDigits(phone) {
  return String(phone || "").replace(/[^0-9+]/g, "");
}

function whatsappHref(phone, text) {
  const digits = phoneDigits(phone).replace(/^\+/, "");
  if (!digits) return "";
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

function matchesSearch(row) {
  if (!state.search) return true;
  const q = state.search.toLowerCase();
  return [row.customerName, row.phone, row.id]
    .some((f) => String(f || "").toLowerCase().includes(q));
}

function renderRows() {
  const tbody = el("receivable-rows");
  const filtered = state.rows.filter(matchesSearch);
  setStatus(state.search
    ? `${filtered.length} of ${state.rows.length} outstanding balances`
    : `${state.rows.length} outstanding balance${state.rows.length === 1 ? "" : "s"}`);

  if (!filtered.length) {
    tbody.innerHTML = `<tr class="receivable-empty"><td colspan="8" class="muted" style="padding:20px;text-align:center">Nothing outstanding. Nice.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map((row) => {
    const days = daysSince(row.deliveryDate);
    const dayCell = days >= state.thresholds.receivableOverdueDays
      ? `<span style="color:rgb(122,32,22);font-weight:600">${days}d</span>`
      : `${days}d`;
    const followUpCell = row.followUpBy ? escapeHtml(row.followUpBy) : "";
    const followUpOverdue = row.followUpBy && row.followUpBy < todayKey();
    const followUpDisplay = followUpOverdue
      ? `<span style="color:rgb(122,32,22);font-weight:600">${followUpCell}</span>`
      : followUpCell;
    const customerLink = row.customerId
      ? `<a href="./customer.html?id=${encodeURIComponent(row.customerId)}">${escapeHtml(row.customerName || "Unknown")}</a>`
      : escapeHtml(row.customerName || "Unknown");
    const phoneCell = row.phone
      ? `<a href="tel:${phoneDigits(row.phone)}">${escapeHtml(row.phone)}</a>`
      : "";
    const orderLink = `<a href="./order.html?id=${encodeURIComponent(row.id)}">${escapeHtml(row.id)}</a>`;
    const chaseText = `Hi ${row.customerName || ""}, just a reminder that ${formatCurrency(row.balanceDue)} is still due from your order on ${row.deliveryDate || ""}. You can pay by cash on next delivery, bank transfer, or QR. Thanks!`;
    const chaseHref = whatsappHref(row.phone, chaseText);
    const chaseButton = chaseHref
      ? `<a class="button-link secondary" href="${chaseHref}" target="_blank" rel="noopener">Chase via WhatsApp</a>`
      : `<span class="muted">No phone on file</span>`;
    return `
      <tr class="receivable-row">
        <td data-label="Delivered">${escapeHtml(row.deliveryDate || "")}</td>
        <td data-label="Age">${dayCell}</td>
        <td data-label="Customer" class="receivable-customer">${customerLink}</td>
        <td data-label="Phone">${phoneCell}</td>
        <td data-label="Order" class="receivable-order">${orderLink}</td>
        <td data-label="Balance" class="receivable-balance">${escapeHtml(formatCurrency(row.balanceDue))}</td>
        <td data-label="Follow-up">${followUpDisplay || `<span class="muted">Not set</span>`}</td>
        <td data-label="Actions" class="receivable-actions">
          <div class="button-row" style="gap:6px;flex-wrap:wrap">
            <button class="primary" type="button" data-collect="${row.id}">Record payment</button>
            <button class="ghost" type="button" data-invoice="${row.id}">Invoice</button>
            ${chaseButton}
          </div>
        </td>
      </tr>
    `;
  }).join("");

  tbody.querySelectorAll("[data-collect]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const row = state.rows.find((r) => r.id === btn.dataset.collect);
      if (row) openRecordPaymentDialog(row);
    });
  });
  tbody.querySelectorAll("[data-invoice]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const row = state.rows.find((r) => r.id === btn.dataset.invoice);
      if (row) await openInvoiceDialog(row);
    });
  });
}

async function loadThresholdsFromSettings() {
  try {
    const snap = await getDoc(doc(db, "settings", "business"));
    const settings = snap.exists() ? snap.data() : {};
    state.thresholds = mergeThresholds(settings.thresholds);
  } catch (_) {
    state.thresholds = { ...THRESHOLD_DEFAULTS };
  }
}

async function loadReceivables() {
  setStatus("Loading receivables...");
  try {
    await loadThresholdsFromSettings();
    const snap = await getDocs(query(collection(db, "orders"), where("balanceDue", ">", 0)));
    state.rows = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      // P0-09: DELIVERED ONLY. This page used to include new/assigned/
      // out_for_delivery orders under a column labelled "Delivered", so the
      // owner could chase a customer for money on water that had not arrived
      // yet. Undelivered money is collected at the door (commitDelivery), and
      // recordPayment rejects undelivered orders server-side to match.
      .filter((o) => o.status === "delivered")
      .sort((a, b) => String(a.deliveryDate || "").localeCompare(String(b.deliveryDate || "")));
    renderRows();
    renderNagTiles();
  } catch (error) {
    setStatus(`Could not load receivables: ${error.message || error}`);
  }
}

function renderNagTiles() {
  const tiles = el("receivables-nag-tiles");
  if (!tiles) return;
  const unpaid = state.rows;
  const unpaidTotal = unpaid.reduce((s, o) => s + Number(o.balanceDue || 0), 0);
  const oldestUnpaidDays = unpaid.reduce((max, o) => {
    const d = o.deliveryDate;
    if (!d) return max;
    const days = Math.floor((Date.now() - new Date(d).getTime()) / 86400000);
    return Math.max(max, days);
  }, 0);
  const unpaidClass = oldestUnpaidDays >= 3 ? 'style="border:2px solid rgb(192,57,43)"' : "";

  tiles.innerHTML = `
    <div class="card" ${unpaidClass}>
      <span class="muted">Unpaid</span>
      <strong>${unpaid.length} · ${formatCurrency(unpaidTotal)}</strong>
      ${oldestUnpaidDays > 0 ? `<div class="muted">Oldest ${oldestUnpaidDays}d</div>` : ""}
    </div>
  `;
}

function daysFromToday(days) {
  const d = new Date();
  d.setDate(d.getDate() + Number(days || 0));
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function toggleRecordPaymentFields() {
  const collected = document.querySelector('input[name="record-collected"]:checked')?.value === "collected";
  el("record-collected-fields").classList.toggle("hidden", !collected);
  el("record-deferred-fields").classList.toggle("hidden", collected);
}

function openRecordPaymentDialog(row) {
  const dialog = el("record-payment-dialog");
  if (!dialog || typeof dialog.showModal !== "function") return;
  el("record-payment-order-id").value = row.id;
  el("record-payment-customer").textContent = row.customerName || "customer";
  el("record-payment-due").textContent = formatCurrency(row.balanceDue);
  el("record-payment-amount").value = Number(row.balanceDue || 0);
  el("record-payment-method").value = "cash";
  el("record-payment-reference").value = "";
  // A file input keeps its selection across dialog opens — without this the
  // next row's payment silently inherits the previous row's proof photo.
  const proofInput = el("record-payment-proof");
  if (proofInput) proofInput.value = "";
  // P0-09: zero collected is not a payment — it routes to this explicit
  // deferred branch, which records a reason and a follow-up date instead.
  const collectedRadio = document.querySelector('input[name="record-collected"][value="collected"]');
  if (collectedRadio) collectedRadio.checked = true;
  el("record-deferral-reason").value = "customer_said_next_time";
  el("record-follow-up").value = row.followUpBy || daysFromToday(state.thresholds.followUpDays);
  el("record-deferral-notes").value = "";
  toggleRecordPaymentFields();
  const statusNode = el("record-payment-status");
  if (statusNode) {
    statusNode.textContent = "";
    statusNode.style.color = "";
  }
  dialog.showModal();
}

async function saveRecordPayment(event) {
  event.preventDefault();
  const orderId = el("record-payment-order-id").value;
  const row = state.rows.find((r) => r.id === orderId);
  const statusNode = el("record-payment-status");
  if (!row) return;
  const showError = (message) => {
    statusNode.textContent = message;
    statusNode.style.color = "var(--danger, #b3261e)";
  };

  // Snapshot every DOM input up front (same discipline as the delivery
  // dialogs) — nothing below re-reads the form.
  const collected = document.querySelector('input[name="record-collected"]:checked')?.value === "collected";
  let paymentSnapshot;
  let proofFile = null;
  if (collected) {
    const amount = Number(el("record-payment-amount").value || 0);
    // Positive whole VND only. Every row here has a balance remaining (the
    // page lists balanceDue > 0), so zero is rejected and routed to the
    // "Not collected" branch. Same rule the server re-checks.
    const problem = collectedPaymentProblem(amount, Math.max(1, Number(row.balanceDue || 0)));
    if (problem) {
      showError(problem);
      return;
    }
    const proofInput = el("record-payment-proof");
    proofFile = proofInput && proofInput.files && proofInput.files[0] ? proofInput.files[0] : null;
    if (proofFile) {
      const proofProblem = validateProofFile(proofFile);
      if (proofProblem) {
        showError(proofProblem);
        return;
      }
    }
    // Electronic payments (transfer/QR) need a reference or a photo — same rule
    // the server re-checks. Cash is exempt.
    const evidenceProblem = paymentEvidenceProblem({
      method: el("record-payment-method").value || "cash",
      reference: el("record-payment-reference").value,
      hasProof: !!proofFile,
      amount
    });
    if (evidenceProblem) {
      showError(evidenceProblem);
      return;
    }
    paymentSnapshot = {
      collected: true,
      amount,
      method: el("record-payment-method").value || "cash",
      reference: el("record-payment-reference").value.trim() || null
    };
  } else {
    const followUpBy = el("record-follow-up").value;
    if (!followUpBy) {
      showError("Pick a follow-up date so this doesn't fall off the list.");
      return;
    }
    paymentSnapshot = {
      collected: false,
      reason: el("record-deferral-reason").value || "other",
      followUpBy,
      notes: el("record-deferral-notes").value.trim() || null
    };
  }

  await withSubmitLock(event, async () => {
    try {
      statusNode.textContent = "Saving...";
      statusNode.style.color = "";
      const paymentId = buildPaymentId();
      // Upload before the callable runs: a failed upload must abort the save
      // rather than record a payment whose proof the owner believes attached.
      // Same shape as the delivery dialogs.
      let proofDocumentId = null;
      let proofUrl = null;
      if (proofFile) {
        statusNode.textContent = "Uploading proof photo…";
        const proof = await uploadPaymentProof({ orderId, paymentId, file: proofFile });
        proofDocumentId = proof.documentId;
        // Denormalized so the today board renders a thumbnail without a
        // documents lookup per payment. See adminApp.js::saveDeliveryPayment.
        proofUrl = proof.downloadUrl;
        statusNode.textContent = "Saving...";
      }

      // Overpayment needs an explicit confirmation that STATES the resulting
      // credit. First confirm against the dialog's number; the server
      // recomputes against the FRESH balance and rejects a mismatch with the
      // real figure, so a stale dialog re-confirms against the truth below.
      let acknowledgeCredit = null;
      if (paymentSnapshot.collected) {
        const knownBalance = Math.max(0, Number(row.balanceDue || 0));
        const credit = Math.max(0, paymentSnapshot.amount - knownBalance);
        if (credit > 0) {
          const ok = window.confirm(
            `That is ${formatCurrency(credit)} more than the ${formatCurrency(knownBalance)} due. ` +
            `The extra stays on ${row.customerName || "the customer"}'s account as credit. Record it?`
          );
          if (!ok) {
            statusNode.textContent = "Not saved.";
            return;
          }
          acknowledgeCredit = credit;
        }
      }

      // P0-09: the write is one server transaction (recordPayment callable) —
      // it re-reads fresh status AND balance, rejects cancelled/undelivered
      // orders, and is idempotent per paymentId.
      const callRecord = (ack) => recordPaymentFn({
        orderId,
        paymentId,
        payment: paymentSnapshot,
        proofDocumentId,
        proofUrl,
        acknowledgeCredit: ack
      });
      try {
        await callRecord(acknowledgeCredit);
      } catch (error) {
        const details = error && error.details;
        if (details && details.overpayment && Number.isInteger(details.resultingCredit)) {
          // Stale dialog: the balance changed since it opened. Nothing was
          // written; re-confirm with the server's fresh numbers and retry
          // under the same paymentId.
          const ok = window.confirm(
            `The balance changed since this dialog opened — ${formatCurrency(details.freshBalance)} is due now, ` +
            `so this payment leaves ${formatCurrency(details.resultingCredit)} as customer credit. Record it?`
          );
          if (!ok) {
            statusNode.textContent = "Not saved — refresh to see the current balance.";
            return;
          }
          await callRecord(details.resultingCredit);
        } else {
          throw error;
        }
      }
      el("record-payment-dialog").close();
      await loadReceivables();
    } catch (error) {
      showError(error.message || String(error));
    }
  });
}

const invoiceState = { currentCtx: null };

async function loadBusinessSettings() {
  try {
    const snap = await getDoc(doc(db, "settings", "business"));
    return snap.exists() ? snap.data() : {};
  } catch (_) {
    return {};
  }
}

async function openInvoiceDialog(row) {
  const dialog = el("invoice-dialog");
  const slot = el("invoice-preview-slot");
  const statusNode = el("invoice-status");
  const downloadBtn = el("invoice-download-button");
  const whatsappBtn = el("invoice-whatsapp-button");
  if (!dialog || !slot) return;

  slot.innerHTML = `<div style="padding:24px;color:var(--muted);text-align:center">Loading invoice…</div>`;
  if (statusNode) statusNode.textContent = "";
  if (whatsappBtn) whatsappBtn.style.display = "none";
  dialog.showModal();

  try {
    const [settings, itemsSnap] = await Promise.all([
      loadBusinessSettings(),
      getDocs(query(collection(db, "orderItems"), where("orderId", "==", row.id)))
    ]);
    const items = itemsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const ctx = invoiceContext({ order: row, items, settings });
    slot.innerHTML = renderInvoiceHtml(ctx);
    await attachQrToPreview(ctx, slot);
    invoiceState.currentCtx = ctx;
    downloadBtn.disabled = false;
    // Upload happens on share-click, not here — previewing shouldn't push a PDF
    // into Storage. Mirrors openInvoiceDialog in adminApp.js.
    const emailBtn = el("invoice-email-button");
    if (emailBtn) emailBtn.style.display = buildEmailShare(ctx) ? "" : "none";
    if (whatsappBtn) whatsappBtn.style.display = buildWhatsAppShare(ctx) ? "" : "none";
  } catch (error) {
    slot.innerHTML = `<div style="padding:24px;color:var(--danger)">Could not load invoice: ${escapeHtml(error.message || error)}</div>`;
  }
}

async function downloadInvoice() {
  const ctx = invoiceState.currentCtx;
  const statusNode = el("invoice-status");
  if (!ctx) return;
  try {
    if (statusNode) statusNode.textContent = "Building PDF…";
    const pdf = await generateInvoicePdf(ctx);
    pdf.save(`invoice-${ctx.invoiceNumber}.pdf`);
    if (statusNode) statusNode.textContent = "Downloaded.";
  } catch (error) {
    if (statusNode) statusNode.textContent = `PDF error: ${error.message || error}`;
  }
}

async function emailInvoice() {
  const ctx = invoiceState.currentCtx;
  const statusNode = el("invoice-status");
  if (!ctx) return;
  if (!buildEmailShare(ctx)) {
    if (statusNode) statusNode.textContent = "No customer email on file.";
    return;
  }
  await withSubmitLock(el("invoice-email-button"), async () => {
    try {
      if (statusNode) statusNode.textContent = "Uploading PDF…";
      const { downloadUrl } = await ensureInvoicePdfUploaded(ctx);
      window.location.href = buildEmailShare(ctx, downloadUrl);
      if (statusNode) statusNode.textContent = "Email opened with a link to the PDF. No attachment needed.";
    } catch (error) {
      if (statusNode) statusNode.textContent = `Email error: ${error.message || error}`;
    }
  }, { busyLabel: "Uploading…" });
}

async function whatsappInvoice() {
  const ctx = invoiceState.currentCtx;
  const statusNode = el("invoice-status");
  if (!ctx) return;
  if (!buildWhatsAppShare(ctx)) {
    if (statusNode) statusNode.textContent = "No customer phone on file.";
    return;
  }
  // Opened synchronously — a window.open after the upload await is a popup and
  // gets blocked. Same reasoning as adminApp.js::whatsappInvoice.
  const tab = window.open("", "_blank", "noopener");
  await withSubmitLock(el("invoice-whatsapp-button"), async () => {
    try {
      if (statusNode) statusNode.textContent = "Uploading PDF…";
      const { downloadUrl } = await ensureInvoicePdfUploaded(ctx);
      const share = buildWhatsAppShare(ctx, downloadUrl);
      if (tab) {
        tab.location.href = share;
        if (statusNode) statusNode.textContent = "WhatsApp opened with a link to the PDF.";
      } else if (statusNode) {
        statusNode.innerHTML = `Pop-up blocked — <a href="${escapeHtml(share)}" target="_blank" rel="noopener">open WhatsApp</a>.`;
      }
    } catch (error) {
      if (tab) tab.close();
      if (statusNode) statusNode.textContent = `WhatsApp error: ${error.message || error}`;
    }
  }, { busyLabel: "Uploading…" });
}

el("search-input").addEventListener("input", (event) => {
  state.search = event.target.value.trim();
  renderRows();
});
el("refresh-button").addEventListener("click", loadReceivables);
el("record-payment-form").addEventListener("submit", saveRecordPayment);
el("record-payment-cancel-button").addEventListener("click", () => {
  el("record-payment-dialog").close();
});
document.querySelectorAll('input[name="record-collected"]').forEach((radio) => {
  radio.addEventListener("change", toggleRecordPaymentFields);
});
const invoiceCloseBtn = el("invoice-close-button");
if (invoiceCloseBtn) invoiceCloseBtn.addEventListener("click", () => el("invoice-dialog").close());
const invoiceDownloadBtn = el("invoice-download-button");
if (invoiceDownloadBtn) invoiceDownloadBtn.addEventListener("click", downloadInvoice);
const invoiceEmailBtn = el("invoice-email-button");
if (invoiceEmailBtn) invoiceEmailBtn.addEventListener("click", emailInvoice);
const invoiceWhatsappBtn = el("invoice-whatsapp-button");
if (invoiceWhatsappBtn) invoiceWhatsappBtn.addEventListener("click", whatsappInvoice);

onAuthStateChanged(auth, async (user) => {
  const authView = el("auth-view");
  const appView = el("app-view");
  if (!user) {
    authView.classList.remove("hidden");
    appView.classList.add("hidden");
    return;
  }
  if (!(await requireRole(user, "owner"))) return;
  authView.classList.add("hidden");
  appView.classList.remove("hidden");
  await loadReceivables();
});

// Give the record-payment dialog's proof input an explicit Take photo / library
// choice. The dialog is static in receivables.html, so one call at load covers it.
initPhotoSourceInputs();

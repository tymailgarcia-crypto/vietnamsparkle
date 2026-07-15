import {
  auth,
  collection,
  db,
  doc,
  getDoc,
  getDocs,
  onAuthStateChanged,
  query,
  runTransaction,
  setDoc,
  signOut,
  updateDoc,
  where
} from "./firebaseClient.js";
import { buildPaymentId, formatCurrency, mergeThresholds, paymentStatusFor, requireRole, THRESHOLD_DEFAULTS, todayKey, withSubmitLock } from "./shared.js";
import {
  invoiceContext,
  renderInvoiceHtml,
  attachQrToPreview,
  generateInvoicePdf,
  buildEmailShare,
  buildWhatsAppShare
} from "./invoice.js";

const state = {
  rows: [],
  search: "",
  thresholds: { ...THRESHOLD_DEFAULTS }
};

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
    const orderLink = `<a href="./admin.html?date=${encodeURIComponent(row.deliveryDate || "")}">${escapeHtml(row.id)}</a>`;
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
      .filter((o) => o.status !== "cancelled" && o.status !== "pending_approval")
      .sort((a, b) => String(a.deliveryDate || "").localeCompare(String(b.deliveryDate || "")));
    renderRows();
    renderNagTiles();
  } catch (error) {
    setStatus(`Could not load receivables: ${error.message || error}`);
  }
}

async function renderNagTiles() {
  const tiles = el("receivables-nag-tiles");
  if (!tiles) return;
  try {
    const unpaid = state.rows;
    const unpaidTotal = unpaid.reduce((s, o) => s + Number(o.balanceDue || 0), 0);
    const oldestUnpaidDays = unpaid.reduce((max, o) => {
      const d = o.deliveryDate;
      if (!d) return max;
      const days = Math.floor((Date.now() - new Date(d).getTime()) / 86400000);
      return Math.max(max, days);
    }, 0);

    const depositsSnap = await getDocs(collection(db, "depositEvents"));
    const perPair = {};
    depositsSnap.docs.forEach((docSnap) => {
      const e = docSnap.data();
      const cid = e.customerId;
      const type = String(e.containerType || "other");
      if (!cid) return;
      const key = `${cid}|${type}`;
      if (!perPair[key]) perPair[key] = { qty: 0, amount: 0, since: null };
      const qty = Number(e.qty || 0);
      const amount = Number(e.amount || 0);
      if (e.eventType === "charged") {
        perPair[key].qty += qty;
        perPair[key].amount += amount;
        if (e.eventDate && (!perPair[key].since || e.eventDate < perPair[key].since)) {
          perPair[key].since = e.eventDate;
        }
      } else if (["refunded", "credited", "forfeited"].includes(e.eventType)) {
        perPair[key].qty -= qty;
        perPair[key].amount -= amount;
      }
    });
    let containerCount = 0;
    let depositTotal = 0;
    let atRiskCount = 0;
    Object.values(perPair).forEach((row) => {
      if (row.qty > 0) {
        containerCount += row.qty;
        depositTotal += Math.max(0, row.amount);
        if (row.since) {
          const days = Math.floor((Date.now() - new Date(row.since).getTime()) / 86400000);
          if (days >= 60) atRiskCount += row.qty;
        }
      }
    });

    const unpaidClass = oldestUnpaidDays >= 3 ? 'style="border:2px solid rgb(192,57,43)"' : "";
    const atRiskClass = atRiskCount > 0 ? 'style="border:2px solid rgb(192,57,43)"' : "";
    tiles.innerHTML = `
      <div class="card" ${unpaidClass}>
        <span class="muted">Unpaid</span>
        <strong>${unpaid.length} · ${formatCurrency(unpaidTotal)}</strong>
        ${oldestUnpaidDays > 0 ? `<div class="muted">Oldest ${oldestUnpaidDays}d</div>` : ""}
      </div>
      <a class="card" ${atRiskClass} href="./deposits.html" style="text-decoration:none;color:inherit">
        <span class="muted">Containers out</span>
        <strong>${containerCount} · ${formatCurrency(depositTotal)}</strong>
        ${atRiskCount > 0 ? `<div class="muted">${atRiskCount} held &gt;60 days</div>` : ""}
      </a>
    `;
  } catch (error) {
    tiles.innerHTML = `<div class="card muted">Could not load outstanding totals: ${error.message || error}</div>`;
  }
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
  const amount = Number(el("record-payment-amount").value || 0);
  const method = el("record-payment-method").value;
  const reference = el("record-payment-reference").value.trim() || null;
  if (amount < 0) {
    statusNode.textContent = "Amount cannot be negative.";
    statusNode.style.color = "var(--danger, #b3261e)";
    return;
  }
  await withSubmitLock(event, async () => {
    try {
      statusNode.textContent = "Saving...";
      statusNode.style.color = "";
      const now = new Date().toISOString();
      const today = todayKey();
      const paymentId = buildPaymentId();
      // Transaction re-reads the order every retry so newAmountPaid is
      // computed against the fresh server value. Two owner tabs recording
      // payments on the same order can't silently overwrite each other.
      await runTransaction(db, async (tx) => {
        const orderRef = doc(db, "orders", orderId);
        const orderSnap = await tx.get(orderRef);
        if (!orderSnap.exists()) throw new Error("Order no longer exists.");
        const order = orderSnap.data();
        const newAmountPaid = Number(order.amountPaid || 0) + amount;
        const total = Number(order.subtotal || 0) + Number(order.depositTotal || 0);
        const newBalance = total - newAmountPaid;
        tx.set(doc(db, "payments", paymentId), {
          orderId,
          customerId: order.customerId || null,
          authUid: order.authUid || null,
          paymentDate: today,
          method,
          amount,
          reference,
          receivedBy: auth.currentUser ? auth.currentUser.email : "owner",
          proofDocumentId: null,
          notes: "Recorded from receivables page",
          deferred: false,
          createdAt: now
        });
        tx.update(orderRef, {
          amountPaid: newAmountPaid,
          balanceDue: newBalance,
          paymentStatus: paymentStatusFor(newAmountPaid, newBalance),
          updatedAt: now
        });
      });
      el("record-payment-dialog").close();
      await loadReceivables();
    } catch (error) {
      statusNode.textContent = error.message || String(error);
      statusNode.style.color = "var(--danger, #b3261e)";
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
    const emailBtn = el("invoice-email-button");
    const mailto = buildEmailShare(ctx);
    if (emailBtn) emailBtn.style.display = mailto ? "" : "none";
    const share = buildWhatsAppShare(ctx);
    if (share && whatsappBtn) {
      whatsappBtn.href = share;
      whatsappBtn.style.display = "";
    }
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
  const mailto = buildEmailShare(ctx);
  if (!mailto) {
    if (statusNode) statusNode.textContent = "No customer email on file.";
    return;
  }
  try {
    if (statusNode) statusNode.textContent = "Preparing PDF + opening email…";
    const pdf = await generateInvoicePdf(ctx);
    pdf.save(`invoice-${ctx.invoiceNumber}.pdf`);
    await new Promise((r) => setTimeout(r, 400));
    window.location.href = mailto;
    if (statusNode) statusNode.textContent = "PDF downloaded. Attach it in the email compose window that just opened.";
  } catch (error) {
    if (statusNode) statusNode.textContent = `Email error: ${error.message || error}`;
  }
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
const invoiceCloseBtn = el("invoice-close-button");
if (invoiceCloseBtn) invoiceCloseBtn.addEventListener("click", () => el("invoice-dialog").close());
const invoiceDownloadBtn = el("invoice-download-button");
if (invoiceDownloadBtn) invoiceDownloadBtn.addEventListener("click", downloadInvoice);
const invoiceEmailBtn = el("invoice-email-button");
if (invoiceEmailBtn) invoiceEmailBtn.addEventListener("click", emailInvoice);

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

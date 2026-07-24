import {
  auth,
  collection,
  db,
  doc,
  getDoc,
  getDocs,
  onAuthStateChanged,
  query,
  updateDoc,
  where
} from "./firebaseClient.js";
import { escapeHtml, formatCurrency, physicalReturnsFromDepositEvents } from "./shared.js";

const el = (id) => document.getElementById(id);
const orderId = new URLSearchParams(location.search).get("id") || "";

const CUSTOMER_STATUS_LABELS = {
  pending_approval: "Waiting for confirmation",
  new: "Confirmed — being prepared",
  assigned: "Being prepared",
  out_for_delivery: "On the way",
  delivered: "Delivered",
  cancelled: "Cancelled"
};

const PAYMENT_STATUS_LABELS = {
  paid: "Paid",
  partial: "Partially paid",
  unpaid: "Unpaid"
};

function humanize(value) {
  return String(value || "Not recorded").replace(/_/g, " ");
}

function customerStatus(value) {
  return CUSTOMER_STATUS_LABELS[value] || humanize(value);
}

function paymentStatus(value) {
  return PAYMENT_STATUS_LABELS[value] || humanize(value);
}

function dateValue(value) {
  if (!value) return "Not recorded";
  if (typeof value?.toDate === "function") {
    return value.toDate().toLocaleString("en-GB", { timeZone: "Asia/Ho_Chi_Minh" });
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? String(value)
    : parsed.toLocaleString("en-GB", { timeZone: "Asia/Ho_Chi_Minh" });
}

function eventMillis(value) {
  if (!value) return 0;
  if (typeof value?.toMillis === "function") return value.toMillis();
  if (typeof value?.toDate === "function") return value.toDate().getTime();
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function empty(message) {
  return `<div class="card muted order-record-empty">${escapeHtml(message)}</div>`;
}

function eventCard(title, fields) {
  const details = fields
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`)
    .join("");
  return `<article class="card order-event-card"><strong>${escapeHtml(title)}</strong><dl>${details}</dl></article>`;
}

async function ownedRows(collectionName, userUid) {
  const snapshot = await getDocs(query(
    collection(db, collectionName),
    where("orderId", "==", orderId),
    where("authUid", "==", userUid)
  ));
  return snapshot.docs.map((row) => ({ id: row.id, ...row.data() }));
}

function renderOrder(order, items, payments, deposits) {
  // P0-05: physical returns come from the depositEvents model (credited /
  // refunded = container came back; forfeited = lost, not a return).
  const returns = physicalReturnsFromDepositEvents(deposits);
  const status = order.status || "unknown";
  const payStatus = order.paymentStatus || "unpaid";
  const total = Number(order.subtotal || 0) + Number(order.depositTotal || 0);

  document.title = `${order.orderId || order.id} · Vietnam Sparkle`;
  el("order-headline").textContent = order.orderId || order.id;
  el("order-subline").textContent = order.deliveryDate
    ? `Delivery ${order.deliveryDate}${order.deliveryWindow ? ` · ${order.deliveryWindow}` : ""}`
    : "Delivery date to be confirmed";
  el("reorder-link").href = `./index.html?reorder=${encodeURIComponent(order.id)}`;

  el("order-summary").innerHTML = `
    <div class="order-record-heading">
      <div>
        <span class="badge status-${escapeHtml(status)}">${escapeHtml(customerStatus(status))}</span>
        <span class="badge pay-${escapeHtml(payStatus)}">${escapeHtml(paymentStatus(payStatus))}</span>
      </div>
    </div>
    <div class="order-record-grid">
      <div><span>Customer</span><strong>${escapeHtml(order.customerName || "Customer")}</strong></div>
      <div><span>Delivery</span><strong>${escapeHtml(order.deliveryDate || "To be confirmed")}</strong><small>${escapeHtml(order.deliveryWindow || "Delivery window to be confirmed")}</small></div>
      <div class="order-record-address"><span>Delivery address</span><strong>${escapeHtml(order.address || "Not recorded")}</strong></div>
    </div>
    ${order.notes ? `<div class="order-record-notes"><span>Your order note</span><p>${escapeHtml(order.notes)}</p></div>` : ""}
    ${status === "cancelled" && order.cancellationReason ? `<div class="order-record-notes"><span>Cancellation</span><p>${escapeHtml(order.cancellationReason)}</p></div>` : ""}
    ${status === "pending_approval" ? `<div class="button-row top-gap"><button class="ghost" id="cancel-unapproved-order" type="button">Cancel this order</button></div>` : ""}
    ${status === "new" || status === "assigned" ? `<p class="muted top-gap" style="margin-bottom:0;font-size:13px">Confirmed and on our delivery list — message us if you need to change or cancel it.</p>` : ""}
  `;

  el("order-item-rows").innerHTML = items.length
    ? items.map((item) => {
        const qty = Number(item.quantity || 0);
        const unitPrice = Number(item.unitPrice || 0);
        const lineTotal = Number(item.lineTotal ?? (qty * unitPrice));
        return `<tr><td><strong>${escapeHtml(item.productName || "Item")}</strong></td><td style="text-align:right">${qty}</td><td style="text-align:right">${escapeHtml(formatCurrency(unitPrice))}</td><td style="text-align:right"><strong>${escapeHtml(formatCurrency(lineTotal))}</strong></td></tr>`;
      }).join("")
    : `<tr><td colspan="4" class="muted">No item records found.</td></tr>`;

  el("order-money").innerHTML = [
    ["Order total", total],
    ["Container deposits", order.depositTotal],
    ["Paid", order.amountPaid],
    ["Balance due", order.balanceDue]
  ].map(([label, value]) => `<div><span>${label}</span><strong>${escapeHtml(formatCurrency(value))}</strong></div>`).join("");

  el("order-payment-note").textContent = Number(order.balanceDue || 0) > 0
    ? "This is the current balance for this order. Your account page shows the combined balance across all orders."
    : "No payment is currently due on this order.";

  el("order-payments").innerHTML = payments.length
    ? [...payments]
        .sort((a, b) => eventMillis(b.paymentDate || b.createdAt) - eventMillis(a.paymentDate || a.createdAt))
        .map((payment) => eventCard(`${formatCurrency(payment.amount)} · ${humanize(payment.method)}`, [
          ["Date", payment.paymentDate || dateValue(payment.createdAt)],
          ["Reference", payment.reference]
        ])).join("")
    : empty("No payments recorded for this order yet.");

  el("order-deposits").innerHTML = deposits.length
    ? [...deposits].sort((a, b) => eventMillis(b.eventDate || b.createdAt) - eventMillis(a.eventDate || a.createdAt)).map((deposit) => eventCard(`${humanize(deposit.eventType)} · ${Number(deposit.qty || 0)} ${humanize(deposit.containerType)}`, [
        ["Date", deposit.eventDate || dateValue(deposit.createdAt)],
        ["Amount", formatCurrency(deposit.amount)]
      ])).join("")
    : empty("No container deposit activity for this order.");

  el("order-returns").innerHTML = returns.length
    ? [...returns].sort((a, b) => eventMillis(b.date) - eventMillis(a.date)).map((returned) => eventCard(`${Number(returned.qty || 0)} ${humanize(returned.containerType)} returned`, [
        ["Returned", dateValue(returned.date)],
        ["Deposit", `${formatCurrency(returned.amount)} ${returned.handling === "refund" ? "refunded" : "credited"}`]
      ])).join("")
    : empty("No container returns recorded for this order.");
}

async function cancelUnapprovedOrder(order) {
  if (!window.confirm("Cancel this unapproved order?")) return;
  try {
    await updateDoc(doc(db, "orders", order.id), {
      status: "cancelled",
      cancelledAt: new Date().toISOString(),
      cancelledBy: "customer",
      updatedAt: new Date().toISOString()
    });
    await loadCustomerOrder(auth.currentUser);
  } catch (error) {
    el("order-load-status").textContent = error.message || String(error);
  }
}

async function loadCustomerOrder(user) {
  if (!orderId) throw new Error("No order ID was provided.");
  const orderSnapshot = await getDoc(doc(db, "orders", orderId));
  if (!orderSnapshot.exists()) throw new Error("Order not found.");
  const order = { id: orderSnapshot.id, ...orderSnapshot.data() };
  if (order.authUid !== user.uid) throw new Error("This order does not belong to your account.");

  // P0-05: no `/returns` read — nothing has ever written that collection.
  // Physical returns are derived from this order's depositEvents in renderOrder.
  const [items, payments, deposits] = await Promise.all([
    ownedRows("orderItems", user.uid),
    ownedRows("payments", user.uid),
    ownedRows("depositEvents", user.uid)
  ]);
  renderOrder(order, items, payments, deposits);
  el("cancel-unapproved-order")?.addEventListener("click", () => cancelUnapprovedOrder(order));
}

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    el("auth-view").classList.remove("hidden");
    el("app-view").classList.add("hidden");
    return;
  }
  el("auth-view").classList.add("hidden");
  el("app-view").classList.remove("hidden");
  el("order-load-status").textContent = "Loading your order…";
  try {
    await loadCustomerOrder(user);
    el("order-load-status").textContent = "";
  } catch (error) {
    el("order-headline").textContent = "Order unavailable";
    el("order-load-status").textContent = error.message || String(error);
  }
});

import {
  auth,
  collection,
  db,
  getDocs,
  onAuthStateChanged,
  query,
  where
} from "./firebaseClient.js";
import { escapeHtml, formatCurrency, requireRole, todayKey } from "./shared.js";

function finiteAmount(value) {
  const amount = Number(value || 0);
  return Number.isFinite(amount) ? amount : 0;
}

function monthRange() {
  const to = todayKey();
  return { from: `${to.slice(0, 7)}-01`, to };
}

function rows(snapshot) {
  return snapshot.docs.map((item) => ({ id: item.id, ...(item.data() || {}) }));
}

function computeMonthSummary(orders, payments, depositEvents) {
  const deliveredOrders = orders.filter((order) => order.status === "delivered");
  const revenue = deliveredOrders.reduce((sum, order) => sum + finiteAmount(order.subtotal), 0);

  const methodTotals = { cash: 0, bank: 0, other: 0 };
  const collected = payments.reduce((sum, payment) => {
    const amount = finiteAmount(payment.amount);
    if (payment.method === "cash") methodTotals.cash += amount;
    else if (payment.method === "transfer" || payment.method === "bank_qr") methodTotals.bank += amount;
    else methodTotals.other += amount;
    return sum + amount;
  }, 0);

  const outstandingOrders = orders.filter((order) => (
    order.status !== "cancelled"
    && order.status !== "pending_approval"
    && finiteAmount(order.balanceDue) > 0
  ));
  const outstanding = outstandingOrders.reduce(
    (sum, order) => sum + Math.max(0, finiteAmount(order.balanceDue)),
    0
  );

  const depositBalances = new Map();
  depositEvents.forEach((event) => {
    const ownerKey = event.customerId || `order:${event.orderId || event.id || "unknown"}`;
    const key = `${ownerKey}|${event.containerType || "other"}`;
    const direction = event.eventType === "charged"
      ? 1
      : (["refunded", "credited", "forfeited", "charge_reversed"].includes(event.eventType) ? -1 : 0);
    depositBalances.set(key, (depositBalances.get(key) || 0) + direction * finiteAmount(event.amount));
  });
  const depositsHeld = Array.from(depositBalances.values())
    .reduce((sum, balance) => sum + Math.max(0, balance), 0);

  return {
    revenue,
    deliveredCount: deliveredOrders.length,
    collected,
    methodTotals,
    outstanding,
    outstandingCount: outstandingOrders.length,
    depositsHeld
  };
}

function renderSummary(summary, to) {
  document.getElementById("finance-month-stats").innerHTML = `
    <div class="finance-stat">
      <span>Delivered sales</span>
      <strong>${formatCurrency(summary.revenue)}</strong>
      <small>${summary.deliveredCount} delivered order${summary.deliveredCount === 1 ? "" : "s"}</small>
    </div>
    <div class="finance-stat">
      <span>Collected</span>
      <strong>${formatCurrency(summary.collected)}</strong>
      <small>Cash ${formatCurrency(summary.methodTotals.cash)} · Bank/QR ${formatCurrency(summary.methodTotals.bank)} · Other ${formatCurrency(summary.methodTotals.other)}</small>
    </div>
    <div class="finance-stat">
      <span>Outstanding</span>
      <strong>${formatCurrency(summary.outstanding)}</strong>
      <small>${summary.outstandingCount} order${summary.outstandingCount === 1 ? "" : "s"} still owe · includes deposits</small>
    </div>
    <div class="finance-stat">
      <span>Deposits held</span>
      <strong>${formatCurrency(summary.depositsHeld)}</strong>
      <small>All customer deposit events through ${escapeHtml(to)}</small>
    </div>
  `;
}

async function loadMonthSummary() {
  const status = document.getElementById("finance-status");
  const { from, to } = monthRange();
  document.getElementById("finance-period-label").textContent = `${from} to ${to}`;
  status.textContent = "Loading...";
  try {
    const [ordersSnapshot, paymentsSnapshot, depositsSnapshot] = await Promise.all([
      getDocs(query(collection(db, "orders"), where("deliveryDate", ">=", from), where("deliveryDate", "<=", to))),
      getDocs(query(collection(db, "payments"), where("paymentDate", ">=", from), where("paymentDate", "<=", to))),
      getDocs(query(collection(db, "depositEvents"), where("eventDate", "<=", to)))
    ]);
    renderSummary(computeMonthSummary(
      rows(ordersSnapshot),
      rows(paymentsSnapshot),
      rows(depositsSnapshot)
    ), to);
    status.textContent = "";
  } catch (error) {
    status.textContent = `Could not load this month: ${error.message || error}`;
    status.style.color = "var(--danger, #b3261e)";
  }
}

onAuthStateChanged(auth, async (user) => {
  const authView = document.getElementById("auth-view");
  const appView = document.getElementById("app-view");
  if (!user) {
    authView.classList.remove("hidden");
    appView.classList.add("hidden");
    return;
  }
  if (!(await requireRole(user, "owner"))) return;
  authView.classList.add("hidden");
  appView.classList.remove("hidden");
  await loadMonthSummary();
});

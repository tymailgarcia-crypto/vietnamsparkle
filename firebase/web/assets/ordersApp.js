import {
  auth,
  collection,
  db,
  getDocs,
  onAuthStateChanged,
  signOut
} from "./firebaseClient.js";
import { formatCurrency, requireRole } from "./shared.js";

const state = {
  orders: [],
  search: "",
  status: "",
  dateFrom: "",
  dateTo: "",
  sort: "delivery-desc"
};

function el(id) {
  return document.getElementById(id);
}

function setStatus(message) {
  const node = el("list-status");
  if (node) node.textContent = message || "";
}

function phoneDialHref(phone) {
  const digits = String(phone || "").replace(/[^0-9+]/g, "");
  return digits ? `tel:${digits}` : "";
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function humanizePaymentStatus(status) {
  if (status === "paid") return "Paid";
  if (status === "partial") return "Partial";
  return "Unpaid";
}

function matchesSearch(order) {
  if (!state.search) return true;
  const q = state.search.toLowerCase();
  return [order.id, order.customerName, order.phone, order.address]
    .some((field) => String(field || "").toLowerCase().includes(q));
}

function matchesStatus(order) {
  if (!state.status) return true;
  return String(order.status || "") === state.status;
}

function matchesDate(order) {
  const delivery = String(order.deliveryDate || "");
  if (state.dateFrom && delivery < state.dateFrom) return false;
  if (state.dateTo && delivery > state.dateTo) return false;
  return true;
}

function sortRows(rows) {
  const copy = rows.slice();
  switch (state.sort) {
    case "delivery-asc":
      return copy.sort((a, b) => String(a.deliveryDate || "").localeCompare(String(b.deliveryDate || "")));
    case "created-desc":
      return copy.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    case "created-asc":
      return copy.sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
    default:
      return copy.sort((a, b) => String(b.deliveryDate || "").localeCompare(String(a.deliveryDate || "")));
  }
}

function renderRows() {
  const tbody = el("order-rows");
  const filtered = sortRows(
    state.orders.filter((order) => matchesSearch(order) && matchesStatus(order) && matchesDate(order))
  );
  const filtersActive = state.search || state.status || state.dateFrom || state.dateTo;
  setStatus(filtersActive
    ? `Showing ${filtered.length} of ${state.orders.length} orders.`
    : `${state.orders.length} order${state.orders.length === 1 ? "" : "s"} on file.`);

  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="muted" style="padding:20px;text-align:center">No matches. Adjust filters or clear them.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map((order) => {
    const customerHref = order.customerId ? `./customer.html?id=${encodeURIComponent(order.customerId)}` : "";
    const customerCell = customerHref
      ? `<a href="${customerHref}" class="row-link">${escapeHtml(order.customerName || "Unknown")}</a>`
      : escapeHtml(order.customerName || "Unknown");
    const phoneHref = phoneDialHref(order.phone);
    const phoneCell = phoneHref
      ? `<a href="${phoneHref}">${escapeHtml(order.phone)}</a>`
      : escapeHtml(order.phone || "");
    const status = order.status || "unknown";
    const payStatus = order.paymentStatus || "unpaid";
    return `
      <tr>
        <td>${customerCell}</td>
        <td>${phoneCell}</td>
        <td><span class="badge status-${escapeHtml(status)}">${escapeHtml(status)}</span></td>
        <td><span class="badge pay-${escapeHtml(payStatus)}">${escapeHtml(humanizePaymentStatus(payStatus))}</span></td>
        <td style="text-align:right">${escapeHtml(formatCurrency(order.subtotal))}</td>
        <td style="text-align:right">${escapeHtml(formatCurrency(order.balanceDue))}</td>
        <td class="orders-id-cell">${formatOrderId(order.id)}</td>
      </tr>
    `;
  }).join("");
}

function formatOrderId(orderId) {
  return escapeHtml(String(orderId || "")).replace(/-/g, "-<br>");
}

async function loadOrders() {
  setStatus("Loading orders...");
  try {
    const snap = await getDocs(collection(db, "orders"));
    state.orders = snap.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));
    renderRows();
  } catch (error) {
    setStatus(`Could not load orders: ${error.message || error}`);
  }
}

el("search-input").addEventListener("input", (event) => {
  state.search = event.target.value.trim();
  renderRows();
});
el("status-filter").addEventListener("change", (event) => {
  state.status = event.target.value;
  renderRows();
});
el("date-from").addEventListener("change", (event) => {
  state.dateFrom = event.target.value;
  renderRows();
});
el("date-to").addEventListener("change", (event) => {
  state.dateTo = event.target.value;
  renderRows();
});
el("sort-select").addEventListener("change", (event) => {
  state.sort = event.target.value;
  renderRows();
});
el("refresh-button").addEventListener("click", loadOrders);

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
  el("auth-email").textContent = user.email || user.uid;
  await loadOrders();
});

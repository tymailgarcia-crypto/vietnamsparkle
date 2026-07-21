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
  limit,
  onAuthStateChanged,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  signInWithEmailAndPassword,
  updateDoc,
  where,
  writeBatch
} from "./firebaseClient.js";
import {
  buildCustomerId,
  buildDepositEventId,
  buildOrderId,
  buildPaymentId,
  collectedPaymentProblem,
  computeDepositBreakdown,
  containerReturnProofProblem,
  containerReturnProofType,
  describeDepositBalanceProblem,
  escapeHtml,
  formatCurrency,
  isBrokenDepositBalance,
  localDateKey,
  mergeThresholds,
  normalizePhone,
  paymentStatusFor,
  productImageUrl,
  requireRole,
  setDeliveryWindow,
  THRESHOLD_DEFAULTS,
  todayKey,
  withSubmitLock
} from "./shared.js";
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
  uploadContainerReturnProof,
  uploadPaymentProof,
  validateProofFile
} from "./storageUploads.js";
import {
  OPEN_ORDER_STATUSES,
  OPEN_ORDER_TIMING_FILTERS,
  filterOpenOrdersByTiming,
  importantNoteIsValid,
  normalizeImportantNote,
  openOrderGroupKey
} from "./adminDashboardModel.js";
import { mapsApiKey } from "./firebaseWebConfig.js";
import { createEditOrderAddressController } from "./editOrderAddress.js";

const mergeCustomersFn = httpsCallable(functions, "mergeCustomers");
const approveOrderFn = httpsCallable(functions, "approveOrder");
const submitOrderCancellationFn = httpsCallable(functions, "submitOrderCancellation");
const commitDeliveryFn = httpsCallable(functions, "commitDelivery");

// P0-07: a stable per-action token so the cancellation callable's caseId
// (`${orderId}-cx-${clientRequestId}`) is idempotent under a retry.
function newCancelRequestId() {
  const uuid = globalThis.crypto && typeof globalThis.crypto.randomUUID === "function"
    ? globalThis.crypto.randomUUID() : null;
  return uuid || ("cx" + Date.now().toString(36) + Math.random().toString(36).slice(2, 12));
}

function initialSelectedDate() {
  const params = new URLSearchParams(location.search);
  const dateParam = params.get("date");
  if (dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
    return dateParam;
  }
  return todayKey();
}

function monthStartKey(dateKey = todayKey()) {
  return /^\d{4}-\d{2}-\d{2}$/.test(dateKey) ? `${dateKey.slice(0, 7)}-01` : todayKey();
}

function financeRangeFor(period) {
  const now = new Date();
  const to = localDateKey(now);
  if (period === "month") {
    return { from: monthStartKey(to), to, label: "This month" };
  }
  return { from: to, to, label: "Today" };
}

let financeLoadSequence = 0;

const state = {
  products: [],
  drivers: [],
  orders: [],
  openOrders: [],
  orderItems: [],
  payments: [],
  depositEvents: [],
  customersById: {},
  thresholds: { ...THRESHOLD_DEFAULTS },
  selectedDate: initialSelectedDate(),
  statusFilter: "all",
  timingFilter: "all",
  financePeriod: "today",
  financeFrom: todayKey(),
  financeTo: todayKey()
};

const STATUS_FILTERS = [
  { key: "to_approve", label: "To approve", match: (o) => o.status === "pending_approval" },
  { key: "to_assign", label: "To assign", match: (o) => o.status === "new" },
  { key: "to_send", label: "To send", match: (o) => o.status === "assigned" },
  { key: "en_route", label: "En route", match: (o) => o.status === "out_for_delivery" },
  { key: "all", label: "All active", match: () => true }
];

function byId(rows) {
  return rows.reduce((map, row) => {
    map[row.id] = row;
    return map;
  }, {});
}

function setStatus(message, isError = false) {
  const appView = document.getElementById("app-view");
  const id = appView && !appView.classList.contains("hidden") ? "admin-toast" : "login-status";
  const node = document.getElementById(id);
  if (!node) return;
  node.textContent = message;
  node.classList.toggle("is-error", isError);
  node.classList.toggle("is-visible", Boolean(message));
}

function renderHero() {
  const todayOrders = state.orders.filter((order) => order.deliveryDate === state.selectedDate);
  const cash = state.payments
    .filter((payment) => payment.paymentDate === state.selectedDate && payment.method === "cash")
    .reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
  const transfer = state.payments
    .filter((payment) => payment.paymentDate === state.selectedDate && payment.method === "transfer")
    .reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
  const unpaid = todayOrders.filter((order) => order.paymentStatus !== "paid").length;

  document.getElementById("daily-kpis").innerHTML = `
    <div class="daily-kpi"><span>Today orders</span><strong>${todayOrders.length}</strong></div>
    <div class="daily-kpi"><span>Cash today</span><strong>${formatCurrency(cash)}</strong></div>
    <div class="daily-kpi"><span>Transfer today</span><strong>${formatCurrency(transfer)}</strong></div>
    <div class="daily-kpi"><span>Unpaid</span><strong>${unpaid}</strong></div>
  `;
}

function setFinanceStatus(message, isError = false) {
  const node = document.getElementById("finance-status");
  if (!node) return;
  node.textContent = message || "";
  node.style.color = isError ? "var(--danger, #b3261e)" : "var(--muted)";
  node.classList.toggle("is-error", isError);
}

function renderFinancePeriodFilter() {
  document.querySelectorAll("[data-finance-period]").forEach((button) => {
    const active = button.dataset.financePeriod === state.financePeriod;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

async function selectFinancePeriod(period) {
  if (!["today", "month"].includes(period)) return;
  const range = financeRangeFor(period);
  state.financePeriod = period;
  state.financeFrom = range.from;
  state.financeTo = range.to;
  renderFinancePeriodFilter();
  await refreshFinanceSummary();
}

function validFinanceRange(from, to) {
  return /^\d{4}-\d{2}-\d{2}$/.test(from)
    && /^\d{4}-\d{2}-\d{2}$/.test(to)
    && from <= to;
}

function finiteAmount(value) {
  const amount = Number(value || 0);
  return Number.isFinite(amount) ? amount : 0;
}

function computeFinanceSummary(orders, payments, depositEvents) {
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
  const outstanding = outstandingOrders.reduce((sum, order) => sum + Math.max(0, finiteAmount(order.balanceDue)), 0);

  const depositBalances = new Map();
  depositEvents.forEach((event) => {
    const ownerKey = event.customerId || `order:${event.orderId || event.id || "unknown"}`;
    const key = `${ownerKey}|${event.containerType || "other"}`;
    const amount = finiteAmount(event.amount);
    const direction = event.eventType === "charged"
      ? 1
      : (["refunded", "credited", "forfeited", "charge_reversed"].includes(event.eventType) ? -1 : 0);
    depositBalances.set(key, (depositBalances.get(key) || 0) + (direction * amount));
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

function renderFinanceSummary(summary, from, to) {
  document.getElementById("finance-stats").innerHTML = `
    <div class="finance-stat">
      <span>Delivered sales</span>
      <strong>${formatCurrency(summary.revenue)}</strong>
      <div class="muted">Subtotal only · ${summary.deliveredCount} delivered order${summary.deliveredCount === 1 ? "" : "s"}</div>
    </div>
    <div class="finance-stat">
      <span>Collected</span>
      <strong>${formatCurrency(summary.collected)}</strong>
      <div class="muted">Cash ${formatCurrency(summary.methodTotals.cash)} · Bank/QR ${formatCurrency(summary.methodTotals.bank)} · Other ${formatCurrency(summary.methodTotals.other)}</div>
    </div>
    <div class="finance-stat">
      <span>Outstanding</span>
      <strong>${formatCurrency(summary.outstanding)}</strong>
      <div class="muted">${summary.outstandingCount} order${summary.outstandingCount === 1 ? "" : "s"} still owe · includes deposits</div>
    </div>
    <div class="finance-stat">
      <span>Deposits held</span>
      <strong>${formatCurrency(summary.depositsHeld)}</strong>
      <div class="muted">All customer deposit events through ${escapeHtml(to)}</div>
    </div>
  `;
  const label = financeRangeFor(state.financePeriod).label;
  const dates = from === to ? from : `${from} to ${to}`;
  setFinanceStatus(`${label} (${dates}). Collections follow payment dates; outstanding is the current balance on these orders.`);
}

async function refreshFinanceSummary() {
  const from = state.financeFrom;
  const to = state.financeTo;
  if (!validFinanceRange(from, to)) {
    setFinanceStatus("Choose a valid range where From is not after To.", true);
    return;
  }

  const requestId = ++financeLoadSequence;
  setFinanceStatus("Loading finance summary...");
  try {
    const [orders, payments, depositEvents] = await Promise.all([
      loadCollection("orders", [where("deliveryDate", ">=", from), where("deliveryDate", "<=", to)]),
      loadCollection("payments", [where("paymentDate", ">=", from), where("paymentDate", "<=", to)]),
      loadCollection("depositEvents", [where("eventDate", "<=", to)])
    ]);
    if (requestId !== financeLoadSequence) return;
    renderFinanceSummary(computeFinanceSummary(orders, payments, depositEvents), from, to);
  } catch (error) {
    if (requestId !== financeLoadSequence) return;
    setFinanceStatus(`Could not load finance summary: ${error.message || error}`, true);
  }
}

function productLinesForOrder(orderId) {
  return state.orderItems.filter((item) => item.orderId === orderId);
}

function driverName(driverId) {
  const driver = state.drivers.find((row) => row.id === driverId);
  return driver ? driver.driverName : "Unassigned";
}

// P0-06: order approval — customer linkage, deposit charging, and the status
// transition — moved into the server callable `approveOrder` (functions/index.js
// approveOrderImpl), where they run in ONE transaction. The old client versions
// of upsertCustomerFromOrder / foldSelfServeStubInto / ensureDepositCharge lived
// here; they did the work as separate awaits with a stale duplicate-check and
// random charge ids, so a failure could approve an order with no deposit charge
// and a retry could double-charge. The account-takeover gate
// (canLinkAuthUidToCustomer) moved with the linkage; it is now in
// functions/index.js, still pinned by rules-tests/authuid-linking.test.mjs.

async function updateOrderStatus(orderId, nextStatus) {
  const order = state.orders.find((row) => row.id === orderId);
  if (!order) {
    return;
  }
  await updateDoc(doc(db, "orders", orderId), {
    status: nextStatus,
    updatedAt: new Date().toISOString()
  });
}

async function returnOrderToAssignment(orderId) {
  const order = state.orders.find((row) => row.id === orderId);
  if (!order || order.status !== "out_for_delivery") return;
  await updateDoc(doc(db, "orders", orderId), {
    status: "assigned",
    updatedAt: new Date().toISOString()
  });
}

// Lazy Maps SDK loader for geocode-on-approval. Same pattern as mapApp.js /
// settingsApp.js — kept local rather than extracted because the surface is
// tiny and the route planner is the only other future consumer.
const mapsSdkState = { ready: false, geocoder: null, loadPromise: null };
let orderMap = null;
let orderMapMarker = null;
let orderMiniMapObserver = null;

function loadMapsSdk() {
  if (mapsSdkState.ready) return Promise.resolve();
  if (mapsSdkState.loadPromise) return mapsSdkState.loadPromise;
  if (!mapsApiKey) return Promise.reject(new Error("no-maps-api-key"));
  if (window.google && window.google.maps) {
    mapsSdkState.ready = true;
    return Promise.resolve();
  }
  mapsSdkState.loadPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    const params = new URLSearchParams({ key: mapsApiKey, v: "weekly" });
    script.src = `https://maps.googleapis.com/maps/api/js?${params.toString()}`;
    script.async = true;
    script.defer = true;
    script.onload = () => { mapsSdkState.ready = true; resolve(); };
    script.onerror = () => reject(new Error("Maps SDK failed to load"));
    document.head.appendChild(script);
  });
  return mapsSdkState.loadPromise;
}

function geocodeAddress(address) {
  if (!mapsSdkState.geocoder) {
    mapsSdkState.geocoder = new google.maps.Geocoder();
  }
  return new Promise((resolve) => {
    mapsSdkState.geocoder.geocode({ address, region: "vn" }, (results, status) => {
      if (status === "OK" && results && results.length) {
        const loc = results[0].geometry.location;
        resolve({ lat: loc.lat(), lng: loc.lng(), formattedAddress: results[0].formatted_address });
      } else {
        resolve(null);
      }
    });
  });
}

// ---- Edit-order address re-confirmation -----------------------------------
// When an admin changes an order's address, the new pin must be eyeballed on
// the map before save — the same checkpoint the new-customer and public-order
// flows already enforce. State is seeded from the order's existing pin on open,
// so an unchanged address needs no re-confirmation.
const editAddressState = {
  map: null,
  marker: null,
  pending: null,
  confirmed: null,        // { lat, lng, formattedAddress, geocodedAt }
  confirmedForAddress: "" // the trimmed address string `confirmed` belongs to
};

function setEditAddressStatus(message, isError = false) {
  const node = document.getElementById("edit-address-status");
  if (!node) return;
  node.textContent = message || "";
  node.style.color = isError ? "var(--danger, #b3261e)" : "var(--muted)";
}

// Called when the edit dialog opens. Seeds the confirmed pin from the order so
// that leaving the address untouched saves without a re-check.
function resetEditAddressConfirm(order) {
  editAddressState.pending = null;
  const wrap = document.getElementById("edit-address-map-wrap");
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
  const address = document.getElementById("edit-address").value.trim();
  if (address.length < 5) {
    setEditAddressStatus("Enter a fuller delivery address first.", true);
    return;
  }
  const button = document.getElementById("edit-address-verify");
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
    const wrap = document.getElementById("edit-address-map-wrap");
    wrap.hidden = false;
    editAddressState.map = editAddressState.map || new google.maps.Map(document.getElementById("edit-address-map"), {
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
    document.getElementById("edit-address-map-wrap")?.setAttribute("hidden", "");
    setEditAddressStatus(error.message || String(error), true);
  } finally {
    button.disabled = false;
  }
}

function confirmEditAddress() {
  if (!editAddressState.pending) return;
  editAddressState.confirmed = { ...editAddressState.pending };
  editAddressState.confirmedForAddress = document.getElementById("edit-address").value.trim();
  setEditAddressStatus("✓ Delivery location confirmed on Google Maps.");
}

const editAddressController = createEditOrderAddressController({ loadMaps: loadMapsSdk });

// Best-effort resolve of the delivery pin for a freshly-approved order.
// Priority: geocode the order's own address; fall back to the customer's
// stored location for returning customers; return null if neither works
// (the map view will show a missing-pin banner + the route planner will skip
// this order).
async function resolveDeliveryLocation(order, customerId) {
  const confirmed = order?.deliveryLocation;
  if (confirmed && typeof confirmed.lat === "number" && typeof confirmed.lng === "number") {
    return confirmed;
  }
  const address = String(order.address || "").trim();
  if (address) {
    try {
      await loadMapsSdk();
      const geo = await geocodeAddress(address);
      if (geo) {
        return {
          lat: geo.lat,
          lng: geo.lng,
          formattedAddress: geo.formattedAddress,
          geocodedAt: new Date().toISOString()
        };
      }
    } catch (error) {
      console.warn(`Geocode failed for order ${order.id}:`, error.message || error);
    }
  }
  if (customerId) {
    try {
      const snap = await getDoc(doc(db, "customers", customerId));
      const loc = snap.exists() ? snap.data().location : null;
      if (loc && typeof loc.lat === "number" && typeof loc.lng === "number") {
        return {
          lat: loc.lat,
          lng: loc.lng,
          formattedAddress: loc.formattedAddress || address || null,
          geocodedAt: new Date().toISOString(),
          sourceCustomerId: customerId
        };
      }
    } catch (_) {
      // ignore — approval still proceeds without a pin
    }
  }
  return null;
}

async function approveOrder(orderId) {
  const order = state.orders.find((row) => row.id === orderId);
  if (!order) {
    return;
  }
  // P0-04: the order routes to the customer's OWN uid-anchored record, so a
  // typo can no longer corrupt a stranger. But a typed phone that already
  // belongs to a DIFFERENT customer record is a data-quality red flag worth
  // stopping on — usually a one-digit typo. Explain it and let the owner fix
  // the number (Edit details) or approve anyway.
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
      // A failed lookup must not block a legitimate approval; the uid anchoring
      // already prevents cross-customer corruption regardless.
    }
  }
  // P0-06: the atomic work (status precondition, customer linkage, deposit
  // charges, status transition) runs server-side in one transaction. Retry-safe
  // and idempotent, so a double-tap or a lost response can't double-charge.
  await approveOrderFn({ orderId });
}

// Reverse every charged deposit event on this order that hasn't already been
// refunded/credited/forfeited. Emits one "refunded" event per still-outstanding
// container type, matching qty and amount, so the deposits page + customer
// balance zero out for this cancelled order.
// P0-07: order cancellation now goes through the server `submitOrderCancellation`
// callable, which cancels the order, writes the cancellation case, computes the
// refund liability from immutable payments, and reverses the deposit charge —
// all in ONE transaction. The old client flow (direct status flip + a separate
// emitDepositReversalsFor deposit write) could leave a cancelled order with its
// deposit not reversed if the second write failed, and it bypassed the case
// ledger entirely.
async function cancelOrder(orderId, reason) {
  const trimmed = String(reason || "").trim();
  await submitOrderCancellationFn({
    orderId,
    kind: "full",
    reason: trimmed.length >= 3 ? trimmed : "Cancelled by owner",
    clientRequestId: newCancelRequestId()
  });
}

async function approveCancellationRequest(orderId) {
  const order = state.orders.find((row) => row.id === orderId);
  if (!order) return;
  const reason = String(order.cancellationRequestReason || "").trim();
  await submitOrderCancellationFn({
    orderId,
    kind: "full",
    reason: reason.length >= 3 ? reason : "Approved cancellation request",
    clientRequestId: newCancelRequestId()
  });
  // Clear the legacy request flags — the server cancels the order + writes the
  // case, but does not touch these older flags.
  await updateDoc(doc(db, "orders", orderId), {
    cancellationRequested: null,
    cancellationRequestReason: null,
    cancellationRequestedAt: null,
    updatedAt: new Date().toISOString()
  });
}

async function dismissCancellationRequest(orderId) {
  await updateDoc(doc(db, "orders", orderId), {
    cancellationRequested: null,
    cancellationRequestReason: null,
    cancellationRequestedAt: null,
    updatedAt: new Date().toISOString()
  });
}

async function assignDriver(orderId, driverId) {
  const order = state.orders.find((row) => row.id === orderId);
  if (!order) return;
  const nextStatus = driverId
    ? (order.status === "new" || order.status === "assigned" ? "assigned" : order.status)
    : (order.status === "assigned" ? "new" : order.status);
  await updateDoc(doc(db, "orders", orderId), {
    assignedDriverId: driverId || null,
    status: nextStatus,
    updatedAt: new Date().toISOString()
  });
}

function renderDriverSelect(order) {
  return `
    <select data-driver="${escapeHtml(order.id)}">
      <option value="">Unassigned</option>
      ${state.drivers.map((driver) => `<option value="${escapeHtml(driver.id)}" ${driver.id === order.assignedDriverId ? "selected" : ""}>${escapeHtml(driver.driverName)}</option>`).join("")}
    </select>
  `;
}

function renderImportanceButton(order) {
  const active = order.important === true;
  const label = active ? "Edit important note" : "Mark important";
  return `<button class="ghost ${active ? "is-important" : ""}" type="button" data-important-order="${escapeHtml(order.id)}" aria-label="${label}">${active ? "&#9733; Important" : "&#9734; Important"}</button>`;
}

function renderImportantNote(order, className = "important-note") {
  if (order.important !== true) return "";
  const note = normalizeImportantNote(order.importantNote);
  return `<div class="${className}"><span class="important-label">Important</span>${note ? ` ${escapeHtml(note)}` : ""}</div>`;
}

function renderStateActions(order) {
  const managementActions = `
    <span class="order-management-actions">
      ${renderImportanceButton(order)}
      <button class="ghost" data-cancel="${escapeHtml(order.id)}">Cancel order</button>
      <button class="ghost" data-edit="${escapeHtml(order.id)}">Edit details</button>
    </span>`;
  const contactAction = renderQuickCallAction(order);
  switch (order.status) {
    case "pending_approval":
      return `
        <button class="primary" data-approve="${order.id}">Approve</button>
        ${managementActions}
        ${contactAction}
      `;
    case "new":
      return `
        ${renderDriverSelect(order)}
        ${managementActions}
        ${contactAction}
      `;
    case "assigned":
      return `
        ${renderDriverSelect(order)}
        <button class="primary" data-status="${order.id}" data-next="out_for_delivery">Send out for delivery</button>
        ${managementActions}
        ${contactAction}
      `;
    case "out_for_delivery":
      return `
        <button class="primary" data-collect="${order.id}">Mark delivered &amp; record payment</button>
        <button class="secondary" data-return-assignment="${order.id}">Reset</button>
        ${managementActions}
        ${contactAction}
      `;
    case "delivered":
      return `<span class="muted">Delivered</span> <button class="ghost" data-invoice="${order.id}">Invoice</button> ${order.important === true ? renderImportanceButton(order) : ""} ${contactAction}`;
    case "cancelled":
      return `<span class="muted">Cancelled${order.cancellationReason ? ` — ${escapeHtml(order.cancellationReason)}` : ""}</span> ${order.important === true ? renderImportanceButton(order) : ""}`;
    default:
      return `<span class="muted">Unknown status: ${escapeHtml(order.status)}</span>`;
  }
}

function phoneDialHref(phone) {
  const raw = String(phone || "").trim();
  const digits = raw.replace(/\D/g, "");
  if (!digits) return "";
  return `tel:${raw.startsWith("+") ? "+" : ""}${digits}`;
}

function renderQuickCallAction(order) {
  const href = phoneDialHref(order.phone);
  if (!href) return "";
  const customer = String(order.customerName || "customer").trim() || "customer";
  const phone = String(order.phone || "").trim();
  const digits = phone.replace(/\D/g, "");
  const messageDigits = digits.startsWith("0") ? `84${digits.slice(1)}` : digits;
  const message = `Hi ${customer}, this is Vietnam Sparkle about order ${order.id}.`;
  const icon = (kind) => {
    if (kind === "phone") return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.6 10.8c1.7 3.3 3.3 4.9 6.6 6.6l2.2-2.2c.3-.3.7-.4 1.1-.3 1.2.4 2.5.6 3.8.6.6 0 1 .4 1 1v3.8c0 .6-.4 1-1 1C10.6 21.3 2.7 13.4 2.7 3.7c0-.6.4-1 1-1h3.8c.6 0 1 .4 1 1 0 1.3.2 2.6.6 3.8.1.4 0 .8-.3 1.1l-2.2 2.2Z"/></svg>`;
    if (kind === "whatsapp") return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 3.5A11.8 11.8 0 0 0 12.1 0C5.6 0 .3 5.3.3 11.8c0 2.1.5 4.1 1.6 5.9L.2 24l6.5-1.7c1.7.9 3.6 1.4 5.5 1.4 6.5 0 11.8-5.3 11.8-11.8 0-3.2-1.2-6.1-3.5-8.4Zm-8.4 18.2c-1.7 0-3.4-.5-4.9-1.3l-.4-.2-3.8 1 1-3.7-.2-.4a9.7 9.7 0 1 1 8.3 4.6Zm5.3-7.3c-.3-.1-1.7-.8-2-.9-.3-.1-.5-.1-.7.1-.2.3-.8.9-1 1.1-.2.2-.4.2-.7.1-1.7-.8-2.8-1.5-3.9-3.4-.3-.5.3-.5.8-1.6.1-.2 0-.4 0-.6l-.9-2c-.2-.6-.5-.5-.7-.5h-.6c-.2 0-.6.1-.9.4-.3.3-1.2 1.2-1.2 2.9s1.2 3.3 1.4 3.6c.2.2 2.4 3.7 5.9 5.2 2.2.9 3.1 1 4.2.8.7-.1 1.7-.7 1.9-1.3.2-.6.2-1.2.2-1.3-.1-.1-.3-.2-.6-.3Z"/></svg>`;
    if (kind === "chat") return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 3h16a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H9l-5 4v-4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm3 6h10V7H7v2Zm0 4h7v-2H7v2Z"/></svg>`;
    return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 2h14a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3h-6l-4.8 4v-4H5a3 3 0 0 1-3-3V5a3 3 0 0 1 3-3Z"/><path class="zalo-letter" d="M7 7h7l-7 6h7"/></svg>`;
  };
  return `
    <details class="customer-contact">
      <summary aria-label="Contact ${escapeHtml(customer)}${phone ? ` at ${escapeHtml(phone)}` : ""}" title="Contact customer">${icon("chat")}</summary>
      <div class="customer-contact-menu">
        <a class="contact-whatsapp" href="https://wa.me/${messageDigits}?text=${encodeURIComponent(message)}" target="_blank" rel="noopener" aria-label="WhatsApp ${escapeHtml(customer)}" title="WhatsApp">${icon("whatsapp")}</a>
        <a class="contact-zalo" href="https://zalo.me/${messageDigits}" target="_blank" rel="noopener" aria-label="Zalo ${escapeHtml(customer)}" title="Zalo">${icon("zalo")}</a>
        <a href="${escapeHtml(href)}" aria-label="Call ${escapeHtml(customer)}" title="Phone">${icon("phone")}</a>
      </div>
    </details>`;
}

document.addEventListener("click", (event) => {
  document.querySelectorAll("#today-board details.customer-contact[open]").forEach((details) => {
    if (!details.contains(event.target)) details.removeAttribute("open");
  });
});

function compactDashboardAddress(value) {
  const original = String(value || "").trim();
  const normalize = (part) => part.normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/đ/g, "d")
    .trim();
  const parts = original.split(",").map((part) => part.trim()).filter(Boolean);
  while (parts.length) {
    const tail = normalize(parts[parts.length - 1]);
    if (!/^(?:viet\s*nam|(?:tp\.?\s*)?da\s*nang(?:\s*city)?)$/.test(tail)) break;
    parts.pop();
  }
  const withoutWard = parts.filter((part) => !/\b(?:phuong|ward)\b/.test(normalize(part)));
  const concise = (withoutWard.length ? withoutWard : parts).slice(-2);
  return concise.join(", ") || original;
}

function mapDirectionsHref(address) {
  const trimmed = String(address || "").trim();
  if (!trimmed) return "";
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(trimmed)}`;
}

function productForOrderItem(item) {
  return state.products.find((product) => product.id === item.productId)
    || state.products.find((product) => product.productName === item.productName)
    || item.productName;
}

function renderOrderItemThumbs(order) {
  const items = productLinesForOrder(order.id);
  if (!items.length) return "";
  const thumbs = items.map((item) => {
    const name = String(item.productName || "Product");
    const quantity = Number(item.quantity || 0);
    const imageUrl = productImageUrl(productForOrderItem(item));
    if (!imageUrl) return "";
    const title = quantity > 1 ? `${name} ×${quantity}` : name;
    return `
      <span class="map-order-product" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}">
        <img class="map-order-product-image" src="${escapeHtml(imageUrl)}" alt="${escapeHtml(name)}" loading="lazy">
        ${quantity > 1 ? `<span class="map-order-product-badge">×${quantity}</span>` : ""}
      </span>`;
  }).join("");
  return thumbs ? `<div class="map-order-thumbs" aria-label="Ordered items">${thumbs}</div>` : "";
}

function deliveryPosition(order) {
  const location = order?.deliveryLocation;
  const rawLat = location?.lat ?? location?.latitude;
  const rawLng = location?.lng ?? location?.longitude;
  if (rawLat == null || rawLng == null) return null;
  const lat = Number(rawLat);
  const lng = Number(rawLng);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

function renderOrderMiniMap(order) {
  const position = deliveryPosition(order);
  if (!position) return "";
  return `
    <button class="order-mini-map" type="button"
      data-open-map="${escapeHtml(order.id)}"
      data-mini-map-lat="${position.lat}"
      data-mini-map-lng="${position.lng}"
      aria-label="Enlarge delivery map for ${escapeHtml(order.customerName || "customer")}">
      <span class="order-mini-map-canvas" aria-hidden="true"></span>
      <span class="order-mini-map-label">Tap to enlarge</span>
    </button>`;
}

async function hydrateOrderMiniMap(button) {
  if (button.dataset.mapReady === "true") return;
  button.dataset.mapReady = "true";
  try {
    await loadMapsSdk();
    if (!button.isConnected) return;
    const position = {
      lat: Number(button.dataset.miniMapLat),
      lng: Number(button.dataset.miniMapLng)
    };
    const map = new google.maps.Map(button.querySelector(".order-mini-map-canvas"), {
      center: position,
      zoom: 12,
      disableDefaultUI: true,
      clickableIcons: false,
      gestureHandling: "none",
      keyboardShortcuts: false
    });
    new google.maps.Marker({ map, position });
  } catch (error) {
    button.classList.add("is-unavailable");
    button.title = error.message || String(error);
  }
}

function initializeOrderMiniMaps(board) {
  if (orderMiniMapObserver) orderMiniMapObserver.disconnect();
  const previews = Array.from(board.querySelectorAll("[data-mini-map-lat]"));
  if (!previews.length) return;
  if (!("IntersectionObserver" in window)) {
    previews.forEach(hydrateOrderMiniMap);
    return;
  }
  orderMiniMapObserver = new IntersectionObserver((entries, observer) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      observer.unobserve(entry.target);
      hydrateOrderMiniMap(entry.target);
    });
  }, { rootMargin: "180px 0px" });
  previews.forEach((button) => orderMiniMapObserver.observe(button));
}

async function openOrderMap(order) {
  const dialog = document.getElementById("order-map-dialog");
  const status = document.getElementById("order-map-status");
  const address = String(order.address || "").trim();
  document.getElementById("order-map-customer").textContent = order.customerName || "Customer";
  document.getElementById("order-map-address").textContent = address || "No address on this order";
  const directions = document.getElementById("order-map-directions");
  directions.hidden = true;
  status.textContent = "Loading map...";
  dialog.showModal();
  try {
    await loadMapsSdk();
    const location = await resolveDeliveryLocation(order, order.customerId);
    if (!location) throw new Error("No confirmed pin was found for this address.");
    const position = { lat: Number(location.lat), lng: Number(location.lng) };
    orderMap = orderMap || new google.maps.Map(document.getElementById("order-map-canvas"), {
      center: position,
      zoom: 17,
      streetViewControl: false,
      mapTypeControl: false,
      fullscreenControl: true
    });
    orderMap.setCenter(position);
    orderMap.setZoom(17);
    google.maps.event.trigger(orderMap, "resize");
    if (orderMapMarker) orderMapMarker.setMap(null);
    orderMapMarker = new google.maps.Marker({
      map: orderMap,
      position,
      title: order.customerName || address || "Delivery location"
    });
    directions.href = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(`${position.lat},${position.lng}`)}`;
    directions.hidden = false;
    status.textContent = location.formattedAddress || "Confirmed delivery pin";
  } catch (error) {
    status.textContent = error.message || String(error);
  }
}

// Proof photos attached to this order's payments. Reads state.payments, which
// refreshDashboard already loads per order — no extra fetch. proofUrl is a
// tokenized Storage URL, so the <img> loads without a signed-in Storage read.
function renderProofThumbs(order) {
  const proofs = state.payments.filter((p) => p.orderId === order.id && p.proofUrl);
  if (!proofs.length) return "";
  return `
    <div class="proof-thumbs">
      ${proofs.map((p) => `
        <button class="ghost" type="button" data-proof-preview="${escapeHtml(p.proofUrl)}" data-proof-amount="${escapeHtml(formatCurrency(p.amount))}" style="padding:0;border:0;background:transparent" title="Preview payment proof — ${escapeHtml(formatCurrency(p.amount))}">
          <img src="${escapeHtml(p.proofUrl)}" alt="Payment proof for ${escapeHtml(order.id)}" loading="lazy">
        </button>
      `).join("")}
    </div>
  `;
}

function openProofPreview(button) {
  const url = button.dataset.proofPreview;
  if (!url) return;
  const dialog = document.getElementById("proof-preview-dialog");
  const image = document.getElementById("proof-preview-image");
  const link = document.getElementById("proof-preview-new-tab");
  document.getElementById("proof-preview-title").textContent = `Payment proof · ${button.dataset.proofAmount || ""}`;
  image.src = url;
  link.href = url;
  dialog.showModal();
}

function renderOrderCompact(order) {
  const displayName = order.customerName || "Unknown customer";
  const nameCell = order.customerId
    ? `<a href="./customer.html?id=${encodeURIComponent(order.customerId)}">${escapeHtml(displayName)}</a>`
    : escapeHtml(displayName);
  const cancellationBanner = order.cancellationRequested
    ? `<div class="cancellation-request">Cancellation requested${order.cancellationRequestReason ? ` — ${escapeHtml(order.cancellationRequestReason)}` : ""}</div>`
    : "";
  const cancellationActions = order.cancellationRequested
    ? `
      <button class="primary" data-approve-cancel="${escapeHtml(order.id)}">Approve cancel</button>
      <button class="ghost" data-dismiss-cancel="${escapeHtml(order.id)}">Dismiss</button>
    `
    : "";
  const address = order.address || "";
  const displayAddress = compactDashboardAddress(address);
  const miniMap = renderOrderMiniMap(order);
  const driver = driverName(order.assignedDriverId);
  const orderIdLink = `<a class="order-id-link" href="./order.html?id=${encodeURIComponent(order.id)}" title="Open order ${escapeHtml(order.id)}">${escapeHtml(order.id)}</a>`;
  const pickupBadge = state.customersById?.[order.customerId]?.emptiesPickupRequested === true
    ? `<span class="badge" title="Requested from the customer's account page" style="background:rgba(11,122,99,0.14);color:#0b7a63;font-weight:700">♻ Pick up empties</span>`
    : "";
  const deliveryTiming = openOrderTiming(order, todayKey());
  return `
    <div class="compact-order" data-order-card="${escapeHtml(order.id)}">
      <div class="top">
        <div class="who">${nameCell}</div>
        <span class="badge status-${escapeHtml(order.status)}">${escapeHtml(order.status)}</span>
      </div>
      <div class="order-delivery-timing ${deliveryTiming.overdue ? "is-overdue" : ""}">${escapeHtml(deliveryTiming.label)}</div>
      ${pickupBadge ? `<div class="where">${pickupBadge}</div>` : ""}
      <div class="where">${orderIdLink}</div>
      ${address ? `<div class="where order-address-row"><span>${escapeHtml(displayAddress)}</span>${miniMap ? "" : `<button class="ghost" type="button" data-open-map="${escapeHtml(order.id)}">Open map</button>`}</div>` : ""}
      ${miniMap}
      ${renderOrderItemThumbs(order)}
      <div class="where order-total-line"><span>${escapeHtml(driver)}</span><strong>${formatCurrency(order.subtotal + order.depositTotal)}</strong></div>
      ${renderProofThumbs(order)}
      ${renderImportantNote(order, "order-important-note")}
      ${cancellationBanner}
      <div class="compact-actions">
        ${cancellationActions}
        ${renderStateActions(order)}
      </div>
    </div>
  `;
}

function renderStatusFilter(orders) {
  const bar = document.getElementById("order-status-filter");
  if (!bar) return;
  if (!STATUS_FILTERS.some((f) => f.key === state.statusFilter)) {
    state.statusFilter = "all";
  }
  bar.innerHTML = STATUS_FILTERS.map((f) => {
    const count = orders.filter(f.match).length;
    const isActive = f.key === state.statusFilter;
    return `<button type="button" data-filter="${f.key}" class="${isActive ? "active" : ""}">${escapeHtml(f.label)} (${count})</button>`;
  }).join("");
  bar.querySelectorAll("button[data-filter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.statusFilter = btn.dataset.filter;
      renderOrderBoard();
    });
  });
}

function renderTimingFilter(orders) {
  const select = document.getElementById("order-timing-filter");
  if (!select) return;
  if (!OPEN_ORDER_TIMING_FILTERS.some((filter) => filter.key === state.timingFilter)) {
    state.timingFilter = "all";
  }
  const today = todayKey();
  select.innerHTML = OPEN_ORDER_TIMING_FILTERS.map((filter) => {
    const count = filter.key === "all"
      ? orders.length
      : orders.filter((order) => openOrderGroupKey(order, today) === filter.key).length;
    return `<option value="${filter.key}">${escapeHtml(filter.label)} (${count})</option>`;
  }).join("");
  select.value = state.timingFilter;
}

function renderOrderBoard() {
  const board = document.getElementById("today-board");
  const activeOrders = state.orders.filter((order) => OPEN_ORDER_STATUSES.includes(order.status));
  const count = document.getElementById("active-orders-count");
  if (count) count.textContent = String(activeOrders.length);

  const activeFilter = STATUS_FILTERS.find((f) => f.key === state.statusFilter) || STATUS_FILTERS[0];
  renderStatusFilter(activeOrders);
  renderTimingFilter(activeOrders.filter(activeFilter.match));

  if (!activeOrders.length) {
    board.innerHTML = `<div class="card"><strong>All caught up</strong><div class="muted">There are no unfinished orders. Delivered and cancelled orders remain available on the Orders page.</div></div>`;
    return;
  }

  const timingFilter = OPEN_ORDER_TIMING_FILTERS.find((filter) => filter.key === state.timingFilter)
    || OPEN_ORDER_TIMING_FILTERS[0];
  const visibleOrders = filterOpenOrdersByTiming(
    activeOrders.filter(activeFilter.match),
    todayKey(),
    timingFilter.key
  );

  if (!visibleOrders.length) {
    board.innerHTML = `<div class="card"><strong>No matching active orders</strong><div class="muted">No ${escapeHtml(activeFilter.label.toLowerCase())} orders match “${escapeHtml(timingFilter.label)}”. Try a different filter.</div></div>`;
    return;
  }

  board.innerHTML = visibleOrders.map(renderOrderCompact).join("");
  initializeOrderMiniMaps(board);

  board.querySelectorAll("[data-approve]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        await approveOrder(button.dataset.approve);
        await refreshDashboard();
      } catch (error) {
        setStatus(error.message || String(error), true);
      }
    });
  });
  board.querySelectorAll("[data-cancel]").forEach((button) => {
    button.addEventListener("click", async () => {
      const reason = prompt("Reason for cancelling this order? (optional — leave blank if none). It is stored on the order for audit review.");
      if (reason === null) return;
      try {
        await cancelOrder(button.dataset.cancel, reason);
        await refreshDashboard();
      } catch (error) {
        setStatus(error.message || String(error), true);
      }
    });
  });
  board.querySelectorAll("[data-driver]").forEach((select) => {
    select.addEventListener("change", async () => {
      try {
        await assignDriver(select.dataset.driver, select.value);
        await refreshDashboard();
      } catch (error) {
        setStatus(error.message || String(error), true);
      }
    });
  });
  board.querySelectorAll("[data-status]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        await updateOrderStatus(button.dataset.status, button.dataset.next);
        await refreshDashboard();
      } catch (error) {
        setStatus(error.message || String(error), true);
      }
    });
  });
  board.querySelectorAll("[data-return-assignment]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (!confirm("Return this delivery to the assignment stage? The assigned driver will be kept.")) return;
      try {
        await returnOrderToAssignment(button.dataset.returnAssignment);
        await refreshDashboard();
      } catch (error) {
        setStatus(error.message || String(error), true);
      }
    });
  });
  board.querySelectorAll("[data-open-map]").forEach((button) => {
    button.addEventListener("click", () => {
      const order = state.orders.find((row) => row.id === button.dataset.openMap);
      if (order) openOrderMap(order);
    });
  });
  board.querySelectorAll("[data-proof-preview]").forEach((button) => {
    button.addEventListener("click", () => openProofPreview(button));
  });
  board.querySelectorAll("[data-edit]").forEach((button) => {
    button.addEventListener("click", () => {
      const order = state.orders.find((row) => row.id === button.dataset.edit);
      if (order) openEditDialog(order);
    });
  });
  board.querySelectorAll("[data-collect]").forEach((button) => {
    button.addEventListener("click", async () => {
      const order = state.orders.find((row) => row.id === button.dataset.collect);
      if (order) await openDeliveryPaymentDialog(order);
    });
  });
  board.querySelectorAll("[data-invoice]").forEach((button) => {
    button.addEventListener("click", async () => {
      const order = state.orders.find((row) => row.id === button.dataset.invoice);
      if (order) await openInvoiceDialog(order);
    });
  });
  board.querySelectorAll("[data-approve-cancel]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (!confirm("Approve the customer's cancellation request? The order will be marked cancelled.")) {
        return;
      }
      try {
        await approveCancellationRequest(button.dataset.approveCancel);
        await refreshDashboard();
      } catch (error) {
        setStatus(error.message || String(error), true);
      }
    });
  });
  board.querySelectorAll("[data-dismiss-cancel]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (!confirm("Dismiss the cancellation request? The order stays active — you should follow up with the customer.")) {
        return;
      }
      try {
        await dismissCancellationRequest(button.dataset.dismissCancel);
        await refreshDashboard();
      } catch (error) {
        setStatus(error.message || String(error), true);
      }
    });
  });
}

const editState = {
  items: []
};

function computeEditTotals() {
  return editState.items.reduce((acc, item) => {
    const qty = Number(item.quantity || 0);
    acc.subtotal += qty * Number(item.unitPrice || 0);
    acc.depositTotal += qty * Number(item.defaultDepositAmount || 0);
    return acc;
  }, { subtotal: 0, depositTotal: 0 });
}

function renderEditTotals() {
  const totals = computeEditTotals();
  const due = totals.subtotal + totals.depositTotal;
  document.getElementById("edit-totals").innerHTML = `
    <div class="card"><span class="muted">Subtotal</span><strong>${formatCurrency(totals.subtotal)}</strong></div>
    <div class="card"><span class="muted">Deposit</span><strong>${formatCurrency(totals.depositTotal)}</strong></div>
    <div class="card"><span class="muted">Total due</span><strong>${formatCurrency(due)}</strong></div>
  `;
}

function renderEditItems() {
  const container = document.getElementById("edit-items-list");
  if (!editState.items.length) {
    container.innerHTML = `<p class="muted">No items yet. Add a product below.</p>`;
    return;
  }
  container.innerHTML = editState.items.map((item, idx) => `
    <div class="card">
      <div class="order-top">
        <div>
          <strong>${escapeHtml(item.productName)}</strong>
          <div class="muted">${formatCurrency(item.unitPrice)} each · deposit ${formatCurrency(item.defaultDepositAmount || 0)}</div>
        </div>
        <div class="button-row" style="gap:6px">
          <button class="ghost" type="button" data-edit-qty-minus="${idx}">-</button>
          <span class="qty-value">${Number(item.quantity || 0)}</span>
          <button class="ghost" type="button" data-edit-qty-plus="${idx}">+</button>
          <button class="ghost" type="button" data-edit-remove="${idx}">Remove</button>
        </div>
      </div>
    </div>
  `).join("");
  container.querySelectorAll("[data-edit-qty-minus]").forEach((btn) => {
    btn.addEventListener("click", () => changeEditQty(Number(btn.dataset.editQtyMinus), -1));
  });
  container.querySelectorAll("[data-edit-qty-plus]").forEach((btn) => {
    btn.addEventListener("click", () => changeEditQty(Number(btn.dataset.editQtyPlus), 1));
  });
  container.querySelectorAll("[data-edit-remove]").forEach((btn) => {
    btn.addEventListener("click", () => removeEditItem(Number(btn.dataset.editRemove)));
  });
}

function changeEditQty(idx, delta) {
  const next = Math.max(0, Number(editState.items[idx].quantity || 0) + delta);
  if (next === 0) {
    editState.items.splice(idx, 1);
  } else {
    editState.items[idx].quantity = next;
  }
  renderEditItems();
  renderEditTotals();
}

function removeEditItem(idx) {
  editState.items.splice(idx, 1);
  renderEditItems();
  renderEditTotals();
}

function addEditItem() {
  const select = document.getElementById("edit-add-item-select");
  const productId = select.value;
  if (!productId) return;
  const product = state.products.find((p) => p.id === productId);
  if (!product) return;
  const existing = editState.items.find((i) => i.productId === productId);
  if (existing) {
    existing.quantity = Number(existing.quantity || 0) + 1;
  } else {
    editState.items.push({
      productId: product.id,
      productName: product.productName,
      quantity: 1,
      unitPrice: Number(product.unitPrice || 0),
      defaultDepositAmount: Number(product.defaultDepositAmount || 0)
    });
  }
  select.value = "";
  renderEditItems();
  renderEditTotals();
}

async function loadOrderItems(orderId) {
  const snap = await getDocs(query(collection(db, "orderItems"), where("orderId", "==", orderId)));
  return snap.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));
}

async function openEditDialog(order) {
  const dialog = document.getElementById("edit-order-dialog");
  if (!dialog || typeof dialog.showModal !== "function") return;
  document.getElementById("edit-order-id").value = order.id;
  document.getElementById("edit-customer-name").value = order.customerName || "";
  document.getElementById("edit-phone").value = order.phone || "";
  document.getElementById("edit-address").value = order.address || "";
  editAddressController.reset(order);
  document.getElementById("edit-delivery-date").value = order.deliveryDate || "";
  setDeliveryWindow(document.getElementById("edit-delivery-window"), order.deliveryWindow || "");
  document.getElementById("edit-notes").value = order.notes || "";
  const statusNode = document.getElementById("edit-status");
  if (statusNode) statusNode.textContent = "";

  const addSelect = document.getElementById("edit-add-item-select");
  addSelect.innerHTML = '<option value="">Choose a product to add...</option>'
    + state.products.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.productName)} — ${formatCurrency(p.unitPrice)}</option>`).join("");

  editState.items = [];
  renderEditItems();
  renderEditTotals();
  dialog.showModal();

  try {
    const items = await loadOrderItems(order.id);
    editState.items = items.map((item) => {
      const product = state.products.find((p) => p.id === item.productId);
      return {
        productId: item.productId,
        productName: item.productName || (product ? product.productName : ""),
        quantity: Number(item.quantity || 0),
        unitPrice: Number(item.unitPrice || (product ? product.unitPrice : 0)),
        defaultDepositAmount: Number(product ? product.defaultDepositAmount : 0)
      };
    });
    renderEditItems();
    renderEditTotals();
  } catch (error) {
    if (statusNode) {
      statusNode.textContent = `Could not load current items: ${error.message || error}`;
      statusNode.style.color = "var(--danger, #b3261e)";
    }
  }
}

async function saveEditedOrder(event) {
  event.preventDefault();
  const orderId = document.getElementById("edit-order-id").value;
  const statusNode = document.getElementById("edit-status");

  if (!editState.items.length) {
    if (statusNode) {
      statusNode.textContent = "Order needs at least one item.";
      statusNode.style.color = "var(--danger, #b3261e)";
    }
    return;
  }

  const order = state.orders.find((row) => row.id === orderId);
  const newAddress = document.getElementById("edit-address").value.trim();
  const oldAddress = String(order?.address || "").trim();
  const addressChanged = newAddress !== oldAddress;
  const confirmedEditLocation = editAddressController.confirmedFor(newAddress);
  const locationReconfirmed = editAddressController.hasFreshConfirmationFor(newAddress);
  // A changed address must be re-verified on the map before it can be saved —
  // no silent geocode. The confirmed pin has to belong to the address as it
  // now reads in the field, so editing after confirming forces another check.
  if (addressChanged && !confirmedEditLocation) {
    if (statusNode) {
      statusNode.textContent = "Confirm the new address on Google Maps before saving.";
      statusNode.style.color = "var(--danger, #b3261e)";
    }
    editAddressController.setStatus("Find the new address on the map and confirm the pin.", true);
    document.getElementById("edit-address-verify")?.focus();
    return;
  }

  await withSubmitLock(event, async () => {
    try {
      if (statusNode) statusNode.textContent = "Saving...";

      const amountPaid = Number(order?.amountPaid || 0);
      const totals = computeEditTotals();
      const balanceDue = totals.subtotal + totals.depositTotal - amountPaid;

      const deliveryLocationPatch = (addressChanged || locationReconfirmed)
        ? { deliveryLocation: confirmedEditLocation }
        : {};

      const batch = writeBatch(db);

      const existingSnap = await getDocs(query(collection(db, "orderItems"), where("orderId", "==", orderId)));
      existingSnap.docs.forEach((docSnap) => {
        batch.delete(doc(db, "orderItems", docSnap.id));
      });

      editState.items.forEach((item) => {
        const qty = Number(item.quantity);
        const unitPrice = Number(item.unitPrice);
        batch.set(doc(db, "orderItems", buildOrderId("ITEM")), {
          orderId,
          authUid: order?.authUid || null,
          productId: item.productId,
          productName: item.productName,
          quantity: qty,
          unitPrice,
          lineTotal: qty * unitPrice
        });
      });

      // Compensating deposit events: for every container-type delta between
      // what was already charged on this order (net of any refunds already
      // processed) and what the current items require, emit a charged or
      // refunded event. Keeps the deposits page + customer balance in sync
      // with the edited order. Legacy "mixed" events get zeroed out naturally
      // as the new per-type charges land.
      const productsById = Object.fromEntries(state.products.map((p) => [p.id, p]));
      const newBreakdown = computeDepositBreakdown(editState.items, productsById);
      const newByType = Object.fromEntries(newBreakdown.map((b) => [b.containerType, b]));
      const existingByType = {};
      state.depositEvents
        .filter((e) => e.orderId === orderId)
        .forEach((e) => {
          const type = e.containerType || "other";
          const qty = Number(e.qty || 0);
          const amt = Number(e.amount || 0);
          if (!existingByType[type]) existingByType[type] = { qty: 0, amount: 0 };
          if (e.eventType === "charged") {
            existingByType[type].qty += qty;
            existingByType[type].amount += amt;
          } else if (["refunded", "credited", "forfeited", "charge_reversed"].includes(e.eventType)) {
            existingByType[type].qty -= qty;
            existingByType[type].amount -= amt;
          }
        });
      const allTypes = new Set([...Object.keys(existingByType), ...Object.keys(newByType)]);
      const nowStr = todayKey();
      allTypes.forEach((type) => {
        const need = newByType[type] || { qty: 0, amount: 0 };
        const have = existingByType[type] || { qty: 0, amount: 0 };
        const deltaQty = need.qty - have.qty;
        const deltaAmount = need.amount - have.amount;
        if (deltaQty === 0 && Math.abs(deltaAmount) < 0.01) return;
        const eventType = (deltaQty > 0 || (deltaQty === 0 && deltaAmount > 0)) ? "charged" : "refunded";
        batch.set(doc(db, "depositEvents", buildDepositEventId()), {
          orderId,
          customerId: order?.customerId || null,
          authUid: order?.authUid || null,
          containerType: type,
          qty: Math.abs(deltaQty),
          amount: Math.abs(deltaAmount),
          eventType,
          eventDate: nowStr,
          linkedDocumentId: null,
          notes: eventType === "charged" ? "Order edit — increased containers" : "Order edit — reduced containers"
        });
      });

      batch.update(doc(db, "orders", orderId), {
        customerName: document.getElementById("edit-customer-name").value.trim(),
        phone: document.getElementById("edit-phone").value.trim(),
        address: newAddress,
        ...deliveryLocationPatch,
        deliveryDate: document.getElementById("edit-delivery-date").value,
        deliveryWindow: document.getElementById("edit-delivery-window").value.trim(),
        notes: document.getElementById("edit-notes").value.trim(),
        subtotal: totals.subtotal,
        depositTotal: totals.depositTotal,
        balanceDue,
        paymentStatus: paymentStatusFor(amountPaid, balanceDue),
        updatedAt: new Date().toISOString()
      });

      await batch.commit();
      document.getElementById("edit-order-dialog").close();
      await refreshDashboard();
    } catch (error) {
      if (statusNode) {
        statusNode.textContent = error.message || String(error);
        statusNode.style.color = "var(--danger, #b3261e)";
      }
    }
  });
}

function daysFromToday(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return localDateKey(d);
}

const CONTAINER_LABELS = {
  glass_crate: "Glass crates",
  "18_9l_jug": "18.9 L jugs",
  "19l_jug": "19 L jugs",
  "20l_jug": "20 L jugs",
  mixed: "Mixed containers"
};

function humanizeContainerType(key) {
  if (!key) return "Other";
  return CONTAINER_LABELS[key] || String(key).replace(/_/g, " ");
}

const deliveryDialogState = {
  heldContainers: {},
  balanceDue: 0,
  amountOverridden: false
};

async function loadHeldContainersForCustomer(customerId) {
  if (!customerId) return {};
  const snap = await getDocs(query(collection(db, "depositEvents"), where("customerId", "==", customerId)));
  const byType = {};
  snap.docs.forEach((docSnap) => {
    const event = docSnap.data();
    const type = String(event.containerType || "other");
    if (!byType[type]) {
      byType[type] = { qty: 0, amount: 0, totalChargedAmount: 0, totalChargedQty: 0 };
    }
    const qty = Number(event.qty || 0);
    const amount = Number(event.amount || 0);
    if (event.eventType === "charged") {
      byType[type].qty += qty;
      byType[type].amount += amount;
      byType[type].totalChargedAmount += amount;
      byType[type].totalChargedQty += qty;
    } else if (event.eventType === "refunded" || event.eventType === "credited" || event.eventType === "forfeited" || event.eventType === "charge_reversed") {
      byType[type].qty -= qty;
      byType[type].amount -= amount;
    }
  });
  // Types that net to a clean zero are dropped; negatives are deliberately kept
  // so renderHeldContainers can flag them. Filtering them out here is what let a
  // broken balance masquerade as "nothing on file".
  const result = {};
  Object.entries(byType).forEach(([type, data]) => {
    if (data.qty !== 0 || Math.abs(data.amount) >= 1) {
      result[type] = {
        qty: data.qty,
        outstandingAmount: data.amount,
        depositPerUnit: data.totalChargedQty > 0 ? data.totalChargedAmount / data.totalChargedQty : 0
      };
    }
  });
  return result;
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

function renderHeldContainers(held) {
  const container = document.getElementById("delivery-containers-list");
  const help = document.getElementById("delivery-containers-help");
  const types = heldTypesFrom(held);
  const warning = brokenBalanceWarningHtml(brokenBalancesFrom(held));
  if (!types.length) {
    if (help) {
      help.textContent = warning
        ? "Nothing can be returned here until the record below is corrected."
        : "This customer isn't holding any containers, so there's nothing to return and nothing to write off. If they hand one back anyway, take it — but there's no deposit of theirs to give back, so note it on the order instead.";
    }
    container.innerHTML = warning;
    recalcAdminDeliveryCod();
    return;
  }
  if (help) help.textContent = "Enter qty returned this trip and pick how to handle the deposit. Leave qty 0 for containers that stayed with the customer.";
  container.innerHTML = warning + types.map((type) => {
    const info = held[type];
    return `
      <div class="card">
        <div class="order-top">
          <div>
            <strong>${escapeHtml(humanizeContainerType(type))}</strong>
            <div class="muted">${Number(info.qty || 0)} held · ${formatCurrency(info.outstandingAmount)} deposit outstanding</div>
          </div>
          <div class="button-row" style="gap:6px;flex-wrap:wrap">
            <label class="muted" style="gap:4px;display:flex;align-items:center">
              Returned
              <input type="number" data-return-qty="${escapeHtml(type)}" min="0" max="${Number(info.qty || 0)}" step="1" value="0" style="width:64px">
            </label>
            <select data-return-handling="${escapeHtml(type)}">
              <option value="credit">Apply to this order</option>
              <option value="refund">Refund cash now</option>
              <option value="keep">Owner will decide later</option>
            </select>
          </div>
        </div>
      </div>
    `;
  }).join("");
  container.querySelectorAll("[data-return-qty], [data-return-handling]").forEach((node) => {
    node.addEventListener("input", recalcAdminDeliveryCod);
    node.addEventListener("change", recalcAdminDeliveryCod);
  });
  recalcAdminDeliveryCod();
}

function collectAdminDeliveryReturns() {
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

function recalcAdminDeliveryCod() {
  const returns = collectAdminDeliveryReturns();
  const creditTotal = returns.filter((r) => r.handling === "credit").reduce((sum, r) => sum + r.returnedQty * r.depositPerUnit, 0);
  const refundTotal = returns.filter((r) => r.handling === "refund").reduce((sum, r) => sum + r.returnedQty * r.depositPerUnit, 0);
  const due = Number(deliveryDialogState.balanceDue || 0);
  const cashToCollect = Math.max(0, due - creditTotal);
  const amountInput = document.getElementById("delivery-payment-amount");
  if (!deliveryDialogState.amountOverridden && amountInput) amountInput.value = cashToCollect;
  const collected = document.querySelector('input[name="collected"]:checked')?.value === "collected";
  const cashPaid = collected ? Number(amountInput?.value || 0) : 0;
  const overCredit = Math.min(creditTotal, Math.max(0, cashPaid + creditTotal - due));
  const summary = document.getElementById("delivery-cod-summary");
  if (summary && (creditTotal > 0 || refundTotal > 0)) {
    const lines = [`<div><span>Order due</span><strong>${escapeHtml(formatCurrency(due))}</strong></div>`];
    if (creditTotal > 0) lines.push(`<div><span>− Deposit credit applied</span><strong>−${escapeHtml(formatCurrency(creditTotal))}</strong></div>`);
    lines.push(`<div class="delivery-cod-total"><span>Cash to collect</span><strong>${escapeHtml(formatCurrency(cashToCollect))}</strong></div>`);
    if (refundTotal > 0) lines.push(`<div><span>Cash to refund (separate)</span><strong>${escapeHtml(formatCurrency(refundTotal))}</strong></div>`);
    if (overCredit > 0) lines.push(`<div><span class="muted" style="grid-column:1/-1">Choose below whether to refund the ${escapeHtml(formatCurrency(overCredit))} excess or carry it forward.</span></div>`);
    summary.innerHTML = lines.join("");
    summary.classList.remove("hidden");
  } else if (summary) {
    summary.innerHTML = "";
    summary.classList.add("hidden");
  }
  // Photo is mandatory whenever a container physically changed hands.
  document.getElementById("delivery-return-proof-field")?.classList.toggle("hidden", returns.length === 0);
  document.getElementById("delivery-overcredit-field")?.classList.toggle("hidden", overCredit <= 0);
  const amountNode = document.getElementById("delivery-overcredit-amount");
  if (amountNode) amountNode.textContent = formatCurrency(overCredit);
}

// Only containers the customer is actually holding can be written off. Listing
// every product type here is what allowed a loss report against a customer who
// held nothing — a 0 VND forfeit that drove their balance below zero.
function populateLossTypeSelect() {
  const select = document.getElementById("delivery-loss-type");
  if (!select) return;
  const held = deliveryDialogState.heldContainers;
  const heldTypes = heldTypesFrom(held);
  select.innerHTML = heldTypes.map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(humanizeContainerType(t))} (${Number(held[t].qty)} held)</option>`).join("");
  select.onchange = syncLossQtyMax;
  const nothingToWriteOff = heldTypes.length === 0;
  const checkbox = document.getElementById("delivery-loss-checkbox");
  if (checkbox) {
    checkbox.disabled = nothingToWriteOff;
    if (nothingToWriteOff) checkbox.checked = false;
  }
  const help = document.getElementById("delivery-loss-help");
  if (help) help.textContent = nothingToWriteOff ? "Nothing to write off — this customer has no containers on file." : "";
  syncLossQtyMax();
  toggleLossFields();
}

// Keeps the qty ceiling in step with the selected type, so five jugs can't be
// written off against a customer holding two.
function syncLossQtyMax() {
  const select = document.getElementById("delivery-loss-type");
  const qtyInput = document.getElementById("delivery-loss-qty");
  if (!select || !qtyInput) return;
  const heldQty = Number(deliveryDialogState.heldContainers[select.value]?.qty || 0);
  qtyInput.max = heldQty > 0 ? heldQty : 1;
  if (Number(qtyInput.value || 0) > heldQty) qtyInput.value = heldQty > 0 ? heldQty : 1;
}

function toggleLossFields() {
  const checkbox = document.getElementById("delivery-loss-checkbox");
  const fields = document.getElementById("delivery-loss-fields");
  if (!checkbox || !fields) return;
  if (checkbox.checked) {
    fields.classList.remove("hidden");
  } else {
    fields.classList.add("hidden");
  }
}

function toggleDeliveryPaymentFields() {
  const selected = document.querySelector('input[name="collected"]:checked')?.value || "collected";
  const collectedFields = document.getElementById("delivery-collected-fields");
  const deferredFields = document.getElementById("delivery-deferred-fields");
  const amountInput = document.getElementById("delivery-payment-amount");
  if (selected === "collected") {
    collectedFields.classList.remove("hidden");
    deferredFields.classList.add("hidden");
    if (amountInput) amountInput.required = true;
  } else {
    collectedFields.classList.add("hidden");
    deferredFields.classList.remove("hidden");
    if (amountInput) amountInput.required = false;
  }
}

async function openDeliveryPaymentDialog(order) {
  const dialog = document.getElementById("delivery-payment-dialog");
  if (!dialog || typeof dialog.showModal !== "function") return;
  document.getElementById("delivery-payment-order-id").value = order.id;
  document.getElementById("delivery-payment-customer").textContent = order.customerName || "customer";
  document.getElementById("delivery-payment-due").textContent = formatCurrency(order.balanceDue);
  document.getElementById("delivery-payment-amount").value = Number(order.balanceDue || 0);
  document.getElementById("delivery-payment-method").value = "cash";
  document.getElementById("delivery-payment-reference").value = "";
  // A file input keeps its selection across dialog opens — without this the
  // next order's payment silently inherits the previous order's proof photo.
  const proofInput = document.getElementById("delivery-payment-proof");
  if (proofInput) proofInput.value = "";
  // Same trap for the container-return photo: a stale selection here would
  // attach the previous order's empties as proof for this one.
  const returnProofInput = document.getElementById("delivery-return-proof");
  if (returnProofInput) returnProofInput.value = "";
  // Same trap for the written alternative: last order's explanation must not
  // become this order's proof.
  const returnNoteInput = document.getElementById("delivery-return-note");
  if (returnNoteInput) returnNoteInput.value = "";
  document.getElementById("delivery-return-proof-field")?.classList.add("hidden");
  document.getElementById("delivery-cod-summary")?.classList.add("hidden");
  document.getElementById("delivery-overcredit-field")?.classList.add("hidden");
  const carryRadio = document.querySelector('input[name="delivery-overcredit"][value="carry"]');
  if (carryRadio) carryRadio.checked = true;
  deliveryDialogState.balanceDue = Number(order.balanceDue || 0);
  deliveryDialogState.amountOverridden = false;
  document.getElementById("delivery-deferral-reason").value = "customer_said_next_time";
  document.getElementById("delivery-follow-up").value = daysFromToday(state.thresholds.followUpDays);
  document.getElementById("delivery-deferral-notes").value = "";
  const lossCheckbox = document.getElementById("delivery-loss-checkbox");
  if (lossCheckbox) lossCheckbox.checked = false;
  document.getElementById("delivery-loss-qty").value = 1;
  document.getElementById("delivery-loss-note").value = "";
  toggleLossFields();
  const collectedRadio = document.querySelector('input[name="collected"][value="collected"]');
  if (collectedRadio) collectedRadio.checked = true;
  toggleDeliveryPaymentFields();

  deliveryDialogState.heldContainers = {};
  renderHeldContainers({});
  populateLossTypeSelect();
  const statusNode = document.getElementById("delivery-payment-status");
  if (statusNode) {
    statusNode.textContent = "";
    statusNode.style.color = "";
  }
  // Remembered so a successful delivery can clear the customer's
  // "pick up my empties" request — the visit it asked for has happened.
  deliveryDialogState.customerId = order.customerId || null;
  dialog.showModal();

  try {
    const held = await loadHeldContainersForCustomer(order.customerId);
    deliveryDialogState.heldContainers = held;
    renderHeldContainers(held);
    populateLossTypeSelect();
  } catch (error) {
    const help = document.getElementById("delivery-containers-help");
    if (help) help.textContent = `Could not load container balance: ${error.message || error}`;
  }

  if (state.customersById?.[order.customerId]?.emptiesPickupRequested === true) {
    const help = document.getElementById("delivery-containers-help");
    if (help) {
      help.innerHTML = `<strong style="color:#0b7a63">♻ The customer asked for an empties pickup this delivery.</strong> ${escapeHtml(help.textContent)}`;
    }
  }
}

async function saveDeliveryPayment(event) {
  event.preventDefault();
  const orderId = document.getElementById("delivery-payment-order-id").value;
  const statusNode = document.getElementById("delivery-payment-status");

  const collectedRadio = document.querySelector('input[name="collected"]:checked');
  const collected = collectedRadio ? collectedRadio.value : "collected";
  const now = new Date().toISOString();
  const today = todayKey();
  const paymentId = buildPaymentId();

  // Snapshot every DOM input BEFORE opening the transaction. Firestore may
  // retry the transaction closure on contention; DOM reads inside the closure
  // would leak stale values on retry (or the input itself could have been
  // disabled by withSubmitLock).
  let paymentSnapshot;
  if (collected === "collected") {
    const amount = Number(document.getElementById("delivery-payment-amount").value || 0);
    // P0-09: positive whole VND only, and zero while a balance remains routes
    // to the "Not collected today" branch instead of writing a silent 0 VND
    // payment. The server re-checks this against the FRESH balance; this is
    // the friendlier local stop.
    const amountProblem = collectedPaymentProblem(amount, deliveryDialogState.balanceDue);
    if (amountProblem) {
      if (statusNode) {
        statusNode.textContent = amountProblem;
        statusNode.style.color = "var(--danger, #b3261e)";
      }
      return;
    }
    // The proof input only lives in the collected branch — a deferred payment
    // moved no money, so there is nothing to photograph.
    const proofInput = document.getElementById("delivery-payment-proof");
    const proofFile = proofInput && proofInput.files && proofInput.files[0] ? proofInput.files[0] : null;
    if (proofFile) {
      const problem = validateProofFile(proofFile);
      if (problem) {
        if (statusNode) {
          statusNode.textContent = problem;
          statusNode.style.color = "var(--danger, #b3261e)";
        }
        return;
      }
    }
    paymentSnapshot = {
      collected: true,
      amount,
      method: document.getElementById("delivery-payment-method").value || "cash",
      reference: document.getElementById("delivery-payment-reference").value.trim() || null,
      proofFile
    };
  } else {
    paymentSnapshot = {
      collected: false,
      reason: document.getElementById("delivery-deferral-reason").value || "other",
      followUpBy: document.getElementById("delivery-follow-up").value || daysFromToday(state.thresholds.followUpDays),
      notes: document.getElementById("delivery-deferral-notes").value.trim() || null
    };
  }

  const containerReturns = collectAdminDeliveryReturns();
  const overCreditChoice = document.querySelector('input[name="delivery-overcredit"]:checked')?.value || "carry";

  // A container that physically changed hands must leave a record before the
  // order can close — a credit/refund with no account of it is exactly how a
  // deposit goes missing (driver credits it but forgets to take the empty).
  // Photo OR written note, per containerReturnProofProblem: a photo of an empty
  // floor proves nothing, so the note is a real alternative rather than a lesser
  // one. Mirrors orderApp.js::saveDeliveryPayment via the shared rule.
  const returnProofInput = document.getElementById("delivery-return-proof");
  const returnProofFile = returnProofInput && returnProofInput.files && returnProofInput.files[0]
    ? returnProofInput.files[0]
    : null;
  const returnNote = String(document.getElementById("delivery-return-note")?.value || "").trim();
  if (containerReturns.length > 0) {
    const proofProblem = containerReturnProofProblem({ hasPhoto: !!returnProofFile, note: returnNote });
    if (proofProblem) {
      if (statusNode) {
        statusNode.textContent = proofProblem;
        statusNode.style.color = "var(--danger, #b3261e)";
      }
      return;
    }
    const problem = returnProofFile ? validateProofFile(returnProofFile) : null;
    if (problem) {
      if (statusNode) {
        statusNode.textContent = problem;
        statusNode.style.color = "var(--danger, #b3261e)";
      }
      return;
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
  const lossCheckbox = document.getElementById("delivery-loss-checkbox");
  let lossReport = null;
  if (lossCheckbox && lossCheckbox.checked) {
    const lossType = document.getElementById("delivery-loss-type").value;
    const lossQty = Number(document.getElementById("delivery-loss-qty").value || 0);
    const lossNote = document.getElementById("delivery-loss-note").value.trim() || null;
    const held = deliveryDialogState.heldContainers[lossType];
    const heldQty = Number(held?.qty || 0);
    const reject = (message) => {
      if (statusNode) {
        statusNode.textContent = message;
        statusNode.style.color = "var(--danger, #b3261e)";
      }
    };
    if (!lossType || heldQty <= 0) {
      reject("This customer has no containers on file, so there is nothing to report lost.");
      return;
    }
    if (lossQty <= 0 || lossQty > heldQty) {
      reject(`Qty lost must be between 1 and ${heldQty}.`);
      return;
    }
    // A write-off needs a deliberate reason (P0-08 item 5); the server rejects
    // an empty one too.
    if (!lossNote) {
      reject("Say what happened to the containers before writing them off.");
      return;
    }
    lossReport = { lossType, lossQty, depositPerUnit: held.depositPerUnit || 0, lossNote };
  }

  // P0-09: cash beyond what is still due becomes customer credit and needs an
  // explicit confirmation that STATES that credit (an extra typed zero is a 10x
  // overpayment). Confirmed here against the dialog's number; the server
  // recomputes against the FRESH balance and rejects a mismatch with the real
  // figure, which is re-confirmed in the catch below. Mirrors orderApp.js.
  let acknowledgeCashCredit = null;
  if (paymentSnapshot.collected) {
    const knownBalance = Math.max(0, Number(deliveryDialogState.balanceDue || 0));
    const excessCash = Math.max(0, paymentSnapshot.amount - knownBalance);
    if (excessCash > 0) {
      const ok = window.confirm(
        `That collects ${formatCurrency(excessCash)} more than the ${formatCurrency(knownBalance)} due. ` +
        `The extra stays on the customer's account as credit. Continue?`
      );
      if (!ok) {
        if (statusNode) statusNode.textContent = "Not saved.";
        return;
      }
      acknowledgeCashCredit = excessCash;
    }
  }

  await withSubmitLock(event, async () => {
    try {
      if (statusNode) {
        statusNode.textContent = "Saving...";
        statusNode.style.color = "";
      }
      // Upload the proof before the transaction opens, for two reasons: an
      // upload inside the closure would re-run on every Firestore retry and
      // leave orphan copies, and a failed upload must abort the whole save
      // rather than record a payment whose proof the owner believes attached.
      let proofDocumentId = null;
      let proofUrl = null;
      if (paymentSnapshot.collected && paymentSnapshot.proofFile) {
        if (statusNode) statusNode.textContent = "Uploading proof photo…";
        const proof = await uploadPaymentProof({
          orderId,
          paymentId,
          file: paymentSnapshot.proofFile
        });
        proofDocumentId = proof.documentId;
        // Denormalized alongside proofDocumentId so the today board can render a
        // thumbnail from state.payments, which it already loads. The alternative
        // is a documents lookup per payment on every board render, and that page
        // is already the one ROADMAP flags as first to hurt on load volume.
        proofUrl = proof.downloadUrl;
        if (statusNode) statusNode.textContent = "Saving...";
      }
      // Same pre-transaction reasoning as the payment proof above: uploading
      // inside the closure would duplicate on retry, and a failed upload must
      // abort the save rather than book a credit whose proof never landed.
      let returnProofDocumentId = null;
      if (containerReturns.length > 0 && returnProofFile) {
        if (statusNode) statusNode.textContent = "Uploading container photo…";
        const returnProof = await uploadContainerReturnProof({ orderId, file: returnProofFile });
        returnProofDocumentId = returnProof.documentId;
        if (statusNode) statusNode.textContent = "Saving...";
      }
      // P0-08: the whole commit is now ONE Admin-SDK transaction on the server
      // (commitDelivery) — same callable the order-detail page uses. It re-reads
      // the order status, re-aggregates the customer's current holdings, clamps
      // every return + forfeit against those FRESH numbers, and serializes
      // concurrent deliveries on the customer doc so two stale tabs can't drive a
      // balance below zero. It also clears the empties-pickup flag ONLY when a
      // physical return was actually recorded. Proof photos are uploaded above
      // (client-side, id-referenced), the same pattern refund proofs use. The
      // money math lives on the server now; this dashboard no longer computes
      // balances or writes deposit events directly.
      const callCommit = (ack) => commitDeliveryFn({
        orderId,
        paymentId,
        payment: paymentSnapshot.collected
          ? {
              collected: true,
              amount: paymentSnapshot.amount,
              method: paymentSnapshot.method,
              reference: paymentSnapshot.reference
            }
          : {
              collected: false,
              reason: paymentSnapshot.reason,
              followUpBy: paymentSnapshot.followUpBy,
              notes: paymentSnapshot.notes
            },
        returns: containerReturns.map((r) => ({ type: r.type, returnedQty: r.returnedQty, handling: r.handling })),
        lossReport: lossReport
          ? { lossType: lossReport.lossType, lossQty: lossReport.lossQty, lossNote: lossReport.lossNote }
          : null,
        overCreditChoice,
        acknowledgeCashCredit: ack,
        proofDocumentId,
        proofUrl,
        returnProofDocumentId,
        returnProofType,
        returnProofNote
      });
      try {
        await callCommit(acknowledgeCashCredit);
      } catch (error) {
        const details = error && error.details;
        if (details && details.overpayment && Number.isInteger(details.excessCash)) {
          // Stale dialog: the balance changed since it opened. Nothing was
          // written; re-confirm with the server's fresh numbers and retry
          // under the same paymentId.
          const ok = window.confirm(
            `The balance changed since this dialog opened — ${formatCurrency(details.dueBefore)} is due now, ` +
            `so this collects ${formatCurrency(details.excessCash)} extra as customer credit. Continue?`
          );
          if (!ok) {
            if (statusNode) statusNode.textContent = "Not saved — reload to see the current balance.";
            return;
          }
          await callCommit(details.excessCash);
        } else {
          throw error;
        }
      }
      document.getElementById("delivery-payment-dialog").close();
      await refreshDashboard();
    } catch (error) {
      if (statusNode) {
        statusNode.textContent = error.message || String(error);
        statusNode.style.color = "var(--danger, #b3261e)";
      }
    }
  });
}

const invoiceState = {
  currentCtx: null,
  previousShare: null
};

async function loadBusinessSettings() {
  try {
    const snap = await getDocs(query(collection(db, "settings")));
    const businessDoc = snap.docs.find((d) => d.id === "business");
    return businessDoc ? businessDoc.data() : {};
  } catch (_) {
    return {};
  }
}

async function loadPreviousInvoiceShare(orderId) {
  try {
    const snap = await getDocs(query(collection(db, "documents"), where("entityId", "==", orderId)));
    return snap.docs
      .map((item) => ({ id: item.id, ...item.data() }))
      .filter((item) => item.entityType === "order" && ["invoice", "order_confirmation"].includes(item.documentType))
      .sort((a, b) => invoiceShareTime(b.uploadedAt) - invoiceShareTime(a.uploadedAt))[0] || null;
  } catch (error) {
    console.warn("Could not check previous invoice shares:", error);
    return null;
  }
}

async function openInvoiceDialog(order) {
  const dialog = document.getElementById("invoice-dialog");
  const slot = document.getElementById("invoice-preview-slot");
  const statusNode = document.getElementById("invoice-status");
  const downloadBtn = document.getElementById("invoice-download-button");
  const whatsappBtn = document.getElementById("invoice-whatsapp-button");
  if (!dialog || !slot) return;

  slot.innerHTML = `<div style="padding:24px;color:var(--muted);text-align:center">Loading invoice…</div>`;
  if (statusNode) statusNode.textContent = "";
  if (whatsappBtn) whatsappBtn.style.display = "none";
  invoiceState.currentCtx = null;
  invoiceState.previousShare = null;
  dialog.showModal();

  try {
    const [settings, itemsSnap, previousShare] = await Promise.all([
      loadBusinessSettings(),
      getDocs(query(collection(db, "orderItems"), where("orderId", "==", order.id))),
      loadPreviousInvoiceShare(order.id)
    ]);
    const items = itemsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const ctx = invoiceContext({ order, items, settings });
    slot.innerHTML = renderInvoiceHtml(ctx);
    await attachQrToPreview(ctx, slot);

    invoiceState.currentCtx = ctx;
    invoiceState.previousShare = previousShare;
    downloadBtn.disabled = false;
    downloadBtn.dataset.orderId = order.id;

    // Both share buttons upload on click rather than here — previewing an
    // invoice shouldn't push a PDF into Storage. They're shown/hidden purely on
    // whether the customer has an email / phone to send to.
    const emailBtn = document.getElementById("invoice-email-button");
    if (emailBtn) emailBtn.style.display = buildEmailShare(ctx) ? "" : "none";
    if (whatsappBtn) whatsappBtn.style.display = buildWhatsAppShare(ctx) ? "" : "none";
  } catch (error) {
    slot.innerHTML = `<div style="padding:24px;color:var(--danger)">Could not load invoice: ${escapeHtml(error.message || error)}</div>`;
  }
}

async function downloadInvoice() {
  const ctx = invoiceState.currentCtx;
  const statusNode = document.getElementById("invoice-status");
  if (!ctx) return;
  try {
    if (statusNode) statusNode.textContent = "Building PDF…";
    const doc = await generateInvoicePdf(ctx);
    doc.save(`invoice-${ctx.invoiceNumber}.pdf`);
    if (statusNode) statusNode.textContent = "Downloaded.";
  } catch (error) {
    if (statusNode) statusNode.textContent = `PDF error: ${error.message || error}`;
  }
}

function invoiceShareTime(value) {
  const date = value && typeof value.toDate === "function" ? value.toDate() : new Date(value);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function invoiceShareDate(value) {
  const time = invoiceShareTime(value);
  return time ? new Date(time).toLocaleString() : "an earlier time";
}

function confirmRepeatedInvoiceShare(ctx, nextChannel) {
  const order = ctx?.order;
  const previousAt = order?.invoiceLastSharedAt || invoiceState.previousShare?.uploadedAt;
  if (!previousAt) return true;
  const previousChannel = order.invoiceLastSharedChannel === "whatsapp"
    ? " by WhatsApp"
    : (order.invoiceLastSharedChannel === "email" ? " by Email" : "");
  return window.confirm(
    `Duplicate message warning\n\nThis invoice was already prepared for the customer${previousChannel} on ${invoiceShareDate(previousAt)}.\n\nSend it again via ${nextChannel}?`
  );
}

async function recordInvoiceShare(ctx, channel) {
  const sharedAt = new Date().toISOString();
  await updateDoc(doc(db, "orders", ctx.order.id), {
    invoiceLastSharedAt: serverTimestamp(),
    invoiceLastSharedChannel: channel,
    updatedAt: sharedAt
  });
  // Keep the open dialog in sync so a second channel click warns immediately,
  // without waiting for the live order listener to deliver the server write.
  ctx.order.invoiceLastSharedAt = sharedAt;
  ctx.order.invoiceLastSharedChannel = channel;
}

async function emailInvoice() {
  const ctx = invoiceState.currentCtx;
  const statusNode = document.getElementById("invoice-status");
  if (!ctx) return;
  if (!buildEmailShare(ctx)) {
    if (statusNode) statusNode.textContent = "No customer email on file.";
    return;
  }
  if (!confirmRepeatedInvoiceShare(ctx, "Email")) return;
  await withSubmitLock(document.getElementById("invoice-email-button"), async () => {
    try {
      if (statusNode) statusNode.textContent = "Uploading PDF…";
      const { downloadUrl } = await ensureInvoicePdfUploaded(ctx);
      await recordInvoiceShare(ctx, "email");
      window.location.href = buildEmailShare(ctx, downloadUrl);
      if (statusNode) statusNode.textContent = "Email opened with a link to the PDF. No attachment needed.";
    } catch (error) {
      if (statusNode) statusNode.textContent = `Email error: ${error.message || error}`;
    }
  }, { busyLabel: "Uploading…" });
}

async function whatsappInvoice() {
  const ctx = invoiceState.currentCtx;
  const statusNode = document.getElementById("invoice-status");
  if (!ctx) return;
  if (!buildWhatsAppShare(ctx)) {
    if (statusNode) statusNode.textContent = "No customer phone on file.";
    return;
  }
  if (!confirmRepeatedInvoiceShare(ctx, "WhatsApp")) return;
  // The tab has to be opened synchronously inside the click handler — opening
  // it after the upload await makes it a popup and the browser blocks it.
  const tab = window.open("", "_blank", "noopener");
  await withSubmitLock(document.getElementById("invoice-whatsapp-button"), async () => {
    try {
      if (statusNode) statusNode.textContent = "Uploading PDF…";
      const { downloadUrl } = await ensureInvoicePdfUploaded(ctx);
      await recordInvoiceShare(ctx, "whatsapp");
      const share = buildWhatsAppShare(ctx, downloadUrl);
      if (tab) {
        tab.location.href = share;
        if (statusNode) statusNode.textContent = "WhatsApp opened with a link to the PDF.";
      } else {
        // Popup blocked. The upload already succeeded, so hand over the link
        // rather than making the owner click through the whole flow again.
        if (statusNode) {
          statusNode.innerHTML = `Pop-up blocked — <a href="${escapeHtml(share)}" target="_blank" rel="noopener">open WhatsApp</a>.`;
        }
      }
    } catch (error) {
      if (tab) tab.close();
      if (statusNode) statusNode.textContent = `WhatsApp error: ${error.message || error}`;
    }
  }, { busyLabel: "Uploading…" });
}

async function loadCollection(name, filters = []) {
  let source = collection(db, name);
  if (!filters.length) {
    const snap = await getDocs(source);
    return snap.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));
  }
  const snap = await getDocs(query(source, ...filters));
  return snap.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));
}

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

async function refreshDashboard(preloadedOpenOrders = null) {
  const date = state.selectedDate;
  setStatus("Loading Firestore data...");

  const [dayOrders, openOrders, dayPayments] = await Promise.all([
    loadCollection("orders", [where("deliveryDate", "==", date)]),
    Array.isArray(preloadedOpenOrders)
      ? Promise.resolve(preloadedOpenOrders)
      : loadCollection("orders", [where("status", "in", OPEN_ORDER_STATUSES)]),
    loadCollection("payments", [where("paymentDate", "==", date)])
  ]);
  state.openOrders = openOrders;
  const ordersById = new Map(dayOrders.map((order) => [order.id, order]));
  openOrders.forEach((order) => ordersById.set(order.id, order));
  state.orders = [...ordersById.values()];

  const orderIds = openOrders.map((order) => order.id);
  const items = [];
  const orderPayments = [];
  const deposits = [];

  for (const chunk of chunkArray(orderIds, 30)) {
    const [itemsBatch, paymentsBatch, depositsBatch] = await Promise.all([
      loadCollection("orderItems", [where("orderId", "in", chunk)]),
      loadCollection("payments", [where("orderId", "in", chunk)]),
      loadCollection("depositEvents", [where("orderId", "in", chunk)])
    ]);
    items.push(...itemsBatch);
    orderPayments.push(...paymentsBatch);
    deposits.push(...depositsBatch);
  }

  const seenPaymentIds = new Set();
  state.payments = [...dayPayments, ...orderPayments].filter((payment) => {
    if (seenPaymentIds.has(payment.id)) return false;
    seenPaymentIds.add(payment.id);
    return true;
  });
  state.orderItems = items;
  state.depositEvents = deposits;

  // Join the customer docs for active orders — currently only for the
  // "pick up my empties" flag, which lives on the customer (intent isn't
  // tied to one order). One read per unique customer on the board. Best-effort:
  // a failed read just means no badge, never a broken board.
  const uniqueCustomerIds = [...new Set(openOrders.map((o) => o.customerId).filter(Boolean))];
  const customerSnaps = await Promise.all(uniqueCustomerIds.map(async (id) => {
    try {
      const snap = await getDoc(doc(db, "customers", id));
      return snap.exists() ? { id, ...snap.data() } : null;
    } catch (_) {
      return null;
    }
  }));
  state.customersById = Object.fromEntries(customerSnaps.filter(Boolean).map((c) => [c.id, c]));

  renderHero();
  renderOrderBoard();
  setStatus("");
}

// --- Actionable order alerts ------------------------------------------------
//
// The active board now spans every delivery date. This separate pending query
// remains because notifications and the tab-title badge care specifically
// about approval work, while the board also includes assignment and delivery.
//
// Owner-only, and cheap: the orders read rule already grants owners the whole
// collection, and a single equality filter needs no composite index. This is
// the in-page half of the notification story — it only fires while the
// dashboard is open. Push (FCM) would cover a closed tab and is a much bigger
// lift; see ROADMAP.
const ALERT_BASE_TITLE = document.title;

const pendingAlerts = {
  openUnsub: null,
  unsub: null,
  seeded: false,
  count: 0,
  cancellationUnsub: null,
  cancellationSeeded: false,
  cancellationCount: 0
};

function alertStack() {
  let node = document.getElementById("order-alerts");
  if (!node) {
    node = document.createElement("div");
    node.id = "order-alerts";
    node.className = "order-alerts";
    node.setAttribute("role", "status");
    node.setAttribute("aria-live", "polite");
    document.body.appendChild(node);
  }
  return node;
}

// The count rides in the tab title because that is the only part of the page
// visible when the dashboard is in a background tab, which is where it will
// spend most of its day.
function renderPendingBadge() {
  const total = pendingAlerts.count + pendingAlerts.cancellationCount;
  document.title = total > 0
    ? `(${total}) ${ALERT_BASE_TITLE}`
    : ALERT_BASE_TITLE;
}

const OPEN_ORDER_FILTER_KEYS = {
  pending_approval: "to_approve",
  new: "to_assign",
  assigned: "to_send",
  out_for_delivery: "en_route"
};

function humanDeliveryDate(dateKey) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return "Delivery date missing";
  const date = new Date(`${dateKey}T00:00:00+07:00`);
  return date.toLocaleDateString("en-GB", {
    timeZone: "Asia/Ho_Chi_Minh",
    weekday: "short",
    day: "numeric",
    month: "short"
  });
}

function openOrderTiming(order, today) {
  const dateKey = String(order.deliveryDate || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
    return { label: "Needs delivery date", overdue: true };
  }
  if (dateKey === today) return { label: "Today", overdue: false };
  const days = Math.round((Date.parse(`${dateKey}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
  if (days < 0) {
    const overdueDays = Math.abs(days);
    return {
      label: `${overdueDays} day${overdueDays === 1 ? "" : "s"} overdue · ${humanDeliveryDate(dateKey)}`,
      overdue: true
    };
  }
  return { label: days === 1 ? "Tomorrow" : humanDeliveryDate(dateKey), overdue: false };
}

function findDashboardOrder(orderId) {
  return state.openOrders.find((order) => order.id === orderId)
    || state.orders.find((order) => order.id === orderId)
    || null;
}

function openImportanceDialog(orderId) {
  const order = findDashboardOrder(orderId);
  if (!order) return;
  const dialog = document.getElementById("importance-dialog");
  const noteInput = document.getElementById("importance-note");
  document.getElementById("importance-order-id").value = order.id;
  document.getElementById("importance-order-label").textContent = `${order.customerName || "Unknown customer"} · ${order.id}`;
  noteInput.value = order.important === true ? normalizeImportantNote(order.importantNote) : "";
  noteInput.setCustomValidity("");
  document.getElementById("importance-status").textContent = "";
  document.getElementById("importance-clear-button").classList.toggle("hidden", order.important !== true);
  dialog.showModal();
  noteInput.focus();
}

function patchImportanceInState(orderId, important, importantNote) {
  const patch = { important, importantNote };
  state.openOrders = state.openOrders.map((order) => order.id === orderId ? { ...order, ...patch } : order);
  state.orders = state.orders.map((order) => order.id === orderId ? { ...order, ...patch } : order);
  renderOrderBoard();
}

async function saveImportantOrder(event) {
  event.preventDefault();
  const orderId = document.getElementById("importance-order-id").value;
  const noteInput = document.getElementById("importance-note");
  const note = normalizeImportantNote(noteInput.value);
  const status = document.getElementById("importance-status");
  noteInput.setCustomValidity(importantNoteIsValid(note) ? "" : "Enter a note before marking this order important.");
  if (!importantNoteIsValid(note)) {
    noteInput.reportValidity();
    status.textContent = "Note is required.";
    return;
  }

  await withSubmitLock(event, async () => {
    try {
      status.textContent = "Saving…";
      await updateDoc(doc(db, "orders", orderId), {
        important: true,
        importantNote: note,
        importantUpdatedAt: serverTimestamp()
      });
      patchImportanceInState(orderId, true, note);
      document.getElementById("importance-dialog").close();
      setStatus("Important note saved.");
    } catch (error) {
      status.textContent = error.message || String(error);
    }
  }, { busyLabel: "Saving…" });
}

async function clearImportantOrder() {
  const orderId = document.getElementById("importance-order-id").value;
  const status = document.getElementById("importance-status");
  const button = document.getElementById("importance-clear-button");
  await withSubmitLock(button, async () => {
    try {
      status.textContent = "Removing…";
      await updateDoc(doc(db, "orders", orderId), {
        important: false,
        importantNote: null,
        importantUpdatedAt: serverTimestamp()
      });
      patchImportanceInState(orderId, false, null);
      document.getElementById("importance-dialog").close();
      setStatus("Important label removed.");
    } catch (error) {
      status.textContent = error.message || String(error);
    }
  }, { busyLabel: "Removing…" });
}

function dismissAlert(card) {
  card.classList.add("is-dismissing");
  setTimeout(() => card.remove(), 180);
}

// Only burn the toast's lifespan while someone can actually see it.
//
// A backgrounded tab is the case this whole feature exists for, and it breaks
// the naive version twice over: requestAnimationFrame never fires there (so an
// entrance animation driven by it never starts), and setTimeout keeps running
// (so a 15s timer expires while the tab is hidden). Net result was a toast that
// was invisible for its entire life and already gone by the time the owner
// looked. The entrance is CSS-driven now, and the countdown waits for a visible
// tab.
function armAlertDismiss(card, ms) {
  if (document.visibilityState === "visible") {
    setTimeout(() => {
      if (card.isConnected) dismissAlert(card);
    }, ms);
    return;
  }
  const onVisible = () => {
    if (document.visibilityState !== "visible") return;
    document.removeEventListener("visibilitychange", onVisible);
    if (card.isConnected) armAlertDismiss(card, ms);
  };
  document.addEventListener("visibilitychange", onVisible);
}

async function jumpToOpenOrder(order) {
  state.statusFilter = OPEN_ORDER_FILTER_KEYS[order.status] || "all";
  await refreshDashboard(state.openOrders);
  const card = [...document.querySelectorAll("[data-order-card]")]
    .find((node) => node.dataset.orderCard === order.id);
  if (card) {
    card.scrollIntoView({ block: "center", behavior: "smooth" });
    card.querySelector("button.primary, select, a")?.focus();
  }
}

async function jumpToPendingOrder(order) {
  await jumpToOpenOrder(order);
}

async function jumpToCancellationRequest(order) {
  state.statusFilter = "all";
  await refreshDashboard(state.openOrders);
  const action = [...document.querySelectorAll("[data-approve-cancel]")]
    .find((button) => button.dataset.approveCancel === order.id);
  if (action) {
    action.closest(".compact-order")?.scrollIntoView({ block: "center", behavior: "smooth" });
    action.focus();
  }
}

function showOrderAlert(order) {
  const dateLabel = order.deliveryDate === state.selectedDate
    ? "for today's board"
    : `for ${escapeHtml(order.deliveryDate || "no delivery date")}`;
  const card = document.createElement("div");
  card.className = "order-alert";
  card.innerHTML = `
    <button type="button" class="order-alert-dismiss" aria-label="Dismiss">×</button>
    <strong>New order to approve</strong>
    <span>${escapeHtml(order.customerName || "Unknown customer")} — ${dateLabel}</span>
    <button type="button" class="order-alert-view primary">View</button>
  `;
  card.querySelector(".order-alert-dismiss").addEventListener("click", () => dismissAlert(card));
  card.querySelector(".order-alert-view").addEventListener("click", async () => {
    dismissAlert(card);
    await jumpToPendingOrder(order);
  });
  alertStack().appendChild(card);
  armAlertDismiss(card, 15000);
}

function showCancellationAlert(order) {
  const dateLabel = order.deliveryDate === state.selectedDate
    ? "on today's board"
    : `for ${escapeHtml(order.deliveryDate || "no delivery date")}`;
  const reason = order.cancellationRequestReason
    ? `<span>Reason: ${escapeHtml(order.cancellationRequestReason)}</span>`
    : `<span>No reason was provided.</span>`;
  const card = document.createElement("div");
  card.className = "order-alert";
  card.innerHTML = `
    <button type="button" class="order-alert-dismiss" aria-label="Dismiss">×</button>
    <strong>Cancellation requested</strong>
    <span>${escapeHtml(order.customerName || "Unknown customer")} — ${dateLabel}</span>
    ${reason}
    <button type="button" class="order-alert-view primary">Review</button>
  `;
  card.querySelector(".order-alert-dismiss").addEventListener("click", () => dismissAlert(card));
  card.querySelector(".order-alert-view").addEventListener("click", async () => {
    dismissAlert(card);
    await jumpToCancellationRequest(order);
  });
  alertStack().appendChild(card);
  armAlertDismiss(card, 15000);
}

function watchOpenOrders() {
  if (pendingAlerts.openUnsub) return;
  const openQuery = query(collection(db, "orders"), where("status", "in", OPEN_ORDER_STATUSES));
  pendingAlerts.openUnsub = onSnapshot(openQuery, (snap) => {
    state.openOrders = snap.docs.map((item) => ({ id: item.id, ...item.data() }));
    refreshDashboard(state.openOrders).catch((error) => {
      console.warn("Could not refresh active-order cards:", error);
      setStatus("Could not refresh active orders. Reload the dashboard to try again.", true);
    });
  }, (error) => {
    console.warn("Open-order watch stopped:", error);
    setStatus("Live active-order updates stopped. Reload the dashboard to reconnect.", true);
  });
}

function watchPendingApprovals() {
  if (pendingAlerts.unsub) return;
  pendingAlerts.seeded = false;
  const pendingQuery = query(collection(db, "orders"), where("status", "==", "pending_approval"));
  pendingAlerts.unsub = onSnapshot(pendingQuery, (snap) => {
    pendingAlerts.count = snap.size;
    renderPendingBadge();
    // Seed on the first snapshot that actually came from the server, and toast
    // nothing before then. The existing backlog is not news — the badge covers
    // it. Seeding on the *first* callback instead looks right and isn't: that
    // one is usually served from the local cache and can hold a stale subset,
    // so every order the server then reveals arrives as an `added` change and
    // toasts. Cache warm with 1 of 2 orders produced exactly one phantom toast
    // on reload; a cold cache with a real backlog would fire one per order.
    if (!pendingAlerts.seeded) {
      if (snap.metadata.fromCache) return;
      pendingAlerts.seeded = true;
      return;
    }
    snap.docChanges().forEach((change) => {
      if (change.type !== "added") return;
      const order = { id: change.doc.id, ...change.doc.data() };
      showOrderAlert(order);
    });
  }, (error) => {
    // A dead listener must not read as a broken dashboard; the board itself is
    // still correct, it just stops self-updating.
    console.warn("Pending-order watch stopped:", error);
  });
}

function watchCancellationRequests() {
  if (pendingAlerts.cancellationUnsub) return;
  pendingAlerts.cancellationSeeded = false;
  const cancellationQuery = query(collection(db, "orders"), where("cancellationRequested", "==", true));
  pendingAlerts.cancellationUnsub = onSnapshot(cancellationQuery, (snap) => {
    pendingAlerts.cancellationCount = snap.size;
    renderPendingBadge();
    // As with new orders, an existing request is backlog rather than a new
    // notification. Wait for the first server snapshot so cache catch-up does
    // not announce old requests as if the customer just submitted them.
    if (!pendingAlerts.cancellationSeeded) {
      if (snap.metadata.fromCache) return;
      pendingAlerts.cancellationSeeded = true;
      return;
    }
    snap.docChanges().forEach((change) => {
      const order = { id: change.doc.id, ...change.doc.data() };
      if (change.type === "added") showCancellationAlert(order);
    });
  }, (error) => {
    console.warn("Cancellation-request watch stopped:", error);
  });
}

// --- Reconciliation health toast ---------------------------------------
//
// One-shot check, not a listener: the nightly job writes once a day, so the
// dashboard just reads the newest reconciliationReports doc on load. This is
// the in-page half of the alert story — a true push channel (email/WhatsApp)
// needs a provider + credentials; see ROADMAP.
//
// Unlike the order toasts this one does NOT auto-dismiss: there is no
// tab-title badge backing it up, so a toast that expires unseen is an alert
// that never happened. Dismissing (or opening the report) records the run id
// in localStorage and stays quiet for that run. The stale case re-arms every
// day so a dead cron keeps nagging until someone actually fixes it.

const RECON_ALERT_DISMISS_KEY = "reconAlertDismissed";
const RECON_EVENT_DISMISS_KEY = "reconEventAlertDismissed";
const RECON_STALE_HOURS = 30;
// The dashboard only nudges about real-time corrections from the last day; the
// full list lives on the reconciliation page.
const RECON_EVENT_WINDOW_HOURS = 24;

function reconAlertToken(runId, kind) {
  return kind === "stale" ? `${runId}|stale|${todayKey()}` : `${runId}|${kind}`;
}

function showReconAlert({ token, title, detail, dismissKey = RECON_ALERT_DISMISS_KEY }) {
  let dismissed = null;
  try { dismissed = localStorage.getItem(dismissKey); } catch (_) {}
  if (dismissed === token) return;
  const card = document.createElement("div");
  card.className = "order-alert";
  card.innerHTML = `
    <button type="button" class="order-alert-dismiss" aria-label="Dismiss">×</button>
    <strong>${escapeHtml(title)}</strong>
    <span>${escapeHtml(detail)}</span>
    <button type="button" class="order-alert-view primary">Open report</button>
  `;
  const remember = () => {
    try { localStorage.setItem(dismissKey, token); } catch (_) {}
  };
  card.querySelector(".order-alert-dismiss").addEventListener("click", () => {
    remember();
    dismissAlert(card);
  });
  card.querySelector(".order-alert-view").addEventListener("click", () => {
    remember();
    window.location.href = "./reports.html";
  });
  alertStack().appendChild(card);
}

async function checkReconciliationHealth() {
  let run = null;
  try {
    const snap = await getDocs(query(
      collection(db, "reconciliationReports"),
      orderBy("startedAt", "desc"),
      limit(1)
    ));
    // Never run at all: nothing worth toasting — reports.html already says so.
    if (snap.empty) return;
    run = { id: snap.docs[0].id, ...(snap.docs[0].data() || {}) };
  } catch (error) {
    // The health check must never take the dashboard down with it.
    console.warn("Reconciliation health check skipped:", error);
    return;
  }

  const startedAt = run.startedAt && typeof run.startedAt.toDate === "function"
    ? run.startedAt.toDate()
    : null;
  const ageHours = startedAt ? (Date.now() - startedAt.getTime()) / 36e5 : Infinity;
  const drifted = Number(run.drifted || 0);
  const fixFailures = Number(run.failed || 0);

  // One toast per load, worst condition wins: silence > failure > drift.
  if (ageHours > RECON_STALE_HOURS) {
    showReconAlert({
      token: reconAlertToken(run.id, "stale"),
      title: "Reconciliation has gone quiet",
      detail: `No run in over ${RECON_STALE_HOURS} hours — the nightly 03:00 job may be broken.`
    });
    return;
  }
  if (run.status === "failed" || fixFailures > 0) {
    showReconAlert({
      token: reconAlertToken(run.id, "failed"),
      title: "Reconciliation run failed",
      detail: run.status === "failed"
        ? String(run.error || "The nightly run did not finish.")
        : `${fixFailures} drift fix${fixFailures === 1 ? "" : "es"} failed last night.`
    });
    return;
  }
  if (drifted > 0) {
    // Drift used to be routine (non-atomic client writes). Since payment writes
    // are transactional and /payments is append-only, a stored total can no
    // longer drift from its payments through the normal app — so a correction
    // now points at a real cause: a math bug, or a manual/admin data edit.
    // Word it as "investigate", not "handled".
    showReconAlert({
      token: reconAlertToken(run.id, "drift"),
      title: `${drifted} order total${drifted === 1 ? "" : "s"} didn't match — investigate`,
      detail: "Last night's run corrected stored totals that no longer matched their payments. This shouldn't happen on its own now — check what changed these orders."
    });
  }
}

// The reconcileOnPaymentWrite trigger fixes a drifted order the instant a
// payment changes and logs it to reconciliationEvents. The full list lives on
// the reconciliation page; the dashboard only shows a small nudge when there
// has been one in the last day. Separate dismiss key from the nightly toast so
// the two do not overwrite each other's dismissed state.
async function checkRealtimeCorrections() {
  let events = [];
  try {
    const snap = await getDocs(query(
      collection(db, "reconciliationEvents"),
      orderBy("at", "desc"),
      limit(20)
    ));
    events = snap.docs.map((d) => d.data() || {});
  } catch (error) {
    console.warn("Real-time reconciliation check skipped:", error);
    return;
  }

  const cutoff = Date.now() - RECON_EVENT_WINDOW_HOURS * 36e5;
  const recent = events.filter((ev) => {
    const at = ev.at && typeof ev.at.toDate === "function" ? ev.at.toDate().getTime() : 0;
    return at >= cutoff;
  });
  if (!recent.length) return;

  showReconAlert({
    dismissKey: RECON_EVENT_DISMISS_KEY,
    token: `event|${todayKey()}|${recent.length}`,
    title: `${recent.length} order total${recent.length === 1 ? "" : "s"} auto-corrected today — investigate`,
    detail: "The real-time reconciler fixed a total that drifted outside a normal delivery. Open the reconciliation page for details."
  });
}

function stopWatchingPendingApprovals() {
  if (pendingAlerts.openUnsub) {
    pendingAlerts.openUnsub();
    pendingAlerts.openUnsub = null;
  }
  if (pendingAlerts.unsub) {
    pendingAlerts.unsub();
    pendingAlerts.unsub = null;
  }
  if (pendingAlerts.cancellationUnsub) {
    pendingAlerts.cancellationUnsub();
    pendingAlerts.cancellationUnsub = null;
  }
  pendingAlerts.seeded = false;
  pendingAlerts.count = 0;
  pendingAlerts.cancellationSeeded = false;
  pendingAlerts.cancellationCount = 0;
  state.openOrders = [];
  renderPendingBadge();
}

async function bootstrapDashboard() {
  state.products = await loadCollection("products", [where("active", "==", true)]);
  state.drivers = await loadCollection("drivers");
  const settings = await loadBusinessSettings();
  state.thresholds = mergeThresholds(settings.thresholds);
  await refreshDashboard();
}

document.getElementById("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const email = document.getElementById("login-email").value;
  const password = document.getElementById("login-password").value;
  try {
    await signInWithEmailAndPassword(auth, email, password);
  } catch (error) {
    setStatus(error.message || String(error), true);
  }
});

document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-important-order]");
  if (button) openImportanceDialog(button.dataset.importantOrder);
});
document.getElementById("importance-form").addEventListener("submit", saveImportantOrder);
document.getElementById("importance-note").addEventListener("input", (event) => {
  event.target.setCustomValidity("");
  document.getElementById("importance-status").textContent = "";
});
document.getElementById("importance-clear-button").addEventListener("click", clearImportantOrder);
document.getElementById("importance-cancel-button").addEventListener("click", () => {
  document.getElementById("importance-dialog").close();
});
document.getElementById("order-timing-filter")?.addEventListener("change", (event) => {
  state.timingFilter = event.target.value;
  renderOrderBoard();
});

document.getElementById("edit-order-form").addEventListener("submit", saveEditedOrder);
document.getElementById("edit-cancel-button").addEventListener("click", () => {
  document.getElementById("edit-order-dialog").close();
});
document.getElementById("edit-add-item-button").addEventListener("click", addEditItem);
document.getElementById("delivery-payment-form").addEventListener("submit", saveDeliveryPayment);
document.getElementById("delivery-payment-cancel-button").addEventListener("click", () => {
  document.getElementById("delivery-payment-dialog").close();
});
document.getElementById("order-map-close").addEventListener("click", () => {
  document.getElementById("order-map-dialog").close();
});
document.getElementById("proof-preview-close").addEventListener("click", () => {
  document.getElementById("proof-preview-dialog").close();
});
document.getElementById("proof-preview-dialog").addEventListener("close", () => {
  document.getElementById("proof-preview-image").src = "";
});
document.querySelectorAll('input[name="collected"]').forEach((radio) => {
  radio.addEventListener("change", () => {
    toggleDeliveryPaymentFields();
    recalcAdminDeliveryCod();
  });
});
document.getElementById("delivery-payment-amount")?.addEventListener("input", () => {
  deliveryDialogState.amountOverridden = document.getElementById("delivery-payment-amount").value.trim() !== "";
  recalcAdminDeliveryCod();
});
const lossCheckboxNode = document.getElementById("delivery-loss-checkbox");
if (lossCheckboxNode) lossCheckboxNode.addEventListener("change", toggleLossFields);

const invoiceCloseBtn = document.getElementById("invoice-close-button");
if (invoiceCloseBtn) invoiceCloseBtn.addEventListener("click", () => {
  document.getElementById("invoice-dialog").close();
});
const invoiceDownloadBtn = document.getElementById("invoice-download-button");
if (invoiceDownloadBtn) invoiceDownloadBtn.addEventListener("click", downloadInvoice);
const invoiceEmailBtn = document.getElementById("invoice-email-button");
if (invoiceEmailBtn) invoiceEmailBtn.addEventListener("click", emailInvoice);
const invoiceWhatsappBtn = document.getElementById("invoice-whatsapp-button");
if (invoiceWhatsappBtn) invoiceWhatsappBtn.addEventListener("click", whatsappInvoice);

onAuthStateChanged(auth, async (user) => {
  const authView = document.getElementById("auth-view");
  const appView = document.getElementById("app-view");
  if (!user) {
    stopWatchingPendingApprovals();
    authView.classList.remove("hidden");
    appView.classList.add("hidden");
    return;
  }
  if (!(await requireRole(user, "owner"))) {
    stopWatchingPendingApprovals();
    return;
  }
  authView.classList.add("hidden");
  appView.classList.remove("hidden");
  await bootstrapDashboard();
  watchOpenOrders();
  watchPendingApprovals();
  watchCancellationRequests();
  // Fire-and-forget: each catches its own errors and must not block the board.
  checkReconciliationHealth();
  checkRealtimeCorrections();
});

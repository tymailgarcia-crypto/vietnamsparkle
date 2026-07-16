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
  computeDepositBreakdown,
  escapeHtml,
  formatCurrency,
  localDateKey,
  mergeThresholds,
  normalizePhone,
  paymentStatusFor,
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
  uploadPaymentProof,
  validateProofFile
} from "./storageUploads.js";
import { mapsApiKey } from "./firebaseWebConfig.js";

const mergeCustomersFn = httpsCallable(functions, "mergeCustomers");

function initialSelectedDate() {
  const params = new URLSearchParams(location.search);
  const dateParam = params.get("date");
  if (dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
    return dateParam;
  }
  return todayKey();
}

const state = {
  products: [],
  drivers: [],
  orders: [],
  orderItems: [],
  payments: [],
  depositEvents: [],
  thresholds: { ...THRESHOLD_DEFAULTS },
  selectedDate: initialSelectedDate(),
  statusFilter: "all"
};

const STATUS_FILTERS = [
  { key: "all", label: "All", match: () => true },
  { key: "to_approve", label: "To approve", match: (o) => o.status === "pending_approval" },
  { key: "to_assign", label: "To assign", match: (o) => o.status === "new" },
  { key: "to_send", label: "To send", match: (o) => o.status === "assigned" },
  { key: "en_route", label: "En route", match: (o) => o.status === "out_for_delivery" },
  { key: "done", label: "Done", match: (o) => o.status === "delivered" || o.status === "cancelled" }
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

  document.getElementById("hero-stats").innerHTML = `
    <div class="card"><span class="muted">Today orders</span><strong>${todayOrders.length}</strong></div>
    <div class="card money-card">
      <div class="money-row"><span>Cash today</span><strong>${formatCurrency(cash)}</strong></div>
      <div class="money-row"><span>Transfer today</span><strong>${formatCurrency(transfer)}</strong></div>
      <div class="money-row"><span>Unpaid</span><strong>${unpaid}</strong></div>
    </div>
  `;
}

function productLinesForOrder(orderId) {
  return state.orderItems.filter((item) => item.orderId === orderId);
}

function driverName(driverId) {
  const driver = state.drivers.find((row) => row.id === driverId);
  return driver ? driver.driverName : "Unassigned";
}

// Stamp `order.authUid` onto the phone-keyed customer doc ONLY when that doc
// is brand new, or already belongs to this same uid.
//
// The tempting third case — "doc exists but is unclaimed (authUid == null), so
// linking is harmless" — is an account takeover. Nothing proves the person who
// typed a phone number into the public order form owns that number. An
// attacker signs in with any account, orders quoting a stranger's phone, and
// the owner's routine approve stamps the attacker's uid onto the stranger's
// record — handing over their profile and, via the orders claim rule, their
// entire history. Firestore rules cannot catch this: the owner performs the
// write, and owners may write anything.
//
// A real customer whose record predates their sign-in still links up, through
// the paths that actually prove ownership: verified-email match in
// accountApp's findUnclaimedByEmail, or an explicit owner merge.
export function canLinkAuthUidToCustomer(order, existingData) {
  return !!order.authUid
    && (!existingData || existingData.authUid === order.authUid);
}

async function upsertCustomerFromOrder(order) {
  const customerId = buildCustomerId(order.phone);
  if (!customerId) {
    return { customerId: "", createdNew: false, linkedAuthUid: false };
  }
  // `email` is safe to merge unconditionally: if the order was signed-in,
  // propagating it enables future auto-link-by-email on that same browser.
  const ref = doc(db, "customers", customerId);
  const existing = await getDoc(ref);
  const existingData = existing.exists() ? existing.data() : null;
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
  if (order.email) payload.email = order.email;
  if (canLinkAuthUid) payload.authUid = order.authUid;
  await setDoc(ref, payload, { merge: true });
  return { customerId, createdNew: !existingData, linkedAuthUid: canLinkAuthUid };
}

// Fold a self-serve `CUS-<uid>` stub into the canonical phone-keyed doc.
//
// The stub is unavoidable: at Google/magic-link sign-in there is no phone to
// key on (user.phoneNumber is null for those providers), and the customers
// create rule deliberately forbids a customer from minting a phone-keyed doc
// — that would be id squatting. So accountApp mints CUS-<uid>, and the first
// approved order is the earliest moment both halves of the identity are known.
//
// Gated on the phone doc having been created FRESH for this same uid. Never
// fold into a pre-existing doc: mergeCustomers copies the source authUid onto
// a target that lacks one, which would re-open the very takeover that
// canLinkAuthUidToCustomer above closes.
async function foldSelfServeStubInto(customerId, authUid) {
  const stubId = `CUS-${authUid}`;
  if (!authUid || stubId === customerId) return;
  try {
    const stubSnap = await getDoc(doc(db, "customers", stubId));
    if (!stubSnap.exists()) return;
    const stub = stubSnap.data() || {};
    if (stub.archived === true) return;
    if (stub.authUid !== authUid) return;
    await mergeCustomersFn({ fromId: stubId, toId: customerId });
  } catch (error) {
    // Best-effort: approval must still succeed. The owner can merge by hand
    // from the customer page if this ever fails.
    console.warn(`Could not fold stub ${stubId} into ${customerId}:`, error && error.message ? error.message : error);
  }
}

async function ensureDepositCharge(order) {
  // Skip if this order has ANY prior charged event — either from before this
  // fix (a single "mixed" event) or from a previous re-approval. Prevents
  // double-charging on re-clicks; legacy "mixed" data stays until manually
  // reconciled.
  const alreadyCharged = state.depositEvents.some(
    (event) => event.orderId === order.id && event.eventType === "charged"
  );
  if (alreadyCharged) return;

  const items = productLinesForOrder(order.id);
  const productsById = Object.fromEntries(state.products.map((p) => [p.id, p]));
  const breakdown = computeDepositBreakdown(items, productsById);
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
      eventDate: state.selectedDate,
      linkedDocumentId: null,
      notes: "Auto-charged on approval"
    });
  });
  await batch.commit();
}

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

// Lazy Maps SDK loader for geocode-on-approval. Same pattern as mapApp.js /
// settingsApp.js — kept local rather than extracted because the surface is
// tiny and the route planner is the only other future consumer.
const mapsSdkState = { ready: false, geocoder: null, loadPromise: null };

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
  const { customerId, createdNew, linkedAuthUid } = await upsertCustomerFromOrder(order);
  const deliveryLocation = await resolveDeliveryLocation(order, customerId);
  await updateDoc(doc(db, "orders", orderId), {
    status: "new",
    customerId: customerId || null,
    deliveryLocation: deliveryLocation,
    updatedAt: new Date().toISOString()
  });
  await ensureDepositCharge({ ...order, customerId });
  if (customerId && createdNew && linkedAuthUid) {
    await foldSelfServeStubInto(customerId, order.authUid);
  }
}

// Reverse every charged deposit event on this order that hasn't already been
// refunded/credited/forfeited. Emits one "refunded" event per still-outstanding
// container type, matching qty and amount, so the deposits page + customer
// balance zero out for this cancelled order.
async function emitDepositReversalsFor(orderId, order) {
  // Re-read from Firestore so we cover orders outside the currently-loaded
  // date range (cancellations can be triggered from any board view).
  const snap = await getDocs(query(collection(db, "depositEvents"), where("orderId", "==", orderId)));
  const netByType = {};
  snap.docs.forEach((docSnap) => {
    const e = docSnap.data();
    const type = e.containerType || "other";
    const qty = Number(e.qty || 0);
    const amt = Number(e.amount || 0);
    if (!netByType[type]) netByType[type] = { qty: 0, amount: 0 };
    if (e.eventType === "charged") {
      netByType[type].qty += qty;
      netByType[type].amount += amt;
    } else if (["refunded", "credited", "forfeited"].includes(e.eventType)) {
      netByType[type].qty -= qty;
      netByType[type].amount -= amt;
    }
  });
  const batch = writeBatch(db);
  let wrote = 0;
  const nowStr = todayKey();
  Object.entries(netByType).forEach(([type, net]) => {
    if (net.qty <= 0 && net.amount <= 0.01) return;
    batch.set(doc(db, "depositEvents", buildDepositEventId()), {
      orderId,
      customerId: order?.customerId || null,
      authUid: order?.authUid || null,
      containerType: type,
      qty: Math.max(0, net.qty),
      amount: Math.max(0, net.amount),
      eventType: "refunded",
      eventDate: nowStr,
      linkedDocumentId: null,
      notes: "Order cancelled — deposit reversed"
    });
    wrote += 1;
  });
  if (wrote) await batch.commit();
}

async function cancelOrder(orderId, reason) {
  const trimmed = String(reason || "").trim();
  const order = state.orders.find((row) => row.id === orderId);
  await updateDoc(doc(db, "orders", orderId), {
    status: "cancelled",
    cancellationReason: trimmed || null,
    cancelledAt: new Date().toISOString(),
    cancelledBy: "owner",
    updatedAt: new Date().toISOString()
  });
  await emitDepositReversalsFor(orderId, order);
}

async function approveCancellationRequest(orderId) {
  const order = state.orders.find((row) => row.id === orderId);
  if (!order) return;
  await updateDoc(doc(db, "orders", orderId), {
    status: "cancelled",
    cancellationReason: order.cancellationRequestReason || null,
    cancelledAt: new Date().toISOString(),
    cancelledBy: "owner_via_request",
    cancellationRequested: null,
    cancellationRequestReason: null,
    cancellationRequestedAt: null,
    updatedAt: new Date().toISOString()
  });
  await emitDepositReversalsFor(orderId, order);
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

function renderStateActions(order) {
  const editButton = `<button class="ghost" data-edit="${order.id}">Edit details</button>`;
  const invoiceButton = `<button class="ghost" data-invoice="${order.id}">Invoice</button>`;
  switch (order.status) {
    case "pending_approval":
      return `
        <button class="primary" data-approve="${order.id}">Approve</button>
        ${editButton}
        ${invoiceButton}
        <button class="ghost" data-cancel="${order.id}">Cancel order</button>
      `;
    case "new":
      return `
        ${renderDriverSelect(order)}
        ${editButton}
        ${invoiceButton}
        <button class="ghost" data-cancel="${order.id}">Cancel order</button>
      `;
    case "assigned":
      return `
        ${renderDriverSelect(order)}
        <button class="primary" data-status="${order.id}" data-next="out_for_delivery">Send out for delivery</button>
        ${editButton}
        ${invoiceButton}
        <button class="ghost" data-cancel="${order.id}">Cancel order</button>
      `;
    case "out_for_delivery":
      return `
        <button class="primary" data-collect="${order.id}">Mark delivered &amp; record payment</button>
        ${invoiceButton}
        <button class="ghost" data-cancel="${order.id}">Cancel order</button>
      `;
    case "delivered":
      return `<span class="muted">Delivered</span> ${invoiceButton}`;
    case "cancelled":
      return `<span class="muted">Cancelled${order.cancellationReason ? ` — ${escapeHtml(order.cancellationReason)}` : ""}</span>`;
    default:
      return `<span class="muted">Unknown status: ${escapeHtml(order.status)}</span>`;
  }
}

function phoneDialHref(phone) {
  const digits = String(phone || "").replace(/[^0-9+]/g, "");
  return digits ? `tel:${digits}` : "";
}

function mapDirectionsHref(address) {
  const trimmed = String(address || "").trim();
  if (!trimmed) return "";
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(trimmed)}`;
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
        <a href="${escapeHtml(p.proofUrl)}" target="_blank" rel="noopener" title="Payment proof — ${escapeHtml(formatCurrency(p.amount))}">
          <img src="${escapeHtml(p.proofUrl)}" alt="Payment proof for ${escapeHtml(order.id)}" loading="lazy">
        </a>
      `).join("")}
    </div>
  `;
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
  const driver = driverName(order.assignedDriverId);
  const orderIdLink = `<a class="muted" style="font-family:monospace;font-size:11px" href="./admin.html?date=${encodeURIComponent(order.deliveryDate || "")}">${escapeHtml(order.id)}</a>`;
  return `
    <div class="compact-order">
      <div class="top">
        <div class="who">${nameCell}</div>
        <span class="badge status-${escapeHtml(order.status)}">${escapeHtml(order.status)}</span>
      </div>
      <div class="where">${orderIdLink}</div>
      ${address ? `<div class="where">${escapeHtml(address)}</div>` : ""}
      <div class="where">${escapeHtml(driver)} · ${formatCurrency(order.subtotal + order.depositTotal)}</div>
      ${renderProofThumbs(order)}
      ${cancellationBanner}
      <div class="compact-actions">
        ${cancellationActions}
        ${renderStateActions(order)}
      </div>
    </div>
  `;
}

function renderStatusFilter(todayOrders) {
  const bar = document.getElementById("order-status-filter");
  if (!bar) return;
  if (!STATUS_FILTERS.some((f) => f.key === state.statusFilter)) {
    state.statusFilter = "all";
  }
  bar.innerHTML = STATUS_FILTERS.map((f) => {
    const count = todayOrders.filter(f.match).length;
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

function renderOrderBoard() {
  const board = document.getElementById("today-board");
  const todayOrders = state.orders
    .filter((order) => order.deliveryDate === state.selectedDate)
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));

  renderStatusFilter(todayOrders);

  if (!todayOrders.length) {
    board.innerHTML = `<div class="card"><strong>No orders for ${escapeHtml(state.selectedDate)}</strong><div class="muted">Website orders land here. Use the Customers page to look up a customer and create an order from their profile.</div></div>`;
    return;
  }

  const activeFilter = STATUS_FILTERS.find((f) => f.key === state.statusFilter) || STATUS_FILTERS[0];
  const visibleOrders = todayOrders.filter(activeFilter.match);

  if (!visibleOrders.length) {
    board.innerHTML = `<div class="card"><strong>No orders in “${escapeHtml(activeFilter.label)}”</strong><div class="muted">Try a different filter above.</div></div>`;
    return;
  }

  board.innerHTML = visibleOrders.map(renderOrderCompact).join("");

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

  await withSubmitLock(event, async () => {
    try {
      if (statusNode) statusNode.textContent = "Saving...";

      const order = state.orders.find((row) => row.id === orderId);
      const amountPaid = Number(order?.amountPaid || 0);
      const totals = computeEditTotals();
      const balanceDue = totals.subtotal + totals.depositTotal - amountPaid;

      const newAddress = document.getElementById("edit-address").value.trim();
      const oldAddress = String(order?.address || "").trim();
      const addressChanged = newAddress !== oldAddress;
      const deliveryLocationPatch = addressChanged
        ? { deliveryLocation: await resolveDeliveryLocation({ ...order, address: newAddress }, order?.customerId) }
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
          } else if (["refunded", "credited", "forfeited"].includes(e.eventType)) {
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
  heldContainers: {}
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
    } else if (event.eventType === "refunded" || event.eventType === "credited" || event.eventType === "forfeited") {
      byType[type].qty -= qty;
      byType[type].amount -= amount;
    }
  });
  const result = {};
  Object.entries(byType).forEach(([type, data]) => {
    if (data.qty > 0) {
      result[type] = {
        qty: data.qty,
        outstandingAmount: data.amount,
        depositPerUnit: data.totalChargedQty > 0 ? data.totalChargedAmount / data.totalChargedQty : 0
      };
    }
  });
  return result;
}

function renderHeldContainers(held) {
  const container = document.getElementById("delivery-containers-list");
  const help = document.getElementById("delivery-containers-help");
  const types = Object.keys(held);
  if (!types.length) {
    if (help) help.textContent = "This customer has no containers on file. Any return here would be a fresh entry — use loss report if a container needs writing off.";
    container.innerHTML = "";
    return;
  }
  if (help) help.textContent = "Enter qty returned this trip and pick how to handle the deposit. Leave qty 0 for containers that stayed with the customer.";
  container.innerHTML = types.map((type) => {
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
              <option value="credit">Credit next order</option>
              <option value="refund">Refund cash now</option>
              <option value="keep">Owner will decide later</option>
            </select>
          </div>
        </div>
      </div>
    `;
  }).join("");
}

function populateLossTypeSelect() {
  const select = document.getElementById("delivery-loss-type");
  if (!select) return;
  const heldTypes = Object.keys(deliveryDialogState.heldContainers);
  const productTypes = state.products.map((p) => p.containerType).filter(Boolean);
  const allTypes = Array.from(new Set([...heldTypes, ...productTypes]));
  select.innerHTML = allTypes.map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(humanizeContainerType(t))}</option>`).join("");
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
    if (amount < 0) {
      if (statusNode) {
        statusNode.textContent = "Amount cannot be negative.";
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

  const containerReturns = [];
  document.querySelectorAll("[data-return-qty]").forEach((input) => {
    const type = input.dataset.returnQty;
    const returnedQty = Number(input.value || 0);
    if (returnedQty <= 0) return;
    const handlingSelect = document.querySelector(`[data-return-handling="${type}"]`);
    const handling = handlingSelect ? handlingSelect.value : "keep";
    if (handling === "keep") return;
    const held = deliveryDialogState.heldContainers[type];
    const depositPerUnit = held ? held.depositPerUnit : 0;
    containerReturns.push({ type, returnedQty, handling, depositPerUnit });
  });

  const lossCheckbox = document.getElementById("delivery-loss-checkbox");
  let lossReport = null;
  if (lossCheckbox && lossCheckbox.checked) {
    const lossType = document.getElementById("delivery-loss-type").value;
    const lossQty = Number(document.getElementById("delivery-loss-qty").value || 0);
    const lossNote = document.getElementById("delivery-loss-note").value.trim() || null;
    if (lossQty > 0 && lossType) {
      const held = deliveryDialogState.heldContainers[lossType];
      const depositPerUnit = held ? held.depositPerUnit : 0;
      lossReport = { lossType, lossQty, depositPerUnit, lossNote };
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
      // The transaction re-reads the order every retry, so newAmountPaid is
      // always computed against the freshest server value — a concurrent tab
      // recording a payment won't be silently overwritten.
      await runTransaction(db, async (tx) => {
        const orderRef = doc(db, "orders", orderId);
        const orderSnap = await tx.get(orderRef);
        if (!orderSnap.exists()) throw new Error("Order no longer exists.");
        const order = orderSnap.data();
        const receivedBy = auth.currentUser ? auth.currentUser.email : "owner";

        if (paymentSnapshot.collected) {
          const newAmountPaid = Number(order.amountPaid || 0) + paymentSnapshot.amount;
          const total = Number(order.subtotal || 0) + Number(order.depositTotal || 0);
          const newBalance = total - newAmountPaid;
          tx.set(doc(db, "payments", paymentId), {
            orderId,
            customerId: order.customerId || null,
            authUid: order.authUid || null,
            paymentDate: today,
            method: paymentSnapshot.method,
            amount: paymentSnapshot.amount,
            reference: paymentSnapshot.reference,
            receivedBy,
            proofDocumentId,
            proofUrl,
            notes: "Collected at delivery",
            deferred: false,
            createdAt: now
          });
          tx.update(orderRef, {
            status: "delivered",
            deliveryPaymentEventId: paymentId,
            amountPaid: newAmountPaid,
            balanceDue: newBalance,
            paymentStatus: paymentStatusFor(newAmountPaid, newBalance),
            updatedAt: now
          });
        } else {
          tx.set(doc(db, "payments", paymentId), {
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
          tx.update(orderRef, {
            status: "delivered",
            deliveryPaymentEventId: paymentId,
            followUpBy: paymentSnapshot.followUpBy,
            updatedAt: now
          });
        }

        containerReturns.forEach((r) => {
          const amount = r.returnedQty * r.depositPerUnit;
          const eventType = r.handling === "refund" ? "refunded" : "credited";
          tx.set(doc(db, "depositEvents", buildDepositEventId()), {
            orderId,
            customerId: order.customerId || null,
            authUid: order.authUid || null,
            containerType: r.type,
            qty: r.returnedQty,
            amount,
            eventType,
            eventDate: today,
            linkedDocumentId: null,
            notes: `Returned at delivery — ${r.handling === "refund" ? "refunded cash" : "credited to next order"}`,
            createdAt: now
          });
        });

        if (lossReport) {
          const amount = lossReport.lossQty * lossReport.depositPerUnit;
          tx.set(doc(db, "depositEvents", buildDepositEventId()), {
            orderId,
            customerId: order.customerId || null,
            authUid: order.authUid || null,
            containerType: lossReport.lossType,
            qty: lossReport.lossQty,
            amount,
            eventType: "forfeited",
            eventDate: today,
            linkedDocumentId: null,
            notes: lossReport.lossNote || "Reported lost or destroyed at delivery",
            createdAt: now
          });
        }
      });
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
  currentDoc: null
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
  dialog.showModal();

  try {
    const [settings, itemsSnap] = await Promise.all([
      loadBusinessSettings(),
      getDocs(query(collection(db, "orderItems"), where("orderId", "==", order.id)))
    ]);
    const items = itemsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const ctx = invoiceContext({ order, items, settings });
    slot.innerHTML = renderInvoiceHtml(ctx);
    await attachQrToPreview(ctx, slot);

    invoiceState.currentCtx = ctx;
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

async function emailInvoice() {
  const ctx = invoiceState.currentCtx;
  const statusNode = document.getElementById("invoice-status");
  if (!ctx) return;
  if (!buildEmailShare(ctx)) {
    if (statusNode) statusNode.textContent = "No customer email on file.";
    return;
  }
  await withSubmitLock(document.getElementById("invoice-email-button"), async () => {
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
  const statusNode = document.getElementById("invoice-status");
  if (!ctx) return;
  if (!buildWhatsAppShare(ctx)) {
    if (statusNode) statusNode.textContent = "No customer phone on file.";
    return;
  }
  // The tab has to be opened synchronously inside the click handler — opening
  // it after the upload await makes it a popup and the browser blocks it.
  const tab = window.open("", "_blank", "noopener");
  await withSubmitLock(document.getElementById("invoice-whatsapp-button"), async () => {
    try {
      if (statusNode) statusNode.textContent = "Uploading PDF…";
      const { downloadUrl } = await ensureInvoicePdfUploaded(ctx);
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

async function refreshDashboard() {
  const date = state.selectedDate;
  setStatus("Loading Firestore data...");

  state.orders = await loadCollection("orders", [where("deliveryDate", "==", date)]);
  const dayPayments = await loadCollection("payments", [where("paymentDate", "==", date)]);

  const orderIds = state.orders.map((order) => order.id);
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

  renderHero();
  renderOrderBoard();
  setStatus("");
}

async function bootstrapDashboard() {
  state.products = await loadCollection("products", [where("active", "==", true)]);
  state.drivers = await loadCollection("drivers");
  const settings = await loadBusinessSettings();
  state.thresholds = mergeThresholds(settings.thresholds);
  document.getElementById("working-date").value = state.selectedDate;
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

document.getElementById("working-date").addEventListener("change", async (event) => {
  state.selectedDate = event.target.value || todayKey();
  await refreshDashboard();
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
document.querySelectorAll('input[name="collected"]').forEach((radio) => {
  radio.addEventListener("change", toggleDeliveryPaymentFields);
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
    authView.classList.remove("hidden");
    appView.classList.add("hidden");
    return;
  }
  if (!(await requireRole(user, "owner"))) return;
  authView.classList.add("hidden");
  appView.classList.remove("hidden");
  await bootstrapDashboard();
});

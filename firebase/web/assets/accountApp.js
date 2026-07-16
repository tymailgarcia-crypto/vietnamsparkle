import {
  auth,
  collection,
  db,
  doc,
  getDoc,
  getDocs,
  GoogleAuthProvider,
  isSignInWithEmailLink,
  limit,
  onAuthStateChanged,
  orderBy,
  query,
  sendSignInLinkToEmail,
  serverTimestamp,
  setDoc,
  signInWithEmailLink,
  signInWithGoogleForEnvironment,
  signInWithPopup,
  signOut,
  startAfter,
  updateDoc,
  where,
  writeBatch
} from "./firebaseClient.js";
import { buildCustomerId, formatCurrency, mergeThresholds, normalizePhoneE164VN, productImageUrl, THRESHOLD_DEFAULTS, withSubmitLock } from "./shared.js";
import { mapsApiKey } from "./firebaseWebConfig.js";

let accountMapsPromise = null;
let pendingAddressConfirmation = null;
let accountAddressMap = null;
let accountAddressMarker = null;
let resolveMagicLinkEmail = null;
// The saved address text currently being edited, or null when the form is in
// "add" mode. The form is deliberately the only address editor on the page, so
// both paths share one geocode-and-confirm flow.
let editingAddressOriginal = null;

function loadAccountMaps() {
  if (window.google?.maps) return Promise.resolve(window.google.maps);
  if (accountMapsPromise) return accountMapsPromise;
  if (!mapsApiKey) return Promise.reject(new Error("Google Maps is not configured."));
  accountMapsPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(mapsApiKey)}&v=weekly`;
    script.async = true;
    script.onload = () => resolve(window.google.maps);
    script.onerror = () => reject(new Error("Google Maps could not be loaded."));
    document.head.appendChild(script);
  });
  return accountMapsPromise;
}

function resetPendingAddressConfirmation() {
  pendingAddressConfirmation = null;
  el("account-address-map-wrap")?.setAttribute("hidden", "");
  updateAddressFormMode();
}

// Single place that decides what the address form looks like, because the
// label depends on two independent things: add-vs-edit, and whether a pin has
// been confirmed yet.
function updateAddressFormMode() {
  const editing = Boolean(editingAddressOriginal);
  const button = el("new-address-submit");
  if (button) {
    button.textContent = pendingAddressConfirmation
      ? "Save confirmed address"
      : (editing ? "Find new pin on map" : "Find on map");
  }
  const input = el("new-address-input");
  if (input) {
    input.placeholder = editing ? "Update this delivery address" : "Add another delivery address";
  }
  el("cancel-address-edit")?.classList.toggle("hidden", !editing);
}

function beginEditAddress(text) {
  if (!text) return;
  editingAddressOriginal = text;
  resetPendingAddressConfirmation();
  const input = el("new-address-input");
  if (input) {
    input.value = text;
    input.focus();
    input.scrollIntoView({ block: "center", behavior: "smooth" });
  }
  updateAddressFormMode();
  setStatus(el("addresses-status"), "Edit the address, then find it on the map to confirm the pin.");
}

function cancelEditAddress() {
  editingAddressOriginal = null;
  const input = el("new-address-input");
  if (input) input.value = "";
  resetPendingAddressConfirmation();
  setStatus(el("addresses-status"), "");
}

function normalizeDeliveryAddress(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function cleanAddressLocation(address, location) {
  const text = String(address || "").trim();
  const lat = Number(location?.lat);
  const lng = Number(location?.lng);
  if (!text || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return {
    address: text,
    lat,
    lng,
    formattedAddress: String(location?.formattedAddress || "").trim() || null,
    geocodedAt: location?.geocodedAt || new Date().toISOString()
  };
}

function savedAddressLocations(customer = state.customer) {
  const byAddress = new Map();
  (Array.isArray(customer?.addressLocations) ? customer.addressLocations : []).forEach((entry) => {
    const clean = cleanAddressLocation(entry?.address, entry);
    if (clean) byAddress.set(normalizeDeliveryAddress(clean.address), clean);
  });
  // Older records stored only the primary pin in `location`.
  const primary = String(customer?.address || "").trim();
  const legacyPrimary = cleanAddressLocation(primary, customer?.location);
  if (legacyPrimary && !byAddress.has(normalizeDeliveryAddress(primary))) {
    byAddress.set(normalizeDeliveryAddress(primary), legacyPrimary);
  }
  return Array.from(byAddress.values());
}

function savedLocationForAddress(address, entries = savedAddressLocations()) {
  const key = normalizeDeliveryAddress(address);
  return entries.find((entry) => normalizeDeliveryAddress(entry.address) === key) || null;
}

const CONTAINER_LABELS = {
  glass_crate: "Glass crates",
  "18_9l_jug": "18.9 L jugs",
  "19l_jug": "19 L jugs",
  "20l_jug": "20 L jugs",
  mixed: "Mixed containers"
};

function humanizeContainerType(key) {
  if (!key) return "Other containers";
  return CONTAINER_LABELS[key] || key.replace(/_/g, " ");
}

const ORDERS_PAGE_SIZE = 10;

const state = {
  user: null,
  customer: null,
  customerRef: null,
  settings: null,
  orders: [],
  ordersCursor: null,
  ordersExhausted: false,
  activeTab: "reorder",
  // Every orderItem the signed-in customer owns, grouped by orderId. Loaded
  // once per session via authUid — legacy items imported from Sheets that
  // predate the authUid backfill won't appear here, so cards for those orders
  // just render without the thumbnail strip.
  itemsByOrderId: {}
};

async function loadBusinessSettings() {
  try {
    const snap = await getDoc(doc(db, "settings", "business"));
    state.settings = snap.exists() ? snap.data() : {};
  } catch (_) {
    state.settings = {};
  }
}

function el(id) {
  return document.getElementById(id);
}

function setStatus(node, message, isError = false) {
  if (!node) return;
  node.textContent = message || "";
  node.style.color = isError ? "var(--danger, #b3261e)" : "var(--muted)";
}

function customerDocId(uid) {
  return `CUS-${uid}`;
}

async function findByAuthUid(uid) {
  const snap = await getDocs(query(collection(db, "customers"), where("authUid", "==", uid)));
  if (snap.empty) return null;
  const docSnap = snap.docs[0];
  return { ref: doc(db, "customers", docSnap.id), data: docSnap.data(), id: docSnap.id };
}

async function findUnclaimedByEmail(email) {
  if (!email) return null;
  // Both filters are required for Firestore rules to accept the query — the
  // `customers` rule's unclaimed-email branch demands authUid == null, and a
  // list query only clears the rule if the query itself constrains authUid.
  const snap = await getDocs(query(
    collection(db, "customers"),
    where("email", "==", email),
    where("authUid", "==", null)
  ));
  if (snap.empty) return null;
  const docSnap = snap.docs[0];
  return { ref: doc(db, "customers", docSnap.id), data: docSnap.data(), id: docSnap.id };
}

// Direct-by-id lookup for the phone-based canonical doc. Firestore rules only
// let a customer read an unclaimed doc when its email matches their token, so
// this succeeds silently only when the owner set the same email on the
// phone-keyed doc. The path exists so a future phone-auth sign-in
// (`user.phoneNumber`) and the profile-save phone-change flow can collapse
// a `CUS-<uid>` stub into the canonical phone-based doc.
async function findUnclaimedByPhone(phone) {
  const customerId = buildCustomerId(phone);
  if (!customerId) return null;
  try {
    const snap = await getDoc(doc(db, "customers", customerId));
    if (!snap.exists()) return null;
    const data = snap.data();
    if (data.authUid) return null;
    return { ref: doc(db, "customers", customerId), data, id: customerId };
  } catch (_) {
    return null;
  }
}

async function linkCustomerToUser(target, user) {
  await updateDoc(target.ref, {
    authUid: user.uid,
    updatedAt: new Date().toISOString()
  });
  await backfillOrdersForCustomer(target.id, user.uid);
  return {
    ref: target.ref,
    id: target.id,
    data: { ...target.data, authUid: user.uid }
  };
}

async function backfillOrdersForCustomer(customerId, uid) {
  const snap = await getDocs(query(collection(db, "orders"), where("customerId", "==", customerId)));
  const unclaimed = snap.docs.filter((d) => !d.data().authUid);
  if (!unclaimed.length) return;
  const batch = writeBatch(db);
  const now = new Date().toISOString();
  unclaimed.forEach((docSnap) => {
    batch.update(doc(db, "orders", docSnap.id), { authUid: uid, updatedAt: now });
  });
  await batch.commit();
}

async function createFreshCustomer(user) {
  const ref = doc(db, "customers", customerDocId(user.uid));
  const payload = {
    name: user.displayName || "",
    billingName: null,
    email: user.email || null,
    phone: "",
    secondaryPhone: null,
    taxId: null,
    address: "",
    area: null,
    addressHistory: null,
    notes: null,
    lastSourceChannel: "self-serve",
    lastOrderAt: null,
    orderCount: 0,
    authUid: user.uid,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  };
  await setDoc(ref, payload, { merge: true });
  return { ref, data: payload, id: customerDocId(user.uid) };
}

async function findOrAutoLinkCustomer(user) {
  const byUid = await findByAuthUid(user.uid).catch((e) => {
    throw new Error(`findByAuthUid: ${e.message || e}`);
  });
  if (byUid) return byUid;
  const byEmail = await findUnclaimedByEmail(user.email).catch((e) => {
    throw new Error(`findUnclaimedByEmail: ${e.message || e}`);
  });
  if (byEmail) return await linkCustomerToUser(byEmail, user);
  // Phone-auth sign-ins carry `user.phoneNumber`; email/Google sign-ins don't.
  // When present, try the canonical phone-keyed doc so an owner-added or
  // public-order-derived doc collapses into the account instead of minting a
  // duplicate `CUS-<uid>` stub.
  const byPhone = await findUnclaimedByPhone(user.phoneNumber);
  if (byPhone) return await linkCustomerToUser(byPhone, user);
  return null;
}

async function loadFirstOrdersPage(uid) {
  const snap = await getDocs(
    query(
      collection(db, "orders"),
      where("authUid", "==", uid),
      orderBy("createdAt", "desc"),
      limit(ORDERS_PAGE_SIZE)
    )
  );
  state.orders = snap.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));
  state.ordersCursor = snap.docs.length ? snap.docs[snap.docs.length - 1] : null;
  state.ordersExhausted = snap.docs.length < ORDERS_PAGE_SIZE;
  return state.orders;
}

async function loadMoreOrders() {
  if (!state.user || !state.ordersCursor || state.ordersExhausted) return;
  const snap = await getDocs(
    query(
      collection(db, "orders"),
      where("authUid", "==", state.user.uid),
      orderBy("createdAt", "desc"),
      startAfter(state.ordersCursor),
      limit(ORDERS_PAGE_SIZE)
    )
  );
  const next = snap.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));
  state.orders = state.orders.concat(next);
  state.ordersCursor = snap.docs.length ? snap.docs[snap.docs.length - 1] : state.ordersCursor;
  state.ordersExhausted = snap.docs.length < ORDERS_PAGE_SIZE;
  renderOrders(state.orders);
  renderReorderList(state.orders);
  updateLoadMoreButtons();
}

function updateLoadMoreButtons() {
  const historyRow = el("history-load-more-row");
  const reorderRow = el("reorder-load-more-row");
  const show = !state.ordersExhausted;
  if (historyRow) historyRow.style.display = show ? "" : "none";
  if (reorderRow) reorderRow.style.display = show ? "" : "none";
}

async function loadOrderItemsForUid(uid) {
  const snap = await getDocs(
    query(collection(db, "orderItems"), where("authUid", "==", uid))
  );
  const byOrderId = {};
  snap.docs.forEach((docSnap) => {
    const item = { id: docSnap.id, ...docSnap.data() };
    if (!item.orderId) return;
    if (!byOrderId[item.orderId]) byOrderId[item.orderId] = [];
    byOrderId[item.orderId].push(item);
  });
  return byOrderId;
}

async function loadDepositEventsForUid(uid) {
  const snap = await getDocs(
    query(collection(db, "depositEvents"), where("authUid", "==", uid))
  );
  return snap.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));
}

async function loadReturnsForUid(uid) {
  const snap = await getDocs(
    query(collection(db, "returns"), where("authUid", "==", uid))
  );
  return snap.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));
}

function summarizeContainers(depositEvents, returns) {
  const byType = {};
  const bump = (type, deltaQty, deltaAmount, chargedDate) => {
    const key = type || "other";
    if (!byType[key]) byType[key] = { qty: 0, deposit: 0, oldestChargedDate: null };
    byType[key].qty += deltaQty;
    byType[key].deposit += deltaAmount;
    if (chargedDate && (!byType[key].oldestChargedDate || chargedDate < byType[key].oldestChargedDate)) {
      byType[key].oldestChargedDate = chargedDate;
    }
  };
  depositEvents.forEach((event) => {
    const qty = Number(event.qty || 0);
    const amount = Number(event.amount || 0);
    const eventDate = event.eventDate || null;
    if (event.eventType === "charged") {
      bump(event.containerType, qty, amount, eventDate);
    } else if (event.eventType === "refunded" || event.eventType === "credited") {
      bump(event.containerType, 0, -amount, null);
    }
  });
  returns.forEach((ret) => {
    const qty = Number(ret.qty || 0);
    bump(ret.containerType, -qty, 0, null);
  });
  return Object.entries(byType)
    .map(([type, totals]) => ({
      type,
      qty: totals.qty,
      deposit: totals.deposit,
      oldestChargedDate: totals.oldestChargedDate
    }))
    .filter((row) => row.qty > 0 || row.deposit > 0);
}

const CONTAINER_EXPLANATIONS = {
  glass_crate: "Glass bottle crate — reusable, returned on your next delivery.",
  "18_9l_jug": "18.9-litre reusable jug — swap-and-return on delivery.",
  "19l_jug": "19-litre reusable jug — swap-and-return on delivery.",
  "20l_jug": "20-litre reusable jug — swap-and-return on delivery.",
  mixed: "Mixed containers — the driver will confirm the exact type on the next visit."
};

function daysSince(dateString) {
  if (!dateString) return null;
  const then = new Date(dateString);
  if (Number.isNaN(then.getTime())) return null;
  const ms = Date.now() - then.getTime();
  return Math.max(0, Math.floor(ms / 86400000));
}

function renderContainerSummary(rows) {
  const container = el("container-summary");
  if (!container) return;
  if (!rows.length) {
    container.innerHTML = `<div class="card"><strong>Details coming soon</strong><div class="muted top-gap">Once you receive your first delivery, container details show up here.</div></div>`;
    return;
  }
  container.innerHTML = rows.map((row) => {
    const label = humanizeContainerType(row.type);
    const explanation = CONTAINER_EXPLANATIONS[row.type] || "";
    const days = daysSince(row.oldestChargedDate);
    const forfeitDays = mergeThresholds(state.settings?.thresholds).depositForfeitDays;
    const overForfeit = days != null && days >= forfeitDays;
    const dayLine = days == null
      ? ""
      : `<div class="${overForfeit ? "" : "muted"}" style="${overForfeit ? "color:rgb(122,32,22);font-weight:600" : ""}">${days} day${days === 1 ? "" : "s"} held${overForfeit ? " · consider returning soon" : ""}</div>`;
    const sinceLine = row.oldestChargedDate
      ? `<div class="muted">Oldest charged: ${escapeHtml(row.oldestChargedDate)}</div>`
      : "";
    return `
      <div class="card">
        <div style="display:flex;justify-content:space-between;gap:10px;align-items:baseline">
          <strong>${escapeHtml(label)}</strong>
          <span>${row.qty} on hand</span>
        </div>
        <div class="muted top-gap">${formatCurrency(row.deposit)} deposit held</div>
        ${sinceLine}
        ${dayLine}
        ${explanation ? `<div class="muted top-gap" style="font-size:12px">${escapeHtml(explanation)}</div>` : ""}
      </div>
    `;
  }).join("");
}

function shortProductLabel(name) {
  const n = String(name || "").trim();
  if (!n) return "?";
  const initials = n.split(/\s+/).slice(0, 3).map((w) => w[0]).filter(Boolean).join("");
  return initials.toUpperCase() || n.slice(0, 3).toUpperCase();
}

function renderOrderThumbs(orderId) {
  const items = state.itemsByOrderId[orderId] || [];
  if (!items.length) return "";
  const html = items.map((item) => {
    const name = String(item.productName || "");
    const url = productImageUrl(name);
    const qty = Number(item.quantity || 0);
    const badge = qty > 1 ? `<span class="order-thumb-badge">×${qty}</span>` : "";
    const title = qty > 1 ? `${name} × ${qty}` : name;
    const body = url
      ? `<img src="${escapeAttr(url)}" alt="" loading="lazy">`
      : `<span class="order-thumb-fallback">${escapeHtml(shortProductLabel(name))}</span>`;
    return `
      <div class="order-thumb" title="${escapeAttr(title)}" role="button" tabindex="0" aria-label="Show product name: ${escapeAttr(title)}">
        ${body}
        ${badge}
        <span class="order-thumb-name">${escapeHtml(title)}</span>
      </div>
    `;
  }).join("");
  return `<div class="order-thumb-strip" aria-label="Products in this order">${html}</div>`;
}

const thumbLabelTimers = new WeakMap();

function brieflyShowThumbName(thumb) {
  const priorTimer = thumbLabelTimers.get(thumb);
  if (priorTimer) clearTimeout(priorTimer);
  thumb.classList.add("show-name");
  const timer = setTimeout(() => {
    thumb.classList.remove("show-name");
    thumbLabelTimers.delete(thumb);
  }, 5000);
  thumbLabelTimers.set(thumb, timer);
}

document.addEventListener("click", (event) => {
  const thumb = event.target.closest(".order-thumb");
  if (thumb) brieflyShowThumbName(thumb);
});

document.addEventListener("keydown", (event) => {
  const thumb = event.target.closest(".order-thumb");
  if (!thumb || (event.key !== "Enter" && event.key !== " ")) return;
  event.preventDefault();
  brieflyShowThumbName(thumb);
});

function renderReorderList(orders) {
  const container = el("reorder-list");
  if (!container) return;
  if (!orders.length) {
    container.innerHTML = `<div class="card"><strong>No past orders yet</strong><div class="muted top-gap">Your first order will appear here for one-tap reorder.</div></div>`;
    return;
  }
  container.innerHTML = orders.map((order) => {
    const payStatus = order.paymentStatus || "unpaid";
    const reorderHref = `./index.html?reorder=${encodeURIComponent(order.id)}`;
    return `
      <article class="card reorder-card">
        <div style="display:flex;justify-content:space-between;gap:10px;align-items:baseline">
          <div>
            <strong>${escapeHtml(order.deliveryDate || "?")}</strong>
            <div style="font-family:monospace;font-size:12px"><a href="${reorderHref}">${escapeHtml(order.id)}</a></div>
          </div>
          <span class="badge pay-${escapeHtml(payStatus)}">${escapeHtml(humanizePaymentStatus(payStatus))}</span>
        </div>
        <div class="muted top-gap" style="font-size:13px">Total: ${escapeHtml(formatCurrency(Number(order.subtotal || 0) + Number(order.depositTotal || 0)))}</div>
        ${renderOrderThumbs(order.id)}
        <div class="button-row top-gap">
          <a class="button-link primary primary-action" href="${reorderHref}">Reorder</a>
        </div>
      </article>
    `;
  }).join("");
}

function renderSignedOut() {
  el("signed-in-view").classList.add("hidden");
  el("signed-out-view").classList.remove("hidden");
  const heroBtn = el("hero-signout-button");
  if (heroBtn) heroBtn.classList.add("hidden");
  setStatus(el("hero-auth-status"), "");
  setStatus(el("account-status"), "Sign in to save your address and see your order history.");
}

function revealSignedInHero() {
  el("signed-out-view").classList.add("hidden");
  const heroBtn = el("hero-signout-button");
  if (heroBtn) heroBtn.classList.remove("hidden");
  setStatus(
    el("hero-auth-status"),
    `Signed in as ${state.user?.email || state.user?.uid || "customer"}.`
  );
}

function renderProfile() {
  el("signed-in-view").classList.remove("hidden");
  el("signed-out-view").classList.add("hidden");
  const customer = state.customer || {};
  el("profile-email").textContent = state.user?.email || "";
  el("profile-name").value = customer.name || "";
  el("profile-phone").value = customer.phone || "";
  el("profile-notes").value = customer.notes || "";
  renderAddresses();
}

function renderAddresses() {
  const list = el("addresses-list");
  if (!list) return;
  const customer = state.customer || {};
  const primary = String(customer.address || "").trim();
  const additional = Array.isArray(customer.additionalAddresses)
    ? customer.additionalAddresses.map((a) => String(a || "").trim()).filter(Boolean)
    : [];
  const locations = savedAddressLocations(customer);

  const rows = [];
  if (primary) {
    rows.push({ text: primary, isPrimary: true, hasPin: !!savedLocationForAddress(primary, locations) });
  }
  additional.forEach((text) => {
    if (text && text !== primary) {
      rows.push({ text, isPrimary: false, hasPin: !!savedLocationForAddress(text, locations) });
    }
  });

  if (!rows.length) {
    list.innerHTML = `<div class="muted" style="font-size:13px">No delivery address on file yet. Add one below or place your first order — we'll offer to save it.</div>`;
    return;
  }

  list.innerHTML = rows.map((row) => `
    <div class="address-card${row.isPrimary ? " address-card-primary" : ""}">
      <div class="address-card-body">
        ${row.isPrimary ? '<span class="badge pay-paid" style="margin-bottom:4px">Default</span>' : ""}
        <span class="badge ${row.hasPin ? "pay-paid" : "pay-unpaid"}" style="margin-bottom:4px">${row.hasPin ? "Pin confirmed" : "Pin needs refresh"}</span>
        <div class="address-card-text">${escapeHtml(row.text)}</div>
      </div>
      <div class="address-card-actions">
        <button type="button" class="ghost" data-address-edit="${escapeAttr(row.text)}">Edit</button>
        ${row.isPrimary
          ? ""
          : `<button type="button" class="ghost" data-address-primary="${escapeAttr(row.text)}">Set as default</button>`}
        <button type="button" class="danger" data-address-remove="${escapeAttr(row.text)}">Remove</button>
      </div>
    </div>
  `).join("");

  list.querySelectorAll("[data-address-edit]").forEach((btn) => {
    btn.addEventListener("click", () => beginEditAddress(btn.dataset.addressEdit));
  });
  list.querySelectorAll("[data-address-primary]").forEach((btn) => {
    btn.addEventListener("click", () => promoteAddress(btn.dataset.addressPrimary));
  });
  list.querySelectorAll("[data-address-remove]").forEach((btn) => {
    btn.addEventListener("click", () => removeAddress(btn.dataset.addressRemove));
  });
}

function currentAddressSet() {
  const customer = state.customer || {};
  const primary = String(customer.address || "").trim();
  const additional = Array.isArray(customer.additionalAddresses)
    ? customer.additionalAddresses.map((a) => String(a || "").trim()).filter(Boolean)
    : [];
  return { primary, additional };
}

// Keep a pin for every saved address. `customer.location` remains a mirror of
// the primary pin for older owner/driver screens, while `addressLocations`
// carries the complete set used by the public order form.
async function writeAddresses(nextPrimary, nextAdditional, options = {}) {
  if (!state.customerRef) return;
  const primary = String(nextPrimary || "").trim();
  const seen = new Set(primary ? [normalizeDeliveryAddress(primary)] : []);
  const cleanAdditional = (nextAdditional || [])
    .map((address) => String(address || "").trim())
    .filter((address) => {
      const key = normalizeDeliveryAddress(address);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const savedAddresses = [primary, ...cleanAdditional].filter(Boolean);
  let locations = savedAddressLocations();
  const confirmed = cleanAddressLocation(options.confirmedAddress, options.confirmedLocation);
  if (confirmed) {
    const confirmedKey = normalizeDeliveryAddress(confirmed.address);
    locations = locations.filter((entry) => normalizeDeliveryAddress(entry.address) !== confirmedKey);
    locations.push(confirmed);
  }
  const addressTextByKey = new Map(savedAddresses.map((address) => [normalizeDeliveryAddress(address), address]));
  locations = locations
    .filter((entry) => addressTextByKey.has(normalizeDeliveryAddress(entry.address)))
    .map((entry) => ({ ...entry, address: addressTextByKey.get(normalizeDeliveryAddress(entry.address)) }));
  const primaryLocation = savedLocationForAddress(primary, locations);
  const payload = {
    address: primary,
    additionalAddresses: cleanAdditional,
    addressLocations: locations,
    location: primaryLocation ? {
      lat: primaryLocation.lat,
      lng: primaryLocation.lng,
      formattedAddress: primaryLocation.formattedAddress,
      geocodedAt: primaryLocation.geocodedAt
    } : null,
    updatedAt: serverTimestamp()
  };

  await setDoc(state.customerRef, payload, { merge: true });
  state.customer = {
    ...(state.customer || {}),
    address: primary,
    additionalAddresses: cleanAdditional,
    addressLocations: locations,
    location: payload.location
  };
  renderAddresses();
}

async function promoteAddress(text) {
  if (!text) return;
  const { primary, additional } = currentAddressSet();
  if (text === primary) return;
  const status = el("addresses-status");
  setStatus(status, "Setting as default...");
  try {
    const nextAdditional = additional.filter((a) => a !== text);
    if (primary) nextAdditional.push(primary);
    await writeAddresses(text, nextAdditional);
    setStatus(status, "Default address updated.");
  } catch (error) {
    setStatus(status, error.message || String(error), true);
  }
}

async function removeAddress(text) {
  if (!text) return;
  if (!window.confirm(`Remove this address?\n\n${text}`)) return;
  const { primary, additional } = currentAddressSet();
  const status = el("addresses-status");
  setStatus(status, "Removing...");
  try {
    if (text === primary) {
      const nextPrimary = additional[0] || "";
      const nextAdditional = additional.slice(1);
      await writeAddresses(nextPrimary, nextAdditional);
    } else {
      await writeAddresses(primary, additional.filter((a) => a !== text));
    }
    setStatus(status, "Address removed.");
  } catch (error) {
    setStatus(status, error.message || String(error), true);
  }
}

async function findPinFor(value, status) {
  setStatus(status, "Searching Google Maps...");
  const button = el("new-address-submit");
  if (button) button.disabled = true;
  try {
    await loadAccountMaps();
    const geocoder = new google.maps.Geocoder();
    const match = await new Promise((resolve, reject) => {
      geocoder.geocode({ address: value, region: "vn" }, (results, resultStatus) => {
        if (resultStatus === "OK" && results?.[0]) resolve(results[0]);
        else reject(new Error("We couldn't find that address. Add a district or nearby landmark and try again."));
      });
    });
    const position = match.geometry.location;
    if (match.partial_match) {
      throw new Error("Google Maps only found a partial match. Add a district or nearby landmark and try again.");
    }
    const wrap = el("account-address-map-wrap");
    wrap.hidden = false;
    accountAddressMap = accountAddressMap || new google.maps.Map(el("account-address-map"), {
      center: position,
      zoom: 17,
      streetViewControl: false,
      mapTypeControl: false,
      fullscreenControl: false
    });
    accountAddressMap.setCenter(position);
    if (accountAddressMarker) accountAddressMarker.setMap(null);
    accountAddressMarker = new google.maps.Marker({ map: accountAddressMap, position, draggable: true });
    const formatted = match.formatted_address || null;
    const capture = (pos) => {
      pendingAddressConfirmation = {
        address: value,
        lat: pos.lat(),
        lng: pos.lng(),
        formattedAddress: formatted
      };
    };
    capture(position);
    accountAddressMarker.addListener("dragend", () => capture(accountAddressMarker.getPosition()));

    const help = el("account-address-map-help");
    if (help) {
      help.textContent = "Drag the pin to your exact entrance, then select “Save confirmed address”. This saved delivery profile will reuse the pin on future orders.";
    }
    updateAddressFormMode();
    setStatus(status, "Pin found. Check it, drag it if needed, then save.");
  } catch (error) {
    resetPendingAddressConfirmation();
    setStatus(status, error.message || String(error), true);
  } finally {
    if (button) button.disabled = false;
  }
}

async function handleAddressFormSubmit(event) {
  event.preventDefault();
  const input = el("new-address-input");
  if (!input) return;
  const value = String(input.value || "").trim();
  const status = el("addresses-status");
  if (value.length < 5) {
    setStatus(status, "Address is too short.", true);
    return;
  }
  const { primary, additional } = currentAddressSet();
  const original = editingAddressOriginal;
  const isEdit = Boolean(original);

  // In edit mode, matching the address you are editing is not a clash — it is
  // how you re-pin a default without retyping it.
  const clashesWithSaved = value === primary || additional.includes(value);
  if (clashesWithSaved && !(isEdit && value === original)) {
    setStatus(status, "That address is already saved.", true);
    return;
  }

  if (!pendingAddressConfirmation || pendingAddressConfirmation.address !== value) {
    await findPinFor(value, status);
    return;
  }

  setStatus(status, isEdit ? "Saving address..." : "Adding confirmed address...");
  try {
    const pin = {
      lat: pendingAddressConfirmation.lat,
      lng: pendingAddressConfirmation.lng,
      formattedAddress: pendingAddressConfirmation.formattedAddress || null,
      geocodedAt: new Date().toISOString()
    };
    if (isEdit && original === primary) {
      await writeAddresses(value, additional, { confirmedAddress: value, confirmedLocation: pin });
    } else if (isEdit) {
      await writeAddresses(primary, additional.map((a) => (a === original ? value : a)), {
        confirmedAddress: value,
        confirmedLocation: pin
      });
    } else if (!primary) {
      await writeAddresses(value, additional, { confirmedAddress: value, confirmedLocation: pin });
    } else {
      await writeAddresses(primary, [...additional, value], { confirmedAddress: value, confirmedLocation: pin });
    }
    input.value = "";
    editingAddressOriginal = null;
    resetPendingAddressConfirmation();
    setStatus(status, isEdit ? "Address updated." : "Confirmed address added.");
  } catch (error) {
    setStatus(status, error.message || String(error), true);
  }
}

function humanizePaymentStatus(status) {
  if (status === "paid") return "Paid";
  if (status === "partial") return "Partially paid";
  return "Unpaid";
}

const CUSTOMER_STATUS_LABELS = {
  pending_approval: "Waiting for confirmation",
  new: "Confirmed — being prepared",
  assigned: "Being prepared",
  out_for_delivery: "On the way",
  delivered: "Delivered",
  cancelled: "Cancelled"
};

function humanizeOrderStatus(status) {
  return CUSTOMER_STATUS_LABELS[status] || status || "unknown";
}

function renderBalanceSummary(orders) {
  const outstanding = (orders || []).filter((o) => Number(o.balanceDue || 0) > 0 && o.status !== "cancelled" && o.status !== "pending_approval");
  const total = outstanding.reduce((sum, o) => sum + Number(o.balanceDue || 0), 0);
  const summary = el("balance-summary");
  if (!summary) return;

  if (!outstanding.length) {
    summary.innerHTML = `<div style="color:rgb(15,90,73);font-weight:600;font-size:15px">You are all paid up. Thanks!</div>`;
    renderHowToPay(false);
    return;
  }

  const oldest = outstanding
    .map((o) => o.deliveryDate)
    .filter(Boolean)
    .sort()[0];
  const oldestNote = oldest ? ` · Oldest from ${oldest}` : "";

  summary.innerHTML = `
    <div class="amount">${formatCurrency(total)} outstanding</div>
    <div class="caption top-gap">${outstanding.length} unpaid order${outstanding.length === 1 ? "" : "s"}${oldestNote}</div>
  `;
  renderHowToPay(true);
}

function renderHowToPay(hasBalance) {
  const container = el("how-to-pay");
  if (!container) return;
  if (!hasBalance) {
    container.innerHTML = "";
    return;
  }
  const settings = state.settings || {};
  const bank = settings.bank || {};
  const contact = settings.contact || {};
  const hasBankDetails = bank.accountName && bank.accountNumber && bank.name;
  const bankLine = hasBankDetails
    ? `<li><strong>Bank transfer</strong> — ${escapeHtml(bank.name)}, ${escapeHtml(bank.accountName)}, account <code>${escapeHtml(bank.accountNumber)}</code>. Please include your order ID in the reference.</li>`
    : `<li><strong>Bank transfer</strong> — message us on WhatsApp for account details.</li>`;
  const contactButtons = [
    contact.whatsapp
      ? `<a class="button-link secondary" href="${escapeAttr(contact.whatsapp)}?text=${encodeURIComponent("Hi, I want to pay my outstanding balance")}" target="_blank" rel="noopener">Message on WhatsApp</a>`
      : "",
    contact.zalo
      ? `<a class="button-link secondary" href="${escapeAttr(contact.zalo)}" target="_blank" rel="noopener">Message on Zalo</a>`
      : "",
    contact.facebook
      ? `<a class="button-link secondary" href="${escapeAttr(contact.facebook)}" target="_blank" rel="noopener">Message on Facebook</a>`
      : ""
  ].filter(Boolean).join("");
  container.innerHTML = `
    <h4 style="margin:8px 0 6px">How to pay</h4>
    <ul class="stack" style="margin:0;padding-left:18px;color:var(--muted)">
      <li><strong>Cash on next delivery</strong> — the driver will collect at the door.</li>
      ${bankLine}
      <li><strong>QR code</strong> — coming soon.</li>
    </ul>
    ${contactButtons ? `<div class="button-row top-gap">${contactButtons}</div>` : ""}
  `;
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(value) {
  return escapeHtml(value);
}

function renderCancelAction(order) {
  const status = order.status;
  if (status === "cancelled" || status === "delivered") return "";
  if (status === "pending_approval") {
    return `<button class="ghost" type="button" data-cancel-mine="${order.id}">Cancel this order</button>`;
  }
  if (order.cancellationRequested) {
    return `<span class="muted">Cancellation requested — waiting for owner</span>`;
  }
  return `<button class="ghost" type="button" data-request-cancel="${order.id}">Request cancellation</button>`;
}

async function handleCustomerCancel(orderId) {
  const reason = prompt("Reason for cancellation (optional). Leave blank if you prefer not to say.");
  if (reason === null) return;
  try {
    await updateDoc(doc(db, "orders", orderId), {
      status: "cancelled",
      cancellationReason: reason.trim() || null,
      cancelledAt: new Date().toISOString(),
      cancelledBy: "customer",
      updatedAt: new Date().toISOString()
    });
    await refreshAccount();
  } catch (error) {
    setStatus(el("account-status"), error.message || String(error), true);
  }
}

async function handleCustomerRequestCancel(orderId) {
  const reason = prompt("Please tell us why. The owner will review and confirm the cancellation.");
  if (reason === null) return;
  try {
    await updateDoc(doc(db, "orders", orderId), {
      cancellationRequested: true,
      cancellationRequestReason: reason.trim() || null,
      cancellationRequestedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    await refreshAccount();
  } catch (error) {
    setStatus(el("account-status"), error.message || String(error), true);
  }
}

function renderOrders(orders) {
  const container = el("order-history");
  if (!orders.length) {
    container.innerHTML = `<div class="card"><strong>No orders yet</strong><div class="muted top-gap">Place your first order and it will show up here.</div></div>`;
    return;
  }
  container.innerHTML = orders.map((order) => {
    const payStatus = order.paymentStatus || "unpaid";
    const orderIdText = order.orderId || order.id;
    const reorderHref = `./index.html?reorder=${encodeURIComponent(order.id)}`;
    return `
    <article class="card">
      <div class="order-top">
        <div>
          <strong>${order.deliveryDate || "?"}</strong>
          <div style="font-family:monospace;font-size:12px"><a href="${reorderHref}">${escapeHtml(orderIdText)}</a></div>
        </div>
        <div class="button-row" style="gap:8px">
          <span class="badge status-${order.status || "unknown"}">${humanizeOrderStatus(order.status)}</span>
          <span class="badge pay-${payStatus}">${humanizePaymentStatus(payStatus)}</span>
        </div>
      </div>
      <div class="meta-list">
        <div>Subtotal: ${formatCurrency(order.subtotal)}</div>
        <div>Deposit: ${formatCurrency(order.depositTotal)}</div>
        <div>Paid: ${formatCurrency(order.amountPaid)}</div>
        <div>Balance: ${formatCurrency(order.balanceDue)}</div>
      </div>
      ${renderOrderThumbs(order.id)}
      <div class="button-row top-gap">
        <a class="button-link primary" href="./index.html?reorder=${encodeURIComponent(order.id)}">Reorder these items</a>
        ${renderCancelAction(order)}
      </div>
    </article>
  `;
  }).join("");

  container.querySelectorAll("[data-cancel-mine]").forEach((btn) => {
    btn.addEventListener("click", () => handleCustomerCancel(btn.dataset.cancelMine));
  });
  container.querySelectorAll("[data-request-cancel]").forEach((btn) => {
    btn.addEventListener("click", () => handleCustomerRequestCancel(btn.dataset.requestCancel));
  });
}

function showClaimPanel() {
  const panel = el("claim-panel");
  if (panel) panel.classList.remove("hidden");
  const emailNode = el("claim-email");
  if (emailNode) emailNode.textContent = state.user?.email || "your email";
}

function hideClaimPanel() {
  const panel = el("claim-panel");
  if (panel) panel.classList.add("hidden");
}

async function loadAccountData() {
  paintLoadingPlaceholders();
  const [orders, depositEvents, returns, itemsByOrderId] = await Promise.all([
    loadFirstOrdersPage(state.user.uid).catch((e) => {
      throw new Error(`orders: ${e.message || e}`);
    }),
    loadDepositEventsForUid(state.user.uid).catch((e) => {
      throw new Error(`depositEvents: ${e.message || e}`);
    }),
    loadReturnsForUid(state.user.uid).catch((e) => {
      throw new Error(`returns: ${e.message || e}`);
    }),
    loadOrderItemsForUid(state.user.uid).catch((error) => {
      // If a legacy import ever produced an orderItem without authUid the rule
      // check fails the whole query; degrade gracefully to no thumbnails.
      console.warn("Could not load order items:", error);
      return {};
    })
  ]);
  state.itemsByOrderId = itemsByOrderId || {};
  renderBalanceSummary(orders);
  renderOrders(orders);
  renderReorderList(orders);
  renderContainerSummary(summarizeContainers(depositEvents, returns));
  updateLoadMoreButtons();
  setStatus(
    el("account-status"),
    `Signed in as ${state.user.email || state.user.uid}. Showing latest ${orders.length} order${orders.length === 1 ? "" : "s"}.`
  );
}

// Paint neutral "Loading…" cards into every list container BEFORE the network
// call starts. Without this the containers sit visually empty until the fetch
// resolves — on a slow link that reads as "no history" for several seconds,
// and if a render pass ever runs against a mid-flight empty array the user
// briefly sees "No orders yet" even when their history exists.
function paintLoadingPlaceholders() {
  const loadingCard = `<div class="card muted"><strong>Loading…</strong><div style="margin-top:4px">Fetching your history — hang on.</div></div>`;
  ["reorder-list", "order-history", "container-summary"].forEach((id) => {
    const node = el(id);
    if (node) node.innerHTML = loadingCard;
  });
  const balance = el("balance-summary");
  if (balance) balance.innerHTML = `<span class="muted">Loading…</span>`;
}

function activateTab(name) {
  state.activeTab = name;
  document.querySelectorAll("#account-tabs button[data-tab]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === name);
  });
  document.querySelectorAll("[data-tab-panel]").forEach((panel) => {
    panel.classList.toggle("hidden", panel.dataset.tabPanel !== name);
  });
}

async function refreshAccount() {
  if (!state.user) return;
  revealSignedInHero();
  let step = "starting";
  try {
    step = "find-or-auto-link-customer";
    const found = await findOrAutoLinkCustomer(state.user);
    if (!found) {
      hideClaimPanel();
      step = "create-fresh-customer";
      const fresh = await createFreshCustomer(state.user);
      state.customer = fresh.data;
      state.customerRef = fresh.ref;
      renderProfile();
      showClaimPanel();
      step = "load-account-data";
      await loadAccountData();
      return;
    }
    hideClaimPanel();
    state.customer = found.data;
    state.customerRef = found.ref;
    renderProfile();
    step = "load-account-data";
    await loadAccountData();
  } catch (error) {
    console.error(`Account refresh failed at step "${step}":`, error);
    setStatus(
      el("hero-auth-status"),
      `Signed in as ${state.user.email || state.user.uid}. Could not load account details (${step}): ${error.message || error}`,
      true
    );
  }
}

async function handleGoogleSignIn() {
  const statusNode = el("google-signin-status") || el("signin-status");
  await withSubmitLock(el("google-signin-button"), async () => {
    try {
      setStatus(statusNode, "Opening Google sign-in...");
      const result = await signInWithGoogleForEnvironment();
      if (!result) setStatus(statusNode, "Google sign-in cancelled.");
      setStatus(statusNode, "");
    } catch (error) {
      console.error("Google sign-in failed:", error);
      setStatus(statusNode, error.message || String(error), true);
    }
  }, { busyLabel: "Signing in..." });
}

// Where we stash the email between "send link" (this device) and "click link
// in the email" (possibly a different browser). If missing on return (private
// browsing, storage cleared, cross-device open) we ask for it in-page — Firebase
// refuses signInWithEmailLink without the original email as an anti-hijack
// check.
const MAGIC_LINK_EMAIL_KEY = "vs.magicLinkEmail";

function magicLinkActionCodeSettings() {
  return {
    // Continue-URL Firebase appends its params to. Same page so we can complete
    // sign-in on return without an extra hop. window.location.origin keeps this
    // working across localhost / emulator / prod without a config swap.
    url: `${window.location.origin}/account.html`,
    handleCodeInApp: true
  };
}

async function handleSendMagicLink(event) {
  event.preventDefault();
  const email = el("signin-email").value.trim();
  if (!email) {
    setStatus(el("signin-status"), "Type your email above, then tap 'Send me a sign-in link'.", true);
    return;
  }
  await withSubmitLock(event, async () => {
    try {
      setStatus(el("signin-status"), "Sending sign-in link...");
      await sendSignInLinkToEmail(auth, email, magicLinkActionCodeSettings());
      try {
        window.localStorage.setItem(MAGIC_LINK_EMAIL_KEY, email);
      } catch (_) {
        // Private mode / storage disabled — the return page will show the
        // in-page email confirmation form.
      }
      setStatus(
        el("signin-status"),
        `Link sent to ${email}. Open the email on this device and tap it to sign in.`
      );
    } catch (error) {
      setStatus(el("signin-status"), error.message || String(error), true);
    }
  }, { busyLabel: "Sending..." });
}

function showMagicLinkEmailConfirmation() {
  el("default-signin-options")?.classList.add("hidden");
  el("magic-link-confirm-form")?.classList.remove("hidden");
  setStatus(el("magic-link-confirm-status"), "");
  hideAppLoading();
  window.setTimeout(() => el("magic-link-confirm-email")?.focus(), 0);
  return new Promise((resolve) => {
    resolveMagicLinkEmail = resolve;
  });
}

function closeMagicLinkEmailConfirmation(email = "") {
  el("magic-link-confirm-form")?.classList.add("hidden");
  el("default-signin-options")?.classList.remove("hidden");
  const resolve = resolveMagicLinkEmail;
  resolveMagicLinkEmail = null;
  if (resolve) resolve(String(email || "").trim());
}

function handleMagicLinkEmailConfirmation(event) {
  event.preventDefault();
  const input = el("magic-link-confirm-email");
  const email = String(input?.value || "").trim();
  if (!email || !input?.checkValidity()) {
    input?.reportValidity();
    setStatus(el("magic-link-confirm-status"), "Enter the email address that received this link.", true);
    return;
  }
  setStatus(el("magic-link-confirm-status"), "Checking your sign-in link...");
  closeMagicLinkEmailConfirmation(email);
}

function handleMagicLinkStartOver() {
  closeMagicLinkEmailConfirmation("");
}

// Runs at page load. If Firebase recognizes the current URL as an email
// sign-in link, complete the sign-in before the auth observer decides
// "still signed out" and shows the sign-in form. Returns true when a
// sign-in attempt was made (successful or not) so the caller can skip
// the initial signed-out render.
async function tryCompleteEmailLinkSignIn() {
  if (!isSignInWithEmailLink(auth, window.location.href)) return false;
  let email = "";
  try {
    email = window.localStorage.getItem(MAGIC_LINK_EMAIL_KEY) || "";
  } catch (_) {
    // ignore
  }
  if (!email) {
    // Opened the link in a different browser than the one that sent it.
    // Ask in-page for the email to satisfy Firebase's anti-hijack check.
    email = await showMagicLinkEmailConfirmation();
  }
  if (!email) {
    setStatus(el("signin-status"), "Sign-in link not completed. You can use Google or request a new email link.");
    // Strip the query params so a reload doesn't re-hit this branch with
    // the same (already-consumed on failure) code.
    window.history.replaceState({}, document.title, window.location.pathname);
    return true;
  }
  try {
    setStatus(el("signin-status"), "Signing you in...");
    await signInWithEmailLink(auth, email, window.location.href);
    try { window.localStorage.removeItem(MAGIC_LINK_EMAIL_KEY); } catch (_) {}
    // Firebase's oobCode is single-use; clean the URL so a bookmarked
    // "signed in" state doesn't linger with a spent code in the querystring.
    window.history.replaceState({}, document.title, window.location.pathname);
  } catch (error) {
    setStatus(el("signin-status"), `Could not complete sign-in: ${error.message || error}`, true);
    window.history.replaceState({}, document.title, window.location.pathname);
  }
  return true;
}

async function handleSaveProfile(event) {
  event.preventDefault();
  if (!state.customerRef || !state.user) return;
  const phoneInput = el("profile-phone");
  const rawPhone = phoneInput.value.trim();
  const phoneE164 = rawPhone ? normalizePhoneE164VN(rawPhone) : null;
  if (rawPhone && !phoneE164) {
    setStatus(el("profile-status"), "Phone must include the country code, e.g. +84 905 123 456.", true);
    return;
  }
  if (phoneE164) phoneInput.value = phoneE164;
  await withSubmitLock(event, async () => {
    try {
      setStatus(el("profile-status"), "Saving...");
      await setDoc(state.customerRef, {
        name: el("profile-name").value.trim(),
        phone: phoneE164,
        notes: el("profile-notes").value.trim() || null,
        email: state.user.email || null,
        authUid: state.user.uid,
        updatedAt: serverTimestamp()
      }, { merge: true });
      setStatus(el("profile-status"), "Saved.");
      await refreshAccount();
    } catch (error) {
      setStatus(el("profile-status"), error.message || String(error), true);
    }
  });
}

async function handleSignOut() {
  await signOut(auth);
}

el("google-signin-button").addEventListener("click", handleGoogleSignIn);
el("magic-link-form").addEventListener("submit", handleSendMagicLink);
el("magic-link-confirm-form")?.addEventListener("submit", handleMagicLinkEmailConfirmation);
el("magic-link-start-over")?.addEventListener("click", handleMagicLinkStartOver);
el("profile-form").addEventListener("submit", handleSaveProfile);
el("add-address-form")?.addEventListener("submit", handleAddressFormSubmit);
el("cancel-address-edit")?.addEventListener("click", cancelEditAddress);
el("account-address-reset-pin")?.addEventListener("click", () => {
  resetPendingAddressConfirmation();
  setStatus(el("addresses-status"), "Pin reset — update the address if needed, then find it on the map again.");
  el("new-address-input")?.focus();
});
el("new-address-input")?.addEventListener("input", () => {
  if (pendingAddressConfirmation) {
    resetPendingAddressConfirmation();
    setStatus(el("addresses-status"), "Address changed — find it on the map again.");
  }
});
el("signout-button").addEventListener("click", handleSignOut);
const heroSignoutBtn = el("hero-signout-button");
if (heroSignoutBtn) heroSignoutBtn.addEventListener("click", handleSignOut);

document.querySelectorAll("#account-tabs button[data-tab]").forEach((btn) => {
  btn.addEventListener("click", () => activateTab(btn.dataset.tab));
});

const historyLoadMore = el("history-load-more");
if (historyLoadMore) historyLoadMore.addEventListener("click", async () => {
  await withSubmitLock(historyLoadMore, () => loadMoreOrders(), { busyLabel: "Loading..." });
});
const reorderLoadMore = el("reorder-load-more");
if (reorderLoadMore) reorderLoadMore.addEventListener("click", async () => {
  await withSubmitLock(reorderLoadMore, () => loadMoreOrders(), { busyLabel: "Loading..." });
});

function hideAppLoading() {
  const overlay = document.getElementById("app-loading");
  if (overlay) overlay.classList.add("hidden");
}

// Belt-and-braces fallback: even if a load path throws before hitting one of
// the explicit hides below, don't leave the loading overlay stuck forever.
setTimeout(hideAppLoading, 8000);

// If the customer arrived by tapping their magic-link email, finish the
// sign-in BEFORE wiring the auth observer. Otherwise the observer would fire
// once with `user == null`, render the signed-out view, and then fire again
// with the user — a visible flicker to the signed-out state.
(async () => {
  await tryCompleteEmailLinkSignIn();
  onAuthStateChanged(auth, async (user) => {
    state.user = user;
    if (!user) {
      state.customer = null;
      state.customerRef = null;
      renderSignedOut();
      hideAppLoading();
      return;
    }
    try {
      await loadBusinessSettings();
      await refreshAccount();
    } finally {
      hideAppLoading();
    }
  });
})();

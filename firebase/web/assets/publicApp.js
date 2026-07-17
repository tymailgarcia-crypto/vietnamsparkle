import {
  auth,
  collection,
  db,
  doc,
  functions,
  getDoc,
  getDocs,
  GoogleAuthProvider,
  httpsCallable,
  isEmulatorMode,
  limit,
  onAuthStateChanged,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  signInWithPopup,
  signInWithGoogleForEnvironment,
  startAfter,
  where
} from "./firebaseClient.js";
import {
  computeOrderTotals,
  escapeHtml,
  formatCurrency,
  normalizePhoneE164VN,
  productCategoryKey,
  productImageUrl,
  setDeliveryWindow,
  todayKey,
  withSubmitLock
} from "./shared.js";
import { mapsApiKey, mapsDefaultCenter } from "./firebaseWebConfig.js";

const submitPublicOrderFn = httpsCallable(functions, "submitPublicOrder");

const REORDER_PAGE_SIZE = 10;

const state = {
  products: [],
  quantities: {},
  user: null,
  customer: null,
  pastOrders: [],
  pastOrdersCursor: null,
  pastOrdersExhausted: false,
  pastOrdersLoaded: false,
  pastItemsByOrderId: {},
  deliveryLocation: null,
  addressMode: "guest"
};

let mapsLoadPromise = null;
let addressMap = null;
let addressMarker = null;

function loadGoogleMaps() {
  if (window.google?.maps) return Promise.resolve(window.google.maps);
  if (mapsLoadPromise) return mapsLoadPromise;
  if (!mapsApiKey) return Promise.reject(new Error("Google Maps is not configured."));
  mapsLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(mapsApiKey)}&v=weekly`;
    script.async = true;
    script.onload = () => resolve(window.google.maps);
    script.onerror = () => reject(new Error("Google Maps could not be loaded."));
    document.head.appendChild(script);
  });
  return mapsLoadPromise;
}

function setAddressVerifyStatus(text, verified = false) {
  const node = document.getElementById("address-verify-status");
  if (!node) return;
  node.textContent = text;
  node.classList.toggle("address-verified", verified);
}

function normalizeAddress(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function savedAddressData(customer = state.customer) {
  const primary = String(customer?.address || "").trim();
  const seen = new Set(primary ? [normalizeAddress(primary)] : []);
  const additional = (Array.isArray(customer?.additionalAddresses) ? customer.additionalAddresses : [])
    .map((value) => String(value || "").trim())
    .filter((value) => {
      const key = normalizeAddress(value);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return { primary, additional };
}

function validSavedLocation(location) {
  const lat = Number(location?.lat);
  const lng = Number(location?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return {
    lat,
    lng,
    formattedAddress: String(location?.formattedAddress || "").trim(),
    source: String(location?.source || "saved_profile")
  };
}

function savedAddressLocationEntries(customer = state.customer) {
  const byAddress = new Map();
  (Array.isArray(customer?.addressLocations) ? customer.addressLocations : []).forEach((entry) => {
    const address = String(entry?.address || "").trim();
    const location = validSavedLocation(entry);
    if (address && location) {
      byAddress.set(normalizeAddress(address), {
        address,
        ...location,
        geocodedAt: entry.geocodedAt || null
      });
    }
  });
  const primary = String(customer?.address || "").trim();
  const legacyPrimaryLocation = validSavedLocation(customer?.location);
  if (primary && legacyPrimaryLocation && !byAddress.has(normalizeAddress(primary))) {
    byAddress.set(normalizeAddress(primary), {
      address: primary,
      ...legacyPrimaryLocation,
      geocodedAt: customer.location?.geocodedAt || null
    });
  }
  return Array.from(byAddress.values());
}

function savedLocationForAddress(address, customer = state.customer) {
  const key = normalizeAddress(address);
  return savedAddressLocationEntries(customer).find((entry) => normalizeAddress(entry.address) === key) || null;
}

function setSavedAddressHelp(text = "") {
  const help = document.getElementById("saved-address-help");
  if (!help) return;
  help.textContent = text;
  help.hidden = !text;
}

function setAddressSaveChoice(value) {
  const option = document.querySelector(`input[name="addressSaveChoice"][value="${value}"]`);
  if (option) option.checked = true;
}

function updateAddressSaveOptions({ resetChoice = false } = {}) {
  const wrap = document.getElementById("address-save-options");
  if (!wrap) return;
  const signedInChoice = state.user && ["additional", "different", "no_primary"].includes(state.addressMode);
  wrap.hidden = !signedInChoice;
  if (!signedInChoice) return;

  const { primary } = savedAddressData();
  const additionalOption = document.getElementById("address-save-additional-option");
  const addressIsAlreadySaved = state.addressMode === "additional";
  if (additionalOption) additionalOption.hidden = addressIsAlreadySaved || !primary;

  const hint = document.getElementById("address-save-options-hint");
  if (hint) {
    hint.textContent = primary
      ? "Choose whether this address is only for today or should change your saved delivery addresses."
      : "You do not have a primary delivery address yet. Make this primary to use it automatically next time.";
  }
  if (resetChoice || !wrap.querySelector('input[name="addressSaveChoice"]:checked')) {
    setAddressSaveChoice(primary ? "order_only" : "primary");
  }
}

function selectedAddressSaveChoice() {
  if (!state.user || state.addressMode === "guest") return "order_only";
  if (state.addressMode === "primary") return "primary";
  return document.querySelector('input[name="addressSaveChoice"]:checked')?.value || "order_only";
}

function setAddressMode(mode, address = "", location = null) {
  const input = document.getElementById("form-address");
  const verifyButton = document.getElementById("address-verify-button");
  const editor = document.getElementById("delivery-address-editor");
  const editorLabel = document.getElementById("delivery-address-editor-label");
  const savedLocation = validSavedLocation(location);
  const isSavedAddress = mode === "primary" || mode === "additional";
  state.addressMode = mode;
  if (editor) editor.hidden = isSavedAddress;
  if (editorLabel) editorLabel.textContent = mode === "different"
    ? "Enter a different address"
    : "Enter delivery address";
  if (input) {
    input.readOnly = mode === "primary" || mode === "additional";
    input.value = address;
  }
  document.getElementById("address-map-wrap")?.setAttribute("hidden", "");
  if (verifyButton) {
    verifyButton.classList.toggle("hidden", isEmulatorMode || isSavedAddress);
  }

  if (isSavedAddress && savedLocation) {
    state.deliveryLocation = {
      ...savedLocation,
      formattedAddress: savedLocation.formattedAddress || address
    };
    setAddressVerifyStatus(
      mode === "primary"
        ? "✓ Using the confirmed pin for your primary delivery address."
        : "✓ Using the confirmed pin from this saved delivery profile.",
      true
    );
  } else {
    state.deliveryLocation = null;
    const message = isSavedAddress
      ? "Loading the confirmed pin from this saved delivery profile…"
      : mode === "no_primary"
        ? "No primary address yet — confirm this address, then choose whether to make it primary."
        : "Confirm the delivery pin to help us find you.";
    setAddressVerifyStatus(isEmulatorMode ? "Local test mode — map confirmation is disabled." : message);
  }
  updateAddressSaveOptions({ resetChoice: true });
}

async function recoverLegacySavedAddressLocation(address) {
  if (!state.user || !address) return null;
  // Prefer a location previously confirmed for an order to an approximate
  // geocode. This repairs old secondary-address records whose profile flow
  // confirmed a pin but discarded it before `addressLocations` existed.
  try {
    const snap = await getDocs(query(
      collection(db, "orders"),
      where("authUid", "==", state.user.uid),
      orderBy("createdAt", "desc"),
      limit(25)
    ));
    const previous = snap.docs
      .map((docSnap) => docSnap.data())
      .find((order) => normalizeAddress(order.address) === normalizeAddress(address)
        && validSavedLocation(order.deliveryLocation));
    if (previous) return { ...validSavedLocation(previous.deliveryLocation), source: "legacy_order" };
  } catch (error) {
    console.warn("Could not recover saved pin from past orders:", error);
  }

  try {
    await loadGoogleMaps();
    const geocoder = new google.maps.Geocoder();
    const match = await new Promise((resolve, reject) => {
      geocoder.geocode({ address, region: "vn" }, (results, status) => {
        if (status === "OK" && results?.[0] && !results[0].partial_match) resolve(results[0]);
        else reject(new Error("Saved address could not be resolved."));
      });
    });
    return validSavedLocation({
      lat: match.geometry.location.lat(),
      lng: match.geometry.location.lng(),
      formattedAddress: match.formatted_address || address,
      source: "legacy_auto_geocode"
    });
  } catch (error) {
    console.warn("Could not recover saved pin from Google Maps:", error);
    return null;
  }
}

async function selectSavedAddress(mode, address, location) {
  setAddressMode(mode, address, location);
  if (validSavedLocation(location) || isEmulatorMode) {
    setSavedAddressHelp("");
    return;
  }
  setSavedAddressHelp("Loading this saved delivery profile…");
  const expectedAddress = normalizeAddress(address);
  const recovered = await recoverLegacySavedAddressLocation(address);
  if (state.addressMode !== mode
    || normalizeAddress(document.getElementById("form-address")?.value) !== expectedAddress) return;
  if (recovered) {
    setAddressMode(mode, address, recovered);
    setSavedAddressHelp("");
  } else {
    state.deliveryLocation = null;
    setSavedAddressHelp("This older saved profile is missing its stored pin. Edit it once under My account → Delivery addresses.");
  }
}

async function renderSavedAddressControl() {
  const control = document.getElementById("saved-address-control");
  const select = document.getElementById("saved-address-select");
  const help = document.getElementById("saved-address-help");
  const currentAddress = String(document.getElementById("form-address")?.value || "").trim();
  if (!control || !select || !help) return;

  select.replaceChildren();
  if (!state.user) {
    control.hidden = true;
    setSavedAddressHelp("");
    setAddressMode("guest", "");
    return;
  }

  control.hidden = false;
  const { primary, additional } = savedAddressData();
  if (primary) {
    const option = document.createElement("option");
    option.value = "primary";
    option.textContent = `Primary — ${primary}`;
    select.appendChild(option);
  }
  additional.forEach((address, index) => {
    const option = document.createElement("option");
    option.value = `additional:${index}`;
    option.textContent = `Saved address — ${address}`;
    select.appendChild(option);
  });
  const different = document.createElement("option");
  different.value = "different";
  different.textContent = primary || additional.length
    ? "Use a different address for this order"
    : "Add a delivery address";
  select.appendChild(different);

  if (primary) {
    select.value = "primary";
    setSavedAddressHelp("");
    await selectSavedAddress("primary", primary, savedLocationForAddress(primary));
  } else {
    select.value = "different";
    setSavedAddressHelp("No primary delivery address is saved yet.");
    setAddressMode("no_primary", currentAddress);
  }
}

async function handleSavedAddressSelection() {
  const select = document.getElementById("saved-address-select");
  const { primary, additional } = savedAddressData();
  const value = select?.value || "different";
  if (value === "primary" && primary) {
    setSavedAddressHelp("");
    await selectSavedAddress("primary", primary, savedLocationForAddress(primary));
    return;
  }
  if (value.startsWith("additional:")) {
    const index = Number(value.split(":")[1]);
    const address = additional[index] || "";
    setSavedAddressHelp("");
    await selectSavedAddress("additional", address, savedLocationForAddress(address));
    return;
  }
  setSavedAddressHelp(primary ? "" : "No primary delivery address is saved yet.");
  setAddressMode(primary ? "different" : "no_primary", "");
  document.getElementById("form-address")?.focus();
}

function clearDeliveryLocation(message = "Address changed — confirm the pin again.") {
  state.deliveryLocation = null;
  document.getElementById("address-map-wrap")?.setAttribute("hidden", "");
  setAddressVerifyStatus(message, false);
}

async function verifyAddressOnMap() {
  const input = document.getElementById("form-address");
  const button = document.getElementById("address-verify-button");
  const address = String(input?.value || "").trim();
  if (address.length < 5) {
    setAddressVerifyStatus("Enter a complete delivery address first.");
    input?.focus();
    return;
  }
  button.disabled = true;
  button.textContent = "Finding…";
  setAddressVerifyStatus("Searching Google Maps…");
  try {
    await loadGoogleMaps();
    const geocoder = new google.maps.Geocoder();
    const results = await new Promise((resolve, reject) => {
      geocoder.geocode({ address, region: "vn" }, (matches, status) => {
        if (status === "OK" && matches?.[0]) resolve(matches);
        else reject(new Error("We couldn't find that address. Add a district or nearby landmark and try again."));
      });
    });
    const match = results[0];
    if (match.partial_match) {
      throw new Error("Google Maps only found a partial match. Add a district or nearby landmark and try again.");
    }
    const position = match.geometry.location;
    const wrap = document.getElementById("address-map-wrap");
    wrap.hidden = false;
    addressMap = addressMap || new google.maps.Map(document.getElementById("address-confirm-map"), {
      center: position,
      zoom: 17,
      streetViewControl: false,
      mapTypeControl: false,
      fullscreenControl: false
    });
    addressMap.setCenter(position);
    if (addressMarker) addressMarker.setMap(null);
    addressMarker = new google.maps.Marker({ map: addressMap, position, draggable: true, title: "Drag to your delivery entrance" });
    const savePosition = (pos, formattedAddress) => {
      state.deliveryLocation = {
        lat: pos.lat(),
        lng: pos.lng(),
        formattedAddress: String(formattedAddress || address).slice(0, 499),
        source: "customer_google_maps"
      };
      setAddressVerifyStatus("✓ Location confirmed on Google Maps", true);
    };
    savePosition(position, match.formatted_address);
    addressMarker.addListener("dragend", () => {
      savePosition(addressMarker.getPosition(), match.formatted_address);
      addressMap.panTo(addressMarker.getPosition());
    });
    wrap.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (error) {
    clearDeliveryLocation(error.message || String(error));
  } finally {
    button.disabled = false;
    button.textContent = "Find on Google Maps";
  }
}

const categoryTargets = {
  glass: document.getElementById("catalog-glass"),
  jug: document.getElementById("catalog-jug"),
  addon: document.getElementById("catalog-addon")
};

function productNote(product) {
  return String(product.notes || "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part && !/\bper\s+(?:bottle|crate|jug|unit|each)\b/i.test(part))
    .join(" · ")
    .replace(/\s+x\s+/gi, " × ");
}

function selectedLines() {
  return state.products
    .map((product) => ({
      ...product,
      quantity: Number(state.quantities[product.id] || 0)
    }))
    .filter((line) => line.quantity > 0);
}

function renderTotals() {
  const totals = computeOrderTotals(selectedLines());
  const due = totals.subtotal + totals.depositTotal;
  document.getElementById("totals").innerHTML = `
    <div class="card"><span class="muted">Subtotal</span><strong>${formatCurrency(totals.subtotal)}</strong></div>
    <div class="card"><span class="muted">Deposit</span><strong>${formatCurrency(totals.depositTotal)}</strong></div>
    <div class="card"><span class="muted">Due now</span><strong>${formatCurrency(due)}</strong></div>
  `;
}

function adjustQuantity(productId, delta) {
  const current = Number(state.quantities[productId] || 0);
  const next = Math.max(0, current + delta);
  state.quantities[productId] = next;
  const node = document.querySelector(`[data-qty-value="${productId}"]`);
  if (node) {
    node.textContent = String(next);
  }
  renderTotals();
}

function renderCatalog() {
  Object.values(categoryTargets).forEach((node) => {
    node.innerHTML = "";
  });
  applyCatalogLayout();

  state.products.forEach((product) => {
    const key = productCategoryKey(product);
    const target = categoryTargets[key] || categoryTargets.addon;
    const wrap = document.createElement("article");
    wrap.className = "catalog-item";
    const imgUrl = productImageUrl(product);
    const thumb = imgUrl
      ? `<div class="product-thumb"><img src="${escapeHtml(imgUrl)}" alt="" loading="lazy" onerror="this.style.display='none'"></div>`
      : `<div class="product-thumb" aria-hidden="true"></div>`;
    wrap.innerHTML = `
      ${thumb}
      <strong class="product-name">${escapeHtml(product.productName)}</strong>
      <div class="product-details">
        <div class="muted product-note">${escapeHtml(productNote(product))}</div>
        <strong class="product-price">${formatCurrency(product.unitPrice)}</strong>
      </div>
      <div class="qty-row">
        <button class="ghost" type="button" data-qty-minus="${escapeHtml(product.id)}">-</button>
        <span class="qty-value" data-qty-value="${escapeHtml(product.id)}">0</span>
        <button class="primary" type="button" data-qty-plus="${escapeHtml(product.id)}">+</button>
      </div>
    `;
    target.appendChild(wrap);
  });

  document.querySelectorAll("[data-qty-minus]").forEach((button) => {
    button.addEventListener("click", () => adjustQuantity(button.dataset.qtyMinus, -1));
  });
  document.querySelectorAll("[data-qty-plus]").forEach((button) => {
    button.addEventListener("click", () => adjustQuantity(button.dataset.qtyPlus, 1));
  });
}

async function loadProducts() {
  const snapshot = await getDocs(query(collection(db, "products"), where("active", "==", true)));
  state.products = snapshot.docs
    .map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }))
    // sortOrder is owner-set in /catalog.html; unset sorts last, ties by name.
    .sort((a, b) => (Number(a.sortOrder ?? 9999) - Number(b.sortOrder ?? 9999))
      || String(a.productName || "").localeCompare(String(b.productName || "")));
  renderCatalog();
  renderTotals();
}

// Build the callable payload. Only productId + quantity are sent for line
// items — the server reads canonical prices from products/{id} and rejects
// anything else. Client-supplied unitPrice / lineTotal are no longer trusted.
function buildCallablePayload(form) {
  const lines = selectedLines();
  if (!lines.length) {
    throw new Error("Select at least one item.");
  }
  return {
    items: lines.map((line) => ({
      productId: line.id,
      quantity: line.quantity
    })),
    customer: {
      name: form.customerName.value.trim(),
      phone: form.phone.value.trim(),
      email: state.user?.email || null,
      address: form.address.value.trim(),
      deliveryLocation: state.deliveryLocation || (isEmulatorMode ? {
        lat: mapsDefaultCenter.lat,
        lng: mapsDefaultCenter.lng,
        formattedAddress: form.address.value.trim(),
        source: "local_test_bypass"
      } : null),
      deliveryDate: form.deliveryDate.value,
      deliveryWindow: form.deliveryWindow.value.trim(),
      notes: form.notes.value.trim()
    }
  };
}

async function applyReorderById(reorderId) {
  const feedback = document.getElementById("public-feedback");
  const cached = state.pastItemsByOrderId[reorderId];
  const items = cached
    || (await getDocs(query(collection(db, "orderItems"), where("orderId", "==", reorderId))))
      .docs.map((d) => d.data());
  if (!cached) state.pastItemsByOrderId[reorderId] = items;
  if (!items.length) {
    if (feedback) feedback.textContent = "Could not load that past order to reorder. It may have been removed.";
    return false;
  }
  state.quantities = {};
  items.forEach((item) => {
    const productId = item.productId;
    if (!productId) return;
    state.quantities[productId] = Number(item.quantity || 0);
  });
  renderCatalog();
  renderTotals();
  if (feedback) feedback.textContent = "";
  return true;
}

async function applyReorderFromQuery() {
  const params = new URLSearchParams(location.search);
  const reorderId = params.get("reorder");
  if (!reorderId) return;
  try {
    await applyReorderById(reorderId);
  } catch (error) {
    const feedback = document.getElementById("public-feedback");
    if (feedback) feedback.textContent = `Could not load reorder: ${error.message || error}`;
  }
}

function shortProductLabel(name) {
  const n = String(name || "").trim();
  if (!n) return "?";
  const initials = n.split(/\s+/).slice(0, 3).map((w) => w[0]).filter(Boolean).join("");
  return initials.toUpperCase() || n.slice(0, 3).toUpperCase();
}

function renderOrderThumbs(orderId) {
  const items = state.pastItemsByOrderId[orderId] || [];
  if (!items.length) return "";
  const html = items.map((item) => {
    const name = String(item.productName || "");
    const url = productImageUrl(name);
    const qty = Number(item.quantity || 0);
    const badge = qty > 1 ? `<span class="order-thumb-badge">×${qty}</span>` : "";
    const title = qty > 1 ? `${name} × ${qty}` : name;
    const body = url
      ? `<img src="${escapeHtml(url)}" alt="" loading="lazy">`
      : `<span class="order-thumb-fallback">${escapeHtml(shortProductLabel(name))}</span>`;
    return `
      <div class="order-thumb" title="${escapeHtml(title)}" role="button" tabindex="0" aria-label="Show product name: ${escapeHtml(title)}">
        ${body}
        ${badge}
        <span class="order-thumb-name">${escapeHtml(title)}</span>
      </div>
    `;
  }).join("");
  return `<div class="order-thumb-strip" aria-label="Products in this order">${html}</div>`;
}

const reorderThumbTimers = new WeakMap();

function brieflyShowReorderThumbName(thumb) {
  const priorTimer = reorderThumbTimers.get(thumb);
  if (priorTimer) clearTimeout(priorTimer);
  thumb.classList.add("show-name");
  const timer = setTimeout(() => {
    thumb.classList.remove("show-name");
    reorderThumbTimers.delete(thumb);
  }, 5000);
  reorderThumbTimers.set(thumb, timer);
}

function humanizePaymentStatus(status) {
  if (status === "paid") return "Paid";
  if (status === "partial") return "Partially paid";
  return "Unpaid";
}

async function loadPastOrdersPage({ append } = { append: false }) {
  if (!state.user) return;
  const baseArgs = [
    collection(db, "orders"),
    where("authUid", "==", state.user.uid),
    orderBy("createdAt", "desc")
  ];
  const q = append && state.pastOrdersCursor
    ? query(...baseArgs, startAfter(state.pastOrdersCursor), limit(REORDER_PAGE_SIZE))
    : query(...baseArgs, limit(REORDER_PAGE_SIZE));
  const snap = await getDocs(q);
  const orders = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  if (append) {
    state.pastOrders = state.pastOrders.concat(orders);
  } else {
    state.pastOrders = orders;
  }
  state.pastOrdersCursor = snap.docs.length ? snap.docs[snap.docs.length - 1] : state.pastOrdersCursor;
  state.pastOrdersExhausted = snap.docs.length < REORDER_PAGE_SIZE;
  state.pastOrdersLoaded = true;
  await loadOrderItemsForOrders(orders);
}

async function loadOrderItemsForOrders(orders) {
  const missing = orders.filter((o) => !state.pastItemsByOrderId[o.id]);
  if (!missing.length) return;
  await Promise.all(missing.map(async (order) => {
    try {
      const snap = await getDocs(query(collection(db, "orderItems"), where("orderId", "==", order.id)));
      state.pastItemsByOrderId[order.id] = snap.docs.map((d) => d.data());
    } catch (_) {
      state.pastItemsByOrderId[order.id] = [];
    }
  }));
}

function renderReorderDialogList() {
  const container = document.getElementById("reorder-dialog-list");
  if (!container) return;
  if (!state.pastOrders.length) {
    container.innerHTML = `<div class="card"><strong>No past orders yet</strong><div class="muted top-gap">Your first order will appear here for one-tap reorder.</div></div>`;
    return;
  }
  container.innerHTML = state.pastOrders.map((order) => {
    const payStatus = order.paymentStatus || "unpaid";
    const total = Number(order.subtotal || 0) + Number(order.depositTotal || 0);
    return `
      <article class="card reorder-card">
        <div style="display:flex;justify-content:space-between;gap:10px;align-items:baseline">
          <div>
            <strong>${escapeHtml(order.deliveryDate || "?")}</strong>
            <div style="font-family:monospace;font-size:12px">${escapeHtml(order.id)}</div>
          </div>
          <span class="badge pay-${escapeHtml(payStatus)}">${escapeHtml(humanizePaymentStatus(payStatus))}</span>
        </div>
        <div class="muted top-gap" style="font-size:13px">Total: ${escapeHtml(formatCurrency(total))}</div>
        ${renderOrderThumbs(order.id)}
        <div class="button-row top-gap">
          <button type="button" class="primary primary-action" data-reorder-id="${escapeHtml(order.id)}">Reorder</button>
        </div>
      </article>
    `;
  }).join("");
  container.querySelectorAll("[data-reorder-id]").forEach((btn) => {
    btn.addEventListener("click", () => handleReorderPick(btn.dataset.reorderId));
  });
}

function updateReorderDialogLoadMore() {
  const row = document.getElementById("reorder-dialog-load-more-row");
  if (!row) return;
  row.style.display = state.pastOrdersExhausted || !state.pastOrdersLoaded ? "none" : "";
}

function setReorderDialogStatus(text, isError = false) {
  const node = document.getElementById("reorder-dialog-status");
  if (!node) return;
  node.textContent = text || "";
  node.style.color = isError ? "var(--danger, #b3261e)" : "";
}

async function openReorderDialog() {
  const dialog = document.getElementById("reorder-dialog");
  if (!dialog) return;
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");

  if (!state.user) {
    document.getElementById("reorder-dialog-list").innerHTML = `
      <div class="card">
        <strong>Sign in to see your past orders</strong>
        <div class="muted top-gap">Your past orders live in your account. Sign in first, then come back here.</div>
        <div class="button-row top-gap">
          <a class="button-link primary" href="./account.html">Go to my account</a>
        </div>
      </div>
    `;
    setReorderDialogStatus("");
    updateReorderDialogLoadMore();
    return;
  }

  if (state.pastOrdersLoaded) {
    setReorderDialogStatus("");
    renderReorderDialogList();
    updateReorderDialogLoadMore();
    return;
  }

  setReorderDialogStatus("Loading past orders...");
  document.getElementById("reorder-dialog-list").innerHTML = `<div class="card muted"><strong>Loading…</strong><div style="margin-top:4px">Fetching your recent orders.</div></div>`;
  try {
    await loadPastOrdersPage({ append: false });
    setReorderDialogStatus("");
    renderReorderDialogList();
    updateReorderDialogLoadMore();
  } catch (error) {
    setReorderDialogStatus(`Could not load past orders: ${error.message || error}`, true);
  }
}

function closeReorderDialog() {
  const dialog = document.getElementById("reorder-dialog");
  if (!dialog) return;
  if (typeof dialog.close === "function") dialog.close();
  else dialog.removeAttribute("open");
}

function maybePrefillCustomerFromOrder(orderId) {
  const order = state.pastOrders.find((o) => o.id === orderId);
  if (!order) return [];
  const targets = [
    { id: "form-customer-name", label: "name", value: String(order.customerName || "").trim() },
    { id: "form-phone", label: "phone", value: String(order.phone || "").trim() },
    { id: "form-address", label: "address", value: String(order.address || "").trim() }
  ];
  const eligible = targets.filter((t) => {
    const node = document.getElementById(t.id);
    return node && !node.value.trim() && t.value;
  });
  if (!eligible.length) return [];
  const labels = eligible.map((t) => t.label).join(", ");
  const ok = window.confirm(
    `Prefill your ${labels} from this past order? Only empty fields will be filled — anything you've already typed stays as is.`
  );
  if (!ok) return [];
  eligible.forEach((t) => {
    const node = document.getElementById(t.id);
    if (node && !node.value.trim()) node.value = t.value;
  });
  return eligible.map((t) => t.label);
}

async function handleReorderPick(orderId) {
  if (!orderId) return;
  setReorderDialogStatus("Loading order...");
  try {
    const ok = await applyReorderById(orderId);
    if (ok) {
      const prefilled = maybePrefillCustomerFromOrder(orderId);
      closeReorderDialog();
      const totals = document.getElementById("totals");
      if (totals && typeof totals.scrollIntoView === "function") {
        totals.scrollIntoView({ behavior: "smooth", block: "center" });
      }
      const feedback = document.getElementById("public-feedback");
      if (feedback) {
        const suffix = prefilled.length
          ? ` Prefilled ${prefilled.join(", ")} from that order.`
          : "";
        feedback.textContent = `Loaded items from order ${orderId}. Review, then Submit.${suffix}`;
      }
    } else {
      setReorderDialogStatus("Could not load that past order. It may have been removed.", true);
    }
  } catch (error) {
    setReorderDialogStatus(`Could not reorder: ${error.message || error}`, true);
  }
}

async function loadMorePastOrders() {
  if (state.pastOrdersExhausted) return;
  setReorderDialogStatus("Loading more...");
  try {
    await loadPastOrdersPage({ append: true });
    setReorderDialogStatus("");
    renderReorderDialogList();
    updateReorderDialogLoadMore();
  } catch (error) {
    setReorderDialogStatus(`Could not load more: ${error.message || error}`, true);
  }
}

async function submitOrder(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const feedback = document.getElementById("public-feedback");
  if (!state.deliveryLocation && !isEmulatorMode) {
    const savedAddressMissingPin = state.addressMode === "primary" || state.addressMode === "additional";
    feedback.textContent = savedAddressMissingPin
      ? "This older saved delivery profile is missing its stored pin. Edit it once under My account → Delivery addresses."
      : "Confirm your delivery address on Google Maps before submitting.";
    if (savedAddressMissingPin) setSavedAddressHelp(feedback.textContent);
    else setAddressVerifyStatus(feedback.textContent);
    (savedAddressMissingPin
      ? document.getElementById("saved-address-select")
      : document.getElementById("address-verify-button"))?.focus();
    return;
  }
  const submitButton = event.submitter
    || document.querySelector('button[form="public-order-form"][type="submit"]');

  // Phones are stored E.164-only so wa.me links work (Ty, 2026-07-16).
  // Vietnamese local formats normalize to +84 automatically; other countries
  // must be typed with their country code. The field is rewritten so the
  // customer sees exactly what we will store, and the server enforces the
  // same rule — this check just makes the error arrive before the round-trip.
  const phoneE164 = normalizePhoneE164VN(form.phone?.value);
  if (!phoneE164) {
    feedback.textContent = "Please include your phone's country code, e.g. +84 905 123 456.";
    form.phone?.focus();
    return;
  }
  if (form.phone) form.phone.value = phoneE164;
  feedback.textContent = "Submitting order...";

  // Capture identity fields before we reset the form — needed for the
  // "save these to your profile?" prompt after success.
  const submittedIdentity = {
    name: String(form.customerName?.value || "").trim(),
    phone: String(form.phone?.value || "").trim(),
    address: String(form.address?.value || "").trim(),
    addressMode: state.addressMode,
    addressSaveChoice: selectedAddressSaveChoice(),
    deliveryLocation: state.deliveryLocation ? { ...state.deliveryLocation } : null
  };

  let successOrderId = null;
  await withSubmitLock(event, async () => {
    try {
      const payload = buildCallablePayload(form);
      const result = await submitPublicOrderFn(payload);
      const orderId = result?.data?.orderId;
      if (!orderId) throw new Error("Order was not confirmed. Please try again.");
      form.reset();
      state.deliveryLocation = null;
      document.getElementById("address-map-wrap")?.setAttribute("hidden", "");
      setAddressVerifyStatus("Confirm the delivery pin to help us find you.");
      state.quantities = {};
      renderCatalog();
      renderTotals();
      document.getElementById("delivery-date").value = todayKey();
      setDeliveryWindow(document.getElementById("delivery-window"), "");
      successOrderId = orderId;
    } catch (error) {
      // Callable errors surface as { code, message, details } from HttpsError.
      feedback.textContent = error && error.message ? error.message : String(error);
    }
  }, { busyLabel: "Submitting..." });

  if (successOrderId && submitButton) {
    submitButton.disabled = true;
    submitButton.classList.add("success-locked");
    submitButton.textContent = "Ordered ✓";
    feedback.innerHTML = `
      <div class="order-confirmation">
        <strong>Order ${escapeHtml(successOrderId)} received.</strong>
        <div>Thanks! We'll confirm shortly and message you before delivery.</div>
      </div>
    `;
    try {
      await persistDeliveryAddressChoice(submittedIdentity);
    } catch (error) {
      console.warn("Could not save delivery address choice:", error);
      feedback.insertAdjacentHTML(
        "beforeend",
        `<p class="muted">The order was received, but the delivery address could not be saved to your profile: ${escapeHtml(error.message || String(error))}</p>`
      );
    }
    await maybeSaveIdentityToProfile(submittedIdentity);
  }
}

function uniqueAddresses(values, excluded = "") {
  const excludedKey = normalizeAddress(excluded);
  const seen = new Set(excludedKey ? [excludedKey] : []);
  return values
    .map((value) => String(value || "").trim())
    .filter((value) => {
      const key = normalizeAddress(value);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function updatedSavedAddressLocations(savedAddresses, confirmedAddress, confirmedLocation) {
  const addressTextByKey = new Map(
    savedAddresses.filter(Boolean).map((address) => [normalizeAddress(address), String(address).trim()])
  );
  const byAddress = new Map(
    savedAddressLocationEntries()
      .filter((entry) => addressTextByKey.has(normalizeAddress(entry.address)))
      .map((entry) => [normalizeAddress(entry.address), {
        ...entry,
        address: addressTextByKey.get(normalizeAddress(entry.address))
      }])
  );
  const location = validSavedLocation(confirmedLocation);
  const confirmedKey = normalizeAddress(confirmedAddress);
  if (confirmedKey && location && addressTextByKey.has(confirmedKey)) {
    byAddress.set(confirmedKey, {
      address: addressTextByKey.get(confirmedKey),
      lat: location.lat,
      lng: location.lng,
      formattedAddress: location.formattedAddress || String(confirmedAddress).trim(),
      geocodedAt: new Date().toISOString()
    });
  }
  return Array.from(byAddress.values());
}

// Submit the order first, then apply the customer's explicit address choice.
// A profile-write problem can therefore never prevent or duplicate the order.
async function persistDeliveryAddressChoice(submitted) {
  if (!state.user || submitted.addressSaveChoice === "order_only" || !submitted.address) return;
  const { primary, additional } = savedAddressData();
  const sameAsPrimary = normalizeAddress(submitted.address) === normalizeAddress(primary);
  const ref = doc(db, "customers", state.customer?.id || `CUS-${state.user.uid}`);
  const payload = { updatedAt: serverTimestamp() };

  if (submitted.addressSaveChoice === "additional") {
    const alreadySaved = sameAsPrimary
      || additional.some((address) => normalizeAddress(address) === normalizeAddress(submitted.address));
    if (alreadySaved) return;
    payload.additionalAddresses = uniqueAddresses([...additional, submitted.address], primary);
    payload.addressLocations = updatedSavedAddressLocations(
      [primary, ...payload.additionalAddresses],
      submitted.address,
      submitted.deliveryLocation
    );
  } else if (submitted.addressSaveChoice === "primary") {
    // Reusing an already-confirmed primary address is not a profile change.
    if (sameAsPrimary && submitted.addressMode === "primary" && submitted.deliveryLocation?.source === "saved_profile") return;
    payload.address = submitted.address;
    payload.additionalAddresses = uniqueAddresses([
      ...(!sameAsPrimary && primary ? [primary] : []),
      ...additional
    ], submitted.address);
    payload.addressLocations = updatedSavedAddressLocations(
      [payload.address, ...payload.additionalAddresses],
      submitted.address,
      submitted.deliveryLocation
    );
    payload.location = submitted.deliveryLocation ? {
      lat: submitted.deliveryLocation.lat,
      lng: submitted.deliveryLocation.lng,
      formattedAddress: submitted.deliveryLocation.formattedAddress || submitted.address,
      geocodedAt: new Date().toISOString()
    } : null;
  } else {
    return;
  }

  if (!state.customer) {
    payload.authUid = state.user.uid;
    payload.email = state.user.email || null;
    payload.createdAt = serverTimestamp();
  }
  await setDoc(ref, payload, { merge: true });
  state.customer = { ...(state.customer || {}), id: ref.id, ...payload };
}

// Address handling is already explicit in the order form. This prompt only
// offers to fill missing contact fields, and only after a successful order.
async function maybeSaveIdentityToProfile(submitted) {
  if (!state.user) return;
  const existing = state.customer || {};
  const existingName = String(existing.name || "").trim();
  const existingPhone = String(existing.phone || "").trim();

  const missing = [];
  if (submitted.name && !existingName) missing.push({ key: "name", value: submitted.name });
  if (submitted.phone && !existingPhone) missing.push({ key: "phone", value: submitted.phone });
  if (!missing.length) return;

  const dialog = document.getElementById("profile-save-dialog");
  if (!dialog) return;

  // ---- Populate the dialog --------------------------------------------------
  const hint = document.getElementById("profile-save-hint");
  const fieldsWrap = document.getElementById("profile-save-fields");
  const status = document.getElementById("profile-save-status");
  const confirmBtn = document.getElementById("profile-save-confirm");
  const cancelBtn = document.getElementById("profile-save-cancel");

  if (hint) {
    if (!state.customer) {
      hint.textContent = "Create a profile so we can prefill your contact details next time.";
    } else {
      hint.textContent = "We can save these contact details to your profile for next time.";
    }
  }
  if (fieldsWrap) {
    fieldsWrap.innerHTML = missing.length
      ? missing.map((m) => `
        <div class="profile-save-fields-item">
          <strong>${escapeHtml(m.key)}</strong>
          <span>${escapeHtml(m.value)}</span>
        </div>
      `).join("")
      : "";
  }
  if (status) status.textContent = "";
  if (confirmBtn) {
    confirmBtn.disabled = false;
    confirmBtn.textContent = "Save";
  }

  // ---- Wire actions ---------------------------------------------------------
  const cleanup = () => {
    form.removeEventListener("submit", onSubmit);
    cancelBtn?.removeEventListener("click", onCancel);
  };
  const closeDialog = () => {
    if (typeof dialog.close === "function") dialog.close();
    else dialog.removeAttribute("open");
    cleanup();
  };

  const form = document.getElementById("profile-save-form");
  const onCancel = () => closeDialog();
  const onSubmit = async (event) => {
    event.preventDefault();
    if (confirmBtn) {
      confirmBtn.disabled = true;
      confirmBtn.textContent = "Saving...";
    }
    try {
      await writeIdentityToProfile({ missing });
      closeDialog();
    } catch (error) {
      console.warn("Could not save profile:", error);
      if (status) status.textContent = `Could not save: ${error.message || error}`;
      if (confirmBtn) {
        confirmBtn.disabled = false;
        confirmBtn.textContent = "Save";
      }
    }
  };
  cancelBtn?.addEventListener("click", onCancel);
  form.addEventListener("submit", onSubmit);

  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
}

async function writeIdentityToProfile({ missing }) {
  const ref = doc(db, "customers", state.customer?.id || `CUS-${state.user.uid}`);
  const payload = { updatedAt: serverTimestamp() };
  missing.forEach((m) => {
    payload[m.key] = m.value;
  });

  if (!state.customer) {
    payload.authUid = state.user.uid;
    payload.email = state.user.email || null;
    payload.createdAt = serverTimestamp();
  }

  await setDoc(ref, payload, { merge: true });
  state.customer = { ...(state.customer || {}), id: ref.id, ...payload };
}

async function updateAccountFromPersonalDetails() {
  const button = document.getElementById("update-account-details");
  const status = document.getElementById("update-account-status");
  const name = String(document.getElementById("form-customer-name")?.value || "").trim();
  const phone = String(document.getElementById("form-phone")?.value || "").trim();
  const fields = ["form-customer-name", "form-phone"]
    .map((id) => document.getElementById(id));
  if (!state.user) return;
  if (fields.some((field) => field && !field.checkValidity()) || name.length < 2 || phone.length < 6) {
    status.textContent = "Complete your name and phone first.";
    fields.find((field) => field && !field.checkValidity())?.reportValidity();
    return;
  }
  // Same E.164-only rule as the order form — stored phones must carry the
  // country code so wa.me links work.
  const phoneE164 = normalizePhoneE164VN(phone);
  if (!phoneE164) {
    status.textContent = "Please include your phone's country code, e.g. +84 905 123 456.";
    return;
  }
  const phoneField = document.getElementById("form-phone");
  if (phoneField) phoneField.value = phoneE164;
  button.disabled = true;
  button.textContent = "Saving…";
  status.textContent = "Saving your contact details…";
  try {
    const ref = doc(db, "customers", state.customer?.id || `CUS-${state.user.uid}`);
    const payload = {
      authUid: state.user.uid,
      email: state.user.email || null,
      name,
      phone: phoneE164,
      updatedAt: serverTimestamp()
    };
    if (!state.customer) payload.createdAt = serverTimestamp();
    await setDoc(ref, payload, { merge: true });
    state.customer = { ...(state.customer || {}), id: ref.id, ...payload };
    status.textContent = "Your contact details were saved.";
  } catch (error) {
    status.textContent = `Could not save your contact details: ${error.message || error}`;
  } finally {
    button.disabled = false;
    button.textContent = "Save contact details";
  }
}

async function prefillFromCustomer(user) {
  const banner = document.getElementById("signed-in-banner");
  const prevUid = state.user?.uid || null;
  state.user = user || null;
  state.customer = null;
  const nextUid = state.user?.uid || null;
  if (prevUid !== nextUid) {
    state.pastOrders = [];
    state.pastOrdersCursor = null;
    state.pastOrdersExhausted = false;
    state.pastOrdersLoaded = false;
    state.pastItemsByOrderId = {};
  }
  const accountLink = document.getElementById("account-link");
  if (accountLink) accountLink.textContent = user ? "My account" : "Sign in";
  const heroSignin = document.getElementById("hero-signin-row");
  if (heroSignin) heroSignin.classList.toggle("hidden", !!user);
  document.getElementById("update-account-details")?.classList.toggle("hidden", !user);
  if (!user) {
    if (banner) banner.textContent = "";
    if (prevUid) {
      const nameField = document.getElementById("form-customer-name");
      const phoneField = document.getElementById("form-phone");
      if (nameField) nameField.value = "";
      if (phoneField) phoneField.value = "";
    }
    await renderSavedAddressControl();
    return;
  }
  if (banner) {
    banner.innerHTML = `Signed in as <strong>${escapeHtml(user.email)}</strong>.`;
  }
  try {
    const snap = await getDocs(query(collection(db, "customers"), where("authUid", "==", user.uid)));
    if (snap.empty) {
      const nameField = document.getElementById("form-customer-name");
      if (nameField && !nameField.value) nameField.value = user.displayName || "";
      await renderSavedAddressControl();
      return;
    }
    const customer = { id: snap.docs[0].id, ...snap.docs[0].data() };
    state.customer = customer;
    const nameField = document.getElementById("form-customer-name");
    const phoneField = document.getElementById("form-phone");
    if (nameField && !nameField.value) nameField.value = customer.name || user.displayName || "";
    if (phoneField && !phoneField.value) phoneField.value = customer.phone || "";
    // The saved primary address is authoritative. Do not preserve a stale or
    // partially-entered address that happens to be in the form already.
    await renderSavedAddressControl();
  } catch (error) {
    console.warn("Could not prefill customer profile:", error);
    await renderSavedAddressControl();
  }
}

async function handleHeroGoogleSignIn() {
  const btn = document.getElementById("hero-google-signin-button");
  const statusNode = document.getElementById("hero-signin-status");
  if (!btn) return;
  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Signing in...";
  if (statusNode) statusNode.textContent = "Opening Google sign-in...";
  try {
    const result = await signInWithGoogleForEnvironment();
    if (!result && statusNode) statusNode.textContent = "Google sign-in cancelled.";
    if (statusNode) statusNode.textContent = "";
  } catch (error) {
    if (statusNode) statusNode.textContent = error.message || String(error);
  } finally {
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
}

// Owner-chosen customer catalog layout, set from /catalog.html and stored on
// settings/business.catalogLayout: "cards" (default) or "list".
function applyCatalogLayout() {
  const list = state.catalogLayout === "list";
  Object.values(categoryTargets).forEach((node) => {
    if (node) node.classList.toggle("catalog-list-mode", list);
  });
}

async function loadContactChannels() {
  const container = document.getElementById("contact-channels");
  if (!container) return;
  try {
    const snap = await getDoc(doc(db, "settings", "business"));
    const settings = snap.exists() ? snap.data() : {};
    state.catalogLayout = settings.catalogLayout === "list" ? "list" : "cards";
    applyCatalogLayout();
    const contact = settings.contact || {};
    const links = [
      contact.whatsapp
        ? `<a class="button-link primary" href="${escapeHtml(contact.whatsapp)}?text=${encodeURIComponent("Hello, I want to order water")}" target="_blank" rel="noopener">WhatsApp</a>`
        : "",
      contact.zalo
        ? `<a class="button-link primary" href="${escapeHtml(contact.zalo)}" target="_blank" rel="noopener">Zalo</a>`
        : "",
      contact.facebook
        ? `<a class="button-link primary" href="${escapeHtml(contact.facebook)}" target="_blank" rel="noopener">Facebook</a>`
        : ""
    ].filter(Boolean).join("");
    container.innerHTML = links || "";
  } catch (_) {
    container.innerHTML = "";
  }
}

function hideAppLoading() {
  const overlay = document.getElementById("app-loading");
  if (overlay) overlay.classList.add("hidden");
}

// Fallback: never keep the overlay up longer than 8s, even if a network
// call hangs. Users would rather see a half-populated page than a spinner
// they can't dismiss.
setTimeout(hideAppLoading, 8000);

document.getElementById("delivery-date").value = todayKey();
setDeliveryWindow(document.getElementById("delivery-window"), "");
if (isEmulatorMode) {
  document.getElementById("address-verify-button")?.classList.add("hidden");
  setAddressVerifyStatus("Local test mode — map confirmation is disabled.");
}
document.getElementById("public-order-form").addEventListener("submit", submitOrder);
document.getElementById("address-verify-button")?.addEventListener("click", verifyAddressOnMap);
document.getElementById("update-account-details")?.addEventListener("click", updateAccountFromPersonalDetails);
document.getElementById("saved-address-select")?.addEventListener("change", handleSavedAddressSelection);
document.getElementById("address-reset-pin")?.addEventListener("click", () => {
  clearDeliveryLocation("Pin reset — find this delivery address on the map again.");
  document.getElementById("address-verify-button")?.focus();
});
document.getElementById("form-address")?.addEventListener("input", () => {
  if (state.deliveryLocation) clearDeliveryLocation();
});

// Hide the overlay once BOTH the initial auth check has resolved AND the
// product catalog is on screen — that's the minimum "page is real" bar.
let authResolved = false;
let productsResolved = false;
const maybeReveal = () => {
  if (authResolved && productsResolved) hideAppLoading();
};
onAuthStateChanged(auth, async (user) => {
  try {
    await prefillFromCustomer(user);
  } finally {
    authResolved = true;
    maybeReveal();
  }
});
loadContactChannels();
loadProducts()
  .then(async () => {
    await applyReorderFromQuery();
  })
  .catch((error) => {
    document.getElementById("public-feedback").textContent = error && error.message ? error.message : String(error);
  })
  .finally(() => {
    productsResolved = true;
    maybeReveal();
  });

const heroGoogleBtn = document.getElementById("hero-google-signin-button");
if (heroGoogleBtn) heroGoogleBtn.addEventListener("click", handleHeroGoogleSignIn);

const reorderOpenBtn = document.getElementById("reorder-open-button");
if (reorderOpenBtn) reorderOpenBtn.addEventListener("click", openReorderDialog);
const reorderCloseBtn = document.getElementById("reorder-dialog-close");
if (reorderCloseBtn) reorderCloseBtn.addEventListener("click", closeReorderDialog);
const reorderLoadMoreBtn = document.getElementById("reorder-dialog-load-more");
if (reorderLoadMoreBtn) reorderLoadMoreBtn.addEventListener("click", loadMorePastOrders);
const reorderDialog = document.getElementById("reorder-dialog");
if (reorderDialog) {
  reorderDialog.addEventListener("click", (event) => {
    const thumb = event.target.closest(".order-thumb");
    if (thumb) {
      brieflyShowReorderThumbName(thumb);
      return;
    }
    if (event.target === reorderDialog) closeReorderDialog();
  });
  reorderDialog.addEventListener("keydown", (event) => {
    const thumb = event.target.closest(".order-thumb");
    if (!thumb || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    brieflyShowReorderThumbName(thumb);
  });
}

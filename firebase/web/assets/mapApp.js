import {
  auth,
  collection,
  db,
  doc,
  getDoc,
  getDocs,
  onAuthStateChanged,
  onSnapshot,
  query,
  serverTimestamp,
  signOut,
  where,
  writeBatch
} from "./firebaseClient.js";
import { mapsApiKey, mapsDefaultCenter } from "./firebaseWebConfig.js";
import { escapeHtml as escapeHtmlShared, productImageUrl, requireRole, todayKey } from "./shared.js";
import {
  humanizeContainerType,
  itemCountsForOrder,
  planItineraries,
  pickBestItinerary,
  renderRecommendedItinerary,
  tallyForOrders
} from "./routePlanning.js";

const APPROVED_STATUSES = ["new", "assigned", "out_for_delivery"];
const DRIVER_COLORS = [
  "#c0392b", "#2980b9", "#27ae60", "#8e44ad", "#d35400",
  "#16a085", "#c0641b", "#1f6da8", "#7d3c98", "#0e6251"
];
const UNASSIGNED_COLOR = "#7f8c8d";

const state = {
  drivers: [],
  driverColorById: {},
  orders: [],
  customers: {},
  addressLocations: {},
  driverFilter: "",
  statusFilter: "approved",
  map: null,
  markers: [],
  geocoder: null,
  mapsReady: false,
  // Trip-planner state:
  tripSelectionMode: false,
  selectedOrderIds: new Set(),
  warehouse: null,
  productContainerType: {},
  orderItemsByOrderId: {}
};

function normalizeAddress(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function orderMatchesCustomerAddress(order) {
  const customer = state.customers[order.customerId];
  if (!customer || !customer.address || !order.address) return false;
  return normalizeAddress(customer.address) === normalizeAddress(order.address);
}

function locationForOrder(order) {
  // Priority 1: the confirmed coordinates stored on the order. These preserve
  // the actual delivery entrance even if the customer's default address moves.
  const orderLoc = order.deliveryLocation;
  if (orderLoc && typeof orderLoc.lat === "number" && typeof orderLoc.lng === "number") {
    return orderLoc;
  }
  // Priority 2: the order's address geocoded during this map session.
  const key = normalizeAddress(order.address);
  if (key && state.addressLocations[key]) {
    return state.addressLocations[key];
  }
  // Priority 3: the customer's stored location, but ONLY if the order is
  // using the customer's default address. Otherwise the customer's home is
  // the wrong pin for this order.
  if (orderMatchesCustomerAddress(order)) {
    const customerLoc = state.customers[order.customerId]?.location;
    if (customerLoc && typeof customerLoc.lat === "number" && typeof customerLoc.lng === "number") {
      return customerLoc;
    }
  }
  return null;
}

function el(id) {
  return document.getElementById(id);
}

function setStatus(message) {
  const node = el("list-status");
  if (node) node.textContent = message || "";
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function phoneDigits(phone) {
  return String(phone || "").replace(/[^0-9+]/g, "");
}

function driverName(driverId) {
  const driver = state.drivers.find((d) => d.id === driverId);
  return driver ? driver.driverName : "Unassigned";
}

function driverColor(driverId) {
  if (!driverId) return UNASSIGNED_COLOR;
  return state.driverColorById[driverId] || UNASSIGNED_COLOR;
}

function humanizeStatus(status) {
  switch (status) {
    case "new": return "Approved";
    case "assigned": return "Assigned";
    case "out_for_delivery": return "Out for delivery";
    case "delivered": return "Delivered";
    default: return status || "unknown";
  }
}

function loadMapsSdk() {
  if (state.mapsReady) return Promise.resolve();
  if (!mapsApiKey) return Promise.reject(new Error("no-api-key"));
  return new Promise((resolve, reject) => {
    if (window.google && window.google.maps) {
      state.mapsReady = true;
      resolve();
      return;
    }
    const script = document.createElement("script");
    const params = new URLSearchParams({
      key: mapsApiKey,
      libraries: "marker",
      v: "weekly"
    });
    script.src = `https://maps.googleapis.com/maps/api/js?${params.toString()}`;
    script.async = true;
    script.defer = true;
    script.onload = () => {
      state.mapsReady = true;
      resolve();
    };
    script.onerror = () => reject(new Error("Maps SDK failed to load"));
    document.head.appendChild(script);
  });
}

function initMap() {
  const canvas = el("map-canvas");
  if (!canvas) return;
  state.map = new google.maps.Map(canvas, {
    center: mapsDefaultCenter,
    zoom: 13,
    mapTypeControl: false,
    streetViewControl: false,
    fullscreenControl: true
  });
  state.geocoder = new google.maps.Geocoder();
}

function clearMarkers() {
  state.markers.forEach((m) => m.setMap(null));
  state.markers = [];
}

function pinSvg(color, selected = false) {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="28" height="40" viewBox="0 0 28 40">
      <path d="M14 0 C6 0 0 6 0 14 c0 10 14 26 14 26 s14-16 14-26 C28 6 22 0 14 0 z" fill="${color}" stroke="${selected ? "#172033" : "white"}" stroke-width="${selected ? "3" : "2"}"/>
      <circle cx="14" cy="14" r="5" fill="white"/>
      ${selected ? `<path d="M10.5 14 L13 16.5 L17.8 11.7" fill="none" stroke="${color}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>` : ""}
    </svg>`;
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}

function makeInfoWindowHtml(order) {
  const customer = state.customers[order.customerId] || {};
  const phone = order.phone || customer.phone || "";
  const phoneLine = phone
    ? `<div><a href="tel:${escapeHtml(phoneDigits(phone))}">${escapeHtml(phone)}</a></div>`
    : "";
  const boardHref = `./order.html?id=${encodeURIComponent(order.id)}`;
  return `
    <div style="min-width:180px;max-width:240px;font-family:inherit">
      <strong>${escapeHtml(order.customerName || customer.name || "Unknown")}</strong>
      <div style="font-family:monospace;font-size:11px;margin-top:2px">
        <a href="${boardHref}">${escapeHtml(order.id)}</a>
      </div>
      <div style="color:#555;margin-top:4px">${escapeHtml(order.address || customer.address || "")}</div>
      ${phoneLine}
      <div style="margin-top:6px;font-size:12px">
        ${escapeHtml(humanizeStatus(order.status))} · ${escapeHtml(driverName(order.assignedDriverId))}
      </div>
      <div style="margin-top:8px;font-size:12px">
        <a href="${boardHref}">Open order</a>
      </div>
    </div>`;
}

function renderMarkers(orders, fitViewport = true) {
  clearMarkers();
  if (!state.map) return;
  const bounds = new google.maps.LatLngBounds();
  const info = new google.maps.InfoWindow();
  let placed = 0;
  const seenPositions = new Map();
  orders.forEach((order) => {
    const loc = locationForOrder(order);
    if (!loc) return;
    const key = `${loc.lat.toFixed(5)},${loc.lng.toFixed(5)}`;
    const dupIndex = seenPositions.get(key) || 0;
    seenPositions.set(key, dupIndex + 1);
    // Jitter overlapping pins in a small ring so all are individually clickable.
    // Roughly ~10m per unit at Da Nang latitude.
    let lat = loc.lat;
    let lng = loc.lng;
    if (dupIndex > 0) {
      const angle = (dupIndex * 2 * Math.PI) / 8;
      lat += 0.00008 * Math.cos(angle);
      lng += 0.00008 * Math.sin(angle);
    }
    const position = { lat, lng };
    const selected = state.selectedOrderIds.has(order.id);
    const marker = new google.maps.Marker({
      position,
      map: state.map,
      title: state.tripSelectionMode
        ? `${selected ? "Remove" : "Add"} ${order.customerName || "order"} ${selected ? "from" : "to"} trip`
        : order.customerName || "",
      icon: {
        url: pinSvg(driverColor(order.assignedDriverId), selected),
        scaledSize: new google.maps.Size(28, 40),
        anchor: new google.maps.Point(14, 40)
      }
    });
    marker.addListener("click", () => {
      if (state.tripSelectionMode) {
        toggleOrderSelection(order.id);
        return;
      }
      info.setContent(makeInfoWindowHtml(order));
      info.open({ anchor: marker, map: state.map });
    });
    state.markers.push(marker);
    bounds.extend(position);
    placed += 1;
  });
  if (placed > 0 && fitViewport) {
    state.map.fitBounds(bounds, { top: 80, right: 60, bottom: 80, left: 60 });
    if (placed === 1) {
      // Single pin — nudge to a neighbourhood zoom rather than a whole-city one.
      google.maps.event.addListenerOnce(state.map, "idle", () => {
        if (state.map.getZoom() > 14) state.map.setZoom(14);
      });
    } else {
      // Multi-pin — never zoom in past a comfortable read.
      google.maps.event.addListenerOnce(state.map, "idle", () => {
        if (state.map.getZoom() > 15) state.map.setZoom(15);
      });
    }
  }
  return placed;
}

function renderLegend() {
  const container = el("map-legend");
  if (!container) return;
  const active = new Set(state.orders.map((o) => o.assignedDriverId || "__unassigned__"));
  const items = [];
  state.drivers.forEach((driver) => {
    if (!active.has(driver.id)) return;
    items.push(`<span><span class="swatch" style="background:${driverColor(driver.id)}"></span>${escapeHtml(driver.driverName)}</span>`);
  });
  if (active.has("__unassigned__") || active.has(null) || active.has(undefined)) {
    items.push(`<span><span class="swatch" style="background:${UNASSIGNED_COLOR}"></span>Unassigned</span>`);
  }
  container.innerHTML = items.join("");
}

function renderRows(orders) {
  const tbody = el("order-rows");
  if (!tbody) return;
  const table = tbody.closest("table");
  if (table) table.classList.toggle("trip-selection-active", state.tripSelectionMode);
  if (!orders.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="muted" style="padding:20px;text-align:center">No matching active orders.</td></tr>`;
    return;
  }
  tbody.innerHTML = orders.map((order) => {
    const customer = state.customers[order.customerId] || {};
    const phone = order.phone || customer.phone || "";
    const phoneCell = phone
      ? `<a href="tel:${escapeHtml(phoneDigits(phone))}">${escapeHtml(phone)}</a>`
      : "";
    const fullAddress = order.address || customer.address || "";
    const address = compactMapAddress(fullAddress);
    const mapsHref = fullAddress
      ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(fullAddress)}`
      : "";
    const hasPin = Boolean(locationForOrder(order));
    const pinMark = hasPin
      ? `<span title="Pinned on map" style="color:${driverColor(order.assignedDriverId)}">●</span>`
      : `<span title="No pin — geocoding failed or address missing" class="muted">○</span>`;
    const boardHref = `./order.html?id=${encodeURIComponent(order.id)}`;
    const selected = state.selectedOrderIds.has(order.id);
    const selectionLabel = selected ? "Remove from trip" : "Add to trip";
    return `
      <tr data-order-id="${escapeHtml(order.id)}" class="${selected ? "trip-selected-row" : ""}">
        <td class="trip-select-column">
          <input class="trip-select-checkbox" type="checkbox" data-trip-order-id="${escapeHtml(order.id)}"
            aria-label="${selectionLabel}: ${escapeHtml(order.customerName || customer.name || order.id)}"
            ${selected ? "checked" : ""} ${hasPin ? "" : 'disabled title="A confirmed map pin is required"'}>
        </td>
        <td class="map-customer-name">${escapeHtml(order.customerName || customer.name || "Unknown")}</td>
        <td data-label="Products">${renderMapOrderThumbs(order.id)}</td>
        <td data-label="Delivery">${renderDeliveryDate(order.deliveryDate)}</td>
        <td data-label="Phone">${phoneCell}</td>
        <td data-label="Address" class="map-address-cell">${pinMark} ${mapsHref ? `<a class="row-link address-map-link" href="${mapsHref}" target="_blank" rel="noopener" title="Open in Google Maps" aria-label="Open ${escapeHtml(fullAddress)} in Google Maps">${formatMapAddress(address)}</a>` : formatMapAddress(address)}</td>
        <td data-label="Order ID" style="font-family:monospace;font-size:12px"><a href="${boardHref}">${formatOrderId(order.id)}</a></td>
        <td data-label="Driver">${escapeHtml(driverName(order.assignedDriverId))}</td>
      </tr>
    `;
  }).join("");
}

function renderDeliveryDate(value) {
  const date = String(value || "").trim();
  if (!date) return `<span class="muted">—</span>`;
  const today = todayKey();
  if (date < today) return `<span class="map-delivery-date is-overdue">Overdue<br>${escapeHtml(date)}</span>`;
  if (date === today) return `<span class="map-delivery-date is-today">Today</span>`;
  return `<span class="map-delivery-date">${escapeHtml(date)}</span>`;
}

function renderMapOrderThumbs(orderId) {
  const items = state.orderItemsByOrderId[orderId] || [];
  if (!items.length) return `<span class="muted">—</span>`;
  return `<div class="map-order-thumbs">${items.map((item) => {
    const name = String(item.productName || "Product");
    const url = productImageUrl(name);
    const qty = Number(item.quantity || 0);
    const title = qty > 1 ? `${name} ×${qty}` : name;
    return url ? `
      <span class="map-order-product" role="button" tabindex="0" data-product-title="${escapeHtml(title)}" aria-label="Show product name: ${escapeHtml(title)}">
        <img class="map-order-product-image" src="${escapeHtml(url)}" alt="" loading="lazy">
        ${qty > 1 ? `<span class="map-order-product-badge">×${qty}</span>` : ""}
      </span>
    ` : "";
  }).join("")}</div>`;
}

let mapProductNameTimer = null;

function showMapProductName(product) {
  let toast = document.getElementById("map-product-name-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "map-product-name-toast";
    toast.className = "map-product-name-toast";
    toast.setAttribute("role", "status");
    document.body.appendChild(toast);
  }
  toast.textContent = product.dataset.productTitle || "Product";
  toast.classList.add("is-visible");
  if (mapProductNameTimer) clearTimeout(mapProductNameTimer);
  mapProductNameTimer = setTimeout(() => toast.classList.remove("is-visible"), 5000);
}

document.addEventListener("click", (event) => {
  const product = event.target.closest(".map-order-product");
  if (product) showMapProductName(product);
});

document.addEventListener("keydown", (event) => {
  const product = event.target.closest(".map-order-product");
  if (!product || (event.key !== "Enter" && event.key !== " ")) return;
  event.preventDefault();
  showMapProductName(product);
});

function compactMapAddress(address) {
  return String(address || "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part && !/^(?:da nang|đà nẵng)(?:\s+\d{5,6})?$/i.test(part) && !/^(?:viet ?nam|việt ?nam)$/i.test(part))
    .map((part) => part.replace(/\s+\d{5,6}$/, "").trim())
    .filter(Boolean)
    .join(", ");
}

function formatMapAddress(address) {
  const parts = String(address || "").split(", ");
  const street = parts.shift() || "";
  const remainder = parts.join(", ");
  return `${escapeHtml(street)}${remainder ? `<br>${escapeHtml(remainder)}` : ""}`;
}

function formatOrderId(orderId) {
  return escapeHtml(String(orderId || "")).replace(/-/g, "-<br>");
}

function statusesForFilter() {
  if (state.statusFilter === "approved") return APPROVED_STATUSES;
  return [state.statusFilter];
}

function filteredOrders() {
  return state.orders.filter((order) => {
    const wantedStatuses = statusesForFilter();
    if (!wantedStatuses.includes(order.status)) return false;
    if (state.driverFilter === "__unassigned__") {
      if (order.assignedDriverId) return false;
    } else if (state.driverFilter) {
      if (order.assignedDriverId !== state.driverFilter) return false;
    }
    return true;
  });
}

function selectedOrders() {
  return state.orders.filter((order) => state.selectedOrderIds.has(order.id));
}

function selectableOrders(orders) {
  return orders.filter((order) => Boolean(locationForOrder(order)));
}

function toggleOrderSelection(orderId) {
  const order = state.orders.find((candidate) => candidate.id === orderId);
  if (!order || !locationForOrder(order)) return;
  if (state.selectedOrderIds.has(orderId)) state.selectedOrderIds.delete(orderId);
  else state.selectedOrderIds.add(orderId);
  render({ preserveMapViewport: true });
}

function clearTripSelection() {
  state.selectedOrderIds.clear();
  render({ preserveMapViewport: true });
}

function selectAllFilteredOrders() {
  selectableOrders(filteredOrders()).forEach((order) => state.selectedOrderIds.add(order.id));
  state.tripSelectionMode = true;
  render({ preserveMapViewport: true });
}

function renderTripSelection(visibleOrders) {
  const buildButton = el("build-trip-button");
  const bar = el("trip-selection-bar");
  const summary = el("trip-selection-summary");
  const detail = el("trip-selection-detail");
  const selectAllButton = el("select-filtered-button");
  const clearButton = el("clear-trip-selection-button");
  if (!buildButton || !bar || !summary || !detail || !selectAllButton || !clearButton) return;

  const selected = selectedOrders();
  const visibleIds = new Set(visibleOrders.map((order) => order.id));
  const hiddenCount = selected.filter((order) => !visibleIds.has(order.id)).length;
  const selectableVisible = selectableOrders(visibleOrders);
  const unselectedVisible = selectableVisible.filter((order) => !state.selectedOrderIds.has(order.id));
  const demand = tallyForOrders(selected, state.orderItemsByOrderId, state.productContainerType);
  const demandChunks = Object.entries(demand)
    .filter(([, qty]) => Number(qty) > 0)
    .map(([type, qty]) => `${qty} ${humanizeContainerType(type).toLowerCase()}`);

  buildButton.setAttribute("aria-pressed", String(state.tripSelectionMode));
  buildButton.textContent = state.tripSelectionMode ? "Stop selecting" : "Build a trip";
  bar.classList.toggle("hidden", !state.tripSelectionMode && selected.length === 0);
  summary.textContent = selected.length
    ? `${selected.length} stop${selected.length === 1 ? "" : "s"} selected`
    : "No stops selected";
  const details = [];
  if (demandChunks.length) details.push(demandChunks.join(" · "));
  if (hiddenCount) details.push(`${hiddenCount} hidden by the current filters`);
  if (!selected.length) details.push("Select orders from the list or map pins.");
  detail.textContent = details.join(" · ");
  selectAllButton.textContent = unselectedVisible.length
    ? `Select all shown (${selectableVisible.length})`
    : "All shown selected";
  selectAllButton.disabled = !state.tripSelectionMode || unselectedVisible.length === 0;
  clearButton.disabled = selected.length === 0;
}

function renderMissingBanner(orders, placedCount) {
  const banner = el("missing-banner");
  if (!banner) return;
  const missing = orders.length - placedCount;
  if (missing <= 0) {
    banner.style.display = "none";
    banner.textContent = "";
    return;
  }
  banner.style.display = "block";
  banner.textContent = `${missing} of ${orders.length} matching order${orders.length === 1 ? "" : "s"} could not be pinned. Open the customer profile and check the address; the pin will fill in next time.`;
}

// Planner readiness: needs a single specific driver picked, that driver's
// loadout saved in Settings, a warehouse origin, and at least one selected
// stop. When a prerequisite is missing we explain it and disable planning.
function plannerPrereqIssues() {
  const issues = [];
  if (!state.driverFilter || state.driverFilter === "__unassigned__") {
    issues.push('Pick a single driver above (not "All drivers" or Unassigned).');
  }
  if (!state.warehouse || !state.warehouse.location) {
    issues.push('No warehouse origin — add one in <a href="./settings.html">Settings → Warehouse</a>.');
  }
  const driver = state.drivers.find((d) => d.id === state.driverFilter);
  const loadout = driver?.standardLoadout || {};
  if (state.driverFilter && !Object.values(loadout).some((v) => Number(v) > 0)) {
    issues.push('This driver has no loadout — set one in <a href="./settings.html">Settings → Drivers & loadouts</a>.');
  }
  return issues;
}

function renderPlannerHint() {
  const button = el("plan-trips-button");
  const hint = el("planner-hint");
  const cap = el("planner-capacity");
  const results = el("planner-results");
  if (!button || !hint) return;

  const issues = plannerPrereqIssues();
  if (issues.length) {
    button.disabled = true;
    hint.innerHTML = issues.map((i) => `• ${i}`).join("<br>");
    cap.innerHTML = "";
    results.innerHTML = "";
    return;
  }
  const driver = state.drivers.find((d) => d.id === state.driverFilter);
  const loadout = driver?.standardLoadout || {};
  const selected = selectedOrders();
  const pinnedOrders = selected.filter((order) => Boolean(locationForOrder(order)));
  const missing = selected.length - pinnedOrders.length;

  if (!selected.length) {
    button.disabled = true;
    hint.textContent = "Select Build a trip, then choose orders from the list or tap their map pins.";
    cap.innerHTML = "";
    results.innerHTML = "";
    return;
  }

  button.disabled = pinnedOrders.length === 0;
  const demand = tallyForOrders(pinnedOrders, state.orderItemsByOrderId, state.productContainerType);
  const demandChunks = Object.entries(demand)
    .filter(([, qty]) => qty > 0)
    .map(([type, qty]) => `<strong>${qty}</strong> ${escapeHtmlShared(humanizeContainerType(type).toLowerCase())}`);
  hint.innerHTML = `Ready to plan <strong>${escapeHtmlShared(driver.driverName)}</strong>'s trip — <strong>${pinnedOrders.length}</strong> selected stop${pinnedOrders.length === 1 ? "" : "s"}${missing ? ` (${missing} skipped — no pin)` : ""}${demandChunks.length ? ` demanding ${demandChunks.join(" · ")}` : ""}.`;

  const loadoutChips = Object.entries(loadout)
    .filter(([, v]) => Number(v) > 0)
    .map(([type, cap]) => `<span class="loadout-chip">${escapeHtmlShared(humanizeContainerType(type))} <strong>${cap}</strong></span>`)
    .join("");
  cap.innerHTML = loadoutChips ? `<div class="loadout-chips">${loadoutChips}</div>` : "";
}

function render(options = {}) {
  const orders = filteredOrders();
  renderRows(orders);
  renderLegend();
  const placed = state.map ? renderMarkers(orders, !options.preserveMapViewport) : 0;
  renderMissingBanner(orders, placed || 0);
  renderTripSelection(orders);
  renderPlannerHint();
  // Any filter/data change invalidates a previously-planned itinerary —
  // clear it so the driver doesn't act on stale ordering.
  const results = el("planner-results");
  if (results) results.innerHTML = "";
  setStatus(`${orders.length} matching active order${orders.length === 1 ? "" : "s"}. Older active orders stay visible until they are completed or cancelled.`);
}

async function runPlanner() {
  const issues = plannerPrereqIssues();
  if (issues.length) return;
  const driver = state.drivers.find((d) => d.id === state.driverFilter);
  const loadout = driver?.standardLoadout || {};
  const warehouseLoc = state.warehouse.location;
  const pinnedOrders = selectedOrders().filter((order) => Boolean(locationForOrder(order)));
  if (!pinnedOrders.length) return;

  const stops = pinnedOrders.map((order) => {
    const location = locationForOrder(order);
    return {
      orderId: order.id,
      customerName: order.customerName,
      address: order.address,
      location: { lat: location.lat, lng: location.lng },
      counts: itemCountsForOrder(order, state.orderItemsByOrderId, state.productContainerType)
    };
  });

  const itineraries = planItineraries(stops, warehouseLoc, loadout);
  const best = pickBestItinerary(itineraries);
  el("planner-results").innerHTML = renderRecommendedItinerary(best, warehouseLoc);
}

async function loadDrivers() {
  const snap = await getDocs(collection(db, "drivers"));
  state.drivers = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  state.driverColorById = {};
  state.drivers.forEach((driver, idx) => {
    state.driverColorById[driver.id] = DRIVER_COLORS[idx % DRIVER_COLORS.length];
  });
  const select = el("driver-filter");
  const preserved = select.value;
  select.innerHTML = '<option value="">All drivers</option><option value="__unassigned__">Unassigned</option>'
    + state.drivers.filter((d) => d.active !== false).map((d) => `<option value="${escapeHtml(d.id)}">${escapeHtml(d.driverName)}</option>`).join("");
  if (preserved) {
    select.value = preserved;
    return;
  }
  // Default the dropdown to Matt (the default driver in the current setup)
  // so the planner is one click closer to useful. Falls back gracefully if
  // Matt isn't in the roster.
  const matt = state.drivers.find((d) => /matt/i.test(d.driverName || ""));
  if (matt) {
    select.value = matt.id;
    state.driverFilter = matt.id;
  }
}

async function loadPlannerSetup() {
  const [productsSnap, warehouseSnap] = await Promise.all([
    getDocs(collection(db, "products")),
    getDoc(doc(db, "settings", "business"))
  ]);
  productsSnap.docs.forEach((d) => {
    state.productContainerType[d.id] = d.data().containerType || "unit";
  });
  const settings = warehouseSnap.exists() ? warehouseSnap.data() : {};
  state.warehouse = settings.warehouse || null;
}

async function loadOrderItemsForOrders(orders) {
  const itemsByOrderId = {};
  if (!orders.length) return itemsByOrderId;
  const orderIds = orders.map((o) => o.id);
  for (let i = 0; i < orderIds.length; i += 30) {
    const chunk = orderIds.slice(i, i + 30);
    const snap = await getDocs(query(
      collection(db, "orderItems"),
      where("orderId", "in", chunk)
    ));
    snap.docs.forEach((docSnap) => {
      const item = { id: docSnap.id, ...docSnap.data() };
      if (!itemsByOrderId[item.orderId]) itemsByOrderId[item.orderId] = [];
      itemsByOrderId[item.orderId].push(item);
    });
  }
  return itemsByOrderId;
}

async function loadReferencedCustomers(orders = state.orders) {
  const customerIds = Array.from(new Set(orders.map((o) => o.customerId).filter(Boolean)));
  const toFetch = customerIds.filter((id) => !state.customers[id]);
  await Promise.all(toFetch.map(async (id) => {
    try {
      const snap = await getDoc(doc(db, "customers", id));
      if (snap.exists()) state.customers[id] = { id, ...snap.data() };
    } catch (_) {
      // Ignore — the address on the order itself will still show in the list.
    }
  }));
}

function geocodeAddress(address) {
  return new Promise((resolve) => {
    state.geocoder.geocode({ address, region: "vn" }, (results, status) => {
      if (status === "OK" && results && results.length) {
        const loc = results[0].geometry.location;
        resolve({ lat: loc.lat(), lng: loc.lng(), formattedAddress: results[0].formatted_address });
      } else {
        resolve(null);
      }
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function backfillMissingLocations() {
  if (!state.mapsReady || !state.geocoder) return;

  // Pass 1: customer docs that lack a location — geocode + persist.
  const customerPending = [];
  Object.values(state.customers).forEach((customer) => {
    if (!customer) return;
    const loc = customer.location;
    if (loc && typeof loc.lat === "number" && typeof loc.lng === "number") return;
    const orderAddress = state.orders
      .filter((o) => o.customerId === customer.id)
      .map((o) => o.address)
      .find(Boolean);
    const address = customer.address || orderAddress;
    if (!address) return;
    customerPending.push({ customer, address });
  });

  // Pass 2: orders where the order's own address should drive the pin — either
  // no customer, no customer.location, or the order's address doesn't match
  // the customer's stored default (a one-time delivery or an edited order).
  // Geocode by the order's address and cache in-memory by normalized address.
  const seenAddresses = new Set();
  const orderPending = [];
  state.orders.forEach((order) => {
    const confirmed = order.deliveryLocation;
    if (confirmed && typeof confirmed.lat === "number" && typeof confirmed.lng === "number") return;
    const key = normalizeAddress(order.address);
    if (!key || seenAddresses.has(key)) return;
    if (state.addressLocations[key]) return;
    // If this order uses the customer's default address AND the customer has
    // a persisted location, we can just reuse it — no need to spend a geocode.
    if (orderMatchesCustomerAddress(order)) {
      const cLoc = state.customers[order.customerId]?.location;
      if (cLoc && typeof cLoc.lat === "number" && typeof cLoc.lng === "number") {
        return;
      }
    }
    seenAddresses.add(key);
    orderPending.push({ addressKey: key, address: order.address });
  });

  const totalPending = customerPending.length + orderPending.length;
  if (!totalPending) return;
  setStatus(`Geocoding ${totalPending} address${totalPending === 1 ? "" : "es"}...`);

  const batch = writeBatch(db);
  let batched = 0;

  for (const { customer, address } of customerPending) {
    const result = await geocodeAddress(address);
    if (result) {
      customer.location = { lat: result.lat, lng: result.lng, formattedAddress: result.formattedAddress };
      state.addressLocations[normalizeAddress(address)] = customer.location;
      batch.update(doc(db, "customers", customer.id), {
        location: {
          lat: result.lat,
          lng: result.lng,
          formattedAddress: result.formattedAddress,
          geocodedAt: new Date().toISOString()
        },
        updatedAt: serverTimestamp()
      });
      batched += 1;
      render();
    }
    await sleep(120);
  }

  for (const { addressKey, address } of orderPending) {
    const result = await geocodeAddress(address);
    if (result) {
      state.addressLocations[addressKey] = {
        lat: result.lat,
        lng: result.lng,
        formattedAddress: result.formattedAddress
      };
      render();
    }
    await sleep(120);
  }

  if (batched > 0) {
    try {
      await batch.commit();
    } catch (error) {
      console.warn("Failed to persist geocoded locations:", error);
    }
  }
}

let ordersUnsub = null;
let ordersWatchGeneration = 0;
let ordersApplySequence = 0;

function activeOrdersQuery() {
  return query(collection(db, "orders"), where("status", "in", APPROVED_STATUSES));
}

function ordersFromSnapshot(snapshot) {
  return snapshot.docs
    .map((row) => ({ id: row.id, ...row.data() }))
    .filter((order) => APPROVED_STATUSES.includes(order.status))
    .sort((a, b) => String(a.deliveryDate || "9999-12-31").localeCompare(String(b.deliveryDate || "9999-12-31"))
      || String(a.id).localeCompare(String(b.id)));
}

async function applyOrdersSnapshot(snapshot, generation) {
  const requestId = ++ordersApplySequence;
  const orders = ordersFromSnapshot(snapshot);
  const [, itemsByOrderId] = await Promise.all([
    loadReferencedCustomers(orders),
    loadOrderItemsForOrders(orders)
  ]);
  if (generation !== ordersWatchGeneration || requestId !== ordersApplySequence) return;
  state.orders = orders;
  state.orderItemsByOrderId = itemsByOrderId;
  const activeIds = new Set(orders.map((order) => order.id));
  Array.from(state.selectedOrderIds).forEach((orderId) => {
    if (!activeIds.has(orderId)) state.selectedOrderIds.delete(orderId);
  });
  render();
  if (state.mapsReady) {
    await backfillMissingLocations();
    if (generation !== ordersWatchGeneration || requestId !== ordersApplySequence) return;
    render();
  }
}

function stopOrdersWatch() {
  ordersWatchGeneration += 1;
  ordersApplySequence += 1;
  if (ordersUnsub) {
    ordersUnsub();
    ordersUnsub = null;
  }
}

function watchOrders() {
  stopOrdersWatch();
  const generation = ordersWatchGeneration;
  setStatus("Loading orders and starting live updates...");
  let settled = false;
  return new Promise((resolve) => {
    const settle = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    ordersUnsub = onSnapshot(activeOrdersQuery(), (snapshot) => {
      applyOrdersSnapshot(snapshot, generation)
        .then(settle)
        .catch((error) => {
          if (generation === ordersWatchGeneration) setStatus(`Could not update map: ${error.message || error}`);
          settle();
        });
    }, (error) => {
      if (generation === ordersWatchGeneration) {
        setStatus(`Live updates stopped: ${error.message || error}. Select Refresh to reconnect.`);
      }
      settle();
    });
  });
}

function initFilters() {
  el("status-filter").value = state.statusFilter;
  el("driver-filter").addEventListener("change", (event) => {
    state.driverFilter = event.target.value;
    state.selectedOrderIds.clear();
    state.tripSelectionMode = false;
    render();
  });
  el("status-filter").addEventListener("change", (event) => {
    state.statusFilter = event.target.value;
    render();
  });
  el("build-trip-button").addEventListener("click", () => {
    state.tripSelectionMode = !state.tripSelectionMode;
    render({ preserveMapViewport: true });
  });
  el("select-filtered-button").addEventListener("click", selectAllFilteredOrders);
  el("clear-trip-selection-button").addEventListener("click", clearTripSelection);
  el("refresh-button").addEventListener("click", watchOrders);
  el("plan-trips-button").addEventListener("click", runPlanner);

  el("order-rows").addEventListener("change", (event) => {
    const checkbox = event.target.closest("[data-trip-order-id]");
    if (checkbox) toggleOrderSelection(checkbox.dataset.tripOrderId);
  });
  el("order-rows").addEventListener("click", (event) => {
    if (!state.tripSelectionMode) return;
    if (event.target.closest("a, button, input, select, textarea, .map-order-product")) return;
    const row = event.target.closest("tr[data-order-id]");
    if (row) toggleOrderSelection(row.dataset.orderId);
  });
}

async function bootstrap() {
  initFilters();
  await Promise.all([loadDrivers(), loadPlannerSetup()]);
  if (!mapsApiKey) {
    el("map-config-needed").style.display = "block";
    el("map-canvas").style.display = "none";
    setStatus("Map is disabled until an API key is configured. List view still works below.");
    await watchOrders();
    return;
  }
  try {
    await loadMapsSdk();
    initMap();
  } catch (error) {
    el("map-config-needed").style.display = "block";
    el("map-canvas").style.display = "none";
    console.error("Maps SDK failed:", error);
  }
  await watchOrders();
}

onAuthStateChanged(auth, async (user) => {
  const authView = el("auth-view");
  const appView = el("app-view");
  if (!user) {
    stopOrdersWatch();
    authView.classList.remove("hidden");
    appView.classList.add("hidden");
    return;
  }
  if (!(await requireRole(user, "owner"))) {
    stopOrdersWatch();
    return;
  }
  authView.classList.add("hidden");
  appView.classList.remove("hidden");
  el("auth-email").textContent = user.email || user.uid;
  await bootstrap();
});

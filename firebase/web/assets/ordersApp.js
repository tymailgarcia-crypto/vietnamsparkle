import {
  auth,
  collection,
  db,
  doc,
  getDocs,
  onAuthStateChanged,
  serverTimestamp,
  signOut,
  updateDoc
} from "./firebaseClient.js";
import { formatCurrency, formatOrderStatus, productImageUrl, renderImportanceButton, renderImportantNote, renderOrderContactMenu, requireRole, withSubmitLock } from "./shared.js";
import { importantNoteIsValid, normalizeImportantNote } from "./adminDashboardModel.js";
import { mapsApiKey } from "./firebaseWebConfig.js";

const state = {
  orders: [],
  orderItems: [],
  payments: [],
  products: [],
  search: "",
  status: "",
  dateFrom: "",
  dateTo: "",
  sort: "delivery-desc",
  view: localStorage.getItem("orders-view") || "cards"
};

const mapsSdkState = { ready: false, loadPromise: null };
let mapPreviewObserver = null;
let expandedOrderMap = null;
let expandedOrderMarker = null;

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

function deliveryPosition(order) {
  const location = order?.deliveryLocation;
  const rawLat = location?.lat ?? location?.latitude;
  const rawLng = location?.lng ?? location?.longitude;
  if (rawLat == null || rawLng == null) return null;
  const lat = Number(rawLat);
  const lng = Number(rawLng);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

function loadMapsSdk() {
  if (mapsSdkState.ready) return Promise.resolve();
  if (mapsSdkState.loadPromise) return mapsSdkState.loadPromise;
  if (!mapsApiKey) return Promise.reject(new Error("Google Maps is not configured."));
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
    script.onload = () => {
      mapsSdkState.ready = true;
      resolve();
    };
    script.onerror = () => reject(new Error("Maps SDK failed to load"));
    document.head.appendChild(script);
  });
  return mapsSdkState.loadPromise;
}

function renderLocationPreview(order) {
  const position = deliveryPosition(order);
  if (!position) return "";
  const customer = order.customerName || "customer";
  return `
    <button class="order-location-preview" type="button"
      data-map-order="${escapeHtml(order.id)}"
      data-map-lat="${position.lat}"
      data-map-lng="${position.lng}"
      aria-label="View a larger map for ${escapeHtml(customer)}">
      <span class="order-location-preview-map" aria-hidden="true"></span>
      <span class="order-location-preview-label">Tap to enlarge</span>
    </button>`;
}

async function hydrateMapPreview(button) {
  if (button.dataset.mapReady === "true") return;
  button.dataset.mapReady = "true";
  try {
    await loadMapsSdk();
    if (!button.isConnected) return;
    const position = {
      lat: Number(button.dataset.mapLat),
      lng: Number(button.dataset.mapLng)
    };
    const canvas = button.querySelector(".order-location-preview-map");
    const map = new google.maps.Map(canvas, {
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

function initializeMapPreviews() {
  if (mapPreviewObserver) mapPreviewObserver.disconnect();
  const previews = Array.from(el("order-cards").querySelectorAll("[data-map-order]"));
  if (!previews.length) return;
  if (!("IntersectionObserver" in window)) {
    previews.forEach((button) => hydrateMapPreview(button));
    return;
  }
  mapPreviewObserver = new IntersectionObserver((entries, observer) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      observer.unobserve(entry.target);
      hydrateMapPreview(entry.target);
    });
  }, { rootMargin: "180px 0px" });
  previews.forEach((button) => mapPreviewObserver.observe(button));
}

async function openOrderMap(order) {
  const position = deliveryPosition(order);
  if (!position) return;
  const dialog = el("orders-map-dialog");
  const status = el("orders-map-status");
  const directions = el("orders-map-directions");
  el("orders-map-customer").textContent = order.customerName || "Customer";
  el("orders-map-address").textContent = order.address || "No delivery address";
  status.textContent = "Loading map...";
  directions.hidden = true;
  dialog.showModal();
  try {
    await loadMapsSdk();
    expandedOrderMap = expandedOrderMap || new google.maps.Map(el("orders-map-canvas"), {
      center: position,
      zoom: 16,
      streetViewControl: false,
      mapTypeControl: false,
      fullscreenControl: true
    });
    expandedOrderMap.setCenter(position);
    expandedOrderMap.setZoom(16);
    google.maps.event.trigger(expandedOrderMap, "resize");
    if (expandedOrderMarker) expandedOrderMarker.setMap(null);
    expandedOrderMarker = new google.maps.Marker({
      map: expandedOrderMap,
      position,
      title: order.customerName || order.address || "Delivery location"
    });
    directions.href = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(`${position.lat},${position.lng}`)}`;
    directions.hidden = false;
    status.textContent = order.deliveryLocation?.formattedAddress || "Confirmed delivery pin";
  } catch (error) {
    status.textContent = error.message || String(error);
  }
}

function productForOrderItem(item) {
  return state.products.find((product) => product.id === item.productId)
    || state.products.find((product) => product.productName === item.productName)
    || item.productName;
}

function renderOrderItemThumbs(order) {
  const items = state.orderItems.filter((item) => item.orderId === order.id);
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
  return thumbs ? `<div class="map-order-thumbs order-card-item-thumbs" aria-label="Ordered items">${thumbs}</div>` : "";
}

function renderProofThumbs(order) {
  const proofs = state.payments.filter((payment) => payment.orderId === order.id && payment.proofUrl);
  if (!proofs.length) return "";
  return `
    <div class="proof-thumbs order-card-proof-thumbs" aria-label="Payment proofs">
      ${proofs.map((payment) => `
        <button class="ghost" type="button" data-proof-preview="${escapeHtml(payment.proofUrl)}" data-proof-amount="${escapeHtml(formatCurrency(payment.amount))}" title="Preview payment proof — ${escapeHtml(formatCurrency(payment.amount))}">
          <img src="${escapeHtml(payment.proofUrl)}" alt="Payment proof for ${escapeHtml(order.id)}" loading="lazy">
        </button>
      `).join("")}
    </div>`;
}

function openProofPreview(button) {
  const url = button.dataset.proofPreview;
  if (!url) return;
  el("proof-preview-title").textContent = `Payment proof · ${button.dataset.proofAmount || ""}`;
  el("proof-preview-image").src = url;
  el("proof-preview-new-tab").href = url;
  el("proof-preview-dialog").showModal();
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
  const cards = el("order-cards");
  const filtered = sortRows(
    state.orders.filter((order) => matchesSearch(order) && matchesStatus(order) && matchesDate(order))
  );
  const filtersActive = state.search || state.status || state.dateFrom || state.dateTo;
  setStatus(filtersActive
    ? `Showing ${filtered.length} of ${state.orders.length} orders.`
    : `${state.orders.length} order${state.orders.length === 1 ? "" : "s"} on file.`);

  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="muted" style="padding:20px;text-align:center">No matches. Adjust filters or clear them.</td></tr>`;
    cards.innerHTML = `<div class="card muted directory-empty">No matches. Adjust filters or clear them.</div>`;
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
        <td><span class="badge status-${escapeHtml(status)}">${escapeHtml(formatOrderStatus(status))}</span></td>
        <td><span class="badge pay-${escapeHtml(payStatus)}">${escapeHtml(humanizePaymentStatus(payStatus))}</span></td>
        <td style="text-align:right">${escapeHtml(formatCurrency(order.subtotal))}</td>
        <td style="text-align:right">${escapeHtml(formatCurrency(order.balanceDue))}</td>
        <td class="orders-id-cell"><a href="./order.html?id=${encodeURIComponent(order.id)}">${formatOrderId(order.id)}</a></td>
      </tr>
    `;
  }).join("");

  cards.innerHTML = filtered.map((order) => {
    const customerHref = order.customerId ? `./customer.html?id=${encodeURIComponent(order.customerId)}` : "";
    const phoneHref = phoneDialHref(order.phone);
    const status = order.status || "unknown";
    const payStatus = order.paymentStatus || "unpaid";
    const customerName = escapeHtml(order.customerName || "Unknown");
    return `
      <article class="card directory-card order-directory-card">
        <div class="directory-card-head">
          <div>${customerHref ? `<a class="directory-card-title" href="${customerHref}">${customerName}</a>` : `<strong class="directory-card-title">${customerName}</strong>`}<div class="muted">Delivery ${escapeHtml(order.deliveryDate || "not scheduled")}</div></div>
          <span class="badge status-${escapeHtml(status)}">${escapeHtml(formatOrderStatus(status))}</span>
        </div>
        ${renderImportantNote(order, "order-important-note")}
        <div class="directory-card-details">
          <div><span class="muted">Subtotal</span><strong>${escapeHtml(formatCurrency(order.subtotal))}</strong></div>
          <div><span class="muted">Balance</span><strong>${escapeHtml(formatCurrency(order.balanceDue))}</strong></div>
        </div>
        <div class="directory-address">${escapeHtml(order.address || "No delivery address")}</div>
        ${renderLocationPreview(order)}
        ${renderOrderItemThumbs(order)}
        ${renderProofThumbs(order)}
        <div class="directory-order-meta"><span class="badge pay-${escapeHtml(payStatus)}">${escapeHtml(humanizePaymentStatus(payStatus))}</span><a href="./order.html?id=${encodeURIComponent(order.id)}"><code>${escapeHtml(order.id)}</code></a></div>
        <div class="button-row directory-card-actions">
          <a class="button-link primary" href="./order.html?id=${encodeURIComponent(order.id)}">Open order</a>
          ${customerHref ? `<a class="button-link secondary" href="${customerHref}">Customer</a>` : ""}
          ${renderOrderContactMenu(order)}
          ${renderImportanceButton(order)}
        </div>
      </article>`;
  }).join("");

  cards.querySelectorAll("[data-proof-preview]").forEach((button) => {
    button.addEventListener("click", () => openProofPreview(button));
  });
  cards.querySelectorAll("[data-map-order]").forEach((button) => {
    button.addEventListener("click", () => {
      const order = state.orders.find((row) => row.id === button.dataset.mapOrder);
      if (order) openOrderMap(order);
    });
  });
  cards.querySelectorAll("[data-important-order]").forEach((button) => {
    button.addEventListener("click", () => openImportanceDialog(button.dataset.importantOrder));
  });
  initializeMapPreviews();
}

function setView(view) {
  state.view = view === "list" ? "list" : "cards";
  localStorage.setItem("orders-view", state.view);
  el("order-cards").classList.toggle("hidden", state.view !== "cards");
  el("order-list").classList.toggle("hidden", state.view !== "list");
  el("orders-cards-view").classList.toggle("active", state.view === "cards");
  el("orders-list-view").classList.toggle("active", state.view === "list");
}

function formatOrderId(orderId) {
  return escapeHtml(String(orderId || "")).replace(/-/g, "-<br>");
}

// --- Important note (mark / edit / remove) ---------------------------------
// Mirrors the dashboard flow: writes order.important + importantNote, patches
// local state, and re-renders. Validation comes from adminDashboardModel so the
// two pages enforce the same rule.

function openImportanceDialog(orderId) {
  const order = state.orders.find((row) => row.id === orderId);
  if (!order) return;
  const noteInput = el("importance-note");
  el("importance-order-id").value = order.id;
  el("importance-order-label").textContent = `${order.customerName || "Unknown customer"} · ${order.id}`;
  noteInput.value = order.important === true ? normalizeImportantNote(order.importantNote) : "";
  noteInput.setCustomValidity("");
  el("importance-status").textContent = "";
  el("importance-clear-button").classList.toggle("hidden", order.important !== true);
  el("importance-dialog").showModal();
  noteInput.focus();
}

function patchImportanceInState(orderId, important, importantNote) {
  state.orders = state.orders.map((order) => order.id === orderId ? { ...order, important, importantNote } : order);
  renderRows();
}

async function saveImportantOrder(event) {
  event.preventDefault();
  const orderId = el("importance-order-id").value;
  const noteInput = el("importance-note");
  const note = normalizeImportantNote(noteInput.value);
  const status = el("importance-status");
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
      el("importance-dialog").close();
    } catch (error) {
      status.textContent = error.message || String(error);
    }
  }, { busyLabel: "Saving…" });
}

async function clearImportantOrder() {
  const orderId = el("importance-order-id").value;
  const status = el("importance-status");
  const button = el("importance-clear-button");
  await withSubmitLock(button, async () => {
    try {
      status.textContent = "Removing…";
      await updateDoc(doc(db, "orders", orderId), {
        important: false,
        importantNote: null,
        importantUpdatedAt: serverTimestamp()
      });
      patchImportanceInState(orderId, false, null);
      el("importance-dialog").close();
    } catch (error) {
      status.textContent = error.message || String(error);
    }
  }, { busyLabel: "Removing…" });
}

async function loadOrders() {
  setStatus("Loading orders...");
  try {
    const [ordersSnap, itemsSnap, paymentsSnap, productsSnap] = await Promise.all([
      getDocs(collection(db, "orders")),
      getDocs(collection(db, "orderItems")),
      getDocs(collection(db, "payments")),
      getDocs(collection(db, "products"))
    ]);
    state.orders = ordersSnap.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));
    state.orderItems = itemsSnap.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));
    state.payments = paymentsSnap.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));
    state.products = productsSnap.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));
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
el("orders-cards-view").addEventListener("click", () => setView("cards"));
el("orders-list-view").addEventListener("click", () => setView("list"));
el("proof-preview-close").addEventListener("click", () => el("proof-preview-dialog").close());
el("proof-preview-dialog").addEventListener("close", () => {
  el("proof-preview-image").src = "";
});
el("orders-map-close").addEventListener("click", () => el("orders-map-dialog").close());
el("importance-form").addEventListener("submit", saveImportantOrder);
el("importance-clear-button").addEventListener("click", clearImportantOrder);
el("importance-cancel-button").addEventListener("click", () => el("importance-dialog").close());
el("importance-note").addEventListener("input", (event) => {
  event.target.setCustomValidity("");
  el("importance-status").textContent = "";
});
// Close any open contact pop-over when clicking elsewhere.
document.addEventListener("click", (event) => {
  document.querySelectorAll("#order-cards details.customer-contact[open]").forEach((details) => {
    if (!details.contains(event.target)) details.removeAttribute("open");
  });
});
setView(state.view);

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

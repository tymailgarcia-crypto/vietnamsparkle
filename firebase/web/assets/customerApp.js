import {
  auth,
  collection,
  db,
  doc,
  functions,
  getDoc,
  getDocs,
  httpsCallable,
  onAuthStateChanged,
  orderBy,
  query,
  signOut,
  updateDoc,
  where,
  writeBatch
} from "./firebaseClient.js";
import { buildOrderId, computeDepositBreakdown, normalizePhoneE164VN, paymentStatusFor, requireRole, setDeliveryWindow, todayKey, withSubmitLock } from "./shared.js";
import { mapsApiKey } from "./firebaseWebConfig.js";

const mergeCustomersFn = httpsCallable(functions, "mergeCustomers");

let customerMapsPromise = null;
let pendingAddressConfirmation = null;
let customerAddressMap = null;
let customerAddressMarker = null;
let editingAddressOriginal = null;

const state = {
  customerId: "",
  customer: null,
  products: [],
  allCustomers: null
};

const newOrderState = {
  items: []
};

const mergeState = {
  target: null
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

function formatCurrency(amount) {
  const value = Number(amount || 0);
  return new Intl.NumberFormat("en-US").format(value) + " VND";
}

function daysAgo(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return Math.max(0, Math.floor((Date.now() - date.getTime()) / 86400000));
}

function shortMoney(value) {
  const amount = Number(value || 0);
  if (amount >= 1000000) return `${(amount / 1000000).toFixed(amount % 1000000 ? 1 : 0)}m VND`;
  if (amount >= 1000) return `${Math.round(amount / 1000)}k VND`;
  return `${Math.round(amount)} VND`;
}

const CUSTOMER_STATUS_LABELS = {
  pending_approval: "Pending approval",
  new: "Approved",
  assigned: "Assigned",
  out_for_delivery: "Out for delivery",
  delivered: "Delivered",
  cancelled: "Cancelled"
};

function humanizeStatus(status) {
  return CUSTOMER_STATUS_LABELS[status] || status || "unknown";
}

function humanizePaymentStatus(status) {
  if (status === "paid") return "Paid";
  if (status === "partial") return "Partially paid";
  return "Unpaid";
}

function setStatus(nodeId, message, isError = false) {
  const node = el(nodeId);
  if (!node) return;
  node.textContent = message || "";
  node.style.color = isError ? "var(--danger, #b3261e)" : "var(--muted)";
}

function loadCustomerMaps() {
  if (window.google?.maps) return Promise.resolve(window.google.maps);
  if (customerMapsPromise) return customerMapsPromise;
  if (!mapsApiKey) return Promise.reject(new Error("Google Maps is not configured."));
  customerMapsPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(mapsApiKey)}&v=weekly`;
    script.async = true;
    script.onload = () => resolve(window.google.maps);
    script.onerror = () => reject(new Error("Google Maps could not be loaded."));
    document.head.appendChild(script);
  });
  return customerMapsPromise;
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

function currentAddressSet() {
  const customer = state.customer || {};
  const primary = String(customer.address || "").trim();
  const additional = Array.isArray(customer.additionalAddresses)
    ? customer.additionalAddresses.map((address) => String(address || "").trim()).filter(Boolean)
    : [];
  return { primary, additional };
}

function updateAddressFormMode() {
  const editing = Boolean(editingAddressOriginal);
  const button = el("customer-address-submit");
  if (button) {
    button.textContent = pendingAddressConfirmation
      ? "Save confirmed address"
      : (editing ? "Find new pin on map" : "Find on map");
  }
  const input = el("customer-address-input");
  if (input) {
    input.placeholder = editing ? "Update this delivery address" : "Add another delivery address";
  }
  el("customer-address-cancel-edit")?.classList.toggle("hidden", !editing);
}

function resetPendingAddressConfirmation() {
  pendingAddressConfirmation = null;
  el("customer-address-map-wrap")?.setAttribute("hidden", "");
  updateAddressFormMode();
}

function beginEditAddress(text) {
  if (!text) return;
  editingAddressOriginal = text;
  resetPendingAddressConfirmation();
  const input = el("customer-address-input");
  if (input) {
    input.value = text;
    input.focus();
    input.scrollIntoView({ block: "center", behavior: "smooth" });
  }
  updateAddressFormMode();
  setStatus("customer-addresses-status", "Edit the address, then find it on the map to confirm its pin.");
}

function cancelEditAddress() {
  editingAddressOriginal = null;
  const input = el("customer-address-input");
  if (input) input.value = "";
  resetPendingAddressConfirmation();
  setStatus("customer-addresses-status", "");
}

function renderCustomerAddresses() {
  const list = el("customer-addresses-list");
  if (!list) return;
  const { primary, additional } = currentAddressSet();
  const locations = savedAddressLocations();
  const rows = [];
  if (primary) rows.push({ text: primary, isPrimary: true, hasPin: !!savedLocationForAddress(primary, locations) });
  additional.forEach((text) => {
    if (text && normalizeDeliveryAddress(text) !== normalizeDeliveryAddress(primary)) {
      rows.push({ text, isPrimary: false, hasPin: !!savedLocationForAddress(text, locations) });
    }
  });

  if (!rows.length) {
    list.innerHTML = '<div class="muted" style="font-size:13px">No delivery address on file yet. Add and confirm one below.</div>';
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
        <button type="button" class="ghost" data-customer-address-edit="${escapeHtml(row.text)}">Edit</button>
        ${row.isPrimary ? "" : `<button type="button" class="ghost" data-customer-address-primary="${escapeHtml(row.text)}">Set as default</button>`}
        <button type="button" class="danger" data-customer-address-remove="${escapeHtml(row.text)}">Remove</button>
      </div>
    </div>
  `).join("");

  list.querySelectorAll("[data-customer-address-edit]").forEach((button) => {
    button.addEventListener("click", () => beginEditAddress(button.dataset.customerAddressEdit));
  });
  list.querySelectorAll("[data-customer-address-primary]").forEach((button) => {
    button.addEventListener("click", () => promoteAddress(button.dataset.customerAddressPrimary));
  });
  list.querySelectorAll("[data-customer-address-remove]").forEach((button) => {
    button.addEventListener("click", () => removeAddress(button.dataset.customerAddressRemove));
  });
}

async function writeAddresses(nextPrimary, nextAdditional, options = {}) {
  if (!state.customerId) return;
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
    updatedAt: new Date().toISOString()
  };

  await updateDoc(doc(db, "customers", state.customerId), payload);
  state.customer = {
    ...(state.customer || {}),
    address: primary,
    additionalAddresses: cleanAdditional,
    addressLocations: locations,
    location: payload.location
  };
  renderCustomerAddresses();
}

async function promoteAddress(text) {
  if (!text) return;
  const { primary, additional } = currentAddressSet();
  if (normalizeDeliveryAddress(text) === normalizeDeliveryAddress(primary)) return;
  setStatus("customer-addresses-status", "Setting as default...");
  try {
    const nextAdditional = additional.filter((address) => normalizeDeliveryAddress(address) !== normalizeDeliveryAddress(text));
    if (primary) nextAdditional.push(primary);
    await writeAddresses(text, nextAdditional);
    setStatus("customer-addresses-status", "Default address updated.");
  } catch (error) {
    setStatus("customer-addresses-status", error.message || String(error), true);
  }
}

async function removeAddress(text) {
  if (!text || !window.confirm(`Remove this address?\n\n${text}`)) return;
  const { primary, additional } = currentAddressSet();
  setStatus("customer-addresses-status", "Removing...");
  try {
    if (normalizeDeliveryAddress(text) === normalizeDeliveryAddress(primary)) {
      await writeAddresses(additional[0] || "", additional.slice(1));
    } else {
      await writeAddresses(primary, additional.filter((address) => normalizeDeliveryAddress(address) !== normalizeDeliveryAddress(text)));
    }
    if (editingAddressOriginal && normalizeDeliveryAddress(editingAddressOriginal) === normalizeDeliveryAddress(text)) {
      cancelEditAddress();
    }
    setStatus("customer-addresses-status", "Address removed.");
  } catch (error) {
    setStatus("customer-addresses-status", error.message || String(error), true);
  }
}

async function findPinFor(value) {
  setStatus("customer-addresses-status", "Searching Google Maps...");
  const button = el("customer-address-submit");
  if (button) button.disabled = true;
  try {
    await loadCustomerMaps();
    const geocoder = new google.maps.Geocoder();
    const match = await new Promise((resolve, reject) => {
      geocoder.geocode({
        address: value,
        region: "vn",
        componentRestrictions: { country: "vn" },
        // Bias to the Da Nang metro so an ambiguous street name resolves
        // locally instead of matching a same-named road elsewhere in Vietnam.
        bounds: new google.maps.LatLngBounds({ lat: 15.90, lng: 108.05 }, { lat: 16.20, lng: 108.35 })
      }, (results, resultStatus) => {
        if (resultStatus === "OK" && results?.[0]) resolve(results[0]);
        else reject(new Error("We couldn't find that address. Add a district or nearby landmark and try again."));
      });
    });
    // A partial match still gives a usable pin; drop it (draggable) and prompt
    // the owner to nudge it to the exact entrance instead of dead-ending.
    const approximate = Boolean(match.partial_match);
    const position = match.geometry.location;
    const wrap = el("customer-address-map-wrap");
    wrap.hidden = false;
    customerAddressMap = customerAddressMap || new google.maps.Map(el("customer-address-map"), {
      center: position,
      zoom: 17,
      streetViewControl: false,
      mapTypeControl: false,
      fullscreenControl: false
    });
    customerAddressMap.setCenter(position);
    if (customerAddressMarker) customerAddressMarker.setMap(null);
    customerAddressMarker = new google.maps.Marker({ map: customerAddressMap, position, draggable: true });
    const formattedAddress = match.formatted_address || null;
    const capture = (pinPosition) => {
      pendingAddressConfirmation = {
        address: value,
        lat: pinPosition.lat(),
        lng: pinPosition.lng(),
        formattedAddress
      };
    };
    capture(position);
    customerAddressMarker.addListener("dragend", () => capture(customerAddressMarker.getPosition()));
    el("customer-address-map-help").textContent = "Drag the pin to the exact entrance, then select “Save confirmed address”. Future orders will reuse this pin.";
    updateAddressFormMode();
    setStatus("customer-addresses-status", approximate
      ? "Approximate match — drag the pin to the exact entrance, then save."
      : "Pin found. Check it, drag it if needed, then save.");
  } catch (error) {
    resetPendingAddressConfirmation();
    setStatus("customer-addresses-status", error.message || String(error), true);
  } finally {
    if (button) button.disabled = false;
  }
}

async function handleAddressFormSubmit(event) {
  event.preventDefault();
  const input = el("customer-address-input");
  const value = String(input?.value || "").trim();
  if (value.length < 5) {
    setStatus("customer-addresses-status", "Address is too short.", true);
    return;
  }
  const { primary, additional } = currentAddressSet();
  const original = editingAddressOriginal;
  const isEdit = Boolean(original);
  const valueKey = normalizeDeliveryAddress(value);
  const clashesWithSaved = [primary, ...additional].some((address) => normalizeDeliveryAddress(address) === valueKey);
  const isSameAsOriginal = isEdit && normalizeDeliveryAddress(original) === valueKey;
  if (clashesWithSaved && !isSameAsOriginal) {
    setStatus("customer-addresses-status", "That address is already saved.", true);
    return;
  }

  if (!pendingAddressConfirmation || pendingAddressConfirmation.address !== value) {
    await findPinFor(value);
    return;
  }

  setStatus("customer-addresses-status", isEdit ? "Saving address..." : "Adding confirmed address...");
  try {
    const pin = {
      lat: pendingAddressConfirmation.lat,
      lng: pendingAddressConfirmation.lng,
      formattedAddress: pendingAddressConfirmation.formattedAddress || null,
      geocodedAt: new Date().toISOString()
    };
    if (isEdit && normalizeDeliveryAddress(original) === normalizeDeliveryAddress(primary)) {
      await writeAddresses(value, additional, { confirmedAddress: value, confirmedLocation: pin });
    } else if (isEdit) {
      await writeAddresses(primary, additional.map((address) => (
        normalizeDeliveryAddress(address) === normalizeDeliveryAddress(original) ? value : address
      )), { confirmedAddress: value, confirmedLocation: pin });
    } else if (!primary) {
      await writeAddresses(value, additional, { confirmedAddress: value, confirmedLocation: pin });
    } else {
      await writeAddresses(primary, [...additional, value], { confirmedAddress: value, confirmedLocation: pin });
    }
    input.value = "";
    editingAddressOriginal = null;
    resetPendingAddressConfirmation();
    setStatus("customer-addresses-status", isEdit ? "Address updated." : "Confirmed address added.");
  } catch (error) {
    setStatus("customer-addresses-status", error.message || String(error), true);
  }
}

function readCustomerIdFromUrl() {
  const params = new URLSearchParams(location.search);
  return String(params.get("id") || "").trim();
}

function populateForm(customer) {
  el("field-name").value = customer.name || "";
  el("field-phone").value = customer.phone || "";
  el("field-email").value = customer.email || "";
  el("field-billing-name").value = customer.billingName || "";
  el("field-tax-id").value = customer.taxId || "";
  el("field-notes").value = customer.notes || "";
}

async function loadCustomer(customerId) {
  setStatus("load-status", "Loading customer...");
  const snap = await getDoc(doc(db, "customers", customerId));
  if (!snap.exists()) {
    setStatus("load-status", "Customer not found.", true);
    el("customer-headline").textContent = "Customer not found";
    return null;
  }
  const customer = { id: snap.id, ...snap.data() };
  state.customer = customer;
  el("customer-headline").textContent = customer.name || "Unknown customer";
  const subParts = [];
  if (customer.phone) subParts.push(customer.phone);
  if (customer.email) subParts.push(customer.email);
  el("customer-subline").textContent = subParts.join(" · ");
  populateForm(customer);
  renderCustomerAddresses();
  setStatus("load-status", "");
  applyArchivedState(customer);
  return customer;
}

function applyArchivedState(customer) {
  const banner = el("merged-banner");
  const mergePanel = el("merge-panel");
  const newOrderButton = el("new-order-button");
  const addressesPanel = el("customer-addresses-panel");
  if (customer.archived === true) {
    if (banner) {
      banner.classList.remove("hidden");
      const targetId = customer.mergedInto || "";
      const link = el("merged-target-link");
      if (link && targetId) {
        link.href = `./customer.html?id=${encodeURIComponent(targetId)}`;
        link.textContent = `${targetId} (open)`;
      }
    }
    if (mergePanel) mergePanel.classList.add("hidden");
    if (addressesPanel) addressesPanel.classList.add("hidden");
    if (newOrderButton) newOrderButton.disabled = true;
  } else {
    if (banner) banner.classList.add("hidden");
    if (mergePanel) mergePanel.classList.remove("hidden");
    if (addressesPanel) addressesPanel.classList.remove("hidden");
    if (newOrderButton) newOrderButton.disabled = false;
  }
}

async function loadOrderHistory(customer) {
  setStatus("orders-status", "Loading order history...");
  try {
    const seen = new Map();
    const queries = [];
    queries.push(getDocs(query(collection(db, "orders"), where("customerId", "==", customer.id))));
    if (customer.authUid) {
      queries.push(getDocs(query(collection(db, "orders"), where("authUid", "==", customer.authUid))));
    }
    const snapshots = await Promise.all(queries);
    snapshots.forEach((snap) => {
      snap.docs.forEach((docSnap) => {
        if (!seen.has(docSnap.id)) {
          seen.set(docSnap.id, { id: docSnap.id, ...docSnap.data() });
        }
      });
    });
    const orders = Array.from(seen.values())
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    renderOrderHistory(orders);
    setStatus("orders-status", `${orders.length} order${orders.length === 1 ? "" : "s"} on file.`);
    return orders;
  } catch (error) {
    setStatus("orders-status", `Could not load orders: ${error.message || error}`, true);
  }
  return [];
}

async function loadCustomerInsights(customer, orders) {
  try {
    const depositsSnap = await getDocs(query(collection(db, "depositEvents"), where("customerId", "==", customer.id)));
    let containers = 0;
    let oldestContainerDate = null;
    depositsSnap.docs.forEach((item) => {
      const event = item.data();
      const direction = event.eventType === "charged" ? 1 : ["refunded", "credited", "forfeited", "charge_reversed"].includes(event.eventType) ? -1 : 0;
      containers += direction * Number(event.qty || 0);
      if (direction > 0 && event.eventDate && (!oldestContainerDate || event.eventDate < oldestContainerDate)) oldestContainerDate = event.eventDate;
    });
    containers = Math.max(0, containers);
    const activeOrders = orders.filter((order) => order.status !== "cancelled");
    const delivered = activeOrders.filter((order) => order.status === "delivered");
    const outstanding = activeOrders.reduce((sum, order) => sum + Math.max(0, Number(order.balanceDue || 0)), 0);
    const lifetime = delivered.reduce((sum, order) => sum + Number(order.subtotal || 0), 0);
    const dates = activeOrders.map((order) => order.deliveryDate).filter(Boolean).sort();
    const lastDate = dates[dates.length - 1] || null;
    const lastDays = daysAgo(lastDate);
    const gaps = dates.slice(1).map((date, index) => (new Date(date) - new Date(dates[index])) / 86400000).filter((gap) => gap > 0);
    const cadence = gaps.length ? Math.round(gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length) : null;
    const heldDays = daysAgo(oldestContainerDate);
    let attention = { tone: "good", text: "Nothing needs attention" };
    if (outstanding > 0) attention = { tone: "danger", text: `${shortMoney(outstanding)} needs collecting` };
    else if (containers > 0 && heldDays >= 30) attention = { tone: "warning", text: `${containers} container${containers === 1 ? "" : "s"} held ${heldDays} days` };
    else if (cadence && lastDays != null && lastDays >= cadence) attention = { tone: "info", text: "Likely ready to reorder" };
    else if (lastDays != null && lastDays >= 60) attention = { tone: "muted", text: `No order for ${lastDays} days` };
    const attentionNode = el("customer-profile-attention");
    attentionNode.className = `customer-attention customer-attention-${attention.tone}`;
    attentionNode.textContent = attention.text;
    el("customer-profile-metrics").innerHTML = `
      <div><span>Outstanding</span><strong>${outstanding ? escapeHtml(shortMoney(outstanding)) : "Clear"}</strong></div>
      <div><span>Containers out</span><strong>${containers}</strong></div>
      <div><span>Last order</span><strong>${lastDays == null ? "Never" : lastDays === 0 ? "Today" : `${lastDays} days ago`}</strong></div>
      <div><span>Lifetime sales</span><strong>${escapeHtml(shortMoney(lifetime))}</strong></div>`;
    const completion = activeOrders.length ? Math.round(delivered.length / activeOrders.length * 100) : 0;
    el("customer-profile-pattern").textContent = [
      cadence ? `Usually orders every ${cadence} days.` : "Not enough history to estimate an ordering rhythm.",
      activeOrders.length ? `${completion}% of orders delivered.` : "",
      heldDays != null && containers > 0 ? `Oldest outstanding container charge: ${heldDays} days.` : ""
    ].filter(Boolean).join(" ");
  } catch (error) {
    el("customer-profile-attention").textContent = "Insights unavailable";
    el("customer-profile-pattern").textContent = error.message || String(error);
  }
}

function renderOrderHistory(orders) {
  const container = el("order-history");
  if (!orders.length) {
    container.innerHTML = `<div class="card"><strong>No orders</strong><div class="muted top-gap">This customer has no orders on file yet.</div></div>`;
    return;
  }
  container.innerHTML = orders.map((order) => {
    const payStatus = order.paymentStatus || "unpaid";
    const orderLink = `<a href="./order.html?id=${encodeURIComponent(order.id)}" class="muted">${escapeHtml(order.id)}</a>`;
    return `
      <article class="card">
        <div class="order-top">
          <div>
            <strong>${escapeHtml(order.deliveryDate || "?")}</strong>
            <div>${orderLink}</div>
          </div>
          <div class="button-row" style="gap:8px">
            <span class="badge status-${escapeHtml(order.status || "unknown")}">${escapeHtml(humanizeStatus(order.status))}</span>
            <span class="badge pay-${escapeHtml(payStatus)}">${escapeHtml(humanizePaymentStatus(payStatus))}</span>
          </div>
        </div>
        <div class="meta-list">
          <div>Subtotal: ${escapeHtml(formatCurrency(order.subtotal))}</div>
          <div>Deposit: ${escapeHtml(formatCurrency(order.depositTotal))}</div>
          <div>Paid: ${escapeHtml(formatCurrency(order.amountPaid))}</div>
          <div>Balance: ${escapeHtml(formatCurrency(order.balanceDue))}</div>
        </div>
      </article>
    `;
  }).join("");
}

async function saveCustomer(event) {
  event.preventDefault();
  // E.164 only (Ty, 2026-07-16): stored phones must carry the country code so
  // wa.me links work. Vietnamese local formats normalize to +84; anything
  // else must be typed with its country code. An empty phone stays allowed —
  // some legacy records have none.
  const rawPhone = el("field-phone").value.trim();
  const phoneE164 = rawPhone ? normalizePhoneE164VN(rawPhone) : null;
  if (rawPhone && !phoneE164) {
    setStatus("save-status", "Phone must include the country code, e.g. +84 905 123 456.", true);
    return;
  }
  if (phoneE164) el("field-phone").value = phoneE164;
  setStatus("save-status", "Saving...");
  await withSubmitLock(event, async () => {
    try {
      await updateDoc(doc(db, "customers", state.customerId), {
        name: el("field-name").value.trim(),
        phone: phoneE164 || "",
        email: el("field-email").value.trim() || null,
        billingName: el("field-billing-name").value.trim() || null,
        taxId: el("field-tax-id").value.trim() || null,
        notes: el("field-notes").value.trim() || null,
        updatedAt: new Date().toISOString()
      });
      setStatus("save-status", "Saved.");
      await loadCustomer(state.customerId);
    } catch (error) {
      setStatus("save-status", error.message || String(error), true);
    }
  });
}

function appendDatedNote() {
  const noteText = prompt("Add a note. It will be timestamped and prepended to Notes.");
  if (noteText === null) return;
  const trimmed = noteText.trim();
  if (!trimmed) return;
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  const notesField = el("field-notes");
  const existing = notesField.value;
  notesField.value = `[${stamp}] ${trimmed}${existing ? `\n${existing}` : ""}`;
}

async function loadProducts() {
  const snap = await getDocs(query(collection(db, "products"), where("active", "==", true)));
  state.products = snap.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));
}

function computeNewOrderTotals() {
  return newOrderState.items.reduce((acc, item) => {
    const qty = Number(item.quantity || 0);
    acc.subtotal += qty * Number(item.unitPrice || 0);
    acc.depositTotal += qty * Number(item.defaultDepositAmount || 0);
    return acc;
  }, { subtotal: 0, depositTotal: 0 });
}

function renderNewOrderTotals() {
  const totals = computeNewOrderTotals();
  const due = totals.subtotal + totals.depositTotal;
  el("new-order-totals").innerHTML = `
    <div class="card"><span class="muted">Subtotal</span><strong>${formatCurrency(totals.subtotal)}</strong></div>
    <div class="card"><span class="muted">Deposit</span><strong>${formatCurrency(totals.depositTotal)}</strong></div>
    <div class="card"><span class="muted">Total due</span><strong>${formatCurrency(due)}</strong></div>
  `;
}

function renderNewOrderItems() {
  const container = el("new-order-items");
  if (!newOrderState.items.length) {
    container.innerHTML = `<p class="muted">No items yet. Add a product below.</p>`;
    return;
  }
  container.innerHTML = newOrderState.items.map((item, idx) => `
    <div class="card">
      <div class="order-top">
        <div>
          <strong>${escapeHtml(item.productName)}</strong>
          <div class="muted">${formatCurrency(item.unitPrice)} each · deposit ${formatCurrency(item.defaultDepositAmount || 0)}</div>
        </div>
        <div class="button-row" style="gap:6px">
          <button class="ghost" type="button" data-newo-qty-minus="${idx}">-</button>
          <span class="qty-value">${item.quantity}</span>
          <button class="ghost" type="button" data-newo-qty-plus="${idx}">+</button>
          <button class="ghost" type="button" data-newo-remove="${idx}">Remove</button>
        </div>
      </div>
    </div>
  `).join("");
  container.querySelectorAll("[data-newo-qty-minus]").forEach((btn) => {
    btn.addEventListener("click", () => changeNewOrderQty(Number(btn.dataset.newoQtyMinus), -1));
  });
  container.querySelectorAll("[data-newo-qty-plus]").forEach((btn) => {
    btn.addEventListener("click", () => changeNewOrderQty(Number(btn.dataset.newoQtyPlus), 1));
  });
  container.querySelectorAll("[data-newo-remove]").forEach((btn) => {
    btn.addEventListener("click", () => removeNewOrderItem(Number(btn.dataset.newoRemove)));
  });
}

function changeNewOrderQty(idx, delta) {
  const next = Math.max(0, Number(newOrderState.items[idx].quantity || 0) + delta);
  if (next === 0) {
    newOrderState.items.splice(idx, 1);
  } else {
    newOrderState.items[idx].quantity = next;
  }
  renderNewOrderItems();
  renderNewOrderTotals();
}

function removeNewOrderItem(idx) {
  newOrderState.items.splice(idx, 1);
  renderNewOrderItems();
  renderNewOrderTotals();
}

function addNewOrderItem() {
  const select = el("new-order-add-select");
  const productId = select.value;
  if (!productId) return;
  const product = state.products.find((p) => p.id === productId);
  if (!product) return;
  const existing = newOrderState.items.find((i) => i.productId === productId);
  if (existing) {
    existing.quantity += 1;
  } else {
    newOrderState.items.push({
      productId: product.id,
      productName: product.productName,
      quantity: 1,
      unitPrice: Number(product.unitPrice || 0),
      defaultDepositAmount: Number(product.defaultDepositAmount || 0)
    });
  }
  select.value = "";
  renderNewOrderItems();
  renderNewOrderTotals();
}

function openNewOrderDialog() {
  const dialog = el("new-order-dialog");
  if (!dialog || typeof dialog.showModal !== "function") return;
  const customer = state.customer;
  if (!customer) return;
  el("new-order-customer-name").textContent = customer.name || "customer";
  el("new-order-date").value = todayKey();
  setDeliveryWindow(el("new-order-window"), "");
  el("new-order-address").value = customer.address || "";
  el("new-order-notes").value = "";
  const addSelect = el("new-order-add-select");
  addSelect.innerHTML = '<option value="">Choose a product to add...</option>'
    + state.products.map((p) => `<option value="${p.id}">${escapeHtml(p.productName)} — ${formatCurrency(p.unitPrice)}</option>`).join("");
  newOrderState.items = [];
  renderNewOrderItems();
  renderNewOrderTotals();
  const statusNode = el("new-order-status");
  statusNode.textContent = "";
  statusNode.style.color = "";
  dialog.showModal();
}

async function saveNewOrder(event) {
  event.preventDefault();
  const statusNode = el("new-order-status");
  const customer = state.customer;
  if (!customer) return;
  if (!newOrderState.items.length) {
    statusNode.textContent = "Add at least one product.";
    statusNode.style.color = "var(--danger, #b3261e)";
    return;
  }
  await withSubmitLock(event, async () => {
    try {
      statusNode.textContent = "Creating order...";
      statusNode.style.color = "";
      const totals = computeNewOrderTotals();
      const orderId = buildOrderId("ORD");
      const nowIso = new Date().toISOString();
      const deliveryDate = el("new-order-date").value;
      const batch = writeBatch(db);

      // Reuse a saved pin only when it belongs to the exact selected address.
      // This prevents a manually changed order address from inheriting the
      // customer's default pin and sending the driver to the wrong place.
      const orderAddress = el("new-order-address").value.trim();
      const savedOrderLocation = savedLocationForAddress(orderAddress, savedAddressLocations(customer));
      const inheritedLocation = savedOrderLocation
        ? {
            lat: savedOrderLocation.lat,
            lng: savedOrderLocation.lng,
            formattedAddress: savedOrderLocation.formattedAddress || null,
            geocodedAt: nowIso,
            sourceCustomerId: customer.id
          }
        : null;

      batch.set(doc(db, "orders", orderId), {
        createdAt: nowIso,
        sourceChannel: "owner_manual",
        customerId: customer.id,
        authUid: customer.authUid || null,
        customerName: customer.name || "",
        phone: customer.phone || "",
        email: customer.email || null,
        address: orderAddress,
        deliveryLocation: inheritedLocation,
        deliveryDate,
        deliveryWindow: el("new-order-window").value.trim(),
        assignedDriverId: null,
        status: "new",
        subtotal: totals.subtotal,
        depositTotal: totals.depositTotal,
        amountPaid: 0,
        balanceDue: totals.subtotal + totals.depositTotal,
        paymentStatus: paymentStatusFor(0, totals.subtotal + totals.depositTotal),
        notes: el("new-order-notes").value.trim() || null,
        updatedAt: nowIso
      });

      newOrderState.items.forEach((item) => {
        const qty = Number(item.quantity);
        const unitPrice = Number(item.unitPrice);
        batch.set(doc(db, "orderItems", buildOrderId("ITEM")), {
          orderId,
          authUid: customer.authUid || null,
          productId: item.productId,
          productName: item.productName,
          quantity: qty,
          unitPrice,
          lineTotal: qty * unitPrice
        });
      });

      const productsById = Object.fromEntries(state.products.map((p) => [p.id, p]));
      const depositBreakdown = computeDepositBreakdown(newOrderState.items, productsById);
      depositBreakdown.forEach((entry) => {
        batch.set(doc(db, "depositEvents", buildOrderId("DEP")), {
          orderId,
          customerId: customer.id,
          authUid: customer.authUid || null,
          containerType: entry.containerType,
          qty: entry.qty,
          amount: entry.amount,
          eventType: "charged",
          eventDate: deliveryDate,
          linkedDocumentId: null,
          notes: "Auto-charged on owner order create"
        });
      });

      await batch.commit();
      el("new-order-dialog").close();
      const orders = await loadOrderHistory(customer);
      await loadCustomerInsights(customer, orders);
    } catch (error) {
      statusNode.textContent = error.message || String(error);
      statusNode.style.color = "var(--danger, #b3261e)";
    }
  }, { busyLabel: "Creating order..." });
}

el("customer-form").addEventListener("submit", saveCustomer);
el("customer-address-form").addEventListener("submit", handleAddressFormSubmit);
el("customer-address-cancel-edit").addEventListener("click", cancelEditAddress);
el("customer-address-reset-pin").addEventListener("click", () => {
  resetPendingAddressConfirmation();
  setStatus("customer-addresses-status", "Pin reset — update the address if needed, then find it on the map again.");
  el("customer-address-input").focus();
});
el("customer-address-input").addEventListener("input", () => {
  if (pendingAddressConfirmation) {
    resetPendingAddressConfirmation();
    setStatus("customer-addresses-status", "Address changed — find it on the map again.");
  }
});
el("append-note-button").addEventListener("click", appendDatedNote);
el("new-order-button").addEventListener("click", openNewOrderDialog);
el("new-order-cancel-button").addEventListener("click", () => {
  el("new-order-dialog").close();
});
el("new-order-add-button").addEventListener("click", addNewOrderItem);
el("new-order-form").addEventListener("submit", saveNewOrder);

// --- Merge dialog wiring ------------------------------------------------

async function ensureAllCustomersLoaded() {
  if (state.allCustomers) return state.allCustomers;
  const snap = await getDocs(collection(db, "customers"));
  state.allCustomers = snap.docs
    .map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }))
    // Never let the owner pick this record as its own merge target, and
    // never surface already-archived docs as targets (they wouldn't accept
    // incoming children safely).
    .filter((c) => c.id !== state.customerId && c.archived !== true);
  return state.allCustomers;
}

function scoreMatch(customer, needle) {
  const haystack = [customer.name, customer.phone, customer.email, customer.id, customer.area]
    .map((v) => String(v || "").toLowerCase())
    .join(" ");
  return haystack.includes(needle) ? 1 : 0;
}

function renderMergeSuggestions(list) {
  const container = el("merge-target-suggestions");
  if (!container) return;
  if (!list.length) {
    container.innerHTML = `<div class="muted" style="padding:12px">No matches. Type a name, phone, or CUS-… id.</div>`;
    return;
  }
  container.innerHTML = list.slice(0, 20).map((c) => {
    const bits = [c.phone, c.email, c.area].filter(Boolean).map(escapeHtml).join(" · ");
    return `
      <div class="card" data-merge-pick="${escapeHtml(c.id)}" style="cursor:pointer;padding:10px 12px;border-radius:0">
        <strong>${escapeHtml(c.name || "Unknown")}</strong>
        <div class="muted" style="font-size:12px">${escapeHtml(c.id)}${bits ? " · " + bits : ""}${Number(c.orderCount || 0) ? " · " + Number(c.orderCount) + " orders" : ""}</div>
      </div>
    `;
  }).join("");
  container.querySelectorAll("[data-merge-pick]").forEach((node) => {
    node.addEventListener("click", () => pickMergeTarget(node.dataset.mergePick));
  });
}

function pickMergeTarget(targetId) {
  const target = (state.allCustomers || []).find((c) => c.id === targetId);
  if (!target) return;
  mergeState.target = target;
  el("merge-target-search").value = target.name ? `${target.name} — ${target.id}` : target.id;
  el("merge-target-suggestions").innerHTML = "";
  renderMergePreview();
  el("merge-submit-button").disabled = false;
}

function renderMergePreview() {
  const preview = el("merge-preview");
  const from = state.customer;
  const target = mergeState.target;
  if (!preview || !from || !target) return;
  const warnings = [];
  if (from.authUid && target.authUid && from.authUid !== target.authUid) {
    warnings.push("Both records already have a signed-in account attached — the merge will refuse. Ask the owner to reconcile which uid is correct first.");
  }
  if (Number(from.orderCount || 0) > 0 && Number(target.orderCount || 0) > 0) {
    warnings.push("Both records have order history. After merge, all history will appear on the target.");
  }
  preview.classList.remove("hidden");
  preview.innerHTML = `
    <div class="card" style="background:rgba(179,38,30,0.05);border-left:4px solid #b3261e">
      <strong>You are about to archive this record.</strong>
      <div class="stats-grid" style="margin-top:8px">
        <div class="card"><span class="muted">From (archive)</span><strong>${escapeHtml(from.name || from.id)}</strong><div class="muted" style="font-size:12px">${escapeHtml(from.id)}</div></div>
        <div class="card"><span class="muted">Into (keep)</span><strong>${escapeHtml(target.name || target.id)}</strong><div class="muted" style="font-size:12px">${escapeHtml(target.id)}</div></div>
      </div>
      ${warnings.map((w) => `<p class="muted" style="margin:8px 0 0;color:#b3261e">${escapeHtml(w)}</p>`).join("")}
    </div>
  `;
}

async function openMergeDialog() {
  const dialog = el("merge-dialog");
  if (!dialog || typeof dialog.showModal !== "function") return;
  const from = state.customer;
  if (!from) return;
  mergeState.target = null;
  el("merge-from-label").textContent = from.name ? `${from.name} (${from.id})` : from.id;
  el("merge-target-search").value = "";
  el("merge-target-suggestions").innerHTML = `<div class="muted" style="padding:12px">Loading customers…</div>`;
  el("merge-preview").classList.add("hidden");
  el("merge-preview").innerHTML = "";
  el("merge-submit-button").disabled = true;
  el("merge-status").textContent = "";
  el("merge-status").style.color = "";
  dialog.showModal();
  await ensureAllCustomersLoaded();
  el("merge-target-suggestions").innerHTML = `<div class="muted" style="padding:12px">Type a name, phone, or CUS-… id.</div>`;
}

function onMergeSearchInput(event) {
  const needle = String(event.target.value || "").trim().toLowerCase();
  mergeState.target = null;
  el("merge-preview").classList.add("hidden");
  el("merge-submit-button").disabled = true;
  if (!state.allCustomers) return;
  if (!needle) {
    el("merge-target-suggestions").innerHTML = `<div class="muted" style="padding:12px">Type a name, phone, or CUS-… id.</div>`;
    return;
  }
  const matches = state.allCustomers.filter((c) => scoreMatch(c, needle));
  renderMergeSuggestions(matches);
}

async function submitMerge(event) {
  event.preventDefault();
  const statusNode = el("merge-status");
  const from = state.customer;
  const target = mergeState.target;
  if (!from || !target) return;
  await withSubmitLock(event, async () => {
    try {
      statusNode.textContent = "Merging…";
      statusNode.style.color = "";
      const result = await mergeCustomersFn({ fromId: from.id, toId: target.id });
      const data = result && result.data ? result.data : {};
      if (!data.ok) {
        throw new Error("Merge did not confirm. Check the function logs.");
      }
      statusNode.textContent = "Merged. Redirecting…";
      // Kill any cached list so a follow-up merge on the target picks up
      // fresh state.
      state.allCustomers = null;
      window.location.href = `./customer.html?id=${encodeURIComponent(target.id)}`;
    } catch (error) {
      statusNode.textContent = (error && error.message) || String(error);
      statusNode.style.color = "var(--danger, #b3261e)";
    }
  }, { busyLabel: "Merging…" });
}

el("open-merge-button").addEventListener("click", openMergeDialog);
el("merge-cancel-button").addEventListener("click", () => {
  el("merge-dialog").close();
});
el("merge-target-search").addEventListener("input", onMergeSearchInput);
el("merge-form").addEventListener("submit", submitMerge);

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
  state.customerId = readCustomerIdFromUrl();
  if (!state.customerId) {
    setStatus("load-status", "No customer specified. Return to Customers to pick one.", true);
    return;
  }
  await loadProducts();
  const customer = await loadCustomer(state.customerId);
  if (customer) {
    const orders = await loadOrderHistory(customer);
    await loadCustomerInsights(customer, orders);
  }
});

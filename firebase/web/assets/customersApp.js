import {
  auth,
  collection,
  db,
  doc,
  getDocs,
  onAuthStateChanged,
  query,
  serverTimestamp,
  setDoc,
  signOut,
  where,
  writeBatch
} from "./firebaseClient.js";
import { buildDuplicateGroups, buildOrderId, computeDepositBreakdown, normalizePhoneE164VN, normalizePhoneWithCountry, paymentStatusFor, requireRole, setDeliveryWindow, setupPhoneCountryPicker, todayKey, withSubmitLock } from "./shared.js";
import { mapsApiKey } from "./firebaseWebConfig.js";
import { createEditOrderAddressController } from "./editOrderAddress.js";

let customersMapsPromise = null;
let newCustomerPhonePicker = null;

const state = {
  customers: [],
  products: [],
  insights: {},
  search: "",
  attention: "",
  sort: "name-asc",
  view: localStorage.getItem("customers-view") || "cards"
};

// The in-progress order attached to the Add customer / New order dialog. Cleared
// each time the dialog opens. `mode` is "order" when opened via New order (an
// order is required) or "customer" via Add customer (the order is optional).
const orderDraft = { items: [], mode: "customer" };

function el(id) {
  return document.getElementById(id);
}

function setStatus(message) {
  const node = el("list-status");
  if (node) node.textContent = message || "";
}

function loadCustomersMaps() {
  if (window.google?.maps) return Promise.resolve(window.google.maps);
  if (customersMapsPromise) return customersMapsPromise;
  if (!mapsApiKey) return Promise.reject(new Error("Google Maps is not configured."));
  customersMapsPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(mapsApiKey)}&v=weekly`;
    script.async = true;
    script.onload = () => resolve(window.google.maps);
    script.onerror = () => reject(new Error("Google Maps could not be loaded."));
    document.head.appendChild(script);
  });
  return customersMapsPromise;
}

// Reuse the same Google Places autocomplete + draggable-pin controller the
// edit-order address flow uses, so Add customer gets the type-ahead address
// suggestions the order form and My account already have. The controller reads
// its elements by id; getElement maps its `edit-address*` ids onto this form's
// `new-customer-address*` ids, so the shared module needs no changes.
const NEW_CUSTOMER_ADDRESS_IDS = {
  "edit-address": "new-customer-address",
  "edit-address-verify": "new-customer-address-verify",
  "edit-address-confirm": "new-customer-address-confirm",
  "edit-address-reset-pin": "new-customer-address-reset-pin",
  "edit-address-map-wrap": "new-customer-address-map-wrap",
  "edit-address-map": "new-customer-address-map",
  "edit-address-autocomplete-list": "new-customer-address-autocomplete-list",
  "edit-address-status": "new-customer-address-status"
};

const newCustomerAddress = createEditOrderAddressController({
  loadMaps: loadCustomersMaps,
  getElement: (id) => el(NEW_CUSTOMER_ADDRESS_IDS[id] || id)
});

function phoneDialHref(phone) {
  const digits = String(phone || "").replace(/[^0-9+]/g, "");
  return digits ? `tel:${digits}` : "";
}

function mapDirectionsHref(address) {
  const trimmed = String(address || "").trim();
  if (!trimmed) return "";
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(trimmed)}`;
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatCurrency(amount) {
  return new Intl.NumberFormat("en-US").format(Number(amount || 0)) + " VND";
}

function matchesSearch(customer) {
  if (!state.search) return true;
  const q = state.search.toLowerCase();
  return [customer.name, customer.billingName, customer.phone, customer.secondaryPhone, customer.email, customer.address]
    .some((field) => String(field || "").toLowerCase().includes(q));
}

// customer.orderCount / lastOrderAt are only written by the Sheets import and
// never updated by app orders, so they read "0 orders" next to "Last order:
// Today". Count from the orders this page already loads; keep the imported
// figure only when it is higher (legacy history not present as order docs).
function customerOrderCount(customer) {
  const insight = state.insights[customer.id];
  return Math.max(insight ? insight.orders.length : 0, Number(customer.orderCount || 0));
}

function customerLastOrder(customer) {
  const insight = state.insights[customer.id];
  const fromOrders = insight && insight.lastOrderDate ? String(insight.lastOrderDate) : "";
  const imported = customer.lastOrderAt ? String(customer.lastOrderAt).slice(0, 10) : "";
  return fromOrders > imported ? fromOrders : imported;
}

function sortRows(rows) {
  const copy = rows.slice();
  switch (state.sort) {
    case "name-desc":
      return copy.sort((a, b) => String(b.name || "").localeCompare(String(a.name || "")));
    case "last-order-desc":
      return copy.sort((a, b) => customerLastOrder(b).localeCompare(customerLastOrder(a)));
    case "last-order-asc":
      return copy.sort((a, b) => customerLastOrder(a).localeCompare(customerLastOrder(b)));
    case "order-count-desc":
      return copy.sort((a, b) => customerOrderCount(b) - customerOrderCount(a));
    default:
      return copy.sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
  }
}

function daysAgo(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return Math.max(0, Math.floor((Date.now() - date.getTime()) / 86400000));
}

function shortMoney(value) {
  const amount = Number(value || 0);
  if (amount >= 1000000) return `${(amount / 1000000).toFixed(amount % 1000000 ? 1 : 0)}m`;
  if (amount >= 1000) return `${Math.round(amount / 1000)}k`;
  return String(Math.round(amount));
}

function buildCustomerInsights(orders, depositEvents) {
  const byCustomer = {};
  const get = (id) => {
    if (!byCustomer[id]) byCustomer[id] = { orders: [], outstanding: 0, lifetime: 0, containers: 0, oldestContainerDate: null };
    return byCustomer[id];
  };
  orders.forEach((order) => {
    if (!order.customerId || order.status === "cancelled") return;
    const item = get(order.customerId);
    item.orders.push(order);
    item.outstanding += Math.max(0, Number(order.balanceDue || 0));
    if (order.status === "delivered") item.lifetime += Number(order.subtotal || 0);
  });
  depositEvents.forEach((event) => {
    if (!event.customerId) return;
    const item = get(event.customerId);
    const direction = event.eventType === "charged" ? 1 : ["refunded", "credited", "forfeited", "charge_reversed"].includes(event.eventType) ? -1 : 0;
    item.containers += direction * Number(event.qty || 0);
    const eventDate = event.eventDate || event.createdAt;
    if (direction > 0 && eventDate && (!item.oldestContainerDate || String(eventDate) < item.oldestContainerDate)) {
      item.oldestContainerDate = String(eventDate);
    }
  });
  Object.values(byCustomer).forEach((item) => {
    item.containers = Math.max(0, item.containers);
    const dates = item.orders.map((o) => o.deliveryDate).filter(Boolean).sort();
    item.lastOrderDate = dates[dates.length - 1] || null;
    const gaps = dates.slice(1).map((date, index) => (new Date(date) - new Date(dates[index])) / 86400000).filter((gap) => gap > 0);
    item.cadence = gaps.length ? Math.round(gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length) : null;
  });
  return byCustomer;
}

function customerAttention(insight) {
  const lastDays = daysAgo(insight.lastOrderDate);
  const heldDays = daysAgo(insight.oldestContainerDate);
  if (insight.outstanding > 0) return { tone: "danger", text: `${shortMoney(insight.outstanding)} VND needs collecting` };
  if (insight.containers > 0 && heldDays >= 30) return { tone: "warning", text: `${insight.containers} container${insight.containers === 1 ? "" : "s"} held ${heldDays} days` };
  if (insight.cadence && lastDays != null && lastDays >= insight.cadence) return { tone: "info", text: "Likely ready to reorder" };
  if (lastDays != null && lastDays >= 60) return { tone: "muted", text: `No order for ${lastDays} days` };
  return { tone: "good", text: "Nothing needs attention" };
}

function matchesAttention(customer) {
  if (!state.attention) return true;
  const attention = customerAttention(state.insights[customer.id] || {});
  if (state.attention === "needs-attention") return attention.tone !== "good";
  if (state.attention === "payment") return attention.tone === "danger";
  if (state.attention === "containers") return attention.tone === "warning";
  if (state.attention === "reorder") return attention.tone === "info";
  if (state.attention === "inactive") return attention.tone === "muted";
  if (state.attention === "clear") return attention.tone === "good";
  return true;
}

function renderRows() {
  const tbody = el("customer-rows");
  const cards = el("customer-cards");
  const filtered = sortRows(state.customers.filter((c) => matchesSearch(c) && matchesAttention(c)));
  setStatus(state.search || state.attention
    ? `Showing ${filtered.length} of ${state.customers.length} customers.`
    : `${state.customers.length} customer${state.customers.length === 1 ? "" : "s"} on file.`);

  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="muted" style="padding:20px;text-align:center">No matches. Adjust filters or clear the search.</td></tr>`;
    cards.innerHTML = `<div class="card muted directory-empty">No matches. Adjust filters or clear the search.</div>`;
    return;
  }

  tbody.innerHTML = filtered.map((customer) => {
    const nameHref = `./customer.html?id=${encodeURIComponent(customer.id)}`;
    const phoneHref = phoneDialHref(customer.phone);
    const mapsHref = mapDirectionsHref(customer.address);
    const lastOrder = customerLastOrder(customer);
    const notesText = customer.notes ? String(customer.notes).replace(/\n+/g, " · ").slice(0, 120) : "";
    const phoneHtml = phoneHref ? `<a href="${phoneHref}">${escapeHtml(customer.phone)}</a>` : escapeHtml(customer.phone || "");
    const emailHtml = customer.email
      ? `<a href="mailto:${escapeHtml(customer.email)}">${escapeHtml(customer.email)}</a>`
      : `<a class="mini-add-email" href="${nameHref}">+ Add email</a>`;
    return `
      <tr data-customer-id="${escapeHtml(customer.id)}">
        <td><a href="${nameHref}" class="row-link">${escapeHtml(customer.name || "Unknown")}</a></td>
        <td class="customer-contact-cell"><div>${phoneHtml}</div><div class="customer-email-line">${emailHtml}</div></td>
        <td>${mapsHref ? `<a class="row-link address-map-link" href="${mapsHref}" target="_blank" rel="noopener" title="Open in Google Maps" aria-label="Open ${escapeHtml(customer.address)} in Google Maps">${escapeHtml(customer.address)}</a>` : escapeHtml(customer.address || "")}</td>
        <td class="notes-cell">${escapeHtml(notesText)}</td>
        <td>${escapeHtml(lastOrder)}</td>
        <td>${customerOrderCount(customer)}</td>
      </tr>
    `;
  }).join("");

  cards.innerHTML = filtered.map((customer) => {
    const nameHref = `./customer.html?id=${encodeURIComponent(customer.id)}`;
    const phoneHref = phoneDialHref(customer.phone);
    const mapsHref = mapDirectionsHref(customer.address);
    const insight = state.insights[customer.id] || { outstanding: 0, containers: 0, lifetime: 0 };
    const attention = customerAttention(insight);
    const lastDays = daysAgo(customerLastOrder(customer));
    const lastOrder = lastDays == null ? "Never" : lastDays === 0 ? "Today" : `${lastDays}d ago`;
    const orderCount = customerOrderCount(customer);
    return `
      <article class="card directory-card">
        <div class="directory-card-head">
          <div><a class="directory-card-title" href="${nameHref}">${escapeHtml(customer.name || "Unknown")}</a></div>
          <span class="directory-count">${orderCount} order${orderCount === 1 ? "" : "s"}</span>
        </div>
        <div class="customer-attention customer-attention-${attention.tone}">${escapeHtml(attention.text)}</div>
        <div class="customer-insight-grid">
          <div><span>Balance</span><strong>${insight.outstanding ? `${shortMoney(insight.outstanding)} VND` : "Clear"}</strong></div>
          <div><span>Containers</span><strong>${Number(insight.containers || 0)}</strong></div>
          <div><span>Last order</span><strong>${escapeHtml(lastOrder)}</strong></div>
        </div>
        <div class="directory-address">${escapeHtml(customer.address || "No address")}</div>
        <div class="customer-card-context"><span>${escapeHtml(customer.phone || "No phone")}</span><span>Lifetime ${shortMoney(insight.lifetime)} VND</span>${insight.cadence ? `<span>Usually every ${insight.cadence}d</span>` : ""}</div>
        <div class="button-row directory-card-actions">
          <a class="button-link primary" href="${nameHref}">Open customer</a>
          ${phoneHref ? `<a class="button-link secondary" href="${phoneHref}">Call</a>` : ""}
          ${mapsHref ? `<a class="button-link secondary" href="${mapsHref}" target="_blank" rel="noopener">Map</a>` : ""}
        </div>
      </article>`;
  }).join("");
}

function setView(view) {
  state.view = view === "list" ? "list" : "cards";
  localStorage.setItem("customers-view", state.view);
  el("customer-cards").classList.toggle("hidden", state.view !== "cards");
  el("customer-list").classList.toggle("hidden", state.view !== "list");
  el("customers-cards-view").classList.toggle("active", state.view === "cards");
  el("customers-list-view").classList.toggle("active", state.view === "list");
}

async function loadCustomers() {
  setStatus("Loading customers...");
  try {
    const [snap, ordersSnap, depositsSnap] = await Promise.all([
      getDocs(collection(db, "customers")),
      getDocs(collection(db, "orders")),
      getDocs(collection(db, "depositEvents"))
    ]);
    // Archived docs are the tombstone left behind by a merge — kept for audit
    // but never shown in the main directory. To see one, navigate to it by
    // URL (e.g. from another archived stub's mergedInto link).
    state.customers = snap.docs
      .map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }))
      .filter((c) => c.archived !== true);
    state.insights = buildCustomerInsights(
      ordersSnap.docs.map((item) => ({ id: item.id, ...item.data() })),
      depositsSnap.docs.map((item) => item.data())
    );
    renderRows();
    updateDuplicatesBadge();
  } catch (error) {
    setStatus(`Could not load customers: ${error.message || error}`);
  }
}

// Nudge toward the merge tool: count records that look like the same person
// (same phone or email) and badge the "Find duplicates" link. Same grouping the
// tool itself uses (buildDuplicateGroups), so the number can't disagree with
// what you see when you open it. Merging stays a manual owner decision there.
function updateDuplicatesBadge() {
  const badge = el("duplicates-badge");
  if (!badge) return;
  // Match the tool's population: it also drops testFixture docs (archived docs
  // are already excluded when state.customers is built).
  const groups = buildDuplicateGroups(state.customers.filter((c) => c.testFixture !== true));
  if (groups.length) {
    badge.textContent = String(groups.length);
    badge.hidden = false;
    badge.title = `${groups.length} possible duplicate account${groups.length === 1 ? "" : "s"} to review`;
  } else {
    badge.hidden = true;
  }
}

el("search-input").addEventListener("input", (event) => {
  state.search = event.target.value.trim();
  renderRows();
});
el("attention-filter").addEventListener("change", (event) => {
  state.attention = event.target.value;
  renderRows();
});
el("sort-select").addEventListener("change", (event) => {
  state.sort = event.target.value;
  renderRows();
});
el("refresh-button").addEventListener("click", loadCustomers);
el("customers-cards-view").addEventListener("click", () => setView("cards"));
el("customers-list-view").addEventListener("click", () => setView("list"));
setView(state.view);

function checkForDuplicatePhone() {
  const rawPhone = el("new-customer-phone").value;
  const countryCode = el("new-customer-phone-country")?.value || "+84";
  const e164 = normalizePhoneWithCountry(rawPhone, countryCode);
  const banner = el("new-customer-dedupe-banner");
  if (!e164) {
    banner.style.display = "none";
    banner.innerHTML = "";
    return;
  }
  const matches = state.customers.filter((c) => normalizePhoneE164VN(c.phone) === e164);
  if (!matches.length) {
    banner.style.display = "none";
    banner.innerHTML = "";
    return;
  }
  banner.className = "cancellation-request";
  banner.style.display = "block";
  const links = matches.map((m) =>
    `<a href="./customer.html?id=${encodeURIComponent(m.id)}">${escapeHtml(m.name || "Unknown")}</a>`
  ).join(", ");
  banner.innerHTML = `A customer with this phone may already exist: ${links}. Choose what to do:`
    + `<div class="button-row" style="margin-top:8px;gap:16px;flex-wrap:wrap">`
    + `<label class="button-row" style="gap:6px;cursor:pointer"><input type="radio" name="add-customer-dedupe-choice" value="existing" checked><span>Use this existing customer</span></label>`
    + `<label class="button-row" style="gap:6px;cursor:pointer"><input type="radio" name="add-customer-dedupe-choice" value="new"><span>Create a separate new record</span></label>`
    + `</div>`;
}

// --- Order draft (product picker shared by the Add customer / New order dialog) ---

function computeOrderDraftTotals() {
  return orderDraft.items.reduce((acc, item) => {
    const qty = Number(item.quantity || 0);
    acc.subtotal += qty * Number(item.unitPrice || 0);
    acc.depositTotal += qty * Number(item.defaultDepositAmount || 0);
    return acc;
  }, { subtotal: 0, depositTotal: 0 });
}

function renderOrderDraftTotals() {
  const totals = computeOrderDraftTotals();
  const due = totals.subtotal + totals.depositTotal;
  el("add-customer-totals").innerHTML = `
    <div class="card"><span class="muted">Subtotal</span><strong>${formatCurrency(totals.subtotal)}</strong></div>
    <div class="card"><span class="muted">Deposit</span><strong>${formatCurrency(totals.depositTotal)}</strong></div>
    <div class="card"><span class="muted">Total due</span><strong>${formatCurrency(due)}</strong></div>
  `;
}

function renderOrderDraftItems() {
  const container = el("add-customer-items");
  if (!orderDraft.items.length) {
    const hint = orderDraft.mode === "order" ? " — at least one is needed" : " (optional)";
    container.innerHTML = `<p class="muted">No items yet. Add a product below${hint}.</p>`;
    return;
  }
  container.innerHTML = orderDraft.items.map((item, idx) => `
    <div class="card">
      <div class="order-top">
        <div>
          <strong>${escapeHtml(item.productName)}</strong>
          <div class="muted">${formatCurrency(item.unitPrice)} each · deposit ${formatCurrency(item.defaultDepositAmount || 0)}</div>
        </div>
        <div class="button-row" style="gap:6px">
          <button class="ghost" type="button" data-od-minus="${idx}">-</button>
          <span class="qty-value">${item.quantity}</span>
          <button class="ghost" type="button" data-od-plus="${idx}">+</button>
          <button class="ghost" type="button" data-od-remove="${idx}">Remove</button>
        </div>
      </div>
    </div>
  `).join("");
  container.querySelectorAll("[data-od-minus]").forEach((btn) => btn.addEventListener("click", () => changeOrderDraftQty(Number(btn.dataset.odMinus), -1)));
  container.querySelectorAll("[data-od-plus]").forEach((btn) => btn.addEventListener("click", () => changeOrderDraftQty(Number(btn.dataset.odPlus), 1)));
  container.querySelectorAll("[data-od-remove]").forEach((btn) => btn.addEventListener("click", () => removeOrderDraftItem(Number(btn.dataset.odRemove))));
}

function changeOrderDraftQty(idx, delta) {
  const next = Math.max(0, Number(orderDraft.items[idx].quantity || 0) + delta);
  if (next === 0) orderDraft.items.splice(idx, 1);
  else orderDraft.items[idx].quantity = next;
  renderOrderDraftItems();
  renderOrderDraftTotals();
}

function removeOrderDraftItem(idx) {
  orderDraft.items.splice(idx, 1);
  renderOrderDraftItems();
  renderOrderDraftTotals();
}

function addOrderDraftItem() {
  const select = el("add-customer-add-select");
  const productId = select.value;
  if (!productId) return;
  const product = state.products.find((p) => p.id === productId);
  if (!product) return;
  const existing = orderDraft.items.find((i) => i.productId === productId);
  if (existing) existing.quantity += 1;
  else orderDraft.items.push({
    productId: product.id,
    productName: product.productName,
    quantity: 1,
    unitPrice: Number(product.unitPrice || 0),
    defaultDepositAmount: Number(product.defaultDepositAmount || 0)
  });
  select.value = "";
  renderOrderDraftItems();
  renderOrderDraftTotals();
}

function openAddCustomerDialog(mode = "customer") {
  const dialog = el("add-customer-dialog");
  if (!dialog || typeof dialog.showModal !== "function") return;
  el("add-customer-form").reset();
  // form.reset() restores the hidden country <input> to +84 but not the picker's
  // visible label/state, so set it back explicitly.
  newCustomerPhonePicker?.setValue("+84");
  el("new-customer-dedupe-banner").style.display = "none";
  el("new-customer-dedupe-banner").innerHTML = "";
  const statusNode = el("add-customer-status");
  statusNode.textContent = "";
  statusNode.style.color = "";
  newCustomerAddress.reset();

  orderDraft.mode = mode === "order" ? "order" : "customer";
  orderDraft.items = [];
  el("add-customer-title").textContent = orderDraft.mode === "order" ? "New order" : "Add a new customer";
  el("add-customer-submit").textContent = orderDraft.mode === "order" ? "Create order" : "Save customer";
  el("add-customer-order-heading").textContent = orderDraft.mode === "order" ? "Order" : "Order (optional)";
  el("add-customer-date").value = todayKey();
  setDeliveryWindow(el("add-customer-window"), "");
  el("add-customer-add-select").innerHTML = '<option value="">Choose a product to add...</option>'
    + state.products.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.productName)} — ${formatCurrency(p.unitPrice)}</option>`).join("");
  renderOrderDraftItems();
  renderOrderDraftTotals();

  dialog.showModal();
}

async function handleSaveNewCustomer(event) {
  event.preventDefault();
  const statusNode = el("add-customer-status");
  const rawPhone = el("new-customer-phone").value.trim();
  const countryCode = el("new-customer-phone-country")?.value || "+84";
  const e164 = normalizePhoneWithCountry(rawPhone, countryCode);
  if (!e164) {
    statusNode.textContent = "Enter a valid phone. Pick the country code, then enter the number.";
    statusNode.style.color = "var(--danger, #b3261e)";
    return;
  }
  const address = el("new-customer-address").value.trim();
  const confirmedLocation = newCustomerAddress.confirmedFor(address);
  if (!confirmedLocation) {
    statusNode.textContent = "Confirm the delivery address on Google Maps before saving.";
    statusNode.style.color = "var(--danger, #b3261e)";
    el("new-customer-address-verify").focus();
    return;
  }

  const hasOrder = orderDraft.items.length > 0;
  if (orderDraft.mode === "order" && !hasOrder) {
    statusNode.textContent = "Add at least one product for the order.";
    statusNode.style.color = "var(--danger, #b3261e)";
    return;
  }

  // Duplicate phone: warn + let the owner choose (radios rendered in the dedupe
  // banner). Default is to reuse the existing customer without overwriting it.
  const digits = e164.replace(/\D+/g, "");
  const matches = state.customers.filter((c) => normalizePhoneE164VN(c.phone) === e164);
  const dedupeChoice = document.querySelector('input[name="add-customer-dedupe-choice"]:checked')?.value;
  const existingCustomer = (matches.length && dedupeChoice !== "new") ? matches[0] : null;

  // Target id: the existing record when reusing; otherwise CUS-<digits>, suffixed
  // when that id is already taken (a deliberate separate person on one phone).
  let customerId;
  if (existingCustomer) customerId = existingCustomer.id;
  else if (matches.some((c) => c.id === `CUS-${digits}`)) customerId = `CUS-${digits}-${Date.now().toString(36)}`;
  else customerId = `CUS-${digits}`;

  const formName = el("new-customer-name").value.trim();
  const formEmail = el("new-customer-email").value.trim() || null;
  const notes = el("new-customer-notes").value.trim() || null;

  await withSubmitLock(event, async () => {
    try {
      statusNode.textContent = hasOrder ? "Creating order..." : "Saving...";
      statusNode.style.color = "";
      const nowIso = new Date().toISOString();
      const batch = writeBatch(db);

      // Create the customer only when we are not reusing an existing record —
      // never overwrite a customer the owner chose to keep.
      if (!existingCustomer) {
        batch.set(doc(db, "customers", customerId), {
          name: formName,
          // E.164 only (Ty, 2026-07-16) — wa.me links break on local formats.
          phone: e164,
          email: formEmail,
          area: null,
          address,
          addressLocations: [{ address, ...confirmedLocation }],
          location: { ...confirmedLocation },
          notes,
          billingName: null,
          taxId: null,
          secondaryPhone: null,
          addressHistory: null,
          lastSourceChannel: "owner_added",
          lastOrderAt: null,
          orderCount: 0,
          authUid: null,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        }, { merge: true });
      }

      if (hasOrder) {
        const totals = computeOrderDraftTotals();
        const orderId = buildOrderId("ORD");
        const deliveryDate = el("add-customer-date").value || todayKey();
        const orderName = existingCustomer ? (existingCustomer.name || formName) : formName;
        const orderPhone = existingCustomer ? (existingCustomer.phone || e164) : e164;
        const orderEmail = existingCustomer ? (existingCustomer.email || null) : formEmail;
        const orderAuthUid = existingCustomer ? (existingCustomer.authUid || null) : null;
        const balanceDue = totals.subtotal + totals.depositTotal;

        batch.set(doc(db, "orders", orderId), {
          createdAt: nowIso,
          sourceChannel: "owner_manual",
          customerId,
          authUid: orderAuthUid,
          customerName: orderName,
          phone: orderPhone,
          email: orderEmail,
          address,
          deliveryLocation: {
            lat: confirmedLocation.lat,
            lng: confirmedLocation.lng,
            formattedAddress: confirmedLocation.formattedAddress || null,
            geocodedAt: nowIso,
            sourceCustomerId: customerId
          },
          deliveryDate,
          deliveryWindow: el("add-customer-window").value.trim(),
          assignedDriverId: null,
          status: "new",
          subtotal: totals.subtotal,
          depositTotal: totals.depositTotal,
          amountPaid: 0,
          balanceDue,
          paymentStatus: paymentStatusFor(0, balanceDue),
          notes,
          updatedAt: nowIso
        });

        orderDraft.items.forEach((item) => {
          const qty = Number(item.quantity);
          const unitPrice = Number(item.unitPrice);
          batch.set(doc(db, "orderItems", buildOrderId("ITEM")), {
            orderId,
            authUid: orderAuthUid,
            productId: item.productId,
            productName: item.productName,
            quantity: qty,
            unitPrice,
            lineTotal: qty * unitPrice
          });
        });

        const productsById = Object.fromEntries(state.products.map((p) => [p.id, p]));
        computeDepositBreakdown(orderDraft.items, productsById).forEach((entry) => {
          batch.set(doc(db, "depositEvents", buildOrderId("DEP")), {
            orderId,
            customerId,
            authUid: orderAuthUid,
            containerType: entry.containerType,
            qty: entry.qty,
            amount: entry.amount,
            eventType: "charged",
            eventDate: deliveryDate,
            linkedDocumentId: null,
            notes: "Auto-charged on owner order create"
          });
        });
      }

      await batch.commit();
      el("add-customer-dialog").close();
      location.href = `./customer.html?id=${encodeURIComponent(customerId)}`;
    } catch (error) {
      statusNode.textContent = error.message || String(error);
      statusNode.style.color = "var(--danger, #b3261e)";
    }
  });
}

newCustomerPhonePicker = setupPhoneCountryPicker(el("new-customer-phone-country-picker"));
el("add-customer-button").addEventListener("click", () => openAddCustomerDialog("customer"));
el("new-order-button").addEventListener("click", () => openAddCustomerDialog("order"));
el("add-customer-cancel-button").addEventListener("click", () => {
  el("add-customer-dialog").close();
});
el("add-customer-form").addEventListener("submit", handleSaveNewCustomer);
el("add-customer-add-button").addEventListener("click", addOrderDraftItem);
el("new-customer-phone").addEventListener("input", checkForDuplicatePhone);
// The address input, "Find on Google Maps", "Use this location" and "Reset pin"
// are wired by newCustomerAddress (createEditOrderAddressController) above,
// which also drives the type-ahead Google Places suggestions.

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
  await loadCustomers();
  // Products drive the New order product picker. Non-fatal: if it fails the
  // dialog still creates a customer, just with an empty product list.
  await loadProducts();
});

async function loadProducts() {
  try {
    const snap = await getDocs(query(collection(db, "products"), where("active", "==", true)));
    state.products = snap.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));
  } catch (error) {
    state.products = [];
  }
}

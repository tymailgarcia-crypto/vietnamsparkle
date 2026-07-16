import {
  auth,
  collection,
  db,
  doc,
  getDocs,
  onAuthStateChanged,
  serverTimestamp,
  setDoc,
  signOut
} from "./firebaseClient.js";
import { normalizePhoneE164VN, requireRole, withSubmitLock } from "./shared.js";

const state = {
  customers: [],
  insights: {},
  search: "",
  attention: "",
  sort: "name-asc",
  view: localStorage.getItem("customers-view") || "cards"
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

function matchesSearch(customer) {
  if (!state.search) return true;
  const q = state.search.toLowerCase();
  return [customer.name, customer.billingName, customer.phone, customer.secondaryPhone, customer.email, customer.address, customer.area]
    .some((field) => String(field || "").toLowerCase().includes(q));
}

function sortRows(rows) {
  const copy = rows.slice();
  switch (state.sort) {
    case "name-desc":
      return copy.sort((a, b) => String(b.name || "").localeCompare(String(a.name || "")));
    case "last-order-desc":
      return copy.sort((a, b) => String(b.lastOrderAt || "").localeCompare(String(a.lastOrderAt || "")));
    case "last-order-asc":
      return copy.sort((a, b) => String(a.lastOrderAt || "").localeCompare(String(b.lastOrderAt || "")));
    case "order-count-desc":
      return copy.sort((a, b) => Number(b.orderCount || 0) - Number(a.orderCount || 0));
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
    const direction = event.eventType === "charged" ? 1 : ["refunded", "credited", "forfeited"].includes(event.eventType) ? -1 : 0;
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
    const lastOrder = customer.lastOrderAt ? String(customer.lastOrderAt).slice(0, 10) : "";
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
        <td>${Number(customer.orderCount || 0)}</td>
      </tr>
    `;
  }).join("");

  cards.innerHTML = filtered.map((customer) => {
    const nameHref = `./customer.html?id=${encodeURIComponent(customer.id)}`;
    const phoneHref = phoneDialHref(customer.phone);
    const mapsHref = mapDirectionsHref(customer.address);
    const insight = state.insights[customer.id] || { outstanding: 0, containers: 0, lifetime: 0 };
    const attention = customerAttention(insight);
    const lastDays = daysAgo(insight.lastOrderDate || customer.lastOrderAt);
    const lastOrder = lastDays == null ? "Never" : lastDays === 0 ? "Today" : `${lastDays}d ago`;
    return `
      <article class="card directory-card">
        <div class="directory-card-head">
          <div><a class="directory-card-title" href="${nameHref}">${escapeHtml(customer.name || "Unknown")}</a><div class="muted">${escapeHtml(customer.area || "Area not set")}</div></div>
          <span class="directory-count">${Number(customer.orderCount || 0)} order${Number(customer.orderCount || 0) === 1 ? "" : "s"}</span>
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
  } catch (error) {
    setStatus(`Could not load customers: ${error.message || error}`);
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
  const e164 = normalizePhoneE164VN(rawPhone);
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
  banner.innerHTML = `A customer with this phone may already exist: ${links}. You can still save if these are different people sharing a phone.`;
}

function openAddCustomerDialog() {
  const dialog = el("add-customer-dialog");
  if (!dialog || typeof dialog.showModal !== "function") return;
  el("add-customer-form").reset();
  el("new-customer-dedupe-banner").style.display = "none";
  el("new-customer-dedupe-banner").innerHTML = "";
  const statusNode = el("add-customer-status");
  statusNode.textContent = "";
  statusNode.style.color = "";
  dialog.showModal();
}

async function handleSaveNewCustomer(event) {
  event.preventDefault();
  const statusNode = el("add-customer-status");
  const rawPhone = el("new-customer-phone").value.trim();
  const e164 = normalizePhoneE164VN(rawPhone);
  if (!e164) {
    statusNode.textContent = "Enter a valid phone. Include country code for numbers outside Vietnam.";
    statusNode.style.color = "var(--danger, #b3261e)";
    return;
  }
  const digits = e164.replace(/\D+/g, "");
  const customerId = `CUS-${digits}`;
  await withSubmitLock(event, async () => {
    try {
      statusNode.textContent = "Saving...";
      statusNode.style.color = "";
      await setDoc(doc(db, "customers", customerId), {
        name: el("new-customer-name").value.trim(),
        // E.164 only (Ty, 2026-07-16) — wa.me links break on local formats.
        phone: e164,
        email: el("new-customer-email").value.trim() || null,
        area: el("new-customer-area").value.trim() || null,
        address: el("new-customer-address").value.trim(),
        notes: el("new-customer-notes").value.trim() || null,
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
      el("add-customer-dialog").close();
      location.href = `./customer.html?id=${encodeURIComponent(customerId)}`;
    } catch (error) {
      statusNode.textContent = error.message || String(error);
      statusNode.style.color = "var(--danger, #b3261e)";
    }
  });
}

el("add-customer-button").addEventListener("click", openAddCustomerDialog);
el("add-customer-cancel-button").addEventListener("click", () => {
  el("add-customer-dialog").close();
});
el("add-customer-form").addEventListener("submit", handleSaveNewCustomer);
el("new-customer-phone").addEventListener("input", checkForDuplicatePhone);

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
});

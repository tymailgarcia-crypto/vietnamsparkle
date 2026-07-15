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
  search: "",
  area: "",
  sort: "name-asc"
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

function matchesArea(customer) {
  if (!state.area) return true;
  return String(customer.area || "") === state.area;
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

function renderAreaOptions() {
  const areas = Array.from(new Set(state.customers.map((c) => String(c.area || "")).filter(Boolean))).sort();
  const select = el("area-filter");
  const preserved = select.value;
  select.innerHTML = '<option value="">All areas</option>'
    + areas.map((area) => `<option value="${escapeHtml(area)}">${escapeHtml(area)}</option>`).join("");
  if (preserved) select.value = preserved;
}

function renderRows() {
  const tbody = el("customer-rows");
  const filtered = sortRows(state.customers.filter((c) => matchesSearch(c) && matchesArea(c)));
  setStatus(state.search || state.area
    ? `Showing ${filtered.length} of ${state.customers.length} customers.`
    : `${state.customers.length} customer${state.customers.length === 1 ? "" : "s"} on file.`);

  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="muted" style="padding:20px;text-align:center">No matches. Adjust filters or clear the search.</td></tr>`;
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
}

async function loadCustomers() {
  setStatus("Loading customers...");
  try {
    const snap = await getDocs(collection(db, "customers"));
    // Archived docs are the tombstone left behind by a merge — kept for audit
    // but never shown in the main directory. To see one, navigate to it by
    // URL (e.g. from another archived stub's mergedInto link).
    state.customers = snap.docs
      .map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }))
      .filter((c) => c.archived !== true);
    renderAreaOptions();
    renderRows();
  } catch (error) {
    setStatus(`Could not load customers: ${error.message || error}`);
  }
}

el("search-input").addEventListener("input", (event) => {
  state.search = event.target.value.trim();
  renderRows();
});
el("area-filter").addEventListener("change", (event) => {
  state.area = event.target.value;
  renderRows();
});
el("sort-select").addEventListener("change", (event) => {
  state.sort = event.target.value;
  renderRows();
});
el("refresh-button").addEventListener("click", loadCustomers);

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
        phone: rawPhone,
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

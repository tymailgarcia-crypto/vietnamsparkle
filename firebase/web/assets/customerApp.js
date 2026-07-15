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
import { buildOrderId, computeDepositBreakdown, paymentStatusFor, requireRole, setDeliveryWindow, todayKey, withSubmitLock } from "./shared.js";

const mergeCustomersFn = httpsCallable(functions, "mergeCustomers");

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
  el("field-area").value = customer.area || "";
  el("field-address").value = customer.address || "";
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
  if (customer.area) subParts.push(customer.area);
  el("customer-subline").textContent = subParts.join(" · ");
  populateForm(customer);
  setStatus("load-status", "");
  applyArchivedState(customer);
  return customer;
}

function applyArchivedState(customer) {
  const banner = el("merged-banner");
  const mergePanel = el("merge-panel");
  const newOrderButton = el("new-order-button");
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
    if (newOrderButton) newOrderButton.disabled = true;
  } else {
    if (banner) banner.classList.add("hidden");
    if (mergePanel) mergePanel.classList.remove("hidden");
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
  } catch (error) {
    setStatus("orders-status", `Could not load orders: ${error.message || error}`, true);
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
    const orderLink = order.deliveryDate
      ? `<a href="./admin.html?date=${encodeURIComponent(order.deliveryDate)}" class="muted">${escapeHtml(order.id)}</a>`
      : `<span class="muted">${escapeHtml(order.id)}</span>`;
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
  setStatus("save-status", "Saving...");
  await withSubmitLock(event, async () => {
    try {
      await updateDoc(doc(db, "customers", state.customerId), {
        name: el("field-name").value.trim(),
        phone: el("field-phone").value.trim(),
        email: el("field-email").value.trim() || null,
        billingName: el("field-billing-name").value.trim() || null,
        taxId: el("field-tax-id").value.trim() || null,
        area: el("field-area").value.trim() || null,
        address: el("field-address").value.trim(),
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

      // Owner-created orders skip pending_approval, so the approval hook
      // that geocodes the address never runs. Reuse the customer's cached
      // location when we have it; otherwise leave deliveryLocation null and
      // let /route.html / /map.html geocode later.
      const inheritedLocation = customer.location
        && typeof customer.location.lat === "number"
        && typeof customer.location.lng === "number"
        ? {
            lat: customer.location.lat,
            lng: customer.location.lng,
            formattedAddress: customer.location.formattedAddress || null,
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
        address: el("new-order-address").value.trim(),
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
      await loadOrderHistory(customer);
    } catch (error) {
      statusNode.textContent = error.message || String(error);
      statusNode.style.color = "var(--danger, #b3261e)";
    }
  }, { busyLabel: "Creating order..." });
}

el("customer-form").addEventListener("submit", saveCustomer);
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
  if (customer) await loadOrderHistory(customer);
});

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
  productCategoryKey,
  productImageUrl,
  setDeliveryWindow,
  todayKey,
  withSubmitLock
} from "./shared.js";

const submitPublicOrderFn = httpsCallable(functions, "submitPublicOrder");
const resolveWhatsAppOrderLinkFn = httpsCallable(functions, "resolveWhatsAppOrderLink");

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
  pastItemsByOrderId: {}
};

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
  state.products = snapshot.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));
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

async function applyWhatsAppOrderLink() {
  const token = new URLSearchParams(location.search).get("wa");
  if (!token) return false;
  const feedback = document.getElementById("public-feedback");
  try {
    const result = await resolveWhatsAppOrderLinkFn({ token });
    const data = result?.data || {};
    const customer = data.customer || {};
    const form = document.getElementById("public-order-form");
    if (customer.name) form.customerName.value = customer.name;
    if (customer.phone) form.phone.value = customer.phone;
    if (customer.address) form.address.value = customer.address;
    state.quantities = {};
    for (const item of data.items || []) {
      if (item.productId && Number(item.quantity) > 0) {
        state.quantities[item.productId] = Number(item.quantity);
      }
    }
    renderCatalog();
    renderTotals();
    if (feedback) feedback.textContent = "Your saved order is ready to review.";
    history.replaceState({}, "", location.pathname);
    return true;
  } catch (error) {
    if (feedback) feedback.textContent = error?.message || "This WhatsApp order link is invalid or expired.";
    return true;
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
  const submitButton = event.submitter
    || document.querySelector('button[form="public-order-form"][type="submit"]');
  feedback.textContent = "Submitting order...";

  // Capture identity fields before we reset the form — needed for the
  // "save these to your profile?" prompt after success.
  const submittedIdentity = {
    name: String(form.customerName?.value || "").trim(),
    phone: String(form.phone?.value || "").trim(),
    address: String(form.address?.value || "").trim()
  };

  let successOrderId = null;
  await withSubmitLock(event, async () => {
    try {
      const payload = buildCallablePayload(form);
      const result = await submitPublicOrderFn(payload);
      const orderId = result?.data?.orderId;
      if (!orderId) throw new Error("Order was not confirmed. Please try again.");
      form.reset();
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
    await maybeSaveIdentityToProfile(submittedIdentity);
  }
}

// Offer to persist the identity fields the customer just typed into their
// customer profile — but only when they're signed in and their profile
// doesn't already carry those values. Their explicit yes/no controls the
// write; we never save silently. If the submitted address is different
// from the one already on file, the dialog also lets the customer save
// it as an additional address and pick which one is primary.
async function maybeSaveIdentityToProfile(submitted) {
  if (!state.user) return;
  const existing = state.customer || {};
  const existingName = String(existing.name || "").trim();
  const existingPhone = String(existing.phone || "").trim();
  const existingAddress = String(existing.address || "").trim();
  const additional = Array.isArray(existing.additionalAddresses) ? existing.additionalAddresses : [];

  const missing = [];
  if (submitted.name && !existingName) missing.push({ key: "name", value: submitted.name });
  if (submitted.phone && !existingPhone) missing.push({ key: "phone", value: submitted.phone });
  if (submitted.address && !existingAddress) missing.push({ key: "address", value: submitted.address });

  const addressDiffers = !!submitted.address
    && !!existingAddress
    && submitted.address !== existingAddress
    && !additional.includes(submitted.address);

  if (!missing.length && !addressDiffers) return;

  const dialog = document.getElementById("profile-save-dialog");
  if (!dialog) return;

  // ---- Populate the dialog --------------------------------------------------
  const hint = document.getElementById("profile-save-hint");
  const fieldsWrap = document.getElementById("profile-save-fields");
  const addressBlock = document.getElementById("profile-save-address-block");
  const addressExistingText = document.getElementById("profile-save-address-existing");
  const addressSubmittedText = document.getElementById("profile-save-address-submitted");
  const status = document.getElementById("profile-save-status");
  const confirmBtn = document.getElementById("profile-save-confirm");
  const cancelBtn = document.getElementById("profile-save-cancel");

  if (hint) {
    if (!state.customer) {
      hint.textContent = "Create a profile so we can prefill your details next time.";
    } else if (missing.length && addressDiffers) {
      hint.textContent = "Save these details and pick which address to use by default.";
    } else if (missing.length) {
      hint.textContent = "We can save these to your profile so we prefill them next time.";
    } else if (addressDiffers) {
      hint.textContent = "This delivery address isn't on your profile yet — save it as another delivery address?";
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
  if (addressBlock) {
    addressBlock.hidden = !addressDiffers;
    if (addressDiffers) {
      if (addressExistingText) addressExistingText.textContent = existingAddress;
      if (addressSubmittedText) addressSubmittedText.textContent = submitted.address;
      const submittedRadio = dialog.querySelector('input[name="primaryAddress"][value="submitted"]');
      if (submittedRadio) submittedRadio.checked = true;
    }
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
    const primaryChoice = dialog.querySelector('input[name="primaryAddress"]:checked')?.value || "submitted";
    try {
      await writeIdentityToProfile({ submitted, missing, addressDiffers, existingAddress, additional, primaryChoice });
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

async function writeIdentityToProfile({ submitted, missing, addressDiffers, existingAddress, additional, primaryChoice }) {
  const ref = doc(db, "customers", `CUS-${state.user.uid}`);
  const payload = { updatedAt: serverTimestamp() };
  missing.forEach((m) => {
    if (m.key !== "address") payload[m.key] = m.value;
  });

  // Address handling: primary lives in `address`, alternates in
  // `additionalAddresses` (keeps existing admin/account reads working).
  if (missing.find((m) => m.key === "address")) {
    payload.address = submitted.address;
  } else if (addressDiffers) {
    if (primaryChoice === "submitted") {
      payload.address = submitted.address;
      const nextAlt = [existingAddress, ...additional.filter((a) => a && a !== submitted.address && a !== existingAddress)];
      payload.additionalAddresses = Array.from(new Set(nextAlt.filter(Boolean)));
    } else {
      const nextAlt = [...additional.filter((a) => a && a !== submitted.address), submitted.address];
      payload.additionalAddresses = Array.from(new Set(nextAlt));
    }
  }

  if (!state.customer) {
    payload.authUid = state.user.uid;
    payload.email = state.user.email || null;
    payload.createdAt = serverTimestamp();
  }

  await setDoc(ref, payload, { merge: true });
  state.customer = { ...(state.customer || {}), ...payload };
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
  if (!user) {
    if (banner) banner.textContent = "";
    return;
  }
  if (banner) {
    banner.innerHTML = `Signed in as <strong>${escapeHtml(user.email)}</strong>.`;
  }
  try {
    const snap = await getDocs(query(collection(db, "customers"), where("authUid", "==", user.uid)));
    if (snap.empty) return;
    const customer = { id: snap.docs[0].id, ...snap.docs[0].data() };
    state.customer = customer;
    const nameField = document.getElementById("form-customer-name");
    const phoneField = document.getElementById("form-phone");
    const addressField = document.getElementById("form-address");
    if (nameField && !nameField.value) nameField.value = customer.name || user.displayName || "";
    if (phoneField && !phoneField.value) phoneField.value = customer.phone || "";
    if (addressField && !addressField.value) addressField.value = customer.address || "";
  } catch (error) {
    console.warn("Could not prefill customer profile:", error);
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

async function loadContactChannels() {
  const container = document.getElementById("contact-channels");
  if (!container) return;
  try {
    const snap = await getDoc(doc(db, "settings", "business"));
    const settings = snap.exists() ? snap.data() : {};
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
document.getElementById("public-order-form").addEventListener("submit", submitOrder);

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
    const handledWhatsAppLink = await applyWhatsAppOrderLink();
    if (!handledWhatsAppLink) await applyReorderFromQuery();
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

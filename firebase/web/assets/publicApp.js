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
  buildOrderDraft,
  computeOrderTotals,
  DA_NANG_DELIVERY_BOUNDS,
  deliveryDateProblem,
  escapeHtml,
  formatCurrency,
  humanizeCustomerError,
  isBrokenDepositBalance,
  isInsideDeliveryArea,
  normalizePhoneWithCountry,
  ORDER_DRAFT_STORAGE_KEY,
  parseStoredOrderDraft,
  phoneEntryErrorMessage,
  preAppEmptyTypesFromCatalog,
  productCategoryKey,
  productImageUrl,
  resolveSubmissionKey,
  setupPhoneCountryPicker,
  splitPhoneWithCountry,
  setDeliveryWindow,
  submissionFingerprint,
  summarizeHeldContainers,
  summarizePreAppEmptiesClaim,
  summarizeReorderChanges,
  todayKeyInZone,
  withSubmitLock
} from "./shared.js";
import { mapsApiKey, mapsDefaultCenter } from "./firebaseWebConfig.js";

const submitPublicOrderFn = httpsCallable(functions, "submitPublicOrder");

// P0-02: the key that makes a Retry return the already-created order instead
// of duplicating it. Lives in localStorage so it survives a reload between the
// lost response and the retry; cleared only after a success the customer saw.
const SUBMISSION_KEY_STORAGE = "vs-order-submission-key";

function readStoredSubmissionKey() {
  try {
    return JSON.parse(localStorage.getItem(SUBMISSION_KEY_STORAGE) || "null");
  } catch (_) {
    return null;
  }
}

function writeStoredSubmissionKey(entry) {
  try {
    if (entry) localStorage.setItem(SUBMISSION_KEY_STORAGE, JSON.stringify(entry));
    else localStorage.removeItem(SUBMISSION_KEY_STORAGE);
  } catch (_) {
    // Private-mode storage failures just lose idempotency, not ordering.
  }
}

// --- P0-10: draft that survives the email sign-in navigation -----------------
// Google sign-in is a popup (page never unloads); email sign-in navigates to
// account.html and the emailed link. Saving here is what makes the sign-in
// modal's "Your cart is kept" true on BOTH paths. Pure shape/validation logic
// lives in shared.js (buildOrderDraft/parseStoredOrderDraft) so it is testable.

function readStoredOrderDraft() {
  try {
    return parseStoredOrderDraft(localStorage.getItem(ORDER_DRAFT_STORAGE_KEY));
  } catch (_) {
    return null;
  }
}

function writeStoredOrderDraft(draft) {
  try {
    if (draft) localStorage.setItem(ORDER_DRAFT_STORAGE_KEY, JSON.stringify(draft));
    else localStorage.removeItem(ORDER_DRAFT_STORAGE_KEY);
  } catch (_) {
    // Private-mode storage failures just lose the draft, not ordering.
  }
}

// Snapshot the live form + cart. Called from the links that navigate away to
// sign in; a null result (nothing typed, nothing in the cart) clears any
// stale stored draft instead.
function captureOrderDraft() {
  const form = document.getElementById("public-order-form");
  if (!form) return null;
  return buildOrderDraft({
    quantities: state.quantities,
    fields: {
      name: form.customerName?.value,
      phoneNational: form.phone?.value,
      phoneCountry: document.getElementById("form-phone-country")?.value,
      address: form.address?.value,
      deliveryDate: form.deliveryDate?.value,
      deliveryWindow: form.deliveryWindow?.value,
      notes: form.notes?.value
    },
    deliveryLocation: state.deliveryLocation
  });
}

function saveOrderDraftForSignIn() {
  writeStoredOrderDraft(captureOrderDraft());
}

// One-shot restore on return. Runs only after BOTH auth and the catalog have
// resolved: the quantities need the product list, and prefillFromCustomer must
// already have run so the draft's values (what the customer typed minutes ago)
// win over the profile prefill, not the other way round. The address + pin are
// restored only while the manual address editor is in charge — for a returning
// customer with saved addresses, the saved-address flow is deliberately
// authoritative (its comment: do not preserve a stale typed address).
function restoreOrderDraftIfAny() {
  const draft = readStoredOrderDraft();
  if (!draft) return false;
  writeStoredOrderDraft(null);
  const form = document.getElementById("public-order-form");
  if (!form) return false;
  const f = draft.fields || {};
  if (f.name && form.customerName) form.customerName.value = f.name;
  if (f.phoneNational && form.phone) form.phone.value = f.phoneNational;
  if (f.phoneCountry) {
    setupPhoneCountryPicker(document.getElementById("form-phone-country-picker"))?.setValue(f.phoneCountry);
  }
  if (f.deliveryDate && form.deliveryDate) form.deliveryDate.value = f.deliveryDate;
  if (f.deliveryWindow) setDeliveryWindow(document.getElementById("delivery-window"), f.deliveryWindow);
  if (f.notes && form.notes) form.notes.value = f.notes;
  const manualAddressMode = document.getElementById("saved-address-control")?.hidden !== false;
  if (manualAddressMode && f.address && form.address) {
    form.address.value = f.address;
    if (draft.deliveryLocation) {
      state.deliveryLocation = { ...draft.deliveryLocation };
      setAddressVerifyStatus("✓ Delivery location confirmed on Google Maps.", true);
    }
  }
  if (Object.keys(draft.quantities || {}).length) {
    state.quantities = { ...draft.quantities };
    renderCatalog();
    renderTotals();
  }
  refreshDeliveryDateFloor();
  setPublicFeedback("Welcome back — your order is exactly where you left it. Check it and submit when ready.");
  return true;
}

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

let publicOpenOrdersRequestId = 0;
let emptiesPickupRequestId = 0;

const PUBLIC_OPEN_ORDER_LABELS = {
  pending_approval: "Waiting for confirmation",
  new: "Confirmed",
  assigned: "Being prepared",
  out_for_delivery: "On the way"
};

async function renderPublicOpenOrders(user) {
  const section = document.getElementById("public-open-orders");
  const list = document.getElementById("public-open-orders-list");
  const count = document.getElementById("public-open-orders-count");
  if (!section || !list || !count) return;
  const requestId = ++publicOpenOrdersRequestId;
  if (!user) {
    section.classList.add("hidden");
    list.innerHTML = "";
    count.textContent = "";
    return;
  }
  try {
    // P0-05: no limit — an open order older than the newest 25 must still show
    // here. Scoped to the customer's own orders via the (authUid, createdAt)
    // index; at this scale one customer's order count is small.
    const snapshot = await getDocs(query(
      collection(db, "orders"),
      where("authUid", "==", user.uid),
      orderBy("createdAt", "desc")
    ));
    if (requestId !== publicOpenOrdersRequestId) return;
    const open = snapshot.docs
      .map((item) => ({ id: item.id, ...item.data() }))
      .filter((order) => order.status !== "delivered" && order.status !== "cancelled");
    if (!open.length) {
      section.classList.add("hidden");
      list.innerHTML = "";
      count.textContent = "";
      return;
    }
    count.textContent = `(${open.length})`;
    section.classList.remove("hidden");
    list.innerHTML = open.slice(0, 3).map((order) => {
      const total = Number(order.subtotal || 0) + Number(order.depositTotal || 0);
      const status = PUBLIC_OPEN_ORDER_LABELS[order.status] || order.status || "Open";
      const detailHref = `./customer-order.html?id=${encodeURIComponent(order.id)}`;
      return `
        <a class="public-open-order" href="${detailHref}" style="color:inherit;text-decoration:none" aria-label="View order ${escapeHtml(order.orderId || order.id)}">
          <div class="public-open-order-main">
            <strong>${escapeHtml(status)}</strong>
            <div class="public-open-order-meta">${escapeHtml(order.deliveryDate ? `Delivery ${order.deliveryDate}` : "Delivery date to be confirmed")} · ${escapeHtml(order.orderId || order.id)}</div>
          </div>
          <span class="public-open-order-total">${escapeHtml(formatCurrency(total))} →</span>
        </a>
      `;
    }).join("");
  } catch (error) {
    if (requestId !== publicOpenOrdersRequestId) return;
    section.classList.add("hidden");
    console.warn("Could not load open orders on the order form:", error);
  }
}

// ---------------------------------------------------------------------------
// Empties pickup on the order form
//
// Ty asked whether a customer should be able to deduct their deposit here. They
// should not, and this is the alternative. A customer-typed deduction is a
// deposit credit created with nobody having counted a container, and it puts a
// discount on the order hours before the driver discovers there are no empties
// waiting. Deposit money moves in exactly one place — the delivery dialog,
// against containers the driver physically counted, with a photo.
//
// What the customer CAN usefully do is say "come and get them". That request
// already exists as `emptiesPickupRequested` on the customer doc: it badges the
// today board, shows in both delivery dialogs, and clears itself when the
// delivery is saved. It just lived only on account.html, which nobody visits
// while placing an order. This surfaces the same flag at the moment the
// customer is actually thinking about it.
//
// Everything below is deliberately non-binding. The figure shown is an estimate
// in prose; it is NOT added to computeOrderTotals, depositTotal or the "Pay on
// delivery" figure, because a credit that has not been earned must never reach
// the order.
// No rules change: the customers update rule blacklists owner-managed keys, so
// a signed-in customer may already set these two keys on their own doc — the
// same write account.html has been making.
const PUBLIC_CONTAINER_LABELS = {
  glass_crate: "glass crates",
  "18_9l_jug": "18.9 L jugs",
  "19l_jug": "19 L jugs",
  "20l_jug": "20 L jugs",
  mixed: "containers"
};

function publicContainerLabel(type, qty) {
  const plural = PUBLIC_CONTAINER_LABELS[type] || String(type || "containers").replace(/_/g, " ");
  return Number(qty) === 1 ? plural.replace(/s$/, "") : plural;
}

async function loadHeldContainersForUid(uid) {
  const snap = await getDocs(query(collection(db, "depositEvents"), where("authUid", "==", uid)));
  return summarizeHeldContainers(snap.docs.map((row) => row.data()));
}

// --- Old-customer opening empties (non-binding declaration) ----------------
//
// A customer who used the business before this app existed already holds
// containers whose cash deposit the ledger has no record of. renderEmptiesPickup
// shows this block instead of the pickup card when a signed-in customer holds
// nothing on the ledger yet. The counts are a CLAIM the owner confirms later
// (confirmPreAppEmpties); the money estimate is prose and is NEVER added to the
// order totals or the callable's priced fields.
const preAppEmpties = { active: false, counts: {} };

function renderPreAppEmpties(canShow) {
  const card = document.getElementById("preapp-empties");
  if (!card) return;
  const types = canShow ? preAppEmptyTypesFromCatalog(state.products) : [];
  if (!canShow || !types.length) {
    card.classList.add("hidden");
    // Drop any stale declaration so it can never ride along on the payload.
    preAppEmpties.active = false;
    preAppEmpties.counts = {};
    return;
  }
  card.classList.remove("hidden");
  renderPreAppChoice();
  renderPreAppRows(types);
  renderPreAppPreview(types);
}

function setPreAppActive(active) {
  preAppEmpties.active = active === true;
  if (!preAppEmpties.active) preAppEmpties.counts = {};
  const types = preAppEmptyTypesFromCatalog(state.products);
  renderPreAppChoice();
  renderPreAppRows(types);
  renderPreAppPreview(types);
}

function renderPreAppChoice() {
  document.querySelectorAll("[data-preapp-choice]").forEach((btn) => {
    const isOld = btn.dataset.preappChoice === "old";
    const pressed = isOld ? preAppEmpties.active : !preAppEmpties.active;
    btn.setAttribute("aria-pressed", String(pressed));
    btn.classList.toggle("is-selected", pressed);
  });
  const body = document.getElementById("preapp-empties-body");
  if (body) body.classList.toggle("hidden", !preAppEmpties.active);
}

function renderPreAppRows(types) {
  const wrap = document.getElementById("preapp-empties-rows");
  if (!wrap) return;
  wrap.innerHTML = types.map((t) => {
    const qty = Math.max(0, Math.floor(Number(preAppEmpties.counts[t.containerType]) || 0));
    const label = publicContainerLabel(t.containerType, 2);
    return `
      <div class="preapp-row${qty > 0 ? "" : " is-zero"}">
        <span class="preapp-row-label">${escapeHtml(label)}</span>
        <div class="preapp-stepper">
          <button type="button" class="preapp-step" data-preapp-minus="${escapeHtml(t.containerType)}" aria-label="One fewer ${escapeHtml(label)}">−</button>
          <span class="preapp-qty" data-preapp-qty="${escapeHtml(t.containerType)}">${qty}</span>
          <button type="button" class="preapp-step" data-preapp-plus="${escapeHtml(t.containerType)}" aria-label="One more ${escapeHtml(label)}">+</button>
        </div>
      </div>`;
  }).join("");
  wrap.querySelectorAll("[data-preapp-minus]").forEach((b) => {
    b.addEventListener("click", () => adjustPreAppCount(b.dataset.preappMinus, -1, types));
  });
  wrap.querySelectorAll("[data-preapp-plus]").forEach((b) => {
    b.addEventListener("click", () => adjustPreAppCount(b.dataset.preappPlus, 1, types));
  });
}

function adjustPreAppCount(type, delta, types) {
  const current = Math.max(0, Math.floor(Number(preAppEmpties.counts[type]) || 0));
  const next = Math.min(999, Math.max(0, current + delta));
  if (next > 0) preAppEmpties.counts[type] = next;
  else delete preAppEmpties.counts[type];
  const node = wrap_preAppQtyNode(type);
  if (node) {
    node.textContent = String(next);
    node.closest(".preapp-row")?.classList.toggle("is-zero", next === 0);
  }
  renderPreAppPreview(types);
}

function wrap_preAppQtyNode(type) {
  const rows = document.getElementById("preapp-empties-rows");
  if (!rows) return null;
  return Array.from(rows.querySelectorAll("[data-preapp-qty]"))
    .find((node) => node.getAttribute("data-preapp-qty") === String(type)) || null;
}

function renderPreAppPreview(types) {
  const box = document.getElementById("preapp-empties-preview");
  if (!box) return;
  const { lines, totalQty, totalDeposit } = summarizePreAppEmptiesClaim(preAppEmpties.counts, types);
  if (!totalQty) {
    box.innerHTML = `<p class="preapp-preview-empty muted">Add the empties you have above.</p>`;
    return;
  }
  const rowsHtml = lines.map((l) => `
    <div class="preapp-preview-row">
      <span>${Number(l.qty)} × ${escapeHtml(publicContainerLabel(l.containerType, l.qty))}</span>
      <span>${l.depositPerUnit > 0 ? "~" + escapeHtml(formatCurrency(l.amount)) : "—"}</span>
    </div>`).join("");
  const totalLine = totalDeposit >= 1 ? `~${formatCurrency(totalDeposit)}` : "your deposit back";
  box.innerHTML = `
    <p class="preapp-preview-warn"><strong>You get money back only if you give the empties to the driver.</strong></p>
    <div class="preapp-preview-table">
      ${rowsHtml}
      <div class="preapp-preview-total"><span>Give back everything</span><strong>${escapeHtml(totalLine)}</strong></div>
    </div>
    <p class="preapp-preview-note muted">The driver checks the empties first. No money is paid before pick-up. This is an estimate — we confirm the real number and deposit.</p>`;
}

async function renderEmptiesPickup(user) {
  const card = document.getElementById("empties-pickup");
  const toggle = document.getElementById("empties-pickup-toggle");
  const summary = document.getElementById("empties-pickup-summary");
  const details = document.getElementById("empties-pickup-details");
  const status = document.getElementById("empties-pickup-status");
  if (!card || !toggle || !summary) return;
  const requestId = ++emptiesPickupRequestId;
  const hide = () => card.classList.add("hidden");
  // No profile means no deposit history to have containers against, and nothing
  // to write the flag to.
  if (!user || !state.customer?.id) {
    hide();
    renderPreAppEmpties(false);
    return;
  }
  let rows = [];
  try {
    rows = await loadHeldContainersForUid(user.uid);
  } catch (error) {
    // A container read must never stand between a customer and placing an order.
    console.warn("Could not load held containers on the order form:", error);
    hide();
    renderPreAppEmpties(false);
    return;
  }
  if (requestId !== emptiesPickupRequestId) return;
  // A below-zero balance is a broken ledger, not a holding — offering to collect
  // against it would invite a return the deposit record cannot absorb. The
  // owner's delivery dialog suppresses these the same way. Silently excluded:
  // it is the business's bookkeeping problem, not something to alarm a customer
  // with mid-order. The deposits page flags it on the owner's side.
  const holding = rows.filter((row) => Number(row.qty) > 0 && !isBrokenDepositBalance(row.qty, row.deposit));
  const requested = state.customer?.emptiesPickupRequested === true;
  // An established customer (holds something) gets the pickup card; a customer
  // with an empty ledger may be an old customer holding pre-app containers, so
  // they get the opening-empties declaration instead.
  renderPreAppEmpties(holding.length === 0);
  if (!holding.length && !requested) {
    hide();
    return;
  }
  const totalDeposit = holding.reduce((sum, row) => sum + Number(row.deposit || 0), 0);
  const parts = holding.map((row) => `${Number(row.qty)} ${publicContainerLabel(row.type, row.qty)}`);
  const held = parts.length
    ? parts.join(" · ")
    : "Collection requested";
  // "About", and only when there is something to estimate. This is the one line
  // that could be mistaken for a discount, so it stays conditional prose.
  const estimate = totalDeposit >= 1
    ? `About ${formatCurrency(totalDeposit)} is held as deposit. The driver counts what actually comes back, and your credit follows that count, so this is an estimate.`
    : "The driver counts what actually comes back, and your deposit credit follows that count.";
  summary.textContent = held;
  if (details) details.textContent = estimate;
  toggle.checked = requested;
  if (status) status.textContent = "";
  card.classList.remove("hidden");
}

async function toggleEmptiesPickup(event) {
  const toggle = event.currentTarget;
  const status = document.getElementById("empties-pickup-status");
  const requesting = toggle.checked === true;
  if (!state.user || !state.customer?.id) {
    toggle.checked = !requesting;
    return;
  }
  toggle.disabled = true;
  if (status) status.textContent = "Saving…";
  // Same two keys, same shape as account.html's toggle, so the two screens
  // cannot disagree about what "requested" means.
  const payload = {
    emptiesPickupRequested: requesting,
    emptiesPickupRequestedAt: requesting ? new Date().toISOString() : null,
    updatedAt: new Date().toISOString()
  };
  try {
    await setDoc(doc(db, "customers", state.customer.id), payload, { merge: true });
    state.customer = { ...state.customer, ...payload };
    if (status) {
      status.textContent = requesting
        ? "Saved — the driver will collect them on your next delivery."
        : "Pickup request cancelled.";
    }
  } catch (error) {
    // Put the checkbox back: leaving it ticked would promise a collection that
    // was never recorded, and the driver would arrive not knowing to ask.
    toggle.checked = !requesting;
    if (status) {
      status.textContent = humanizeCustomerError(error, {
        fallback: "We couldn't save your pickup request. Please try again.",
      });
    }
  } finally {
    toggle.disabled = false;
  }
}

document.getElementById("empties-pickup-toggle")?.addEventListener("change", toggleEmptiesPickup);

// New vs old customer choice on the opening-empties block. Static buttons, so
// wire once; renderPreAppChoice keeps their pressed state in sync.
document.querySelectorAll("[data-preapp-choice]").forEach((btn) => {
  btn.addEventListener("click", () => setPreAppActive(btn.dataset.preappChoice === "old"));
});

let mapsLoadPromise = null;
let addressMap = null;
let addressMarker = null;
let addressInfoWindow = null;
// Formatted address the current pin resolves to. Set when the confirmation
// popup is shown, cleared whenever the pin is invalidated, and read by the
// footer "Use this address" button so it can confirm the exact same pin.
let pinFormattedAddress = "";
let addressAutocompleteTimer = null;
let addressAutocompleteRequestId = 0;
let addressAutocompletePredictions = [];
let addressAutocompleteActiveIndex = -1;

// P0-03: bounds + the inside-area test now live in shared.js so the callable's
// mirrored copy has one thing to track. Local alias keeps the map call sites
// (locationRestriction, LatLngBounds) reading the same as before.
const isInsideDaNangDeliveryArea = isInsideDeliveryArea;

// P0-03: the delivery-date field's floor. Recomputed rather than captured once
// at load, because this page is left open overnight — a tab opened yesterday
// would otherwise keep offering yesterday and the server would reject it.
function refreshDeliveryDateFloor() {
  const input = document.getElementById("delivery-date");
  if (!input) return;
  const today = todayKeyInZone();
  input.min = today;
  // Only drag the value forward when it has actually gone stale. Never
  // rewrite a future date the customer deliberately picked.
  if (!input.value || input.value < today) input.value = today;
}

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

function addressAutocompleteList() {
  let list = document.getElementById("address-autocomplete-list");
  if (list) return list;
  const input = document.getElementById("form-address");
  if (!input) return null;
  list = document.createElement("div");
  list.id = "address-autocomplete-list";
  list.hidden = true;
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "Google Maps address suggestions");
  list.style.cssText = "margin-top:6px;overflow:hidden;border:1px solid #d8ddd9;border-radius:10px;background:#fff;box-shadow:0 8px 22px rgba(17,34,45,.14)";
  input.closest("label")?.insertAdjacentElement("afterend", list);
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", list.id);
  input.setAttribute("aria-expanded", "false");
  return list;
}

function closeAddressAutocomplete() {
  addressAutocompleteRequestId += 1;
  addressAutocompletePredictions = [];
  addressAutocompleteActiveIndex = -1;
  const input = document.getElementById("form-address");
  const list = document.getElementById("address-autocomplete-list");
  if (list) {
    list.hidden = true;
    list.replaceChildren();
  }
  input?.setAttribute("aria-expanded", "false");
  input?.removeAttribute("aria-activedescendant");
}

function setActiveAddressSuggestion(index) {
  if (!addressAutocompletePredictions.length) return;
  addressAutocompleteActiveIndex = (index + addressAutocompletePredictions.length)
    % addressAutocompletePredictions.length;
  const input = document.getElementById("form-address");
  document.querySelectorAll("#address-autocomplete-list [role='option']").forEach((option, optionIndex) => {
    const active = optionIndex === addressAutocompleteActiveIndex;
    option.setAttribute("aria-selected", String(active));
    option.style.background = active ? "#eef6f1" : "#fff";
    if (active) input?.setAttribute("aria-activedescendant", option.id);
  });
}

async function chooseAddressSuggestion(placePrediction) {
  const input = document.getElementById("form-address");
  if (!input || !placePrediction) return;
  const suggestedAddress = String(placePrediction.text || "").trim();
  if (!suggestedAddress) return;
  input.value = suggestedAddress.slice(0, 499);
  closeAddressAutocomplete();
  setAddressVerifyStatus("Address selected — checking its pin on Google Maps…");
  await verifyAddressOnMap();
}

function renderAddressSuggestions(predictions) {
  const list = addressAutocompleteList();
  const input = document.getElementById("form-address");
  if (!list || !input) return;
  addressAutocompletePredictions = predictions.slice(0, 5);
  addressAutocompleteActiveIndex = -1;
  list.replaceChildren();
  if (!addressAutocompletePredictions.length) {
    closeAddressAutocomplete();
    return;
  }
  addressAutocompletePredictions.forEach((prediction, index) => {
    const option = document.createElement("button");
    option.id = `address-autocomplete-option-${index}`;
    option.type = "button";
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", "false");
    option.style.cssText = "display:block;width:100%;padding:11px 12px;border:0;border-bottom:1px solid #e5e9e6;background:#fff;color:inherit;font:inherit;text-align:left;cursor:pointer";
    option.textContent = String(prediction.text || "");
    option.addEventListener("mouseenter", () => setActiveAddressSuggestion(index));
    option.addEventListener("click", () => void chooseAddressSuggestion(prediction));
    list.appendChild(option);
  });
  const attribution = document.createElement("div");
  attribution.setAttribute("translate", "no");
  attribution.style.cssText = "padding:5px 10px;color:#5e5e5e;font:400 12px Roboto,sans-serif;text-align:right";
  attribution.textContent = "Google Maps";
  list.appendChild(attribution);
  list.hidden = false;
  input.setAttribute("aria-expanded", "true");
}

async function fetchAddressSuggestions() {
  const input = document.getElementById("form-address");
  const queryText = String(input?.value || "").trim();
  if (isEmulatorMode || !mapsApiKey || queryText.length < 3 || input?.readOnly) {
    closeAddressAutocomplete();
    return;
  }
  const requestId = ++addressAutocompleteRequestId;
  try {
    const maps = await loadGoogleMaps();
    const { AutocompleteSuggestion } = await maps.importLibrary("places");
    const { suggestions } = await AutocompleteSuggestion.fetchAutocompleteSuggestions({
      input: queryText,
      includedRegionCodes: ["vn"],
      region: "vn",
      language: document.documentElement.lang || "en",
      locationRestriction: DA_NANG_DELIVERY_BOUNDS
    });
    if (requestId !== addressAutocompleteRequestId
      || queryText !== String(input.value || "").trim()) return;
    renderAddressSuggestions((suggestions || [])
      .map((suggestion) => suggestion.placePrediction)
      .filter(Boolean));
  } catch (error) {
    if (requestId === addressAutocompleteRequestId) closeAddressAutocomplete();
    console.warn("Google address suggestions unavailable; manual entry remains enabled.", error);
  }
}

function scheduleAddressSuggestions() {
  clearTimeout(addressAutocompleteTimer);
  addressAutocompleteTimer = setTimeout(() => void fetchAddressSuggestions(), 320);
}

function handleAddressAutocompleteKeydown(event) {
  if (!addressAutocompletePredictions.length) return;
  if (event.key === "ArrowDown") {
    event.preventDefault();
    setActiveAddressSuggestion(addressAutocompleteActiveIndex + 1);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    setActiveAddressSuggestion(addressAutocompleteActiveIndex < 0
      ? addressAutocompletePredictions.length - 1
      : addressAutocompleteActiveIndex - 1);
  } else if (event.key === "Enter") {
    event.preventDefault();
    void chooseAddressSuggestion(addressAutocompletePredictions[Math.max(0, addressAutocompleteActiveIndex)]);
  } else if (event.key === "Escape") {
    closeAddressAutocomplete();
  }
}

function setAddressVerifyStatus(text, verified = false, isError = false) {
  const node = document.getElementById("address-verify-status");
  if (!node) return;
  node.textContent = text;
  node.classList.toggle("address-verified", verified);
  node.classList.toggle("is-blocking", isError);
}

// A pre-order blocking message ("do X before you can order") has to be seen:
// paint it in the error colour and pull it into the middle of the screen so it
// isn't left off-screen below the Submit button. Neutral/success updates pass
// no options and clear the blocking styling again.
function setPublicFeedback(message, { error = false, scroll = false } = {}) {
  const feedback = document.getElementById("public-feedback");
  if (!feedback) return null;
  feedback.textContent = message;
  feedback.classList.toggle("is-blocking", Boolean(error));
  if (scroll && typeof feedback.scrollIntoView === "function") {
    feedback.scrollIntoView({ behavior: "smooth", block: "center" });
  }
  return feedback;
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

function setSavedAddressHelp(text = "", isError = false) {
  const help = document.getElementById("saved-address-help");
  if (!help) return;
  help.textContent = text;
  help.hidden = !text;
  help.classList.toggle("is-blocking", isError && Boolean(text));
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
  closeAddressAutocomplete();
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
  pinFormattedAddress = "";
  addressInfoWindow?.close();
  document.getElementById("address-map-wrap")?.setAttribute("hidden", "");
  setAddressVerifyStatus(message, false);
}

// Confirm the resolved pin from the always-visible footer button. The button
// lives in the page rather than inside the map InfoWindow because Google clips
// tall InfoWindow content on desktop, leaving the in-window button unreachable.
function confirmDeliveryPin() {
  if (!addressMarker || !pinFormattedAddress) return;
  const pos = addressMarker.getPosition();
  state.deliveryLocation = {
    lat: pos.lat(),
    lng: pos.lng(),
    formattedAddress: String(pinFormattedAddress).slice(0, 499),
    source: "customer_google_maps"
  };
  setAddressVerifyStatus("✓ Location confirmed on Google Maps", true);
  addressInfoWindow?.close();
}

async function verifyAddressOnMap() {
  const input = document.getElementById("form-address");
  const button = document.getElementById("address-verify-button");
  const address = String(input?.value || "").trim();
  if (address.length < 5) {
    setAddressVerifyStatus("Enter a complete delivery address first.", false, true);
    input?.focus();
    return;
  }
  button.disabled = true;
  button.textContent = "Finding…";
  state.deliveryLocation = null;
  addressInfoWindow?.close();
  setAddressVerifyStatus("Searching Google Maps…");
  try {
    await loadGoogleMaps();
    const geocoder = new google.maps.Geocoder();
    const results = await new Promise((resolve, reject) => {
      geocoder.geocode({
        address,
        region: "vn",
        componentRestrictions: { country: "vn" },
        // Bias to the Da Nang metro so an ambiguous street name resolves
        // locally instead of matching a same-named road elsewhere in Vietnam —
        // a common cause of the "partial match" dead-end.
        bounds: new google.maps.LatLngBounds(
          { lat: DA_NANG_DELIVERY_BOUNDS.south, lng: DA_NANG_DELIVERY_BOUNDS.west },
          { lat: DA_NANG_DELIVERY_BOUNDS.north, lng: DA_NANG_DELIVERY_BOUNDS.east }
        )
      }, (matches, status) => {
        if (status === "OK" && matches?.[0]) resolve(matches);
        else reject(new Error("We couldn't find that address. Add a district or nearby landmark and try again."));
      });
    });
    const match = results[0];
    if (!isInsideDaNangDeliveryArea(match.geometry.location)) {
      throw new Error("Google Maps found a result outside the Da Nang delivery area. Choose a Da Nang suggestion or enter a more complete local address.");
    }
    // Google flags many valid Da Nang addresses as a partial match. Rather than
    // dead-end, still drop the (draggable) pin at the best match and ask the
    // customer to nudge it to their exact entrance — the same confirm-by-drag
    // step a full match uses.
    let currentApproximate = Boolean(match.partial_match);
    let currentFormattedAddress = String(match.formatted_address || address);
    let pinAddressLookupId = 0;
    const position = match.geometry.location;
    const wrap = document.getElementById("address-map-wrap");
    const mapElement = document.getElementById("address-confirm-map");
    wrap.hidden = false;
    // Expand the confirmation surface only when Maps is in use. `clamp` keeps
    // it substantially larger than the 260px resting size without letting it
    // overwhelm a short phone viewport.
    mapElement.style.height = "clamp(360px, 62vh, 520px)";
    addressMap = addressMap || new google.maps.Map(mapElement, {
      center: position,
      zoom: 17,
      streetViewControl: false,
      mapTypeControl: false,
      fullscreenControl: false
    });
    google.maps.event.trigger(addressMap, "resize");
    addressMap.setCenter(position);
    if (addressMarker) addressMarker.setMap(null);
    addressMarker = new google.maps.Marker({ map: addressMap, position, draggable: true, title: "Drag to your delivery entrance" });
    // Use the supported InfoWindow API instead of reaching into Google's
    // generated `.gm-style-iw…` DOM. The popup is informational only — it shows
    // the address the pin resolved to; the customer confirms with the footer
    // "Use this address" button (see `confirmDeliveryPin`), which stays visible
    // below the map even when Google clips the InfoWindow on desktop.
    const showPinConfirmation = () => {
      pinFormattedAddress = currentFormattedAddress;

      const content = document.createElement("div");
      content.style.maxWidth = "240px";

      const title = document.createElement("strong");
      title.textContent = "Is this your delivery entrance?";
      content.appendChild(title);

      const detail = document.createElement("p");
      detail.style.margin = "6px 0 10px";
      detail.textContent = currentApproximate
        ? "Google found an approximate match. Drag the pin if needed, then choose “Use this address” below."
        : "Drag the pin if it needs correcting, then choose “Use this address” below.";
      content.appendChild(detail);

      const resolvedAddress = document.createElement("p");
      resolvedAddress.style.margin = "0";
      resolvedAddress.style.overflowWrap = "anywhere";
      const addressLabel = document.createElement("strong");
      addressLabel.textContent = "Address: ";
      resolvedAddress.append(addressLabel, document.createTextNode(currentFormattedAddress));
      content.appendChild(resolvedAddress);

      addressInfoWindow = addressInfoWindow || new google.maps.InfoWindow({ maxWidth: 280 });
      addressInfoWindow.setContent(content);
      addressInfoWindow.open({ map: addressMap, anchor: addressMarker });
    };

    setAddressVerifyStatus(currentApproximate
      ? "Check the suggested pin. Drag it if needed, or choose “Use this address”."
      : "Check the pin, then choose “Use this address”.", false);
    showPinConfirmation();
    addressMarker.addListener("dragstart", () => {
      pinAddressLookupId += 1;
      state.deliveryLocation = null;
      pinFormattedAddress = "";
      addressInfoWindow?.close();
      setAddressVerifyStatus("Pin moved — check its position, then choose “Use this address”.", false);
    });
    addressMarker.addListener("dragend", async () => {
      const draggedPosition = addressMarker.getPosition();
      const lookupId = ++pinAddressLookupId;
      addressMap.panTo(draggedPosition);
      if (!isInsideDaNangDeliveryArea(draggedPosition)) {
        setAddressVerifyStatus("That pin is outside the Da Nang delivery area. Move it back into Da Nang to continue.", false, true);
        return;
      }
      setAddressVerifyStatus("Finding the address at the corrected pin…", false);
      try {
        const reverseMatches = await new Promise((resolve, reject) => {
          geocoder.geocode({ location: draggedPosition }, (matches, status) => {
            if (status === "OK" && matches?.[0]) resolve(matches);
            else reject(new Error("Google Maps could not find a street address at that pin."));
          });
        });
        if (lookupId !== pinAddressLookupId) return;
        currentFormattedAddress = String(reverseMatches[0].formatted_address || address);
        currentApproximate = false;
        closeAddressAutocomplete();
        input.value = currentFormattedAddress.slice(0, 499);
        setAddressVerifyStatus("Pin moved — check the updated address, then choose “Use this address”.", false);
        showPinConfirmation();
      } catch (error) {
        if (lookupId !== pinAddressLookupId) return;
        setAddressVerifyStatus(`${error.message || String(error)} Move the pin again, or enter the address and search again.`, false, true);
      }
    });
    wrap.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (error) {
    clearDeliveryLocation(humanizeCustomerError(error, {
      fallback: "We couldn't open the map just now. Enter your address and tap Find on Google Maps again.",
    }));
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

function setOrderReviewCollapsed(collapsed) {
  const panel = document.getElementById("mobile-order-totals");
  const toggle = document.getElementById("order-review-toggle");
  if (!panel || !toggle) return;
  if (collapsed) setOrderReviewExpanded(false);
  panel.classList.toggle("review-collapsed", collapsed);
  toggle.setAttribute("aria-expanded", String(!collapsed));
  toggle.setAttribute("aria-label", collapsed ? "Show order item list" : "Hide order item list");
}

function setOrderReviewExpanded(expanded) {
  const panel = document.getElementById("mobile-order-totals");
  const button = document.getElementById("order-review-expand");
  if (!panel || !button) return;
  panel.classList.toggle("review-expanded", expanded);
  button.setAttribute("aria-pressed", String(expanded));
  button.setAttribute("aria-label", expanded ? "Use compact item list" : "Show the full item list");
  button.title = expanded ? "Use compact list" : "Show all items";
}

function renderTotals() {
  const lines = selectedLines();
  const totals = computeOrderTotals(lines);
  const due = totals.subtotal + totals.depositTotal;
  const panel = document.getElementById("mobile-order-totals");
  panel?.classList.toggle("has-order-items", lines.length > 0);
  panel?.classList.toggle("has-long-order-review", lines.length >= 5);
  if (!lines.length) setOrderReviewCollapsed(false);
  if (lines.length < 5) setOrderReviewExpanded(false);

  // Small ordered overview so the customer can double-check what they're about
  // to submit, right above the Submit button.
  const review = lines.length
    ? `<ul class="order-review${lines.length >= 5 ? " is-scrollable" : ""}" id="order-review-list">${lines.map((line) => `
        <li>
          <span class="order-review-name">${escapeHtml(line.productName)}</span>
          <span class="order-review-qty">× ${Number(line.quantity)}</span>
          <span class="order-review-amt">${formatCurrency(Number(line.unitPrice || 0) * Number(line.quantity))}</span>
          <button type="button" class="order-review-remove" data-remove-order-line="${escapeHtml(line.id)}" aria-label="Remove ${escapeHtml(line.productName)} from order">×</button>
        </li>`).join("")}</ul>`
    : `<p class="muted order-review-empty">No items yet — add products above and they'll be listed here to review.</p>`;

  document.getElementById("totals").innerHTML = `
    ${review}
    <div class="order-total-summary">
      <div class="order-total-cell"><span class="muted">Subtotal</span><strong>${formatCurrency(totals.subtotal)}</strong></div>
      <div class="order-total-cell"><span class="muted order-deposit-label">Deposit <button type="button" class="info-dot" id="deposit-info" aria-label="What is a deposit?" aria-expanded="false">?</button></span><strong>${formatCurrency(totals.depositTotal)}</strong></div>
      <div class="order-total-cell order-total-due"><span class="muted">Pay on delivery</span><strong>${formatCurrency(due)}</strong></div>
    </div>
    <p id="deposit-note" class="muted deposit-note hidden">Refundable deposit for returnable crates and jugs. You get it back when they are returned.</p>
  `;

  const info = document.getElementById("deposit-info");
  if (info) {
    info.addEventListener("click", () => {
      const note = document.getElementById("deposit-note");
      if (!note) return;
      const open = note.classList.toggle("hidden");
      info.setAttribute("aria-expanded", String(!open));
    });
  }

  document.querySelectorAll("[data-remove-order-line]").forEach((button) => {
    button.addEventListener("click", () => {
      const productId = button.dataset.removeOrderLine;
      if (!productId) return;
      adjustQuantity(productId, -Number(state.quantities[productId] || 0));
    });
  });
}

function adjustQuantity(productId, delta) {
  const current = Number(state.quantities[productId] || 0);
  const next = Math.max(0, current + delta);
  state.quantities[productId] = next;
  const node = document.querySelector(`[data-qty-value="${productId}"]`);
  if (node) {
    node.textContent = String(next);
  }
  // P0-10: announce the result to screen readers ("Uni 20L Jug: 2 in cart")
  // without stealing focus — the +/- buttons only say what they do, not what
  // the cart now holds.
  const announcer = document.getElementById("cart-live-status");
  if (announcer && next !== current) {
    const product = state.products.find((p) => p.id === productId);
    announcer.textContent = `${product?.productName || "Item"}: ${next} in cart`;
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
        <button class="ghost" type="button" data-qty-minus="${escapeHtml(product.id)}" aria-label="Remove one ${escapeHtml(product.productName)}">-</button>
        <span class="qty-value" data-qty-value="${escapeHtml(product.id)}">${Number(state.quantities[product.id] || 0)}</span>
        <button class="primary" type="button" data-qty-plus="${escapeHtml(product.id)}" aria-label="Add one ${escapeHtml(product.productName)}">+</button>
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
  const payload = {
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
  // Non-binding old-customer opening-empties claim. Server stores it on the
  // order for the owner to confirm; it never touches the priced fields.
  if (preAppEmpties.active) {
    const counts = {};
    Object.keys(preAppEmpties.counts).forEach((type) => {
      const qty = Math.max(0, Math.floor(Number(preAppEmpties.counts[type]) || 0));
      if (qty > 0) counts[type] = qty;
    });
    if (Object.keys(counts).length) payload.preAppEmptiesClaim = counts;
  }
  return payload;
}

async function applyReorderById(reorderId) {
  const feedback = document.getElementById("public-feedback");
  const cached = state.pastItemsByOrderId[reorderId];
  // The /orderItems read rule requires authUid==myUid, and Firestore denies a
  // list unless the QUERY proves that — a query by orderId alone is rejected
  // ("Property authUid is undefined … for 'list'"), which silently broke every
  // customer reorder. Constrain on authUid too (two equality filters, no
  // composite index needed). Signed out there is nothing to reorder.
  const uid = state.user?.uid || null;
  if (!cached && !uid) {
    if (feedback) feedback.textContent = "Sign in to load one of your past orders.";
    return false;
  }
  const items = cached
    || (await getDocs(query(
        collection(db, "orderItems"),
        where("orderId", "==", reorderId),
        where("authUid", "==", uid)
      ))).docs.map((d) => d.data());
  if (!cached) state.pastItemsByOrderId[reorderId] = items;
  if (!items.length) {
    if (feedback) feedback.textContent = "Could not load that past order to reorder. It may have been removed.";
    return false;
  }
  // Rebuild the cart at today's catalog and tell the customer what changed since
  // that order: products retired since (dropped — add a replacement) and unit
  // prices that moved (the cart is priced at today's rate). Pure diff in
  // shared.js so it can be tested without a browser; wording stays here.
  const { quantities, dropped, priceChanges } = summarizeReorderChanges(items, state.products);
  state.quantities = quantities;
  renderCatalog();
  renderTotals();
  if (feedback) {
    const messages = [];
    if (dropped.length) {
      const list = dropped.join(", ");
      messages.push(dropped.length === 1
        ? `${list} is no longer available, so it was left out of this reorder. Add a replacement before you submit.`
        : `These items from that order are no longer available and were left out: ${list}. Add replacements before you submit.`);
    }
    if (priceChanges.length) {
      const list = priceChanges
        .map((c) => `${c.name} is now ${formatCurrency(c.now)} (was ${formatCurrency(c.was)})`)
        .join("; ");
      messages.push(priceChanges.length === 1
        ? `One price has changed since that order — ${list}. Your total uses today's prices.`
        : `Some prices have changed since that order — ${list}. Your total uses today's prices.`);
    }
    feedback.textContent = messages.join(" ");
  }
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
    if (feedback) {
      feedback.textContent = humanizeCustomerError(error, {
        fallback: "We couldn't reload that order. Please try again.",
      });
    }
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
  // Same authUid constraint as applyReorderById — the orderItems list rule
  // requires it, so a by-orderId-only query is denied. These are the customer's
  // own past orders, so state.user.uid always matches.
  const uid = state.user?.uid || null;
  if (!uid) {
    missing.forEach((order) => { state.pastItemsByOrderId[order.id] = []; });
    return;
  }
  await Promise.all(missing.map(async (order) => {
    try {
      const snap = await getDocs(query(
        collection(db, "orderItems"),
        where("orderId", "==", order.id),
        where("authUid", "==", uid)
      ));
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
    setReorderDialogStatus(
      humanizeCustomerError(error, { fallback: "We couldn't load your past orders. Please try again." }),
      true
    );
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
      const suffix = prefilled.length
        ? ` Prefilled ${prefilled.join(", ")} from that order.`
        : "";
      setPublicFeedback(`Loaded items from order ${orderId}. Review, then Submit.${suffix}`);
    } else {
      setReorderDialogStatus("Could not load that past order. It may have been removed.", true);
    }
  } catch (error) {
    setReorderDialogStatus(
      humanizeCustomerError(error, { fallback: "We couldn't add that order to your cart. Please try again." }),
      true
    );
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
    setReorderDialogStatus(
      humanizeCustomerError(error, { fallback: "We couldn't load more orders. Please try again." }),
      true
    );
  }
}

async function submitOrder(event) {
  event.preventDefault();
  const form = event.currentTarget;
  // Ordering requires sign-in. The server rejects guest orders too; this is the
  // friendly stop (reached via Enter-to-submit — the button click opens the
  // modal directly). Pop the sign-in modal instead of bouncing the customer.
  if (!state.user) {
    openSignInDialog();
    return;
  }
  if (!state.deliveryLocation && !isEmulatorMode) {
    const savedAddressMissingPin = state.addressMode === "primary" || state.addressMode === "additional";
    const message = savedAddressMissingPin
      ? "This older saved delivery profile is missing its stored pin. Edit it once under My account → Delivery addresses."
      : "Confirm your delivery address on Google Maps before submitting.";
    setPublicFeedback(message, { error: true, scroll: true });
    if (savedAddressMissingPin) setSavedAddressHelp(message, true);
    else setAddressVerifyStatus(message, false, true);
    (savedAddressMissingPin
      ? document.getElementById("saved-address-select")
      : document.getElementById("address-verify-button"))?.focus();
    return;
  }

  // Phones are stored E.164-only so wa.me links work (Ty, 2026-07-16).
  // Vietnamese local formats normalize to +84 automatically; other countries
  // must be typed with their country code. The field is rewritten so the
  // customer sees exactly what we will store, and the server enforces the
  // same rule — this check just makes the error arrive before the round-trip.
  const phoneE164 = normalizePhoneWithCountry(form.phone?.value, document.getElementById("form-phone-country")?.value);
  if (!phoneE164) {
    setPublicFeedback(phoneEntryErrorMessage(form.phone?.value), { error: true, scroll: true });
    form.phone?.focus();
    return;
  }
  if (form.phone) form.phone.value = phoneE164;
  if (!selectedLines().length) {
    setPublicFeedback("Select at least one item.", { error: true, scroll: true });
    return;
  }

  // P0-10: submitting the form opens the final review — nothing is sent until
  // "Place order" is pressed inside the dialog.
  openOrderReviewDialog();
}

// --- P0-10: the true final review -------------------------------------------
// One tap used to submit immediately; the sticky totals never showed the
// address, phone, date or notes about to be sent. The review reads the SAME
// computed state the totals panel uses — selectedLines() + computeOrderTotals()
// — so there is no second deposit calculation to drift.

function renderOrderReviewBody() {
  const form = document.getElementById("public-order-form");
  const lines = selectedLines();
  const totals = computeOrderTotals(lines);
  const editButton = (target, label) =>
    `<button type="button" class="ghost order-review-edit" data-review-edit="${target}" aria-label="Edit ${label}">Edit</button>`;

  const itemRows = lines.map((line) => `
    <li>
      <span class="order-review-name">${escapeHtml(line.productName)}</span>
      <span class="order-review-qty">× ${Number(line.quantity)}</span>
      <span class="order-review-amt">${formatCurrency(Number(line.unitPrice || 0) * Number(line.quantity))}</span>
    </li>`).join("");

  const windowSelect = document.getElementById("delivery-window");
  const windowLabel = windowSelect?.selectedOptions?.[0]?.textContent?.trim() || form.deliveryWindow?.value?.trim() || "Any time";
  const pin = state.deliveryLocation;
  const pinLine = pin?.formattedAddress && pin.formattedAddress !== form.address?.value?.trim()
    ? `<div class="muted order-review-pin">Pin: ${escapeHtml(pin.formattedAddress)}</div>`
    : "";
  const notes = String(form.notes?.value || "").trim();
  return `
    <section class="order-review-section" id="order-review-items-section">
      <div class="order-review-section-head"><h4>Items</h4>${editButton("items", "the items")}</div>
      <ul class="order-review">${itemRows}</ul>
      <div class="order-total-summary">
        <div class="order-total-cell"><span class="muted">Subtotal</span><strong>${formatCurrency(totals.subtotal)}</strong></div>
        <div class="order-total-cell"><span class="muted">Deposit</span><strong>${formatCurrency(totals.depositTotal)}</strong></div>
        <div class="order-total-cell order-total-due"><span class="muted">Pay on delivery</span><strong>${formatCurrency(totals.subtotal + totals.depositTotal)}</strong></div>
      </div>
    </section>
    <section class="order-review-section">
      <div class="order-review-section-head"><h4>Contact</h4>${editButton("contact", "your contact details")}</div>
      <p><strong>${escapeHtml(String(form.customerName?.value || "").trim())}</strong> · ${escapeHtml(String(form.phone?.value || "").trim())}</p>
    </section>
    <section class="order-review-section">
      <div class="order-review-section-head"><h4>Delivery address</h4>${editButton("address", "the delivery address")}</div>
      <p>${escapeHtml(String(form.address?.value || "").trim())}</p>
      ${pinLine}
    </section>
    <section class="order-review-section">
      <div class="order-review-section-head"><h4>When</h4>${editButton("delivery", "the delivery date and window")}</div>
      <p>${escapeHtml(String(form.deliveryDate?.value || "").trim())} · ${escapeHtml(windowLabel)}</p>
    </section>
    <section class="order-review-section">
      <div class="order-review-section-head"><h4>Notes for the driver</h4>${editButton("notes", "the notes")}</div>
      <p>${notes ? escapeHtml(notes) : '<span class="muted">None</span>'}</p>
    </section>
  `;
}

function openOrderReviewDialog() {
  const dialog = document.getElementById("order-review-dialog");
  const body = document.getElementById("order-review-dialog-body");
  if (!dialog || !body) return;
  // Keep the live pickup control (and its change listener) inside the review's
  // scroll region. Hold the node while replacing the generated sections, then
  // reattach that same node rather than cloning it.
  const pickupCard = document.getElementById("empties-pickup");
  const preAppCard = document.getElementById("preapp-empties");
  body.innerHTML = renderOrderReviewBody();
  // Keep the empties right under the order total, not stranded at the bottom
  // (Ty): a customer must see the deposit/empties context next to the amount,
  // before scrolling past Contact/Address/When/Notes. Insert after the Items
  // section (which ends with the totals); fall back to the end if it's absent.
  // Only one card is ever un-hidden (renderEmptiesPickup decides), but both are
  // persistent nodes that must survive the innerHTML rewrite above.
  const emptiesAnchor = document.getElementById("order-review-items-section");
  if (emptiesAnchor) {
    if (pickupCard) emptiesAnchor.after(pickupCard);
    if (preAppCard) emptiesAnchor.after(preAppCard);
  } else {
    if (preAppCard) body.appendChild(preAppCard);
    if (pickupCard) body.appendChild(pickupCard);
  }
  pickupCard?.querySelector("details")?.removeAttribute("open");
  const confirmBtn = document.getElementById("order-review-dialog-confirm");
  if (confirmBtn) {
    confirmBtn.disabled = false;
    confirmBtn.textContent = "Place order";
  }
  const status = document.getElementById("order-review-dialog-status");
  if (status) {
    status.textContent = "";
    status.classList.remove("is-error");
  }
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
}

function closeOrderReviewDialog() {
  const dialog = document.getElementById("order-review-dialog");
  if (!dialog) return;
  if (typeof dialog.close === "function") dialog.close();
  else dialog.removeAttribute("open");
  // The phone gate rewrote the field to E.164 before the review opened; going
  // back to edit should show the national number + country picker again.
  syncPublicPhoneCountry();
}

// "Edit" inside the review: close and land the customer on the section they
// asked for, form state untouched (it was never cleared).
function handleOrderReviewEdit(target) {
  closeOrderReviewDialog();
  if (target === "items") {
    document.getElementById("catalog-glass")?.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  const focusTarget = {
    contact: "form-customer-name",
    address: "form-address",
    delivery: "delivery-date",
    pickup: "empties-pickup-toggle"
  }[target];
  if (focusTarget) {
    const node = document.getElementById(focusTarget);
    node?.scrollIntoView({ behavior: "smooth", block: "center" });
    node?.focus?.({ preventScroll: true });
    return;
  }
  if (target === "notes") {
    const notes = document.getElementById("public-order-form")?.notes;
    notes?.scrollIntoView({ behavior: "smooth", block: "center" });
    notes?.focus?.({ preventScroll: true });
  }
}

async function handleOrderReviewConfirm(event) {
  // Keep "Check your order" open while the order is sent so the customer is not
  // bounced back to the form mid-flight. Only a confirmed order closes it (which
  // reveals the confirmation on the form beneath); an error keeps the review
  // open with the reason, so nothing typed is lost and they can retry here.
  const confirmBtn = document.getElementById("order-review-dialog-confirm");
  const status = document.getElementById("order-review-dialog-status");
  const originalLabel = confirmBtn?.textContent;
  if (confirmBtn) {
    confirmBtn.disabled = true;
    confirmBtn.textContent = "Placing order…";
  }
  if (status) {
    status.textContent = "Sending your order…";
    status.classList.remove("is-error");
  }
  const outcome = await performOrderSubmit(event);
  if (outcome && outcome.orderId) {
    closeOrderReviewDialog();
    return;
  }
  if (status) {
    status.textContent = (outcome && outcome.error) || "Could not place the order. Please try again.";
    status.classList.add("is-error");
  }
  if (confirmBtn) {
    confirmBtn.disabled = false;
    confirmBtn.textContent = originalLabel || "Place order";
  }
}

// The actual submission — everything below ran inline in submitOrder before
// P0-10; only the entry point changed (the review dialog's "Place order").
async function performOrderSubmit(lockEvent) {
  const form = document.getElementById("public-order-form");
  const feedback = document.getElementById("public-feedback");
  const submitButton = document.querySelector('button[form="public-order-form"][type="submit"]');
  setPublicFeedback("Submitting order...");

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
  let successWasDuplicate = false;
  let submitError = null;
  await withSubmitLock(lockEvent, async () => {
    try {
      const payload = buildCallablePayload(form);
      // Same order (same fingerprint, <24h) reuses the stored key so a retry
      // after a lost response cannot create a second order; a changed order
      // rotates it. Persist BEFORE the call: a reload while the request is
      // in flight must not lose the key.
      const fingerprint = submissionFingerprint(payload);
      const resolved = resolveSubmissionKey(readStoredSubmissionKey(), fingerprint);
      writeStoredSubmissionKey({ key: resolved.key, fingerprint, at: Date.now() });
      payload.submissionKey = resolved.key;
      const result = await submitPublicOrderFn(payload);
      const orderId = result?.data?.orderId;
      if (!orderId) throw new Error("Order was not confirmed. Please try again.");
      successWasDuplicate = result?.data?.duplicate === true;
      writeStoredSubmissionKey(null);
      // A submitted order retires any sign-in draft too — nothing should
      // resurrect a cart that was just delivered to the server.
      writeStoredOrderDraft(null);
      form.reset();
      state.deliveryLocation = null;
      document.getElementById("address-map-wrap")?.setAttribute("hidden", "");
      setAddressVerifyStatus("Confirm the delivery pin to help us find you.");
      state.quantities = {};
      // A placed order carried any opening-empties declaration with it; clear it
      // so the next order for this now-established customer starts clean.
      preAppEmpties.active = false;
      preAppEmpties.counts = {};
      renderCatalog();
      renderTotals();
      refreshDeliveryDateFloor();
      setDeliveryWindow(document.getElementById("delivery-window"), "");
      successOrderId = orderId;
    } catch (error) {
      // Callable errors surface as { code, message, details } from HttpsError.
      // humanizeCustomerError keeps the server's authored validation text (bad
      // date, out-of-area, unknown product) but turns infra/auth codes into a
      // plain, actionable line so a shopper doesn't abandon the order at the wall.
      submitError = humanizeCustomerError(error, {
        fallback: "Your order didn't go through. Please check your connection and tap Place order again.",
      });
      setPublicFeedback(submitError, { error: true, scroll: true });
    }
  }, { busyLabel: "Submitting..." });

  // The callable needs E.164, but the visible field owns only the national
  // number because its country code is already shown in the adjacent picker.
  if (successOrderId) {
    setupPhoneCountryPicker(document.getElementById("form-phone-country-picker"))?.setValue("+84");
  } else {
    syncPublicPhoneCountry();
  }

  if (successOrderId && submitButton) {
    submitButton.disabled = true;
    submitButton.classList.add("success-locked");
    submitButton.textContent = "Ordered ✓";
    feedback.classList.remove("is-blocking");
    // Close the loop on the pickup request: the customer ticked a box several
    // minutes ago and should see it was carried onto the order they just placed,
    // otherwise the only confirmation is a checkbox that scrolled away.
    const pickupLine = state.customer?.emptiesPickupRequested === true
      ? `<div>Have your empties ready — the driver counts what comes back at the door, and the deposit for that count comes off your bill.</div>`
      : "";
    // duplicate: the server matched this submission to an order it already
    // created (a retry whose first response was lost). Say so — the customer
    // may have hit Retry expecting a fix, not a second delivery.
    const receivedLine = successWasDuplicate
      ? `<strong>Order ${escapeHtml(successOrderId)} was already received.</strong>
        <div>This looked like a repeat of an order we already have, so we didn't create a second one. Check "View your orders" below — if you really wanted another delivery, change the order (or wait a day) and submit again.</div>`
      : `<strong>Order ${escapeHtml(successOrderId)} received.</strong>
        <div>Thanks! We'll confirm shortly and message you before delivery.</div>`;
    feedback.innerHTML = `
      <div class="order-confirmation">
        ${receivedLine}
        ${pickupLine}
        <div class="button-row top-gap"><a class="button-link secondary" href="./account.html">View your orders</a></div>
      </div>
    `;
    renderPublicOpenOrders(state.user);
    renderEmptiesPickup(state.user);
    try {
      await persistDeliveryAddressChoice(submittedIdentity);
    } catch (error) {
      console.warn("Could not save delivery address choice:", error);
      feedback.insertAdjacentHTML(
        "beforeend",
        `<p class="muted">Your order was received, but we couldn't save this delivery address to your profile: ${escapeHtml(humanizeCustomerError(error, { fallback: "we couldn't reach your profile just now — you can add it from My account later." }))}</p>`
      );
    }
    await maybeSaveIdentityToProfile(submittedIdentity);
  }

  // Let the caller (the review dialog's "Place order") decide what to do next:
  // close on a confirmed order, or stay open and show the error for a retry.
  return { orderId: successOrderId, error: submitError };
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
      if (status) {
        status.textContent = humanizeCustomerError(error, {
          fallback: "We couldn't save your details. Please try again.",
        });
      }
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
    status.classList.add("is-blocking");
    fields.find((field) => field && !field.checkValidity())?.reportValidity();
    return;
  }
  // Same E.164-only rule as the order form — stored phones must carry the
  // country code so wa.me links work.
  const phoneE164 = normalizePhoneWithCountry(phone, document.getElementById("form-phone-country")?.value);
  if (!phoneE164) {
    status.textContent = phoneEntryErrorMessage(phone);
    status.classList.add("is-blocking");
    return;
  }
  button.disabled = true;
  button.textContent = "Saving…";
  status.textContent = "Saving your contact details…";
  status.classList.remove("is-blocking");
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
    status.textContent = humanizeCustomerError(error, {
      fallback: "We couldn't save your contact details. Please try again.",
    });
    status.classList.add("is-blocking");
  } finally {
    button.disabled = false;
    button.textContent = "Save contact details";
  }
}

async function prefillFromCustomer(user) {
  try {
    await prefillFromCustomerProfile(user);
  } finally {
    // Every exit path lands here — signed out, no profile yet, loaded, or the
    // read failed. The pickup block reads state.customer, which only settles
    // once the pass above is done, and it must disappear again on sign-out.
    renderEmptiesPickup(user);
  }
}

async function prefillFromCustomerProfile(user) {
  const banner = document.getElementById("signed-in-banner");
  const prevUid = state.user?.uid || null;
  state.user = user || null;
  state.customer = null;
  renderPublicOpenOrders(user);
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
  applyOrderAuthGate(!!user);
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
  // Any path that signs the customer in (modal, hero, or a returning session)
  // should dismiss the sign-in modal if it happens to be open.
  closeSignInDialog();
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
    syncPublicPhoneCountry();
    // The saved primary address is authoritative. Do not preserve a stale or
    // partially-entered address that happens to be in the form already.
    await renderSavedAddressControl();
  } catch (error) {
    console.warn("Could not prefill customer profile:", error);
    await renderSavedAddressControl();
  }
}

function syncPublicPhoneCountry() {
  const input = document.getElementById("form-phone");
  const picker = document.getElementById("form-phone-country");
  if (!input || !picker || !String(input.value).startsWith("+")) return;
  const split = splitPhoneWithCountry(input.value, picker.value);
  setupPhoneCountryPicker(document.getElementById("form-phone-country-picker"))?.setValue(split.dialCode);
  input.value = split.nationalNumber;
}

setupPhoneCountryPicker(document.getElementById("form-phone-country-picker"));

// Reflect the sign-in requirement on the submit button. Signed out, it stays
// clickable and reads "Sign in to order" — clicking it opens the sign-in modal
// (see the click handler) rather than submitting. The post-success "Ordered ✓"
// locked state sets its own label/disabled and only happens while signed in, so
// it never collides with this gate.
function applyOrderAuthGate(signedIn) {
  const submit = document.getElementById("public-submit-button");
  if (!submit || submit.classList.contains("success-locked")) return;
  submit.disabled = false;
  submit.textContent = signedIn ? "Submit order" : "Sign in to order";
}

function openSignInDialog() {
  const dialog = document.getElementById("signin-dialog");
  if (!dialog) return;
  const status = document.getElementById("signin-dialog-status");
  if (status) status.textContent = "";
  const btn = document.getElementById("signin-dialog-google");
  if (btn) btn.disabled = false;
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
}

function closeSignInDialog() {
  const dialog = document.getElementById("signin-dialog");
  if (!dialog) return;
  if (typeof dialog.close === "function") dialog.close();
  else dialog.removeAttribute("open");
}

// Google is the one-tap, stay-on-page path: the popup resolves after auth state
// flips, so onAuthStateChanged re-enables ordering and the customer's in-memory
// cart (state.quantities) is untouched. We just close the modal.
async function handleDialogGoogleSignIn() {
  const btn = document.getElementById("signin-dialog-google");
  const status = document.getElementById("signin-dialog-status");
  if (btn) btn.disabled = true;
  if (status) status.textContent = "Opening Google sign-in…";
  try {
    const result = await signInWithGoogleForEnvironment();
    if (!result) {
      if (status) status.textContent = "Sign-in cancelled.";
      if (btn) btn.disabled = false;
      return;
    }
    if (status) status.textContent = "Signed in — you can place your order now.";
    closeSignInDialog();
  } catch (error) {
    if (status) {
      status.textContent = humanizeCustomerError(error, {
        fallback: "Sign-in didn't complete. Please try again, or use the email sign-in link.",
      });
    }
    if (btn) btn.disabled = false;
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
    if (statusNode) {
      statusNode.textContent = humanizeCustomerError(error, {
        fallback: "Sign-in didn't complete. Please try again, or use the email sign-in link.",
      });
    }
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

refreshDeliveryDateFloor();
// A phone left on this page overnight, or backgrounded for hours, must not
// submit yesterday. Re-floor on every return to the tab and on a slow tick;
// both are cheap and either one alone leaves a real gap (a tab that is never
// hidden still crosses midnight).
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refreshDeliveryDateFloor();
});
window.addEventListener("focus", refreshDeliveryDateFloor);
setInterval(refreshDeliveryDateFloor, 60000);
setDeliveryWindow(document.getElementById("delivery-window"), "");
if (isEmulatorMode) {
  document.getElementById("address-verify-button")?.classList.add("hidden");
  setAddressVerifyStatus("Local test mode — map confirmation is disabled.");
}
document.getElementById("public-order-form").addEventListener("submit", submitOrder);
document.getElementById("address-verify-button")?.addEventListener("click", verifyAddressOnMap);
document.getElementById("update-account-details")?.addEventListener("click", updateAccountFromPersonalDetails);

// When the customer starts entering their personal data, snap the whole Contact
// details section to the middle of the screen so they get the full overview
// instead of a field pinned under the keyboard. One-shot so it doesn't fight
// the customer as they tab between fields.
let contactDetailsCentered = false;
function centerContactDetails() {
  if (contactDetailsCentered) return;
  contactDetailsCentered = true;
  const section = document.getElementById("contact-details-section");
  section?.scrollIntoView?.({ behavior: "smooth", block: "center" });
}
["form-customer-name", "form-phone"].forEach((id) => {
  document.getElementById(id)?.addEventListener("focus", centerContactDetails);
});
document.getElementById("saved-address-select")?.addEventListener("change", handleSavedAddressSelection);
document.getElementById("address-reset-pin")?.addEventListener("click", () => {
  clearDeliveryLocation("Pin reset — find this delivery address on the map again.");
  document.getElementById("address-verify-button")?.focus();
});
document.getElementById("address-confirm")?.addEventListener("click", confirmDeliveryPin);
const publicAddressInput = document.getElementById("form-address");
publicAddressInput?.addEventListener("input", () => {
  if (state.deliveryLocation) clearDeliveryLocation();
  closeAddressAutocomplete();
  scheduleAddressSuggestions();
});
publicAddressInput?.addEventListener("focus", scheduleAddressSuggestions);
publicAddressInput?.addEventListener("keydown", handleAddressAutocompleteKeydown);
publicAddressInput?.addEventListener("blur", () => {
  setTimeout(() => {
    if (!document.getElementById("address-autocomplete-list")?.contains(document.activeElement)) {
      closeAddressAutocomplete();
    }
  }, 120);
});

// Hide the overlay once BOTH the initial auth check has resolved AND the
// product catalog is on screen — that's the minimum "page is real" bar.
let authResolved = false;
let productsResolved = false;
// P0-10: the sign-in draft restores at the same moment, and only then — the
// quantities need the catalog, and prefillFromCustomer must already have run
// so the draft's values (what the customer typed minutes ago) win over the
// profile prefill rather than being clobbered by it.
let orderDraftRestored = false;
const maybeReveal = () => {
  if (!authResolved || !productsResolved) return;
  if (!orderDraftRestored) {
    orderDraftRestored = true;
    try {
      restoreOrderDraftIfAny();
    } catch (error) {
      console.warn("Could not restore the order draft:", error);
    }
  }
  hideAppLoading();
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
    document.getElementById("public-feedback").textContent = humanizeCustomerError(error, {
      fallback: "We couldn't load the products just now. Please refresh the page.",
    });
  })
  .finally(() => {
    productsResolved = true;
    maybeReveal();
  });

const heroGoogleBtn = document.getElementById("hero-google-signin-button");
if (heroGoogleBtn) heroGoogleBtn.addEventListener("click", handleHeroGoogleSignIn);

// Signed-out click on the order button opens the sign-in modal instead of
// submitting. Handling it on click (before the form's submit + native field
// validation) means an empty form still opens the modal rather than nagging
// the customer to fill fields they can't use yet.
document.getElementById("public-submit-button")?.addEventListener("click", (event) => {
  if (!state.user) {
    event.preventDefault();
    openSignInDialog();
  }
});
document.getElementById("signin-dialog-google")?.addEventListener("click", handleDialogGoogleSignIn);
document.getElementById("signin-dialog-close")?.addEventListener("click", closeSignInDialog);

// P0-10: both links that navigate away to sign in save the draft first — this
// is what makes the modal's "Your cart is kept" true on the email path too
// (Google is a popup and never unloads the page). account.html bounces back
// here after the emailed link completes, and the draft restores on load.
document.getElementById("signin-dialog-email")?.addEventListener("click", saveOrderDraftForSignIn);
document.getElementById("account-link")?.addEventListener("click", saveOrderDraftForSignIn);

// P0-10: final review dialog.
document.getElementById("order-review-dialog-confirm")?.addEventListener("click", handleOrderReviewConfirm);
document.getElementById("order-review-dialog-back")?.addEventListener("click", closeOrderReviewDialog);
document.getElementById("order-review-dialog-body")?.addEventListener("click", (event) => {
  const editBtn = event.target.closest("[data-review-edit]");
  if (editBtn) handleOrderReviewEdit(editBtn.dataset.reviewEdit);
});
document.getElementById("form-phone")?.addEventListener("blur", syncPublicPhoneCountry);

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

document.getElementById("order-review-toggle")?.addEventListener("click", () => {
  const panel = document.getElementById("mobile-order-totals");
  setOrderReviewCollapsed(!panel?.classList.contains("review-collapsed"));
});

document.getElementById("order-review-expand")?.addEventListener("click", () => {
  const panel = document.getElementById("mobile-order-totals");
  if (!panel) return;
  if (panel.classList.contains("review-collapsed")) setOrderReviewCollapsed(false);
  setOrderReviewExpanded(!panel.classList.contains("review-expanded"));
});

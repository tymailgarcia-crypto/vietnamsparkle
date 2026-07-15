export function formatCurrency(amount) {
  const value = Number(amount || 0);
  return new Intl.NumberFormat("en-US").format(value) + " VND";
}

// Returns today's date in the browser's local timezone as YYYY-MM-DD.
// toISOString() returns UTC — in Vietnam (UTC+7) between 00:00 and 07:00
// local, that yields yesterday's date and corrupts every business date
// defaulted from this helper.
export function todayKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Convenience for other callers that need a local YYYY-MM-DD for a specific
// Date instance (e.g. deposit event dates, payment dates).
export function localDateKey(date) {
  const d = date instanceof Date ? date : new Date(date);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Simple HTML-escape helper for interpolating untrusted strings into template
// literals that end up in innerHTML. Public customer input can otherwise carry
// script payloads that execute in the owner's session.
export function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function normalizePhone(value) {
  return String(value || "").replace(/\D+/g, "");
}

// Best-effort conversion to E.164. Any input that already starts with '+' is
// passed through so international numbers just work. Bare local-format inputs
// fall back to Vietnam parsing (leading 0, 84 prefix, or 9-digit mobile).
export function normalizePhoneE164VN(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const cleanedPlus = raw.replace(/[^\d+]/g, "");
  if (/^\+\d{6,15}$/.test(cleanedPlus)) return cleanedPlus;
  const digits = raw.replace(/\D+/g, "");
  if (!digits) return null;
  if (digits.startsWith("84") && digits.length >= 11) return "+" + digits;
  if (digits.startsWith("0") && digits.length >= 10) return "+84" + digits.slice(1);
  if (digits.length === 9) return "+84" + digits;
  return null;
}

export function buildCustomerId(phone) {
  const normalized = normalizePhoneE164VN(phone) || normalizePhone(phone);
  if (!normalized) return "";
  return "CUS-" + normalized.replace(/\D+/g, "");
}

// Single canonical customer-id resolver used from every entry point (public
// form, admin approval, account signup, owner-added, owner-created order).
// Prefers a phone-based `CUS-<E164 digits>` — phone is the most stable
// identifier we have across anonymous, signed-in, and owner-facing surfaces —
// falling back to a uid-based `CUS-<uid>` only when the caller has no phone.
//
// Returns { id, source } where source is 'phone' | 'uid' | null. A null id
// means the caller has neither a phone nor a uid; no order should be written
// with a null customerId, so callers should treat that as a validation error.
export function resolveCustomerId({ uid, phone } = {}) {
  const phoneId = buildCustomerId(phone);
  if (phoneId) return { id: phoneId, source: "phone" };
  if (uid) return { id: `CUS-${uid}`, source: "uid" };
  return { id: null, source: null };
}

export function buildOrderId(prefix = "ORD") {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const random = Math.floor(Math.random() * 9000 + 1000);
  return `${prefix}-${stamp}-${random}`;
}

export function buildPaymentId() {
  return buildOrderId("PAY");
}

export function buildDepositEventId() {
  return buildOrderId("DEP");
}

// Real product photography pulled from danangwater.com. Matched by regex on
// the productName (case-insensitive) so Firestore product IDs stay flexible.
// First rule that matches wins; order matters — put more-specific patterns
// (e.g. "thach bich 19l jug") above their broader variants ("thach bich").
// Eventually replaced by a per-product imageUrl on the Firestore product doc —
// see ROADMAP "Visual redesign" follow-up.
const PRODUCT_IMAGE_MATCHERS = [
  { match: /danh\s*thanh/i,        url: "https://danangwatercom.swipepages.media/2025/3/5fafecac22647a001ca2c0c1/danhthanh-pwcz0f.png" },
  { match: /thach\s*bich.*(18|19|jug)/i, url: "https://danangwatercom.swipepages.media/2025/3/5fafecac22647a001ca2c0c1/thach-bich-19l-1-0hrekh.png" },
  { match: /thach\s*bich/i,        url: "https://danangwatercom.swipepages.media/2025/10/5fafecac22647a001ca2c0c1/thach-bich.png" },
  { match: /vikoda.*(19|20|jug)/i, url: "https://danangwatercom.swipepages.media/2025/9/5fafecac22647a001ca2c0c1/vikoda-20l-transparent-with-minerals-500.webp" },
  { match: /vikoda/i,              url: "https://danangwatercom.swipepages.media/2025/9/5fafecac22647a001ca2c0c1/vikoda-still-480ml-500.webp" },
  { match: /glassia/i,             url: "https://danangwatercom.swipepages.media/2025/9/5fafecac22647a001ca2c0c1/custom-dimensions-1000x1000-px--1--500.webp" },
  { match: /uni.*(sunrise|20)/i,   url: "https://danangwatercom.swipepages.media/2025/3/5fafecac22647a001ca2c0c1/uni-18-9.png" },
  { match: /shower.*filter/i,      url: "https://danangwatercom.swipepages.media/2025/2/5fafecac22647a001ca2c0c1/website-pic-no-qr.png" },
  { match: /coconut/i,             url: "https://danangwatercom.swipepages.media/2025/3/5fafecac22647a001ca2c0c1/beach-water-500.webp" },
  { match: /straw|test|recycle/i,  url: "https://danangwatercom.swipepages.media/2025/2/5fafecac22647a001ca2c0c1/rrr-water-recycle-500.webp" }
];

export function productImageUrl(productOrName) {
  const name = typeof productOrName === "string"
    ? productOrName
    : String(productOrName?.productName || "");
  if (!name) return "";
  for (const rule of PRODUCT_IMAGE_MATCHERS) {
    if (rule.match.test(name)) return rule.url;
  }
  return "";
}

// Standard delivery window slots. The stored value is human-readable text so
// invoices can print it directly; empty string means "any time / no preference".
// Callers use setDeliveryWindow(selectEl, value) to preserve legacy free-text
// values that don't match one of these options — the helper prepends the
// value as a temporary option so it survives an edit without disappearing.
export const DELIVERY_WINDOW_OPTIONS = [
  { value: "", label: "Any time" },
  { value: "Morning (08:00–12:00)", label: "Morning (08:00–12:00)" },
  { value: "Early afternoon (13:00–15:00)", label: "Early afternoon (13:00–15:00)" },
  { value: "Late afternoon (15:00–17:00)", label: "Late afternoon (15:00–17:00)" },
  { value: "Evening (17:00–19:00)", label: "Evening (17:00–19:00)" }
];

export function renderDeliveryWindowOptions(currentValue = "") {
  const knownValues = new Set(DELIVERY_WINDOW_OPTIONS.map((o) => o.value));
  const options = [...DELIVERY_WINDOW_OPTIONS];
  if (currentValue && !knownValues.has(currentValue)) {
    options.unshift({ value: currentValue, label: `${currentValue} (previous)` });
  }
  return options
    .map((opt) => `<option value="${escapeHtml(opt.value)}"${opt.value === currentValue ? " selected" : ""}>${escapeHtml(opt.label)}</option>`)
    .join("");
}

export function setDeliveryWindow(selectEl, value) {
  if (!selectEl) return;
  selectEl.innerHTML = renderDeliveryWindowOptions(value || "");
  selectEl.value = value || "";
}

// Configurable thresholds. Sensible defaults live here so pages work even
// when settings/business.thresholds isn't yet populated; the owner can
// override any subset from /settings.html. Every consumer should call
// `mergeThresholds(settings.thresholds)` at load and read from the result.
export const THRESHOLD_DEFAULTS = Object.freeze({
  // Days out to default the follow-up-by date when a delivery is marked
  // without collecting payment.
  followUpDays: 3,
  // Days since delivery after which an unpaid order shows a red "days since"
  // cell on /receivables.html.
  receivableOverdueDays: 7,
  // Days a container has been held before it turns yellow on /deposits.html.
  depositWarningDays: 30,
  // Days a container has been held before it turns red on /deposits.html
  // AND the account page nudges the customer to return it.
  depositForfeitDays: 60
});

// Fills in missing keys with defaults; passes numbers through, coerces
// strings to numbers, and rejects negatives (falls back to default).
export function mergeThresholds(raw) {
  const source = (raw && typeof raw === "object") ? raw : {};
  const out = {};
  for (const key of Object.keys(THRESHOLD_DEFAULTS)) {
    const candidate = Number(source[key]);
    out[key] = Number.isFinite(candidate) && candidate >= 0 ? candidate : THRESHOLD_DEFAULTS[key];
  }
  return out;
}

export function productCategoryKey(product) {
  const category = String(product.category || "").toLowerCase();
  const containerType = String(product.containerType || "").toLowerCase();
  const name = String(product.productName || "").toLowerCase();
  if (category.includes("glass") || containerType.includes("glass") || name.includes("glass")) {
    return "glass";
  }
  if (category.includes("jug") || containerType.includes("jug") || name.includes("jug") || name.includes("19l")) {
    return "jug";
  }
  return "addon";
}

// Group an order's items by returnable containerType and compute the deposit
// dollars-per-type. Products without a containerType (accessories) or with a
// zero deposit are excluded — those aren't refundable, so they never generate
// a deposit event.
//
// Args:
//   items: [{ productId, quantity, ... }]
//   productsById: { [productId]: { containerType, defaultDepositAmount } }
// Returns: [{ containerType, qty, amount }] — one entry per unique container
// type present in the order, empty array if no returnable items.
export function computeDepositBreakdown(items, productsById) {
  const byType = {};
  items.forEach((item) => {
    const product = productsById && productsById[item.productId];
    // Fall back to item-carried fields when the caller enriched the item
    // shape (owner-dialog flows do this). Everything else comes from the
    // canonical products doc.
    const containerType = (product && product.containerType) || item.containerType || null;
    const deposit = Number(
      (product ? product.defaultDepositAmount : item.defaultDepositAmount) || 0
    );
    if (!containerType || deposit <= 0) return;
    const qty = Number(item.quantity || 0);
    if (qty <= 0) return;
    if (!byType[containerType]) {
      byType[containerType] = { containerType, qty: 0, amount: 0 };
    }
    byType[containerType].qty += qty;
    byType[containerType].amount += qty * deposit;
  });
  return Object.values(byType);
}

export function computeOrderTotals(selectedProducts) {
  return selectedProducts.reduce((acc, line) => {
    const quantity = Number(line.quantity || 0);
    const unitPrice = Number(line.unitPrice || 0);
    const unitDeposit = Number(line.defaultDepositAmount || 0);
    acc.subtotal += quantity * unitPrice;
    acc.depositTotal += quantity * unitDeposit;
    return acc;
  }, { subtotal: 0, depositTotal: 0 });
}

// Three-branch payment status derived from the money on the order.
// Rules enforce: paymentStatus == 'paid' → balanceDue <= 0; == 'unpaid' →
// amountPaid == 0. So a partially-paid order (amountPaid > 0 AND balanceDue > 0)
// MUST report 'partial' or the write fails orderMathValid.
export function paymentStatusFor(amountPaid, balanceDue) {
  if (balanceDue <= 0) return "paid";
  if (Number(amountPaid || 0) > 0) return "partial";
  return "unpaid";
}

// Redirect signed-in users to /account.html when they don't have the role
// this page expects. Prevents a signed-in customer (or a driver on a page
// they don't own) from watching the owner shell load and then eating a
// cascade of permission-denied errors. Rules still enforce security; this
// helper only fixes the UX.
//
// Usage inside onAuthStateChanged after the !user branch:
//   if (!(await requireRole(user, "owner"))) return;
//
// Returns true when the user's custom claim matches the required role.
export async function requireRole(user, role) {
  if (!user) return false;
  try {
    const token = await user.getIdTokenResult();
    if (token.claims.role === role) return true;
  } catch (_) {
    // Fall through to redirect on token errors so the page never loads in a
    // half-broken state.
  }
  // If we're already on /account.html, don't loop; just fail silently.
  if (!/account\.html$/.test(window.location.pathname)) {
    window.location.href = "./account.html";
  }
  return false;
}

// Guard against double-submit under input lag: disables the button, swaps its
// label, and re-enables in a finally so an error keeps the form usable. Pass a
// form-submit event or a button element; a null button just runs the work.
export async function withSubmitLock(target, work, options = {}) {
  const button = resolveSubmitButton(target);
  if (!button) {
    return await work();
  }
  const busyLabel = options.busyLabel || "Saving...";
  const originalLabel = button.textContent;
  const wasDisabled = button.disabled;
  button.disabled = true;
  button.textContent = busyLabel;
  try {
    return await work();
  } finally {
    button.disabled = wasDisabled;
    button.textContent = originalLabel;
  }
}

function resolveSubmitButton(target) {
  if (!target) return null;
  if (target instanceof HTMLButtonElement) return target;
  if (target instanceof HTMLInputElement && target.type === "submit") return target;
  if (typeof Event !== "undefined" && target instanceof Event) {
    if (target.submitter) return target.submitter;
    const form = target.currentTarget || target.target;
    if (form && typeof form.querySelector === "function") {
      return form.querySelector('button[type="submit"], button:not([type]), input[type="submit"]');
    }
  }
  return null;
}

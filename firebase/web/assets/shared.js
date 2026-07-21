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

// Business timezone. The shop runs on Vietnam time regardless of where the
// customer's device thinks it is: a traveller ordering from Europe at 23:00
// their time is ordering on TOMORROW's date in Da Nang, and the server (which
// enforces the same rule) would otherwise reject their form's default as a
// past date. Use this for any date the BUSINESS owns; todayKey() stays
// device-local for owner-side screens where that is what's meant.
export const BUSINESS_TIME_ZONE = "Asia/Ho_Chi_Minh";

// Today's YYYY-MM-DD in a named IANA zone. Intl is the only correct way to do
// this — manual UTC+7 arithmetic silently breaks if Vietnam ever adopts DST,
// and getting it wrong here rejects real orders placed near midnight.
export function todayKeyInZone(timeZone = BUSINESS_TIME_ZONE, now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);
  const get = (type) => (parts.find((p) => p.type === type) || {}).value || "";
  return `${get("year")}-${get("month")}-${get("day")}`;
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

// Kept in one shared list so checkout and My Account offer the same searchable
// country choices. Common Da Nang customer origins come first; the input stays
// compact because browsers only reveal the full list while the customer types.
export const PHONE_COUNTRIES = Object.freeze([
  ["+84", "🇻🇳", "Vietnam"], ["+1", "🇺🇸", "United States"], ["+1", "🇨🇦", "Canada"],
  ["+44", "🇬🇧", "United Kingdom"], ["+61", "🇦🇺", "Australia"], ["+64", "🇳🇿", "New Zealand"],
  ["+33", "🇫🇷", "France"], ["+49", "🇩🇪", "Germany"], ["+81", "🇯🇵", "Japan"],
  ["+82", "🇰🇷", "South Korea"], ["+65", "🇸🇬", "Singapore"], ["+66", "🇹🇭", "Thailand"],
  ["+91", "🇮🇳", "India"], ["+7", "🇷🇺", "Russia"], ["+86", "🇨🇳", "China"],
  ["+852", "🇭🇰", "Hong Kong"], ["+853", "🇲🇴", "Macau"], ["+886", "🇹🇼", "Taiwan"],
  ["+62", "🇮🇩", "Indonesia"], ["+60", "🇲🇾", "Malaysia"], ["+63", "🇵🇭", "Philippines"],
  ["+855", "🇰🇭", "Cambodia"], ["+856", "🇱🇦", "Laos"], ["+95", "🇲🇲", "Myanmar"],
  ["+880", "🇧🇩", "Bangladesh"], ["+92", "🇵🇰", "Pakistan"], ["+94", "🇱🇰", "Sri Lanka"],
  ["+977", "🇳🇵", "Nepal"], ["+975", "🇧🇹", "Bhutan"], ["+960", "🇲🇻", "Maldives"],
  ["+31", "🇳🇱", "Netherlands"], ["+32", "🇧🇪", "Belgium"], ["+34", "🇪🇸", "Spain"],
  ["+39", "🇮🇹", "Italy"], ["+41", "🇨🇭", "Switzerland"], ["+43", "🇦🇹", "Austria"],
  ["+353", "🇮🇪", "Ireland"], ["+351", "🇵🇹", "Portugal"], ["+30", "🇬🇷", "Greece"],
  ["+45", "🇩🇰", "Denmark"], ["+46", "🇸🇪", "Sweden"], ["+47", "🇳🇴", "Norway"],
  ["+358", "🇫🇮", "Finland"], ["+354", "🇮🇸", "Iceland"], ["+48", "🇵🇱", "Poland"],
  ["+420", "🇨🇿", "Czechia"], ["+421", "🇸🇰", "Slovakia"], ["+36", "🇭🇺", "Hungary"],
  ["+40", "🇷🇴", "Romania"], ["+359", "🇧🇬", "Bulgaria"], ["+385", "🇭🇷", "Croatia"],
  ["+386", "🇸🇮", "Slovenia"], ["+381", "🇷🇸", "Serbia"], ["+382", "🇲🇪", "Montenegro"],
  ["+387", "🇧🇦", "Bosnia and Herzegovina"], ["+389", "🇲🇰", "North Macedonia"],
  ["+355", "🇦🇱", "Albania"], ["+383", "🇽🇰", "Kosovo"], ["+373", "🇲🇩", "Moldova"],
  ["+380", "🇺🇦", "Ukraine"], ["+375", "🇧🇾", "Belarus"], ["+370", "🇱🇹", "Lithuania"],
  ["+371", "🇱🇻", "Latvia"], ["+372", "🇪🇪", "Estonia"], ["+352", "🇱🇺", "Luxembourg"],
  ["+356", "🇲🇹", "Malta"], ["+357", "🇨🇾", "Cyprus"], ["+377", "🇲🇨", "Monaco"],
  ["+376", "🇦🇩", "Andorra"], ["+423", "🇱🇮", "Liechtenstein"], ["+378", "🇸🇲", "San Marino"],
  ["+90", "🇹🇷", "Türkiye"], ["+971", "🇦🇪", "United Arab Emirates"], ["+966", "🇸🇦", "Saudi Arabia"],
  ["+974", "🇶🇦", "Qatar"], ["+973", "🇧🇭", "Bahrain"], ["+965", "🇰🇼", "Kuwait"],
  ["+968", "🇴🇲", "Oman"], ["+972", "🇮🇱", "Israel"], ["+962", "🇯🇴", "Jordan"],
  ["+961", "🇱🇧", "Lebanon"], ["+98", "🇮🇷", "Iran"], ["+964", "🇮🇶", "Iraq"],
  ["+995", "🇬🇪", "Georgia"], ["+374", "🇦🇲", "Armenia"], ["+994", "🇦🇿", "Azerbaijan"],
  ["+7", "🇰🇿", "Kazakhstan"], ["+998", "🇺🇿", "Uzbekistan"], ["+996", "🇰🇬", "Kyrgyzstan"],
  ["+976", "🇲🇳", "Mongolia"], ["+27", "🇿🇦", "South Africa"], ["+20", "🇪🇬", "Egypt"],
  ["+212", "🇲🇦", "Morocco"], ["+213", "🇩🇿", "Algeria"], ["+216", "🇹🇳", "Tunisia"],
  ["+234", "🇳🇬", "Nigeria"], ["+254", "🇰🇪", "Kenya"], ["+233", "🇬🇭", "Ghana"],
  ["+251", "🇪🇹", "Ethiopia"], ["+255", "🇹🇿", "Tanzania"], ["+256", "🇺🇬", "Uganda"],
  ["+250", "🇷🇼", "Rwanda"], ["+230", "🇲🇺", "Mauritius"], ["+248", "🇸🇨", "Seychelles"],
  ["+52", "🇲🇽", "Mexico"], ["+55", "🇧🇷", "Brazil"], ["+54", "🇦🇷", "Argentina"],
  ["+56", "🇨🇱", "Chile"], ["+57", "🇨🇴", "Colombia"], ["+51", "🇵🇪", "Peru"],
  ["+58", "🇻🇪", "Venezuela"], ["+593", "🇪🇨", "Ecuador"], ["+591", "🇧🇴", "Bolivia"],
  ["+595", "🇵🇾", "Paraguay"], ["+598", "🇺🇾", "Uruguay"], ["+506", "🇨🇷", "Costa Rica"],
  ["+507", "🇵🇦", "Panama"], ["+502", "🇬🇹", "Guatemala"], ["+503", "🇸🇻", "El Salvador"],
  ["+504", "🇭🇳", "Honduras"], ["+505", "🇳🇮", "Nicaragua"], ["+53", "🇨🇺", "Cuba"],
  ["+1", "🇯🇲", "Jamaica"], ["+1", "🇩🇴", "Dominican Republic"], ["+1", "🇵🇷", "Puerto Rico"],
  ["+679", "🇫🇯", "Fiji"], ["+675", "🇵🇬", "Papua New Guinea"], ["+685", "🇼🇸", "Samoa"],
  ["+676", "🇹🇴", "Tonga"], ["+678", "🇻🇺", "Vanuatu"], ["+687", "🇳🇨", "New Caledonia"],
  ["+689", "🇵🇫", "French Polynesia"]
].map(([dialCode, flag, name]) => Object.freeze({ dialCode, flag, name })));

export function populatePhoneCountryDatalist(listElement) {
  if (!listElement || listElement.childElementCount) return;
  for (const country of PHONE_COUNTRIES) {
    const option = document.createElement("option");
    option.value = `${country.flag} ${country.dialCode}`;
    option.label = country.name;
    listElement.append(option);
  }
}

export function phoneCountryDisplayValue(dialCode, currentValue = "") {
  const code = String(dialCode || "").match(/\+\d{1,3}/)?.[0] || "+84";
  if (String(currentValue).includes(code) && /\p{Regional_Indicator}/u.test(String(currentValue))) {
    return String(currentValue);
  }
  const country = PHONE_COUNTRIES.find((entry) => entry.dialCode === code) || PHONE_COUNTRIES[0];
  return `${country.flag} ${code}`;
}

export function phoneCountryCodeForNumber(value, selectedCode = "+84") {
  const phone = String(value || "").replace(/[^\d+]/g, "");
  const selected = String(selectedCode || "").match(/\+\d{1,3}/)?.[0];
  if (selected && phone.startsWith(selected)) return selected;
  const codes = [...new Set(PHONE_COUNTRIES.map((country) => country.dialCode))]
    .sort((left, right) => right.length - left.length);
  return codes.find((code) => phone.startsWith(code)) || selected || "+84";
}

// Keep the country code in its own control. Stored E.164 numbers are split
// when loaded so the adjacent phone field contains only the national number.
export function splitPhoneWithCountry(value, selectedCode = "+84") {
  const raw = String(value || "").trim();
  const selected = String(selectedCode || "").match(/\+\d{1,3}/)?.[0] || "+84";
  if (!raw.startsWith("+")) return { dialCode: selected, nationalNumber: raw };
  const cleaned = raw.replace(/[^\d+]/g, "");
  const dialCode = phoneCountryCodeForNumber(cleaned, selected);
  return {
    dialCode,
    nationalNumber: cleaned.startsWith(dialCode) ? cleaned.slice(dialCode.length) : cleaned.replace(/^\+/, "")
  };
}

export function setupPhoneCountryPicker(rootElement) {
  if (!rootElement) return null;
  if (rootElement._phoneCountryPicker) return rootElement._phoneCountryPicker;
  const valueInput = rootElement.querySelector("[data-phone-country-value]");
  const trigger = rootElement.querySelector(".phone-country-trigger");
  const display = rootElement.querySelector("[data-phone-country-display]");
  const menu = rootElement.querySelector(".phone-country-menu");
  const search = rootElement.querySelector(".phone-country-search");
  const options = rootElement.querySelector(".phone-country-options");
  if (!valueInput || !trigger || !display || !menu || !search || !options) return null;

  let selectedCountry = PHONE_COUNTRIES.find((country) => country.dialCode === valueInput.value) || PHONE_COUNTRIES[0];
  const close = () => {
    menu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
  };
  const render = () => {
    const query = search.value.trim().toLowerCase();
    options.replaceChildren();
    const matches = PHONE_COUNTRIES.filter((country) =>
      !query || country.name.toLowerCase().includes(query) || country.dialCode.includes(query)
    );
    for (const country of matches) {
      const option = document.createElement("button");
      option.type = "button";
      option.className = "phone-country-option";
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", String(country === selectedCountry));
      for (const [className, text] of [
        ["phone-country-flag", country.flag],
        ["phone-country-name", country.name],
        ["phone-country-code", country.dialCode]
      ]) {
        const part = document.createElement("span");
        part.className = className;
        part.textContent = text;
        option.append(part);
      }
      option.addEventListener("click", () => {
        api.setValue(country.dialCode, country);
        valueInput.dispatchEvent(new Event("change", { bubbles: true }));
        close();
        trigger.focus();
      });
      options.append(option);
    }
    if (!matches.length) {
      const empty = document.createElement("span");
      empty.className = "phone-country-empty";
      empty.textContent = "No matching country";
      options.append(empty);
    }
  };
  const api = {
    setValue(dialCode, country = null) {
      const code = String(dialCode || "").match(/\+\d{1,3}/)?.[0] || "+84";
      selectedCountry = country
        || (selectedCountry?.dialCode === code ? selectedCountry : null)
        || PHONE_COUNTRIES.find((entry) => entry.dialCode === code)
        || PHONE_COUNTRIES[0];
      valueInput.value = code;
      display.textContent = `${selectedCountry.flag} ${code}`;
      render();
    },
    close
  };
  rootElement._phoneCountryPicker = api;
  trigger.addEventListener("click", () => {
    const opening = menu.hidden;
    if (!opening) return close();
    menu.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    search.value = "";
    render();
    search.focus();
  });
  search.addEventListener("input", render);
  rootElement.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      close();
      trigger.focus();
    }
  });
  document.addEventListener("pointerdown", (event) => {
    if (!rootElement.contains(event.target)) close();
  });
  api.setValue(valueInput.value);
  return api;
}

// Phone forms show a small, familiar country picker rather than requiring a
// customer to understand why a bare local number is rejected. A number that
// already carries '+' always wins; the picker only supplies the missing code.
export function normalizePhoneWithCountry(value, countryCode = "+84") {
  const raw = String(value || "").trim();
  if (!raw) return null;
  if (raw.startsWith("+")) return normalizePhoneE164VN(raw);
  const code = String(countryCode || "+84").match(/\+\d{1,3}/)?.[0] || "";
  if (!/^\+\d{1,3}$/.test(code)) return null;
  if (code === "+84") return normalizePhoneE164VN(raw);
  const digits = raw.replace(/\D+/g, "").replace(/^00/, "").replace(/^0/, "");
  return digits.length >= 5 && digits.length <= 15 ? `${code}${digits}` : null;
}

export function phoneEntryErrorMessage(value) {
  const raw = String(value || "").trim();
  if (/[A-Za-z]/.test(raw)) {
    return "Phone number must use digits, not letters. Spaces, +, brackets and dashes are okay.";
  }
  return "Enter a valid phone number. Choose the country code, then enter at least 5 digits.";
}

export function buildCustomerId(phone) {
  const normalized = normalizePhoneE164VN(phone) || normalizePhone(phone);
  if (!normalized) return "";
  return "CUS-" + normalized.replace(/\D+/g, "");
}

// Group customer docs that look like the same person — 2+ records sharing a
// canonical phone or an email. Used by BOTH the Find-duplicates tool (to list
// and merge) and the Customers-page nudge (to count), so the badge count can
// never disagree with what the tool shows. Merging is always owner-initiated;
// this only surfaces candidates, it never links anything automatically.
export function buildDuplicateGroups(customers) {
  const emailKey = (value) => {
    const raw = String(value || "").trim().toLowerCase();
    return raw.includes("@") ? raw : null;
  };
  const byPhone = new Map();
  const byEmail = new Map();
  for (const customer of customers) {
    const phone = normalizePhoneE164VN(customer.phone);
    if (phone) {
      if (!byPhone.has(phone)) byPhone.set(phone, []);
      byPhone.get(phone).push(customer);
    }
    const email = emailKey(customer.email);
    if (email) {
      if (!byEmail.has(email)) byEmail.set(email, []);
      byEmail.get(email).push(customer);
    }
  }

  const groups = [];
  const seenMemberSets = new Set();
  const memberKey = (docs) => docs.map((d) => d.id).sort().join("|");

  for (const [phone, docs] of byPhone) {
    if (docs.length < 2) continue;
    groups.push({ kind: "phone", key: phone, docs });
    seenMemberSets.add(memberKey(docs));
  }
  // Email groups that are not just a phone group seen again.
  for (const [email, docs] of byEmail) {
    if (docs.length < 2) continue;
    if (seenMemberSets.has(memberKey(docs))) continue;
    groups.push({ kind: "email", key: email, docs });
  }

  // Biggest groups first; phone groups ahead of email at equal size.
  groups.sort((a, b) => b.docs.length - a.docs.length
    || (a.kind === b.kind ? 0 : a.kind === "phone" ? -1 : 1));
  return groups;
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
  // A per-product imageUrl (set in the /catalog.html builder) always wins;
  // the name-matcher below is the legacy fallback for docs without one.
  if (typeof productOrName === "object" && productOrName?.imageUrl) {
    return String(productOrName.imageUrl);
  }
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

// A container balance is broken when netting the ledger leaves the customer
// holding less than nothing — more containers returned, refunded or written off
// than were ever charged to them. That is never a real-world state, so it always
// means a bad write upstream.
//
// Screens must surface it instead of filtering it out. A hidden negative
// silently absorbs the customer's next genuine deposit (charge 2, hole is -2,
// net reads 0), so cash you actually collected stops showing as owed back and
// the customer has no record to point at when they return the containers.
//
// qty and amount are tested separately on purpose: a write-off priced at a zero
// deposit moves the count without the money, so the two drift apart
// independently and either one alone is enough to prove the ledger is wrong.
export function isBrokenDepositBalance(qty, amount) {
  return Number(qty || 0) < 0 || Number(amount || 0) <= -1;
}

export function describeDepositBalanceProblem(qty, amount) {
  const parts = [];
  const netQty = Number(qty || 0);
  const netAmount = Number(amount || 0);
  if (netQty < 0) parts.push(`${Math.abs(netQty)} more returned than were ever charged`);
  if (netAmount <= -1) parts.push(`${formatCurrency(Math.abs(netAmount))} refunded beyond what was collected`);
  return parts.join(" · ");
}

// Proof that containers actually came back.
//
// A photo on its own is weak evidence — nothing stops someone photographing an
// empty floor, a previous trip's crates, or the back of a van — so requiring a
// photo and nothing else buys false confidence. The rule is therefore "a photo
// OR a written account", with the note treated as a genuine alternative rather
// than a lesser fallback: a specific sentence about what was collected and from
// whom, saved against the delivery under the name of whoever closed it, is
// harder to produce carelessly than a blank photo and far easier to challenge
// later. Either way the point is the same — no deposit credit without someone
// putting their name to an account of what physically changed hands.
//
// Both delivery dialogs call this, so the bar cannot drift between the owner's
// order page and the dashboard.
export const RETURN_NOTE_MIN_LENGTH = 15;

export function containerReturnProofProblem({ hasPhoto = false, note = "" } = {}) {
  if (hasPhoto) return null;
  const trimmed = String(note || "").trim();
  if (!trimmed) {
    return "Add a photo of the returned containers — or, if you can't, write what you collected.";
  }
  if (trimmed.length < RETURN_NOTE_MIN_LENGTH) {
    return `Say what was actually collected, and from whom — at least ${RETURN_NOTE_MIN_LENGTH} characters.`;
  }
  return null;
}

// "photo" | "note" | "photo_note" | null. Stored alongside the return events and
// the deposit_credit payment so "which returns were closed without a photo?" is
// one query, rather than inferring it from a null document id — which would also
// match a return recorded before any of this existed.
export function containerReturnProofType({ hasPhoto = false, note = "" } = {}) {
  const hasNote = String(note || "").trim().length > 0;
  if (hasPhoto && hasNote) return "photo_note";
  if (hasPhoto) return "photo";
  if (hasNote) return "note";
  return null;
}

// What a customer is still holding, per container type, from their deposit
// ledger. `charged` adds containers and money; `credited`, `refunded` and
// `forfeited` all take both back — a written-off container is no longer held
// any more than a returned one is.
//
// This is deliberately the SAME arithmetic as the owner's
// loadHeldContainersForCustomer (adminApp/orderApp), because the customer and
// the owner disagreeing about how many crates are on the doorstep is the whole
// problem. The customer surfaces used to run their own version keyed off
// /returns docs — but nothing in this app has ever WRITTEN a /returns doc, so
// a container returned at delivery stayed on the customer's record forever and
// forfeited ones were ignored outright. Do not reintroduce a /returns term
// here without first making something write them.
//
// Negative nets are NOT filtered out: below zero means the ledger is broken,
// and hiding it is exactly what let a hole masquerade as a settled customer.
// Callers decide how to present it — see isBrokenDepositBalance.
export function summarizeHeldContainers(depositEvents = []) {
  const byType = {};
  const bump = (rawType, deltaQty, deltaAmount, chargedDate) => {
    const type = String(rawType || "other");
    if (!byType[type]) {
      byType[type] = { type, qty: 0, deposit: 0, oldestChargedDate: null, chargedQty: 0, chargedAmount: 0 };
    }
    byType[type].qty += deltaQty;
    byType[type].deposit += deltaAmount;
    if (chargedDate && (!byType[type].oldestChargedDate || chargedDate < byType[type].oldestChargedDate)) {
      byType[type].oldestChargedDate = chargedDate;
    }
  };
  depositEvents.forEach((event) => {
    const qty = Number(event.qty || 0);
    const amount = Number(event.amount || 0);
    if (event.eventType === "charged") {
      bump(event.containerType, qty, amount, event.eventDate || null);
      const row = byType[String(event.containerType || "other")];
      row.chargedQty += qty;
      row.chargedAmount += amount;
    } else if (event.eventType === "credited" || event.eventType === "refunded" || event.eventType === "forfeited") {
      bump(event.containerType, -qty, -amount, null);
    }
  });
  // A type that nets to a clean zero is settled and uninteresting. Sub-1 money
  // residue is rounding, not a balance.
  return Object.values(byType)
    .map((row) => ({
      ...row,
      depositPerUnit: row.chargedQty > 0 ? row.chargedAmount / row.chargedQty : 0
    }))
    .filter((row) => row.qty !== 0 || Math.abs(row.deposit) >= 1);
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

// --- Customer account truth (P0-05) ----------------------------------------
//
// The account balance and open-order list must be computed over the customer's
// WHOLE order set, not just the newest page — an older unpaid order beyond the
// pagination window would otherwise silently drop out of the balance, and a
// negative balanceDue (the customer is in credit after an overpayment or
// refund) was ignored entirely. Both of these are pure so they can be tested
// without a browser: pass the full array of the customer's order docs.
//
// Statuses excluded from debt: `cancelled` (no longer owed) and
// `pending_approval` (not a confirmed order yet). Credit is counted on any
// non-cancelled order, because an overpayment is real money the business holds
// regardless of the order's stage.
export function summarizeAccountBalance(orders = []) {
  let debt = 0;
  let credit = 0;
  let outstandingCount = 0;
  let oldestOutstandingDate = null;
  for (const order of orders) {
    const status = order && order.status;
    if (status === "cancelled") continue;
    const balance = Number((order && order.balanceDue) || 0);
    if (balance > 0 && status !== "pending_approval") {
      debt += balance;
      outstandingCount += 1;
      const date = order.deliveryDate || null;
      if (date && (!oldestOutstandingDate || date < oldestOutstandingDate)) {
        oldestOutstandingDate = date;
      }
    } else if (balance < 0) {
      credit += -balance;
    }
  }
  // net > 0 → the customer owes; net < 0 → the business owes them; 0 → settled.
  return { debt, credit, net: debt - credit, outstandingCount, oldestOutstandingDate };
}

// Open orders = anything still in flight (not delivered, not cancelled),
// computed over the full order set so an old open order can't hide behind
// newer history.
export function openOrdersFrom(orders = []) {
  return (orders || []).filter((o) => o && o.status !== "delivered" && o.status !== "cancelled");
}

// Physical container returns derived from the real depositEvents model. A
// returned container is booked as a `credited` (deposit applied to the order)
// or `refunded` (deposit paid back in cash) event; `forfeited` means the
// container was NOT returned (lost/damaged), so it is deliberately excluded.
// Replaces the dead `/returns` collection, which nothing has ever written.
export function physicalReturnsFromDepositEvents(events = []) {
  return (events || [])
    .filter((e) => e && (e.eventType === "credited" || e.eventType === "refunded"))
    .map((e) => ({
      qty: Number(e.qty || 0),
      containerType: e.containerType || "other",
      amount: Number(e.amount || 0),
      handling: e.eventType === "refunded" ? "refund" : "credit",
      date: e.eventDate || e.createdAt || null
    }));
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

// --- Delivery date + service area (P0-03) ----------------------------------
//
// The public order callable enforces both of these server-side. These are the
// CANONICAL definitions; `functions/index.js` mirrors them (it is CommonJS and
// cannot import this module) behind a keep-in-sync comment. If you widen the
// area or change the date rule, change both or the server will reject orders
// the form happily accepted.
//
// KNOWN DUPLICATION, not introduced here: the same rectangle is hardcoded in
// accountApp.js, editOrderAddress.js, adminApp.js, orderApp.js, customersApp.js
// and customerApp.js. Those are map-bias/marker call sites in another agent's
// files; see ROADMAP → "Service area is defined in eight places".

export const DA_NANG_DELIVERY_BOUNDS = Object.freeze({
  west: 108.05,
  south: 15.90,
  east: 108.35,
  north: 16.20
});

// Accepts a plain {lat, lng} or a google.maps.LatLng (whose lat/lng are
// functions), so map callbacks and stored pins can share one check.
export function isInsideDeliveryArea(position) {
  const latValue = typeof position?.lat === "function" ? position.lat() : position?.lat;
  const lngValue = typeof position?.lng === "function" ? position.lng() : position?.lng;
  const lat = Number(latValue);
  const lng = Number(lngValue);
  return Number.isFinite(lat) && Number.isFinite(lng)
    && lat >= DA_NANG_DELIVERY_BOUNDS.south
    && lat <= DA_NANG_DELIVERY_BOUNDS.north
    && lng >= DA_NANG_DELIVERY_BOUNDS.west
    && lng <= DA_NANG_DELIVERY_BOUNDS.east;
}

// Same-day ordering is currently allowed with no cutoff hour. Whether a
// same-day order placed at (say) 20:00 should be pushed to tomorrow is a
// BUSINESS decision that is still open with Ty — see SHIP-READINESS P0-03.
// Leaving this null means "no cutoff"; setting it to an hour 0-23 activates
// the rule on both client and server. Do not invent a value here: a wrong
// cutoff silently refuses real money.
export const SAME_DAY_CUTOFF_HOUR = null;

// Returns null when the requested delivery date is acceptable, else a
// customer-facing reason. `today` is the business-zone date key.
export function deliveryDateProblem(dateKey, today) {
  const value = String(dateKey || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return "Delivery date must be YYYY-MM-DD.";
  }
  // The regex accepts impossible dates (2026-02-31, 2026-13-01). Round-trip
  // through UTC and require the parts to survive, rather than letting Date
  // roll 02-31 forward into March behind the customer's back.
  const [y, m, d] = value.split("-").map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    return "That delivery date does not exist. Please pick a date from the calendar.";
  }
  // String compare is safe and timezone-free for zero-padded ISO dates.
  if (value < today) {
    return `That delivery date has passed. Please choose ${today} or later.`;
  }
  return null;
}

// --- Idempotent order submission (P0-02) -----------------------------------
//
// Every submitPublicOrder attempt used to mint a fresh order id server-side,
// so a commit whose response was lost (timeout, dropped connection, closed
// tab) turned the customer's Retry into a second real order. The client now
// sends a submission key; the server maps {uid, key} → order transactionally
// and returns the already-created order for a repeat key instead of writing
// a new one.
//
// The key must survive retry AND reload (localStorage), but a *deliberately
// new* order must not reuse it — otherwise the new order would be swallowed
// by the mapping and the customer would silently get nothing. The client
// cannot ask the customer which case this is, so the rotation rule is:
// reuse the stored key only while the order's material fields fingerprint
// the same and the key is younger than SUBMISSION_KEY_MAX_AGE_MS; anything
// else gets a fresh key. A retry of the same order (same cart, same address,
// same date) fingerprints identically even when the cart was rebuilt after
// a reload; editing anything that changes what would be delivered rotates
// the key, which is Stripe's idempotency-key semantic: different request,
// different key.

export const SUBMISSION_KEY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const SUBMISSION_KEY_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

// Stable string of the fields that make two submissions "the same order".
// Item order is normalized so a cart rebuilt in a different sequence after a
// reload still matches. Coordinates are rounded to ~1m so a re-confirmed pin
// on the same spot does not rotate the key.
export function submissionFingerprint(payload) {
  const items = (Array.isArray(payload?.items) ? payload.items : [])
    .map((it) => `${String(it?.productId || "")}x${Math.floor(Number(it?.quantity || 0))}`)
    .sort()
    .join(",");
  const c = payload?.customer || {};
  const loc = c.deliveryLocation
    ? `${Number(c.deliveryLocation.lat).toFixed(5)},${Number(c.deliveryLocation.lng).toFixed(5)}`
    : "";
  return [
    items,
    String(c.phone || "").trim(),
    String(c.address || "").trim(),
    String(c.deliveryDate || "").trim(),
    String(c.deliveryWindow || "").trim(),
    String(c.notes || "").trim(),
    loc
  ].join("|");
}

export function randomSubmissionKey() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return "sk" + Date.now().toString(36) + Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 12);
}

// stored is {key, fingerprint, at} (or null/garbage — localStorage survives
// old app versions, so validate everything). Returns {key, reused}.
export function resolveSubmissionKey(stored, fingerprint, nowMs = Date.now()) {
  const reusable = stored
    && typeof stored.key === "string"
    && SUBMISSION_KEY_PATTERN.test(stored.key)
    && stored.fingerprint === fingerprint
    && Number.isFinite(Number(stored.at))
    && nowMs - Number(stored.at) >= 0
    && nowMs - Number(stored.at) < SUBMISSION_KEY_MAX_AGE_MS;
  if (reusable) return { key: stored.key, reused: true };
  return { key: randomSubmissionKey(), reused: false };
}

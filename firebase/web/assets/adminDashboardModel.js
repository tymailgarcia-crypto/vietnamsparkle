export const OPEN_ORDER_STATUSES = Object.freeze([
  "pending_approval",
  "new",
  "assigned",
  "out_for_delivery"
]);

export const OPEN_ORDER_GROUPS = Object.freeze([
  { key: "needs_date", label: "Needs a date" },
  { key: "overdue", label: "Overdue" },
  { key: "today", label: "Today" },
  { key: "upcoming", label: "Upcoming" }
]);

export const OPEN_ORDER_TIMING_FILTERS = Object.freeze([
  { key: "all", label: "All delivery dates" },
  ...OPEN_ORDER_GROUPS.map(({ key, label }) => ({ key, label }))
]);

const OPEN_STATUS_SET = new Set(OPEN_ORDER_STATUSES);

export function isOpenOrder(order) {
  return OPEN_STATUS_SET.has(String(order?.status || ""));
}

export function normalizeImportantNote(value) {
  return String(value == null ? "" : value).trim();
}

export function importantNoteIsValid(value) {
  const note = normalizeImportantNote(value);
  return note.length > 0 && note.length <= 300;
}

export function openOrderGroupKey(order, today) {
  const deliveryDate = String(order?.deliveryDate || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(deliveryDate)) return "needs_date";
  if (deliveryDate < today) return "overdue";
  if (deliveryDate === today) return "today";
  return "upcoming";
}

function createdMillis(order) {
  const value = order?.createdAt;
  if (value && typeof value.toMillis === "function") return value.toMillis();
  if (value && typeof value.toDate === "function") return value.toDate().getTime();
  const parsed = new Date(value || 0).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

export function compareOpenOrders(a, b) {
  const importance = Number(b?.important === true) - Number(a?.important === true);
  if (importance) return importance;

  const dateA = String(a?.deliveryDate || "9999-99-99");
  const dateB = String(b?.deliveryDate || "9999-99-99");
  const dateOrder = dateA.localeCompare(dateB);
  if (dateOrder) return dateOrder;

  return createdMillis(a) - createdMillis(b)
    || String(a?.id || "").localeCompare(String(b?.id || ""));
}

export function groupOpenOrders(orders, today) {
  const grouped = Object.fromEntries(OPEN_ORDER_GROUPS.map(({ key }) => [key, []]));
  (orders || []).filter(isOpenOrder).forEach((order) => {
    grouped[openOrderGroupKey(order, today)].push(order);
  });
  OPEN_ORDER_GROUPS.forEach(({ key }) => grouped[key].sort(compareOpenOrders));
  return grouped;
}

export function filterOpenOrdersByTiming(orders, today, timing = "all") {
  const selectedTiming = OPEN_ORDER_TIMING_FILTERS.some(({ key }) => key === timing)
    ? timing
    : "all";
  return (orders || [])
    .filter(isOpenOrder)
    .filter((order) => selectedTiming === "all" || openOrderGroupKey(order, today) === selectedTiming)
    .sort(compareOpenOrders);
}

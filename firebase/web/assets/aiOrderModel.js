export function fold(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/gi, "d").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
function similarity(a, b) {
  a = fold(a); b = fold(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]; row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const before = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = before;
    }
  }
  const edit = 1 - row[b.length] / Math.max(a.length, b.length);
  const aa = new Set(a.split(" ")), bb = new Set(b.split(" "));
  const overlap = [...aa].filter(word => bb.has(word)).length / Math.max(aa.size, bb.size);
  return Math.max(edit, overlap);
}
export function customerMatches(draft, customers, normalizePhone) {
  const number = normalizePhone(draft.phone);
  return customers.filter(c => c.archived !== true).map(customer => {
    const exact = !!number && [customer.phone, customer.secondaryPhone].some(p => normalizePhone(p) === number);
    const nameScore = similarity(draft.name, customer.name);
    const addresses = [customer.address, ...(Array.isArray(customer.additionalAddresses) ? customer.additionalAddresses : []), ...(Array.isArray(customer.addressLocations) ? customer.addressLocations : []).map(a => a?.address)].filter(a => typeof a === "string");
    const addressScore = Math.max(0, ...addresses.map(a => similarity(draft.address, a)));
    return { customer, exact, score: exact ? 2 : Math.max(nameScore >= 0.65 ? nameScore : 0, addressScore >= 0.72 ? addressScore : 0), reason: exact ? "Same phone" : nameScore >= addressScore ? "Similar name" : "Similar address" };
  }).filter(m => m.score > 0).sort((a, b) => b.score - a.score);
}
export function orderTotals(items, products) {
  return items.reduce((totals, item) => {
    const p = products.find(p => p.id === item.productId);
    const qty = Number(item.quantity);
    if (p && Number.isInteger(qty) && qty > 0) {
      totals.subtotal += qty * Number(p.unitPrice || 0);
      totals.depositTotal += qty * Number(p.defaultDepositAmount || 0);
    }
    return totals;
  }, { subtotal: 0, depositTotal: 0 });
}

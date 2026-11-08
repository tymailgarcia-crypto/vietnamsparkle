import assert from "node:assert/strict";
import { customerMatches, fold, orderTotals } from "./aiOrderModel.js";
const normalize = value => {
  let digits = String(value || "").replace(/\D/g, "");
  if (digits.startsWith("0")) digits = `84${digits.slice(1)}`;
  if (digits.length === 9) digits = `84${digits}`;
  return digits || null;
};
const customers = [
  { id: "v", name: "Varvara", phone: "+84329708584", address: "54 Lê Thước" },
  { id: "other", name: "Someone Else", phone: "+84988888888", address: "10 Tran Phu" },
  { id: "archived", name: "Varvara", phone: "+84329708584", archived: true }
];
assert.equal(fold("LÊ THƯỚC Đà Nẵng"), "le thuoc da nang");
assert.equal(customerMatches({ phone: "0329708584" }, customers, normalize)[0].customer.id, "v");
assert.equal(customerMatches({ phone: "84 329 708 584" }, customers, normalize)[0].exact, true);
assert.equal(customerMatches({ name: "Varvra" }, customers, normalize)[0].customer.id, "v");
assert.equal(customerMatches({ address: "54 Le Thuoc" }, customers, normalize)[0].customer.id, "v");
assert.equal(customerMatches({ name: "Unrelated", address: "99 Random Avenue" }, customers, normalize).length, 0);
assert.equal(customerMatches({ phone: "+84329708584" }, customers, normalize).length, 1);
assert.equal(customerMatches({ phone: "0988888888" }, [{ id: "s", secondaryPhone: "+84988888888" }], normalize)[0].exact, true);
assert.equal(customerMatches({ phone: "0329708584" }, [...customers, { id: "shared", phone: "+84329708584" }], normalize).filter(m => m.exact).length, 2);
assert.deepEqual(orderTotals([{ productId: "p", quantity: 3 }], [{ id: "p", unitPrice: 20000, defaultDepositAmount: 50000 }]), { subtotal: 60000, depositTotal: 150000 });
assert.deepEqual(orderTotals([{ productId: "missing", quantity: 9 }], []), { subtotal: 0, depositTotal: 0 });
console.log("AI order model: 11 checks passed");

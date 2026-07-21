// P0-05 — customer account truth: open orders, balance (debt AND credit), and
// container returns derived from the real model. Pure, no emulator, no DOM. Run:
//   cd firebase
//   node web/assets/accountTruth.test.mjs
//
// What these pin:
//  - The balance is computed over the WHOLE order set, so an old unpaid order
//    beyond the pagination window can't vanish from what the customer owes.
//  - Customer credit (a negative balanceDue after overpayment/refund) is
//    counted and labelled, not dropped.
//  - Physical returns come from depositEvents (credited/refunded), never the
//    dead `/returns` collection; forfeited (lost) is not a return.

import assert from "node:assert";
import {
  openOrdersFrom,
  physicalReturnsFromDepositEvents,
  summarizeAccountBalance
} from "./shared.js";

let passed = 0;
let failed = 0;
function it(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed += 1;
  } catch (err) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err && err.message ? err.message.split("\n")[0] : err}`);
    failed += 1;
  }
}

console.log("\nsummarizeAccountBalance\n");

it("more than 25 orders: an old unpaid order beyond the page is still counted", () => {
  // 30 delivered+paid orders, then one old unpaid order — exactly the case the
  // paginated (limit 10 / 25) queries used to hide.
  const orders = [];
  for (let i = 0; i < 30; i += 1) {
    orders.push({ status: "delivered", balanceDue: 0, deliveryDate: `2026-06-${String((i % 28) + 1).padStart(2, "0")}` });
  }
  orders.push({ status: "delivered", balanceDue: 40000, deliveryDate: "2026-01-05" });
  const s = summarizeAccountBalance(orders);
  assert.strictEqual(s.debt, 40000);
  assert.strictEqual(s.outstandingCount, 1);
  assert.strictEqual(s.net, 40000);
  assert.strictEqual(s.oldestOutstandingDate, "2026-01-05");
});

it("old open debt on a delivered order is counted (status is not a filter for debt)", () => {
  const s = summarizeAccountBalance([
    { status: "delivered", balanceDue: 100000, deliveryDate: "2026-02-01" }
  ]);
  assert.strictEqual(s.debt, 100000);
  assert.strictEqual(s.outstandingCount, 1);
});

it("mixed debt + credit: reports both and the net", () => {
  const s = summarizeAccountBalance([
    { status: "delivered", balanceDue: 120000, deliveryDate: "2026-03-01" },
    { status: "delivered", balanceDue: -30000, deliveryDate: "2026-03-05" } // overpaid → credit
  ]);
  assert.strictEqual(s.debt, 120000);
  assert.strictEqual(s.credit, 30000);
  assert.strictEqual(s.net, 90000);
  assert.strictEqual(s.outstandingCount, 1);
});

it("pure credit: no debt, positive credit, negative net", () => {
  const s = summarizeAccountBalance([
    { status: "delivered", balanceDue: -50000, deliveryDate: "2026-04-01" }
  ]);
  assert.strictEqual(s.debt, 0);
  assert.strictEqual(s.credit, 50000);
  assert.strictEqual(s.net, -50000);
  assert.strictEqual(s.outstandingCount, 0);
});

it("cancelled orders count for neither debt nor credit", () => {
  const s = summarizeAccountBalance([
    { status: "cancelled", balanceDue: 90000 },
    { status: "cancelled", balanceDue: -90000 }
  ]);
  assert.deepStrictEqual([s.debt, s.credit, s.net], [0, 0, 0]);
});

it("a pending_approval order is not yet confirmed debt (but its credit still counts)", () => {
  assert.strictEqual(summarizeAccountBalance([{ status: "pending_approval", balanceDue: 70000 }]).debt, 0);
  assert.strictEqual(summarizeAccountBalance([{ status: "pending_approval", balanceDue: -70000 }]).credit, 70000);
});

it("all-zero balances read as settled", () => {
  const s = summarizeAccountBalance([
    { status: "delivered", balanceDue: 0 },
    { status: "new", balanceDue: 0 }
  ]);
  assert.deepStrictEqual([s.debt, s.credit, s.net, s.outstandingCount], [0, 0, 0, 0]);
});

it("oldest outstanding date is the earliest among unpaid orders only", () => {
  const s = summarizeAccountBalance([
    { status: "delivered", balanceDue: 0, deliveryDate: "2026-01-01" }, // paid, ignored
    { status: "delivered", balanceDue: 10000, deliveryDate: "2026-05-01" },
    { status: "delivered", balanceDue: 10000, deliveryDate: "2026-03-01" }
  ]);
  assert.strictEqual(s.oldestOutstandingDate, "2026-03-01");
});

console.log("\nopenOrdersFrom\n");

it("keeps in-flight orders and drops delivered/cancelled across a large set", () => {
  const orders = [];
  for (let i = 0; i < 40; i += 1) orders.push({ id: `d${i}`, status: "delivered" });
  orders.push({ id: "old-open", status: "assigned" });
  orders.push({ id: "cancelled", status: "cancelled" });
  orders.push({ id: "pending", status: "pending_approval" });
  const open = openOrdersFrom(orders);
  const ids = open.map((o) => o.id).sort();
  assert.deepStrictEqual(ids, ["old-open", "pending"]);
});

console.log("\nphysicalReturnsFromDepositEvents\n");

it("credited and refunded events are returns; charged and forfeited are not", () => {
  const returns = physicalReturnsFromDepositEvents([
    { eventType: "charged", qty: 3, containerType: "jug", amount: 90000, eventDate: "2026-05-01" },
    { eventType: "credited", qty: 2, containerType: "jug", amount: 60000, eventDate: "2026-05-10" },
    { eventType: "refunded", qty: 1, containerType: "crate", amount: 20000, eventDate: "2026-05-11" },
    { eventType: "forfeited", qty: 1, containerType: "jug", amount: 30000, eventDate: "2026-05-12" }
  ]);
  assert.strictEqual(returns.length, 2);
  assert.deepStrictEqual(returns.map((r) => r.handling).sort(), ["credit", "refund"]);
  const credit = returns.find((r) => r.handling === "credit");
  assert.deepStrictEqual(
    [credit.qty, credit.containerType, credit.amount, credit.date],
    [2, "jug", 60000, "2026-05-10"]
  );
});

it("a charge_reversed (cancelled order) is NOT a physical return", () => {
  // P0-07: reversing a deposit charge because the order was cancelled reduces
  // the holding, but no container came back, so it must not show as a return.
  const returns = physicalReturnsFromDepositEvents([
    { eventType: "charged", qty: 2, containerType: "jug", amount: 60000 },
    { eventType: "charge_reversed", qty: 2, containerType: "jug", amount: 60000, eventDate: "2026-05-20" }
  ]);
  assert.deepStrictEqual(returns, []);
});

it("falls back to createdAt when eventDate is absent, and handles an empty set", () => {
  const [r] = physicalReturnsFromDepositEvents([{ eventType: "credited", qty: 1, createdAt: "2026-06-01T00:00:00Z" }]);
  assert.strictEqual(r.date, "2026-06-01T00:00:00Z");
  assert.deepStrictEqual(physicalReturnsFromDepositEvents([]), []);
  assert.deepStrictEqual(physicalReturnsFromDepositEvents(null), []);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

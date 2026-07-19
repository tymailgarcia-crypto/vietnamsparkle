"use strict";

// Pure unit tests for cancellationMath.js — no emulator, no I/O. Run:
//   cd firebase/functions && node cancellationMath.test.js
//
// These pin the money math the CANCELLATION-REFUND-PLAN acceptance criteria rest
// on: single reduction of active-order money, refund-owed definitions across
// unpaid/partial/full/overpaid, the consecutive-cancellation no-double-count
// formula, and the reduction guards (no increases, no new products).

const assert = require("node:assert");
const {
  vnd,
  computeRefundRequired,
  refundStatusFor,
  computeReductionCancellation
} = require("./cancellationMath");

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

console.log("\ncancellationMath\n");

// --- computeRefundRequired ---

it("unpaid full cancel owes nothing", () => {
  // netPayments 0, revisedTotal 0 (full), no siblings
  assert.strictEqual(computeRefundRequired(0, 0, 0), 0);
});

it("fully-paid full cancel refunds everything paid", () => {
  // paid 260k, full cancel -> revisedTotal 0
  assert.strictEqual(computeRefundRequired(260000, 0, 0), 260000);
});

it("partially-paid full cancel refunds the amount received", () => {
  assert.strictEqual(computeRefundRequired(100000, 0, 0), 100000);
});

it("overpaid order refunds only the overpayment", () => {
  // paid 300k on a 260k order that is NOT cancelled (revisedTotal 260k)
  assert.strictEqual(computeRefundRequired(300000, 260000, 0), 40000);
});

it("paid-in-full order with no reduction owes nothing", () => {
  assert.strictEqual(computeRefundRequired(260000, 260000, 0), 0);
});

it("partial cancel of a fully-paid order refunds the removed value", () => {
  // paid 100k, revised total 60k after reduction -> 40k owed
  assert.strictEqual(computeRefundRequired(100000, 60000, 0), 40000);
});

it("consecutive cancellation does not double-count an existing open obligation", () => {
  // paid 100k; first case already owes 40k (still open); second cancel revises
  // total to 30k. Naive: 100k - 30k = 70k. Correct: minus the 40k already owed.
  assert.strictEqual(computeRefundRequired(100000, 30000, 40000), 30000);
});

it("open obligations larger than the gap floor the refund at zero", () => {
  assert.strictEqual(computeRefundRequired(100000, 80000, 40000), 0);
});

// --- refundStatusFor ---

it("no requirement -> not_required", () => {
  assert.strictEqual(refundStatusFor(0, 0), "not_required");
});
it("required, nothing paid -> pending", () => {
  assert.strictEqual(refundStatusFor(40000, 0), "pending");
});
it("required, some paid -> partial", () => {
  assert.strictEqual(refundStatusFor(40000, 15000), "partial");
});
it("required, fully paid -> paid", () => {
  assert.strictEqual(refundStatusFor(40000, 40000), "paid");
});
it("over-paid still reads paid (clamped)", () => {
  assert.strictEqual(refundStatusFor(40000, 50000), "paid");
});

// --- computeReductionCancellation ---

const items = [
  { productId: "P1", productName: "19L jug", quantity: 5, unitPrice: 20000 },
  { productId: "P2", productName: "Crate", quantity: 2, unitPrice: 50000 }
];
const deposits = { P1: 30000, P2: 0 };

it("reducing one line computes removed value and after-items", () => {
  // keep 3 of P1 (remove 2), keep 2 of P2 (unchanged not listed)
  const r = computeReductionCancellation(items, { P1: 3 }, deposits);
  // removed 2 x 20000 subtotal, 2 x 30000 deposit
  assert.strictEqual(r.subtotalRemoved, 40000);
  assert.strictEqual(r.depositRemoved, 60000);
  assert.strictEqual(r.lineDeltas.length, 1);
  assert.strictEqual(r.lineDeltas[0].productId, "P1");
  assert.strictEqual(r.lineDeltas[0].delta, -2);
  // after: P1 x3 (survives) + P2 x2 (untouched)
  assert.strictEqual(r.afterItems.length, 2);
  const p1 = r.afterItems.find((i) => i.productId === "P1");
  assert.strictEqual(p1.quantity, 3);
  assert.strictEqual(p1.lineTotal, 60000);
  assert.strictEqual(p1.depositPerUnit, 30000);
});

it("removing a line entirely drops it from after-items", () => {
  const r = computeReductionCancellation(items, { P2: 0 }, deposits);
  assert.strictEqual(r.subtotalRemoved, 100000); // 2 x 50000
  assert.strictEqual(r.depositRemoved, 0);
  assert.ok(!r.afterItems.find((i) => i.productId === "P2"));
  assert.strictEqual(r.afterItems.length, 1); // only P1 remains
});

it("rejects an increase (that is an edit, not a cancellation)", () => {
  assert.throws(() => computeReductionCancellation(items, { P1: 6 }, deposits), /increase/);
});

it("rejects a new product", () => {
  assert.throws(() => computeReductionCancellation(items, { P9: 1 }, deposits), /new product/);
});

it("vnd rounds and defends against junk", () => {
  assert.strictEqual(vnd(1.4), 1);
  assert.strictEqual(vnd("2000"), 2000);
  assert.strictEqual(vnd(undefined), 0);
  assert.strictEqual(vnd(NaN), 0);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);

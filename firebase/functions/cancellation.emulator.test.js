"use strict";

// Behavioral tests for the cancellation/refund callable CORES, run against the
// Firestore emulator with the Admin SDK (no functions/auth emulator needed). The
// pure arithmetic is covered by cancellationMath.test.js; this exercises the
// transaction wiring: atomic approval, the guards, idempotency, the money written
// to the order + case, over-refund rejection, and reconcileCaseRefund end-to-end.
//
// Run (Java is installed but not on PATH — see HANDOFF.md):
//   cd firebase
//   export JAVA_HOME="/c/Program Files/Eclipse Adoptium/jre-21.0.11.10-hotspot"
//   firebase emulators:exec --only firestore \
//     "cd functions && NODE_ENV=test node cancellation.emulator.test.js"
//
// Read the emulator's stderr, not just the pass count.

process.env.NODE_ENV = "test"; // exposes _cancellationTestApi (guarded in index.js)

const assert = require("node:assert");
const admin = require("firebase-admin");

// Match the emulator's project (emulators:exec sets GCLOUD_PROJECT) so
// singleProjectMode doesn't reject the Admin SDK writes.
admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || "demo-cancellation-emulator" });
const db = admin.firestore();

const {
  applyApprovalTransaction,
  reconcileCaseRefund,
  recordOrderRefundImpl,
  attachRefundEvidenceImpl,
  resolveLegacyCancellationImpl,
  depositReversalId
} = require("./index.js")._cancellationTestApi();

let passed = 0;
let failed = 0;
async function it(name, fn) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed += 1;
  } catch (err) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err && err.message ? err.message.split("\n")[0] : err}`);
    failed += 1;
  }
}
async function assertRejects(fn, code) {
  try {
    await fn();
  } catch (e) {
    assert.strictEqual(e.code, code, `expected code '${code}', got '${e.code}' (${e && e.message})`);
    return;
  }
  throw new Error(`expected a rejection with code '${code}'`);
}

const ISO = "2026-07-19T00:00:00.000Z";

async function seedOrder(orderId, over) {
  await db.doc(`orders/${orderId}`).set({
    customerId: "CUS-1", authUid: "cust-1", status: "assigned",
    subtotal: 100000, depositTotal: 60000, amountPaid: 0, balanceDue: 160000,
    paymentStatus: "unpaid", ...over
  });
}
async function seedProduct(productId, unitPrice, deposit) {
  await db.doc(`products/${productId}`).set({ productName: productId, unitPrice, defaultDepositAmount: deposit, active: true });
}
async function seedItem(orderId, productId, qty, unitPrice) {
  await db.collection("orderItems").add({
    orderId, authUid: "cust-1", productId, productName: productId, quantity: qty, unitPrice, lineTotal: qty * unitPrice
  });
}
async function seedPayment(id, orderId, amount, extra) {
  await db.doc(`payments/${id}`).set({ orderId, amount, method: "cash", createdAt: ISO, ...(extra || {}) });
}
async function seedProductTyped(productId, unitPrice, deposit, containerType) {
  await db.doc(`products/${productId}`).set({ productName: productId, unitPrice, defaultDepositAmount: deposit, containerType, active: true });
}
async function seedDeposit(id, orderId, containerType, qty, amount, eventType) {
  await db.doc(`depositEvents/${id}`).set({ orderId, customerId: "CUS-1", authUid: "cust-1", containerType, qty, amount, eventType, eventDate: "2026-07-19" });
}
async function reversalsFor(orderId) {
  const snap = await db.collection("depositEvents").where("orderId", "==", orderId).where("eventType", "==", "charge_reversed").get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}
const owner = (orderId, req, over) => ({
  orderId, caseId: `${orderId}-cx-${req}`, reason: "test reason",
  requestedBy: "owner-uid", requestedByRole: "owner", requestedAt: ISO, decidedBy: "owner-uid", ...over
});

(async () => {
console.log("\ncancellation cores (emulator)\n");

// --- Full cancellation ---

await it("full cancel of an unpaid order: order cancelled, case approved, no refund", async () => {
  await seedOrder("ORD-FU", { status: "assigned" });
  await seedItem("ORD-FU", "P1", 5, 20000);
  const res = await applyApprovalTransaction(owner("ORD-FU", "r1", { kind: "full", remainingItems: null }));
  assert.strictEqual(res.status, "approved");
  assert.strictEqual(res.refundRequired, 0);
  const order = (await db.doc("orders/ORD-FU").get()).data();
  assert.strictEqual(order.status, "cancelled");
  assert.strictEqual(order.cancellationCaseId, "ORD-FU-cx-r1");
  const c = (await db.doc("orderCancellations/ORD-FU-cx-r1").get()).data();
  assert.strictEqual(c.decisionStatus, "approved");
  assert.strictEqual(c.refundStatus, "not_required");
  assert.strictEqual(c.before.items.length, 1);
  assert.strictEqual(c.after.items.length, 0);
});

await it("full cancel of a fully-paid order: refundRequired == amount paid, pending; order money frozen", async () => {
  await seedOrder("ORD-FP", { status: "assigned", amountPaid: 160000, balanceDue: 0, paymentStatus: "paid" });
  await seedItem("ORD-FP", "P1", 5, 20000);
  await seedPayment("PAY-FP", "ORD-FP", 160000);
  const res = await applyApprovalTransaction(owner("ORD-FP", "r1", { kind: "full", remainingItems: null }));
  assert.strictEqual(res.refundRequired, 160000);
  const c = (await db.doc("orderCancellations/ORD-FP-cx-r1").get()).data();
  assert.strictEqual(c.refundStatus, "pending");
  assert.strictEqual(c.evidenceStatus, "missing");
  const order = (await db.doc("orders/ORD-FP").get()).data();
  assert.strictEqual(order.status, "cancelled");
  assert.strictEqual(order.amountPaid, 160000); // frozen — case owns settlement
});

// --- Guards ---

await it("delivered order rejects cancellation", async () => {
  await seedOrder("ORD-DEL", { status: "delivered" });
  await assertRejects(() => applyApprovalTransaction(owner("ORD-DEL", "r1", { kind: "full" })), "failed-precondition");
});

await it("out_for_delivery order rejects cancellation (must return to assignment)", async () => {
  await seedOrder("ORD-OFD", { status: "out_for_delivery" });
  await assertRejects(() => applyApprovalTransaction(owner("ORD-OFD", "r1", { kind: "full" })), "failed-precondition");
});

await it("duplicate approval of the same case is an idempotent no-op", async () => {
  await seedOrder("ORD-DUP", { status: "assigned" });
  await seedItem("ORD-DUP", "P1", 2, 20000);
  await applyApprovalTransaction(owner("ORD-DUP", "r1", { kind: "full" }));
  const again = await applyApprovalTransaction(owner("ORD-DUP", "r1", { kind: "full" }));
  assert.strictEqual(again.status, "already_approved");
});

// --- Partial (reduction-only) ---

await it("partial reduction: order stays active, totals + items rewritten, no refund when unpaid", async () => {
  await seedProduct("P1", 20000, 30000);
  await seedOrder("ORD-PA", { status: "assigned", subtotal: 100000, depositTotal: 150000, amountPaid: 0, balanceDue: 250000 });
  await seedItem("ORD-PA", "P1", 5, 20000);
  const res = await applyApprovalTransaction(owner("ORD-PA", "r1", { kind: "partial", remainingItems: [{ productId: "P1", quantity: 3 }] }));
  assert.strictEqual(res.refundRequired, 0);
  const order = (await db.doc("orders/ORD-PA").get()).data();
  assert.strictEqual(order.status, "assigned"); // still active
  assert.strictEqual(order.subtotal, 60000);   // 3 x 20000
  assert.strictEqual(order.depositTotal, 90000); // 3 x 30000
  assert.strictEqual(order.balanceDue, 150000);
  const items = await db.collection("orderItems").where("orderId", "==", "ORD-PA").get();
  assert.strictEqual(items.size, 1);
  assert.strictEqual(items.docs[0].data().quantity, 3);
  const c = (await db.doc("orderCancellations/ORD-PA-cx-r1").get()).data();
  assert.strictEqual(c.kind, "partial");
  assert.strictEqual(c.lineDeltas[0].delta, -2);
});

await it("partial reduction of a fully-paid order: case owes the removed value, order shows overpaid", async () => {
  await seedProduct("P1", 20000, 30000);
  await seedOrder("ORD-PP", { status: "assigned", subtotal: 100000, depositTotal: 150000, amountPaid: 250000, balanceDue: 0, paymentStatus: "paid" });
  await seedItem("ORD-PP", "P1", 5, 20000);
  await seedPayment("PAY-PP", "ORD-PP", 250000);
  const res = await applyApprovalTransaction(owner("ORD-PP", "r1", { kind: "partial", remainingItems: [{ productId: "P1", quantity: 3 }] }));
  assert.strictEqual(res.refundRequired, 100000); // 250000 - 150000
  const order = (await db.doc("orders/ORD-PP").get()).data();
  assert.strictEqual(order.balanceDue, -100000); // overpaid by the refund owed
  assert.strictEqual(order.paymentStatus, "paid");
});

await it("partial rejects an increase (that is an edit, not a cancellation)", async () => {
  await seedProduct("P1", 20000, 30000);
  await seedOrder("ORD-INC", { status: "assigned" });
  await seedItem("ORD-INC", "P1", 2, 20000);
  await assertRejects(() => applyApprovalTransaction(owner("ORD-INC", "r1", { kind: "partial", remainingItems: [{ productId: "P1", quantity: 5 }] })), "invalid-argument");
});

// --- P0-07 deposit charge-reversal (in the same transaction) ---

await it("full cancel reverses the whole outstanding deposit charge, deterministic id", async () => {
  await seedOrder("ORD-DR1", { status: "assigned" });
  await seedItem("ORD-DR1", "P1", 2, 20000);
  await seedDeposit("DEP-DR1", "ORD-DR1", "jug", 2, 60000, "charged");
  await applyApprovalTransaction(owner("ORD-DR1", "r1", { kind: "full" }));
  const revs = await reversalsFor("ORD-DR1");
  assert.strictEqual(revs.length, 1);
  assert.strictEqual(revs[0].id, depositReversalId("ORD-DR1-cx-r1", "jug"));
  assert.strictEqual(revs[0].qty, 2);
  assert.strictEqual(revs[0].amount, 60000);
  assert.strictEqual(revs[0].cancellationCaseId, "ORD-DR1-cx-r1");
});

await it("full cancel only reverses what is still charged after a prior return", async () => {
  await seedOrder("ORD-DR2", { status: "assigned" });
  await seedItem("ORD-DR2", "P1", 2, 20000);
  await seedDeposit("DEP-DR2c", "ORD-DR2", "jug", 2, 60000, "charged");
  await seedDeposit("DEP-DR2r", "ORD-DR2", "jug", 1, 30000, "credited"); // one already returned
  await applyApprovalTransaction(owner("ORD-DR2", "r1", { kind: "full" }));
  const revs = await reversalsFor("ORD-DR2");
  assert.strictEqual(revs.length, 1);
  assert.strictEqual(revs[0].qty, 1);       // only the outstanding one
  assert.strictEqual(revs[0].amount, 30000);
});

await it("full cancel with nothing outstanding writes no reversal", async () => {
  await seedOrder("ORD-DR3", { status: "assigned" });
  await seedItem("ORD-DR3", "P1", 1, 20000);
  await seedDeposit("DEP-DR3c", "ORD-DR3", "jug", 1, 30000, "charged");
  await seedDeposit("DEP-DR3r", "ORD-DR3", "jug", 1, 30000, "refunded"); // already fully returned
  await applyApprovalTransaction(owner("ORD-DR3", "r1", { kind: "full" }));
  assert.strictEqual((await reversalsFor("ORD-DR3")).length, 0);
});

await it("partial cancel reverses only the removed line's deposit", async () => {
  await seedProductTyped("P1", 20000, 30000, "jug");
  await seedOrder("ORD-DR4", { status: "assigned", subtotal: 100000, depositTotal: 150000, amountPaid: 0, balanceDue: 250000 });
  await seedItem("ORD-DR4", "P1", 5, 20000);
  await seedDeposit("DEP-DR4", "ORD-DR4", "jug", 5, 150000, "charged");
  await applyApprovalTransaction(owner("ORD-DR4", "r1", { kind: "partial", remainingItems: [{ productId: "P1", quantity: 3 }] }));
  const revs = await reversalsFor("ORD-DR4");
  assert.strictEqual(revs.length, 1);
  assert.strictEqual(revs[0].qty, 2);       // removed 2 of 5
  assert.strictEqual(revs[0].amount, 60000); // 2 x 30000
});

await it("partial reversal is capped at the outstanding charge (already-returned containers)", async () => {
  await seedProductTyped("P1", 20000, 30000, "jug");
  await seedOrder("ORD-DR5", { status: "assigned", subtotal: 100000, depositTotal: 150000, amountPaid: 0, balanceDue: 250000 });
  await seedItem("ORD-DR5", "P1", 5, 20000);
  await seedDeposit("DEP-DR5c", "ORD-DR5", "jug", 5, 150000, "charged");
  await seedDeposit("DEP-DR5r", "ORD-DR5", "jug", 4, 120000, "credited"); // only 1 still held
  await applyApprovalTransaction(owner("ORD-DR5", "r1", { kind: "partial", remainingItems: [{ productId: "P1", quantity: 3 }] }));
  const revs = await reversalsFor("ORD-DR5");
  assert.strictEqual(revs.length, 1);
  assert.strictEqual(revs[0].qty, 1);       // want to reverse 2, but only 1 outstanding
  assert.strictEqual(revs[0].amount, 30000);
});

await it("net holding after a full-cancel reversal is zero (no double reversal on the ledger)", async () => {
  await seedOrder("ORD-DR6", { status: "assigned" });
  await seedItem("ORD-DR6", "P1", 3, 20000);
  await seedDeposit("DEP-DR6", "ORD-DR6", "jug", 3, 90000, "charged");
  await applyApprovalTransaction(owner("ORD-DR6", "r1", { kind: "full" }));
  const all = await db.collection("depositEvents").where("orderId", "==", "ORD-DR6").get();
  let netQty = 0;
  all.forEach((d) => {
    const e = d.data();
    if (e.eventType === "charged") netQty += Number(e.qty || 0);
    else if (["refunded", "credited", "forfeited", "charge_reversed"].includes(e.eventType)) netQty -= Number(e.qty || 0);
  });
  assert.strictEqual(netQty, 0);
});

// --- Refund lifecycle ---

await it("recordOrderRefund writes an immutable negative payment and settles the case", async () => {
  await seedOrder("ORD-RF", { status: "assigned", amountPaid: 160000, balanceDue: 0, paymentStatus: "paid" });
  await seedItem("ORD-RF", "P1", 5, 20000);
  await seedPayment("PAY-RF", "ORD-RF", 160000);
  await applyApprovalTransaction(owner("ORD-RF", "r1", { kind: "full" }));
  const caseId = "ORD-RF-cx-r1";

  const r1 = await recordOrderRefundImpl("owner-uid", { caseId, refundId: "ref1", amount: 100000, method: "refund_bank" });
  assert.strictEqual(r1.status, "recorded");
  assert.strictEqual(r1.remaining, 60000);
  assert.strictEqual(r1.refundStatus, "partial");
  const pay = (await db.doc(`payments/${caseId}-refund-ref1`).get()).data();
  assert.strictEqual(pay.amount, -100000);
  assert.strictEqual(pay.cancellationCaseId, caseId);

  const r2 = await recordOrderRefundImpl("owner-uid", { caseId, refundId: "ref2", amount: 60000, method: "refund_cash" });
  assert.strictEqual(r2.remaining, 0);
  assert.strictEqual(r2.refundStatus, "paid");
});

await it("over-refund is rejected", async () => {
  const caseId = "ORD-RF-cx-r1"; // fully refunded above
  await assertRejects(() => recordOrderRefundImpl("owner-uid", { caseId, refundId: "ref3", amount: 1, method: "refund_bank" }), "failed-precondition");
});

await it("duplicate refundId is idempotent (no second payment)", async () => {
  const caseId = "ORD-RF-cx-r1";
  const dup = await recordOrderRefundImpl("owner-uid", { caseId, refundId: "ref1", amount: 100000, method: "refund_bank" });
  assert.strictEqual(dup.status, "already_recorded");
  const pays = await db.collection("payments").where("cancellationCaseId", "==", caseId).get();
  assert.strictEqual(pays.size, 2); // ref1 + ref2 only
});

// --- reconcileCaseRefund (the trigger/nightly backstop) ---

await it("reconcileCaseRefund settles a case from a directly-written refund payment + logs an event", async () => {
  // An approved case with an open refund, then a refund payment written OUTSIDE
  // recordOrderRefund (a console/Admin-SDK write) — the backstop must settle it.
  const caseId = "ORD-REC-cx-r1";
  await db.doc(`orderCancellations/${caseId}`).set({
    orderId: "ORD-REC", customerId: "CUS-1", authUid: "cust-1", kind: "full",
    decisionStatus: "approved", refundStatus: "pending", evidenceStatus: "missing",
    refundRequired: 50000, refundRemaining: 50000, createdAt: ISO, updatedAt: ISO
  });
  await seedPayment(`${caseId}-refund-ext`, "ORD-REC", -50000, { cancellationCaseId: caseId });
  const changed = await reconcileCaseRefund(caseId, { eventSource: "test" });
  assert.strictEqual(changed, true);
  const c = (await db.doc(`orderCancellations/${caseId}`).get()).data();
  assert.strictEqual(c.refundRemaining, 0);
  assert.strictEqual(c.refundStatus, "paid");
  const events = await db.collection("reconciliationEvents").where("caseId", "==", caseId).get();
  assert.ok(events.size >= 1, "expected a reconciliationEvents row");
});

await it("reconcileCaseRefund is idempotent once settled", async () => {
  const again = await reconcileCaseRefund("ORD-REC-cx-r1", { eventSource: "test" });
  assert.strictEqual(again, false);
});

await it("reconcileCaseRefund flags an over-refund but clamps remaining at 0", async () => {
  const caseId = "ORD-OVR-cx-r1";
  await db.doc(`orderCancellations/${caseId}`).set({
    orderId: "ORD-OVR", kind: "full", decisionStatus: "approved",
    refundStatus: "pending", refundRequired: 40000, refundRemaining: 40000, createdAt: ISO, updatedAt: ISO
  });
  await seedPayment(`${caseId}-refund-a`, "ORD-OVR", -30000, { cancellationCaseId: caseId });
  await seedPayment(`${caseId}-refund-b`, "ORD-OVR", -20000, { cancellationCaseId: caseId });
  const changed = await reconcileCaseRefund(caseId, { eventSource: "test" });
  assert.strictEqual(changed, true);
  const c = (await db.doc(`orderCancellations/${caseId}`).get()).data();
  assert.strictEqual(c.refundRemaining, 0);
  assert.strictEqual(c.refundStatus, "paid");
  const ev = (await db.collection("reconciliationEvents").where("caseId", "==", caseId).get()).docs[0].data();
  assert.strictEqual(ev.overRefunded, true);
});

// --- attachRefundEvidence ---

await it("attaching evidence to the only refund flips evidenceStatus to complete", async () => {
  await seedOrder("ORD-EV", { status: "assigned", amountPaid: 100000, balanceDue: 0, paymentStatus: "paid" });
  await seedItem("ORD-EV", "P1", 5, 20000);
  await seedPayment("PAY-EV", "ORD-EV", 100000);
  await applyApprovalTransaction(owner("ORD-EV", "r1", { kind: "full" }));
  const caseId = "ORD-EV-cx-r1";
  await recordOrderRefundImpl("owner-uid", { caseId, refundId: "ref1", amount: 100000, method: "refund_bank" });
  assert.strictEqual((await db.doc(`orderCancellations/${caseId}`).get()).data().evidenceStatus, "missing");
  const res = await attachRefundEvidenceImpl("owner-uid", {
    caseId, refundId: "ref1", storagePath: "refund-proofs/ORD-EV/ref1", proofKind: "electronic", generation: "g1", md5Hash: "h1"
  });
  assert.strictEqual(res.evidenceStatus, "complete");
  const c = (await db.doc(`orderCancellations/${caseId}`).get()).data();
  assert.strictEqual(c.refundEvidence.length, 1);
  assert.strictEqual(c.refundEvidence[0].storagePath, "refund-proofs/ORD-EV/ref1");
});

await it("evidence covering one of two refunds stays missing until both are covered", async () => {
  await seedOrder("ORD-EV2", { status: "assigned", amountPaid: 100000, balanceDue: 0, paymentStatus: "paid" });
  await seedItem("ORD-EV2", "P1", 5, 20000);
  await seedPayment("PAY-EV2", "ORD-EV2", 100000);
  await applyApprovalTransaction(owner("ORD-EV2", "r1", { kind: "full" }));
  const caseId = "ORD-EV2-cx-r1";
  await recordOrderRefundImpl("owner-uid", { caseId, refundId: "ref-a", amount: 60000, method: "refund_bank" });
  await recordOrderRefundImpl("owner-uid", { caseId, refundId: "ref-b", amount: 40000, method: "refund_cash" });
  const r1 = await attachRefundEvidenceImpl("owner-uid", { caseId, refundId: "ref-a", storagePath: "refund-proofs/ORD-EV2/a", proofKind: "electronic" });
  assert.strictEqual(r1.evidenceStatus, "missing");
  const r2 = await attachRefundEvidenceImpl("owner-uid", { caseId, refundId: "ref-b", storagePath: "refund-proofs/ORD-EV2/b", proofKind: "cash" });
  assert.strictEqual(r2.evidenceStatus, "complete");
});

await it("evidence for a nonexistent refundId is rejected", async () => {
  await assertRejects(() => attachRefundEvidenceImpl("owner-uid", { caseId: "ORD-EV-cx-r1", refundId: "nope", storagePath: "refund-proofs/ORD-EV/nope", proofKind: "cash" }), "failed-precondition");
});

await it("evidence with a storagePath outside refund-proofs/ is rejected", async () => {
  await assertRejects(() => attachRefundEvidenceImpl("owner-uid", { caseId: "ORD-EV-cx-r1", refundId: "ref1", storagePath: "invoices/ORD-EV/x", proofKind: "cash" }), "invalid-argument");
});

await it("attaching the same evidence twice is idempotent", async () => {
  const dup = await attachRefundEvidenceImpl("owner-uid", { caseId: "ORD-EV-cx-r1", refundId: "ref1", storagePath: "refund-proofs/ORD-EV/ref1", proofKind: "electronic", generation: "g1" });
  assert.strictEqual(dup.status, "already_attached");
});

// --- resolveLegacyCancellation ---

async function seedLegacyCase(caseId, over) {
  await db.doc(`orderCancellations/${caseId}`).set({
    orderId: "ORD-LEG", customerId: "CUS-1", authUid: "cust-1", kind: "full",
    decisionStatus: "approved", refundStatus: "pending", evidenceStatus: "missing",
    refundRequired: 80000, refundRemaining: 80000, source: "legacy_imported",
    legacyOutcome: null, createdAt: ISO, updatedAt: ISO, ...over
  });
}

await it("legacy refunded_off_system writes a case-linked refund payment and attests; reconciler agrees", async () => {
  const caseId = "ORD-LEG1-cx-legacy";
  await seedLegacyCase(caseId, { orderId: "ORD-LEG1" });
  const res = await resolveLegacyCancellationImpl("owner-uid", {
    caseId, outcome: "refunded_off_system", amount: 80000, method: "bank transfer", details: "Refunded via Techcombank 2026-03-01"
  });
  assert.strictEqual(res.status, "resolved");
  const c = (await db.doc(`orderCancellations/${caseId}`).get()).data();
  assert.strictEqual(c.legacyOutcome, "refunded_off_system");
  assert.strictEqual(c.evidenceStatus, "legacy_attested");
  assert.strictEqual(c.refundStatus, "paid");
  assert.strictEqual(c.refundRemaining, 0);
  const pay = (await db.doc(`payments/${caseId}-legacy-refunded_off_system`).get()).data();
  assert.strictEqual(pay.amount, -80000);
  assert.strictEqual(pay.cancellationCaseId, caseId);
  assert.strictEqual(await reconcileCaseRefund(caseId, {}), false); // consistent, no drift
});

await it("legacy payment_not_real reverses to the ORDER only; reconciler must not count it as a refund", async () => {
  const caseId = "ORD-LEG2-cx-legacy";
  await seedLegacyCase(caseId, { orderId: "ORD-LEG2", refundRequired: 50000, refundRemaining: 50000 });
  const res = await resolveLegacyCancellationImpl("owner-uid", {
    caseId, outcome: "payment_not_real", amount: 50000, details: "Imported Sheets row double-counted a cash payment"
  });
  assert.strictEqual(res.status, "resolved");
  const pay = (await db.doc(`payments/${caseId}-legacy-payment_not_real`).get()).data();
  assert.strictEqual(pay.amount, -50000);
  assert.strictEqual(pay.cancellationCaseId, null); // NOT a case refund
  assert.strictEqual(pay.correctsCaseId, caseId);
  const c = (await db.doc(`orderCancellations/${caseId}`).get()).data();
  assert.strictEqual(c.refundStatus, "not_required");
  assert.strictEqual(c.refundRequired, 0);
  assert.strictEqual(await reconcileCaseRefund(caseId, {}), false); // stays not_required
});

await it("legacy op rejects a non-legacy (app) case", async () => {
  await assertRejects(() => resolveLegacyCancellationImpl("owner-uid", { caseId: "ORD-EV-cx-r1", outcome: "payment_not_real", amount: 1, details: "should fail" }), "failed-precondition");
});

await it("legacy resolution is idempotent", async () => {
  const dup = await resolveLegacyCancellationImpl("owner-uid", { caseId: "ORD-LEG1-cx-legacy", outcome: "refunded_off_system", amount: 80000, method: "bank transfer", details: "again" });
  assert.strictEqual(dup.status, "already_resolved");
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

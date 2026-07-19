// Tests for the legacy-cancellation backfill. Pure computeLegacyCase assertions
// need no emulator; runBackfill assertions drive the Firestore emulator via the
// Admin SDK. Run:
//   cd firebase
//   export JAVA_HOME="/c/Program Files/Eclipse Adoptium/jre-21.0.11.10-hotspot"
//   firebase emulators:exec --only firestore \
//     "node src/scripts/backfillLegacyCancellations.test.mjs"

import assert from "node:assert";
import admin from "firebase-admin";
import { computeLegacyCase, runBackfill } from "./backfillLegacyCancellations.js";

admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || "demo-backfill" });
const db = admin.firestore();

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

console.log("\nbackfill legacy cancellations\n");

// --- Pure computeLegacyCase ---

await it("positive net payments -> pending + review + refundRequired", () => {
  const c = computeLegacyCase({
    order: { id: "O1", subtotal: 100000, depositTotal: 60000, amountPaid: 160000, balanceDue: 0, cancelledBy: "owner" },
    items: [{ productId: "P1", productName: "Jug", quantity: 5, unitPrice: 20000 }],
    payments: [{ amount: 160000 }]
  });
  assert.strictEqual(c.source, "legacy_imported");
  assert.strictEqual(c.decisionStatus, "approved");
  assert.strictEqual(c.refundStatus, "pending");
  assert.strictEqual(c.legacyReview, true);
  assert.strictEqual(c.refundRequired, 160000);
  assert.strictEqual(c.refundRemaining, 160000);
  assert.strictEqual(c.before.items.length, 1);
  assert.strictEqual(c.after.items.length, 0);
});

await it("zero payments -> not_required, no review", () => {
  const c = computeLegacyCase({
    order: { id: "O2", subtotal: 100000, depositTotal: 0, amountPaid: 0, balanceDue: 100000 },
    items: [], payments: []
  });
  assert.strictEqual(c.refundStatus, "not_required");
  assert.strictEqual(c.legacyReview, false);
  assert.strictEqual(c.refundRequired, 0);
});

await it("payments already netted to zero by a prior refund -> not_required", () => {
  const c = computeLegacyCase({
    order: { id: "O3", subtotal: 100000 },
    items: [], payments: [{ amount: 100000 }, { amount: -100000 }]
  });
  assert.strictEqual(c.netPaymentsAtDecision, 0);
  assert.strictEqual(c.refundStatus, "not_required");
});

// --- runBackfill (emulator) ---

async function seedCancelledOrder(id, over, items, payments) {
  await db.doc(`orders/${id}`).set({
    status: "cancelled", customerId: "CUS-1", authUid: "cust-1",
    subtotal: 100000, depositTotal: 0, amountPaid: 0, balanceDue: 100000,
    cancellationReason: "changed mind", cancelledBy: "owner", cancelledAt: "2026-05-01T00:00:00Z",
    ...over
  });
  for (const item of items || []) await db.collection("orderItems").add({ orderId: id, ...item });
  for (const p of payments || []) await db.collection("payments").add({ orderId: id, ...p });
}

await it("dry-run writes no cases", async () => {
  await seedCancelledOrder("BF-1", {}, [{ productId: "P1", productName: "Jug", quantity: 2, unitPrice: 20000 }], []);
  const stats = await runBackfill(db, { dryRun: true });
  assert.ok(stats.scanned >= 1);
  assert.strictEqual((await db.doc("orderCancellations/BF-1-cx-legacy").get()).exists, false);
});

await it("write creates a case; a paid cancelled order is flagged review_required", async () => {
  await seedCancelledOrder("BF-2", { amountPaid: 160000, balanceDue: 0 },
    [{ productId: "P1", productName: "Jug", quantity: 5, unitPrice: 20000 }], [{ amount: 160000 }]);
  const stats = await runBackfill(db, { dryRun: false });
  assert.ok(stats.created >= 1);
  const c = (await db.doc("orderCancellations/BF-2-cx-legacy").get()).data();
  assert.strictEqual(c.source, "legacy_imported");
  assert.strictEqual(c.refundStatus, "pending");
  assert.strictEqual(c.legacyReview, true);
  assert.strictEqual(c.refundRequired, 160000);
  assert.strictEqual(c.reason, "changed mind");
});

await it("re-run is idempotent (existing cases skipped, nothing new created)", async () => {
  await runBackfill(db, { dryRun: false });        // ensure all created
  const second = await runBackfill(db, { dryRun: false });
  assert.strictEqual(second.created, 0);
});

await it("testFixture cancelled orders are skipped", async () => {
  await seedCancelledOrder("BF-FIX", { testFixture: true }, [], []);
  await runBackfill(db, { dryRun: false });
  assert.strictEqual((await db.doc("orderCancellations/BF-FIX-cx-legacy").get()).exists, false);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);

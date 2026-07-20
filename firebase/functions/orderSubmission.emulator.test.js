"use strict";

// Behavioral tests for the P0-02 idempotent order-creation core behind
// submitPublicOrder, run against the Firestore emulator with the Admin SDK.
// The client-side key rotation is covered by web/assets/orderSubmissionKey.test.mjs;
// this exercises the transaction wiring: one order per {authUid, submissionKey}
// across sequential retries AND parallel requests, key scoping per user, a new
// key creating a new order, and the legacy no-key fallback.
//
// Run (Java is installed but not on PATH — see HANDOFF.md):
//   cd firebase
//   export JAVA_HOME="/c/Program Files/Eclipse Adoptium/jre-21.0.11.10-hotspot"
//   firebase emulators:exec --only firestore \
//     "cd functions && NODE_ENV=test node orderSubmission.emulator.test.js"
//
// Read the emulator's stderr, not just the pass count.

process.env.NODE_ENV = "test"; // exposes _orderSubmissionTestApi (guarded in index.js)

const assert = require("node:assert");
const admin = require("firebase-admin");

admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || "demo-order-submission-emulator" });
const db = admin.firestore();

const { createOrderUnderSubmissionKey, SUBMISSION_KEY_PATTERN } = require("./index.js")._orderSubmissionTestApi();

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

const ISO = "2026-07-20T00:00:00.000Z";
let seq = 0;
function makeAttempt(over) {
  seq += 1;
  const orderId = `WEB-TEST-${String(seq).padStart(4, "0")}`;
  return {
    authUid: "cust-1",
    submissionKey: "11111111-aaaa-4bbb-8ccc-dddddddddddd",
    orderId,
    orderDoc: {
      createdAt: ISO, sourceChannel: "website", customerId: "CUS-84905123456",
      customerName: "Test", phone: "+84905123456", email: null, authUid: "cust-1",
      address: "12 Nguyen Hue, Da Nang", deliveryDate: "2026-07-21", deliveryWindow: "",
      status: "pending_approval", subtotal: 100000, depositTotal: 0, amountPaid: 0,
      balanceDue: 100000, paymentStatus: "unpaid", notes: ""
    },
    itemDocs: [
      { id: `ITEM-TEST-${seq}-1`, data: { orderId, authUid: "cust-1", productId: "water-19l", quantity: 2, unitPrice: 50000, lineTotal: 100000 } }
    ],
    ...over
  };
}

async function countDocs(coll, field, value) {
  const snap = await db.collection(coll).where(field, "==", value).get();
  return snap.size;
}

(async () => {
  await it("first submission creates the order, items, and the mapping doc", async () => {
    const attempt = makeAttempt({ submissionKey: "key-first-00000001" });
    const res = await createOrderUnderSubmissionKey(attempt);
    assert.strictEqual(res.duplicate, false);
    assert.strictEqual(res.orderId, attempt.orderId);
    const order = await db.doc(`orders/${attempt.orderId}`).get();
    assert.strictEqual(order.exists, true);
    assert.strictEqual(await countDocs("orderItems", "orderId", attempt.orderId), 1);
    const mapping = await db.doc(`orderSubmissions/cust-1__key-first-00000001`).get();
    assert.strictEqual(mapping.exists, true);
    assert.strictEqual(mapping.data().orderId, attempt.orderId);
  });

  await it("retry with the same key (timeout-after-commit / double-click) returns the original order and writes nothing", async () => {
    const key = "key-retry-00000001";
    const first = makeAttempt({ submissionKey: key });
    const firstRes = await createOrderUnderSubmissionKey(first);
    // The retry mints a different candidate orderId, exactly like a real
    // second callable invocation would.
    const retry = makeAttempt({ submissionKey: key });
    const retryRes = await createOrderUnderSubmissionKey(retry);
    assert.strictEqual(retryRes.duplicate, true);
    assert.strictEqual(retryRes.orderId, firstRes.orderId);
    const ghost = await db.doc(`orders/${retry.orderId}`).get();
    assert.strictEqual(ghost.exists, false, "retry must not create its candidate order");
    assert.strictEqual(await countDocs("orderItems", "orderId", retry.orderId), 0);
  });

  await it("two PARALLEL requests with the same key create exactly one order", async () => {
    const key = "key-parallel-0000001";
    const a = makeAttempt({ submissionKey: key });
    const b = makeAttempt({ submissionKey: key });
    const [resA, resB] = await Promise.all([
      createOrderUnderSubmissionKey(a),
      createOrderUnderSubmissionKey(b)
    ]);
    assert.strictEqual(resA.orderId, resB.orderId, "both callers must land on one order");
    assert.strictEqual([resA, resB].filter((r) => r.duplicate === false).length, 1, "exactly one creation");
    const created = [a, b].filter((x) => x.orderId === resA.orderId);
    assert.strictEqual(created.length, 1);
    const orders = await Promise.all([db.doc(`orders/${a.orderId}`).get(), db.doc(`orders/${b.orderId}`).get()]);
    assert.strictEqual(orders.filter((s) => s.exists).length, 1, "exactly one order doc on disk");
  });

  await it("a new deliberate order (new key, same user) still creates a second order", async () => {
    const a = makeAttempt({ submissionKey: "key-newer-00000001" });
    const b = makeAttempt({ submissionKey: "key-newer-00000002" });
    const resA = await createOrderUnderSubmissionKey(a);
    const resB = await createOrderUnderSubmissionKey(b);
    assert.strictEqual(resA.duplicate, false);
    assert.strictEqual(resB.duplicate, false);
    assert.notStrictEqual(resA.orderId, resB.orderId);
  });

  await it("the same key from a DIFFERENT user is a different mapping (no cross-user dedup)", async () => {
    const key = "key-shared-browser-1";
    const a = makeAttempt({ submissionKey: key, authUid: "cust-1" });
    const b = makeAttempt({ submissionKey: key, authUid: "cust-2" });
    b.orderDoc = { ...b.orderDoc, authUid: "cust-2" };
    const resA = await createOrderUnderSubmissionKey(a);
    const resB = await createOrderUnderSubmissionKey(b);
    assert.strictEqual(resA.duplicate, false);
    assert.strictEqual(resB.duplicate, false);
    assert.notStrictEqual(resA.orderId, resB.orderId);
  });

  await it("no key (legacy cached client) falls back to plain creation every time", async () => {
    const a = makeAttempt({ submissionKey: null });
    const b = makeAttempt({ submissionKey: null });
    const resA = await createOrderUnderSubmissionKey(a);
    const resB = await createOrderUnderSubmissionKey(b);
    assert.strictEqual(resA.duplicate, false);
    assert.strictEqual(resB.duplicate, false);
    assert.notStrictEqual(resA.orderId, resB.orderId);
    const orders = await Promise.all([db.doc(`orders/${a.orderId}`).get(), db.doc(`orders/${b.orderId}`).get()]);
    assert.strictEqual(orders.filter((s) => s.exists).length, 2);
  });

  await it("server pattern accepts client-shaped keys and rejects garbage", async () => {
    assert.strictEqual(SUBMISSION_KEY_PATTERN.test("0f7c9a4e-1111-4222-8333-abcdefabcdef"), true);
    assert.strictEqual(SUBMISSION_KEY_PATTERN.test("short"), false);
    assert.strictEqual(SUBMISSION_KEY_PATTERN.test("has spaces"), false);
    assert.strictEqual(SUBMISSION_KEY_PATTERN.test("a".repeat(65)), false);
    assert.strictEqual(SUBMISSION_KEY_PATTERN.test("../orders/evil"), false);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

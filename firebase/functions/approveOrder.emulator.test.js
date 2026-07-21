"use strict";

// P0-06 — atomic, retry-safe order approval. Runs approveOrderImpl against the
// Firestore emulator with the Admin SDK. Covers the acceptance cases: partial
// failure (rollback), parallel approval, retry/idempotency, no-deposit
// products, mixed container types, the status precondition, and the relocated
// account-takeover gate on customer linkage.
//
// Run (Java is installed but not on PATH — see HANDOFF.md):
//   cd firebase
//   export JAVA_HOME="/c/Program Files/Eclipse Adoptium/jre-21.0.11.10-hotspot"
//   firebase emulators:exec --only firestore \
//     "cd functions && node approveOrder.emulator.test.js"
//
// Read the emulator's stderr, not just the pass count.

process.env.NODE_ENV = "test";

const assert = require("node:assert");
const admin = require("firebase-admin");

admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || "demo-approve-order-emulator" });
const db = admin.firestore();

const { approveOrderImpl, depositChargeId } = require("./index.js")._approvalTestApi();

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
    if (code) assert.strictEqual(e.code, code, `expected code '${code}', got '${e.code}' (${e && e.message})`);
    return;
  }
  throw new Error(`expected a rejection${code ? ` with code '${code}'` : ""}`);
}

let seq = 0;
async function seedScenario(over = {}) {
  seq += 1;
  const orderId = `WEB-AP-${String(seq).padStart(4, "0")}`;
  const authUid = over.authUid !== undefined ? over.authUid : `uid-${seq}`;
  const customerId = over.customerId !== undefined ? over.customerId : (authUid ? `CUS-${authUid}` : null);
  await db.doc(`orders/${orderId}`).set({
    status: "pending_approval",
    customerId,
    authUid,
    customerName: "Test Customer",
    phone: "+84905123456",
    email: over.email || null,
    address: "12 Nguyen Hue, Da Nang",
    deliveryDate: "2026-07-25",
    sourceChannel: "website",
    subtotal: 100000, depositTotal: 0, amountPaid: 0, balanceDue: 100000, paymentStatus: "unpaid",
    ...(over.order || {})
  });
  const products = over.products || [{ id: "water-19l", containerType: "jug", deposit: 30000, qty: 2 }];
  for (const p of products) {
    await db.doc(`products/${p.id}`).set({ productName: p.id, unitPrice: 50000, defaultDepositAmount: p.deposit, containerType: p.containerType, active: true });
    await db.collection("orderItems").add({ orderId, authUid, productId: p.id, productName: p.id, quantity: p.qty, unitPrice: 50000, lineTotal: 50000 * p.qty });
  }
  if (over.seedCustomer) await db.doc(`customers/${over.seedCustomer.id}`).set(over.seedCustomer.data);
  return { orderId, authUid, customerId };
}

async function chargesFor(orderId) {
  const snap = await db.collection("depositEvents").where("orderId", "==", orderId).where("eventType", "==", "charged").get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

(async () => {
  await it("happy path: order approved, deterministic charge written, customer linked", async () => {
    const { orderId, authUid } = await seedScenario();
    const res = await approveOrderImpl(orderId, "owner-uid");
    assert.strictEqual(res.status, "new");
    assert.strictEqual(res.alreadyApproved, false);
    assert.strictEqual(res.chargesCreated, 1);

    const order = (await db.doc(`orders/${orderId}`).get()).data();
    assert.strictEqual(order.status, "new");

    const charges = await chargesFor(orderId);
    assert.strictEqual(charges.length, 1);
    assert.strictEqual(charges[0].id, depositChargeId(orderId, "jug"));
    assert.strictEqual(charges[0].amount, 60000); // 2 * 30000
    assert.strictEqual(charges[0].qty, 2);

    const customer = (await db.doc(`customers/CUS-${authUid}`).get()).data();
    assert.strictEqual(customer.authUid, authUid); // brand-new doc → linked
    assert.strictEqual(customer.address, "12 Nguyen Hue, Da Nang");
  });

  await it("no-deposit products: order approved, zero charges", async () => {
    const { orderId } = await seedScenario({ products: [{ id: "straw", containerType: "", deposit: 0, qty: 5 }] });
    const res = await approveOrderImpl(orderId, "owner-uid");
    assert.strictEqual(res.status, "new");
    assert.strictEqual(res.chargesCreated, 0);
    assert.strictEqual((await chargesFor(orderId)).length, 0);
    assert.strictEqual((await db.doc(`orders/${orderId}`).get()).data().status, "new");
  });

  await it("mixed container types: one deterministic charge per type", async () => {
    const { orderId } = await seedScenario({ products: [
      { id: "jug19", containerType: "jug", deposit: 30000, qty: 2 },
      { id: "crate", containerType: "crate", deposit: 10000, qty: 3 },
      { id: "straw", containerType: "", deposit: 0, qty: 9 } // no deposit → ignored
    ] });
    const res = await approveOrderImpl(orderId, "owner-uid");
    assert.strictEqual(res.chargesCreated, 2);
    const charges = await chargesFor(orderId);
    const byId = Object.fromEntries(charges.map((c) => [c.id, c]));
    assert.ok(byId[depositChargeId(orderId, "jug")]);
    assert.ok(byId[depositChargeId(orderId, "crate")]);
    assert.strictEqual(byId[depositChargeId(orderId, "jug")].amount, 60000);
    assert.strictEqual(byId[depositChargeId(orderId, "crate")].amount, 30000);
  });

  await it("retry: re-approving is idempotent — status stays, ledger unchanged", async () => {
    const { orderId } = await seedScenario();
    await approveOrderImpl(orderId, "owner-uid");
    const second = await approveOrderImpl(orderId, "owner-uid");
    assert.strictEqual(second.alreadyApproved, true);
    assert.strictEqual(second.status, "new");
    assert.strictEqual(second.chargesCreated, 0);
    assert.strictEqual((await chargesFor(orderId)).length, 1); // no duplicate
  });

  await it("parallel approval: two concurrent calls create exactly one charge set", async () => {
    const { orderId } = await seedScenario();
    const results = await Promise.allSettled([
      approveOrderImpl(orderId, "owner-uid"),
      approveOrderImpl(orderId, "owner-uid")
    ]);
    // Both should resolve (transaction serializes); one creates, one is a no-op.
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    assert.strictEqual(fulfilled.length, 2, results.map((r) => r.reason && r.reason.message).join(" | "));
    const created = fulfilled.reduce((n, r) => n + r.value.chargesCreated, 0);
    assert.strictEqual(created, 1, "exactly one charge created across both");
    assert.strictEqual((await chargesFor(orderId)).length, 1);
    assert.strictEqual((await db.doc(`orders/${orderId}`).get()).data().status, "new");
  });

  await it("partial failure rolls back: a different-sign-in customer aborts the whole approval", async () => {
    // order.customerId points at a doc owned by a DIFFERENT uid → the guard
    // throws mid-transaction; nothing must commit (order stays pending, no charge).
    const { orderId } = await seedScenario({
      authUid: "uid-me",
      customerId: "CUS-collision",
      seedCustomer: { id: "CUS-collision", data: { authUid: "someone-else", name: "Stranger" } }
    });
    await assertRejects(() => approveOrderImpl(orderId, "owner-uid"), "failed-precondition");
    const order = (await db.doc(`orders/${orderId}`).get()).data();
    assert.strictEqual(order.status, "pending_approval", "status must not change on abort");
    assert.strictEqual((await chargesFor(orderId)).length, 0, "no charge on abort");
    const stranger = (await db.doc("customers/CUS-collision").get()).data();
    assert.strictEqual(stranger.name, "Stranger", "stranger record untouched");
  });

  await it("status precondition: a cancelled order cannot be approved", async () => {
    const { orderId } = await seedScenario({ order: { status: "cancelled" } });
    await assertRejects(() => approveOrderImpl(orderId, "owner-uid"), "failed-precondition");
    assert.strictEqual((await chargesFor(orderId)).length, 0);
  });

  await it("missing order rejects and writes nothing", async () => {
    await assertRejects(() => approveOrderImpl("WEB-DOES-NOT-EXIST", "owner-uid"), "not-found");
  });

  await it("takeover gate: approval never stamps authUid onto an unclaimed doc it did not create", async () => {
    // order.customerId points at an UNCLAIMED doc (authUid null). canLink is
    // false (existing, not owned by this uid), so approval denormalizes profile
    // but must NOT stamp the order's authUid onto it.
    const { orderId } = await seedScenario({
      authUid: "uid-orderer",
      customerId: "CUS-unclaimed",
      seedCustomer: { id: "CUS-unclaimed", data: { authUid: null, name: "Pre-existing" } }
    });
    const res = await approveOrderImpl(orderId, "owner-uid");
    assert.strictEqual(res.status, "new");
    const doc = (await db.doc("customers/CUS-unclaimed").get()).data();
    assert.strictEqual(doc.authUid, null, "authUid must NOT be stamped onto an unclaimed doc");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

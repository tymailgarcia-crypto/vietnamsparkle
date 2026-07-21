"use strict";

// P0-08 — atomic delivery commit. Runs commitDeliveryImpl against the Firestore
// emulator with the Admin SDK. Covers the acceptance core: the fresh-status
// guard, holdings re-aggregation + clamp, parallel deliveries that must never
// drive a (customer, container) balance below zero, the transactional forfeit
// re-read + mandatory reason + deterministic id, and fulfilled-only pickup
// clearing.
//
// Run (Java is installed but not on PATH — see HANDOFF.md):
//   cd firebase
//   export JAVA_HOME="/c/Program Files/Eclipse Adoptium/jre-21.0.11.10-hotspot"
//   firebase emulators:exec --only firestore \
//     "cd functions && node commitDelivery.emulator.test.js"
//
// Read the emulator's stderr, not just the pass count.

process.env.NODE_ENV = "test";

const assert = require("node:assert");
const admin = require("firebase-admin");

admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || "demo-commit-delivery-emulator" });
const db = admin.firestore();

const { commitDeliveryImpl, forfeitEventId } = require("./index.js")._deliveryTestApi();

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
    return e;
  }
  throw new Error(`expected a rejection${code ? ` with code '${code}'` : ""}`);
}

let seq = 0;
// Seeds one order (out_for_delivery by default) and, optionally, a "charged"
// deposit event giving the customer a starting holding of `heldQty` of `type`.
async function seedOrder(over = {}) {
  seq += 1;
  const orderId = over.orderId || `WEB-DL-${String(seq).padStart(4, "0")}`;
  const authUid = over.authUid !== undefined ? over.authUid : `uid-${seq}`;
  const customerId = over.customerId !== undefined ? over.customerId : `CUS-${authUid}`;
  await db.doc(`orders/${orderId}`).set({
    status: over.status || "out_for_delivery",
    customerId,
    authUid,
    subtotal: over.subtotal !== undefined ? over.subtotal : 100000,
    depositTotal: over.depositTotal !== undefined ? over.depositTotal : 0,
    amountPaid: 0,
    balanceDue: 100000,
    paymentStatus: "unpaid"
  });
  if (customerId) await db.doc(`customers/${customerId}`).set({ authUid, name: "Test Customer" }, { merge: true });
  return { orderId, authUid, customerId };
}

// Seed a fresh customer holding qty of a container type via a single charge.
async function seedHolding(customerId, authUid, type, qty, perUnit) {
  await db.collection("depositEvents").add({
    customerId, authUid, containerType: type, qty, amount: qty * perUnit,
    eventType: "charged", eventDate: "2026-07-20", notes: "seed"
  });
}

// Net held qty for a (customer, type): charged minus everything that removes.
async function netHeld(customerId, type) {
  const snap = await db.collection("depositEvents").where("customerId", "==", customerId).get();
  let net = 0;
  snap.forEach((d) => {
    const e = d.data() || {};
    if (String(e.containerType || "other") !== type) return;
    const qty = Number(e.qty || 0);
    if (e.eventType === "charged") net += qty;
    else if (["refunded", "credited", "forfeited", "charge_reversed"].includes(e.eventType)) net -= qty;
  });
  return net;
}

(async () => {
  await it("happy path: credit return delivers order, writes deterministic ret event + deposit-credit payment", async () => {
    const { orderId, authUid, customerId } = await seedOrder();
    await seedHolding(customerId, authUid, "jug", 2, 30000);
    const res = await commitDeliveryImpl("owner-uid", {
      orderId,
      paymentId: `${orderId}-pay`,
      payment: { collected: true, amount: 40000, method: "cash" },
      returns: [{ type: "jug", returnedQty: 2, handling: "credit" }],
      returnProofDocumentId: "doc-1",
      overCreditChoice: "carry"
    });
    assert.strictEqual(res.status, "delivered");
    const order = (await db.doc(`orders/${orderId}`).get()).data();
    assert.strictEqual(order.status, "delivered");
    // total 100000; cash 40000 + credit 60000 = 100000 paid → balance 0.
    assert.strictEqual(order.amountPaid, 100000);
    assert.strictEqual(order.balanceDue, 0);
    assert.strictEqual(order.paymentStatus, "paid");
    const ret = (await db.doc(`depositEvents/${orderId}-ret-jug`).get()).data();
    assert.strictEqual(ret.qty, 2);
    assert.strictEqual(ret.eventType, "credited");
    const credit = (await db.doc(`payments/${orderId}-deposit-credit`).get()).data();
    assert.strictEqual(credit.amount, 60000);
    assert.strictEqual(await netHeld(customerId, "jug"), 0);
  });

  await it("status guard: an order not out_for_delivery is rejected, nothing written", async () => {
    const { orderId, authUid, customerId } = await seedOrder({ status: "assigned" });
    await seedHolding(customerId, authUid, "jug", 2, 30000);
    await assertRejects(() => commitDeliveryImpl("owner-uid", {
      orderId, paymentId: `${orderId}-pay`,
      payment: { collected: false, reason: "x", followUpBy: "2026-08-01" },
      returns: [{ type: "jug", returnedQty: 2, handling: "credit" }]
    }), "failed-precondition");
    assert.strictEqual((await db.doc(`orders/${orderId}`).get()).data().status, "assigned");
    assert.strictEqual((await db.doc(`depositEvents/${orderId}-ret-jug`).get()).exists, false);
  });

  await it("clamp: a return larger than fresh holdings is clamped, never goes negative", async () => {
    const { orderId, authUid, customerId } = await seedOrder();
    await seedHolding(customerId, authUid, "jug", 3, 30000);
    await commitDeliveryImpl("owner-uid", {
      orderId, paymentId: `${orderId}-pay`,
      payment: { collected: false, reason: "later", followUpBy: "2026-08-01" },
      returns: [{ type: "jug", returnedQty: 9, handling: "credit" }],
      returnProofDocumentId: "doc-2"
    });
    const ret = (await db.doc(`depositEvents/${orderId}-ret-jug`).get()).data();
    assert.strictEqual(ret.qty, 3, "clamped to held");
    assert.strictEqual(await netHeld(customerId, "jug"), 0);
  });

  await it("PARALLEL deliveries for one customer cannot drive a balance below zero", async () => {
    // One customer holds 5 jugs. Two DIFFERENT orders each try to take back 5.
    // Serialization on the customer doc means the second re-aggregates and
    // clamps to what's left, so net held never goes negative.
    seq += 1;
    const authUid = `uid-par-${seq}`;
    const customerId = `CUS-${authUid}`;
    const a = await seedOrder({ authUid, customerId, orderId: `WEB-PAR-A-${seq}` });
    const b = await seedOrder({ authUid, customerId, orderId: `WEB-PAR-B-${seq}` });
    await seedHolding(customerId, authUid, "jug", 5, 30000);
    const results = await Promise.allSettled([
      commitDeliveryImpl("owner-uid", { orderId: a.orderId, paymentId: `${a.orderId}-pay`, payment: { collected: false, reason: "x", followUpBy: "2026-08-01" }, returns: [{ type: "jug", returnedQty: 5, handling: "credit" }], returnProofDocumentId: "d" }),
      commitDeliveryImpl("owner-uid", { orderId: b.orderId, paymentId: `${b.orderId}-pay`, payment: { collected: false, reason: "x", followUpBy: "2026-08-01" }, returns: [{ type: "jug", returnedQty: 5, handling: "credit" }], returnProofDocumentId: "d" })
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    assert.strictEqual(fulfilled.length, 2, results.map((r) => r.reason && r.reason.message).join(" | "));
    const net = await netHeld(customerId, "jug");
    assert.ok(net >= 0, `net held must never be negative, got ${net}`);
    assert.strictEqual(net, 0, "exactly the 5 real empties came back");
  });

  await it("forfeit: requires a reason", async () => {
    const { orderId, authUid, customerId } = await seedOrder();
    await seedHolding(customerId, authUid, "jug", 2, 30000);
    await assertRejects(() => commitDeliveryImpl("owner-uid", {
      orderId, paymentId: `${orderId}-pay`,
      payment: { collected: false, reason: "x", followUpBy: "2026-08-01" },
      returns: [],
      lossReport: { lossType: "jug", lossQty: 1, lossNote: "   " }
    }), "invalid-argument");
    assert.strictEqual((await db.doc(`orders/${orderId}`).get()).data().status, "out_for_delivery");
  });

  await it("forfeit: re-reads current balance — cannot write off more than held; deterministic id", async () => {
    const { orderId, authUid, customerId } = await seedOrder();
    await seedHolding(customerId, authUid, "jug", 1, 30000);
    // Try to forfeit 4 when only 1 held → rejected.
    await assertRejects(() => commitDeliveryImpl("owner-uid", {
      orderId, paymentId: `${orderId}-pay`,
      payment: { collected: false, reason: "x", followUpBy: "2026-08-01" },
      returns: [], lossReport: { lossType: "jug", lossQty: 4, lossNote: "smashed" }
    }), "failed-precondition");
    // Forfeit the 1 → deterministic id, net 0.
    await commitDeliveryImpl("owner-uid", {
      orderId, paymentId: `${orderId}-pay`,
      payment: { collected: false, reason: "x", followUpBy: "2026-08-01" },
      returns: [], lossReport: { lossType: "jug", lossQty: 1, lossNote: "smashed" }
    });
    const forfeit = (await db.doc(`depositEvents/${forfeitEventId(orderId, "jug")}`).get()).data();
    assert.strictEqual(forfeit.eventType, "forfeited");
    assert.strictEqual(forfeit.qty, 1);
    assert.strictEqual(forfeit.notes, "smashed");
    assert.strictEqual(await netHeld(customerId, "jug"), 0);
  });

  await it("pickup flag clears only when a physical return was recorded", async () => {
    // Fulfilled: a return happened → flag cleared.
    const a = await seedOrder();
    await db.doc(`customers/${a.customerId}`).set({ emptiesPickupRequested: true, emptiesPickupRequestedAt: "2026-07-20" }, { merge: true });
    await seedHolding(a.customerId, a.authUid, "jug", 1, 30000);
    const resA = await commitDeliveryImpl("owner-uid", {
      orderId: a.orderId, paymentId: `${a.orderId}-pay`,
      payment: { collected: false, reason: "x", followUpBy: "2026-08-01" },
      returns: [{ type: "jug", returnedQty: 1, handling: "credit" }], returnProofDocumentId: "d"
    });
    assert.strictEqual(resA.pickupCleared, true);
    assert.strictEqual((await db.doc(`customers/${a.customerId}`).get()).data().emptiesPickupRequested, false);

    // Not fulfilled: no return → flag stays set (nags next time).
    const b = await seedOrder();
    await db.doc(`customers/${b.customerId}`).set({ emptiesPickupRequested: true, emptiesPickupRequestedAt: "2026-07-20" }, { merge: true });
    const resB = await commitDeliveryImpl("owner-uid", {
      orderId: b.orderId, paymentId: `${b.orderId}-pay`,
      payment: { collected: false, reason: "x", followUpBy: "2026-08-01" },
      returns: []
    });
    assert.strictEqual(resB.pickupCleared, false);
    assert.strictEqual((await db.doc(`customers/${b.customerId}`).get()).data().emptiesPickupRequested, true);
  });

  await it("P0-09: zero collected while a balance remains is rejected (deferred is the zero path)", async () => {
    const { orderId } = await seedOrder();
    await assertRejects(() => commitDeliveryImpl("owner-uid", {
      orderId, paymentId: `${orderId}-pay`,
      payment: { collected: true, amount: 0, method: "cash" }, returns: []
    }), "failed-precondition");
    const order = (await db.doc(`orders/${orderId}`).get()).data();
    assert.strictEqual(order.status, "out_for_delivery", "delivery did not close");
    assert.strictEqual((await db.doc(`payments/${orderId}-pay`).get()).exists, false);
  });

  await it("P0-09: zero collected on a fully prepaid order still delivers (nothing was due)", async () => {
    const { orderId } = await seedOrder();
    await db.doc(`orders/${orderId}`).update({ amountPaid: 100000, balanceDue: 0, paymentStatus: "paid" });
    const res = await commitDeliveryImpl("owner-uid", {
      orderId, paymentId: `${orderId}-pay`,
      payment: { collected: true, amount: 0, method: "cash" }, returns: []
    });
    assert.strictEqual(res.status, "delivered");
    assert.strictEqual(res.balanceDue, 0);
  });

  await it("P0-09: fractional VND is rejected, no silent rounding", async () => {
    const { orderId } = await seedOrder();
    await assertRejects(() => commitDeliveryImpl("owner-uid", {
      orderId, paymentId: `${orderId}-pay`,
      payment: { collected: true, amount: 99999.5, method: "cash" }, returns: []
    }), "invalid-argument");
    assert.strictEqual((await db.doc(`orders/${orderId}`).get()).data().status, "out_for_delivery");
  });

  await it("P0-09: cash overpay needs the exact acknowledged credit — rejected with the fresh excess in details", async () => {
    const { orderId } = await seedOrder();
    // Extra zero: 1 000 000 typed against 100 000 due.
    const err = await assertRejects(() => commitDeliveryImpl("owner-uid", {
      orderId, paymentId: `${orderId}-pay`,
      payment: { collected: true, amount: 1000000, method: "cash" }, returns: []
    }), "failed-precondition");
    assert.strictEqual(err.details && err.details.overpayment, true);
    assert.strictEqual(err.details.excessCash, 900000);
    assert.strictEqual(err.details.dueBefore, 100000);
    assert.strictEqual((await db.doc(`orders/${orderId}`).get()).data().status, "out_for_delivery", "nothing written");
    // Acknowledging the exact excess records it as customer credit.
    const res = await commitDeliveryImpl("owner-uid", {
      orderId, paymentId: `${orderId}-pay`,
      payment: { collected: true, amount: 1000000, method: "cash" }, returns: [],
      acknowledgeCashCredit: 900000
    });
    assert.strictEqual(res.status, "delivered");
    assert.strictEqual(res.balanceDue, -900000, "credit carried on the order");
    const order = (await db.doc(`orders/${orderId}`).get()).data();
    assert.strictEqual(order.paymentStatus, "paid");
  });

  await it("missing order rejects and writes nothing", async () => {
    await assertRejects(() => commitDeliveryImpl("owner-uid", {
      orderId: "WEB-NONE", paymentId: "p",
      payment: { collected: false, reason: "x", followUpBy: "2026-08-01" }, returns: []
    }), "not-found");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

"use strict";

// P0-09 — guarded payment entry. Runs recordPaymentImpl against the Firestore
// emulator with the Admin SDK. Covers the acceptance list: exact payment, zero
// (routed to the explicit deferred path), extra-zero overpayment needing an
// acknowledged credit, the stale dialog whose acknowledged number no longer
// matches the fresh balance, intentional credit, cancelled order, undelivered
// order — plus idempotent retry and whole-VND enforcement.
//
// Run (Java is installed but not on PATH — see HANDOFF.md):
//   cd firebase
//   export JAVA_HOME="/c/Program Files/Eclipse Adoptium/jre-21.0.11.10-hotspot"
//   firebase emulators:exec --only firestore \
//     "cd functions && node recordPayment.emulator.test.js"
//
// Read the emulator's stderr, not just the pass count.

process.env.NODE_ENV = "test";

const assert = require("node:assert");
const admin = require("firebase-admin");

admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || "demo-record-payment-emulator" });
const db = admin.firestore();

const { recordPaymentImpl } = require("./index.js")._recordPaymentTestApi();

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
// Seeds one delivered order with a 100 000 VND balance by default.
async function seedOrder(over = {}) {
  seq += 1;
  const orderId = over.orderId || `WEB-RP-${String(seq).padStart(4, "0")}`;
  const subtotal = over.subtotal !== undefined ? over.subtotal : 100000;
  const amountPaid = over.amountPaid !== undefined ? over.amountPaid : 0;
  await db.doc(`orders/${orderId}`).set({
    status: over.status || "delivered",
    customerId: `CUS-uid-${seq}`,
    authUid: `uid-${seq}`,
    subtotal,
    depositTotal: over.depositTotal !== undefined ? over.depositTotal : 0,
    amountPaid,
    balanceDue: subtotal + (over.depositTotal || 0) - amountPaid,
    paymentStatus: amountPaid > 0 ? "partial" : "unpaid"
  });
  return orderId;
}

(async () => {
  await it("exact payment settles the order and writes the payment doc", async () => {
    const orderId = await seedOrder();
    const res = await recordPaymentImpl("owner-uid", {
      orderId,
      paymentId: `${orderId}-pay`,
      payment: { collected: true, amount: 100000, method: "cash", reference: "till" }
    });
    assert.strictEqual(res.balanceDue, 0);
    assert.strictEqual(res.paymentStatus, "paid");
    const order = (await db.doc(`orders/${orderId}`).get()).data();
    assert.strictEqual(order.amountPaid, 100000);
    assert.strictEqual(order.balanceDue, 0);
    assert.strictEqual(order.paymentStatus, "paid");
    const pay = (await db.doc(`payments/${orderId}-pay`).get()).data();
    assert.strictEqual(pay.amount, 100000);
    assert.strictEqual(pay.deferred, false);
    assert.strictEqual(pay.receivedBy, "owner-uid");
  });

  await it("zero collected is rejected — the deferred path is the only zero path", async () => {
    const orderId = await seedOrder();
    await assertRejects(() => recordPaymentImpl("owner-uid", {
      orderId, paymentId: `${orderId}-pay`,
      payment: { collected: true, amount: 0, method: "cash" }
    }), "invalid-argument");
    assert.strictEqual((await db.doc(`payments/${orderId}-pay`).get()).exists, false);
    assert.strictEqual((await db.doc(`orders/${orderId}`).get()).data().amountPaid, 0);
  });

  await it("fractional VND is rejected", async () => {
    const orderId = await seedOrder();
    await assertRejects(() => recordPaymentImpl("owner-uid", {
      orderId, paymentId: `${orderId}-pay`,
      payment: { collected: true, amount: 99999.5, method: "cash" }
    }), "invalid-argument");
    assert.strictEqual((await db.doc(`payments/${orderId}-pay`).get()).exists, false);
  });

  await it("deferred path records the follow-up state without touching the money", async () => {
    const orderId = await seedOrder();
    const res = await recordPaymentImpl("owner-uid", {
      orderId,
      paymentId: `${orderId}-def`,
      payment: { collected: false, reason: "customer_said_next_time", followUpBy: "2026-08-01", notes: "will pay Friday" }
    });
    assert.strictEqual(res.balanceDue, 100000, "balance unchanged");
    const order = (await db.doc(`orders/${orderId}`).get()).data();
    assert.strictEqual(order.amountPaid, 0);
    assert.strictEqual(order.followUpBy, "2026-08-01");
    const pay = (await db.doc(`payments/${orderId}-def`).get()).data();
    assert.strictEqual(pay.amount, 0);
    assert.strictEqual(pay.deferred, true);
    assert.strictEqual(pay.deferralReason, "customer_said_next_time");
    assert.strictEqual(pay.followUpBy, "2026-08-01");
  });

  await it("deferred without a follow-up date is rejected", async () => {
    const orderId = await seedOrder();
    await assertRejects(() => recordPaymentImpl("owner-uid", {
      orderId, paymentId: `${orderId}-def`,
      payment: { collected: false, reason: "other" }
    }), "invalid-argument");
  });

  await it("extra zero (10x overpayment) without acknowledgement is rejected with the credit in details", async () => {
    const orderId = await seedOrder();
    const err = await assertRejects(() => recordPaymentImpl("owner-uid", {
      orderId, paymentId: `${orderId}-pay`,
      payment: { collected: true, amount: 1000000, method: "cash" }
    }), "failed-precondition");
    assert.strictEqual(err.details && err.details.overpayment, true);
    assert.strictEqual(err.details.resultingCredit, 900000);
    assert.strictEqual(err.details.freshBalance, 100000);
    assert.strictEqual((await db.doc(`payments/${orderId}-pay`).get()).exists, false, "nothing written");
  });

  await it("intentional credit: acknowledging the exact credit records the overpayment", async () => {
    const orderId = await seedOrder();
    const res = await recordPaymentImpl("owner-uid", {
      orderId, paymentId: `${orderId}-pay`,
      payment: { collected: true, amount: 150000, method: "transfer", reference: "QA-TXN-9" },
      acknowledgeCredit: 50000
    });
    assert.strictEqual(res.resultingCredit, 50000);
    const order = (await db.doc(`orders/${orderId}`).get()).data();
    assert.strictEqual(order.amountPaid, 150000);
    assert.strictEqual(order.balanceDue, -50000, "credit carried on the order");
    assert.strictEqual(order.paymentStatus, "paid");
  });

  await it("STALE DIALOG: an acknowledgement computed from an old balance is rejected with the fresh number", async () => {
    const orderId = await seedOrder();
    // Tab A settles 60 000 of the 100 000 while tab B's dialog is open.
    await recordPaymentImpl("owner-uid", {
      orderId, paymentId: `${orderId}-a`,
      payment: { collected: true, amount: 60000, method: "cash" }
    });
    // Tab B still believes the balance is 100 000 and records exactly that —
    // no overpay from where it stands, so no acknowledgement passed. Fresh
    // balance is 40 000, so the server rejects with the REAL credit (60 000).
    const err = await assertRejects(() => recordPaymentImpl("owner-uid", {
      orderId, paymentId: `${orderId}-b`,
      payment: { collected: true, amount: 100000, method: "cash" }
    }), "failed-precondition");
    assert.strictEqual(err.details.resultingCredit, 60000);
    assert.strictEqual(err.details.freshBalance, 40000);
    // Re-confirming with the fresh number goes through.
    const res = await recordPaymentImpl("owner-uid", {
      orderId, paymentId: `${orderId}-b`,
      payment: { collected: true, amount: 100000, method: "cash" },
      acknowledgeCredit: 60000
    });
    assert.strictEqual(res.balanceDue, -60000);
  });

  await it("cancelled orders reject payment, nothing written", async () => {
    const orderId = await seedOrder({ status: "cancelled" });
    const err = await assertRejects(() => recordPaymentImpl("owner-uid", {
      orderId, paymentId: `${orderId}-pay`,
      payment: { collected: true, amount: 100000, method: "cash" }
    }), "failed-precondition");
    assert.ok(/cancelled/.test(err.message), err.message);
    assert.strictEqual((await db.doc(`payments/${orderId}-pay`).get()).exists, false);
  });

  await it("undelivered orders reject payment — money is collected at the door", async () => {
    for (const status of ["pending_approval", "new", "assigned", "out_for_delivery"]) {
      const orderId = await seedOrder({ status });
      const err = await assertRejects(() => recordPaymentImpl("owner-uid", {
        orderId, paymentId: `${orderId}-pay`,
        payment: { collected: true, amount: 100000, method: "cash" }
      }), "failed-precondition");
      assert.ok(/not been delivered/.test(err.message), `${status}: ${err.message}`);
      assert.strictEqual((await db.doc(`payments/${orderId}-pay`).get()).exists, false, status);
    }
  });

  await it("idempotent retry: the same paymentId never double-counts", async () => {
    const orderId = await seedOrder();
    await recordPaymentImpl("owner-uid", {
      orderId, paymentId: `${orderId}-pay`,
      payment: { collected: true, amount: 100000, method: "cash" }
    });
    const res = await recordPaymentImpl("owner-uid", {
      orderId, paymentId: `${orderId}-pay`,
      payment: { collected: true, amount: 100000, method: "cash" }
    });
    assert.strictEqual(res.duplicate, true);
    const order = (await db.doc(`orders/${orderId}`).get()).data();
    assert.strictEqual(order.amountPaid, 100000, "not 200000");
    assert.strictEqual(order.balanceDue, 0);
  });

  await it("missing order rejects with not-found", async () => {
    await assertRejects(() => recordPaymentImpl("owner-uid", {
      orderId: "WEB-RP-NONE", paymentId: "p",
      payment: { collected: true, amount: 1000, method: "cash" }
    }), "not-found");
  });

  await it("evidence gate: a transfer with no reference and no proof is rejected, nothing written", async () => {
    const orderId = await seedOrder();
    const err = await assertRejects(() => recordPaymentImpl("owner-uid", {
      orderId, paymentId: `${orderId}-pay`,
      payment: { collected: true, amount: 100000, method: "transfer" }
    }), "invalid-argument");
    assert.ok(/reference number or a photo/.test(err.message), err.message);
    assert.strictEqual((await db.doc(`payments/${orderId}-pay`).get()).exists, false, "no payment written");
  });

  await it("evidence gate: a transfer with a reference goes through", async () => {
    const orderId = await seedOrder();
    const res = await recordPaymentImpl("owner-uid", {
      orderId, paymentId: `${orderId}-pay`,
      payment: { collected: true, amount: 100000, method: "transfer", reference: "TXN-7788" }
    });
    assert.strictEqual(res.balanceDue, 0);
    assert.strictEqual((await db.doc(`payments/${orderId}-pay`).get()).data().reference, "TXN-7788");
  });

  await it("evidence gate: a transfer with a proofDocumentId (no reference) goes through", async () => {
    const orderId = await seedOrder();
    const res = await recordPaymentImpl("owner-uid", {
      orderId, paymentId: `${orderId}-pay`,
      payment: { collected: true, amount: 100000, method: "transfer" },
      proofDocumentId: "doc-abc"
    });
    assert.strictEqual(res.balanceDue, 0);
  });

  await it("evidence gate: cash needs nothing", async () => {
    const orderId = await seedOrder();
    const res = await recordPaymentImpl("owner-uid", {
      orderId, paymentId: `${orderId}-pay`,
      payment: { collected: true, amount: 100000, method: "cash" }
    });
    assert.strictEqual(res.balanceDue, 0);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

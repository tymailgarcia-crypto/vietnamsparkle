// Firestore rules tests for /payments — the immutable financial ledger.
//
// Why this suite exists: an order's amountPaid/balanceDue is the running sum of
// these docs, and the nightly reconciler (functions/index.js) trusts that sum as
// truth. Before 2026-07-19 the rule allowed `update, delete: if isOwner()`, so a
// single mis-click or a future stray write could silently rewrite or erase a
// payment and shift the official balance with nothing to flag it — the reconciler
// would then "correct" the order to match the tampered payments and call it clean.
// The rule is now append-only (`update, delete: if false`). A correction is a NEW
// reversing payment (a negative-amount adjustment the owner may create), never an
// edit. This suite pins that shut. Same posture as /orderCorrections.
//
// The deterministic `${orderId}-deposit-credit` line in the delivery flow is only
// ever CREATED, never updated, because both delivery dialogs block a re-run once
// the order is delivered (orderApp.js + adminApp.js). Admin-SDK writers (the
// mergeCustomers re-key, the reconciler itself) bypass these rules entirely.
//
// Run with the emulator (Java is installed but not on PATH — see HANDOFF.md):
//   cd firebase
//   export JAVA_HOME="/c/Program Files/Eclipse Adoptium/jre-21.0.11.10-hotspot"
//   export FIRESTORE_EMULATOR_HOST="127.0.0.1:8080"
//   node rules-tests/payments.rules.test.mjs
//
// Read the emulator's stderr, not just the pass count. Every latent rules bug
// this codebase has found was reported as an evaluation error while the
// assertions still passed.
//
// KNOWN BENIGN stderr: driver-context denials print `evaluation error at
// L255:24 for 'create'` — L255 is the pre-existing driver `create` branch
// (`get(orders/…).assignedDriverId == myDriverId()`), NOT the append-only line
// this suite added (that logs a clean `false for 'update'/'delete' @ L272`).
// It is the same class as the accepted L193 customers residual (ROADMAP →
// "Bare field access … union"): the write still denies/allows correctly. If you
// harden the driver-create branch later, this warning should disappear; until
// then it is expected, not a regression from the payments append-only change.

import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds
} from "@firebase/rules-unit-testing";
import { readFileSync } from "node:fs";
import { doc, getDoc, setDoc, deleteDoc } from "firebase/firestore";

const PROJECT_ID = "vietnamsparkle-payments-test";

let passed = 0;
let failed = 0;

async function it(name, fn) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed += 1;
  } catch (error) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${error && error.message ? error.message.split("\n")[0] : error}`);
    failed += 1;
  }
}

const testEnv = await initializeTestEnvironment({
  projectId: PROJECT_ID,
  firestore: {
    rules: readFileSync("firestore.rules", "utf8"),
    host: "127.0.0.1",
    port: 8080
  }
});

// The shared emulator may already contain rows from a previous local run.
// Start clean so a create assertion cannot silently become an update assertion.
await testEnv.clearFirestore();

const owner = testEnv.authenticatedContext("owner-uid", { role: "owner" });
const driver = testEnv.authenticatedContext("driver-uid", { role: "driver", driverId: "DRV-1" });
// A customer token carries no `role` key at all — the shape that made isOwner()
// raise an evaluation error before 2026-07-15. See firestore.rules.
const customer = testEnv.authenticatedContext("customer-uid", { email: "c@example.test", email_verified: true });
const anon = testEnv.unauthenticatedContext();

const validPayment = {
  orderId: "ORD-1",
  customerId: "CUS-1",
  authUid: "customer-uid",
  paymentDate: "2026-07-19",
  method: "cash",
  amount: 100000,
  reference: null,
  receivedBy: "owner@example.test",
  deferred: false,
  createdAt: "2026-07-19T00:00:00.000Z"
};

async function seedPayment(id, data) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), "payments", id), data);
  });
}

async function seedOrder(id, data) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), "orders", id), data);
  });
}

// The driver-create rule does get(orders/{orderId}) and checks assignedDriverId.
await seedOrder("ORD-1", { assignedDriverId: "DRV-1", status: "out_for_delivery" });
await seedOrder("ORD-2", { assignedDriverId: "DRV-2", status: "out_for_delivery" });

console.log("\n/payments rules\n");

// --- Create paths (unchanged behaviour, pinned so a refactor can't loosen them) ---

await it("owner CAN create a payment", async () => {
  await assertSucceeds(setDoc(doc(owner.firestore(), "payments", "PAY-1"), validPayment));
});

// The correction path this append-only rule assumes: an owner reverses a mistake
// with a NEW negative-amount line, never by editing the original.
await it("owner CAN create a negative-amount reversing adjustment", async () => {
  await assertSucceeds(setDoc(doc(owner.firestore(), "payments", "PAY-ADJ-1"), {
    ...validPayment,
    amount: -50000,
    method: "adjustment",
    notes: "Reversal: deposit credit keyed twice on ORD-1"
  }));
});

await it("driver CAN create a payment for an order assigned to them", async () => {
  await assertSucceeds(setDoc(doc(driver.firestore(), "payments", "PAY-DRV-1"), { ...validPayment, orderId: "ORD-1" }));
});

await it("driver CANNOT create a payment for an order assigned to someone else", async () => {
  await assertFails(setDoc(doc(driver.firestore(), "payments", "PAY-DRV-2"), { ...validPayment, orderId: "ORD-2" }));
});

await it("driver CANNOT create a negative-amount payment (amount >= 0 required)", async () => {
  await assertFails(setDoc(doc(driver.firestore(), "payments", "PAY-DRV-3"), { ...validPayment, orderId: "ORD-1", amount: -1 }));
});

await it("customer CANNOT create a payment", async () => {
  await assertFails(setDoc(doc(customer.firestore(), "payments", "PAY-CUS-1"), validPayment));
});

await it("anonymous CANNOT create a payment", async () => {
  await assertFails(setDoc(doc(anon.firestore(), "payments", "PAY-ANON-1"), validPayment));
});

// --- Append-only: the whole point. If any of these pass, the ledger is forgeable. ---

await it("owner CANNOT update a payment (append-only)", async () => {
  await seedPayment("PAY-U-1", validPayment);
  await assertFails(setDoc(doc(owner.firestore(), "payments", "PAY-U-1"), { ...validPayment, amount: 1 }));
});

await it("owner CANNOT delete a payment (append-only)", async () => {
  await seedPayment("PAY-D-1", validPayment);
  await assertFails(deleteDoc(doc(owner.firestore(), "payments", "PAY-D-1")));
});

await it("driver CANNOT update a payment", async () => {
  await seedPayment("PAY-U-2", validPayment);
  await assertFails(setDoc(doc(driver.firestore(), "payments", "PAY-U-2"), { ...validPayment, amount: 1 }));
});

await it("driver CANNOT delete a payment", async () => {
  await seedPayment("PAY-D-2", validPayment);
  await assertFails(deleteDoc(doc(driver.firestore(), "payments", "PAY-D-2")));
});

await it("customer CANNOT update a payment", async () => {
  await seedPayment("PAY-U-3", validPayment);
  await assertFails(setDoc(doc(customer.firestore(), "payments", "PAY-U-3"), { ...validPayment, amount: 1 }));
});

await it("customer CANNOT delete a payment", async () => {
  await seedPayment("PAY-D-3", validPayment);
  await assertFails(deleteDoc(doc(customer.firestore(), "payments", "PAY-D-3")));
});

// --- Read scoping (unchanged; pinned alongside the create/update surface) ---

await it("owner CAN read any payment", async () => {
  await seedPayment("PAY-R-1", validPayment);
  await assertSucceeds(getDoc(doc(owner.firestore(), "payments", "PAY-R-1")));
});

await it("customer CAN read a payment whose authUid is theirs", async () => {
  await seedPayment("PAY-R-2", { ...validPayment, authUid: "customer-uid" });
  await assertSucceeds(getDoc(doc(customer.firestore(), "payments", "PAY-R-2")));
});

await it("customer CANNOT read a payment belonging to another customer", async () => {
  await seedPayment("PAY-R-3", { ...validPayment, authUid: "someone-else" });
  await assertFails(getDoc(doc(customer.firestore(), "payments", "PAY-R-3")));
});

await it("anonymous CANNOT read a payment", async () => {
  await seedPayment("PAY-R-4", validPayment);
  await assertFails(getDoc(doc(anon.firestore(), "payments", "PAY-R-4")));
});

console.log(`\n${passed} passed, ${failed} failed\n`);
await testEnv.cleanup();
process.exit(failed > 0 ? 1 : 0);

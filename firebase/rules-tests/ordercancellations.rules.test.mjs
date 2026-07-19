// Firestore rules tests for /orderCancellations — the cancellation & refund case
// ledger.
//
// Why this suite exists: a cancellation case owns the refund obligation and proof
// status for an order, and (for a full cancellation) it is the settlement source
// of truth because the reconciler skips cancelled orders. Every state transition
// runs in a Cloud Function on the Admin SDK, which bypasses these rules. So the
// only thing rules must guarantee is: NO client can write a case (server-only),
// and reads are scoped to owner + the customer whose authUid the case carries.
// If a client-write path ever opened, a customer could forge their own refund
// status or dismiss a cancellation decision. This suite pins that shut.
//
// See CANCELLATION-REFUND-PLAN.md for the case document shape.
//
// Run with the emulator (Java is installed but not on PATH — see HANDOFF.md):
//   cd firebase
//   export JAVA_HOME="/c/Program Files/Eclipse Adoptium/jre-21.0.11.10-hotspot"
//   firebase emulators:exec --only firestore \
//     "node rules-tests/ordercancellations.rules.test.mjs"
//
// Read the emulator's stderr, not just the pass count. Every latent rules bug
// this codebase has found was reported as an evaluation error while the
// assertions still passed.

import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds
} from "@firebase/rules-unit-testing";
import { readFileSync } from "node:fs";
import { doc, getDoc, setDoc, updateDoc, deleteDoc } from "firebase/firestore";

const PROJECT_ID = "vietnamsparkle-ordercancellations-test";

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
await testEnv.clearFirestore();

const owner = testEnv.authenticatedContext("owner-uid", { role: "owner" });
const driver = testEnv.authenticatedContext("driver-uid", { role: "driver", driverId: "DRV-1" });
// A customer token carries no `role` key at all — the shape that made isOwner()
// raise an evaluation error before 2026-07-15. See firestore.rules.
const customer = testEnv.authenticatedContext("customer-uid", { email: "c@example.test", email_verified: true });
const anon = testEnv.unauthenticatedContext();

// A representative approved partial-cancellation case with a pending refund.
const validCase = {
  orderId: "ORD-1",
  customerId: "CUS-1",
  authUid: "customer-uid",
  kind: "partial",
  decisionStatus: "approved",
  refundStatus: "pending",
  evidenceStatus: "not_required",
  reason: "Customer reduced order",
  refundRequired: 40000,
  refundRemaining: 40000,
  createdAt: "2026-07-19T00:00:00.000Z",
  updatedAt: "2026-07-19T00:00:00.000Z"
};

async function seedCase(id, data) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), "orderCancellations", id), data);
  });
}

console.log("\n/orderCancellations rules\n");

// --- Read scoping ---

await it("owner CAN read any case", async () => {
  await seedCase("CX-R-1", validCase);
  await assertSucceeds(getDoc(doc(owner.firestore(), "orderCancellations", "CX-R-1")));
});

await it("customer CAN read a case whose authUid is theirs", async () => {
  await seedCase("CX-R-2", { ...validCase, authUid: "customer-uid" });
  await assertSucceeds(getDoc(doc(customer.firestore(), "orderCancellations", "CX-R-2")));
});

await it("customer CANNOT read a case belonging to another customer", async () => {
  await seedCase("CX-R-3", { ...validCase, authUid: "someone-else" });
  await assertFails(getDoc(doc(customer.firestore(), "orderCancellations", "CX-R-3")));
});

await it("customer CANNOT read a guest case (authUid null)", async () => {
  await seedCase("CX-R-4", { ...validCase, authUid: null });
  await assertFails(getDoc(doc(customer.firestore(), "orderCancellations", "CX-R-4")));
});

// Drivers have no branch here — cancellation/refund is owner + owning-customer only.
await it("driver CANNOT read a case", async () => {
  await seedCase("CX-R-5", validCase);
  await assertFails(getDoc(doc(driver.firestore(), "orderCancellations", "CX-R-5")));
});

await it("anonymous CANNOT read a case", async () => {
  await seedCase("CX-R-6", validCase);
  await assertFails(getDoc(doc(anon.firestore(), "orderCancellations", "CX-R-6")));
});

// --- Server-only writes: the whole point. If any of these pass, a customer can
// forge their own refund status or reverse a cancellation decision. ---

await it("owner CANNOT create a case (server-only)", async () => {
  await assertFails(setDoc(doc(owner.firestore(), "orderCancellations", "CX-C-1"), validCase));
});

await it("owner CANNOT update a case (server-only)", async () => {
  await seedCase("CX-U-1", validCase);
  await assertFails(updateDoc(doc(owner.firestore(), "orderCancellations", "CX-U-1"), { refundStatus: "paid" }));
});

await it("owner CANNOT delete a case (server-only)", async () => {
  await seedCase("CX-D-1", validCase);
  await assertFails(deleteDoc(doc(owner.firestore(), "orderCancellations", "CX-D-1")));
});

await it("customer CANNOT create a case", async () => {
  await assertFails(setDoc(doc(customer.firestore(), "orderCancellations", "CX-C-2"), validCase));
});

// Even on their OWN case — a customer must not be able to mark their refund paid
// or flip an approved decision to dismissed.
await it("customer CANNOT update their own case", async () => {
  await seedCase("CX-U-2", { ...validCase, authUid: "customer-uid" });
  await assertFails(updateDoc(doc(customer.firestore(), "orderCancellations", "CX-U-2"), { refundStatus: "paid" }));
});

await it("customer CANNOT delete their own case", async () => {
  await seedCase("CX-D-2", { ...validCase, authUid: "customer-uid" });
  await assertFails(deleteDoc(doc(customer.firestore(), "orderCancellations", "CX-D-2")));
});

await it("anonymous CANNOT create a case", async () => {
  await assertFails(setDoc(doc(anon.firestore(), "orderCancellations", "CX-C-3"), validCase));
});

console.log(`\n${passed} passed, ${failed} failed\n`);
await testEnv.cleanup();
process.exit(failed > 0 ? 1 : 0);

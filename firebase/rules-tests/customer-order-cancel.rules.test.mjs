// Customer cancellation policy:
// - the owner may manage every cancellation workflow;
// - a customer may directly cancel only their own pending_approval order;
// - that direct cancellation records no reason/evidence/request documentation;
// - approved-order cancellation requests are not a client-write path.

import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { readFileSync } from "node:fs";
import { doc, setDoc, updateDoc } from "firebase/firestore";

const testEnv = await initializeTestEnvironment({
  projectId: "vietnamsparkle-customer-cancel-test",
  firestore: {
    rules: readFileSync("firestore.rules", "utf8"),
    host: "127.0.0.1",
    port: 8080
  }
});

await testEnv.clearFirestore();
const customer = testEnv.authenticatedContext("customer-uid", { email: "customer@example.test", email_verified: true });

async function seedOrder(id, over = {}) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), "orders", id), {
      authUid: "customer-uid",
      customerId: "CUS-1",
      status: "pending_approval",
      subtotal: 100000,
      depositTotal: 50000,
      amountPaid: 0,
      balanceDue: 150000,
      paymentStatus: "unpaid",
      updatedAt: "2026-07-20T00:00:00.000Z",
      ...over
    });
  });
}

let passed = 0;
let failed = 0;
async function it(name, fn) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed += 1;
  } catch (error) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${error?.message?.split("\n")[0] || error}`);
    failed += 1;
  }
}

console.log("\ncustomer order cancellation rules\n");

await it("customer CAN cancel their own pending_approval order without documentation", async () => {
  await seedOrder("ORD-PENDING");
  await assertSucceeds(updateDoc(doc(customer.firestore(), "orders", "ORD-PENDING"), {
    status: "cancelled",
    cancelledAt: "2026-07-20T01:00:00.000Z",
    cancelledBy: "customer",
    updatedAt: "2026-07-20T01:00:00.000Z"
  }));
});

await it("customer CANNOT attach a cancellation reason/documentation", async () => {
  await seedOrder("ORD-REASON");
  await assertFails(updateDoc(doc(customer.firestore(), "orders", "ORD-REASON"), {
    status: "cancelled",
    cancellationReason: "changed mind",
    cancelledAt: "2026-07-20T01:00:00.000Z",
    cancelledBy: "customer",
    updatedAt: "2026-07-20T01:00:00.000Z"
  }));
});

await it("customer CANNOT directly cancel an approved order", async () => {
  await seedOrder("ORD-APPROVED", { status: "new" });
  await assertFails(updateDoc(doc(customer.firestore(), "orders", "ORD-APPROVED"), {
    status: "cancelled",
    cancelledAt: "2026-07-20T01:00:00.000Z",
    cancelledBy: "customer",
    updatedAt: "2026-07-20T01:00:00.000Z"
  }));
});

await it("customer CANNOT request cancellation of an approved order", async () => {
  await seedOrder("ORD-REQUEST", { status: "new" });
  await assertFails(updateDoc(doc(customer.firestore(), "orders", "ORD-REQUEST"), {
    cancellationRequested: true,
    cancellationRequestedAt: "2026-07-20T01:00:00.000Z",
    updatedAt: "2026-07-20T01:00:00.000Z"
  }));
});

await it("customer CANNOT cancel another customer's pending order", async () => {
  await seedOrder("ORD-OTHER", { authUid: "other-uid" });
  await assertFails(updateDoc(doc(customer.firestore(), "orders", "ORD-OTHER"), {
    status: "cancelled",
    cancelledAt: "2026-07-20T01:00:00.000Z",
    cancelledBy: "customer",
    updatedAt: "2026-07-20T01:00:00.000Z"
  }));
});

await it("customer CANNOT alter order data while cancelling", async () => {
  await seedOrder("ORD-TAMPER");
  await assertFails(updateDoc(doc(customer.firestore(), "orders", "ORD-TAMPER"), {
    status: "cancelled",
    subtotal: 1,
    cancelledAt: "2026-07-20T01:00:00.000Z",
    cancelledBy: "customer",
    updatedAt: "2026-07-20T01:00:00.000Z"
  }));
});

await testEnv.cleanup();
console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exitCode = 1;

// Firestore rules tests for /orderItems read access — the reorder / order-detail
// customer path.
//
// Why this suite exists: the customer reorder flow (publicApp.js applyReorderById
// + loadOrderItemsForOrders) reads this collection to rebuild a past cart. The
// read rule requires `resource.data.authUid == myUid()`, and Firestore denies a
// list unless the QUERY proves every result satisfies the rule. The client used
// to query by `orderId` alone — which does NOT constrain authUid — so Firestore
// rejected it ("Property authUid is undefined on object. for 'list'") and reorder
// was silently broken for every customer. The fix is CLIENT-SIDE: the query now
// also filters `where("authUid","==",uid)` (two equality filters, no composite
// index). These tests pin that the constrained query SUCCEEDS while a query by
// orderId alone (or one claiming another uid) is DENIED — so a regression that
// drops the authUid filter is caught here instead of in production. The rule
// itself is unchanged.
//
// Run with the emulator (Java is installed but not on PATH — see HANDOFF.md):
//   cd firebase
//   export JAVA_HOME="/c/Program Files/Eclipse Adoptium/jre-21.0.11.10-hotspot"
//   node rules-tests/orderitems.rules.test.mjs
//
// Read the emulator's stderr, not just the pass count — a bare-field regression
// shows up there as an evaluation error even when a single-doc get still passes.

import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds
} from "@firebase/rules-unit-testing";
import { readFileSync } from "node:fs";
import { collection, doc, getDocs, query, setDoc, where } from "firebase/firestore";

const PROJECT_ID = "vietnamsparkle-orderitems-test";

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
await testEnv.clearFirestore();

const owner = testEnv.authenticatedContext("owner-uid", { role: "owner" });
const driver = testEnv.authenticatedContext("driver-uid", { role: "driver", driverId: "DRV-1" });
// A customer token carries no `role` key — the shape that used to make isOwner()
// itself raise an evaluation error before 2026-07-15.
const alice = testEnv.authenticatedContext("alice-uid", { email: "alice@example.test", email_verified: true });
const bob = testEnv.authenticatedContext("bob-uid", { email: "bob@example.test", email_verified: true });

async function seedItem(id, data) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), "orderItems", id), data);
  });
}

// Alice's order has two line items, both stamped with her authUid the way the
// real submitPublicOrder callable writes them.
await seedItem("ORD-A-i1", { orderId: "ORD-A", authUid: "alice-uid", productId: "P-1", productName: "Jug", quantity: 2, unitPrice: 50000, lineTotal: 100000 });
await seedItem("ORD-A-i2", { orderId: "ORD-A", authUid: "alice-uid", productId: "P-2", productName: "Crate", quantity: 1, unitPrice: 199000, lineTotal: 199000 });
// Bob's order.
await seedItem("ORD-B-i1", { orderId: "ORD-B", authUid: "bob-uid", productId: "P-1", productName: "Jug", quantity: 1, unitPrice: 50000, lineTotal: 50000 });
// A legacy item with NO authUid key at all — the exact shape the bare-field rule
// choked on. It must not make an otherwise-valid customer list error out.
await seedItem("ORD-C-i1", { orderId: "ORD-C", productId: "P-1", productName: "Jug", quantity: 1, unitPrice: 50000, lineTotal: 50000 });

// The FIXED reorder query: orderId AND authUid.
const itemsByOrderAndUid = (ctx, orderId, uid) =>
  getDocs(query(
    collection(ctx.firestore(), "orderItems"),
    where("orderId", "==", orderId),
    where("authUid", "==", uid)
  ));
// The OLD (broken) reorder query: orderId only.
const itemsByOrderOnly = (ctx, orderId) =>
  getDocs(query(collection(ctx.firestore(), "orderItems"), where("orderId", "==", orderId)));

console.log("\n/orderItems read rules\n");

// The regression pin: the fixed client query must SUCCEED for the customer's
// own order.
await it("customer CAN list their OWN order's items with (orderId + authUid) [fixed reorder query]", async () => {
  await assertSucceeds(itemsByOrderAndUid(alice, "ORD-A", "alice-uid"));
});

// The pin that documents WHY the client must constrain: dropping the authUid
// filter (the pre-fix query) is denied for a customer.
await it("customer CANNOT list by orderId ALONE (the pre-fix query — proves the constraint is required)", async () => {
  await assertFails(itemsByOrderOnly(alice, "ORD-A"));
});

await it("customer CANNOT list another customer's items by claiming their uid", async () => {
  await assertFails(itemsByOrderAndUid(bob, "ORD-A", "alice-uid"));
});

await it("customer querying their own uid against someone else's order gets nothing (allowed, empty)", async () => {
  // Constrained to bob-uid, so the rule is provable; it simply matches no docs.
  const snap = await assertSucceeds(itemsByOrderAndUid(bob, "ORD-A", "bob-uid"));
  if (snap.size !== 0) throw new Error(`expected 0 docs, got ${snap.size}`);
});

await it("owner CAN list any order's items unconstrained", async () => {
  await assertSucceeds(itemsByOrderOnly(owner, "ORD-A"));
  await assertSucceeds(itemsByOrderOnly(owner, "ORD-C"));
});

await it("driver CAN list order items unconstrained", async () => {
  await assertSucceeds(itemsByOrderOnly(driver, "ORD-A"));
});

await it("anonymous CANNOT list order items", async () => {
  const anon = testEnv.unauthenticatedContext();
  await assertFails(itemsByOrderAndUid(anon, "ORD-A", "alice-uid"));
});

console.log(`\n${passed} passed, ${failed} failed`);
await testEnv.cleanup();
process.exit(failed > 0 ? 1 : 0);

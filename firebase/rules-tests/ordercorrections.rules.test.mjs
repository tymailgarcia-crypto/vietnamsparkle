// Firestore rules tests for /orderCorrections — the append-only audit notes
// behind the timeline on /order.html.
//
// Why this suite exists: the collection shipped to production without a rule.
// `order.html` + `orderApp.js` went live reading `orderCorrections`, but the
// matching rule block sat uncommitted on one disk and was never deployed.
// Firestore default-denies any unmatched path, and because `loadOrderRecord`
// fans its seven reads out through a single `Promise.all`, that one denial
// rejected the whole page — every order rendered as "Order unavailable /
// Missing or insufficient permissions" for the owner. Deployed 2026-07-16.
//
// Run with the emulator (Java is installed but not on PATH — see HANDOFF.md):
//   cd firebase
//   export JAVA_HOME="/c/Program Files/Eclipse Adoptium/jre-21.0.11.10-hotspot"
//   export FIRESTORE_EMULATOR_HOST="127.0.0.1:8080"
//   node rules-tests/ordercorrections.rules.test.mjs
//
// Read the emulator's stderr, not just the pass count. Every latent rules bug
// this codebase has found was reported as an evaluation error while the
// assertions still passed.
//
// Missing-field cases must fail cleanly without evaluation errors. The rule
// uses `.get(key, default)` for optional-map access; if stderr reports a missing
// property while this suite still passes, treat that as a regression rather
// than accepting a deny produced by a rules-runtime exception.

import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds
} from "@firebase/rules-unit-testing";
import { readFileSync } from "node:fs";
import { doc, getDoc, setDoc, deleteDoc, collection, getDocs, query, where } from "firebase/firestore";

const PROJECT_ID = "vietnamsparkle-ordercorrections-test";

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

const validNote = {
  orderId: "WEB-1",
  category: "correction",
  note: "Driver recorded the wrong container count on delivery.",
  createdByUid: "owner-uid",
  createdByEmail: "owner@example.test"
};

async function seed(id, data) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), "orderCorrections", id), data);
  });
}

console.log("\n/orderCorrections rules\n");

// The regression the page actually hit: this read is what `loadOrderRecord`
// issues, and it was denied in production.
await it("owner CAN query corrections by orderId (the read order.html makes)", async () => {
  await seed("OC-1", validNote);
  await assertSucceeds(
    getDocs(query(collection(owner.firestore(), "orderCorrections"), where("orderId", "==", "WEB-1")))
  );
});

await it("owner CAN read a correction doc directly", async () => {
  await seed("OC-2", validNote);
  await assertSucceeds(getDoc(doc(owner.firestore(), "orderCorrections", "OC-2")));
});

await it("owner CAN append a valid correction", async () => {
  await assertSucceeds(setDoc(doc(owner.firestore(), "orderCorrections", "OC-3"), validNote));
});

// Append-only is the whole point: a correction explains a historical record
// without rewriting it. If these two ever pass, the audit trail is forgeable.
await it("owner CANNOT update a correction (append-only)", async () => {
  await seed("OC-4", validNote);
  await assertFails(setDoc(doc(owner.firestore(), "orderCorrections", "OC-4"), { ...validNote, note: "rewritten after the fact" }));
});

await it("owner CANNOT delete a correction (append-only)", async () => {
  await seed("OC-5", validNote);
  await assertFails(deleteDoc(doc(owner.firestore(), "orderCorrections", "OC-5")));
});

await it("note shorter than 10 chars is rejected", async () => {
  await assertFails(setDoc(doc(owner.firestore(), "orderCorrections", "OC-6"), { ...validNote, note: "typo" }));
});

await it("note longer than 2000 chars is rejected", async () => {
  await assertFails(setDoc(doc(owner.firestore(), "orderCorrections", "OC-7"), { ...validNote, note: "x".repeat(2001) }));
});

await it("missing orderId is rejected", async () => {
  const { orderId, ...noOrderId } = validNote;
  await assertFails(setDoc(doc(owner.firestore(), "orderCorrections", "OC-8"), noOrderId));
});

await it("non-string orderId is rejected", async () => {
  await assertFails(setDoc(doc(owner.firestore(), "orderCorrections", "OC-9"), { ...validNote, orderId: 42 }));
});

await it("missing note is rejected", async () => {
  const { note, ...noNote } = validNote;
  await assertFails(setDoc(doc(owner.firestore(), "orderCorrections", "OC-10"), noNote));
});

// These corrections quote customer/order detail and are owner-authored audit
// notes. Nobody but the owner sees them.
await it("customer CANNOT read corrections", async () => {
  await seed("OC-11", validNote);
  await assertFails(getDoc(doc(customer.firestore(), "orderCorrections", "OC-11")));
});

await it("driver CANNOT read corrections", async () => {
  await seed("OC-12", validNote);
  await assertFails(getDoc(doc(driver.firestore(), "orderCorrections", "OC-12")));
});

await it("anonymous CANNOT read corrections", async () => {
  await seed("OC-13", validNote);
  await assertFails(getDoc(doc(anon.firestore(), "orderCorrections", "OC-13")));
});

await it("customer CANNOT append a correction", async () => {
  await assertFails(setDoc(doc(customer.firestore(), "orderCorrections", "OC-14"), validNote));
});

await it("driver CANNOT append a correction", async () => {
  await assertFails(setDoc(doc(driver.firestore(), "orderCorrections", "OC-15"), validNote));
});

await it("anonymous CANNOT append a correction", async () => {
  await assertFails(setDoc(doc(anon.firestore(), "orderCorrections", "OC-16"), validNote));
});

console.log(`\n${passed} passed, ${failed} failed\n`);
await testEnv.cleanup();
process.exit(failed > 0 ? 1 : 0);

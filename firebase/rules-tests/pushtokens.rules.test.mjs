// Firestore rules tests for /pushTokens — FCM web-push registration tokens for
// owner phone alerts (order / overdue / reconciliation / refund).
//
// Why this suite exists: these tokens are the address the Cloud Function pushes
// to. The collection is owner-only in every direction, and a create/update must
// carry ownerUid == the caller so a token can only ever be filed under its own
// owner. Nothing sensitive lives here (an FCM token + device metadata), but a
// stray write path would let another signed-in user register a device to receive
// the owner's operational alerts, so the boundary is pinned shut.
//
// Run with the emulator (Java is installed but not on PATH — see HANDOFF.md):
//   cd firebase
//   export JAVA_HOME="/c/Program Files/Eclipse Adoptium/jre-21.0.11.10-hotspot"
//   export FIRESTORE_EMULATOR_HOST="127.0.0.1:8080"
//   node rules-tests/pushtokens.rules.test.mjs
//
// Read the emulator's stderr, not just the pass count.

import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds
} from "@firebase/rules-unit-testing";
import { readFileSync } from "node:fs";
import { doc, getDoc, setDoc, deleteDoc } from "firebase/firestore";

const PROJECT_ID = "vietnamsparkle-pushtokens-test";

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
// A customer token carries no `role` key at all.
const customer = testEnv.authenticatedContext("customer-uid", { email: "c@example.test", email_verified: true });
const driver = testEnv.authenticatedContext("driver-uid", { role: "driver", driverId: "DRV-1" });
const anon = testEnv.unauthenticatedContext();

const tokenDoc = {
  token: "fcm-token-abc123",
  ownerUid: "owner-uid",
  platform: "iPhone",
  userAgent: "Mozilla/5.0 (iPhone)",
  createdAt: "2026-07-22T00:00:00.000Z",
  updatedAt: "2026-07-22T00:00:00.000Z"
};

async function seedToken(id, data) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), "pushTokens", id), data);
  });
}

console.log("\n/pushTokens rules\n");

// --- Owner: full control over their own tokens ---

await it("owner CAN create a token filed under their own uid", async () => {
  await assertSucceeds(setDoc(doc(owner.firestore(), "pushTokens", "fcm-token-abc123"), tokenDoc));
});

await it("owner CANNOT create a token filed under someone else's uid", async () => {
  await assertFails(setDoc(doc(owner.firestore(), "pushTokens", "fcm-token-spoof"),
    { ...tokenDoc, ownerUid: "someone-else" }));
});

await it("owner CANNOT create a token with no ownerUid (clean deny, not a raise)", async () => {
  const { ownerUid, ...noOwner } = tokenDoc;
  await assertFails(setDoc(doc(owner.firestore(), "pushTokens", "fcm-token-noowner"), noOwner));
});

await it("owner CAN refresh (update) their own token", async () => {
  await seedToken("fcm-token-upd", tokenDoc);
  await assertSucceeds(setDoc(doc(owner.firestore(), "pushTokens", "fcm-token-upd"),
    { ...tokenDoc, updatedAt: "2026-07-23T00:00:00.000Z" }));
});

await it("owner CAN read tokens", async () => {
  await seedToken("fcm-token-read", tokenDoc);
  await assertSucceeds(getDoc(doc(owner.firestore(), "pushTokens", "fcm-token-read")));
});

await it("owner CAN delete their token (turn off on a device)", async () => {
  await seedToken("fcm-token-del", tokenDoc);
  await assertSucceeds(deleteDoc(doc(owner.firestore(), "pushTokens", "fcm-token-del")));
});

// --- Everyone else: no read, no write ---

await it("customer CANNOT create a token", async () => {
  await assertFails(setDoc(doc(customer.firestore(), "pushTokens", "fcm-token-cus"),
    { ...tokenDoc, ownerUid: "customer-uid" }));
});

await it("customer CANNOT read a token", async () => {
  await seedToken("fcm-token-read2", tokenDoc);
  await assertFails(getDoc(doc(customer.firestore(), "pushTokens", "fcm-token-read2")));
});

await it("driver CANNOT create a token", async () => {
  await assertFails(setDoc(doc(driver.firestore(), "pushTokens", "fcm-token-drv"),
    { ...tokenDoc, ownerUid: "driver-uid" }));
});

await it("driver CANNOT read a token", async () => {
  await seedToken("fcm-token-read3", tokenDoc);
  await assertFails(getDoc(doc(driver.firestore(), "pushTokens", "fcm-token-read3")));
});

await it("anonymous CANNOT create a token", async () => {
  await assertFails(setDoc(doc(anon.firestore(), "pushTokens", "fcm-token-anon"), tokenDoc));
});

await it("anonymous CANNOT read a token", async () => {
  await seedToken("fcm-token-read4", tokenDoc);
  await assertFails(getDoc(doc(anon.firestore(), "pushTokens", "fcm-token-read4")));
});

console.log(`\n${passed} passed, ${failed} failed\n`);
await testEnv.cleanup();
process.exit(failed > 0 ? 1 : 0);

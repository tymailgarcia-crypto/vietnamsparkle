// Firestore rules tests for the legacy /inquiries collection.
//
// There is no current browser writer for this collection. Public ordering uses
// the submitPublicOrder callable; the retired inquiry flow writes to Sheets;
// imports and merge maintenance use Admin SDK and bypass Firestore rules. The
// correct client rule is therefore owner-readable legacy data with NO client
// create path, rather than a shape-validated unauthenticated spam endpoint.
//
// Run from firebase/ while the Firestore emulator is on 127.0.0.1:8080.

import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds
} from "@firebase/rules-unit-testing";
import { readFileSync } from "node:fs";
import { deleteDoc, doc, getDoc, setDoc, updateDoc } from "firebase/firestore";

const PROJECT_ID = "vietnamsparkle-inquiries-test";

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
const customer = testEnv.authenticatedContext("customer-uid", {
  email: "customer@example.test",
  email_verified: true
});
const anon = testEnv.unauthenticatedContext();

const validLegacyInquiry = {
  name: "Legacy lead",
  phone: "0901234567",
  requestStatus: "new",
  preferredChannel: "whatsapp",
  notes: "Imported from the retired inquiry sheet"
};

async function seed(id = "INQ-LEGACY") {
  // Models Admin import/maintenance: privileged server writes still work even
  // though every browser/client create is denied.
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), "inquiries", id), validLegacyInquiry);
  });
}

console.log("\n/inquiries rules\n");

await it("anonymous client CANNOT create a valid-shaped inquiry", async () => {
  await assertFails(setDoc(doc(anon.firestore(), "inquiries", "INQ-ANON"), validLegacyInquiry));
});

await it("customer client CANNOT create an inquiry", async () => {
  await assertFails(setDoc(doc(customer.firestore(), "inquiries", "INQ-CUSTOMER"), validLegacyInquiry));
});

await it("driver client CANNOT create an inquiry", async () => {
  await assertFails(setDoc(doc(driver.firestore(), "inquiries", "INQ-DRIVER"), validLegacyInquiry));
});

await it("owner client CANNOT create an inquiry (Admin import only)", async () => {
  await assertFails(setDoc(doc(owner.firestore(), "inquiries", "INQ-OWNER"), validLegacyInquiry));
});

await it("Admin-style privileged context CAN seed legacy inquiry data", async () => {
  await seed();
  await assertSucceeds(getDoc(doc(owner.firestore(), "inquiries", "INQ-LEGACY")));
});

await it("owner CAN update an existing legacy inquiry", async () => {
  await assertSucceeds(updateDoc(doc(owner.firestore(), "inquiries", "INQ-LEGACY"), {
    requestStatus: "resolved"
  }));
});

await it("non-owner CANNOT read an existing legacy inquiry", async () => {
  await assertFails(getDoc(doc(customer.firestore(), "inquiries", "INQ-LEGACY")));
});

await it("owner CAN delete an existing legacy inquiry", async () => {
  await assertSucceeds(deleteDoc(doc(owner.firestore(), "inquiries", "INQ-LEGACY")));
});

console.log(`\n${passed} passed, ${failed} failed\n`);
await testEnv.cleanup();
process.exit(failed > 0 ? 1 : 0);

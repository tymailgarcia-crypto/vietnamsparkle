// Firestore rules tests for the customers collection.
//
// Run with the emulator:
//   cd firebase
//   npx firebase emulators:exec --only firestore "node rules-tests/customers.rules.test.mjs"
//
// Covers the 2026-07-15 hardening:
//   - unverified email cannot read or claim an unclaimed profile
//   - customers cannot squat a phone-keyed doc id
//   - customers cannot touch merge tombstones or spoof email on their own doc
// ...and asserts the legitimate flows those rules must not break.

import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds
} from "@firebase/rules-unit-testing";
import { readFileSync } from "node:fs";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  updateDoc,
  where
} from "firebase/firestore";

const PROJECT_ID = "vietnamsparkle-rules-test";
const VICTIM_EMAIL = "victim@example.test";
const ATTACKER_UID = "attacker-uid";
const VICTIM_UID = "victim-uid";
const LEGACY_CUSTOMER_ID = "CUS-84901234567";
const MISSING_AUTH_CUSTOMER_ID = "CUS-84902222222";
const MISSING_EMAIL_CUSTOMER_ID = "CUS-84903333333";

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

// Auth contexts. `email_verified` is the whole point of these tests.
const verifiedVictim = testEnv.authenticatedContext(VICTIM_UID, {
  email: VICTIM_EMAIL,
  email_verified: true
});
const unverifiedAttacker = testEnv.authenticatedContext(ATTACKER_UID, {
  email: VICTIM_EMAIL, // attacker registered with the victim's address
  email_verified: false
});
const verifiedAttacker = testEnv.authenticatedContext(ATTACKER_UID, {
  email: "attacker@example.test",
  email_verified: true
});
const owner = testEnv.authenticatedContext("owner-uid", {
  email: "owner@example.test",
  email_verified: true,
  role: "owner"
});
const driver = testEnv.authenticatedContext("driver-uid", {
  email: "driver@example.test",
  email_verified: true,
  role: "driver",
  driverId: "DRV-1"
});
// A token with no `role` claim at all — the shape every real customer sign-in
// produces, and the one that made isOwner()/isDriver() raise an evaluation
// error before they were switched to .get().
const roleless = testEnv.authenticatedContext("roleless-uid", {
  email: "roleless@example.test",
  email_verified: true
});

async function seedLegacyProfile() {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), "customers", LEGACY_CUSTOMER_ID), {
      name: "Legacy Victim",
      email: VICTIM_EMAIL,
      phone: "0901234567",
      authUid: null,
      orderCount: 12
    });
  });
}

async function seedProfileWithoutAuthUid() {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), "customers", MISSING_AUTH_CUSTOMER_ID), {
      name: "Imported Without Auth Field",
      email: "attacker@example.test",
      phone: "0902222222",
      orderCount: 3
    });
  });
}

async function seedProfileWithoutEmail() {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), "customers", MISSING_EMAIL_CUSTOMER_ID), {
      name: "Imported Without Email Field",
      phone: "0903333333",
      authUid: null,
      orderCount: 2
    });
  });
}

console.log("\ncustomers rules\n");

// --- The account-takeover the audit flagged -------------------------------

await testEnv.clearFirestore();
await seedLegacyProfile();

await it("unverified email CANNOT read an unclaimed profile (takeover blocked)", async () => {
  await assertFails(
    getDoc(doc(unverifiedAttacker.firestore(), "customers", LEGACY_CUSTOMER_ID))
  );
});

await it("unverified email CANNOT claim an unclaimed profile (takeover blocked)", async () => {
  await assertFails(
    updateDoc(doc(unverifiedAttacker.firestore(), "customers", LEGACY_CUSTOMER_ID), {
      authUid: ATTACKER_UID,
      updatedAt: "2026-07-15T00:00:00Z"
    })
  );
});

await it("verified owner of the email CAN read their unclaimed profile", async () => {
  await assertSucceeds(
    getDoc(doc(verifiedVictim.firestore(), "customers", LEGACY_CUSTOMER_ID))
  );
});

await it("verified email query CAN find an explicitly unclaimed profile", async () => {
  const snap = await assertSucceeds(
    getDocs(query(
      collection(verifiedVictim.firestore(), "customers"),
      where("email", "==", VICTIM_EMAIL),
      where("authUid", "==", null)
    ))
  );
  if (snap.size !== 1 || snap.docs[0].id !== LEGACY_CUSTOMER_ID) {
    throw new Error("findUnclaimedByEmail query did not return the legacy profile");
  }
});

await it("verified owner of the email CAN claim their unclaimed profile", async () => {
  await assertSucceeds(
    updateDoc(doc(verifiedVictim.firestore(), "customers", LEGACY_CUSTOMER_ID), {
      authUid: VICTIM_UID,
      updatedAt: "2026-07-15T00:00:00Z"
    })
  );
});

await it("verified but WRONG email cannot read someone else's unclaimed profile", async () => {
  await testEnv.clearFirestore();
  await seedLegacyProfile();
  await assertFails(
    getDoc(doc(verifiedAttacker.firestore(), "customers", LEGACY_CUSTOMER_ID))
  );
});

// --- Missing import fields fail cleanly without widening claim access ------

await testEnv.clearFirestore();
await seedProfileWithoutAuthUid();

await it("matching verified email CANNOT read a profile whose authUid field is missing", async () => {
  await assertFails(
    getDoc(doc(verifiedAttacker.firestore(), "customers", MISSING_AUTH_CUSTOMER_ID))
  );
});

await it("matching verified email CANNOT claim a profile whose authUid field is missing", async () => {
  await assertFails(
    updateDoc(doc(verifiedAttacker.firestore(), "customers", MISSING_AUTH_CUSTOMER_ID), {
      authUid: ATTACKER_UID,
      updatedAt: "2026-07-16T00:00:00Z"
    })
  );
});

await testEnv.clearFirestore();
await seedProfileWithoutEmail();

await it("verified customer CANNOT claim an unclaimed profile whose email field is missing", async () => {
  await assertFails(
    updateDoc(doc(verifiedAttacker.firestore(), "customers", MISSING_EMAIL_CUSTOMER_ID), {
      authUid: ATTACKER_UID,
      updatedAt: "2026-07-16T00:00:00Z"
    })
  );
});

// --- Id squatting ----------------------------------------------------------

await testEnv.clearFirestore();

await it("customer CANNOT squat a phone-keyed doc id", async () => {
  await assertFails(
    setDoc(doc(verifiedAttacker.firestore(), "customers", "CUS-84909999999"), {
      name: "Squatter",
      authUid: ATTACKER_UID,
      email: "attacker@example.test"
    })
  );
});

await it("customer CAN create their own uid-keyed stub (createFreshCustomer)", async () => {
  await assertSucceeds(
    setDoc(doc(verifiedAttacker.firestore(), "customers", `CUS-${ATTACKER_UID}`), {
      name: "Legit Signup",
      email: "attacker@example.test",
      phone: "",
      address: "",
      authUid: ATTACKER_UID,
      orderCount: 0
    })
  );
});

await it("customer CANNOT create a stub carrying someone else's email", async () => {
  await assertFails(
    setDoc(doc(verifiedAttacker.firestore(), "customers", `CUS-${ATTACKER_UID}`), {
      name: "Spoofer",
      email: VICTIM_EMAIL,
      authUid: ATTACKER_UID
    })
  );
});

await it("customer CANNOT create a stub pre-seeded as a merge tombstone", async () => {
  await assertFails(
    setDoc(doc(verifiedAttacker.firestore(), "customers", `CUS-${ATTACKER_UID}`), {
      name: "Tombstone",
      authUid: ATTACKER_UID,
      email: null,
      archived: true,
      mergedInto: LEGACY_CUSTOMER_ID
    })
  );
});

// --- Self-update constraints ----------------------------------------------

await testEnv.clearFirestore();
await testEnv.withSecurityRulesDisabled(async (ctx) => {
  await setDoc(doc(ctx.firestore(), "customers", `CUS-${ATTACKER_UID}`), {
    name: "Own Doc",
    email: "attacker@example.test",
    phone: "0900000000",
    authUid: ATTACKER_UID
  });
});

await it("customer CAN edit their own profile fields (handleSaveProfile)", async () => {
  await assertSucceeds(
    updateDoc(doc(verifiedAttacker.firestore(), "customers", `CUS-${ATTACKER_UID}`), {
      name: "New Name",
      phone: "0911111111",
      email: "attacker@example.test",
      authUid: ATTACKER_UID,
      updatedAt: "2026-07-15T00:00:00Z"
    })
  );
});

await it("customer CANNOT spoof a victim's email onto their own doc", async () => {
  await assertFails(
    updateDoc(doc(verifiedAttacker.firestore(), "customers", `CUS-${ATTACKER_UID}`), {
      email: VICTIM_EMAIL
    })
  );
});

await it("customer CANNOT archive/tombstone their own doc", async () => {
  await assertFails(
    updateDoc(doc(verifiedAttacker.firestore(), "customers", `CUS-${ATTACKER_UID}`), {
      archived: true,
      mergedInto: LEGACY_CUSTOMER_ID
    })
  );
});

await it("customer CANNOT reassign their doc to another uid", async () => {
  await assertFails(
    updateDoc(doc(verifiedAttacker.firestore(), "customers", `CUS-${ATTACKER_UID}`), {
      authUid: VICTIM_UID
    })
  );
});

await testEnv.clearFirestore();
await testEnv.withSecurityRulesDisabled(async (ctx) => {
  await setDoc(doc(ctx.firestore(), "customers", `CUS-${ATTACKER_UID}`), {
    name: "Own Imported Doc",
    phone: "0900000000",
    authUid: ATTACKER_UID
  });
});

await it("customer CAN update their own imported profile when email is absent", async () => {
  await assertSucceeds(
    updateDoc(doc(verifiedAttacker.firestore(), "customers", `CUS-${ATTACKER_UID}`), {
      name: "Own Imported Doc Updated",
      updatedAt: "2026-07-16T00:00:00Z"
    })
  );
});

// --- Owner still has room to work -----------------------------------------

await it("owner CAN create a phone-keyed customer (customersApp add-customer)", async () => {
  await assertSucceeds(
    setDoc(doc(owner.firestore(), "customers", "CUS-84905555555"), {
      name: "Owner Added",
      phone: "0905555555",
      email: null,
      authUid: null,
      orderCount: 0
    })
  );
});

await it("owner CAN archive a doc during merge (mergeCustomers writes as admin, but UI reads back)", async () => {
  await assertSucceeds(
    updateDoc(doc(owner.firestore(), "customers", "CUS-84905555555"), {
      archived: true,
      mergedInto: LEGACY_CUSTOMER_ID
    })
  );
});

// --- Role helpers still resolve correctly after the .get() switch ----------

await testEnv.clearFirestore();
await seedLegacyProfile();

await it("driver CAN still read customer docs (isDriver intact)", async () => {
  await assertSucceeds(
    getDoc(doc(driver.firestore(), "customers", LEGACY_CUSTOMER_ID))
  );
});

await it("driver CANNOT write customer docs", async () => {
  await assertFails(
    updateDoc(doc(driver.firestore(), "customers", LEGACY_CUSTOMER_ID), {
      name: "Driver Edited"
    })
  );
});

await it("owner CAN read any customer doc (isOwner intact)", async () => {
  await assertSucceeds(
    getDoc(doc(owner.firestore(), "customers", LEGACY_CUSTOMER_ID))
  );
});

await it("role-less token is treated as a customer, not an owner", async () => {
  // If isOwner() ever returned true for a token without a role claim, this
  // write would succeed and every customer would be an admin.
  await assertFails(
    updateDoc(doc(roleless.firestore(), "customers", LEGACY_CUSTOMER_ID), {
      name: "Escalated",
      orderCount: 999
    })
  );
});

await testEnv.cleanup();

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);

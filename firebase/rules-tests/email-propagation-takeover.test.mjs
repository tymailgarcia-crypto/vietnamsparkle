// FOCUSED REPRO — suspected account-takeover via order-email propagation.
//
// Run from firebase/ while the Firestore emulator is on 127.0.0.1:8080:
//   export JAVA_HOME="/c/Program Files/Eclipse Adoptium/jre-21.0.11.10-hotspot"
//   npx firebase emulators:exec --only firestore \
//     "node rules-tests/email-propagation-takeover.test.mjs"
//
// The 2026-07-15 Critical fix closed ONE takeover key: it stopped
// upsertCustomerFromOrder from stamping the orderer's authUid onto a
// pre-existing doc (canLinkAuthUidToCustomer). But adminApp.js:303 still runs
//
//     if (order.email) payload.email = order.email;   // setDoc(..., {merge:true})
//
// UNGATED, as the OWNER, at order approval. order.email is the signed-in
// orderer's verified token email (submitPublicOrder: email: authEmail || ...).
// So a signed-in attacker who quotes a victim's phone gets the owner's routine
// approval to plant the attacker's email onto the victim's unclaimed doc — and
// then claims it through the intended verified-email path. Same outcome as the
// 2026-07-15 takeover, reopened through the `email` key instead of `authUid`.
//
// Firestore rules cannot stop the PLANT (owner writes anything). This test
// therefore reproduces the plant with an owner-authenticated write — exactly
// what line 303 did — and asserts the CLAIM that follows. The control shows
// the plant is the one and only thing that unlocks the takeover.
//
// STATUS: FIXED 2026-07-17 in upsertCustomerFromOrder (adminApp.js) — the
// email write is now gated by canLinkAuthUidToCustomer, so an attacker order
// quoting a victim's phone no longer plants the attacker's email. These four
// assertions STILL pass: they exercise the RULES layer directly (owner plant +
// intended email-match claim), which is unchanged and correct. They remain as
// the standing proof of WHY the guard must live in client code — the rules
// alone cannot distinguish a planted email from a legitimately stored one, so
// preventing the plant is the only defence. Pinned by the source-level checks
// in authuid-linking.test.mjs.

import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds
} from "@firebase/rules-unit-testing";
import { readFileSync } from "node:fs";
import { collection, doc, getDocs, query, setDoc, updateDoc, where } from "firebase/firestore";

const PROJECT_ID = "vietnamsparkle-email-takeover-test";
const VICTIM_ID = "CUS-84900001111"; // victim's phone-keyed canonical doc
const VICTIM_EMAIL = "victim@real.test";
const ATTACKER_UID = "attacker-uid";
const ATTACKER_EMAIL = "attacker@evil.test";

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

// The owner who routinely approves orders. In production this is the account
// running adminApp.js; here it just needs the owner claim.
const owner = testEnv.authenticatedContext("owner-uid", {
  email: "owner@example.test",
  email_verified: true,
  role: "owner"
});
// The attacker: a normal signed-in customer (Google → verified email, no role).
const attacker = testEnv.authenticatedContext(ATTACKER_UID, {
  email: ATTACKER_EMAIL,
  email_verified: true
});

// Seed the victim: a real customer who has NEVER signed in (authUid null),
// carrying their OWN real email — an imported/owner-created record, i.e. the
// most valuable takeover target.
async function seedVictim() {
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), "customers", VICTIM_ID), {
      name: "Real Victim",
      email: VICTIM_EMAIL,
      phone: "84900001111",
      authUid: null,
      orderCount: 40
    });
  });
}

const claimWrite = (ctx) => updateDoc(doc(ctx.firestore(), "customers", VICTIM_ID), {
  authUid: ATTACKER_UID,
  updatedAt: new Date().toISOString()
});

console.log("\nemail-propagation takeover");

await it("BASELINE: attacker CANNOT claim the victim doc while it holds the victim's own email", async () => {
  await seedVictim();
  await assertFails(claimWrite(attacker));
});

await it("PLANT: owner approval CAN write the orderer's email onto the victim doc (this is adminApp.js:303)", async () => {
  await seedVictim();
  await assertSucceeds(setDoc(
    doc(owner.firestore(), "customers", VICTIM_ID),
    { email: ATTACKER_EMAIL },
    { merge: true }
  ));
});

await it("QUERY: after the plant, findUnclaimedByEmail(attacker email) returns the victim doc", async () => {
  await seedVictim();
  await setDoc(doc(owner.firestore(), "customers", VICTIM_ID), { email: ATTACKER_EMAIL }, { merge: true });
  const snap = await getDocs(query(
    collection(attacker.firestore(), "customers"),
    where("email", "==", ATTACKER_EMAIL),
    where("authUid", "==", null)
  ));
  if (snap.empty || !snap.docs.some((d) => d.id === VICTIM_ID)) {
    throw new Error("attacker's email query did not surface the victim doc");
  }
});

await it("TAKEOVER: after the plant, the attacker CAN claim the victim doc — profile + order history transfer", async () => {
  await seedVictim();
  await setDoc(doc(owner.firestore(), "customers", VICTIM_ID), { email: ATTACKER_EMAIL }, { merge: true });
  await assertSucceeds(claimWrite(attacker));
});

await testEnv.cleanup();

console.log(`\n${passed} passed, ${failed} failed`);
console.log(
  failed === 0
    ? "\n>>> CONFIRMED: the plant (adminApp.js:303) is the only thing between attacker and victim's account."
    : "\n>>> NOT reproduced as expected — inspect above before concluding."
);
process.exit(passed === 4 && failed === 0 ? 0 : 1);

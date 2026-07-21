"use strict";

// P0-04 — `resolveSignedInCustomerId` against the Firestore emulator. The pure
// pick is covered by customerIdentity.test.mjs; this proves the query half:
// resolution reads the customer linked to the auth uid and ignores the phone.
// The three P0-04 scenarios (one-digit typo, existing-number collision,
// legitimate phone change) all reduce to "identity follows the uid, not the
// phone", exercised here end-to-end.
//
// Run (Java is installed but not on PATH — see HANDOFF.md):
//   cd firebase
//   export JAVA_HOME="/c/Program Files/Eclipse Adoptium/jre-21.0.11.10-hotspot"
//   firebase emulators:exec --only firestore \
//     "cd functions && node customerIdentity.emulator.test.js"
//
// Read the emulator's stderr, not just the pass count.

process.env.NODE_ENV = "test";

const assert = require("node:assert");
const admin = require("firebase-admin");

admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || "demo-customer-identity-emulator" });
const db = admin.firestore();

const { resolveSignedInCustomerId } = require("./index.js")._customerIdentityTestApi();

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

async function setCustomer(id, data) {
  await db.doc(`customers/${id}`).set(data);
}

(async () => {
  await it("resolves to the doc linked by auth uid, regardless of the order's phone", async () => {
    // Customer U's canonical record is the phone-keyed doc, linked to their uid.
    await setCustomer("CUS-84905123456", { authUid: "uid-u", phone: "+84905123456", name: "Real U" });
    // Even if a later order carried a mistyped phone, resolution uses the uid.
    assert.strictEqual(await resolveSignedInCustomerId("uid-u"), "CUS-84905123456");
  });

  await it("one-digit typo: identity is unchanged because it follows the uid", async () => {
    // Same U, same linked doc. The order phone could be +84905123457 (typo) or
    // anything — resolveSignedInCustomerId never reads it, so U stays U.
    assert.strictEqual(await resolveSignedInCustomerId("uid-u"), "CUS-84905123456");
  });

  await it("no linked doc yet → the uid-derived id (never a phone doc)", async () => {
    assert.strictEqual(await resolveSignedInCustomerId("uid-fresh"), "CUS-uid-fresh");
  });

  await it("existing-number collision: U's order resolves to U's own doc, not the stranger's", async () => {
    // Stranger X owns the phone-keyed doc for +84900000001.
    await setCustomer("CUS-84900000001", { authUid: "uid-x", phone: "+84900000001", name: "Stranger X", orderCount: 42 });
    // Customer U is a different uid with their own uid-keyed stub, and quotes
    // X's phone on an order. Resolution returns U's doc; X is never addressed.
    await setCustomer("CUS-uid-u2", { authUid: "uid-u2", phone: "", name: "Customer U2" });
    const resolved = await resolveSignedInCustomerId("uid-u2");
    assert.strictEqual(resolved, "CUS-uid-u2");
    assert.notStrictEqual(resolved, "CUS-84900000001");
    // And X's record is still intact and untouched.
    const x = (await db.doc("customers/CUS-84900000001").get()).data();
    assert.strictEqual(x.name, "Stranger X");
    assert.strictEqual(x.orderCount, 42);
  });

  await it("legitimate phone change keeps the same customer id", async () => {
    await setCustomer("CUS-uid-mover", { authUid: "uid-mover", phone: "+84905000000", name: "Mover" });
    const before = await resolveSignedInCustomerId("uid-mover");
    // Customer edits their phone in the profile — updates the attribute in place.
    await db.doc("customers/CUS-uid-mover").set({ phone: "+84905999999" }, { merge: true });
    const after = await resolveSignedInCustomerId("uid-mover");
    assert.strictEqual(before, after, "a phone change must not change identity");
    assert.strictEqual(after, "CUS-uid-mover");
  });

  await it("an archived (merged-away) doc that kept its uid is skipped", async () => {
    // mergeCustomers normally clears authUid off the source; if a stray archived
    // doc still carried it, resolution must not return the tombstone.
    await setCustomer("CUS-stale-tomb", { authUid: "uid-lonely", archived: true, name: "Tombstone" });
    assert.strictEqual(await resolveSignedInCustomerId("uid-lonely"), "CUS-uid-lonely");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

// P0-04 — signed-in customer identity is anchored to the auth uid, not the
// typed phone. Pure + source checks, no emulator. Run:
//   cd firebase/functions
//   node customerIdentity.test.mjs
//
// Two halves:
//  1. The server's pure `pickSignedInCustomerId` decision (from index.js).
//  2. Source-level guards on the client approval path in adminApp.js — that
//     file loads the Firebase web SDK at import, so (like authuid-linking) it
//     is checked by regex rather than imported. These pin that a future edit
//     can't quietly re-key approval off the phone or drop the collision guard.
//
// The account-takeover truth table stays in authuid-linking.test.mjs; run both.

import assert from "node:assert";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

process.env.NODE_ENV = "test"; // exposes _customerIdentityTestApi in index.js

const require = createRequire(import.meta.url);
const { pickSignedInCustomerId } = require("./index.js")._customerIdentityTestApi();

let passed = 0;
let failed = 0;
function it(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed += 1;
  } catch (err) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err && err.message ? err.message.split("\n")[0] : err}`);
    failed += 1;
  }
}

console.log("\npickSignedInCustomerId (server)\n");

it("a live doc linked to this uid IS the customer's id (the typed phone is irrelevant)", () => {
  // Customer U is already linked to the canonical phone-keyed doc. A later order
  // whose phone was mistyped changes nothing — resolution never looks at phone.
  assert.strictEqual(
    pickSignedInCustomerId("uid-u", [{ id: "CUS-84905123456", archived: false }]),
    "CUS-84905123456"
  );
});

it("no linked doc yet → the uid-derived id, never a phone-keyed one", () => {
  assert.strictEqual(pickSignedInCustomerId("uid-u", []), "CUS-uid-u");
  assert.strictEqual(pickSignedInCustomerId("uid-u", null), "CUS-uid-u");
});

it("an archived (merged-away) doc is skipped in favour of the uid id", () => {
  assert.strictEqual(
    pickSignedInCustomerId("uid-u", [{ id: "CUS-old", archived: true }]),
    "CUS-uid-u"
  );
});

it("a live doc wins over an archived one for the same uid", () => {
  assert.strictEqual(
    pickSignedInCustomerId("uid-u", [
      { id: "CUS-archived", archived: true },
      { id: "CUS-live", archived: false }
    ]),
    "CUS-live"
  );
});

it("existing-number collision: U's order never resolves to a stranger's phone doc", () => {
  // The stranger X owns CUS-84900000001. U (a different uid) quotes X's phone.
  // U's linked docs do NOT include X's doc, so resolution returns U's own id —
  // X's record is never even addressed, let alone overwritten.
  const uLinkedDocs = [{ id: "CUS-uid-u", archived: false }];
  const resolved = pickSignedInCustomerId("uid-u", uLinkedDocs);
  assert.strictEqual(resolved, "CUS-uid-u");
  assert.notStrictEqual(resolved, "CUS-84900000001");
});

// BOTH owner approval paths must key on the uid, not the phone: the dashboard
// (adminApp.js) and the order-detail page (orderApp.js) each carry their own
// copy of upsertCustomerFromOrder/approveOrder.
function expectSource(name, cond) {
  it(name, () => assert.ok(cond));
}
for (const file of ["adminApp.js", "orderApp.js"]) {
  console.log(`\n${file} approval routing (source)\n`);
  const src = readFileSync(new URL(`../web/assets/${file}`, import.meta.url), "utf8");
  expectSource(
    "upsertCustomerFromOrder keys on order.customerId (uid-anchored), not the phone",
    /const customerId = order\.customerId\s*\n?\s*\|\|/.test(src)
  );
  expectSource(
    "the old phone-derived primary key is gone",
    !/const customerId = buildCustomerId\(order\.phone\);/.test(src)
  );
  expectSource(
    "a different-sign-in doc is never overwritten (belt-and-braces guard present)",
    /belongs to a different sign-in/.test(src)
  );
  expectSource(
    "approveOrder blocks + explains a phone collision with another customer",
    /already belongs to a different customer/.test(src)
  );
  // Preserve the takeover gate in this copy too (authuid-linking pins adminApp
  // only; orderApp carries an unpinned duplicate).
  expectSource(
    "authUid write stays gated by canLinkAuthUid",
    /if \(canLinkAuthUid\) payload\.authUid = order\.authUid;/.test(src)
  );
  expectSource(
    "email write stays gated by canLinkAuthUid",
    /if \(order\.email && canLinkAuthUid\) payload\.email = order\.email;/.test(src)
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

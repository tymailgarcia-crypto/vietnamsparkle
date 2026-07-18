// Truth table for canLinkAuthUidToCustomer (adminApp.js).
//
// Run: node rules-tests/authuid-linking.test.mjs
//
// This predicate decides whether the owner's approve action stamps an order's
// authUid onto the phone-keyed customer doc. Firestore rules CANNOT guard it —
// the owner performs the write and owners may write anything — so this pure
// function is the only thing standing between a stranger and someone else's
// order history. Hence a test.
//
// Since 2026-07-17 the SAME predicate also gates the email write in
// upsertCustomerFromOrder — planting the orderer's email onto an unproven doc
// was a second takeover key (see email-propagation-takeover.test.mjs). The
// source-level checks at the bottom pin that both writes stay behind it.
//
// Imported by regex rather than by `import` because adminApp.js pulls in the
// Firebase web SDK at module load, which needs a browser.

import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../web/assets/adminApp.js", import.meta.url), "utf8");
const match = src.match(
  /export function canLinkAuthUidToCustomer\(order, existingData\) \{([\s\S]*?)\n\}/
);
if (!match) {
  console.error("FAIL  could not locate canLinkAuthUidToCustomer in adminApp.js");
  process.exit(1);
}
const canLinkAuthUidToCustomer = new Function("order", "existingData", match[1]);

let passed = 0;
let failed = 0;

function expect(name, actual, want) {
  if (actual === want) {
    console.log(`  PASS  ${name}`);
    passed += 1;
  } else {
    console.log(`  FAIL  ${name} — expected ${want}, got ${actual}`);
    failed += 1;
  }
}

console.log("\ncanLinkAuthUidToCustomer\n");

// The attack this exists to block.
expect(
  "attacker quoting a stranger's phone is NOT linked to their record",
  canLinkAuthUidToCustomer(
    { authUid: "attacker-uid", phone: "0901234567" },
    { authUid: null, name: "Real Victim", orderCount: 50 }
  ),
  false
);

expect(
  "unclaimed doc is never auto-claimed, even with no history",
  canLinkAuthUidToCustomer({ authUid: "u1" }, { authUid: null }),
  false
);

// Legitimate flows that must keep working.
expect(
  "brand-new doc for a signed-in customer IS linked",
  canLinkAuthUidToCustomer({ authUid: "u1" }, null),
  true
);

expect(
  "doc already owned by the same uid stays linked",
  canLinkAuthUidToCustomer({ authUid: "u1" }, { authUid: "u1" }),
  true
);

// Guards that already existed and must not regress.
expect(
  "doc owned by someone else is never re-stamped",
  canLinkAuthUidToCustomer({ authUid: "u1" }, { authUid: "u2" }),
  false
);

expect(
  "anonymous order links nothing to a new doc",
  canLinkAuthUidToCustomer({ authUid: null }, null),
  false
);

expect(
  "anonymous order links nothing to an existing doc",
  canLinkAuthUidToCustomer({ authUid: null }, { authUid: null }),
  false
);

expect(
  "empty-string authUid is falsy, links nothing",
  canLinkAuthUidToCustomer({ authUid: "" }, null),
  false
);

// --- Source-level guards: both authUid and email must stay gated -----------
//
// The truth table above proves the PREDICATE is correct. These prove
// upsertCustomerFromOrder actually routes both sensitive writes through it,
// so a future edit can't silently reintroduce the unguarded `payload.email`.

console.log("\nupsertCustomerFromOrder write gating (source)\n");

function expectSource(name, cond) {
  expect(name, !!cond, true);
}

expectSource(
  "authUid write is gated by canLinkAuthUid",
  /if \(canLinkAuthUid\) payload\.authUid = order\.authUid;/.test(src)
);
expectSource(
  "email write is gated by canLinkAuthUid (not the bare `if (order.email)`)",
  /if \(order\.email && canLinkAuthUid\) payload\.email = order\.email;/.test(src)
);
expectSource(
  "the unguarded email write is gone",
  !/if \(order\.email\) payload\.email = order\.email;/.test(src)
);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);

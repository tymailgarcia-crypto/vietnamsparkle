// Truth table for canLinkAuthUidToCustomer — the account-takeover gate.
//
// Run: node rules-tests/authuid-linking.test.mjs
//
// This predicate decides whether approving an order stamps the order's authUid
// (and verified email) onto the customer doc. Firestore rules CANNOT guard it —
// approval is an owner action and owners may write anything — so this pure
// function is the only thing standing between a stranger and someone else's
// order history. Hence a test.
//
// RELOCATED 2026-07-21 (P0-06): approval moved from the client into the server
// callable `approveOrder` (functions/index.js), so the gate and both gated
// writes moved with it. This test now pins the SERVER copy. The security
// property is unchanged — only its home. The client `upsertCustomerFromOrder`
// that this used to read no longer exists; do not restore it.
//
// Since 2026-07-17 the SAME predicate also gates the email write — planting the
// orderer's email onto an unproven doc was a second takeover key (see
// email-propagation-takeover.test.mjs). The source-level checks pin that both
// writes stay behind it.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

process.env.NODE_ENV = "test"; // exposes _approvalTestApi in index.js

const require = createRequire(import.meta.url);
const { canLinkAuthUidToCustomer } = require("../functions/index.js")._approvalTestApi();

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

console.log("\ncanLinkAuthUidToCustomer (server: functions/index.js)\n");

// The attack this exists to block: an attacker signed in as `attacker-uid`
// quotes a stranger's phone; the stranger's doc is unclaimed (authUid null).
expect(
  "attacker quoting a stranger's phone is NOT linked to their record",
  canLinkAuthUidToCustomer("attacker-uid", { authUid: null, name: "Real Victim", orderCount: 50 }),
  false
);

expect(
  "unclaimed doc is never auto-claimed, even with no history",
  canLinkAuthUidToCustomer("u1", { authUid: null }),
  false
);

// Legitimate flows that must keep working.
expect(
  "brand-new doc for a signed-in customer IS linked",
  canLinkAuthUidToCustomer("u1", null),
  true
);

expect(
  "doc already owned by the same uid stays linked",
  canLinkAuthUidToCustomer("u1", { authUid: "u1" }),
  true
);

// Guards that already existed and must not regress.
expect(
  "doc owned by someone else is never re-stamped",
  canLinkAuthUidToCustomer("u1", { authUid: "u2" }),
  false
);

expect(
  "anonymous order links nothing to a new doc",
  canLinkAuthUidToCustomer(null, null),
  false
);

expect(
  "anonymous order links nothing to an existing doc",
  canLinkAuthUidToCustomer(null, { authUid: null }),
  false
);

expect(
  "empty-string authUid is falsy, links nothing",
  canLinkAuthUidToCustomer("", null),
  false
);

// --- Source-level guards: both authUid and email must stay gated -----------
//
// The truth table proves the PREDICATE is correct. These prove approveOrderImpl
// actually routes both sensitive writes through it, so a future edit can't
// silently reintroduce an unguarded email/authUid stamp.

console.log("\napproveOrderImpl write gating (source: functions/index.js)\n");

const src = readFileSync(new URL("../functions/index.js", import.meta.url), "utf8");
function expectSource(name, cond) {
  expect(name, !!cond, true);
}

expectSource(
  "authUid write is gated by canLink",
  /if \(canLink\) customerPatch\.authUid = order\.authUid;/.test(src)
);
expectSource(
  "email write is gated by canLink (not a bare `if (order.email)`)",
  /if \(order\.email && canLink\) customerPatch\.email = order\.email;/.test(src)
);
expectSource(
  "there is no ungated customerPatch.email = order.email write",
  !/(^|\n)\s*customerPatch\.email = order\.email;/.test(
    // strip the one gated occurrence, then look for any remaining bare write
    src.replace(/if \(order\.email && canLink\) customerPatch\.email = order\.email;/g, "")
  )
);
expectSource(
  "there is no ungated customerPatch.authUid = order.authUid write",
  !/(^|\n)\s*customerPatch\.authUid = order\.authUid;/.test(
    src.replace(/if \(canLink\) customerPatch\.authUid = order\.authUid;/g, "")
  )
);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);

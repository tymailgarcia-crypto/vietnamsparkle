// P0-09 — collected-payment validation. Pure, no emulator. Run:
//   cd firebase/functions
//   node paymentEntry.parity.test.mjs
//
// Two jobs, same shape as deliveryValidation.parity.test.mjs:
//  1. PARITY. collectedPaymentProblem is defined in web/assets/shared.js
//     (client) and mirrored in functions/index.js (server, CommonJS — can't
//     import the ESM module). If the two drift, a dialog accepts an amount the
//     server rejects, or worse the other way round. These tests run BOTH copies
//     over a battery of inputs and assert identical answers.
//  2. BEHAVIOR. The P0-09 acceptance semantics: negative and fractional always
//     rejected, zero rejected exactly when a balance remains, positive whole
//     VND always accepted (overpayment is the transaction's own acknowledged
//     gate, deliberately NOT this helper's job).

import assert from "node:assert";
import { createRequire } from "node:module";

process.env.NODE_ENV = "test"; // exposes _recordPaymentTestApi in index.js

import { collectedPaymentProblem as clientProblem } from "../web/assets/shared.js";

const require = createRequire(import.meta.url);
const serverProblem = require("./index.js")._recordPaymentTestApi().collectedPaymentProblem;

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

// --- Parity across a battery of inputs -------------------------------------

it("client and server agree on every (amount, balanceRemaining) sample", () => {
  const amounts = [-100000, -1, -0.5, 0, 0.5, 1, 999.99, 1000, 100000, 1000000, NaN, Infinity, -Infinity, "abc", "1000", null, undefined];
  const balances = [0, 1, 40000, 100000, -5000];
  for (const amount of amounts) {
    for (const balance of balances) {
      assert.strictEqual(
        clientProblem(amount, balance),
        serverProblem(amount, balance),
        `drift at amount=${String(amount)} balance=${String(balance)}`
      );
    }
  }
});

// --- Behavior (P0-09 acceptance) -------------------------------------------

it("negative is always rejected", () => {
  assert.ok(clientProblem(-1, 0));
  assert.ok(clientProblem(-1, 100000));
});

it("fractional VND is always rejected", () => {
  assert.ok(clientProblem(1000.5, 0));
  assert.ok(clientProblem(1000.5, 100000));
});

it("non-numeric input is rejected", () => {
  assert.ok(clientProblem(NaN, 100000));
  assert.ok(clientProblem("abc", 100000));
  assert.ok(clientProblem(Infinity, 100000));
});

it("zero is rejected exactly when a balance remains", () => {
  assert.ok(clientProblem(0, 100000), "balance remains → zero routed to the deferred path");
  assert.strictEqual(clientProblem(0, 0), null, "nothing due → delivering a prepaid order collects 0");
  assert.strictEqual(clientProblem(0, -5000), null, "in credit → nothing due either");
});

it("positive whole VND is accepted; overpayment is NOT this helper's job", () => {
  assert.strictEqual(clientProblem(100000, 100000), null);
  assert.strictEqual(clientProblem(1000000, 100000), null, "over the balance still passes here — the transaction's acknowledged-credit gate owns that");
  assert.strictEqual(clientProblem(1, 100000), null);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

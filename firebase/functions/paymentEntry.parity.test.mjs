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

import {
  collectedPaymentProblem as clientProblem,
  paymentEvidenceProblem as clientEvidence,
  refundEvidenceProblem as clientRefundEvidence
} from "../web/assets/shared.js";

const require = createRequire(import.meta.url);
const _api = require("./index.js")._recordPaymentTestApi();
const serverProblem = _api.collectedPaymentProblem;
const serverEvidence = _api.paymentEvidenceProblem;
const serverRefundEvidence = _api.refundEvidenceProblem;

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

// --- Evidence-per-method: parity ------------------------------------------

it("payment evidence: client and server agree across every sample", () => {
  const methods = ["cash", "transfer", "bank_qr", "other", "", "deferred", undefined];
  const references = ["", "   ", "ABC123", null, undefined];
  const proofs = [true, false, undefined];
  const amounts = [0, -1, 1, 100000, NaN, "1000", null];
  for (const method of methods) {
    for (const reference of references) {
      for (const hasProof of proofs) {
        for (const amount of amounts) {
          const args = { method, reference, hasProof, amount };
          assert.strictEqual(
            clientEvidence(args),
            serverEvidence(args),
            `drift at ${JSON.stringify(args)}`
          );
        }
      }
    }
  }
});

it("refund evidence: client and server agree across every sample", () => {
  const methods = ["refund_bank", "refund_qr", "refund_wallet", "refund_cash", "", "other", undefined];
  const references = ["", "  ", "TXN-9", null, undefined];
  for (const method of methods) {
    for (const reference of references) {
      const args = { method, reference };
      assert.strictEqual(
        clientRefundEvidence(args),
        serverRefundEvidence(args),
        `drift at ${JSON.stringify(args)}`
      );
    }
  }
});

// --- Evidence-per-method: behavior ----------------------------------------

it("cash and 'other' never need payment evidence", () => {
  assert.strictEqual(clientEvidence({ method: "cash", amount: 100000 }), null);
  assert.strictEqual(clientEvidence({ method: "other", amount: 100000 }), null);
});

it("transfer/QR need a reference OR a photo when money moved", () => {
  assert.ok(clientEvidence({ method: "transfer", amount: 100000 }), "no ref, no photo → blocked");
  assert.ok(clientEvidence({ method: "bank_qr", amount: 100000 }), "no ref, no photo → blocked");
  assert.strictEqual(clientEvidence({ method: "transfer", amount: 100000, reference: "TXN1" }), null, "reference satisfies it");
  assert.strictEqual(clientEvidence({ method: "transfer", amount: 100000, hasProof: true }), null, "a photo satisfies it");
  assert.strictEqual(clientEvidence({ method: "bank_qr", amount: 100000, reference: "  x  " }), null, "a non-blank reference satisfies it");
});

it("a blank/whitespace reference does not satisfy the transfer rule", () => {
  assert.ok(clientEvidence({ method: "transfer", amount: 100000, reference: "   " }));
});

it("a zero (prepaid) collected amount needs no evidence, whatever the method", () => {
  assert.strictEqual(clientEvidence({ method: "transfer", amount: 0 }), null);
  assert.strictEqual(clientEvidence({ method: "bank_qr", amount: 0, reference: "" }), null);
});

it("electronic refunds need a reference; cash refunds do not", () => {
  assert.ok(clientRefundEvidence({ method: "refund_bank" }), "bank refund with no reference → blocked");
  assert.ok(clientRefundEvidence({ method: "refund_qr", reference: "" }));
  assert.ok(clientRefundEvidence({ method: "refund_wallet" }));
  assert.strictEqual(clientRefundEvidence({ method: "refund_bank", reference: "TXN-42" }), null);
  assert.strictEqual(clientRefundEvidence({ method: "refund_cash" }), null, "cash refund is exempt");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

// Tests for the container-deposit ledger guards. Pure arithmetic — no emulator,
// no DOM. Run:
//   cd firebase
//   node web/assets/depositLedger.test.mjs
//
// What these pin: a customer's container balance is derived by netting their
// depositEvents, and it must never be allowed below zero. A hidden negative
// silently absorbs the next genuine deposit, so money the business actually
// collected stops showing as owed back to the customer.

import assert from "node:assert";
import {
  containerReturnProofProblem,
  containerReturnProofType,
  describeDepositBalanceProblem,
  isBrokenDepositBalance,
  RETURN_NOTE_MIN_LENGTH,
  summarizeHeldContainers
} from "./shared.js";

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

// Mirrors the reducer every screen runs over one customer's depositEvents.
function netBalance(events) {
  return events.reduce((acc, event) => {
    const qty = Number(event.qty || 0);
    const amount = Number(event.amount || 0);
    if (event.eventType === "charged") return { qty: acc.qty + qty, amount: acc.amount + amount };
    if (["refunded", "credited", "forfeited", "charge_reversed"].includes(event.eventType)) {
      return { qty: acc.qty - qty, amount: acc.amount - amount };
    }
    return acc;
  }, { qty: 0, amount: 0 });
}

const charge = (qty, amount) => ({ eventType: "charged", qty, amount });
const forfeit = (qty, amount) => ({ eventType: "forfeited", qty, amount });
const credited = (qty, amount) => ({ eventType: "credited", qty, amount });
const chargeReversed = (qty, amount) => ({ eventType: "charge_reversed", qty, amount });

console.log("\ndeposit ledger guards\n");

it("a settled customer nets to zero and is not flagged", () => {
  const net = netBalance([charge(2, 60000), credited(2, 60000)]);
  assert.deepStrictEqual(net, { qty: 0, amount: 0 });
  assert.strictEqual(isBrokenDepositBalance(net.qty, net.amount), false);
});

it("a customer still holding containers is not flagged", () => {
  const net = netBalance([charge(2, 60000)]);
  assert.deepStrictEqual(net, { qty: 2, amount: 60000 });
  assert.strictEqual(isBrokenDepositBalance(net.qty, net.amount), false);
});

it("a write-off against a customer holding nothing breaks the balance", () => {
  // The bug this guards: the loss report priced the forfeit at 0 VND because
  // there was no charge history to derive a per-unit deposit from.
  const net = netBalance([forfeit(2, 0)]);
  assert.strictEqual(net.qty, -2);
  assert.strictEqual(isBrokenDepositBalance(net.qty, net.amount), true);
});

it("the hole silently swallows the customer's next real deposit", () => {
  // 60,000 VND was actually collected here, but the ledger reads as settled —
  // this is the state the fix exists to make impossible, and to surface where
  // it already happened.
  const net = netBalance([forfeit(2, 0), charge(2, 60000)]);
  assert.strictEqual(net.qty, 0);
  assert.strictEqual(net.amount, 60000);
  assert.strictEqual(isBrokenDepositBalance(net.qty, net.amount), false,
    "a cancelled-out hole is undetectable after the fact — prevention is the only fix");
});

it("over-refunding money is flagged even when the container count looks fine", () => {
  // qty and amount drift apart independently, so each is tested on its own.
  const net = netBalance([charge(2, 60000), credited(2, 90000)]);
  assert.strictEqual(net.qty, 0);
  assert.strictEqual(net.amount, -30000);
  assert.strictEqual(isBrokenDepositBalance(net.qty, net.amount), true);
});

it("sub-1 VND rounding dust is not treated as a broken balance", () => {
  assert.strictEqual(isBrokenDepositBalance(0, -0.4), false);
});

it("the problem description names both the count and the money", () => {
  assert.match(describeDepositBalanceProblem(-2, -60000), /2 more returned/);
  assert.match(describeDepositBalanceProblem(-2, -60000), /refunded beyond/);
  assert.strictEqual(describeDepositBalanceProblem(-2, 0), "2 more returned than were ever charged");
});

// summarizeHeldContainers is the shared per-type version of the netBalance
// reducer above — the one both customer screens and (in arithmetic) the owner's
// delivery dialogs now run. It drives what the order form tells the customer
// they are holding, and the money estimate beside it, so it is pinned here.
const chargeOf = (type, qty, amount, eventDate = null) => ({ eventType: "charged", containerType: type, qty, amount, eventDate });
const creditOf = (type, qty, amount) => ({ eventType: "credited", containerType: type, qty, amount });
const refundOf = (type, qty, amount) => ({ eventType: "refunded", containerType: type, qty, amount });
const forfeitOf = (type, qty, amount) => ({ eventType: "forfeited", containerType: type, qty, amount });
const rowFor = (rows, type) => rows.find((row) => row.type === type);

it("summarize: a plain charge shows as held, with its per-unit deposit", () => {
  const rows = summarizeHeldContainers([chargeOf("glass_crate", 3, 600000, "2026-07-01")]);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rowFor(rows, "glass_crate").qty, 3);
  assert.strictEqual(rowFor(rows, "glass_crate").deposit, 600000);
  assert.strictEqual(rowFor(rows, "glass_crate").depositPerUnit, 200000);
  assert.strictEqual(rowFor(rows, "glass_crate").oldestChargedDate, "2026-07-01");
});

it("summarize: returning at delivery clears the containers, not just the money", () => {
  // The exact bug this replaced: accountApp subtracted only the amount, so the
  // customer kept seeing crates they had physically handed back.
  const rows = summarizeHeldContainers([
    chargeOf("glass_crate", 3, 600000, "2026-07-01"),
    creditOf("glass_crate", 3, 600000)
  ]);
  assert.deepStrictEqual(rows, [], "a fully returned type is settled and should not render at all");
});

it("summarize: a forfeited container stops being held", () => {
  // Also previously wrong on the account page, which ignored `forfeited`
  // entirely and kept showing written-off containers as the customer's.
  const rows = summarizeHeldContainers([
    chargeOf("19l_jug", 4, 400000, "2026-06-01"),
    forfeitOf("19l_jug", 1, 100000)
  ]);
  assert.strictEqual(rowFor(rows, "19l_jug").qty, 3);
  assert.strictEqual(rowFor(rows, "19l_jug").deposit, 300000);
});

it("summarize: credited and refunded both reduce the holding", () => {
  const rows = summarizeHeldContainers([
    chargeOf("glass_crate", 3, 600000, "2026-07-01"),
    creditOf("glass_crate", 1, 200000),
    refundOf("glass_crate", 1, 200000)
  ]);
  assert.strictEqual(rowFor(rows, "glass_crate").qty, 1);
  assert.strictEqual(rowFor(rows, "glass_crate").deposit, 200000);
});

it("summarize: a charge_reversed (cancelled order) stops the deposit being held", () => {
  // P0-07: cancelling an order reverses its deposit charge. The customer no
  // longer holds the container and is owed nothing back for it.
  const rows = summarizeHeldContainers([
    chargeOf("glass_crate", 2, 400000, "2026-07-01"),
    { eventType: "charge_reversed", containerType: "glass_crate", qty: 2, amount: 400000 }
  ]);
  assert.strictEqual(rowFor(rows, "glass_crate"), undefined);
});

it("charge_reversed reduces the raw net balance too", () => {
  const net = netBalance([charge(2, 400000), chargeReversed(2, 400000)]);
  assert.strictEqual(net.qty, 0);
  assert.strictEqual(net.amount, 0);
});

it("summarize: types are kept apart", () => {
  const rows = summarizeHeldContainers([
    chargeOf("glass_crate", 2, 400000, "2026-07-01"),
    chargeOf("20l_jug", 1, 120000, "2026-07-05")
  ]);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rowFor(rows, "glass_crate").qty, 2);
  assert.strictEqual(rowFor(rows, "20l_jug").qty, 1);
});

it("summarize: a below-zero balance survives instead of being filtered away", () => {
  // Same posture as isBrokenDepositBalance above — hiding it is what let a hole
  // look like a settled customer. The order form must NOT offer a pickup here.
  const rows = summarizeHeldContainers([
    chargeOf("glass_crate", 1, 200000, "2026-07-01"),
    creditOf("glass_crate", 3, 600000)
  ]);
  assert.strictEqual(rowFor(rows, "glass_crate").qty, -2);
  assert.strictEqual(isBrokenDepositBalance(rowFor(rows, "glass_crate").qty, rowFor(rows, "glass_crate").deposit), true);
});

it("summarize: oldest charge date wins, and later charges do not reset it", () => {
  const rows = summarizeHeldContainers([
    chargeOf("glass_crate", 1, 200000, "2026-07-09"),
    chargeOf("glass_crate", 1, 200000, "2026-03-02")
  ]);
  assert.strictEqual(rowFor(rows, "glass_crate").oldestChargedDate, "2026-03-02");
});

it("summarize: a missing container type is bucketed, not dropped", () => {
  const rows = summarizeHeldContainers([{ eventType: "charged", qty: 1, amount: 50000 }]);
  assert.strictEqual(rowFor(rows, "other").qty, 1);
});

it("summarize: no events is simply nothing held", () => {
  assert.deepStrictEqual(summarizeHeldContainers([]), []);
  assert.deepStrictEqual(summarizeHeldContainers(), []);
});

// Proof that containers came back. Both delivery dialogs gate the save on this,
// so the two screens cannot drift apart on how much evidence is enough.
it("proof: a photo alone is accepted", () => {
  assert.strictEqual(containerReturnProofProblem({ hasPhoto: true, note: "" }), null);
  assert.strictEqual(containerReturnProofType({ hasPhoto: true, note: "" }), "photo");
});

it("proof: nothing at all is refused", () => {
  const problem = containerReturnProofProblem({ hasPhoto: false, note: "" });
  assert.match(problem, /photo/i);
  assert.match(problem, /write what you collected/i);
  assert.strictEqual(containerReturnProofType({ hasPhoto: false, note: "" }), null);
});

it("proof: a real written account replaces the photo", () => {
  // The whole point of the alternative — a photo can be of an empty floor, so a
  // specific sentence someone put their name to is worth at least as much.
  const note = "3 crates collected from Ms Hoa at the shop, camera broken";
  assert.strictEqual(containerReturnProofProblem({ hasPhoto: false, note }), null);
  assert.strictEqual(containerReturnProofType({ hasPhoto: false, note }), "note");
});

it("proof: a token note is refused", () => {
  const problem = containerReturnProofProblem({ hasPhoto: false, note: "ok" });
  assert.match(problem, /at least 15 characters/);
  assert.strictEqual(containerReturnProofProblem({ hasPhoto: false, note: "   ok   " }), problem,
    "padding a short note with spaces must not get past the minimum");
});

it("proof: whitespace is not an account of anything", () => {
  assert.match(containerReturnProofProblem({ hasPhoto: false, note: "               " }), /write what you collected/i);
  assert.strictEqual(containerReturnProofType({ hasPhoto: false, note: "     " }), null);
});

it("proof: exactly at the minimum is accepted, one short is not", () => {
  const atMin = "x".repeat(RETURN_NOTE_MIN_LENGTH);
  const belowMin = "x".repeat(RETURN_NOTE_MIN_LENGTH - 1);
  assert.strictEqual(containerReturnProofProblem({ hasPhoto: false, note: atMin }), null);
  assert.match(containerReturnProofProblem({ hasPhoto: false, note: belowMin }), /at least/);
});

it("proof: both photo and note is recorded as both", () => {
  const note = "3 crates collected from Ms Hoa at the shop";
  assert.strictEqual(containerReturnProofProblem({ hasPhoto: true, note }), null);
  assert.strictEqual(containerReturnProofType({ hasPhoto: true, note }), "photo_note");
});

it("proof: a photo still passes even when the note is too short to stand alone", () => {
  // The note is optional extra context once a photo exists; it must not become
  // a second hurdle that blocks a delivery that already has evidence.
  assert.strictEqual(containerReturnProofProblem({ hasPhoto: true, note: "ok" }), null);
});

it("proof: called with nothing at all does not throw", () => {
  assert.match(containerReturnProofProblem(), /photo/i);
  assert.strictEqual(containerReturnProofType(), null);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);

// Tests for the P0-10 order-draft logic. Pure — no emulator, no DOM. Run:
//   cd firebase
//   node web/assets/orderDraft.test.mjs
//
// What these pin: the draft written before the email sign-in navigation must
// round-trip through localStorage byte-safe (quantities, typed fields, the
// confirmed pin), expire after a day so a weeks-old cart never resurrects,
// and re-normalize on the way back in so corrupt or hand-edited storage can
// never inject unexpected shapes into the order form. The DOM half (capture /
// restore and the account.html bounce-back) is exercised in browser QA.

import assert from "node:assert";
import {
  buildOrderDraft,
  ORDER_DRAFT_MAX_AGE_MS,
  ORDER_DRAFT_STORAGE_KEY,
  parseStoredOrderDraft
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

const NOW = 1_800_000_000_000;

function sampleDraft(savedAtMs = NOW) {
  return buildOrderDraft({
    quantities: { "P-UNI-20L-JUG": 2, "P-GLASS-STRAW": 1 },
    fields: {
      name: "Test Customer",
      phoneNational: "905123456",
      phoneCountry: "+84",
      address: "36 Bạch Đằng, Đà Nẵng",
      deliveryDate: "2026-07-22",
      deliveryWindow: "08:00-11:00",
      notes: "call ahead"
    },
    deliveryLocation: { lat: 16.0736, lng: 108.2242, formattedAddress: "36 Bạch Đằng", source: "geocode" },
    savedAtMs
  });
}

it("an empty form builds no draft (nothing to resurrect)", () => {
  assert.strictEqual(buildOrderDraft({ quantities: {}, fields: {}, deliveryLocation: null }), null);
  assert.strictEqual(buildOrderDraft(), null);
  // Zero/negative/garbage quantities and blank fields count as empty.
  assert.strictEqual(buildOrderDraft({
    quantities: { a: 0, b: -2, c: "x" },
    fields: { name: "   ", notes: "" }
  }), null);
});

it("quantities are cleaned: floor to positive integers, drop the rest", () => {
  const draft = buildOrderDraft({ quantities: { a: 2.9, b: 0, c: -1, d: "3", e: NaN } });
  assert.deepStrictEqual(draft.quantities, { a: 2, d: 3 });
});

it("fields are trimmed and unknown keys dropped", () => {
  const draft = buildOrderDraft({ fields: { name: "  Ty  ", hacked: "value", notes: "hi" } });
  assert.deepStrictEqual(draft.fields, { name: "Ty", notes: "hi" });
  assert.strictEqual("hacked" in draft.fields, false);
});

it("an invalid pin is dropped without dropping the draft", () => {
  const draft = buildOrderDraft({
    quantities: { a: 1 },
    deliveryLocation: { lat: "not-a-number", lng: 108.2 }
  });
  assert.strictEqual(draft.deliveryLocation, null);
  assert.deepStrictEqual(draft.quantities, { a: 1 });
});

it("round-trips through JSON storage byte-safe", () => {
  const draft = sampleDraft();
  const restored = parseStoredOrderDraft(JSON.stringify(draft), NOW + 60_000);
  assert.deepStrictEqual(restored, draft);
});

it("garbage, bad JSON and foreign versions parse to null", () => {
  assert.strictEqual(parseStoredOrderDraft(null, NOW), null);
  assert.strictEqual(parseStoredOrderDraft("", NOW), null);
  assert.strictEqual(parseStoredOrderDraft("{not json", NOW), null);
  assert.strictEqual(parseStoredOrderDraft("42", NOW), null);
  assert.strictEqual(parseStoredOrderDraft(JSON.stringify({ ...sampleDraft(), v: 2 }), NOW), null);
  assert.strictEqual(parseStoredOrderDraft(JSON.stringify({ ...sampleDraft(), savedAt: "soon" }), NOW), null);
});

it("expires after a day — a stale cart never resurrects", () => {
  const draft = sampleDraft(NOW - ORDER_DRAFT_MAX_AGE_MS - 1);
  assert.strictEqual(parseStoredOrderDraft(JSON.stringify(draft), NOW), null);
  const justFresh = sampleDraft(NOW - ORDER_DRAFT_MAX_AGE_MS + 60_000);
  assert.ok(parseStoredOrderDraft(JSON.stringify(justFresh), NOW), "a 23h59m draft still restores");
});

it("a future-stamped draft (clock skew beyond a minute) parses to null", () => {
  const draft = sampleDraft(NOW + 5 * 60_000);
  assert.strictEqual(parseStoredOrderDraft(JSON.stringify(draft), NOW), null);
  const slightSkew = sampleDraft(NOW + 30_000);
  assert.ok(parseStoredOrderDraft(JSON.stringify(slightSkew), NOW), "sub-minute skew tolerated");
});

it("parse re-normalizes: corrupt storage cannot inject shapes into the form", () => {
  const tampered = {
    v: 1,
    savedAt: NOW,
    quantities: { good: 2, bad: -5, weird: "9.7" },
    fields: { name: " x ", injected: "<script>" },
    deliveryLocation: { lat: 16.07, lng: 108.22, formattedAddress: 12345, extra: true }
  };
  const restored = parseStoredOrderDraft(JSON.stringify(tampered), NOW);
  assert.deepStrictEqual(restored.quantities, { good: 2, weird: 9 });
  assert.deepStrictEqual(restored.fields, { name: "x" });
  assert.strictEqual(typeof restored.deliveryLocation.formattedAddress, "string");
  assert.strictEqual("extra" in restored.deliveryLocation, false);
});

it("storage key is stable (account.html reads the same key)", () => {
  assert.strictEqual(ORDER_DRAFT_STORAGE_KEY, "vs-order-draft");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

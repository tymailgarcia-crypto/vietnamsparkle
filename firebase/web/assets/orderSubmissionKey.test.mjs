// Tests for the P0-02 client-side submission-key logic. Pure — no emulator,
// no DOM. Run:
//   cd firebase
//   node web/assets/orderSubmissionKey.test.mjs
//
// What these pin: a retry of THE SAME order (double-click, timeout, reload +
// rebuilt cart) must reuse the stored key so the server can dedup it, while a
// deliberately different or stale order must rotate the key so it is never
// swallowed by an old mapping. The server half (transactional dedup) is
// covered by functions/orderSubmission.emulator.test.js.

import assert from "node:assert";
import {
  randomSubmissionKey,
  resolveSubmissionKey,
  SUBMISSION_KEY_MAX_AGE_MS,
  SUBMISSION_KEY_PATTERN,
  submissionFingerprint
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

const basePayload = () => ({
  items: [
    { productId: "water-19l", quantity: 2 },
    { productId: "crate-330", quantity: 1 }
  ],
  customer: {
    name: "Nguyen Van A",
    phone: "+84905123456",
    address: "12 Nguyen Hue, Da Nang",
    deliveryDate: "2026-07-21",
    deliveryWindow: "Morning",
    notes: "",
    deliveryLocation: { lat: 16.06778, lng: 108.22083, formattedAddress: "12 Nguyen Hue" }
  }
});

const NOW = 1_800_000_000_000;

it("generated keys satisfy the shared pattern the server validates", () => {
  for (let i = 0; i < 20; i += 1) {
    assert.match(randomSubmissionKey(), SUBMISSION_KEY_PATTERN);
  }
});

it("same payload fingerprints identically even when the cart was rebuilt in another item order", () => {
  const a = basePayload();
  const b = basePayload();
  b.items.reverse();
  assert.strictEqual(submissionFingerprint(a), submissionFingerprint(b));
});

it("fingerprint ignores the customer's display name but not delivery-material fields", () => {
  const a = basePayload();
  const b = basePayload();
  b.customer.name = "Different Display Name";
  assert.strictEqual(submissionFingerprint(a), submissionFingerprint(b));
  const c = basePayload();
  c.customer.address = "45 Bach Dang, Da Nang";
  assert.notStrictEqual(submissionFingerprint(a), submissionFingerprint(c));
});

it("re-confirming the pin on the same spot (sub-meter jitter) does not rotate the fingerprint", () => {
  const a = basePayload();
  const b = basePayload();
  b.customer.deliveryLocation = { ...b.customer.deliveryLocation, lat: 16.067780004, lng: 108.220830004 };
  assert.strictEqual(submissionFingerprint(a), submissionFingerprint(b));
});

it("double-click / immediate retry reuses the stored key", () => {
  const fp = submissionFingerprint(basePayload());
  const first = resolveSubmissionKey(null, fp, NOW);
  assert.strictEqual(first.reused, false);
  const stored = { key: first.key, fingerprint: fp, at: NOW };
  const retry = resolveSubmissionKey(stored, fp, NOW + 1500);
  assert.strictEqual(retry.reused, true);
  assert.strictEqual(retry.key, first.key);
});

it("retry after reload reuses the key parsed back from storage JSON", () => {
  const fp = submissionFingerprint(basePayload());
  const stored = JSON.parse(JSON.stringify({ key: "0f7c9a4e-1111-4222-8333-abcdefabcdef", fingerprint: fp, at: NOW }));
  const retry = resolveSubmissionKey(stored, fp, NOW + 10 * 60 * 1000);
  assert.strictEqual(retry.reused, true);
  assert.strictEqual(retry.key, "0f7c9a4e-1111-4222-8333-abcdefabcdef");
});

it("a deliberately different order (changed cart) rotates the key", () => {
  const fp = submissionFingerprint(basePayload());
  const changed = basePayload();
  changed.items[0].quantity = 5;
  const fp2 = submissionFingerprint(changed);
  assert.notStrictEqual(fp, fp2);
  const stored = { key: "abcdefgh12345678", fingerprint: fp, at: NOW };
  const next = resolveSubmissionKey(stored, fp2, NOW + 1000);
  assert.strictEqual(next.reused, false);
  assert.notStrictEqual(next.key, stored.key);
});

it("a stale key (>= max age) rotates even for an identical order", () => {
  const fp = submissionFingerprint(basePayload());
  const stored = { key: "abcdefgh12345678", fingerprint: fp, at: NOW };
  const next = resolveSubmissionKey(stored, fp, NOW + SUBMISSION_KEY_MAX_AGE_MS);
  assert.strictEqual(next.reused, false);
  const stillFresh = resolveSubmissionKey(stored, fp, NOW + SUBMISSION_KEY_MAX_AGE_MS - 1);
  assert.strictEqual(stillFresh.reused, true);
});

it("garbage in storage (old versions, clock skew, wrong shapes) never reuses", () => {
  const fp = submissionFingerprint(basePayload());
  const cases = [
    null,
    "not-an-object",
    {},
    { key: 42, fingerprint: fp, at: NOW },
    { key: "short", fingerprint: fp, at: NOW },
    { key: "has spaces bad!", fingerprint: fp, at: NOW },
    { key: "abcdefgh12345678", fingerprint: fp, at: "yesterday" },
    // stored "in the future" — a wrong clock must not extend the key's life
    { key: "abcdefgh12345678", fingerprint: fp, at: NOW + 5000 }
  ];
  for (const stored of cases) {
    const next = resolveSubmissionKey(stored, fp, NOW);
    assert.strictEqual(next.reused, false, `should not reuse for ${JSON.stringify(stored)}`);
    assert.match(next.key, SUBMISSION_KEY_PATTERN);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

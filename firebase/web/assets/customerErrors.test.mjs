// Tests for the customer-facing error humanizer. Pure — no emulator, no DOM. Run:
//   cd firebase
//   node web/assets/customerErrors.test.mjs
//
// What these pin: humanizeCustomerError turns the raw strings Firebase drops
// into error.message (auth/* codes, "Missing or insufficient permissions",
// infra codes) into a plain, actionable sentence — WITHOUT clobbering the
// customer-ready messages our own callables author for their validation throws
// (see functions/index.js submitPublicOrder). The invariant that matters most:
// a raw Firebase string must never reach the customer.

import assert from "node:assert";
import { humanizeCustomerError } from "./shared.js";

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

// A FirebaseError-shaped object: { code, message }. httpsCallable and the
// Firebase Auth/Firestore SDKs all throw this shape.
const fbError = (code, message) => ({ code, message });

it("a Google popup-blocked auth code becomes an actionable line about pop-ups", () => {
  const msg = humanizeCustomerError(fbError("auth/popup-blocked", "Firebase: Error (auth/popup-blocked)."));
  assert.match(msg, /pop-up/i);
  assert.match(msg, /email sign-in link/i);
  assert.doesNotMatch(msg, /firebase|auth\//i, "the raw code must not leak through");
});

it("a cancelled sign-in popup invites the customer to try again, not an error dump", () => {
  const msg = humanizeCustomerError(fbError("auth/popup-closed-by-user", "Firebase: Error (auth/popup-closed-by-user)."));
  assert.match(msg, /cancelled/i);
  assert.doesNotMatch(msg, /firebase|auth\//i);
});

it("an offline auth attempt tells the customer to check their connection", () => {
  const msg = humanizeCustomerError(fbError("auth/network-request-failed", "Firebase: A network error ... (auth/network-request-failed)."));
  assert.match(msg, /offline|connection/i);
});

it("an expired email sign-in link asks for a fresh one", () => {
  const msg = humanizeCustomerError(fbError("auth/invalid-action-code", "Firebase: Error (auth/invalid-action-code)."));
  assert.match(msg, /expired|already used/i);
  assert.match(msg, /fresh email link/i);
});

it("a Cloud Functions 'unavailable' code becomes a plain retry line (bare tail matched)", () => {
  const msg = humanizeCustomerError(fbError("functions/unavailable", "internal"));
  assert.match(msg, /couldn't reach our server|connection/i);
  assert.doesNotMatch(msg, /functions\//i);
});

it("a Firestore permission-denied ('Missing or insufficient permissions') is never shown raw", () => {
  const msg = humanizeCustomerError(fbError("permission-denied", "Missing or insufficient permissions."));
  assert.doesNotMatch(msg, /insufficient permissions/i);
  assert.match(msg, /sign-in may have expired|sign in again/i);
});

it("an authored server validation message (failed-precondition) is passed through verbatim", () => {
  // submitPublicOrder throws these; they are written for the customer already.
  const server = "That delivery date has already passed. Pick tomorrow or later.";
  assert.strictEqual(
    humanizeCustomerError(fbError("functions/failed-precondition", server)),
    server
  );
});

it("an authored invalid-argument message is passed through verbatim", () => {
  const server = "Address must be 5–499 characters.";
  assert.strictEqual(humanizeCustomerError(fbError("functions/invalid-argument", server)), server);
});

it("an unmapped Firebase code with junk text uses the caller's fallback, not the junk", () => {
  const msg = humanizeCustomerError(
    fbError("auth/some-brand-new-code", "Firebase: Error (auth/some-brand-new-code)."),
    { fallback: "Sign-in didn't complete. Please try again." }
  );
  assert.strictEqual(msg, "Sign-in didn't complete. Please try again.");
});

it("a plain Error we threw ourselves (no code) is shown as-is — it's already customer text", () => {
  const msg = humanizeCustomerError(new Error("Order was not confirmed. Please try again."), {
    fallback: "unused",
  });
  assert.strictEqual(msg, "Order was not confirmed. Please try again.");
});

it("a plain Error that wraps a raw SDK string is suppressed in favour of the fallback", () => {
  // accountApp wraps child failures as new Error("orders: <child.message>").
  const msg = humanizeCustomerError(new Error("orders: Missing or insufficient permissions."), {
    fallback: "We couldn't load your account details.",
  });
  assert.strictEqual(msg, "We couldn't load your account details.");
});

it("null / undefined / empty errors fall back cleanly", () => {
  assert.strictEqual(humanizeCustomerError(null, { fallback: "F" }), "F");
  assert.strictEqual(humanizeCustomerError(undefined, { fallback: "F" }), "F");
  assert.strictEqual(humanizeCustomerError({}, { fallback: "F" }), "F");
});

it("the default fallback is a safe, generic sentence when none is supplied", () => {
  const msg = humanizeCustomerError(fbError("functions/internal", "INTERNAL"));
  // 'internal' is mapped, so this proves the map wins; but an unmapped no-code
  // object with no usable message must hit the built-in default:
  const generic = humanizeCustomerError({ code: "totally-unknown" });
  assert.match(msg, /our side|try again/i);
  assert.match(generic, /something went wrong/i);
});

it("a bare string error falls back rather than echoing the raw string", () => {
  // Some throws are `throw "boom"`; a bare string has no code and could be raw.
  const msg = humanizeCustomerError("permission-denied at /customers", { fallback: "Please try again." });
  assert.strictEqual(msg, "Please try again.");
});

it("too-many-requests throttling is explained in plain words", () => {
  const msg = humanizeCustomerError(fbError("auth/too-many-requests", "Firebase: ... (auth/too-many-requests)."));
  assert.match(msg, /too many attempts/i);
  assert.match(msg, /wait/i);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);

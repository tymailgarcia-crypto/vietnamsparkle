// P0-03 — delivery date + service-area validation. Pure, no emulator. Run:
//   cd firebase/functions
//   node deliveryValidation.parity.test.mjs
//
// Two jobs:
//  1. PARITY. The rule is defined in web/assets/shared.js (client) and mirrored
//     in functions/index.js (server, CommonJS — can't import the ESM module).
//     Duplication is the risk: if the two drift, the form accepts orders the
//     server rejects, or vice versa. These tests load BOTH copies and assert
//     they agree on a battery of inputs, so a future edit to one and not the
//     other fails here instead of in production.
//  2. BEHAVIOR. The acceptance cases from SHIP-READINESS P0-03: past date,
//     nonexistent date, malformed date, today/future accepted, boundary
//     coordinates, and the timezone-boundary case UTC gets wrong.

import assert from "node:assert";
import { createRequire } from "node:module";

process.env.NODE_ENV = "test"; // exposes _deliveryValidationTestApi in index.js

import {
  DA_NANG_DELIVERY_BOUNDS as CLIENT_BOUNDS,
  SAME_DAY_CUTOFF_HOUR as CLIENT_CUTOFF,
  deliveryDateProblem as clientDateProblem,
  isInsideDeliveryArea as clientInsideArea,
  todayKeyInZone
} from "../web/assets/shared.js";

const require = createRequire(import.meta.url);
const server = require("./index.js")._deliveryValidationTestApi();

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

// --- Parity of the constants -----------------------------------------------

it("server bounds equal client bounds, edge for edge", () => {
  assert.deepStrictEqual(server.DA_NANG_DELIVERY_BOUNDS, CLIENT_BOUNDS);
});

it("server same-day cutoff equals client cutoff (both still the open null)", () => {
  assert.strictEqual(server.SAME_DAY_CUTOFF_HOUR, CLIENT_CUTOFF);
});

// --- Parity of businessTodayKey / todayKeyInZone ---------------------------

it("server businessTodayKey matches client todayKeyInZone across many instants", () => {
  const samples = [
    "2026-01-01T00:00:00Z",
    "2026-07-21T16:59:00Z", // 23:59 Vietnam, same civil day
    "2026-07-21T17:00:00Z", // 00:00 Vietnam, civil day rolls over
    "2026-07-21T19:00:00Z", // 02:00 Vietnam next day
    "2026-12-31T20:00:00Z"  // 03:00 Vietnam, new year already in Da Nang
  ];
  for (const iso of samples) {
    const now = new Date(iso);
    assert.strictEqual(server.businessTodayKey(now), todayKeyInZone("Asia/Ho_Chi_Minh", now), iso);
  }
});

// --- Parity of the date rule -----------------------------------------------

it("date rule agrees between client and server on a battery of dates", () => {
  const today = "2026-07-21";
  const dates = [
    "2026-07-21", // today
    "2026-07-22", // future
    "2026-07-20", // past
    "2026-02-31", // nonexistent
    "2026-13-01", // nonexistent month
    "2026-00-10", // nonexistent month 0
    "2026-7-1",   // malformed (not zero-padded)
    "not-a-date",
    "",
    "2026-12-31"
  ];
  for (const d of dates) {
    assert.strictEqual(
      Boolean(server.deliveryDateProblem(d, today)),
      Boolean(clientDateProblem(d, today)),
      `problem/no-problem disagreed for ${JSON.stringify(d)}`
    );
    // And the exact message, so the customer sees the same words either path.
    assert.strictEqual(server.deliveryDateProblem(d, today), clientDateProblem(d, today), `message disagreed for ${JSON.stringify(d)}`);
  }
});

// --- Parity of the area rule -----------------------------------------------

it("area rule agrees between client and server around every edge", () => {
  const { west, south, east, north } = CLIENT_BOUNDS;
  const midLat = (south + north) / 2;
  const midLng = (west + east) / 2;
  const points = [
    [midLat, midLng],            // centre
    [south, west],               // exact SW corner (inclusive)
    [north, east],               // exact NE corner (inclusive)
    [south - 0.0001, midLng],    // just south
    [north + 0.0001, midLng],    // just north
    [midLat, west - 0.0001],     // just west
    [midLat, east + 0.0001],     // just east
    [10.7626, 106.6602],         // Ho Chi Minh City — far outside
    [21.0278, 105.8342]          // Hanoi — far outside
  ];
  for (const [lat, lng] of points) {
    assert.strictEqual(
      server.isInsideDeliveryArea(lat, lng),
      clientInsideArea({ lat, lng }),
      `inside/outside disagreed for ${lat},${lng}`
    );
  }
});

// --- Behavior: acceptance cases --------------------------------------------

it("past date is rejected as a fixable precondition, not a format error", () => {
  const problem = server.deliveryDateProblem("2026-07-20", "2026-07-21");
  assert.ok(problem && /passed/.test(problem));
});

it("nonexistent date (02-31) does not silently roll into March", () => {
  const problem = server.deliveryDateProblem("2026-02-31", "2026-01-01");
  assert.ok(problem && /does not exist/.test(problem));
});

it("malformed date returns the YYYY-MM-DD format message", () => {
  assert.strictEqual(server.deliveryDateProblem("21/07/2026", "2026-07-21"), "Delivery date must be YYYY-MM-DD.");
});

it("today and a future date are accepted", () => {
  assert.strictEqual(server.deliveryDateProblem("2026-07-21", "2026-07-21"), null);
  assert.strictEqual(server.deliveryDateProblem("2026-08-01", "2026-07-21"), null);
});

it("stale-tab / midnight case: a date yesterday-in-Da-Nang is rejected using the business zone, which UTC would wrongly accept", () => {
  // 2026-07-21T19:00:00Z == 2026-07-22 02:00 in Da Nang (UTC+7).
  const now = new Date("2026-07-21T19:00:00Z");
  const businessToday = server.businessTodayKey(now); // 2026-07-22
  assert.strictEqual(businessToday, "2026-07-22");
  // A UTC-derived floor would be 2026-07-21, which accepts a Da-Nang-yesterday order.
  const utcToday = now.toISOString().slice(0, 10); // 2026-07-21
  assert.strictEqual(server.deliveryDateProblem("2026-07-21", utcToday), null, "UTC floor wrongly accepts");
  assert.ok(server.deliveryDateProblem("2026-07-21", businessToday), "business floor correctly rejects");
});

it("boundary coordinates: a pin one step outside any edge is out of area", () => {
  const { west, south, east, north } = CLIENT_BOUNDS;
  assert.strictEqual(server.isInsideDeliveryArea((south + north) / 2, (west + east) / 2), true);
  assert.strictEqual(server.isInsideDeliveryArea(south - 0.0001, (west + east) / 2), false);
  assert.strictEqual(server.isInsideDeliveryArea((south + north) / 2, east + 0.0001), false);
  // A legacy Ho Chi Minh City pin is rejected — the P0-03 out-of-area case.
  assert.strictEqual(server.isInsideDeliveryArea(10.7626, 106.6602), false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

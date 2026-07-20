import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("../web/map.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../web/assets/mapApp.js", import.meta.url), "utf8");

test("the operational map has no date gate or delivered-history filter", () => {
  assert.doesNotMatch(html, /id="map-date"/);
  assert.doesNotMatch(html, /value="delivered"/);
  assert.match(html, /value="approved">All active orders</);
  assert.match(app, /where\("status", "in", APPROVED_STATUSES\)/);
  assert.doesNotMatch(app, /where\("deliveryDate", "[<>]=?"/);
});

test("active orders stay live and are sorted with the oldest delivery first", () => {
  assert.match(app, /onSnapshot\(activeOrdersQuery\(\)/);
  assert.match(app, /filter\(\(order\) => APPROVED_STATUSES\.includes\(order\.status\)\)/);
  assert.match(app, /String\(a\.deliveryDate \|\| "9999-12-31"\)\.localeCompare/);
  assert.match(html, /<th>Delivery<\/th>/);
  assert.match(app, /Overdue<br>/);
});

test("trip building has explicit filtered and individual selection controls", () => {
  for (const id of [
    "build-trip-button",
    "trip-selection-bar",
    "select-filtered-button",
    "clear-trip-selection-button",
    "plan-trips-button"
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  assert.match(app, /selectedOrderIds: new Set\(\)/);
  assert.match(app, /selectableOrders\(filteredOrders\(\)\)/);
  assert.match(app, /data-trip-order-id/);
  assert.match(app, /if \(state\.tripSelectionMode\) \{\s*toggleOrderSelection\(order\.id\)/);
});

test("the planner uses only selected orders", () => {
  const runPlanner = app.match(/async function runPlanner\(\) \{[\s\S]*?\n\}/)?.[0] || "";
  assert.match(runPlanner, /selectedOrders\(\)/);
  assert.doesNotMatch(runPlanner, /filteredOrders\(\)/);
  assert.match(runPlanner, /locationForOrder\(order\)/);
  assert.match(html, /Plan selected/);
});

test("visible pins and plannable stops share the same resolved location", () => {
  assert.match(app, /const orderLoc = order\.deliveryLocation/);
  assert.match(app, /const hasPin = Boolean\(locationForOrder\(order\)\)/);
  assert.match(app, /selectedOrders\(\)\.filter\(\(order\) => Boolean\(locationForOrder\(order\)\)\)/);
  assert.match(app, /pinSvg\(driverColor\(order\.assignedDriverId\), selected\)/);
});

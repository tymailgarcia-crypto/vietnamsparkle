import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  compareOpenOrders,
  filterOpenOrdersByTiming,
  groupOpenOrders,
  importantNoteIsValid,
  isOpenOrder,
  normalizeImportantNote,
  openOrderGroupKey
} from "../web/assets/adminDashboardModel.js";

const adminSource = readFileSync(new URL("../web/assets/adminApp.js", import.meta.url), "utf8");
const adminHtml = readFileSync(new URL("../web/admin.html", import.meta.url), "utf8");

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test("only operational statuses are open", () => {
  for (const status of ["pending_approval", "new", "assigned", "out_for_delivery"]) {
    assert.equal(isOpenOrder({ status }), true, status);
  }
  for (const status of ["delivered", "cancelled", "", null]) {
    assert.equal(isOpenOrder({ status }), false, String(status));
  }
});

test("orders are assigned to the right delivery-time group", () => {
  const today = "2026-07-20";
  assert.equal(openOrderGroupKey({}, today), "needs_date");
  assert.equal(openOrderGroupKey({ deliveryDate: "not-a-date" }, today), "needs_date");
  assert.equal(openOrderGroupKey({ deliveryDate: "2026-07-19" }, today), "overdue");
  assert.equal(openOrderGroupKey({ deliveryDate: today }, today), "today");
  assert.equal(openOrderGroupKey({ deliveryDate: "2026-07-21" }, today), "upcoming");
});

test("terminal orders never leak into grouped open work", () => {
  const grouped = groupOpenOrders([
    { id: "open", status: "new", deliveryDate: "2026-07-20" },
    { id: "delivered", status: "delivered", deliveryDate: "2026-07-20" },
    { id: "cancelled", status: "cancelled", deliveryDate: "2026-07-19" }
  ], "2026-07-20");
  assert.deepEqual(grouped.today.map((order) => order.id), ["open"]);
  assert.equal(Object.values(grouped).flat().length, 1);
});

test("important work rises within its group, then nearer dates win", () => {
  const orders = [
    { id: "later", deliveryDate: "2026-07-22", createdAt: "2026-07-10" },
    { id: "important", deliveryDate: "2026-07-25", important: true, createdAt: "2026-07-12" },
    { id: "nearer", deliveryDate: "2026-07-21", createdAt: "2026-07-11" }
  ];
  assert.deepEqual(orders.sort(compareOpenOrders).map((order) => order.id), ["important", "nearer", "later"]);
});

test("delivery timing filter returns a sorted flat order list", () => {
  const orders = [
    { id: "upcoming", status: "new", deliveryDate: "2026-07-22" },
    { id: "overdue-later", status: "assigned", deliveryDate: "2026-07-19" },
    { id: "overdue-earlier", status: "new", deliveryDate: "2026-07-18" },
    { id: "done", status: "delivered", deliveryDate: "2026-07-18" }
  ];
  assert.deepEqual(
    filterOpenOrdersByTiming(orders, "2026-07-20", "overdue").map((order) => order.id),
    ["overdue-earlier", "overdue-later"]
  );
  assert.deepEqual(
    filterOpenOrdersByTiming(orders, "2026-07-20", "all").map((order) => order.id),
    ["overdue-earlier", "overdue-later", "upcoming"]
  );
});

test("important notes must contain visible text and stay compact", () => {
  assert.equal(normalizeImportantNote("  Call before loading.  "), "Call before loading.");
  assert.equal(importantNoteIsValid("   "), false);
  assert.equal(importantNoteIsValid("Call first"), true);
  assert.equal(importantNoteIsValid("x".repeat(301)), false);
});

test("the active board uses a timing dropdown and flat full-order cards", () => {
  assert.match(adminSource, /filterOpenOrdersByTiming\(/);
  assert.match(adminSource, /visibleOrders\.map\(renderOrderCompact\)/);
  assert.match(adminHtml, /id="active-orders-panel"/);
  assert.match(adminHtml, /id="order-timing-filter"/);
  assert.doesNotMatch(adminHtml, /active-order-group-overdue/);
  assert.doesNotMatch(adminSource, /active-order-group-/);
  assert.doesNotMatch(adminHtml, /id="open-orders-list"/);
  assert.doesNotMatch(adminHtml, /id="working-date"/);
});

test("approval deposit events follow the order delivery date", () => {
  assert.match(adminSource, /eventDate: order\.deliveryDate \|\| todayKey\(\)/);
});

let passed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS  ${name}`);
  } catch (error) {
    console.error(`FAIL  ${name}`);
    throw error;
  }
}
console.log(`\n${passed}/${tests.length} admin dashboard model tests passed.`);

// Tests for the reorder integrity diff. Pure — no emulator, no DOM. Run:
//   cd firebase
//   node web/assets/reorderChanges.test.mjs
//
// What these pin: when a customer reorders a past order, the rebuilt cart is
// priced at TODAY's catalog. summarizeReorderChanges is what tells them what
// changed so they are not surprised — products retired since (dropped, add a
// replacement) and unit prices that moved. Deposit is intentionally not compared
// (orderItems do not store it; the totals panel shows today's deposit).

import assert from "node:assert";
import { summarizeReorderChanges } from "./shared.js";

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

const itemOf = (productId, quantity, unitPrice, productName) => ({ productId, quantity, unitPrice, productName });
const productOf = (id, unitPrice, productName) => ({ id, unitPrice, productName });

it("an unchanged reorder sets quantities and warns about nothing", () => {
  const items = [itemOf("P1", 2, 20000, "20L Jug"), itemOf("P2", 1, 15000, "Glass crate")];
  const catalog = [productOf("P1", 20000, "20L Jug"), productOf("P2", 15000, "Glass crate")];
  const { quantities, dropped, priceChanges } = summarizeReorderChanges(items, catalog);
  assert.deepStrictEqual(quantities, { P1: 2, P2: 1 });
  assert.deepStrictEqual(dropped, []);
  assert.deepStrictEqual(priceChanges, []);
});

it("a retired product is dropped, named, and kept out of the cart", () => {
  const items = [itemOf("P1", 2, 20000, "20L Jug"), itemOf("GONE", 3, 9000, "Old Bottle")];
  const catalog = [productOf("P1", 20000, "20L Jug")];
  const { quantities, dropped } = summarizeReorderChanges(items, catalog);
  assert.deepStrictEqual(quantities, { P1: 2 }, "the retired product must not be in the rebuilt cart");
  assert.deepStrictEqual(dropped, ["Old Bottle"]);
});

it("a retired product with no stored name falls back to its id", () => {
  const items = [{ productId: "GONE", quantity: 1, unitPrice: 5000 }];
  const { dropped } = summarizeReorderChanges(items, []);
  assert.deepStrictEqual(dropped, ["GONE"]);
});

it("a price increase is reported with was/now and today's name", () => {
  const items = [itemOf("P1", 2, 20000, "20L Jug (old name)")];
  const catalog = [productOf("P1", 25000, "20L Jug")];
  const { priceChanges } = summarizeReorderChanges(items, catalog);
  assert.deepStrictEqual(priceChanges, [{ name: "20L Jug", was: 20000, now: 25000 }]);
});

it("a price decrease is reported too", () => {
  const items = [itemOf("P1", 1, 25000, "20L Jug")];
  const catalog = [productOf("P1", 22000, "20L Jug")];
  const { priceChanges } = summarizeReorderChanges(items, catalog);
  assert.strictEqual(priceChanges.length, 1);
  assert.strictEqual(priceChanges[0].was, 25000);
  assert.strictEqual(priceChanges[0].now, 22000);
});

it("an unchanged price is not reported", () => {
  const { priceChanges } = summarizeReorderChanges(
    [itemOf("P1", 1, 20000, "20L Jug")],
    [productOf("P1", 20000, "20L Jug")]
  );
  assert.deepStrictEqual(priceChanges, []);
});

it("a legacy zero/missing past price is not treated as a change", () => {
  // Some old orderItems may carry 0 or no unitPrice; comparing that to today's
  // real price would spam a bogus 'price changed' notice on every such line.
  const catalog = [productOf("P1", 20000, "20L Jug")];
  assert.deepStrictEqual(summarizeReorderChanges([itemOf("P1", 1, 0, "20L Jug")], catalog).priceChanges, []);
  assert.deepStrictEqual(summarizeReorderChanges([{ productId: "P1", quantity: 1 }], catalog).priceChanges, []);
});

it("a current price of zero is not treated as a change either", () => {
  const { priceChanges } = summarizeReorderChanges(
    [itemOf("P1", 1, 20000, "20L Jug")],
    [productOf("P1", 0, "20L Jug")]
  );
  assert.deepStrictEqual(priceChanges, []);
});

it("an item with no productId is skipped, not thrown on", () => {
  const { quantities, dropped, priceChanges } = summarizeReorderChanges(
    [{ quantity: 2, unitPrice: 100 }, itemOf("P1", 1, 20000, "20L Jug")],
    [productOf("P1", 20000, "20L Jug")]
  );
  assert.deepStrictEqual(quantities, { P1: 1 });
  assert.deepStrictEqual(dropped, []);
  assert.deepStrictEqual(priceChanges, []);
});

it("empty / missing inputs simply produce an empty result", () => {
  assert.deepStrictEqual(summarizeReorderChanges(), { quantities: {}, dropped: [], priceChanges: [] });
  assert.deepStrictEqual(summarizeReorderChanges([], []), { quantities: {}, dropped: [], priceChanges: [] });
});

it("a dropped product and a price change are reported together", () => {
  const items = [itemOf("P1", 2, 20000, "20L Jug"), itemOf("GONE", 1, 9000, "Old Bottle")];
  const catalog = [productOf("P1", 24000, "20L Jug")];
  const { quantities, dropped, priceChanges } = summarizeReorderChanges(items, catalog);
  assert.deepStrictEqual(quantities, { P1: 2 });
  assert.deepStrictEqual(dropped, ["Old Bottle"]);
  assert.deepStrictEqual(priceChanges, [{ name: "20L Jug", was: 20000, now: 24000 }]);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);

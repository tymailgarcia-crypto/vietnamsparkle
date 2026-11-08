import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const filename = "returnDelivery.js";
const source = readFileSync(new URL(filename, import.meta.url), "utf8");
const match = source.match(/^export async function returnDeliveryToAssignment\([^]*?^}/m);
assert.ok(match, `Return action exists in ${filename}`);

async function attempt(status, exists = true) {
  const writes = [];
  const runTransaction = async (_db, callback) => callback({
    get: async () => ({ exists: () => exists, data: () => ({ status, assignedDriverId: "H-005" }) }),
    update: (ref, fields) => writes.push({ ref, fields })
  });
  const invoke = new Function("db", "doc", "runTransaction",
    `${match[0].replace(/^export /, "")}; return returnDeliveryToAssignment("test-order");`);
  const result = invoke({}, (_db, collection, id) => `${collection}/${id}`, runTransaction);
  return { writes, result };
}

test(`${filename}: returning a delivery preserves the driver and financial fields`, async () => {
  const { result, writes } = await attempt("out_for_delivery");
  await result;
  assert.equal(writes.length, 1);
  assert.equal(writes[0].ref, "orders/test-order");
  assert.deepEqual(Object.keys(writes[0].fields).sort(), ["status", "updatedAt"]);
  assert.equal(writes[0].fields.status, "assigned");
});

test(`${filename}: retry after a successful return makes no additional write`, async () => {
  const { result, writes } = await attempt("assigned");
  await result;
  assert.equal(writes.length, 0);
});

for (const status of ["delivered", "cancelled", "pending_approval"]) {
  test(`${filename}: stale screen cannot overwrite a ${status} order`, async () => {
    const { result, writes } = await attempt(status);
    await assert.rejects(result, /no longer out for delivery/);
    assert.equal(writes.length, 0);
  });
}

test(`${filename}: missing order is rejected without a write`, async () => {
  const { result, writes } = await attempt(null, false);
  await assert.rejects(result, /no longer exists/);
  assert.equal(writes.length, 0);
});

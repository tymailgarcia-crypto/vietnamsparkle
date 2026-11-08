process.env.NODE_ENV = "test";
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
initializeApp({ projectId: process.env.GCLOUD_PROJECT || "demo-ai-order" });
const db = getFirestore();
const save = require("./index")._aiOrderTestApi;
const parse = require("./index").parseAiOrder;
const { cleanDraft, phone, owner } = require("./aiOrder");
let passed = 0;
async function test(name, run) { await run(); console.log(`PASS ${name}`); passed++; }
const rejects = (run, code) => assert.rejects(run, error => error.code === code);
const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const input = (extra = {}) => ({ requestId: randomUUID(), name: "Synthetic Varvara", phone: "0329708584", address: "54 Le Thuoc", deliveryDate: date,
  deliveryLocation: { lat: 16.07, lng: 108.24 }, items: [{ productId: "ai-test-jug", quantity: 3 }], reviewedTotal: 210000, ...extra });
async function main() {
  await db.doc("products/ai-test-jug").set({ productName: "Vikoda jug", active: true, unitPrice: 20000, defaultDepositAmount: 50000, containerType: "jug" });
  await test("normalizes local / international phones", async () => { assert.equal(phone("0329708584"), "+84329708584"); assert.equal(phone("84 329 708 584"), "+84329708584"); assert.equal(phone("bad"), null); });
  await test("denies anonymous, customer and driver-only roles", async () => { for (const role of [undefined, "customer", "driver"]) assert.throws(() => owner({ auth: { token: { role } } }), e => e.code === "permission-denied"); });
  await test("AI cannot invent product ids or quantities", async () => { const d = cleanDraft({ items: [{ productId: "invented", quantity: 2.5 }] }, [{ id: "ai-test-jug" }]); assert.equal(d.items[0].productId, ""); assert.equal(d.items[0].quantity, null); });
  const draft = input(); let result;
  await test("atomic new customer/order/items/deposit", async () => {
    result = await save(draft, "owner-test", db);
    const order = (await db.doc(`orders/${result.orderId}`).get()).data();
    assert.equal(order.subtotal, 60000); assert.equal(order.depositTotal, 150000); assert.equal(order.balanceDue, 210000); assert.equal(order.status, "new");
    assert.equal((await db.doc(`customers/${result.customerId}`).get()).data().authUid, null);
    assert.equal((await db.collection("orderItems").where("orderId", "==", result.orderId).get()).size, 1);
    const deposits = await db.collection("depositEvents").where("orderId", "==", result.orderId).get();
    assert.equal(deposits.size, 1); assert.equal(deposits.docs[0].data().qty, 3); assert.equal(deposits.docs[0].data().amount, 150000);
  });
  await test("same request retries once, without duplicate deposits", async () => {
    const [a, b] = await Promise.all([save(draft, "owner-test", db), save(draft, "owner-test", db)]);
    assert.equal(a.orderId, b.orderId); assert.equal((await db.collection("depositEvents").where("orderId", "==", a.orderId).get()).size, 1);
  });
  await test("another caller cannot replay the request", () => rejects(() => save(draft, "different-owner", db), "permission-denied"));
  await test("normalized duplicate phone cannot create customer", () => rejects(() => save(input({ phone: "84329708584" }), "owner-test", db), "already-exists"));
  await test("existing customer order never overwrites profile or auth", async () => {
    await db.doc(`customers/${result.customerId}`).update({ name: "Original name", authUid: "real-customer", notes: "Keep me" });
    const before = (await db.doc(`customers/${result.customerId}`).get()).data();
    const r = await save(input({ customerId: result.customerId, name: "Different name", address: "An order-only address" }), "owner-test", db);
    assert.deepEqual((await db.doc(`customers/${result.customerId}`).get()).data(), before);
    const order = (await db.doc(`orders/${r.orderId}`).get()).data(); assert.equal(order.authUid, "real-customer"); assert.equal(order.customerName, "Original name"); assert.equal(order.address, "An order-only address");
  });
  await test("changed prices require review and leave no writes", async () => {
    const d = input({ customerId: result.customerId, reviewedTotal: 1 });
    await rejects(() => save(d, "owner-test", db), "failed-precondition");
    assert.equal((await db.doc(`orders/ORD-AI-${d.requestId}`).get()).exists, false);
  });
  await test("invalid items, date, pin and unknown customer rejected", async () => {
    for (const extra of [{ items: [] }, { items: [{ productId: "ai-test-jug", quantity: -1 }] }, { items: [{ productId: "invented", quantity: 1 }] }, { deliveryDate: "2026-02-31" }, { deliveryLocation: { lat: 0, lng: 0 } }, { customerId: "missing" }]) {
      await rejects(() => save(input({ customerId: result.customerId, ...extra }), "owner-test", db), "invalid-argument");
    }
  });
  await test("parallel new customer submissions do not create duplicates", async () => {
    const results = await Promise.allSettled([save(input({ phone: "0901234567" }), "owner-test", db), save(input({ phone: "0901234567" }), "owner-test", db)]);
    assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
    assert.equal(results.find(r => r.status === "rejected").reason.code, "already-exists");
  });
  await test("parse only sends catalogue and pasted message, never customer directory", async () => {
    process.env.GEMINI_API_KEY = "synthetic-test-key";
    const originalFetch = global.fetch;
    global.fetch = async (url, options) => {
      const body = JSON.parse(options.body);
      assert.ok(body.systemInstruction.parts[0].text.includes("Vikoda jug"));
      assert.ok(!JSON.stringify(body).includes("Original name"));
      assert.equal(body.generationConfig.responseMimeType, "application/json");
      return { ok: true, status: 200, json: async () => ({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({ name: "Test", phone: "", address: "", deliveryDate: "", notes: "", warnings: [], items: [{ original: "3 vikda jgs", productId: "ai-test-jug", quantity: 3, reason: "Likely typo for Vikoda jug" }] }) }] } }] }) };
    };
    try {
      const result = await parse.run({ auth: { uid: "parse-test", token: { role: "owner" } }, data: { message: "Test, 3 vikda jgs" } });
      assert.equal(result.items[0].productId, "ai-test-jug");
      assert.equal(result.items[0].quantity, 3);
    } finally { global.fetch = originalFetch; }
  });
  await test("parse enforces quota and rejects oversized input", async () => {
    await db.doc("aiOrderUsage/capped").set({ day: date, count: 80 });
    const request = { auth: { uid: "capped", token: { role: "owner" } }, data: { message: "3 jugs" } };
    await rejects(() => parse.run(request), "resource-exhausted");
    await rejects(() => parse.run({ ...request, data: { message: "x".repeat(5001) } }), "invalid-argument");
  });
  console.log(`${passed} AI order checks passed`);
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });

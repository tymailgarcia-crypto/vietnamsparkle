// Firestore rules tests for Inventory phase 1.
//
// /products remains publicly readable for the customer order catalog, so
// supplier cost and exact physical counts must live in owner-only /inventory.
// These tests pin both sides of that boundary and the retained-record lifecycle.
//
// Run from firebase/ while the Firestore emulator is on 127.0.0.1:8080.

import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds
} from "@firebase/rules-unit-testing";
import { readFileSync } from "node:fs";
import { deleteDoc, doc, getDoc, setDoc, updateDoc } from "firebase/firestore";

const PROJECT_ID = "vietnamsparkle-inventory-test";

let passed = 0;
let failed = 0;

async function it(name, fn) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed += 1;
  } catch (error) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${error && error.message ? error.message.split("\n")[0] : error}`);
    failed += 1;
  }
}

const testEnv = await initializeTestEnvironment({
  projectId: PROJECT_ID,
  firestore: {
    rules: readFileSync("firestore.rules", "utf8"),
    host: "127.0.0.1",
    port: 8080
  }
});

await testEnv.clearFirestore();

const owner = testEnv.authenticatedContext("owner-uid", { role: "owner" });
const driver = testEnv.authenticatedContext("driver-uid", { role: "driver", driverId: "DRV-1" });
const customer = testEnv.authenticatedContext("customer-uid", {
  email: "customer@example.test",
  email_verified: true
});
const anon = testEnv.unauthenticatedContext();

const validInventory = {
  productId: "PROD-1",
  onHand: 24,
  reserved: 3,
  available: 21,
  costPrice: 18000,
  updatedByUid: "owner-uid"
};

const validMovement = {
  productId: "PROD-1",
  qty: 6,
  reason: "stock_take_adjustment",
  linkedOrderId: null,
  linkedPurchaseId: null,
  beforeOnHand: 18,
  afterOnHand: 24,
  costPriceBefore: 17000,
  costPriceAfter: 18000,
  byUid: "owner-uid"
};

await testEnv.withSecurityRulesDisabled(async (ctx) => {
  await setDoc(doc(ctx.firestore(), "products", "PROD-1"), {
    productName: "19 L water jug",
    unitPrice: 45000,
    active: true
  });
});

console.log("\n/inventory rules\n");

await it("public customer catalog CAN still read a product", async () => {
  await assertSucceeds(getDoc(doc(anon.firestore(), "products", "PROD-1")));
});

await it("owner CAN create valid inventory", async () => {
  await assertSucceeds(setDoc(doc(owner.firestore(), "inventory", "PROD-1"), validInventory));
});

await it("owner CAN read inventory", async () => {
  await assertSucceeds(getDoc(doc(owner.firestore(), "inventory", "PROD-1")));
});

await it("anonymous customer CANNOT read inventory", async () => {
  await assertFails(getDoc(doc(anon.firestore(), "inventory", "PROD-1")));
});

await it("signed-in customer CANNOT read inventory", async () => {
  await assertFails(getDoc(doc(customer.firestore(), "inventory", "PROD-1")));
});

await it("driver CANNOT read supplier cost from inventory", async () => {
  await assertFails(getDoc(doc(driver.firestore(), "inventory", "PROD-1")));
});

await it("non-owner CANNOT write inventory", async () => {
  await assertFails(setDoc(doc(customer.firestore(), "inventory", "PROD-2"), {
    ...validInventory,
    productId: "PROD-2"
  }));
});

await it("owner CAN save a new valid stock count", async () => {
  await assertSucceeds(updateDoc(doc(owner.firestore(), "inventory", "PROD-1"), {
    onHand: 18,
    available: 15,
    costPrice: 19000
  }));
});

await it("inventory records CANNOT be deleted", async () => {
  await assertFails(deleteDoc(doc(owner.firestore(), "inventory", "PROD-1")));
});

await it("owner CAN append an inventory movement", async () => {
  await assertSucceeds(setDoc(doc(owner.firestore(), "inventoryMovements", "MOV-1"), validMovement));
});

await it("owner CAN read inventory movements", async () => {
  await assertSucceeds(getDoc(doc(owner.firestore(), "inventoryMovements", "MOV-1")));
});

await it("anonymous customer CANNOT read inventory movements", async () => {
  await assertFails(getDoc(doc(anon.firestore(), "inventoryMovements", "MOV-1")));
});

await it("driver CANNOT read supplier-cost movements", async () => {
  await assertFails(getDoc(doc(driver.firestore(), "inventoryMovements", "MOV-1")));
});

await it("customer CANNOT append an inventory movement", async () => {
  await assertFails(setDoc(doc(customer.firestore(), "inventoryMovements", "MOV-CUSTOMER"), validMovement));
});

await it("inventory movements CANNOT be updated", async () => {
  await assertFails(updateDoc(doc(owner.firestore(), "inventoryMovements", "MOV-1"), { qty: 999 }));
});

await it("inventory movements CANNOT be deleted", async () => {
  await assertFails(deleteDoc(doc(owner.firestore(), "inventoryMovements", "MOV-1")));
});

console.log(`\n${passed} passed, ${failed} failed\n`);
await testEnv.cleanup();
process.exit(failed > 0 ? 1 : 0);

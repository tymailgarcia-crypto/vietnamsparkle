import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { mapProduct } from "../firestore/schema.js";

// Deliberately refuses non-local hosts so this convenience command can never
// overwrite the production catalog.
process.env.FIRESTORE_EMULATOR_HOST ||= "127.0.0.1:8080";
if (!/^(127\.0\.0\.1|localhost):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST)) {
  throw new Error(`Refusing to seed non-local Firestore host: ${process.env.FIRESTORE_EMULATOR_HOST}`);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const productsPath = path.resolve(here, "../../sheet-export/products.json");
const rows = JSON.parse(fs.readFileSync(productsPath, "utf8"));
const app = initializeApp({ projectId: "vietnamsparkle-36dfe" }, "emulator-product-seed");
const db = getFirestore(app);
const batch = db.batch();
let count = 0;

for (const row of rows) {
  const id = String(row.product_id || "").trim();
  if (!id) continue;
  batch.set(db.collection("products").doc(id), mapProduct(row), { merge: true });
  count += 1;
}

await batch.commit();
console.log(`Seeded ${count} products into Firestore emulator at ${process.env.FIRESTORE_EMULATOR_HOST}.`);

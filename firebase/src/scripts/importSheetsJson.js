import fs from "fs";
import path from "path";
import { getFirestore } from "../config/firebaseAdmin.js";
import {
  COLLECTIONS,
  mapCustomer,
  mapDailySummary,
  mapDepositEvent,
  mapDocument,
  mapDriver,
  mapExpense,
  mapInquiry,
  mapOrder,
  mapOrderItem,
  mapPayment,
  mapProduct,
  mapPurchase,
  mapReturn
} from "../firestore/schema.js";

function parseArgs(argv) {
  const args = { input: "" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--input") {
      args.input = argv[i + 1] || "";
    }
  }
  return args;
}

function readInputFile(inputPath) {
  if (!inputPath) {
    throw new Error("Pass --input \"C:\\path\\to\\sheet-export\" or a combined JSON file.");
  }
  const resolved = path.resolve(inputPath);
  const stats = fs.statSync(resolved);
  if (stats.isDirectory()) {
    return readInputDirectory(resolved);
  }
  return JSON.parse(fs.readFileSync(resolved, "utf8"));
}

function readJsonFileIfExists(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readInputDirectory(inputDir) {
  const manifestPath = path.join(inputDir, "manifest.json");
  const manifest = fs.existsSync(manifestPath)
    ? JSON.parse(fs.readFileSync(manifestPath, "utf8"))
    : null;

  const data = {
    customers: readJsonFileIfExists(path.join(inputDir, "customers.json")),
    orders: readJsonFileIfExists(path.join(inputDir, "orders.json")),
    orderItems: readJsonFileIfExists(path.join(inputDir, "orderItems.json")),
    products: readJsonFileIfExists(path.join(inputDir, "products.json")),
    helpers: readJsonFileIfExists(path.join(inputDir, "helpers.json")),
    payments: readJsonFileIfExists(path.join(inputDir, "payments.json")),
    deposits: readJsonFileIfExists(path.join(inputDir, "deposits.json")),
    returns: readJsonFileIfExists(path.join(inputDir, "returns.json")),
    purchases: readJsonFileIfExists(path.join(inputDir, "purchases.json")),
    expenses: readJsonFileIfExists(path.join(inputDir, "expenses.json")),
    documents: readJsonFileIfExists(path.join(inputDir, "documents.json")),
    dailySummary: readJsonFileIfExists(path.join(inputDir, "dailySummary.json")),
    inquiries: readJsonFileIfExists(path.join(inputDir, "inquiries.json"))
  };

  if (manifest) {
    data._manifest = manifest;
  }

  return data;
}

async function upsertMany(db, collectionName, rows, idField, mapper) {
  const batchSize = 250;
  for (let i = 0; i < rows.length; i += batchSize) {
    const chunk = rows.slice(i, i + batchSize);
    const batch = db.batch();
    chunk.forEach((row) => {
      const id = String(row[idField] || "").trim();
      if (!id) return;
      batch.set(db.collection(collectionName).doc(id), mapper(row), { merge: true });
    });
    await batch.commit();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const data = readInputFile(args.input);
  const db = getFirestore();

  await upsertMany(db, COLLECTIONS.customers, data.customers || [], "customer_id", mapCustomer);
  await upsertMany(db, COLLECTIONS.orders, data.orders || [], "order_id", mapOrder);
  await upsertMany(db, COLLECTIONS.orderItems, data.orderItems || [], "order_item_id", mapOrderItem);
  await upsertMany(db, COLLECTIONS.products, data.products || [], "product_id", mapProduct);
  await upsertMany(db, COLLECTIONS.drivers, data.helpers || [], "helper_id", mapDriver);
  await upsertMany(db, COLLECTIONS.payments, data.payments || [], "payment_id", mapPayment);
  await upsertMany(db, COLLECTIONS.depositEvents, data.deposits || [], "deposit_event_id", mapDepositEvent);
  await upsertMany(db, COLLECTIONS.returns, data.returns || [], "return_id", mapReturn);
  await upsertMany(db, COLLECTIONS.purchases, data.purchases || [], "purchase_id", mapPurchase);
  await upsertMany(db, COLLECTIONS.expenses, data.expenses || [], "expense_id", mapExpense);
  await upsertMany(db, COLLECTIONS.documents, data.documents || [], "document_id", mapDocument);
  await upsertMany(db, COLLECTIONS.dailySummaries, data.dailySummary || [], "summary_date", mapDailySummary);
  await upsertMany(db, COLLECTIONS.inquiries, data.inquiries || [], "inquiry_id", mapInquiry);

  console.log("Import complete.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

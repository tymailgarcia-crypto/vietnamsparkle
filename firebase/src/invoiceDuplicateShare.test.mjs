import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const invoiceSource = readFileSync(new URL("../web/assets/invoice.js", import.meta.url), "utf8");
const adminSource = readFileSync(new URL("../web/assets/adminApp.js", import.meta.url), "utf8");

test("duplicate warning is not rendered inside the customer invoice", () => {
  assert.doesNotMatch(invoiceSource, /invoice-duplicate-warning/);
  assert.doesNotMatch(invoiceSource, /Avoid a duplicate/);
});

test("Admin warns before either invoice message flow can start", () => {
  assert.match(adminSource, /function confirmRepeatedInvoiceShare\(ctx, nextChannel\)/);
  assert.match(adminSource, /Duplicate message warning/);
  assert.match(adminSource, /if \(!confirmRepeatedInvoiceShare\(ctx, "Email"\)\) return;[\s\S]*?ensureInvoicePdfUploaded\(ctx\)/);
  assert.match(adminSource, /if \(!confirmRepeatedInvoiceShare\(ctx, "WhatsApp"\)\) return;[\s\S]*?window\.open\("", "_blank", "noopener"\)/);
});

test("older share-button uploads also trigger the warning", () => {
  assert.match(adminSource, /collection\(db, "documents"\), where\("entityId", "==", orderId\)/);
  assert.match(adminSource, /\["invoice", "order_confirmation"\]\.includes\(item\.documentType\)/);
  assert.match(adminSource, /order\?\.invoiceLastSharedAt \|\| invoiceState\.previousShare\?\.uploadedAt/);
});

test("successful Admin share preparation is recorded on the order", () => {
  assert.match(adminSource, /invoiceLastSharedAt:\s*serverTimestamp\(\)/);
  assert.match(adminSource, /invoiceLastSharedChannel:\s*channel/);
  assert.match(adminSource, /ensureInvoicePdfUploaded\(ctx\);[\s\S]*?recordInvoiceShare\(ctx, "email"\);[\s\S]*?window\.location\.href/);
  assert.match(adminSource, /ensureInvoicePdfUploaded\(ctx\);[\s\S]*?recordInvoiceShare\(ctx, "whatsapp"\);[\s\S]*?buildWhatsAppShare/);
});

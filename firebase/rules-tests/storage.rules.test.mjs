// Cloud Storage rules tests. Covers the bucket added 2026-07-16 for invoice
// delivery + payment-proof photos.
//
// Run with the emulator (Java is installed but not on PATH — see HANDOFF.md):
//   cd firebase
//   export JAVA_HOME="/c/Program Files/Eclipse Adoptium/jre-21.0.11.10-hotspot"
//   npx firebase emulators:exec --only storage "node rules-tests/storage.rules.test.mjs"
//
// Read the emulator's stderr, not just the pass count. Both latent rules bugs
// found on 2026-07-15 were reported as evaluation errors while every assertion
// still passed.
//
// What these DON'T cover, by design: the tokenized getDownloadURL() path. That
// URL is readable by anyone holding it, without auth, and bypasses these rules
// entirely — it is how a customer opens an invoice from WhatsApp. See the
// header comment in storage.rules.

import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds
} from "@firebase/rules-unit-testing";
import { readFileSync } from "node:fs";
import { ref, uploadBytes, getBytes, deleteObject } from "firebase/storage";

const PROJECT_ID = "vietnamsparkle-storage-test";

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
  storage: {
    rules: readFileSync("storage.rules", "utf8"),
    host: "127.0.0.1",
    port: 9199
  }
});

const owner = testEnv.authenticatedContext("owner-uid", { role: "owner" });
const driver = testEnv.authenticatedContext("driver-uid", { role: "driver", driverId: "DRV-1" });
// A customer token carries no `role` key at all. This is the shape that made
// isOwner() raise an evaluation error before 2026-07-15 — see firestore.rules.
const customer = testEnv.authenticatedContext("customer-uid", { email: "c@example.test", email_verified: true });
const anon = testEnv.unauthenticatedContext();

const pdf = (bytes = 32) => new Uint8Array(bytes).fill(37);
const jpg = (bytes = 32) => new Uint8Array(bytes).fill(255);

const PDF_META = { contentType: "application/pdf" };
const JPG_META = { contentType: "image/jpeg" };

function at(ctx, path) {
  return ref(ctx.storage(), path);
}

console.log("\ninvoices/");

await it("owner CAN upload an invoice PDF", async () => {
  await assertSucceeds(uploadBytes(at(owner, "invoices/ORD-1/invoice-ORD-1-x.pdf"), pdf(), PDF_META));
});

await it("owner CANNOT upload a non-PDF as an invoice", async () => {
  await assertFails(uploadBytes(at(owner, "invoices/ORD-1/sneaky.jpg"), jpg(), JPG_META));
});

await it("owner CANNOT upload an invoice over 5 MB", async () => {
  await assertFails(uploadBytes(at(owner, "invoices/ORD-1/huge.pdf"), pdf(5 * 1024 * 1024 + 1), PDF_META));
});

await it("customer CANNOT upload an invoice", async () => {
  await assertFails(uploadBytes(at(customer, "invoices/ORD-1/forged.pdf"), pdf(), PDF_META));
});

await it("customer CANNOT read an invoice via the SDK path", async () => {
  await assertFails(getBytes(at(customer, "invoices/ORD-1/invoice-ORD-1-x.pdf")));
});

await it("anonymous CANNOT read an invoice via the SDK path", async () => {
  await assertFails(getBytes(at(anon, "invoices/ORD-1/invoice-ORD-1-x.pdf")));
});

console.log("\npayment-proofs/");

await it("owner CAN upload a proof photo", async () => {
  await assertSucceeds(uploadBytes(at(owner, "payment-proofs/ORD-1/PAY-1.jpg"), jpg(), JPG_META));
});

await it("owner CANNOT upload a non-image as a proof", async () => {
  await assertFails(uploadBytes(at(owner, "payment-proofs/ORD-1/PAY-1.pdf"), pdf(), PDF_META));
});

await it("owner CANNOT upload a proof over 10 MB", async () => {
  await assertFails(uploadBytes(at(owner, "payment-proofs/ORD-1/huge.jpg"), jpg(10 * 1024 * 1024 + 1), JPG_META));
});

// Deliberate: /documents in firestore.rules is owner-only, so a driver upload
// would land the file and then fail to record it. Widen both together when the
// driver-side view lands. See the comment in storage.rules.
await it("driver CANNOT upload a proof (documents/ is owner-only)", async () => {
  await assertFails(uploadBytes(at(driver, "payment-proofs/ORD-1/PAY-2.jpg"), jpg(), JPG_META));
});

await it("customer CANNOT upload a proof", async () => {
  await assertFails(uploadBytes(at(customer, "payment-proofs/ORD-1/PAY-3.jpg"), jpg(), JPG_META));
});

await it("customer CANNOT read a proof via the SDK path", async () => {
  await assertFails(getBytes(at(customer, "payment-proofs/ORD-1/PAY-1.jpg")));
});

await it("customer CANNOT delete financial evidence", async () => {
  await assertFails(deleteObject(at(customer, "payment-proofs/ORD-1/PAY-1.jpg")));
});

console.log("\nproduct-images/");

await it("owner CAN upload a product photo", async () => {
  await assertSucceeds(uploadBytes(at(owner, "product-images/P-TEST/photo-1.jpg"), jpg(), JPG_META));
});

await it("owner CANNOT upload a non-image as a product photo", async () => {
  await assertFails(uploadBytes(at(owner, "product-images/P-TEST/sneaky.pdf"), pdf(), PDF_META));
});

await it("owner CANNOT upload a product photo over 10 MB", async () => {
  await assertFails(uploadBytes(at(owner, "product-images/P-TEST/huge.jpg"), jpg(10 * 1024 * 1024 + 1), JPG_META));
});

await it("customer CANNOT upload a product photo", async () => {
  await assertFails(uploadBytes(at(customer, "product-images/P-TEST/vandal.jpg"), jpg(), JPG_META));
});

await it("driver CANNOT upload a product photo", async () => {
  await assertFails(uploadBytes(at(driver, "product-images/P-TEST/nope.jpg"), jpg(), JPG_META));
});

// The PUBLIC storefront loads product photos through the tokenized download
// URL, which bypasses rules by design — the SDK path stays owner-only like
// every other prefix.
await it("anonymous CANNOT read a product photo via the SDK path", async () => {
  await assertFails(getBytes(at(anon, "product-images/P-TEST/photo-1.jpg")));
});

console.log("\ndefault deny");

await it("owner CANNOT write outside the three known prefixes", async () => {
  await assertFails(uploadBytes(at(owner, "random/whatever.jpg"), jpg(), JPG_META));
});

await it("anonymous CANNOT write anywhere", async () => {
  await assertFails(uploadBytes(at(anon, "invoices/ORD-1/anon.pdf"), pdf(), PDF_META));
});

await testEnv.cleanup();

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);

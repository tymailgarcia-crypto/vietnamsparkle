// The only module in the app that writes to Cloud Storage. Every upload lands
// a documents/{id} row alongside the file, so a file is always reachable from
// the ledger and never exists as an orphan blob someone has to go hunting for
// in the console.
//
// Bucket paths and their rules live in firebase/storage.rules. Read the header
// comment there before changing anything here: getDownloadURL() returns a URL
// that anyone can open without signing in, which is what makes invoice links
// work in WhatsApp, and is also the reason nothing sensitive belongs in this
// bucket.
import {
  db,
  doc,
  getDownloadURL,
  serverTimestamp,
  setDoc,
  storage,
  storageRef,
  uploadBytes
} from "./firebaseClient.js";
import { generateInvoicePdf, invoicePdfBlob } from "./invoice.js";
import { buildOrderId } from "./shared.js";

export function buildDocumentId() {
  return buildOrderId("DOC");
}

// Strip anything that would be awkward in a Storage path. Storage tolerates
// most characters, but order ids and filenames end up inside a URL that gets
// pasted into WhatsApp, so keep them boring.
function safeSegment(value, fallback) {
  const cleaned = String(value == null ? "" : value).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || fallback;
}

function extensionFor(file) {
  const fromName = String(file && file.name ? file.name : "").match(/\.([A-Za-z0-9]{1,5})$/);
  if (fromName) return fromName[1].toLowerCase();
  const type = String(file && file.type ? file.type : "");
  if (type === "image/jpeg") return "jpg";
  if (type === "image/png") return "png";
  if (type === "image/webp") return "webp";
  if (type === "image/heic") return "heic";
  return "bin";
}

// documents/{id} is the Sheets-era schema (see src/firestore/schema.js). Its
// driveLink field is left alone on purpose: it means "this file lives on Google
// Drive", which is true of the imported rows and false of everything we write.
// Storage-hosted files carry downloadUrl + storagePath instead, so a reader can
// tell the two eras apart rather than guessing at a URL shape.
async function recordDocument({ entityType, entityId, documentType, downloadUrl, storagePath, contentType, sizeBytes, notes }) {
  const documentId = buildDocumentId();
  await setDoc(doc(db, "documents", documentId), {
    entityType,
    entityId,
    documentType,
    driveLink: null,
    downloadUrl,
    storagePath,
    contentType: contentType || null,
    sizeBytes: sizeBytes == null ? null : Number(sizeBytes),
    uploadedAt: serverTimestamp(),
    notes: notes || null
  });
  return documentId;
}

// Uploads a generated invoice PDF and returns a link the customer can open
// without an account. Overwrites nothing: each generate gets its own timestamped
// object, so an invoice link already sent to a customer keeps resolving to the
// numbers that were on it at the time.
export async function uploadInvoicePdf({ orderId, blob, isDraft }) {
  const order = safeSegment(orderId, "unknown-order");
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const path = `invoices/${order}/invoice-${order}-${stamp}.pdf`;
  const fileRef = storageRef(storage, path);
  await uploadBytes(fileRef, blob, { contentType: "application/pdf" });
  const downloadUrl = await getDownloadURL(fileRef);
  const documentId = await recordDocument({
    entityType: "order",
    entityId: orderId,
    documentType: isDraft ? "order_confirmation" : "invoice",
    downloadUrl,
    storagePath: path,
    contentType: "application/pdf",
    sizeBytes: blob && blob.size,
    notes: null
  });
  return { documentId, downloadUrl, storagePath: path };
}

// Both share buttons need the same uploaded PDF, and the owner clicking
// WhatsApp then email should not mint two objects and two documents rows. The
// signature includes the money, so re-sharing an invoice after a payment lands
// correctly uploads a fresh PDF rather than handing back a stale link.
const invoiceUploadCache = new Map();

function invoiceSignature(ctx) {
  const order = ctx.order || {};
  return [ctx.invoiceNumber, ctx.isDraft, ctx.total, ctx.balanceDue, order.amountPaid, order.status].join("|");
}

export async function ensureInvoicePdfUploaded(ctx) {
  const key = invoiceSignature(ctx);
  const cached = invoiceUploadCache.get(key);
  if (cached) return cached;
  const pdfDoc = await generateInvoicePdf(ctx);
  const result = await uploadInvoicePdf({
    orderId: ctx.invoiceNumber,
    blob: invoicePdfBlob(pdfDoc),
    isDraft: ctx.isDraft
  });
  invoiceUploadCache.set(key, result);
  return result;
}

// Uploads a payment-proof photo. Called BEFORE the payment transaction opens so
// the resulting documentId can be written onto the payments doc as
// proofDocumentId in the same transaction — an upload that fails must not leave
// a payment recorded without the proof the owner thought they attached.
export async function uploadPaymentProof({ orderId, paymentId, file }) {
  const order = safeSegment(orderId, "unknown-order");
  const payment = safeSegment(paymentId, "unknown-payment");
  const path = `payment-proofs/${order}/${payment}.${extensionFor(file)}`;
  const fileRef = storageRef(storage, path);
  await uploadBytes(fileRef, file, { contentType: file.type || "image/jpeg" });
  const downloadUrl = await getDownloadURL(fileRef);
  const documentId = await recordDocument({
    entityType: "payment",
    entityId: paymentId,
    documentType: "payment_proof",
    downloadUrl,
    storagePath: path,
    contentType: file.type || null,
    sizeBytes: file.size,
    notes: `Proof for order ${orderId}`
  });
  return { documentId, downloadUrl, storagePath: path };
}

// Rules cap these; checking client-side too turns a permission-denied stack
// trace into a sentence the owner can act on.
export const MAX_PROOF_BYTES = 10 * 1024 * 1024;
export const MAX_INVOICE_BYTES = 5 * 1024 * 1024;

export function validateProofFile(file) {
  if (!file) return "No file selected.";
  if (!/^image\//.test(file.type || "")) return "Choose a photo — that file is not an image.";
  if (file.size > MAX_PROOF_BYTES) return `Photo is ${(file.size / 1024 / 1024).toFixed(1)} MB. Maximum is 10 MB.`;
  return null;
}

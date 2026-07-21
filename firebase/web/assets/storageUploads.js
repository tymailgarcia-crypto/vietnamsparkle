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

const MAX_IMAGE_EDGE = 1600;
const IMAGE_QUALITY = 0.82;
const KEEP_SMALL_ORIGINAL_BYTES = 350 * 1024;

async function decodeImage(file) {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch (_) {
      // Safari/older Chromium can reject the options object or HEIC input.
    }
  }
  return await new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("This photo format could not be read. Try JPG, PNG, or WebP."));
    };
    image.src = url;
  });
}

function canvasBlob(canvas, type, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

// Camera photos routinely arrive at 4–15 MB even though the UI only displays
// thumbnails and document previews. Resize once in the browser so payment,
// return, and product uploads all share the same storage-saving policy. Small
// originals stay untouched, as does any original that is already smaller than
// the encoded WebP. PDFs never pass through this function.
export async function compressImageForUpload(file) {
  if (!file || !/^image\//.test(file.type || "")) return file;
  if (file.size <= KEEP_SMALL_ORIGINAL_BYTES) return file;

  const image = await decodeImage(file);
  const sourceWidth = Number(image.width || image.naturalWidth || 0);
  const sourceHeight = Number(image.height || image.naturalHeight || 0);
  if (!sourceWidth || !sourceHeight) {
    image.close?.();
    throw new Error("This photo has no readable dimensions.");
  }
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: true });
  if (!context) {
    image.close?.();
    throw new Error("Photo compression is not supported in this browser.");
  }
  context.drawImage(image, 0, 0, width, height);
  image.close?.();
  const blob = await canvasBlob(canvas, "image/webp", IMAGE_QUALITY);
  canvas.width = 1;
  canvas.height = 1;
  if (!blob) throw new Error("The browser could not compress this photo.");
  if (blob.size >= file.size && file.size <= MAX_PROOF_BYTES) return file;

  const originalName = String(file.name || "photo").replace(/\.[^.]+$/, "");
  return new File([blob], `${originalName}.webp`, {
    type: "image/webp",
    lastModified: Date.now()
  });
}

async function preparedImage(file) {
  const compressed = await compressImageForUpload(file);
  if (compressed.size > MAX_PROOF_BYTES) {
    throw new Error(`Photo is still ${(compressed.size / 1024 / 1024).toFixed(1)} MB after compression. Choose a smaller photo.`);
  }
  return compressed;
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
  const uploadFile = await preparedImage(file);
  const order = safeSegment(orderId, "unknown-order");
  const payment = safeSegment(paymentId, "unknown-payment");
  const path = `payment-proofs/${order}/${payment}.${extensionFor(uploadFile)}`;
  const fileRef = storageRef(storage, path);
  await uploadBytes(fileRef, uploadFile, { contentType: uploadFile.type || "image/jpeg" });
  const downloadUrl = await getDownloadURL(fileRef);
  const documentId = await recordDocument({
    entityType: "payment",
    entityId: paymentId,
    documentType: "payment_proof",
    downloadUrl,
    storagePath: path,
    contentType: uploadFile.type || null,
    sizeBytes: uploadFile.size,
    notes: uploadFile.size < file.size ? `Proof for order ${orderId}; compressed from ${file.size} bytes` : `Proof for order ${orderId}`
  });
  return { documentId, downloadUrl, storagePath: path };
}

// P0-07: uploads refund evidence (bank-transfer screenshot or a photographed /
// scanned signed cash acknowledgment) to the create-only refund-proofs/ prefix,
// then returns the metadata attachRefundEvidence records immutably on the case.
// Accepts an image (compressed like other proofs) OR a PDF (bank receipt),
// matching storage.rules; a PDF is uploaded as-is because preparedImage would
// corrupt it. The object path `refund-proofs/<orderId>/<refundId>.<ext>` is
// create-only, so a finalized proof can never be overwritten.
export async function uploadRefundProof({ orderId, refundId, file }) {
  const isImage = String(file.type || "").startsWith("image/");
  const uploadFile = isImage ? await preparedImage(file) : file;
  const order = safeSegment(orderId, "unknown-order");
  const rid = safeSegment(refundId, "unknown-refund");
  const path = `refund-proofs/${order}/${rid}.${extensionFor(uploadFile)}`;
  const fileRef = storageRef(storage, path);
  const snap = await uploadBytes(fileRef, uploadFile, { contentType: uploadFile.type || "application/octet-stream" });
  const downloadUrl = await getDownloadURL(fileRef);
  const meta = (snap && snap.metadata) || {};
  return {
    storagePath: path,
    downloadUrl,
    generation: meta.generation != null ? String(meta.generation) : null,
    md5Hash: meta.md5Hash != null ? String(meta.md5Hash) : null
  };
}

// Uploads the photo of containers collected at delivery. Reuses the
// payment-proofs/ prefix on purpose: storage.rules already scopes that path to
// the owner with the same 10 MB image guard, so container proof needs no new
// rule (touching storage.rules is gated — see AGENTS.md). One photo per return
// (all returned containers fit one frame); a timestamp keeps re-saves distinct.
// Called BEFORE the delivery transaction so the documentId lands on the
// depositEvent's linkedDocumentId in the same commit — a return credit must not
// record without the proof the owner thought they attached.
export async function uploadContainerReturnProof({ orderId, file }) {
  const uploadFile = await preparedImage(file);
  const order = safeSegment(orderId, "unknown-order");
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const path = `payment-proofs/${order}/return-${stamp}.${extensionFor(uploadFile)}`;
  const fileRef = storageRef(storage, path);
  await uploadBytes(fileRef, uploadFile, { contentType: uploadFile.type || "image/jpeg" });
  const downloadUrl = await getDownloadURL(fileRef);
  const documentId = await recordDocument({
    entityType: "order",
    entityId: orderId,
    documentType: "container_return_proof",
    downloadUrl,
    storagePath: path,
    contentType: uploadFile.type || null,
    sizeBytes: uploadFile.size,
    notes: uploadFile.size < file.size ? `Containers returned for order ${orderId}; compressed from ${file.size} bytes` : `Containers returned for order ${orderId}`
  });
  return { documentId, downloadUrl, storagePath: path };
}

// Uploads a product catalog photo from /catalog.html. Timestamped object per
// upload: replacing a photo mints a new URL and the old blob stays behind,
// consistent with the bucket's no-cleanup policy (ROADMAP → Storage → still
// open) — and it means a cached storefront page keeps rendering its image.
// The tokenized downloadUrl lands on products/{id}.imageUrl, which is how the
// PUBLIC storefront reads it (tokens bypass storage.rules by design; product
// photos are public content anyway).
export async function uploadProductImage({ productId, file }) {
  const uploadFile = await preparedImage(file);
  const product = safeSegment(productId, "unknown-product");
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const path = `product-images/${product}/photo-${stamp}.${extensionFor(uploadFile)}`;
  const fileRef = storageRef(storage, path);
  await uploadBytes(fileRef, uploadFile, { contentType: uploadFile.type || "image/jpeg" });
  const downloadUrl = await getDownloadURL(fileRef);
  const documentId = await recordDocument({
    entityType: "product",
    entityId: productId,
    documentType: "product_image",
    downloadUrl,
    storagePath: path,
    contentType: uploadFile.type || null,
    sizeBytes: uploadFile.size,
    notes: uploadFile.size < file.size ? `Compressed from ${file.size} bytes` : null
  });
  return { documentId, downloadUrl, storagePath: path };
}

// Rules cap these; checking client-side too turns a permission-denied stack
// trace into a sentence the owner can act on.
export const MAX_PROOF_BYTES = 10 * 1024 * 1024;
export const MAX_INVOICE_BYTES = 5 * 1024 * 1024;
export const MAX_SOURCE_IMAGE_BYTES = 30 * 1024 * 1024;

export function validateProofFile(file, { allowPdf = false } = {}) {
  if (!file) return "No file selected.";
  const isImage = /^image\//.test(file.type || "");
  const isPdf = (file.type || "") === "application/pdf";
  if (!isImage && !(allowPdf && isPdf)) {
    return allowPdf ? "Choose an image or a PDF." : "Choose a photo — that file is not an image.";
  }
  if (file.size > MAX_SOURCE_IMAGE_BYTES) return `File is ${(file.size / 1024 / 1024).toFixed(1)} MB. Maximum source size is 30 MB.`;
  return null;
}

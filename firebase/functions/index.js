// Cloud Functions for the water-delivery ops app.
//
// Exports:
//   submitPublicOrder — HTTPS callable that takes a client-supplied cart +
//     customer form and writes the order + line items using SERVER-read
//     product prices. Closes the "1 VND per jug" attack where a raw
//     Firestore write bypassed the price check (rules only enforced
//     arithmetic consistency, not that unitPrice matched products/{id}.unitPrice).
//
//   nightlyReconcileOrderMath — scheduled job (03:00 Asia/Ho_Chi_Minh) that
//     recomputes amountPaid / balanceDue / paymentStatus on every non-cancelled
//     order from the actual sum of its payments docs. Any drift is fixed in
//     a Firestore transaction and logged to reconciliationReports/{runId}.
//
// The WhatsApp webhook + order-link resolver used to live here. They were
// pulled on 2026-07-15 because their secrets resolved to "" in production,
// which made the signature check forgeable by anyone. Source and the
// conditions for bringing them back are in whatsapp.parked.js (not imported,
// so it never deploys).
//
//   mergeCustomers — owner-only callable that folds one customer doc (fromId)
//     into another (toId). Re-keys every child record (orders, orderItems,
//     payments, depositEvents, returns, inquiries) from fromId → toId, copies
//     the source's authUid onto the target when the target has none, then
//     archives the source with archived:true + mergedInto:toId. Compliance
//     rule blocks hard-delete of customer docs, so archive is the terminal
//     state. Idempotent: re-running on an already-archived source is a no-op.

const { onCall, HttpsError } = require("firebase-functions/https");
const { onSchedule } = require("firebase-functions/scheduler");
const { logger, setGlobalOptions } = require("firebase-functions");
const { getApp, initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue, FieldPath } = require("firebase-admin/firestore");

setGlobalOptions({ region: "us-central1", maxInstances: 10 });

// Lazy-init pattern: only initialize the Admin SDK the first time a handler
// runs, not at module load. Keeps CLI discovery fast and avoids the
// "Cannot determine backend specification. Timeout" error during deploy.
//
// Probe with `getApp()` (throws if no default app) rather than
// `getApps().length` — in firebase-admin v13, another module can seed the
// apps list with a placeholder so `length > 0` is truthy while there's
// still no default app registered, and `getFirestore()` then blows up.
let _db = null;
function db() {
  if (!_db) {
    try { getApp(); } catch (_) { initializeApp(); }
    _db = getFirestore();
  }
  return _db;
}

// --- Helpers (mirror shared.js so client and server generate matching ids) ---

function normalizePhone(value) {
  return String(value || "").replace(/\D+/g, "");
}

function normalizePhoneE164VN(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const cleanedPlus = raw.replace(/[^\d+]/g, "");
  if (/^\+\d{6,15}$/.test(cleanedPlus)) return cleanedPlus;
  const digits = raw.replace(/\D+/g, "");
  if (!digits) return null;
  if (digits.startsWith("84") && digits.length >= 11) return "+" + digits;
  if (digits.startsWith("0") && digits.length >= 10) return "+84" + digits.slice(1);
  if (digits.length === 9) return "+84" + digits;
  return null;
}

function buildCustomerId(phone) {
  const norm = normalizePhoneE164VN(phone) || normalizePhone(phone);
  if (!norm) return "";
  return "CUS-" + norm.replace(/\D+/g, "");
}

function buildOrderId(prefix) {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const random = Math.floor(Math.random() * 9000 + 1000);
  return `${prefix}-${stamp}-${random}`;
}

// --- The callable ---

exports.submitPublicOrder = onCall(async (request) => {
  const data = request.data || {};
  const authUid = request.auth ? request.auth.uid : null;
  const authEmail = request.auth && request.auth.token ? request.auth.token.email : null;

  // ---- Customer/order fields --------------------------------------------
  const customer = data.customer || {};
  const name = String(customer.name || "").trim();
  const phone = String(customer.phone || "").trim();
  const address = String(customer.address || "").trim();
  const deliveryDate = String(customer.deliveryDate || "").trim();
  const deliveryWindow = String(customer.deliveryWindow || "").trim();
  const notes = String(customer.notes || "").trim();
  const email = String(customer.email || "").trim();
  const rawLocation = customer.deliveryLocation;
  let deliveryLocation = null;
  if (rawLocation == null) {
    throw new HttpsError("failed-precondition", "Confirm the delivery address on Google Maps before ordering.");
  } else {
    const lat = Number(rawLocation.lat);
    const lng = Number(rawLocation.lng);
    const formattedAddress = String(rawLocation.formattedAddress || "").trim();
    if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
      throw new HttpsError("invalid-argument", "Invalid delivery map location.");
    }
    deliveryLocation = {
      lat,
      lng,
      formattedAddress: formattedAddress.slice(0, 499) || address,
      source: "customer_google_maps",
      confirmedAt: new Date().toISOString()
    };
  }

  if (name.length < 2 || name.length >= 200) {
    throw new HttpsError("invalid-argument", "Name must be 2–199 characters.");
  }
  if (!/^[+0-9 ()\-]{6,39}$/.test(phone) || !/\d/.test(phone)) {
    throw new HttpsError("invalid-argument", "Phone must be 6–39 characters with at least one digit.");
  }
  if (address.length < 5 || address.length >= 500) {
    throw new HttpsError("invalid-argument", "Address must be 5–499 characters.");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(deliveryDate)) {
    throw new HttpsError("invalid-argument", "Delivery date must be YYYY-MM-DD.");
  }
  if (deliveryWindow.length >= 200) {
    throw new HttpsError("invalid-argument", "Delivery window too long.");
  }
  if (notes.length >= 2000) {
    throw new HttpsError("invalid-argument", "Notes too long.");
  }
  if (email && email.length >= 200) {
    throw new HttpsError("invalid-argument", "Email too long.");
  }

  // ---- Items ------------------------------------------------------------
  const rawItems = Array.isArray(data.items) ? data.items : [];
  if (!rawItems.length) {
    throw new HttpsError("invalid-argument", "Select at least one item.");
  }
  if (rawItems.length > 50) {
    throw new HttpsError("invalid-argument", "Too many items in one order.");
  }
  const parsed = rawItems.map((it) => ({
    productId: String((it && it.productId) || ""),
    quantity: Math.floor(Number((it && it.quantity) || 0))
  }));
  if (parsed.some((p) => !p.productId || p.quantity <= 0 || p.quantity > 9999)) {
    throw new HttpsError("invalid-argument", "Invalid product id or quantity.");
  }

  // ---- Read canonical product data server-side --------------------------
  const uniqueIds = Array.from(new Set(parsed.map((p) => p.productId)));
  const snaps = await Promise.all(
    uniqueIds.map((id) => db().doc(`products/${id}`).get())
  );
  const productsById = {};
  snaps.forEach((snap) => {
    if (snap.exists) productsById[snap.id] = snap.data();
  });

  for (const line of parsed) {
    const prod = productsById[line.productId];
    if (!prod) {
      throw new HttpsError("failed-precondition", `Unknown product: ${line.productId}.`);
    }
    if (prod.active !== true) {
      throw new HttpsError("failed-precondition", `Product ${line.productId} is not currently available.`);
    }
    if (!(Number(prod.unitPrice) >= 0)) {
      throw new HttpsError("failed-precondition", `Product ${line.productId} has no price on file.`);
    }
  }

  // ---- Build items with server prices, compute totals -------------------
  const items = parsed.map((line) => {
    const prod = productsById[line.productId];
    const unitPrice = Number(prod.unitPrice || 0);
    const depositPerUnit = Number(prod.defaultDepositAmount || 0);
    return {
      productId: line.productId,
      productName: String(prod.productName || ""),
      quantity: line.quantity,
      unitPrice,
      lineTotal: unitPrice * line.quantity,
      depositPerUnit
    };
  });

  const subtotal = items.reduce((s, i) => s + i.lineTotal, 0);
  const depositTotal = items.reduce((s, i) => s + i.depositPerUnit * i.quantity, 0);
  const balanceDue = subtotal + depositTotal;

  if (subtotal <= 0 || subtotal >= 100000000) {
    throw new HttpsError("failed-precondition", "Order subtotal out of range.");
  }
  if (depositTotal < 0 || depositTotal >= 100000000) {
    throw new HttpsError("failed-precondition", "Deposit total out of range.");
  }

  // ---- Canonical customer id (phone preferred) --------------------------
  const customerId = buildCustomerId(phone) || (authUid ? `CUS-${authUid}` : null);
  if (!customerId) {
    throw new HttpsError("invalid-argument", "Could not derive a customer id from the phone number.");
  }

  const orderId = buildOrderId("WEB");
  const nowIso = new Date().toISOString();

  const batch = db().batch();

  batch.set(db().doc(`orders/${orderId}`), {
    createdAt: nowIso,
    sourceChannel: "website",
    customerId,
    customerName: name,
    phone,
    // Prefer the signed-in email if we have it — it's verified.
    email: authEmail || (email || null),
    authUid: authUid || null,
    address,
    deliveryLocation,
    deliveryDate,
    deliveryWindow,
    assignedDriverId: null,
    status: "pending_approval",
    subtotal,
    depositTotal,
    amountPaid: 0,
    balanceDue,
    // subtotal>0 is enforced above, so unpaid is correct.
    paymentStatus: "unpaid",
    notes,
    createdAtServer: FieldValue.serverTimestamp()
  });

  items.forEach((line) => {
    batch.set(db().doc(`orderItems/${buildOrderId("ITEM")}`), {
      orderId,
      authUid: authUid || null,
      productId: line.productId,
      productName: line.productName,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      lineTotal: line.lineTotal
    });
  });

  await batch.commit();

  return { orderId };
});

// --- Nightly reconciliation ----------------------------------------------
//
// Mirrors paymentStatusFor() in web/assets/shared.js and orderMathValid() in
// firestore.rules. Keep the three in sync — the rules will reject any write
// that violates this derivation, so the reconciler must produce identical math.
function paymentStatusFor(amountPaid, balanceDue) {
  if (balanceDue <= 0) return "paid";
  if (Number(amountPaid || 0) > 0) return "partial";
  return "unpaid";
}

async function aggregatePaymentsByOrder() {
  const byOrder = new Map();
  let cursor = null;
  const pageSize = 500;
  while (true) {
    let q = db().collection("payments").orderBy(FieldPath.documentId()).limit(pageSize);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    if (snap.empty) break;
    snap.forEach((d) => {
      const p = d.data() || {};
      const orderId = String(p.orderId || "");
      if (!orderId) return;
      // Deferred payments carry amount:0 by convention, so summing them in is
      // a no-op — no filter needed. If a stray non-zero deferred slipped in,
      // it still represents money-in-hand from the driver's perspective.
      const amt = Number(p.amount || 0);
      if (!Number.isFinite(amt)) return;
      byOrder.set(orderId, (byOrder.get(orderId) || 0) + amt);
    });
    if (snap.size < pageSize) break;
    cursor = snap.docs[snap.docs.length - 1];
  }
  return byOrder;
}

exports.nightlyReconcileOrderMath = onSchedule(
  {
    schedule: "0 3 * * *",
    timeZone: "Asia/Ho_Chi_Minh",
    memory: "512MiB",
    timeoutSeconds: 540
  },
  async () => {
    const runId = "run-" + new Date().toISOString().replace(/[:.]/g, "-");
    const runRef = db().doc(`reconciliationReports/${runId}`);
    await runRef.set({
      startedAt: FieldValue.serverTimestamp(),
      status: "running"
    });

    const stats = { scanned: 0, skipped: 0, drifted: 0, fixed: 0, failed: 0 };

    let paymentsByOrder;
    try {
      paymentsByOrder = await aggregatePaymentsByOrder();
    } catch (err) {
      await runRef.set({
        finishedAt: FieldValue.serverTimestamp(),
        status: "failed",
        error: String((err && err.message) || err)
      }, { merge: true });
      logger.error("nightlyReconcileOrderMath: payments scan failed", err);
      throw err;
    }

    let cursor = null;
    const pageSize = 200;
    while (true) {
      let q = db().collection("orders").orderBy(FieldPath.documentId()).limit(pageSize);
      if (cursor) q = q.startAfter(cursor);
      const snap = await q.get();
      if (snap.empty) break;

      for (const orderDoc of snap.docs) {
        stats.scanned += 1;
        const order = orderDoc.data() || {};

        if (order.testFixture === true || order.status === "cancelled") {
          stats.skipped += 1;
          continue;
        }

        const subtotal = Number(order.subtotal || 0);
        const depositTotal = Number(order.depositTotal || 0);
        const scanSum = paymentsByOrder.get(orderDoc.id) || 0;
        const expectedBalance = subtotal + depositTotal - scanSum;
        const expectedStatus = paymentStatusFor(scanSum, expectedBalance);

        const storedAmount = Number(order.amountPaid || 0);
        const storedBalance = Number(order.balanceDue || 0);
        const storedStatus = String(order.paymentStatus || "");

        if (storedAmount === scanSum
          && storedBalance === expectedBalance
          && storedStatus === expectedStatus) {
          continue;
        }

        stats.drifted += 1;

        try {
          const fixed = await reconcileOne(orderDoc.id, runId);
          if (fixed) stats.fixed += 1;
        } catch (err) {
          stats.failed += 1;
          logger.error("nightlyReconcileOrderMath: fix failed", {
            orderId: orderDoc.id,
            error: String((err && err.message) || err)
          });
        }
      }

      if (snap.size < pageSize) break;
      cursor = snap.docs[snap.docs.length - 1];
    }

    await runRef.set({
      finishedAt: FieldValue.serverTimestamp(),
      status: "ok",
      ...stats
    }, { merge: true });

    logger.info("nightlyReconcileOrderMath complete", { runId, ...stats });
  }
);

// --- Merge two customer docs --------------------------------------------

// Child collections that carry a customerId denormalization. Each is walked
// in pages and re-keyed to the target during merge. orderItems is intentionally
// absent — those are keyed by orderId, not customerId, so they ride along when
// their parent order gets re-keyed (we stamp authUid on them separately).
const CHILDREN_WITH_CUSTOMER_ID = [
  "orders",
  "payments",
  "depositEvents",
  "returns",
  "inquiries"
];

async function rekeyChildrenByCustomerId(collectionName, fromId, toId, newAuthUid) {
  let scanned = 0;
  let updated = 0;
  let cursor = null;
  const pageSize = 300;
  while (true) {
    let q = db().collection(collectionName)
      .where("customerId", "==", fromId)
      .orderBy(FieldPath.documentId())
      .limit(pageSize);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    if (snap.empty) break;
    const batch = db().batch();
    snap.forEach((docSnap) => {
      scanned += 1;
      const patch = { customerId: toId, updatedAt: new Date().toISOString() };
      // Only stamp authUid when we have a target uid AND the child doesn't
      // already carry a uid. Overwriting a real authUid would silently
      // reassign someone else's history.
      if (newAuthUid && !docSnap.data().authUid) {
        patch.authUid = newAuthUid;
      }
      batch.update(docSnap.ref, patch);
      updated += 1;
    });
    await batch.commit();
    if (snap.size < pageSize) break;
    cursor = snap.docs[snap.docs.length - 1];
  }
  return { scanned, updated };
}

async function stampAuthUidOnOrderItems(orderIds, newAuthUid) {
  if (!newAuthUid || !orderIds.length) return { updated: 0 };
  let updated = 0;
  // Firestore `in` queries cap at 30 values, so chunk.
  for (let i = 0; i < orderIds.length; i += 30) {
    const chunk = orderIds.slice(i, i + 30);
    const snap = await db().collection("orderItems").where("orderId", "in", chunk).get();
    if (snap.empty) continue;
    const batch = db().batch();
    snap.forEach((docSnap) => {
      if (docSnap.data().authUid) return;
      batch.update(docSnap.ref, { authUid: newAuthUid });
      updated += 1;
    });
    await batch.commit();
  }
  return { updated };
}

exports.mergeCustomers = onCall(async (request) => {
  const authUid = request.auth ? request.auth.uid : null;
  const authRole = request.auth && request.auth.token ? request.auth.token.role : null;
  if (!authUid || authRole !== "owner") {
    throw new HttpsError("permission-denied", "Only the owner can merge customer records.");
  }

  const data = request.data || {};
  const fromId = String(data.fromId || "").trim();
  const toId = String(data.toId || "").trim();
  if (!fromId || !toId) {
    throw new HttpsError("invalid-argument", "fromId and toId are required.");
  }
  if (fromId === toId) {
    throw new HttpsError("invalid-argument", "fromId and toId must differ.");
  }

  const fromRef = db().doc(`customers/${fromId}`);
  const toRef = db().doc(`customers/${toId}`);
  const [fromSnap, toSnap] = await Promise.all([fromRef.get(), toRef.get()]);
  if (!fromSnap.exists) {
    throw new HttpsError("not-found", `Source customer ${fromId} not found.`);
  }
  if (!toSnap.exists) {
    throw new HttpsError("not-found", `Target customer ${toId} not found.`);
  }
  const fromData = fromSnap.data() || {};
  const toData = toSnap.data() || {};
  if (fromData.archived === true) {
    // Idempotent: nothing to do, but return the state so the client sees success.
    return { ok: true, alreadyArchived: true, fromId, toId, rekeyed: {} };
  }

  // Both docs might have an authUid — refuse rather than silently drop one.
  // The owner has to pick which side wins (usually: archive the stub, keep
  // the real doc; if both are stubs from separate sign-ins, the merge is
  // ambiguous and should be resolved out-of-band by deleting a test fixture
  // or asking the human which uid is correct).
  const preservedAuthUid = toData.authUid || fromData.authUid || null;
  if (fromData.authUid && toData.authUid && fromData.authUid !== toData.authUid) {
    throw new HttpsError(
      "failed-precondition",
      "Both customers already have separate authUids — cannot merge without losing one. Investigate manually."
    );
  }

  const rekeyStats = {};
  for (const coll of CHILDREN_WITH_CUSTOMER_ID) {
    rekeyStats[coll] = await rekeyChildrenByCustomerId(coll, fromId, toId, preservedAuthUid);
  }

  // orderItems is keyed by orderId, not customerId, but carries authUid.
  // Re-fetch the re-keyed orders' ids to stamp any missing authUid on their
  // items. Only done when we actually have a uid to stamp.
  if (preservedAuthUid) {
    const orderSnap = await db().collection("orders").where("customerId", "==", toId).get();
    const orderIds = orderSnap.docs.map((d) => d.id);
    rekeyStats.orderItems = await stampAuthUidOnOrderItems(orderIds, preservedAuthUid);
  } else {
    rekeyStats.orderItems = { updated: 0 };
  }

  const nowIso = new Date().toISOString();

  // Copy authUid to the target if it wasn't there — the source's uid is the
  // canonical binding the customer will sign in with going forward.
  const toPatch = { updatedAt: nowIso };
  if (!toData.authUid && preservedAuthUid) {
    toPatch.authUid = preservedAuthUid;
  }
  // Merge email/phone if target is missing them — keeps auto-link paths alive.
  if (!toData.email && fromData.email) toPatch.email = fromData.email;
  if (!toData.phone && fromData.phone) toPatch.phone = fromData.phone;
  await toRef.update(toPatch);

  // Archive the source. authUid must move OFF the source so accountApp's
  // findByAuthUid stops resolving to this archived stub on the next sign-in.
  // email/phone are cleared (originals preserved as preMerge* for audit) so
  // accountApp's findUnclaimedByEmail can't re-claim the archived stub for a
  // future sign-in that resurfaces the same email (e.g. same user, new uid).
  // All financial records have been re-keyed to `toId`, so the stub no longer
  // anchors any transaction — retention obligations are satisfied by the
  // target + the mergedInto pointer here.
  await fromRef.update({
    archived: true,
    mergedInto: toId,
    mergedAt: nowIso,
    mergedBy: authUid,
    authUid: null,
    email: null,
    phone: null,
    preMergeEmail: fromData.email || null,
    preMergePhone: fromData.phone || null,
    updatedAt: nowIso
  });

  return { ok: true, fromId, toId, preservedAuthUid, rekeyed: rekeyStats };
});

async function reconcileOne(orderId, runId) {
  return db().runTransaction(async (tx) => {
    const orderRef = db().doc(`orders/${orderId}`);
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists) return false;
    const order = orderSnap.data() || {};
    if (order.testFixture === true || order.status === "cancelled") return false;

    // Re-aggregate inside the transaction so a payment that landed between
    // the initial scan and now is included. tx.get(query) locks the read set.
    const paymentsSnap = await tx.get(
      db().collection("payments").where("orderId", "==", orderId)
    );
    let sum = 0;
    paymentsSnap.forEach((d) => {
      const amt = Number((d.data() || {}).amount || 0);
      if (Number.isFinite(amt)) sum += amt;
    });

    const subtotal = Number(order.subtotal || 0);
    const depositTotal = Number(order.depositTotal || 0);
    const expectedAmountPaid = sum;
    const expectedBalance = subtotal + depositTotal - expectedAmountPaid;
    const expectedStatus = paymentStatusFor(expectedAmountPaid, expectedBalance);

    const storedAmount = Number(order.amountPaid || 0);
    const storedBalance = Number(order.balanceDue || 0);
    const storedStatus = String(order.paymentStatus || "");

    if (storedAmount === expectedAmountPaid
      && storedBalance === expectedBalance
      && storedStatus === expectedStatus) {
      // Drift resolved by a concurrent write between the initial scan and
      // now — nothing to do. Not counted as fixed.
      return false;
    }

    const driftRef = db().doc(`reconciliationReports/${runId}/drifts/${orderId}`);
    tx.set(driftRef, {
      orderId,
      before: {
        amountPaid: storedAmount,
        balanceDue: storedBalance,
        paymentStatus: storedStatus
      },
      after: {
        amountPaid: expectedAmountPaid,
        balanceDue: expectedBalance,
        paymentStatus: expectedStatus
      },
      paymentsCount: paymentsSnap.size,
      subtotal,
      depositTotal,
      at: FieldValue.serverTimestamp()
    });

    tx.update(orderRef, {
      amountPaid: expectedAmountPaid,
      balanceDue: expectedBalance,
      paymentStatus: expectedStatus,
      reconciledAt: FieldValue.serverTimestamp(),
      reconciledRunId: runId
    });

    return true;
  });
}

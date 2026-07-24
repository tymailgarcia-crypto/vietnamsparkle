// Cloud Functions for the water-delivery ops app.
//
// Exports:
//   submitPublicOrder — HTTPS callable that takes a client-supplied cart +
//     customer form and writes the order + line items using SERVER-read
//     product prices. Closes the "1 VND per jug" attack where a raw
//     Firestore write bypassed the price check (rules only enforced
//     arithmetic consistency, not that unitPrice matched products/{id}.unitPrice).
//     Idempotent per {authUid, submissionKey} via orderSubmissions/{uid}__{key}
//     (P0-02) — a retry of a committed-but-unacknowledged order returns the
//     original order instead of creating a duplicate.
//
//   nightlyReconcileOrderMath — scheduled job (03:00 Asia/Ho_Chi_Minh) that
//     recomputes amountPaid / balanceDue / paymentStatus on every non-cancelled
//     order from the actual sum of its payments docs. Any drift is fixed in
//     a Firestore transaction and logged to reconciliationReports/{runId}.
//
//   reconcileOnPaymentWrite — Firestore trigger (asia-east2) that reconciles a
//     single order the instant one of its payments is written, so drift is
//     corrected in seconds instead of waiting for the nightly job. Normally a
//     no-op (in-app payment writes update the order in the same transaction);
//     it catches Admin-SDK/console writes that bypass the atomic path. Genuine
//     corrections land in reconciliationEvents, not reconciliationReports.
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
const { onDocumentWritten } = require("firebase-functions/firestore");
const { logger, setGlobalOptions } = require("firebase-functions");
const { getApp, initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue, FieldPath } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");
const {
  vnd,
  computeRefundRequired,
  refundStatusFor,
  computeReductionCancellation
} = require("./cancellationMath");

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

// --- Owner phone alerts (FCM web push) --------------------------------------
//
// Pushes a notification to every device the owner registered from the dashboard
// (pushTokens/{token}, owner-only rule). Sends DATA-ONLY messages: the service
// worker (web/firebase-messaging-sw.js) reads payload.data and builds the
// notification itself, so display is identical foreground/background and there
// is no double-notify. NEVER throw out of here — an alert failing must never
// break the order/refund/reconciliation path that triggered it, so every call
// site wraps this and it also swallows its own errors.
//
// Prunes tokens FCM reports as dead (uninstalled app, revoked permission) so the
// collection doesn't accumulate addresses that will never deliver again.
async function sendOwnerPush({ title, body, url, tag, kind }) {
  try {
    const snap = await db().collection("pushTokens").get();
    let docs = snap.docs.filter((d) => typeof d.get("token") === "string" && d.get("token"));
    // Per-phone opt-out: each device may store prefs.{newOrder,money,refund}.
    // Unset means "on" (opt-out model), so an older token with no prefs still
    // gets everything. `kind` unset (e.g. the test button) skips filtering and
    // always sends.
    if (kind) {
      docs = docs.filter((d) => {
        const prefs = d.get("prefs");
        return !prefs || prefs[kind] !== false;
      });
    }
    if (!docs.length) return { sent: 0, pruned: 0 };
    const tokens = docs.map((d) => d.get("token"));
    const link = String(url || "/admin.html");
    const resp = await getMessaging().sendEachForMulticast({
      tokens,
      data: {
        title: String(title || "Vietnam Sparkle"),
        body: String(body || ""),
        url: link,
        tag: String(tag || "")
      },
      webpush: {
        headers: { Urgency: "high" },
        fcmOptions: { link }
      }
    });
    const dead = [];
    resp.responses.forEach((r, i) => {
      const code = r.success ? null : (r.error && r.error.code);
      if (code === "messaging/registration-token-not-registered"
        || code === "messaging/invalid-registration-token"
        || code === "messaging/invalid-argument") {
        dead.push(docs[i].ref);
      }
    });
    await Promise.all(dead.map((ref) => ref.delete().catch(() => {})));
    return { sent: resp.successCount, failed: resp.failureCount, pruned: dead.length };
  } catch (err) {
    logger.error("sendOwnerPush failed", { error: String((err && err.message) || err) });
    return { sent: 0, error: true };
  }
}

function formatVnd(n) {
  const v = Math.round(Number(n) || 0);
  return v.toLocaleString("en-US") + "₫";
}

// Owner-only "prove the phone alerts work" button on the dashboard. Fires the
// exact same push path a real order would, so a successful test means real
// alerts will land too. Returns the delivery counts so the page can tell the
// owner whether any device actually received it (0 sent = no registered phone,
// or every token is dead). Defined here, next to sendOwnerPush, on purpose.
exports.sendTestPush = onCall(async (request) => {
  requireOwner(request);
  const result = await sendOwnerPush({
    title: "Test alert ✅",
    body: "If you can see this on your phone, order and money alerts will reach you too.",
    url: "/admin.html",
    tag: "test-alert"
  });
  return result || { sent: 0 };
});

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

// --- Signed-in customer identity (P0-04) -----------------------------------
//
// A signed-in customer's identity is anchored to their auth uid, NOT the phone
// they typed into the order form. Keying on the phone let a one-digit typo (or
// an edited number) either split one customer into two records or — worse —
// route the order onto a STRANGER whose phone happened to match, whose profile
// the owner's routine approval then overwrote. Since ordering now requires
// sign-in (P0-01) every order carries an authUid, so we can always resolve the
// customer's own record from it and treat the phone as a plain contact field.
//
// Pure decision, split out so it can be unit-tested without the emulator:
// given the docs currently linked to this uid, pick the customer's stable id.
function pickSignedInCustomerId(authUid, linkedDocs) {
  // A live linked doc IS the customer's canonical record (whether CUS-<uid> or
  // a claimed CUS-<E164>). mergeCustomers clears authUid off archived sources,
  // so there is normally at most one; guard against a stray archived hit anyway.
  const live = (linkedDocs || []).find((d) => d && d.id && d.archived !== true);
  if (live) return live.id;
  // No linked doc yet (first order before accountApp minted the stub, or an
  // owner-created doc the customer hasn't claimed): a uid-derived id, which can
  // only ever be this customer's. NEVER CUS-<phone> for a signed-in order —
  // that is exactly the collision this closes.
  return `CUS-${authUid}`;
}

async function resolveSignedInCustomerId(authUid) {
  const snap = await db().collection("customers").where("authUid", "==", authUid).get();
  const docs = snap.docs.map((d) => ({ id: d.id, archived: (d.data() || {}).archived === true }));
  return pickSignedInCustomerId(authUid, docs);
}

// --- Order approval + deposit charging, atomically (P0-06) ------------------
//
// The account-takeover gate, relocated from adminApp.js to the server when
// approval moved into this callable. Read "Audit follow-ups → Critical" in
// ROADMAP before touching it. It decides whether approval may stamp an order's
// authUid / verified email onto the customer doc: ONLY a brand-new doc, or one
// already owned by this same uid. Never an existing doc owned by nobody — the
// person who typed a phone into the order form is not proven to own that phone,
// and stamping their uid/email onto a stranger's unclaimed record hands it over.
// Firestore rules cannot catch this (the owner performs the write), so this pure
// predicate is the guard. Pinned by rules-tests/authuid-linking.test.mjs.
function canLinkAuthUidToCustomer(orderAuthUid, existingData) {
  return !!orderAuthUid && (!existingData || existingData.authUid === orderAuthUid);
}

// Mirror of shared.js computeDepositBreakdown — one charge per returnable
// container type, priced from the canonical products doc (server-read, so an
// owner-side price tweak can't inflate a deposit charge). Products with no
// containerType or a zero deposit (accessories) contribute nothing.
function computeDepositBreakdown(items, productsById) {
  const byType = {};
  items.forEach((item) => {
    const product = productsById[item.productId];
    const containerType = (product && product.containerType) || item.containerType || null;
    const deposit = Number((product ? product.defaultDepositAmount : item.defaultDepositAmount) || 0);
    if (!containerType || deposit <= 0) return;
    const qty = Number(item.quantity || 0);
    if (qty <= 0) return;
    if (!byType[containerType]) byType[containerType] = { containerType, qty: 0, amount: 0 };
    byType[containerType].qty += qty;
    byType[containerType].amount += qty * deposit;
  });
  return Object.values(byType);
}

// Deterministic deposit-charge id: one per (order, container type). Using a
// fixed id is what makes re-approval idempotent — a retry addresses the same
// doc instead of appending a fresh random one (the old client bug that could
// double-charge). Container types are simple slugs (jug, crate); sanitized
// defensively so an odd type can't escape the id path.
function depositChargeId(orderId, containerType) {
  const slug = String(containerType || "other").replace(/[^A-Za-z0-9_-]+/g, "_");
  return `${orderId}-charge-${slug}`;
}

// Deterministic deposit-REVERSAL id (P0-07): one per (cancellation case,
// container type). Keyed by caseId, not orderId, because one order can hold
// several cases over time (consecutive partial cancels), each reversing a
// different slice — and a re-run of the same case overwrites instead of
// appending. `charge_reversed` is a distinct event type from `refunded`: it
// means the deposit charge was undone because the order was cancelled, NOT that
// a physical container came back, so the "containers held" nets subtract it but
// the returns view (physicalReturnsFromDepositEvents) does not count it.
function depositReversalId(caseId, containerType) {
  const slug = String(containerType || "other").replace(/[^A-Za-z0-9_-]+/g, "_");
  return `${caseId}-chargerev-${slug}`;
}

// The whole of approval in ONE transaction: status precondition, customer
// linkage (denormalized profile + gated identity keys), deposit charges, and
// the order's approval transition. Firestore rolls the whole thing back on any
// failure, so an approved order can never exist without its charges, and a
// retry (deterministic charge ids + status check) never changes the ledger
// twice. Owner-gated by the callable wrapper.
async function approveOrderImpl(orderId, ownerUid) {
  const orderRef = db().doc(`orders/${orderId}`);
  return db().runTransaction(async (tx) => {
    // ---- READS (Admin-SDK transactions require all reads before any write) --
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists) throw new HttpsError("not-found", "Order not found.");
    const order = orderSnap.data() || {};

    if (order.status === "cancelled") {
      throw new HttpsError("failed-precondition", "This order is cancelled and cannot be approved.");
    }
    // Idempotency: only pending_approval transitions to new. An already-approved
    // order re-runs the (idempotent) charge/linkage writes and returns success
    // without moving the status — a double-tap or retry is harmless.
    const alreadyApproved = order.status !== "pending_approval";

    const customerId = order.customerId || (order.authUid ? `CUS-${order.authUid}` : null);
    const customerRef = customerId ? db().doc(`customers/${customerId}`) : null;
    const customerSnap = customerRef ? await tx.get(customerRef) : null;

    const itemsSnap = await tx.get(db().collection("orderItems").where("orderId", "==", orderId));
    const items = itemsSnap.docs.map((d) => d.data() || {});
    const productIds = Array.from(new Set(items.map((i) => String(i.productId || "")).filter(Boolean)));
    const productSnaps = await Promise.all(productIds.map((id) => tx.get(db().doc(`products/${id}`))));
    const productsById = {};
    productSnaps.forEach((s) => { if (s.exists) productsById[s.id] = s.data(); });

    const breakdown = computeDepositBreakdown(items, productsById);
    const chargeTargets = breakdown.map((b) => ({ b, ref: db().doc(`depositEvents/${depositChargeId(orderId, b.containerType)}`) }));
    const chargeSnaps = await Promise.all(chargeTargets.map((c) => tx.get(c.ref)));

    // ---- WRITES ------------------------------------------------------------
    const existingCustomer = customerSnap && customerSnap.exists ? customerSnap.data() : null;
    if (customerRef) {
      // Never overwrite a customer record owned by a DIFFERENT sign-in. With
      // P0-04's uid-anchored customerId this should be unreachable, but approval
      // writes profile fields with merge, so guard it.
      if (existingCustomer && existingCustomer.authUid && order.authUid && existingCustomer.authUid !== order.authUid) {
        throw new HttpsError("failed-precondition", `Customer ${customerId} belongs to a different sign-in; approval stopped to avoid overwriting another customer.`);
      }
      const canLink = canLinkAuthUidToCustomer(order.authUid, existingCustomer);
      const customerPatch = {
        name: order.customerName || null,
        phone: order.phone || null,
        address: order.address || null,
        addressHistory: order.address || null,
        lastSourceChannel: order.sourceChannel || null,
        lastOrderAt: order.deliveryDate || null,
        updatedAt: FieldValue.serverTimestamp()
      };
      // Identity keys ride the takeover gate — same as the old client upsert.
      if (order.email && canLink) customerPatch.email = order.email;
      if (canLink) customerPatch.authUid = order.authUid;
      if (!existingCustomer) customerPatch.createdAt = FieldValue.serverTimestamp();
      tx.set(customerRef, customerPatch, { merge: true });
    }

    // Deposit charges: create only the ones that don't already exist, so a
    // repeat approval never changes the ledger twice and never rewrites an
    // existing charge's amount.
    const eventDate = order.deliveryDate || new Date().toISOString().slice(0, 10);
    let chargesCreated = 0;
    chargeTargets.forEach(({ b, ref }, i) => {
      if (chargeSnaps[i].exists) return;
      tx.set(ref, {
        orderId,
        customerId: customerId || null,
        authUid: order.authUid || null,
        containerType: b.containerType,
        qty: b.qty,
        amount: b.amount,
        eventType: "charged",
        eventDate,
        linkedDocumentId: null,
        notes: "Auto-charged on approval",
        chargedBy: ownerUid,
        createdAtServer: FieldValue.serverTimestamp()
      });
      chargesCreated += 1;
    });

    // Order approval transition (status only when it was actually pending).
    const orderPatch = {
      customerId: customerId || null,
      updatedAt: new Date().toISOString()
    };
    if (!alreadyApproved) orderPatch.status = "new";
    // Keep the customer-confirmed pin (P0-03). Only backfill from the customer
    // record when the order has none — no server geocoding.
    const hasPin = order.deliveryLocation && typeof order.deliveryLocation.lat === "number";
    if (!hasPin && existingCustomer && existingCustomer.location && typeof existingCustomer.location.lat === "number") {
      orderPatch.deliveryLocation = existingCustomer.location;
    }
    tx.update(orderRef, orderPatch);

    return {
      orderId,
      status: alreadyApproved ? order.status : "new",
      alreadyApproved,
      chargesCreated,
      charged: breakdown.map((b) => ({ containerType: b.containerType, qty: b.qty, amount: b.amount }))
    };
  });
}

// --- Idempotent order creation (P0-02) -------------------------------------
//
// Client keys mirror SUBMISSION_KEY_PATTERN in web/assets/shared.js.
const SUBMISSION_KEY_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

// Creates the order + its items exactly once per {authUid, submissionKey}.
// The mapping doc orderSubmissions/{uid}__{key} is written in the SAME
// transaction as the order, so a retry whose first attempt committed finds
// the mapping and gets the original order back — it can never create a
// second one, including two parallel requests (the transaction serializes
// them). No firestore.rules change: orderSubmissions has no match block, so
// clients are denied by default and only this Admin-SDK path writes it.
//
// A missing/invalid key falls back to the old non-idempotent batch write so
// cached pre-P0-02 clients keep ordering; they simply keep the old risk.
async function createOrderUnderSubmissionKey({ authUid, submissionKey, orderId, orderDoc, itemDocs }) {
  if (!submissionKey) {
    const batch = db().batch();
    batch.set(db().doc(`orders/${orderId}`), orderDoc);
    itemDocs.forEach((item) => batch.set(db().doc(`orderItems/${item.id}`), item.data));
    await batch.commit();
    return { orderId, duplicate: false };
  }
  const dedupRef = db().doc(`orderSubmissions/${authUid}__${submissionKey}`);
  return db().runTransaction(async (tx) => {
    const existing = await tx.get(dedupRef);
    if (existing.exists) {
      const existingOrderId = String((existing.data() || {}).orderId || "");
      logger.info("submitPublicOrder: duplicate submission key, returning existing order", {
        authUid, submissionKey, orderId: existingOrderId
      });
      return { orderId: existingOrderId, duplicate: true };
    }
    tx.set(db().doc(`orders/${orderId}`), orderDoc);
    itemDocs.forEach((item) => tx.set(db().doc(`orderItems/${item.id}`), item.data));
    tx.set(dedupRef, {
      orderId,
      authUid,
      createdAt: orderDoc.createdAt,
      createdAtServer: FieldValue.serverTimestamp()
    });
    return { orderId, duplicate: false };
  });
}

// --- Delivery date + service area (P0-03) ----------------------------------
//
// SERVER enforcement of the two rules the public form applies client-side.
// These MIRROR the canonical definitions in web/assets/shared.js — this file
// is CommonJS and cannot import that ESM module, so the values are duplicated
// behind this keep-in-sync note. If you change the bounds, the cutoff, or the
// date rule, change BOTH or the server will reject orders the form accepted
// (or, worse, accept ones the form blocked).

// Mirror of shared.js DA_NANG_DELIVERY_BOUNDS.
const DA_NANG_DELIVERY_BOUNDS = Object.freeze({
  west: 108.05,
  south: 15.90,
  east: 108.35,
  north: 16.20
});

// Mirror of shared.js isInsideDeliveryArea (numeric-only; the server never
// sees a google.maps.LatLng).
function isInsideDeliveryArea(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng)
    && lat >= DA_NANG_DELIVERY_BOUNDS.south
    && lat <= DA_NANG_DELIVERY_BOUNDS.north
    && lng >= DA_NANG_DELIVERY_BOUNDS.west
    && lng <= DA_NANG_DELIVERY_BOUNDS.east;
}

// Mirror of shared.js SAME_DAY_CUTOFF_HOUR. null = no cutoff (open business
// decision — see SHIP-READINESS P0-03). Kept here only so the two files line
// up; the callable does not yet act on it.
const SAME_DAY_CUTOFF_HOUR = null;

// Mirror of shared.js todayKeyInZone — today's YYYY-MM-DD in the business zone.
// Uses Intl (not manual UTC+7) so it stays correct if the zone rules ever
// change; getting this wrong rejects real orders placed near local midnight.
const BUSINESS_TIME_ZONE = "Asia/Ho_Chi_Minh";
function businessTodayKey(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: BUSINESS_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);
  const get = (type) => (parts.find((p) => p.type === type) || {}).value || "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

// Mirror of shared.js deliveryDateProblem. Returns null when acceptable, else a
// customer-facing reason. `today` is the business-zone date key.
function deliveryDateProblem(dateKey, today) {
  const value = String(dateKey || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return "Delivery date must be YYYY-MM-DD.";
  }
  // The regex accepts impossible dates (2026-02-31). Round-trip through UTC and
  // require the parts to survive, rather than letting Date roll 02-31 into March.
  const [y, m, d] = value.split("-").map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    return "That delivery date does not exist. Please pick a date from the calendar.";
  }
  if (value < today) {
    return `That delivery date has passed. Please choose ${today} or later.`;
  }
  return null;
}

// --- The callable ---
//
// App Check staging (see ROADMAP → App Check): once the web client ships with
// a real reCAPTCHA site key AND the console's App Check metrics show live
// traffic is verified, change the signature to
//   onCall({ enforceAppCheck: true }, async (request) => …)
// Doing that BEFORE the client step breaks public ordering for every visitor.
// Deliberately no auth check here — anonymous ordering is the product.

exports.submitPublicOrder = onCall(async (request) => {
  const data = request.data || {};
  const authUid = request.auth ? request.auth.uid : null;
  const authEmail = request.auth && request.auth.token ? request.auth.token.email : null;

  // Ordering requires sign-in (Ty, 2026-07-18). A guest order carries no
  // authUid, so it can never attach to the customer's later sign-in — their
  // history query is keyed by authUid (accountApp loadFirstOrdersPage). Gating
  // here, server-side, is the real enforcement; the public form's disabled
  // submit button is only the UX half. Every order now stamps an authUid, so
  // approval's canLinkAuthUidToCustomer links the phone doc cleanly.
  if (!authUid) {
    throw new HttpsError("unauthenticated", "Please sign in before placing an order.");
  }

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
    // P0-03: the map UI restricts pins to the Da Nang delivery rectangle, but a
    // legacy saved pin (or a crafted payload) can carry coordinates outside it.
    // Reject here so the boundary is actually enforced, with a message that
    // tells the customer how to fix a stale saved pin rather than just failing.
    if (!isInsideDeliveryArea(lat, lng)) {
      throw new HttpsError(
        "failed-precondition",
        "That delivery pin is outside our Da Nang delivery area. Re-confirm your address on the map — if this is a saved address, edit it once under My account → Delivery addresses to set a current pin."
      );
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
  // Store E.164 only (Ty, 2026-07-16): wa.me/Zalo links break on local-format
  // numbers, and CUS-<digits> ids assume the country code. Bare Vietnamese
  // formats (090…, 84…, 9-digit mobiles) normalize automatically; any other
  // country must arrive as +<code><number> or be rejected here.
  const phoneE164 = normalizePhoneE164VN(phone);
  if (!phoneE164) {
    throw new HttpsError("invalid-argument", "Phone must include the country code, e.g. +84 905 123 456.");
  }
  if (address.length < 5 || address.length >= 500) {
    throw new HttpsError("invalid-argument", "Address must be 5–499 characters.");
  }
  // P0-03: enforce a real, non-past delivery date in the BUSINESS timezone.
  // A stale tab (opened yesterday) or a device clock in another zone would
  // otherwise submit yesterday's date; UTC comparison would wrongly reject a
  // valid same-day order placed before 07:00 Vietnam time.
  const dateProblem = deliveryDateProblem(deliveryDate, businessTodayKey());
  if (dateProblem) {
    // Format failures stay invalid-argument; a real-but-past/nonexistent date
    // is a precondition the customer can fix.
    const code = dateProblem === "Delivery date must be YYYY-MM-DD."
      ? "invalid-argument"
      : "failed-precondition";
    throw new HttpsError(code, dateProblem);
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

  // ---- Canonical customer id (P0-04: anchored to the auth uid) ----------
  // Resolved from the signed-in uid, not the typed phone, so a typo or an
  // edited number can never split the customer or hijack a stranger's record.
  // phoneE164 is still validated above and stored on the order as contact data.
  const customerId = await resolveSignedInCustomerId(authUid);
  if (!customerId) {
    throw new HttpsError("invalid-argument", "Could not derive a customer id.");
  }

  // P0-02: idempotency key minted by the client and reused across retry /
  // reload of the same order. Optional — see createOrderUnderSubmissionKey.
  const rawSubmissionKey = String(data.submissionKey || "").trim();
  const submissionKey = SUBMISSION_KEY_PATTERN.test(rawSubmissionKey) ? rawSubmissionKey : null;

  const orderId = buildOrderId("WEB");
  const nowIso = new Date().toISOString();

  const orderDoc = {
    createdAt: nowIso,
    sourceChannel: "website",
    customerId,
    customerName: name,
    phone: phoneE164,
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
  };

  const itemDocs = items.map((line) => ({
    id: buildOrderId("ITEM"),
    data: {
      orderId,
      authUid: authUid || null,
      productId: line.productId,
      productName: line.productName,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      lineTotal: line.lineTotal
    }
  }));

  const result = await createOrderUnderSubmissionKey({ authUid, submissionKey, orderId, orderDoc, itemDocs });
  // Owner phone alert — fire only for a genuinely new order, never on a
  // double-tap retry (createOrderUnderSubmissionKey dedups and flags duplicate).
  if (!result.duplicate) {
    await sendOwnerPush({
      title: "New order to approve",
      body: `${name} · ${formatVnd(balanceDue)} · ${deliveryDate}`,
      url: "/admin.html",
      tag: `order-${result.orderId || orderId}`,
      kind: "newOrder"
    });
  }
  return result;
});

// P0-06: owner approves an order. Everything approval touches — the status
// precondition, customer linkage, deposit charges, and the status transition —
// happens in approveOrderImpl's single transaction. The old client flow did
// these as separate awaits with a stale duplicate-check and random charge ids,
// so a failure could approve an order with no deposit charge and a retry could
// double-charge. Owner-only; anonymous/customer callers are rejected.
exports.approveOrder = onCall(async (request) => {
  const ownerUid = requireOwner(request);
  const orderId = String((request.data || {}).orderId || "").trim();
  if (!orderId) throw new HttpsError("invalid-argument", "orderId is required.");
  return approveOrderImpl(orderId, ownerUid);
});

// --- Atomic delivery commit (P0-08) ----------------------------------------
//
// The Firestore CLIENT SDK cannot run a query inside runTransaction, so the two
// delivery dialogs (orderApp.js / adminApp.js) used to clamp container returns
// against holdings loaded when the dialog OPENED. Two stale dialogs could each
// return the same containers and drive a (customer, container) balance below
// zero, and the standalone forfeit trusted the dialog's hidden depositPerUnit.
//
// This callable moves the whole commit server-side. In ONE Admin-SDK
// transaction it re-reads the order status, RE-AGGREGATES the customer's
// current /depositEvents holdings, clamps every return + forfeit against those
// FRESH holdings, then writes the payment + deposit events + order money update.
//
// Parallel safety: the transaction also reads AND writes the customer doc, so
// two concurrent deliveries for the SAME customer serialize on it — the second
// retries, re-aggregates, sees the first's return events, and re-clamps, so
// neither can out-run the ledger. (Return ids are per-order and would not
// conflict on their own; the customer-doc read/write is what forces the order.)
//
// Ids reuse the deterministic scheme the old client path used
// (${orderId}-ret-${type}, ${orderId}-deposit-credit,
// ${orderId}-deposit-excess-refund); the forfeit now gets a deterministic
// ${orderId}-forfeit-${type} too — it used a random buildDepositEventId() in
// BOTH client files, which made a retry append a duplicate write-off.
//
// Money math MIRRORS orderApp.js::saveDeliveryPayment and the adminApp.js
// delivery transaction exactly. Those two must not drift from this.
function forfeitEventId(orderId, containerType) {
  return `${orderId}-forfeit-${containerType}`;
}

// P0-09 — MIRROR of collectedPaymentProblem in web/assets/shared.js (CommonJS
// can't import the ESM module). Keep the two in sync —
// paymentEntry.parity.test.mjs fails when they drift. Overpayment is deliberately
// not flagged here: it has its own explicit-acknowledgement gate in the
// transaction, where the credit is computed against the FRESH balance.
function collectedPaymentProblem(amount, balanceRemaining) {
  const value = Number(amount);
  if (!Number.isFinite(value)) return "Enter the amount collected.";
  if (value < 0) return "Amount cannot be negative.";
  if (!Number.isInteger(value)) return "Amount must be whole VND — no decimals.";
  if (value === 0 && Number(balanceRemaining || 0) > 0) {
    return 'Nothing was collected — choose "Not collected" instead, so the order gets a follow-up date rather than a silent zero payment.';
  }
  return null;
}

// MIRROR of paymentEvidenceProblem in web/assets/shared.js. Bank transfer / QR
// need a reference OR a proof photo; cash + "other" optional; a 0 payment (fully
// prepaid delivery) needs nothing. Keep in sync — paymentEntry.parity.test.mjs
// fails on drift.
const PAYMENT_METHODS_REQUIRING_EVIDENCE = ["transfer", "bank_qr"];
function paymentEvidenceProblem(opts) {
  const o = opts || {};
  if (!(Number(o.amount) > 0)) return null;
  const m = String(o.method || "").trim();
  if (!PAYMENT_METHODS_REQUIRING_EVIDENCE.includes(m)) return null;
  const hasReference = String(o.reference || "").trim().length > 0;
  if (hasReference || o.hasProof === true) return null;
  const label = m === "bank_qr" ? "QR payment" : "bank transfer";
  return `Add a reference number or a photo for this ${label}, so it can be checked later. Cash doesn't need one.`;
}

// MIRROR of refundEvidenceProblem in web/assets/shared.js. Electronic refund
// methods (bank / QR / wallet) require a reference at record time; cash does
// not. Refund photo proof arrives separately via attachRefundEvidence.
const REFUND_METHODS_REQUIRING_REFERENCE = ["refund_bank", "refund_qr", "refund_wallet"];
function refundEvidenceProblem(opts) {
  const o = opts || {};
  const m = String(o.method || "").trim();
  if (!REFUND_METHODS_REQUIRING_REFERENCE.includes(m)) return null;
  if (String(o.reference || "").trim().length > 0) return null;
  const label = m === "refund_qr" ? "QR refund" : (m === "refund_wallet" ? "wallet refund" : "bank refund");
  return `Add a reference for this ${label} (the transfer id or a note), so it can be matched later. You can still attach the photo proof after.`;
}

// Re-aggregate a customer's held containers from /depositEvents INSIDE a
// transaction. MIRRORS loadHeldContainersForCustomer in both client files:
// charged adds; refunded/credited/forfeited/charge_reversed subtract;
// depositPerUnit is the charge-weighted average.
async function aggregateHoldings(tx, customerId) {
  const held = {};
  if (!customerId) return held;
  const snap = await tx.get(db().collection("depositEvents").where("customerId", "==", customerId));
  const byType = {};
  snap.forEach((docSnap) => {
    const event = docSnap.data() || {};
    const type = String(event.containerType || "other");
    if (!byType[type]) byType[type] = { qty: 0, amount: 0, totalChargedAmount: 0, totalChargedQty: 0 };
    const qty = Number(event.qty || 0);
    const amount = Number(event.amount || 0);
    if (event.eventType === "charged") {
      byType[type].qty += qty;
      byType[type].amount += amount;
      byType[type].totalChargedAmount += amount;
      byType[type].totalChargedQty += qty;
    } else if (["refunded", "credited", "forfeited", "charge_reversed"].includes(event.eventType)) {
      byType[type].qty -= qty;
      byType[type].amount -= amount;
    }
  });
  Object.entries(byType).forEach(([type, d]) => {
    held[type] = {
      qty: d.qty,
      outstandingAmount: d.amount,
      depositPerUnit: d.totalChargedQty > 0 ? d.totalChargedAmount / d.totalChargedQty : 0
    };
  });
  return held;
}

async function commitDeliveryImpl(ownerUid, data) {
  const input = data || {};
  const orderId = String(input.orderId || "").trim();
  if (!orderId) throw new HttpsError("invalid-argument", "orderId is required.");
  const paymentId = String(input.paymentId || "").trim();
  if (!paymentId) throw new HttpsError("invalid-argument", "paymentId is required.");

  const payment = input.payment || {};
  const collected = payment.collected === true;
  // P0-09: no silent Math.round — a fractional amount is a typo, not a payment.
  // Negative/fractional are rejected here; the zero-while-balance-remains rule
  // needs the FRESH balance and runs inside the transaction below.
  const cashAmount = collected ? Number(payment.amount || 0) : 0;
  if (collected) {
    const problem = collectedPaymentProblem(cashAmount, 0);
    if (problem) throw new HttpsError("invalid-argument", problem);
  }
  // P0-09: cash collected beyond what was due before this delivery becomes
  // customer credit and must be explicitly acknowledged at that exact number —
  // see the in-transaction gate. (Returned-container credit beyond the balance
  // has its own explicit carry/refund choice and is not double-gated here.)
  const acknowledgedCashCredit = Number.isInteger(input.acknowledgeCashCredit)
    ? input.acknowledgeCashCredit
    : null;
  const overCreditChoice = input.overCreditChoice === "refund" ? "refund" : "carry";
  const requestedReturns = Array.isArray(input.returns) ? input.returns : [];

  // Forfeit re-read + deliberate reason (P0-08 item 5). The qty and
  // depositPerUnit from the dialog are NOT trusted — the qty is re-clamped
  // against fresh holdings below and the per-unit is recomputed server-side —
  // but the reason must be present and non-empty here.
  const loss = input.lossReport || null;
  if (loss) {
    if (!String(loss.lossType || "").trim()) throw new HttpsError("invalid-argument", "Loss type is required.");
    if (!String(loss.lossNote || "").trim()) {
      throw new HttpsError("invalid-argument", "A write-off needs a reason — say what happened to the containers.");
    }
  }

  const returnProofDocumentId = input.returnProofDocumentId || null;
  const returnProofType = input.returnProofType || null;
  const returnProofNote = input.returnProofNote || null;
  const proofDocumentId = input.proofDocumentId || null;
  const proofUrl = input.proofUrl || null;
  if (collected) {
    // Same evidence bar as receivables: a collected transfer/QR at the door
    // needs a reference or a photo. Prepaid (cashAmount 0) is exempt.
    const evidenceProblem = paymentEvidenceProblem({
      method: payment.method || "cash",
      reference: payment.reference,
      hasProof: !!proofDocumentId,
      amount: cashAmount
    });
    if (evidenceProblem) throw new HttpsError("invalid-argument", evidenceProblem);
  }

  const now = new Date().toISOString();
  const today = businessTodayKey();

  return db().runTransaction(async (tx) => {
    // ---- READS (all before any write) ----
    const orderRef = db().doc(`orders/${orderId}`);
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists) throw new HttpsError("not-found", "Order no longer exists.");
    const order = orderSnap.data() || {};
    // Fresh, in-transaction status gate (P0-08 item 3, now server-authoritative):
    // deliver only an order that is genuinely out_for_delivery right now.
    if (order.status !== "out_for_delivery") {
      throw new HttpsError("failed-precondition", order.status === "delivered"
        ? "This order is already delivered."
        : "This order is no longer out for delivery — reload before recording delivery.");
    }

    const customerId = order.customerId || null;
    // Read the customer doc so the write at the end serializes concurrent
    // deliveries for the same customer (see header). Also the anchor for the
    // empties-pickup flag.
    const customerRef = customerId ? db().doc(`customers/${customerId}`) : null;
    const customerSnap = customerRef ? await tx.get(customerRef) : null;
    const held = await aggregateHoldings(tx, customerId);

    // ---- Clamp returns against FRESH holdings (P0-08 items 1/2) ----
    // "keep" ("owner will decide later") returns are dropped by the client and
    // never arrive here — no ledger event is written for them, so they cannot
    // masquerade as a recorded physical return (item 4).
    const returns = [];
    requestedReturns.forEach((r) => {
      const type = String((r || {}).type || "");
      const handling = r && r.handling === "refund" ? "refund" : "credit";
      const requestedQty = Math.round(Number((r || {}).returnedQty || 0));
      if (!type || !Number.isFinite(requestedQty) || requestedQty <= 0) return;
      const heldQty = Number(held[type] && held[type].qty || 0);
      if (heldQty <= 0) return;
      returns.push({
        type,
        returnedQty: Math.min(requestedQty, heldQty),
        handling,
        depositPerUnit: Number(held[type] && held[type].depositPerUnit || 0)
      });
    });

    // ---- Clamp forfeit against FRESH holdings (P0-08 item 5) ----
    let lossReport = null;
    if (loss) {
      const lossType = String(loss.lossType).trim();
      const heldQty = Number(held[lossType] && held[lossType].qty || 0);
      const lossQty = Math.round(Number(loss.lossQty || 0));
      if (heldQty <= 0) {
        throw new HttpsError("failed-precondition", "This customer has no containers of that type on file, so there is nothing to write off.");
      }
      if (!Number.isFinite(lossQty) || lossQty <= 0 || lossQty > heldQty) {
        throw new HttpsError("failed-precondition", `Qty lost must be between 1 and ${heldQty}.`);
      }
      lossReport = {
        lossType,
        lossQty,
        depositPerUnit: Number(held[lossType] && held[lossType].depositPerUnit || 0),
        lossNote: String(loss.lossNote).trim()
      };
    }

    // ---- Money math (mirror of both client delivery transactions) ----
    const total = Number(order.subtotal || 0) + Number(order.depositTotal || 0);

    // P0-09: both gates run against the FRESH order, not the dialog's numbers.
    // Zero while a balance remains is not a payment — route it to the explicit
    // "not collected" path so the order gets follow-up state instead of a
    // silent 0 VND payment doc that looks like settlement.
    const dueBeforeDelivery = total - Number(order.amountPaid || 0);
    if (collected) {
      const zeroProblem = collectedPaymentProblem(cashAmount, dueBeforeDelivery);
      if (zeroProblem) throw new HttpsError("failed-precondition", zeroProblem);
      // An extra zero typed into the amount field is a 10x overpayment. It only
      // goes through when the client states the exact resulting credit back —
      // computed HERE against the fresh balance, so a stale dialog's
      // acknowledgement of a different number is rejected with the real one.
      const excessCash = Math.max(0, cashAmount - Math.max(0, dueBeforeDelivery));
      if (excessCash > 0 && acknowledgedCashCredit !== excessCash) {
        throw new HttpsError(
          "failed-precondition",
          `That collects ${excessCash} VND more than the ${Math.max(0, dueBeforeDelivery)} VND still due — the extra stays on the account as customer credit. Confirm the credit to record it.`,
          { overpayment: true, excessCash, dueBefore: Math.max(0, dueBeforeDelivery) }
        );
      }
    }

    const creditTotal = returns
      .filter((r) => r.handling === "credit")
      .reduce((s, r) => s + r.returnedQty * r.depositPerUnit, 0);
    const cashPaid = collected ? cashAmount : 0;
    const grossAmountPaid = Number(order.amountPaid || 0) + cashPaid + creditTotal;
    const grossBalance = total - grossAmountPaid;
    const refundableExcess = Math.min(creditTotal, Math.max(0, -grossBalance));
    const excessRefund = overCreditChoice === "refund" ? refundableExcess : 0;
    const newAmountPaid = grossAmountPaid - excessRefund;
    const newBalance = total - newAmountPaid;
    const receivedBy = ownerUid || "owner";

    // ---- WRITES ----
    if (collected) {
      tx.set(db().doc(`payments/${paymentId}`), {
        orderId,
        customerId: customerId || null,
        authUid: order.authUid || null,
        paymentDate: today,
        method: payment.method || "cash",
        amount: cashPaid,
        reference: payment.reference || null,
        receivedBy,
        proofDocumentId,
        proofUrl,
        notes: "Collected at delivery",
        deferred: false,
        createdAt: now
      });
    } else {
      tx.set(db().doc(`payments/${paymentId}`), {
        orderId,
        customerId: customerId || null,
        authUid: order.authUid || null,
        paymentDate: today,
        method: "deferred",
        amount: 0,
        reference: null,
        receivedBy,
        proofDocumentId: null,
        proofUrl: null,
        notes: payment.notes || null,
        deferred: true,
        deferralReason: payment.reason || "other",
        followUpBy: payment.followUpBy || null,
        createdAt: now
      });
    }

    if (creditTotal > 0) {
      tx.set(db().doc(`payments/${orderId}-deposit-credit`), {
        orderId,
        customerId: customerId || null,
        authUid: order.authUid || null,
        paymentDate: today,
        method: "deposit_credit",
        amount: creditTotal,
        reference: null,
        receivedBy,
        proofDocumentId: returnProofDocumentId,
        proofUrl: null,
        proofType: returnProofType,
        proofNote: returnProofNote,
        notes: returnProofDocumentId
          ? "Deposit credit from containers returned at delivery"
          : `Deposit credit from containers returned at delivery — no photo, recorded on note: "${returnProofNote}"`,
        deferred: false,
        createdAt: now
      });
    }

    if (excessRefund > 0) {
      tx.set(db().doc(`payments/${orderId}-deposit-excess-refund`), {
        orderId,
        customerId: customerId || null,
        authUid: order.authUid || null,
        paymentDate: today,
        method: "deposit_refund",
        amount: -excessRefund,
        reference: null,
        receivedBy,
        proofDocumentId: returnProofDocumentId,
        proofUrl: null,
        proofType: returnProofType,
        proofNote: returnProofNote,
        notes: "Cash refund of excess returned-container deposit credit",
        deferred: false,
        createdAt: now
      });
    }

    const orderUpdate = {
      status: "delivered",
      deliveryPaymentEventId: paymentId,
      amountPaid: newAmountPaid,
      balanceDue: newBalance,
      paymentStatus: paymentStatusFor(newAmountPaid, newBalance),
      depositOverCreditDisposition: refundableExcess > 0 ? overCreditChoice : null,
      depositOverCreditAmount: refundableExcess,
      updatedAt: now
    };
    if (!collected) orderUpdate.followUpBy = payment.followUpBy || null;
    tx.update(orderRef, orderUpdate);

    returns.forEach((r) => {
      tx.set(db().doc(`depositEvents/${orderId}-ret-${r.type}`), {
        orderId,
        customerId: customerId || null,
        authUid: order.authUid || null,
        containerType: r.type,
        qty: r.returnedQty,
        amount: r.returnedQty * r.depositPerUnit,
        eventType: r.handling === "refund" ? "refunded" : "credited",
        eventDate: today,
        linkedDocumentId: returnProofDocumentId,
        proofType: returnProofType,
        proofNote: returnProofNote,
        notes: `Returned at delivery — ${r.handling === "refund" ? "refunded cash" : "applied to this order"}`,
        createdAt: now
      });
    });

    if (lossReport) {
      // Deterministic id (was random in both client files) so a retry of this
      // callable overwrites the single write-off instead of appending another.
      tx.set(db().doc(`depositEvents/${forfeitEventId(orderId, lossReport.lossType)}`), {
        orderId,
        customerId: customerId || null,
        authUid: order.authUid || null,
        containerType: lossReport.lossType,
        qty: lossReport.lossQty,
        amount: lossReport.lossQty * lossReport.depositPerUnit,
        eventType: "forfeited",
        eventDate: today,
        linkedDocumentId: null,
        notes: lossReport.lossNote,
        createdAt: now
      });
    }

    // ---- Pickup flag: clear ONLY when empties were actually collected ----
    // Fulfilled = at least one physical return (credit or refund) was written
    // this delivery. A pure "owner will decide later" writes no ledger event and
    // is NOT fulfilled, so the request stays and nags next time (P0-08 item:
    // pickup clears only when fulfilled or explicitly dismissed/rescheduled —
    // explicit dismissal is the customer's own toggle on account.html). The
    // customer-doc write always runs (updatedAt) because it is also the
    // serialization anchor above.
    const pickupFulfilled = returns.length > 0;
    let pickupCleared = false;
    if (customerRef) {
      const patch = { updatedAt: now };
      const wanted = customerSnap && customerSnap.exists
        && (customerSnap.data() || {}).emptiesPickupRequested === true;
      if (wanted && pickupFulfilled) {
        patch.emptiesPickupRequested = false;
        patch.emptiesPickupRequestedAt = null;
        pickupCleared = true;
      }
      tx.set(customerRef, patch, { merge: true });
    }

    return {
      orderId,
      status: "delivered",
      amountPaid: newAmountPaid,
      balanceDue: newBalance,
      creditTotal,
      excessRefund,
      pickupCleared,
      returnsApplied: returns.map((r) => ({ type: r.type, qty: r.returnedQty, handling: r.handling })),
      forfeited: lossReport ? { type: lossReport.lossType, qty: lossReport.lossQty } : null
    };
  });
}

// Owner-only: the delivery dialogs upload proof photos client-side (same pattern
// as refund proofs), then hand the rest to this callable.
exports.commitDelivery = onCall(async (request) => {
  const ownerUid = requireOwner(request);
  return commitDeliveryImpl(ownerUid, request.data || {});
});

// --- P0-09: record a payment against a delivered order ----------------------
//
// The receivables "Record payment" dialog used to run this as a client-side
// transaction. It moved server-side for the same reason approval (P0-06),
// cancellation (P0-07) and delivery commit (P0-08) did: the checks that matter
// — fresh status, fresh balance, the exact resulting credit — must be computed
// against what is in Firestore at commit time, not against whatever the dialog
// loaded minutes ago.
//
// The gate:
//  - Delivered orders only. Cancelled orders reject outright. Undelivered
//    orders reject too — their money is collected at the door through
//    commitDelivery, and Receivables no longer lists them (P0-09: the page
//    shows delivered debt only, so it stops chasing customers pre-delivery).
//  - A collected amount must be a positive whole-VND integer. Zero is not a
//    payment; it routes to the explicit deferred path ({collected:false}),
//    which records the reason + a follow-up date instead of a silent 0.
//  - Paying more than the fresh balance goes through only when the client
//    acknowledges the EXACT resulting credit (acknowledgeCredit). A stale
//    dialog acknowledging yesterday's number is rejected with the real one in
//    error details, so the owner re-confirms against the truth.
//  - Idempotent per paymentId: a retry after a lost response returns the
//    already-recorded outcome instead of double-counting amountPaid.
async function recordPaymentImpl(ownerUid, data) {
  const input = data || {};
  const orderId = String(input.orderId || "").trim();
  if (!orderId) throw new HttpsError("invalid-argument", "orderId is required.");
  const paymentId = String(input.paymentId || "").trim();
  if (!paymentId) throw new HttpsError("invalid-argument", "paymentId is required.");

  const payment = input.payment || {};
  const collected = payment.collected === true;
  const amount = collected ? Number(payment.amount || 0) : 0;
  if (collected) {
    // balanceRemaining floor of 1: on this path zero is NEVER a collected
    // payment, even against a settled order — the deferred branch is the only
    // zero path. (The delivery dialog differs: a fully prepaid order really
    // does collect 0 there.)
    const problem = collectedPaymentProblem(amount, 1);
    if (problem) throw new HttpsError("invalid-argument", problem);
  } else {
    // The deferred path exists to create follow-up state; without a date it
    // records nothing anyone will act on.
    const followUpBy = String(payment.followUpBy || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(followUpBy)) {
      throw new HttpsError("invalid-argument", "A follow-up date (YYYY-MM-DD) is required when nothing was collected.");
    }
  }
  const acknowledgedCredit = Number.isInteger(input.acknowledgeCredit)
    ? input.acknowledgeCredit
    : null;
  const proofDocumentId = input.proofDocumentId || null;
  const proofUrl = input.proofUrl || null;
  if (collected) {
    // Electronic payments must carry a checkable trace (reference or photo).
    const evidenceProblem = paymentEvidenceProblem({
      method: payment.method || "cash",
      reference: payment.reference,
      hasProof: !!proofDocumentId,
      amount
    });
    if (evidenceProblem) throw new HttpsError("invalid-argument", evidenceProblem);
  }

  const now = new Date().toISOString();
  const today = businessTodayKey();

  return db().runTransaction(async (tx) => {
    // ---- READS (all before any write) ----
    const orderRef = db().doc(`orders/${orderId}`);
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists) throw new HttpsError("not-found", "Order no longer exists.");
    const order = orderSnap.data() || {};

    // Idempotent retry — checked BEFORE the status gates so a retry of an
    // already-recorded payment reports its real outcome even if the order's
    // state moved on afterwards.
    const payRef = db().doc(`payments/${paymentId}`);
    const paySnap = await tx.get(payRef);
    if (paySnap.exists) {
      return {
        orderId,
        duplicate: true,
        amountPaid: Number(order.amountPaid || 0),
        balanceDue: Number(order.balanceDue || 0),
        paymentStatus: order.paymentStatus || null,
        resultingCredit: 0
      };
    }

    // ---- Fresh status gates (P0-09) ----
    if (order.status === "cancelled") {
      throw new HttpsError("failed-precondition", "This order is cancelled — payments can no longer be recorded against it. Reload the page.");
    }
    if (order.status !== "delivered") {
      throw new HttpsError("failed-precondition", "This order has not been delivered yet — money for it is collected in the delivery dialog, not here. Reload the page.");
    }

    // ---- Fresh balance (never the dialog's number) ----
    const total = Number(order.subtotal || 0) + Number(order.depositTotal || 0);
    const freshBalance = total - Number(order.amountPaid || 0);

    if (!collected) {
      // Deferred/uncollected: an amount-0 deferred payment doc keeps the audit
      // trail of the chase (same shape commitDelivery writes at the door), and
      // the order carries the follow-up date Receivables sorts on.
      tx.set(payRef, {
        orderId,
        customerId: order.customerId || null,
        authUid: order.authUid || null,
        paymentDate: today,
        method: "deferred",
        amount: 0,
        reference: null,
        receivedBy: ownerUid || "owner",
        proofDocumentId: null,
        proofUrl: null,
        notes: payment.notes || null,
        deferred: true,
        deferralReason: payment.reason || "other",
        followUpBy: payment.followUpBy,
        createdAt: now
      });
      tx.update(orderRef, { followUpBy: payment.followUpBy, updatedAt: now });
      return {
        orderId,
        duplicate: false,
        amountPaid: Number(order.amountPaid || 0),
        balanceDue: Number(order.balanceDue || 0),
        paymentStatus: order.paymentStatus || null,
        resultingCredit: 0
      };
    }

    // ---- Overpayment gate against the FRESH balance ----
    const resultingCredit = Math.max(0, amount - Math.max(0, freshBalance));
    if (resultingCredit > 0 && acknowledgedCredit !== resultingCredit) {
      throw new HttpsError(
        "failed-precondition",
        `That is ${resultingCredit} VND more than the ${Math.max(0, freshBalance)} VND still due — the extra stays on the account as customer credit. Confirm the credit to record it.`,
        { overpayment: true, resultingCredit, freshBalance: Math.max(0, freshBalance) }
      );
    }

    const newAmountPaid = Number(order.amountPaid || 0) + amount;
    const newBalance = total - newAmountPaid;
    tx.set(payRef, {
      orderId,
      customerId: order.customerId || null,
      authUid: order.authUid || null,
      paymentDate: today,
      method: payment.method || "cash",
      amount,
      reference: payment.reference || null,
      receivedBy: ownerUid || "owner",
      proofDocumentId,
      proofUrl,
      notes: "Recorded from receivables page",
      deferred: false,
      createdAt: now
    });
    tx.update(orderRef, {
      amountPaid: newAmountPaid,
      balanceDue: newBalance,
      paymentStatus: paymentStatusFor(newAmountPaid, newBalance),
      updatedAt: now
    });
    return {
      orderId,
      duplicate: false,
      amountPaid: newAmountPaid,
      balanceDue: newBalance,
      paymentStatus: paymentStatusFor(newAmountPaid, newBalance),
      resultingCredit
    };
  });
}

// Owner-only: proof photos are uploaded client-side first and referenced by id,
// the same pattern the delivery dialogs use.
exports.recordPayment = onCall(async (request) => {
  const ownerUid = requireOwner(request);
  return recordPaymentImpl(ownerUid, request.data || {});
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

    const stats = {
      scanned: 0, skipped: 0, drifted: 0, fixed: 0, failed: 0,
      caseScanned: 0, caseFixed: 0, caseFailed: 0
    };

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

    // Case-refund backstop. reconcileOnPaymentWrite settles cases in real time
    // but is fire-and-forget (it logs and swallows on failure), and the order
    // sweep above skips cancelled orders — so without this pass a cancelled
    // order's case would have no nightly safety net if a trigger fire was
    // dropped. Re-settle every approved case that still has an open refund.
    // One equality filter + orderBy(__name__) is served by the automatic
    // single-field index, so this needs no composite index.
    let caseCursor = null;
    while (true) {
      let cq = db().collection("orderCancellations")
        .where("decisionStatus", "==", "approved")
        .orderBy(FieldPath.documentId())
        .limit(pageSize);
      if (caseCursor) cq = cq.startAfter(caseCursor);
      const csnap = await cq.get();
      if (csnap.empty) break;
      for (const caseDoc of csnap.docs) {
        const c = caseDoc.data() || {};
        if (!(Number(c.refundRequired || 0) > 0)) continue;
        if (c.refundStatus !== "pending" && c.refundStatus !== "partial") continue;
        stats.caseScanned += 1;
        try {
          const changed = await reconcileCaseRefund(caseDoc.id, {});
          if (changed) stats.caseFixed += 1;
        } catch (err) {
          stats.caseFailed += 1;
          logger.error("nightlyReconcileOrderMath: case fix failed", {
            caseId: caseDoc.id,
            error: String((err && err.message) || err)
          });
        }
      }
      if (csnap.size < pageSize) break;
      caseCursor = csnap.docs[csnap.docs.length - 1];
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

// opts.eventSource — when set (the real-time payment-write trigger), the drift
// record goes to reconciliationEvents instead of a nightly run's drifts
// subcollection. The math and the order update are identical either way.
async function reconcileOne(orderId, runId, opts = {}) {
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

    const driftPayload = {
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
    };

    if (opts.eventSource) {
      // Real-time correction from the payment-write trigger. Recorded to its
      // own collection, NOT reconciliationReports: the dashboard's stale-cron
      // check reads the newest reconciliationReports doc, so writing there on
      // every corrected payment would mask a dead nightly job.
      tx.set(db().collection("reconciliationEvents").doc(), {
        ...driftPayload,
        source: opts.eventSource
      });
    } else {
      tx.set(db().doc(`reconciliationReports/${runId}/drifts/${orderId}`), driftPayload);
    }

    tx.update(orderRef, {
      amountPaid: expectedAmountPaid,
      balanceDue: expectedBalance,
      paymentStatus: expectedStatus,
      reconciledAt: FieldValue.serverTimestamp(),
      reconciledRunId: opts.eventSource ? null : runId
    });

    return true;
  });
}

// Recompute a cancellation case's refund settlement from the immutable negative
// payments linked to it. This is the case-ledger sibling of reconcileOne — and
// it deliberately does NOT live inside reconcileOne, which returns early on a
// cancelled order (a FULL-cancellation refund lands on a cancelled order, so
// reconcileOne would never see it). refundRemaining is ALWAYS recomputed from
// the payments, never incremented, so a duplicate trigger fire is a no-op.
// Idempotent + transactional. See CANCELLATION-REFUND-PLAN.md.
async function reconcileCaseRefund(caseId, opts = {}) {
  return db().runTransaction(async (tx) => {
    const caseRef = db().doc(`orderCancellations/${caseId}`);
    const caseSnap = await tx.get(caseRef);
    if (!caseSnap.exists) return false;
    const c = caseSnap.data() || {};
    // Only an approved case settles. A requested/dismissed case owes nothing.
    if (c.decisionStatus !== "approved") return false;
    const required = Number(c.refundRequired || 0);
    if (!(required > 0)) return false;

    // Re-sum the immutable negative refund payments linked to THIS case. The
    // tx.get(query) locks the read set so a payment landing mid-transaction is
    // included, exactly as reconcileOne does for order payments.
    const paySnap = await tx.get(
      db().collection("payments").where("cancellationCaseId", "==", caseId)
    );
    let refunded = 0;
    paySnap.forEach((d) => {
      const amt = Number((d.data() || {}).amount || 0);
      if (Number.isFinite(amt) && amt < 0) refunded += -amt;
    });

    const remaining = Math.max(0, required - refunded);
    const status = remaining <= 0 ? "paid" : (refunded > 0 ? "partial" : "pending");
    // recordOrderRefund rejects over-refunds at write time, but a console /
    // Admin-SDK write cannot be rejected after the fact — clamp remaining at 0
    // but surface the anomaly rather than swallowing it.
    const overRefunded = refunded > required;

    const storedRemaining = Number(c.refundRemaining || 0);
    const storedStatus = String(c.refundStatus || "");
    if (storedRemaining === remaining && storedStatus === status && !overRefunded) {
      return false;
    }

    tx.update(caseRef, {
      refundRemaining: remaining,
      refundStatus: status,
      reconciledAt: FieldValue.serverTimestamp(),
      updatedAt: new Date().toISOString()
    });

    if (opts.eventSource) {
      // A refund payment reconciled the case outside the recordOrderRefund
      // callable (a console/Admin-SDK write), or an over-refund was detected.
      // Same owner-read sink as the order path — worth investigating.
      tx.set(db().collection("reconciliationEvents").doc(), {
        caseId,
        orderId: c.orderId || null,
        kind: "case-refund",
        before: { refundRemaining: storedRemaining, refundStatus: storedStatus },
        after: { refundRemaining: remaining, refundStatus: status },
        refundRequired: required,
        refundedSum: refunded,
        overRefunded,
        source: opts.eventSource,
        at: FieldValue.serverTimestamp()
      });
    }

    return true;
  });
}

// --- Real-time reconciliation on payment write ---------------------------
//
// The nightly job is the full-collection backstop; this catches drift within
// seconds instead of up to a day. Every in-app payment write updates its order's
// money in the SAME transaction, so this trigger is normally a no-op — it
// re-checks the order and finds it already correct. It earns its place on the
// paths that bypass the atomic client write: an Admin-SDK import or a console
// edit that adds a payment without touching the order. reconcileOne is
// idempotent and transactional, so the (rare) second fire from a multi-payment
// delivery just finds no drift.
//
// Pinned to asia-east2 because a Firestore trigger must be created in the
// database's region (setGlobalOptions pins us-central1 for the callables). A
// genuine correction is logged at error level and recorded to
// reconciliationEvents (owner-read) — it means a write bypassed the atomic path,
// which is worth investigating.
exports.reconcileOnPaymentWrite = onDocumentWritten(
  { document: "payments/{paymentId}", region: "asia-east2" },
  async (event) => {
    const after = event.data && event.data.after && event.data.after.exists
      ? event.data.after.data() : null;
    const before = event.data && event.data.before && event.data.before.exists
      ? event.data.before.data() : null;
    const orderId = String((after && after.orderId) || (before && before.orderId) || "");
    const caseId = String((after && after.cancellationCaseId) || (before && before.cancellationCaseId) || "");

    // Branch 1 — active-order money. Unchanged. reconcileOne is a no-op on a
    // cancelled order (it returns early), which is exactly right: a full
    // cancellation freezes the order and the case owns settlement below.
    if (orderId) {
      try {
        const fixed = await reconcileOne(orderId, null, { eventSource: "payment-write" });
        if (fixed) {
          logger.error("reconcileOnPaymentWrite: corrected order drift", {
            orderId,
            paymentId: event.params.paymentId
          });
          await sendOwnerPush({
            title: "Payment math auto-corrected",
            body: `Order ${orderId} drifted and was reconciled — tap to review.`,
            url: "/reports.html",
            tag: `recon-${orderId}`,
            kind: "money"
          });
        }
      } catch (err) {
        logger.error("reconcileOnPaymentWrite order failed", {
          orderId,
          error: String((err && err.message) || err)
        });
      }
    }

    // Branch 2 — cancellation-case settlement. A refund payment carries a
    // cancellationCaseId; this re-settles the case EVEN WHEN its order is
    // cancelled (where Branch 1 is intentionally a no-op). Independent of Branch
    // 1 so a partial-cancel refund updates both the active order and the case
    // exactly once each. See CANCELLATION-REFUND-PLAN.md.
    if (caseId) {
      try {
        const changed = await reconcileCaseRefund(caseId, { eventSource: "payment-write" });
        if (changed) {
          logger.error("reconcileOnPaymentWrite: corrected case refund", {
            caseId,
            paymentId: event.params.paymentId
          });
        }
      } catch (err) {
        logger.error("reconcileOnPaymentWrite case failed", {
          caseId,
          error: String((err && err.message) || err)
        });
      }
    }
  }
);

// --- Cancellation & refund callables -------------------------------------
//
// The state machine (approval is one transaction; cases own refund obligations;
// refunds are immutable negative /payments) lives in CANCELLATION-REFUND-PLAN.md.
// This slice implements the invariant-bearing paths: full cancellation,
// reduction-only partial cancellation, the request→approve/dismiss flow, and the
// refund lifecycle with over-refund rejection. Deferred to a follow-up (all
// additive, none change these invariants): attachRefundEvidence,
// resolveLegacyCancellation, mixed add/remove partial (re-pricing new products),
// and depositEvents `charge_reversed` reversal (needs per-container-type
// modelling against the order's existing charged events — getting it wrong
// corrupts the "containers you hold" ledger, so it lands on its own).

function requireOwner(request) {
  const role = request.auth && request.auth.token ? request.auth.token.role : null;
  if (role !== "owner") throw new HttpsError("permission-denied", "Owner only.");
  return request.auth.uid;
}

// Runs the atomic approval: re-reads the order/items/payments/sibling cases,
// applies the full or reduction-partial mutation, and writes the approved case —
// all in ONE transaction, so an approved case can never coexist with an
// unmutated order. Idempotent: a second approval of the same caseId is a no-op.
async function applyApprovalTransaction(input) {
  const {
    orderId, caseId, kind, reason, remainingItems,
    requestedBy, requestedByRole, requestedAt, decidedBy
  } = input;

  return db().runTransaction(async (tx) => {
    // ---- READS (all before any write) ----
    const orderRef = db().doc(`orders/${orderId}`);
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists) throw new HttpsError("not-found", "Order not found.");
    const order = orderSnap.data() || {};

    const caseRef = db().doc(`orderCancellations/${caseId}`);
    const caseSnap = await tx.get(caseRef);
    if (caseSnap.exists) {
      const ec = caseSnap.data() || {};
      // Idempotency FIRST — before the order-status guards. A re-run of an
      // already-approved full cancellation would otherwise trip the
      // "order already cancelled" guard on the very order this case cancelled.
      if (ec.decisionStatus === "approved") return { caseId, status: "already_approved" };
      if (ec.decisionStatus === "dismissed") throw new HttpsError("failed-precondition", "This cancellation was dismissed.");
    }

    if (order.status === "delivered") {
      throw new HttpsError("failed-precondition", "A delivered order cannot be cancelled — use a return/refund.");
    }
    if (order.status === "cancelled") {
      throw new HttpsError("failed-precondition", "Order is already cancelled.");
    }
    if (order.status === "out_for_delivery") {
      throw new HttpsError("failed-precondition", "Return the order to assignment before cancelling.");
    }

    const itemsSnap = await tx.get(db().collection("orderItems").where("orderId", "==", orderId));
    const currentItems = itemsSnap.docs.map((d) => ({ _ref: d.ref, ...(d.data() || {}) }));

    const paySnap = await tx.get(db().collection("payments").where("orderId", "==", orderId));
    let netPayments = 0;
    paySnap.forEach((d) => {
      const a = Number((d.data() || {}).amount || 0);
      if (Number.isFinite(a)) netPayments += a;
    });

    // Sibling cases on the same order. Single-field query (no composite index);
    // filter to still-open approved obligations in code.
    const sibSnap = await tx.get(db().collection("orderCancellations").where("orderId", "==", orderId));
    let siblingOpen = 0;
    sibSnap.forEach((d) => {
      if (d.id === caseId) return;
      const c = d.data() || {};
      if (c.decisionStatus === "approved" && (c.refundStatus === "pending" || c.refundStatus === "partial")) {
        siblingOpen += Number(c.refundRemaining || 0);
      }
    });

    // Resolve per-unit deposit from canonical products (orderItems don't store
    // it). Read in the read phase so the snapshot is accurate for both kinds.
    const productIds = Array.from(new Set(currentItems.map((i) => String(i.productId)).filter(Boolean)));
    const prodSnaps = await Promise.all(productIds.map((id) => tx.get(db().doc(`products/${id}`))));
    const depositByProduct = {};
    const containerTypeByProduct = {};
    prodSnaps.forEach((ps) => {
      if (ps.exists) {
        depositByProduct[ps.id] = Number((ps.data() || {}).defaultDepositAmount || 0);
        containerTypeByProduct[ps.id] = (ps.data() || {}).containerType || null;
      }
    });

    // P0-07: outstanding deposit charge per container type, so cancellation can
    // reverse it in this same transaction (was a separate client write —
    // emitDepositReversalsFor — that could fail after the status flip). Nets the
    // order's depositEvents; charge_reversed is in the subtract set so a second
    // cancel on the same order never re-reverses what a prior one already did.
    const depSnap = await tx.get(db().collection("depositEvents").where("orderId", "==", orderId));
    const depositNetByType = {};
    depSnap.forEach((d) => {
      const e = d.data() || {};
      const type = e.containerType || "other";
      const q = Number(e.qty || 0);
      const a = Number(e.amount || 0);
      if (!depositNetByType[type]) depositNetByType[type] = { qty: 0, amount: 0 };
      if (e.eventType === "charged") {
        depositNetByType[type].qty += q;
        depositNetByType[type].amount += a;
      } else if (["refunded", "credited", "forfeited", "charge_reversed"].includes(e.eventType)) {
        depositNetByType[type].qty -= q;
        depositNetByType[type].amount -= a;
      }
    });

    // ---- COMPUTE ----
    const beforeItems = currentItems.map((i) => ({
      productId: String(i.productId || ""),
      name: String(i.productName || ""),
      qty: vnd(i.quantity),
      unitPrice: vnd(i.unitPrice),
      depositPerUnit: vnd(depositByProduct[String(i.productId)] || 0)
    }));
    const beforeSnapshot = {
      status: order.status,
      subtotal: vnd(order.subtotal),
      depositTotal: vnd(order.depositTotal),
      amountPaid: vnd(order.amountPaid),
      balanceDue: vnd(order.balanceDue),
      items: beforeItems
    };

    let revisedSubtotal;
    let revisedDepositTotal;
    let lineDeltas;
    let afterItemsSnapshot;
    let rewriteItems = null;
    let afterStatus;

    if (kind === "full") {
      revisedSubtotal = 0;
      revisedDepositTotal = 0;
      lineDeltas = beforeItems.map((i) => ({
        productId: i.productId, name: i.name, fromQty: i.qty, toQty: 0,
        delta: -i.qty, unitPrice: i.unitPrice, depositPerUnit: i.depositPerUnit
      }));
      afterItemsSnapshot = [];
      afterStatus = "cancelled";
    } else {
      const desired = {};
      (remainingItems || []).forEach((r) => {
        desired[String(r.productId)] = Math.floor(Number(r.quantity) || 0);
      });
      let red;
      try {
        red = computeReductionCancellation(
          currentItems.map((i) => ({
            productId: i.productId, productName: i.productName,
            quantity: i.quantity, unitPrice: i.unitPrice
          })),
          desired,
          depositByProduct
        );
      } catch (err) {
        // Increases / new products are edits, not cancellations.
        throw new HttpsError("invalid-argument", String((err && err.message) || err));
      }
      if (!red.lineDeltas.length) {
        throw new HttpsError("failed-precondition", "A partial cancellation must reduce at least one item.");
      }
      revisedSubtotal = Math.max(0, vnd(order.subtotal) - red.subtotalRemoved);
      revisedDepositTotal = Math.max(0, vnd(order.depositTotal) - red.depositRemoved);
      lineDeltas = red.lineDeltas;
      rewriteItems = red.afterItems;
      afterItemsSnapshot = red.afterItems.map((i) => ({
        productId: i.productId, name: i.productName, qty: i.quantity,
        unitPrice: i.unitPrice, depositPerUnit: i.depositPerUnit
      }));
      afterStatus = order.status; // stays active
    }

    const revisedTotal = revisedSubtotal + revisedDepositTotal;
    const refundRequired = computeRefundRequired(netPayments, revisedTotal, siblingOpen);
    const nowIso = new Date().toISOString();

    // ---- WRITES ----
    if (kind === "full") {
      tx.update(orderRef, {
        status: "cancelled",
        cancellationReason: reason,
        cancelledAt: nowIso,
        cancelledBy: requestedByRole === "customer" ? "owner_via_request" : "owner",
        cancellationCaseId: caseId,
        updatedAt: nowIso
      });
    } else {
      // Rewrite orderItems: delete the current set, write the surviving set —
      // mirrors the existing Edit flow's delete-then-write. amountPaid is
      // re-derived from the fresh payment sum so the order stays self-consistent.
      currentItems.forEach((i) => tx.delete(i._ref));
      rewriteItems.forEach((line) => {
        tx.set(db().doc(`orderItems/${buildOrderId("ITEM")}`), {
          orderId,
          authUid: order.authUid || null,
          productId: line.productId,
          productName: line.productName,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          lineTotal: line.lineTotal,
          depositPerUnit: line.depositPerUnit
        });
      });
      const newAmountPaid = vnd(netPayments);
      const newBalance = revisedTotal - newAmountPaid;
      tx.update(orderRef, {
        subtotal: revisedSubtotal,
        depositTotal: revisedDepositTotal,
        amountPaid: newAmountPaid,
        balanceDue: newBalance,
        paymentStatus: paymentStatusFor(newAmountPaid, newBalance),
        partialCancellationCaseId: caseId,
        updatedAt: nowIso
      });
    }

    // P0-07: reverse the deposit charge for the cancelled portion in THIS
    // transaction (replaces the separate client emitDepositReversalsFor). A full
    // cancel reverses everything still charged; a partial reverses only the
    // removed lines, capped at the outstanding charge per type so a container
    // already returned is never reversed twice. Deterministic id per (case,
    // type) → idempotent.
    const reversalByType = {};
    if (kind === "full") {
      Object.entries(depositNetByType).forEach(([type, net]) => {
        const q = Math.max(0, net.qty);
        const amt = Math.max(0, net.amount);
        if (q > 0 || amt > 0.01) reversalByType[type] = { qty: q, amount: amt };
      });
    } else {
      const removed = {};
      lineDeltas.forEach((ld) => {
        const type = containerTypeByProduct[String(ld.productId)] || "other";
        const removedQty = Math.abs(Number(ld.delta || 0));
        const dep = Number(ld.depositPerUnit || 0);
        if (removedQty <= 0 || dep <= 0) return;
        if (!removed[type]) removed[type] = { qty: 0, amount: 0 };
        removed[type].qty += removedQty;
        removed[type].amount += removedQty * dep;
      });
      Object.entries(removed).forEach(([type, r]) => {
        const outstanding = depositNetByType[type] || { qty: 0, amount: 0 };
        const q = Math.max(0, Math.min(r.qty, Math.max(0, outstanding.qty)));
        const amt = Math.max(0, Math.min(r.amount, Math.max(0, outstanding.amount)));
        if (q > 0 || amt > 0.01) reversalByType[type] = { qty: q, amount: amt };
      });
    }
    Object.entries(reversalByType).forEach(([type, r]) => {
      tx.set(db().doc(`depositEvents/${depositReversalId(caseId, type)}`), {
        orderId,
        customerId: order.customerId || null,
        authUid: order.authUid || null,
        containerType: type,
        qty: r.qty,
        amount: r.amount,
        eventType: "charge_reversed",
        eventDate: nowIso.slice(0, 10),
        linkedDocumentId: null,
        cancellationCaseId: caseId,
        notes: kind === "full"
          ? "Order cancelled — deposit charge reversed"
          : "Partial cancellation — deposit charge reversed",
        createdAtServer: FieldValue.serverTimestamp()
      });
    });

    tx.set(caseRef, {
      orderId,
      customerId: order.customerId || null,
      authUid: order.authUid || null,
      kind,
      decisionStatus: "approved",
      refundStatus: refundRequired > 0 ? "pending" : "not_required",
      evidenceStatus: refundRequired > 0 ? "missing" : "not_required",
      requestedBy: requestedBy || decidedBy,
      requestedByRole: requestedByRole || "owner",
      requestedAt: requestedAt || nowIso,
      reason,
      decidedBy: decidedBy || requestedBy,
      decidedAt: nowIso,
      decisionNote: null,
      before: beforeSnapshot,
      after: {
        status: afterStatus,
        subtotal: revisedSubtotal,
        depositTotal: revisedDepositTotal,
        items: afterItemsSnapshot
      },
      lineDeltas,
      netPaymentsAtDecision: vnd(netPayments),
      revisedOrderTotal: revisedTotal,
      refundRequired,
      refundRemaining: refundRequired,
      source: "app",
      legacyOutcome: null,
      createdAt: (caseSnap.exists && caseSnap.data().createdAt) || nowIso,
      updatedAt: nowIso
    });

    return { caseId, status: "approved", kind, refundRequired };
  });
}

// Owner-only cancellation workflow. Customers cancel unapproved orders through
// the narrow Firestore rule; every post-approval cancellation stays with admin.
// Idempotent on caseId = `${orderId}-cx-${clientRequestId}`.
exports.submitOrderCancellation = onCall(async (request) => {
  const uid = request.auth ? request.auth.uid : null;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in first.");
  const role = request.auth.token ? request.auth.token.role : null;
  if (role !== "owner") throw new HttpsError("permission-denied", "Only the owner can manage an approved-order cancellation.");

  const data = request.data || {};
  const orderId = String(data.orderId || "");
  const kind = String(data.kind || "");
  const reason = String(data.reason || "").trim();
  const clientRequestId = String(data.clientRequestId || "");
  if (!orderId) throw new HttpsError("invalid-argument", "orderId is required.");
  if (kind !== "full" && kind !== "partial") throw new HttpsError("invalid-argument", "kind must be 'full' or 'partial'.");
  if (reason.length < 3 || reason.length > 2000) throw new HttpsError("invalid-argument", "Provide a reason (3–2000 characters).");
  if (!/^[A-Za-z0-9_-]{8,120}$/.test(clientRequestId)) throw new HttpsError("invalid-argument", "clientRequestId must be a stable 8–120 char token.");
  const caseId = `${orderId}-cx-${clientRequestId}`;

  let remainingItems = null;
  if (kind === "partial") {
    remainingItems = Array.isArray(data.remainingItems) ? data.remainingItems : null;
    if (!remainingItems) throw new HttpsError("invalid-argument", "remainingItems is required for a partial cancellation.");
  }
  const res = await applyApprovalTransaction({
    orderId, caseId, kind, reason, remainingItems,
    requestedBy: uid, requestedByRole: "owner", requestedAt: new Date().toISOString(), decidedBy: uid
  });
  if (res && res.refundRequired > 0) {
    await sendOwnerPush({
      title: "Refund now owed",
      body: `${formatVnd(res.refundRequired)} to refund on a cancelled order — tap to handle.`,
      url: `/order.html?id=${orderId}`,
      tag: `refund-${res.caseId || caseId}`,
      kind: "refund"
    });
  }
  return res;
});

// Owner approves (runs the atomic mutation) or dismisses a cancellation request.
exports.resolveOrderCancellation = onCall(async (request) => {
  const uid = requireOwner(request);
  const data = request.data || {};
  const caseId = String(data.caseId || "");
  const decision = String(data.decision || "");
  const decisionNote = data.decisionNote != null ? String(data.decisionNote).slice(0, 2000) : null;
  if (!caseId) throw new HttpsError("invalid-argument", "caseId is required.");
  if (decision !== "approve" && decision !== "dismiss") throw new HttpsError("invalid-argument", "decision must be 'approve' or 'dismiss'.");

  const caseSnap = await db().doc(`orderCancellations/${caseId}`).get();
  if (!caseSnap.exists) throw new HttpsError("not-found", "Cancellation case not found.");
  const c = caseSnap.data() || {};
  if (c.decisionStatus === "approved") throw new HttpsError("failed-precondition", "Already approved.");
  if (c.decisionStatus === "dismissed") throw new HttpsError("failed-precondition", "Already dismissed.");

  const nowIso = new Date().toISOString();

  if (decision === "dismiss") {
    await db().doc(`orderCancellations/${caseId}`).set({
      decisionStatus: "dismissed",
      decidedBy: uid,
      decidedAt: nowIso,
      decisionNote,
      updatedAt: nowIso
    }, { merge: true });
    if (c.orderId) {
      await db().doc(`orders/${c.orderId}`).set({
        cancellationRequested: FieldValue.delete(),
        cancellationRequestReason: FieldValue.delete(),
        cancellationRequestedAt: FieldValue.delete(),
        updatedAt: nowIso
      }, { merge: true });
    }
    return { caseId, status: "dismissed" };
  }

  // approve → run the atomic mutation, converting the request into an approved case.
  const kind = c.kind === "partial" ? "partial" : "full";
  let remainingItems = null;
  if (kind === "partial") {
    remainingItems = Array.isArray(data.remainingItems) ? data.remainingItems : null;
    if (!remainingItems) throw new HttpsError("invalid-argument", "remainingItems is required to approve a partial cancellation.");
  }
  const res = await applyApprovalTransaction({
    orderId: c.orderId,
    caseId,
    kind,
    reason: c.reason || decisionNote || "Approved cancellation",
    remainingItems,
    requestedBy: c.requestedBy || uid,
    requestedByRole: c.requestedByRole || "customer",
    requestedAt: c.requestedAt,
    decidedBy: uid
  });
  if (c.orderId) {
    await db().doc(`orders/${c.orderId}`).set({
      cancellationRequested: FieldValue.delete(),
      cancellationRequestReason: FieldValue.delete(),
      cancellationRequestedAt: FieldValue.delete(),
      updatedAt: nowIso
    }, { merge: true });
  }
  if (res && res.refundRequired > 0) {
    await sendOwnerPush({
      title: "Refund now owed",
      body: `${formatVnd(res.refundRequired)} to refund on a cancelled order — tap to handle.`,
      url: c.orderId ? `/order.html?id=${c.orderId}` : "/reports.html",
      tag: `refund-${res.caseId || caseId}`,
      kind: "refund"
    });
  }
  return res;
});

// Records a refund as an immutable negative /payments entry linked to the case.
// Deterministic payment id makes a retry idempotent; over-refunds are rejected.
async function recordOrderRefundImpl(uid, data) {
  const caseId = String(data.caseId || "");
  const refundId = String(data.refundId || "");
  const amount = vnd(data.amount);
  const method = String(data.method || "");
  const paidAt = String(data.paidAt || new Date().toISOString().slice(0, 10));
  const reference = data.reference != null ? String(data.reference).slice(0, 300) : null;
  const note = data.note != null ? String(data.note).slice(0, 2000) : null;
  const ALLOWED = ["refund_bank", "refund_qr", "refund_cash", "refund_wallet"];
  if (!caseId) throw new HttpsError("invalid-argument", "caseId is required.");
  if (!/^[A-Za-z0-9_-]{4,120}$/.test(refundId)) throw new HttpsError("invalid-argument", "refundId must be a stable 4–120 char token.");
  if (!(amount > 0)) throw new HttpsError("invalid-argument", "Refund amount must be a positive integer.");
  if (!ALLOWED.includes(method)) throw new HttpsError("invalid-argument", "Invalid refund method.");
  // Electronic refunds must record a reference so the money-out can be matched
  // to the transfer later (the photo proof still comes via attachRefundEvidence).
  const refundProblem = refundEvidenceProblem({ method, reference });
  if (refundProblem) throw new HttpsError("invalid-argument", refundProblem);

  return db().runTransaction(async (tx) => {
    const caseRef = db().doc(`orderCancellations/${caseId}`);
    const caseSnap = await tx.get(caseRef);
    if (!caseSnap.exists) throw new HttpsError("not-found", "Cancellation case not found.");
    const c = caseSnap.data() || {};
    if (c.decisionStatus !== "approved") throw new HttpsError("failed-precondition", "Refunds require an approved cancellation.");
    const required = vnd(c.refundRequired);
    if (!(required > 0)) throw new HttpsError("failed-precondition", "This cancellation owes no refund.");

    const paymentId = `${caseId}-refund-${refundId}`;
    const paySnap = await tx.get(db().collection("payments").where("cancellationCaseId", "==", caseId));
    let alreadyRefunded = 0;
    let duplicate = false;
    paySnap.forEach((d) => {
      if (d.id === paymentId) duplicate = true;
      const a = Number((d.data() || {}).amount || 0);
      if (Number.isFinite(a) && a < 0) alreadyRefunded += -a;
    });
    if (duplicate) return { caseId, refundId, status: "already_recorded" };
    if (alreadyRefunded + amount > required) {
      throw new HttpsError("failed-precondition", `Over-refund: ${alreadyRefunded + amount} exceeds the required ${required}.`);
    }

    const nowIso = new Date().toISOString();
    tx.set(db().doc(`payments/${paymentId}`), {
      orderId: c.orderId || null,
      customerId: c.customerId || null,
      authUid: c.authUid || null,
      cancellationCaseId: caseId,
      refundId,
      paymentDate: paidAt,
      method,
      amount: -amount,
      reference,
      receivedBy: uid,
      proofDocumentId: null,
      proofUrl: null,
      notes: note || "Cancellation refund",
      deferred: false,
      createdAt: nowIso
    });

    const refundedNow = alreadyRefunded + amount;
    const remaining = Math.max(0, required - refundedNow);
    const refundStatus = remaining <= 0 ? "paid" : "partial";
    tx.update(caseRef, {
      refundRemaining: remaining,
      refundStatus,
      // Recorded without evidence stays "missing" (Proof-missing queue) — the
      // ledger moved but the refund is not presented as verified to the customer.
      evidenceStatus: c.evidenceStatus === "complete" ? "complete" : "missing",
      updatedAt: nowIso
    });

    return { caseId, refundId, status: "recorded", remaining, refundStatus };
  });
}

exports.recordOrderRefund = onCall(async (request) => {
  const uid = requireOwner(request);
  return recordOrderRefundImpl(uid, request.data || {});
});

// Links an uploaded proof object (bank screenshot / photographed signed cash
// acknowledgment) to a recorded refund and marks the case's evidenceStatus. The
// object itself is written to Storage by the owner client under the create-only
// refund-proofs/ prefix (storage.rules enforces owner-only + immutability); this
// records that object's path/URL and the owner-observed generation/hash
// immutably on the case (server-only collection). Independent server-side
// re-hash of the object is a future hardening — noted in CANCELLATION-REFUND-PLAN.md.
async function attachRefundEvidenceImpl(uid, data) {
  const caseId = String(data.caseId || "");
  const refundId = String(data.refundId || "");
  const storagePath = String(data.storagePath || "");
  const downloadUrl = data.downloadUrl != null ? String(data.downloadUrl).slice(0, 2000) : null;
  const generation = data.generation != null ? String(data.generation).slice(0, 64) : null;
  const md5Hash = data.md5Hash != null ? String(data.md5Hash).slice(0, 128) : null;
  const proofKind = String(data.proofKind || "");
  if (!caseId) throw new HttpsError("invalid-argument", "caseId is required.");
  if (!/^[A-Za-z0-9_-]{4,120}$/.test(refundId)) throw new HttpsError("invalid-argument", "refundId must be a stable 4–120 char token.");
  if (proofKind !== "electronic" && proofKind !== "cash") throw new HttpsError("invalid-argument", "proofKind must be 'electronic' or 'cash'.");
  if (!storagePath.startsWith("refund-proofs/")) throw new HttpsError("invalid-argument", "storagePath must be under refund-proofs/.");

  return db().runTransaction(async (tx) => {
    const caseRef = db().doc(`orderCancellations/${caseId}`);
    const caseSnap = await tx.get(caseRef);
    if (!caseSnap.exists) throw new HttpsError("not-found", "Cancellation case not found.");
    const c = caseSnap.data() || {};
    if (c.decisionStatus !== "approved") throw new HttpsError("failed-precondition", "Evidence requires an approved cancellation.");

    // The refund the evidence covers must actually exist.
    const paySnap = await tx.get(db().collection("payments").where("cancellationCaseId", "==", caseId));
    const refundIdsWithPayment = new Set();
    let matched = false;
    paySnap.forEach((d) => {
      const p = d.data() || {};
      const a = Number(p.amount || 0);
      if (a < 0 && p.refundId) {
        refundIdsWithPayment.add(String(p.refundId));
        if (String(p.refundId) === refundId) matched = true;
      }
    });
    if (!matched) throw new HttpsError("failed-precondition", "No recorded refund with that refundId to attach evidence to.");

    const existing = Array.isArray(c.refundEvidence) ? c.refundEvidence : [];
    const dupe = existing.find((e) => e && e.refundId === refundId
      && (e.storagePath === storagePath || (generation && e.generation === generation)));
    if (dupe) return { caseId, refundId, status: "already_attached", entries: existing.length };

    const nowIso = new Date().toISOString();
    const entry = { refundId, storagePath, downloadUrl, generation, md5Hash, proofKind, attachedBy: uid, attachedAt: nowIso };
    const evidence = existing.concat([entry]);
    // Complete once every recorded refund has at least one evidence entry.
    const covered = new Set(evidence.map((e) => e && e.refundId));
    const allCovered = Array.from(refundIdsWithPayment).every((id) => covered.has(id));

    tx.update(caseRef, {
      refundEvidence: evidence,
      evidenceStatus: allCovered ? "complete" : "missing",
      updatedAt: nowIso
    });
    return { caseId, refundId, status: "attached", evidenceStatus: allCovered ? "complete" : "missing", entries: evidence.length };
  });
}

exports.attachRefundEvidence = onCall(async (request) => {
  const uid = requireOwner(request);
  return attachRefundEvidenceImpl(uid, request.data || {});
});

// Resolves a legacy_imported case (created by the future backfill) with an
// explicit, evidenced outcome — never a silent "write off what we owe".
//   refunded_off_system: the owner attests a refund happened outside the app;
//     writes an immutable negative refund payment LINKED to the case (so the
//     reconciler counts it) and attests the case.
//   payment_not_real: an imported positive payment was a data artifact; writes an
//     immutable reversing payment tagged to the ORDER ONLY (NOT the case — it is
//     an order correction, not a refund, so reconcileCaseRefund must not count
//     it) plus a permanent note.
async function resolveLegacyCancellationImpl(uid, data) {
  const caseId = String(data.caseId || "");
  const outcome = String(data.outcome || "");
  const amount = vnd(data.amount);
  const details = String(data.details || "").trim();
  const legacyMethod = data.method != null ? String(data.method).slice(0, 80) : null;
  const paidAt = String(data.paidAt || new Date().toISOString().slice(0, 10));
  if (!caseId) throw new HttpsError("invalid-argument", "caseId is required.");
  if (outcome !== "refunded_off_system" && outcome !== "payment_not_real") {
    throw new HttpsError("invalid-argument", "outcome must be 'refunded_off_system' or 'payment_not_real'.");
  }
  if (!(amount > 0)) throw new HttpsError("invalid-argument", "amount must be a positive integer.");
  if (details.length < 3) throw new HttpsError("invalid-argument", "details are required (>= 3 chars).");

  return db().runTransaction(async (tx) => {
    const caseRef = db().doc(`orderCancellations/${caseId}`);
    const caseSnap = await tx.get(caseRef);
    if (!caseSnap.exists) throw new HttpsError("not-found", "Cancellation case not found.");
    const c = caseSnap.data() || {};
    if (c.source !== "legacy_imported") throw new HttpsError("failed-precondition", "Only legacy-imported cases use this operation.");
    if (c.legacyOutcome) {
      // Idempotent on the same outcome; a different outcome on an already-resolved
      // case is a conflict, not a silent overwrite.
      if (c.legacyOutcome === outcome) return { caseId, outcome, status: "already_resolved" };
      throw new HttpsError("failed-precondition", "This legacy case is already resolved with a different outcome.");
    }

    const paymentId = `${caseId}-legacy-${outcome}`;
    const existing = await tx.get(db().doc(`payments/${paymentId}`));
    if (existing.exists) return { caseId, outcome, status: "already_resolved" };

    const nowIso = new Date().toISOString();
    const isRefund = outcome === "refunded_off_system";
    tx.set(db().doc(`payments/${paymentId}`), {
      orderId: c.orderId || null,
      customerId: c.customerId || null,
      authUid: c.authUid || null,
      // Only an off-system refund is a case refund the reconciler should count.
      cancellationCaseId: isRefund ? caseId : null,
      correctsCaseId: isRefund ? null : caseId,
      paymentDate: paidAt,
      method: isRefund ? "refund_legacy" : "adjustment",
      amount: -amount,
      reference: null,
      receivedBy: uid,
      legacyMethod,
      proofDocumentId: null,
      proofUrl: null,
      notes: (isRefund ? "Legacy off-system refund attested: " : "Legacy phantom payment reversed: ") + details,
      deferred: false,
      createdAt: nowIso
    });

    const patch = {
      legacyOutcome: outcome,
      decisionNote: details,
      evidenceStatus: "legacy_attested",
      updatedAt: nowIso
    };
    if (isRefund) {
      // The attested off-system refund is a case-tagged negative payment, so keep
      // the case consistent with what reconcileCaseRefund will recompute from it:
      // adopt the attested amount as the requirement when none was recorded, and
      // derive remaining/status from required vs the amount just refunded.
      const required0 = vnd(c.refundRequired);
      const newRequired = required0 > 0 ? required0 : amount;
      patch.refundRequired = newRequired;
      patch.refundRemaining = Math.max(0, newRequired - amount);
      patch.refundStatus = refundStatusFor(newRequired, amount);
    } else {
      // The imported payment was never real, so there is no overpayment to
      // return. Zero the requirement too, or reconcileCaseRefund (which trusts
      // the stored refundRequired) would flip the case back to pending — the
      // reversal is tagged to the order only, not the case.
      patch.refundRequired = 0;
      patch.refundRemaining = 0;
      patch.refundStatus = "not_required";
    }
    tx.update(caseRef, patch);
    return { caseId, outcome, status: "resolved" };
  });
}

exports.resolveLegacyCancellation = onCall(async (request) => {
  const uid = requireOwner(request);
  return resolveLegacyCancellationImpl(uid, request.data || {});
});

// Test-only surface for the functions-emulator behavioral suite
// (cancellation.emulator.test.js). Guarded so `firebase deploy` — which loads
// this module to discover triggers — never sees it. These are plain functions
// with no endpoint, so discovery would ignore them anyway; the guard removes all
// doubt. applyApprovalTransaction backs submit-owner and resolve-approve;
// reconcileCaseRefund backs the payment-write trigger and the nightly backstop.
if (process.env.NODE_ENV === "test" || process.env.FUNCTIONS_EMULATOR === "true") {
  exports._cancellationTestApi = () => ({
    applyApprovalTransaction,
    reconcileCaseRefund,
    recordOrderRefundImpl,
    attachRefundEvidenceImpl,
    resolveLegacyCancellationImpl,
    depositReversalId
  });
  // P0-02: transactional dedup core behind submitPublicOrder.
  exports._orderSubmissionTestApi = () => ({
    createOrderUnderSubmissionKey,
    SUBMISSION_KEY_PATTERN
  });
  // P0-03: pure date/area validators, so the mirror can be tested against the
  // canonical shared.js copy without spinning up the emulator.
  exports._deliveryValidationTestApi = () => ({
    deliveryDateProblem,
    isInsideDeliveryArea,
    businessTodayKey,
    DA_NANG_DELIVERY_BOUNDS,
    SAME_DAY_CUTOFF_HOUR
  });
  // P0-04: signed-in customer identity resolution (pure pick + emulator query).
  exports._customerIdentityTestApi = () => ({
    pickSignedInCustomerId,
    resolveSignedInCustomerId
  });
  // P0-06: atomic approval core + the relocated account-takeover gate.
  exports._approvalTestApi = () => ({
    approveOrderImpl,
    canLinkAuthUidToCustomer,
    computeDepositBreakdown,
    depositChargeId
  });
  // P0-08: atomic delivery-commit core (holdings re-aggregation, clamp,
  // parallel-safe negative prevention, forfeit re-read, fulfilled-only pickup).
  exports._deliveryTestApi = () => ({
    commitDeliveryImpl,
    aggregateHoldings,
    forfeitEventId
  });
  // P0-09: guarded payment entry (fresh status/balance, zero→deferred,
  // acknowledged overpay credit, cancelled/undelivered rejection) + the
  // client-mirror validation helper for the parity test.
  exports._recordPaymentTestApi = () => ({
    recordPaymentImpl,
    collectedPaymentProblem,
    paymentEvidenceProblem,
    refundEvidenceProblem
  });
}

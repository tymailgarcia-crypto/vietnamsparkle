// One-off migration: create a legacy_imported /orderCancellations case for every
// order that is already status === "cancelled" but has no case yet. This gives
// the cancellation/refund system a record for historical cancellations and, when
// money was received and never returned, surfaces the outstanding refund
// liability for owner review. See CANCELLATION-REFUND-PLAN.md → Migration.
//
// SAFETY: an order that still has positive net payments is flagged
// legacyReview + refundStatus "pending" — we NEVER infer that an off-system
// refund happened. The owner resolves each flagged case explicitly with the
// resolveLegacyCancellation callable (refunded_off_system | payment_not_real).
//
// Usage (dry-run by default — prints what it WOULD create, writes nothing):
//   FIREBASE_SERVICE_ACCOUNT_PATH=/path/to/sa.json \
//   node src/scripts/backfillLegacyCancellations.js --dry-run
//   ...add --write to actually create the cases, --limit N to cap.
//
// Idempotent: the case id is deterministic (`${orderId}-cx-legacy`), so a
// re-run skips orders that already have a case. testFixture orders are skipped.

import { getFirestore } from "../config/firebaseAdmin.js";
import { COLLECTIONS } from "../firestore/schema.js";
import { FieldPath } from "firebase-admin/firestore";
import { pathToFileURL } from "url";

function vnd(n) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.round(v) : 0;
}

// Pure: reconstruct the legacy case doc (minus timestamps) from an order and its
// items + payments. No I/O — unit-tested in backfillLegacyCancellations.test.mjs.
export function computeLegacyCase({ order, items, payments }) {
  let netPayments = 0;
  for (const p of payments || []) {
    const a = Number((p || {}).amount || 0);
    if (Number.isFinite(a)) netPayments += a;
  }
  netPayments = vnd(netPayments);

  const beforeItems = (items || []).map((i) => ({
    productId: String((i || {}).productId || ""),
    name: String((i || {}).productName || ""),
    qty: vnd((i || {}).quantity),
    unitPrice: vnd((i || {}).unitPrice),
    // Legacy orderItems never stored per-unit deposit; leave 0 rather than guess.
    depositPerUnit: 0
  }));

  // Money received and never returned is an OUTSTANDING liability, not a proof of
  // refund. Flag for owner review; never auto-settle it.
  const hasOutstanding = netPayments > 0;

  return {
    orderId: order.id,
    customerId: order.customerId || null,
    authUid: order.authUid || null,
    kind: "full",
    decisionStatus: "approved",
    refundStatus: hasOutstanding ? "pending" : "not_required",
    evidenceStatus: hasOutstanding ? "missing" : "not_required",
    // review_required marker (design's term) for the Historical-review queue.
    legacyReview: hasOutstanding,
    requestedBy: order.cancelledBy || "legacy_import",
    requestedByRole: order.cancelledBy === "customer" ? "customer" : "owner",
    requestedAt: order.cancelledAt || order.createdAt || null,
    reason: order.cancellationReason || "Imported cancellation (no reason recorded)",
    decidedBy: "legacy_import",
    decidedAt: order.cancelledAt || null,
    decisionNote: null,
    before: {
      status: "cancelled",
      subtotal: vnd(order.subtotal),
      depositTotal: vnd(order.depositTotal),
      amountPaid: vnd(order.amountPaid),
      balanceDue: vnd(order.balanceDue),
      items: beforeItems
    },
    after: { status: "cancelled", subtotal: 0, depositTotal: 0, items: [] },
    lineDeltas: beforeItems.map((i) => ({
      productId: i.productId, name: i.name, fromQty: i.qty, toQty: 0,
      delta: -i.qty, unitPrice: i.unitPrice, depositPerUnit: 0
    })),
    netPaymentsAtDecision: netPayments,
    revisedOrderTotal: 0,
    refundRequired: hasOutstanding ? netPayments : 0,
    refundRemaining: hasOutstanding ? netPayments : 0,
    source: "legacy_imported",
    legacyOutcome: null
  };
}

// Walk cancelled orders and create the missing legacy cases. Returns stats.
export async function runBackfill(db, { dryRun = true, limit = null } = {}) {
  const stats = { scanned: 0, created: 0, skipped: 0, reviewRequired: 0, outstanding: 0 };
  const pageSize = 200;
  let cursor = null;

  while (true) {
    let q = db.collection(COLLECTIONS.orders)
      .where("status", "==", "cancelled")
      .orderBy(FieldPath.documentId())
      .limit(pageSize);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    if (snap.empty) break;

    for (const orderDoc of snap.docs) {
      if (limit && stats.scanned >= limit) return stats;
      stats.scanned += 1;
      const order = { id: orderDoc.id, ...orderDoc.data() };
      if (order.testFixture === true) { stats.skipped += 1; continue; }

      const caseId = `${order.id}-cx-legacy`;
      const caseRef = db.collection(COLLECTIONS.orderCancellations).doc(caseId);
      const existing = await caseRef.get();
      if (existing.exists) { stats.skipped += 1; continue; } // idempotent

      const [itemsSnap, paymentsSnap] = await Promise.all([
        db.collection(COLLECTIONS.orderItems).where("orderId", "==", order.id).get(),
        db.collection(COLLECTIONS.payments).where("orderId", "==", order.id).get()
      ]);
      const legacyCase = computeLegacyCase({
        order,
        items: itemsSnap.docs.map((d) => d.data()),
        payments: paymentsSnap.docs.map((d) => d.data())
      });

      if (legacyCase.legacyReview) {
        stats.reviewRequired += 1;
        stats.outstanding += legacyCase.refundRequired;
      }

      if (dryRun) {
        console.log(`[dry-run] ${caseId} refundStatus=${legacyCase.refundStatus} refundRequired=${legacyCase.refundRequired}${legacyCase.legacyReview ? " REVIEW_REQUIRED" : ""}`);
      } else {
        const now = new Date().toISOString();
        await caseRef.set({ ...legacyCase, createdAt: now, updatedAt: now });
      }
      stats.created += 1;
    }

    if (snap.size < pageSize) break;
    cursor = snap.docs[snap.docs.length - 1];
  }

  return stats;
}

function parseArgs(argv) {
  const args = { dryRun: true, limit: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--write") args.dryRun = false;
    else if (argv[i] === "--dry-run") args.dryRun = true;
    else if (argv[i] === "--limit") args.limit = Number(argv[i + 1]);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const db = getFirestore();
  console.log(`Backfilling legacy cancellation cases (${args.dryRun ? "DRY-RUN" : "WRITE"}${args.limit ? `, limit ${args.limit}` : ""})...`);
  const stats = await runBackfill(db, args);
  console.log(
    `Done. scanned=${stats.scanned} created=${stats.created} skipped=${stats.skipped} ` +
    `reviewRequired=${stats.reviewRequired} outstanding=${stats.outstanding}` +
    (args.dryRun ? "  (dry-run — nothing written)" : "")
  );
}

// Only run the CLI when invoked directly, so tests can import the functions.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

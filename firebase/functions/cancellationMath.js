"use strict";

// Pure money math for cancellations & refunds. No Firestore, no I/O — unit-tested
// in cancellationMath.test.js so the risky arithmetic is provable without the
// emulator. The app deals in whole Vietnamese dong, so every result is rounded to
// an integer to keep float drift out of the ledger. See CANCELLATION-REFUND-PLAN.md.

function vnd(n) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.round(v) : 0;
}

// Refund owed by THIS cancellation.
//
// netPayments = sum of the order's payment amounts (positive receipts PLUS any
//   already-negative completed refunds) = money in hand now.
// revisedTotal = subtotal + depositTotal after this cancellation (0 for a full
//   cancel).
// siblingOpenObligations = refundRemaining summed across OTHER approved cases on
//   the same order that are still open (pending/partial). Subtracting it stops
//   two cases claiming the same overpayment.
function computeRefundRequired(netPayments, revisedTotal, siblingOpenObligations) {
  return Math.max(
    0,
    vnd(netPayments) - vnd(revisedTotal) - vnd(siblingOpenObligations)
  );
}

// refundStatus from the required amount vs the summed positive refunded amount.
function refundStatusFor(refundRequired, refundedSoFar) {
  const required = vnd(refundRequired);
  if (required <= 0) return "not_required";
  const remaining = Math.max(0, required - vnd(refundedSoFar));
  if (remaining <= 0) return "paid";
  return vnd(refundedSoFar) > 0 ? "partial" : "pending";
}

// Pure REDUCTION: desiredQtyByProduct maps productId -> final quantity. Every
// entry must be <= the current quantity and reference an existing product (a
// reduction, not an edit) — throws otherwise so the caller routes true edits
// (new products, increases) elsewhere. Products absent from desiredQtyByProduct
// are left unchanged. depositByProduct supplies the per-unit deposit because
// orderItems do not store it.
//
// Returns the removed value (to subtract from the order's stored totals, which
// preserves the originally-agreed unit prices on retained lines instead of
// repricing them), the per-line deltas, and the surviving "after" item list.
function computeReductionCancellation(currentItems, desiredQtyByProduct, depositByProduct) {
  const desired = desiredQtyByProduct || {};
  const deposits = depositByProduct || {};
  const currentIds = new Set(currentItems.map((i) => String(i.productId)));

  for (const pid of Object.keys(desired)) {
    if (!currentIds.has(String(pid))) {
      throw new Error(`reduction cannot add a new product: ${pid}`);
    }
  }

  let subtotalRemoved = 0;
  let depositRemoved = 0;
  const lineDeltas = [];
  const afterItems = [];

  for (const item of currentItems) {
    const pid = String(item.productId);
    const currentQty = vnd(item.quantity);
    const unitPrice = vnd(item.unitPrice);
    const depositPerUnit = vnd(deposits[pid] != null ? deposits[pid] : item.depositPerUnit);
    const finalQty = Object.prototype.hasOwnProperty.call(desired, pid)
      ? vnd(desired[pid])
      : currentQty;

    if (finalQty > currentQty) {
      throw new Error(`reduction cannot increase quantity for ${pid}`);
    }
    if (finalQty < 0) {
      throw new Error(`negative quantity for ${pid}`);
    }

    const removedQty = currentQty - finalQty;
    if (removedQty > 0) {
      subtotalRemoved += removedQty * unitPrice;
      depositRemoved += removedQty * depositPerUnit;
      lineDeltas.push({
        productId: pid,
        name: String(item.productName || item.name || ""),
        fromQty: currentQty,
        toQty: finalQty,
        delta: -removedQty,
        unitPrice,
        depositPerUnit
      });
    }
    if (finalQty > 0) {
      afterItems.push({
        productId: pid,
        productName: String(item.productName || item.name || ""),
        quantity: finalQty,
        unitPrice,
        lineTotal: unitPrice * finalQty,
        depositPerUnit
      });
    }
  }

  return {
    subtotalRemoved: vnd(subtotalRemoved),
    depositRemoved: vnd(depositRemoved),
    lineDeltas,
    afterItems
  };
}

module.exports = {
  vnd,
  computeRefundRequired,
  refundStatusFor,
  computeReductionCancellation
};

# Cancellation & Refund — Step 1 server slice (design)

Status: **server slice partially built (2026-07-19), uncommitted, undeployed.**
This is the concrete plan for the first, additive slice — the state machine,
server helpers, reconciler restructure, and tests. No UI, no rule-tightening, no
backfill in this slice. Written against the real code shapes (see line refs) so
field names and rules are exact.

## Build status (2026-07-19)

Landed on disk, verified at the level noted; **nothing committed or deployed**:

- **Rules — DONE + emulator-green.** `firestore.rules` `orderCancellations` block
  (server-write-only, owner + customer-own read) and `storage.rules`
  `refund-proofs` (create-only, owner read). New suite
  `rules-tests/ordercancellations.rules.test.mjs` — **13/13 green**. Takeover
  gate re-run after the rules edit: authuid-linking 11, email-takeover 4,
  customers 24, payments 17 — **all green, pin intact** (only the two documented
  L193/L255 benign residuals in stderr).
- **Reconciler — DONE + syntax/load-verified.** `reconcileCaseRefund` helper, the
  two-branch `reconcileOnPaymentWrite` (order branch + case branch), and the
  nightly case-refund backstop in `nightlyReconcileOrderMath`. `node --check` +
  module-load OK.
- **Pure money math — DONE + unit-green.** `functions/cancellationMath.js`
  (`computeRefundRequired`, `refundStatusFor`, `computeReductionCancellation`) +
  `functions/cancellationMath.test.js` — **18/18 green**, incl. the
  consecutive-cancellation no-double-count and the reduction guards.
- **Callables — all 5 built + emulator-behavior-tested.**
  `submitOrderCancellation` (owner immediate full / reduction-only partial;
  customer request), `resolveOrderCancellation` (approve→atomic mutation /
  dismiss), `recordOrderRefund` (immutable negative payment, over-refund
  rejection, idempotent), `attachRefundEvidence` (links a create-only
  refund-proofs object to a refund, flips evidenceStatus), and
  `resolveLegacyCancellation` (`refunded_off_system` → case-linked refund payment;
  `payment_not_real` → order-only reversal, never counted as a refund). Deploy-mode
  load = 9 exports; the test surface is guarded behind
  `NODE_ENV=test`/`FUNCTIONS_EMULATOR`, so `firebase deploy` never sees it.
- **Behavioral suite — DONE + emulator-green.**
  `functions/cancellation.emulator.test.js` drives all the cores against the
  Firestore emulator via the Admin SDK — **23/23 green**: full/partial approval,
  the delivered/out-for-delivery guards, duplicate-approval idempotency, partial
  money math on the order + case, over-refund rejection, duplicate-refundId
  idempotency, `reconcileCaseRefund` settlement/idempotency/over-refund-flag,
  evidence completeness across multiple refunds + guards, and both legacy outcomes
  (incl. proving `payment_not_real` is NOT counted as a refund by the reconciler).
  **Caught two real bugs:** (1) the order-status guard fired before the idempotency
  check, so a duplicate full-cancel approval threw instead of a no-op; (2) the
  legacy `legacyOutcome` guard threw on a same-outcome retry instead of returning
  idempotently. Both fixed and re-verified.
- **Legacy backfill — DONE + tested.** `src/scripts/backfillLegacyCancellations.js`
  (dry-run default; `--write` / `--limit N`) creates a `legacy_imported` case per
  already-cancelled order; a positive net-payment order is flagged `legacyReview`
  + `refundStatus: pending` for owner review (NEVER inferred as refunded). Pure
  `computeLegacyCase` + `runBackfill` — **7/7 green** on the emulator (dry-run
  writes nothing, write is idempotent, testFixture skipped). `schema.js` gained
  the `orderCancellations` collection name. Feeds `resolveLegacyCancellation`.

**Not yet done — before this ships to users:**

- **Mixed add/remove partial cancellation** (re-pricing genuinely new products) —
  this cut is **reduction-only**; increases/new products are rejected as edits.
- **`depositEvents` `charge_reversed` reversal** — deferred so it can be modelled
  per container type against the order's existing charged events without
  corrupting the "containers you hold" ledger. NOTE: this needs a coordinated
  CLIENT change too — the "containers you hold" aggregation nets
  `charged − refunded − credited − forfeited` and must learn `charge_reversed`.
- **Client wiring** (order-record panel, Receivables queues, dashboard badges,
  customer refund view) and the scoped rule-tightening. The backfill above is
  built; run it with `--write` when ready (after the Historical-review UI exists
  so the flagged cases are actionable).
- **Independent server-side re-hash** of refund-proof objects (attachRefundEvidence
  currently records the owner-observed Storage generation/hash; storage.rules
  already enforce create-only immutability of the object itself).

Read [AGENTS.md](AGENTS.md) and `.agent-status.md` before implementing. This
touches the least-entangled files on purpose (`firebase/functions/index.js`,
`firebase/firestore.rules`, `firebase/storage.rules`, new test files) so it can
land as its own committed unit ahead of the shared web files.

## Decisions locked (2026-07-19)

- **Approval is one transaction.** No separate "approve, then apply". The order +
  item + deposit mutation and the case's `decisionStatus: 'approved'` commit
  together or not at all. (Fixes the split-write the whole feature is meant to
  kill.)
- **Cancellation cases own refund obligations + proof status.** The normal
  reconciler only maintains *active-order* money fields.
- **Customer self-cancel of an unpaid `pending_approval` order stays a direct
  Firestore write** — the existing rule-enforced `pending_approval → cancelled`
  transition ([firestore.rules:121](firebase/firestore.rules)). It creates **no
  case**: there is no money movement, and a full cancel never rewrites
  `orderItems`, so the exact item state is reconstructable from the retained
  order + `orderItems`. **Consequence:** not every cancellation has a case — any
  "all cancellations" view must union `orderCancellations` ∪ caseless cancelled
  orders. Everything money-relevant (owner cancels, paid/partial, request→approve
  on an already-approved order) does go through a callable and does get a case.
- **A refund can be recorded before proof exists** — ledger moves immediately,
  case sits `evidenceStatus: 'missing'`, shown as *pending confirmation*, never
  *confirmed*, until evidence is attached.
- **Item changes are classified per `productId`, not by net cart value.** Removing
  A while adding a pricier B still records a partial-cancellation event (refund
  may be 0 because the addition absorbs the removed value).

## A. `/orderCancellations/{caseId}`

`caseId = ${orderId}-cx-${clientRequestId}` (caller passes a uuid
`clientRequestId`). A retried/duplicated callable resolves to the same doc, so
concurrent submits converge instead of minting two cases. One order can hold many
cases over time (consecutive partial cancels) — that is why `caseId` is not just
`orderId`.

One immutable discriminator (`kind`) + three orthogonal lifecycles:

```
/orderCancellations/{caseId}
  orderId, customerId, authUid            // authUid mirrors the order, for customer read-scoping

  kind: 'full' | 'partial'                // set once, never transitions

  decisionStatus: 'requested' | 'approved' | 'dismissed'   // approved & dismissed terminal
  refundStatus:   'not_required' | 'pending' | 'partial' | 'paid'
  evidenceStatus: 'not_required' | 'missing' | 'complete' | 'legacy_attested'

  // actors — write-once
  requestedBy, requestedByRole: 'customer'|'owner', requestedAt, reason
  decidedBy, decidedAt, decisionNote

  // immutable snapshots — the "reconstruct exact pre-cancel state" acceptance criterion
  before: { status, subtotal, depositTotal, amountPaid, balanceDue,
            items: [{ productId, name, qty, unitPrice, depositPerUnit }] }
  after:  { status, subtotal, depositTotal, items: [...] }     // full => items:[], totals 0
  lineDeltas: [{ productId, name, fromQty, toQty, delta, unitPrice }]   // negative deltas only

  // money — OWNED by the case, always recomputed, never incremented
  netPaymentsAtDecision   // sum of order payment.amount at approval (audit snapshot)
  revisedOrderTotal       // subtotal+depositTotal after (0 for full)
  refundRequired          // max(0, netPayments - revisedOrderTotal - SUM(sibling open refundRemaining))
  refundRemaining         // refundRequired - SUM(this case's linked negative refund payments)

  source: 'app' | 'legacy_imported'
  legacyOutcome: 'refunded_off_system' | 'payment_not_real' | null
  createdAt, updatedAt
```

**Immutability posture:** clients never write this collection; all mutation is via
a callable on the Admin SDK, same posture as `reconciliationEvents`:

```
match /orderCancellations/{caseId} {
  allow read:  if isOwner() || (isCustomer() && resource.data.authUid == myUid());
  allow write: if false;   // Admin SDK (callables) only
}
```

Server-only writes + free customer read-scoping, and **no field-level
immutability rules needed** because no client can write any field.

**Refund-liability formula, variables pinned so nobody double-counts:**
- `netPayments` = sum of `payment.amount` over the order (positive receipts **plus**
  already-negative completed refunds) = money in hand now.
- `SUM(sibling open refundRemaining)` = obligations from *other* approved cases on
  the same order not yet paid out (stops two cases claiming the same overpayment).
- `refundRequired = max(0, netPayments − revisedOrderTotal − SUM(sibling open refundRemaining))`.

## B. Refund payment — the case↔ledger link

Refunds are immutable negative `/payments` docs (same shape as the existing
`deposit_refund` at [orderApp.js:1289](firebase/web/assets/orderApp.js)) plus two
link fields:

```
/payments/${caseId}-refund-${refundId}      // deterministic id => idempotent retry
  orderId, customerId, authUid,
  cancellationCaseId: caseId,               // NEW — trigger + case re-sum key off this
  refundId,                                 // NEW — client-supplied, unique per case
  method: 'refund_bank'|'refund_qr'|'refund_cash'|'refund_wallet',
  amount: -<refunded>,                      // negative, same convention as deposit_refund
  reference, paidAt, receivedBy, notes,
  proofDocumentId: null,                    // filled later by attachRefundEvidence
  deferred: false, createdAt
```

**No `/payments` rules change.** Owner create already allows any amount incl.
negative ([firestore.rules:255](firebase/firestore.rules)); `update, delete: if
false` already makes it immutable ([firestore.rules:272](firebase/firestore.rules)).
Refunds are Admin-SDK-written anyway, so rules never gate them.

## C. `reconcileOnPaymentWrite` restructure — two independent branches

The case branch **cannot** live inside `reconcileOne`: that helper hard-returns on
cancelled orders ([index.js:596](firebase/functions/index.js)), and a full-cancel
refund lands on a cancelled order. So it is a sibling.

```js
exports.reconcileOnPaymentWrite = onDocumentWritten(
  { document: "payments/{paymentId}", region: "asia-east2" },
  async (event) => {
    const after  = event.data?.after?.exists  ? event.data.after.data()  : null;
    const before = event.data?.before?.exists ? event.data.before.data() : null;
    const orderId = String(after?.orderId || before?.orderId || "");
    const caseId  = String(after?.cancellationCaseId || before?.cancellationCaseId || "");

    // Branch 1 — active-order money. UNCHANGED. No-op on cancelled orders (line 596).
    if (orderId) {
      try {
        const fixed = await reconcileOne(orderId, null, { eventSource: "payment-write" });
        if (fixed) logger.error("reconcileOnPaymentWrite: corrected order drift", { orderId });
      } catch (err) { logger.error("reconcileOnPaymentWrite order failed", { orderId, error: String(err?.message||err) }); }
    }

    // Branch 2 — cancellation-case settlement. Runs EVEN WHEN the order is cancelled.
    if (caseId) {
      try {
        const changed = await reconcileCaseRefund(caseId, { eventSource: "payment-write" });
        if (changed) logger.error("reconcileOnPaymentWrite: corrected case refund", { caseId });
      } catch (err) { logger.error("reconcileOnPaymentWrite case failed", { caseId, error: String(err?.message||err) }); }
    }
  }
);

// Recompute refundRemaining from immutable negative payments — never increment.
async function reconcileCaseRefund(caseId, opts = {}) {
  return db().runTransaction(async (tx) => {
    const caseRef = db().doc(`orderCancellations/${caseId}`);
    const snap = await tx.get(caseRef);
    if (!snap.exists) return false;
    const c = snap.data() || {};
    if (c.decisionStatus !== "approved") return false;      // requested/dismissed never settle
    const required = Number(c.refundRequired || 0);
    if (required <= 0) return false;

    const paySnap = await tx.get(
      db().collection("payments").where("cancellationCaseId", "==", caseId)
    );
    let refunded = 0;
    paySnap.forEach((d) => { const a = Number((d.data()||{}).amount||0);
      if (Number.isFinite(a) && a < 0) refunded += -a; });

    const remaining = Math.max(0, required - refunded);
    const status = remaining <= 0 ? "paid" : (refunded > 0 ? "partial" : "pending");
    const overRefunded = refunded > required;   // console write can't be rejected after the fact

    if (Number(c.refundRemaining||0) === remaining && c.refundStatus === status && !overRefunded) return false;

    tx.update(caseRef, { refundRemaining: remaining, refundStatus: status,
                         updatedAt: new Date().toISOString() });
    // if (opts.eventSource && overRefunded) -> write a reconciliationEvents anomaly row
    return true;
  });
}
```

**Nightly backstop (required).** `reconcileOnPaymentWrite` is fire-and-forget — it
logs and swallows on failure ([index.js:703](firebase/functions/index.js)) — and
`nightlyReconcileOrderMath` only walks orders, skipping cancelled. So without this,
cancelled-order cases have no nightly safety net. In the nightly job, after the
order sweep, add a case sweep: query `orderCancellations where
decisionStatus=='approved' && refundStatus in ['pending','partial']` and call
`reconcileCaseRefund` on each.

**Two properties to document so no one is surprised:**
1. On a **full** cancel the order's `amountPaid/balanceDue` stay frozen at
   pre-cancel values forever (reconciler skips it); the **case** is the
   authoritative post-cancel money view. Any surface reading a cancelled order's
   money fields is reading pre-refund figures by design.
2. On a **partial** cancel the order stays active, so a refund's negative payment
   flows through *both* branches — Branch 1 lowers order `amountPaid`, Branch 2
   lowers case `refundRemaining` — without collision because the partial-cancel
   mutation already rewrote `subtotal` down to `revisedOrderTotal`
   (100 + (−40) = 60 = revised total, balance 0; case 40 − 40 = 0, paid).

## D. Callables (skeletons)

**`submitOrderCancellation` / `resolveOrderCancellation` — approval is one tx:**

```
one db().runTransaction:
 1. tx.get(order, orderItems, payments)  — re-read, never trust the client snapshot
 2. reject: delivered; out_for_delivery not returned to 'assigned'; duplicate decision
    (case already approved/dismissed); stale item qty (client 'before' != live)
 3. compute after{} + lineDeltas (per productId; negative deltas only)
 4. compute refundRequired via the formula (read sibling cases in the SAME tx)
 5a. FULL:    tx.update(order,{status:'cancelled'}) + charge_reversed deposit event
 5b. PARTIAL: tx rewrite orderItems, tx.update(order,{subtotal,depositTotal,balanceDue,
              paymentStatus: paymentStatusFor(...)})  — order stays active
 6. tx.set(case,{ decisionStatus:'approved', kind, before, after, lineDeltas,
              refundRequired, refundRemaining:refundRequired,
              refundStatus: refundRequired>0 ? 'pending' : 'not_required',
              evidenceStatus: refundRequired>0 ? 'missing' : 'not_required', ... })
```

- Owner submit auto-approves in this one tx.
- Customer submit on an already-approved / assigned / out_for_delivery order writes
  only `decisionStatus:'requested'` and mutates nothing; the owner runs
  `resolveOrderCancellation` (steps 1–6) or dismisses (writes `dismissed`,
  preserves reason/actor permanently). This replaces the old
  `cancellationRequested` three-field flag write.
- Customer submit on an unpaid `pending_approval` order is **NOT** this callable —
  it stays the direct rule-enforced transition (decision above).

**`recordOrderRefund` — over-refund rejected at the door:**

```
one transaction:
 1. tx.get(case); require decisionStatus=='approved' && refundRequired>0
 2. re-sum existing linked negative payments -> alreadyRefunded
 3. reject if (alreadyRefunded + amount) > refundRequired   -> 'over-refund'
 4. tx.set(payments/${caseId}-refund-${refundId}, {...negative amount, cancellationCaseId...})
 5. tx.update(case,{ refundRemaining, refundStatus,
                     evidenceStatus: proof ? 'complete' : 'missing' })
```

**`attachRefundEvidence`** — verify the uploaded Storage object (client uploads
first), then write immutable evidence metadata (generation/hash) and set
`evidenceStatus:'complete'`. **`resolveLegacyCancellation`** — `refunded_off_system`
(historical date/method/note + correcting negative payment) or `payment_not_real`
(reversing payment + permanent note). No plain "write off what we owe". These two
carry no new invariants beyond immutable create-only evidence.

## E. Rules delta for this slice

- **New:** the `orderCancellations` block above.
- **New:** Storage `refund-proofs/{orderId}/{refundId}` — create-only, owner-write,
  **customer read scoped to their own authUid** (owner reads all; a customer reads
  only proofs whose metadata carries their authUid).
- **Unchanged:** `/payments`, and the `/orders` customer `pending_approval →
  cancelled` transition ([firestore.rules:121](firebase/firestore.rules)) stays —
  do NOT tighten it (see step-4 note).

## F. Test list (emulator + rules)

Extend `firebase/rules-tests/`; leave the account-takeover suites untouched
(CLAUDE.md hard constraint).

**State machine & money**
- Unpaid full cancel -> `not_required`, order cancelled, no payment written.
- Partially-paid full cancel -> `refundRequired == netPayments`, `pending`.
- Fully-paid full cancel -> refund == amount paid.
- Overpaid order -> refund == overpayment only.
- Partial cancel, single negative delta -> order active, `subtotal` rewritten,
  `balanceDue == subtotal+deposit − amountPaid`, case owns `refundRequired`.
- Mixed add+remove in one save -> partial-cancel case for the removed product, the
  add is an ordinary line, refund uses the revised total (addition may absorb it
  to 0 but the case is still recorded).
- Metadata-only / addition-only edit -> no case created.
- Consecutive cancellations with an open liability ->
  `refundRequired == max(0, netPayments − revised − firstCase.refundRemaining)`.

**Refunds**
- Repeated partial refunds drive `pending -> partial -> paid`; `refundRemaining`
  reaches 0.
- Over-refund (`already + amount > required`) rejected.
- Refund without proof -> ledger moves, `evidenceStatus:'missing'`, customer sees
  *pending confirmation*, never *confirmed*.

**Atomicity & concurrency**
- Approve **full** cancel is atomic: post-tx `order.status=='cancelled'` AND
  `case.decisionStatus=='approved'`; no state where an approved full case coexists
  with an active order. (Scope the assertion to full — partial is intentionally
  active.)
- Duplicate/concurrent `resolveOrderCancellation` -> one wins, retry is a no-op.
- Concurrent `recordOrderRefund` with same `refundId` -> single payment.
- `charge_reversed` deposit reversal idempotent on re-run.

**Guards**
- Delivered -> reject. `out_for_delivery` not returned to `assigned` -> approval
  blocked (request may still be recorded). Stale item qty -> reject.

**Reconciler**
- Console-written refund payment on a cancelled order -> Branch 2 updates the case,
  Branch 1 leaves the frozen order untouched; a `reconciliationEvents` row appears.
- Active partial-cancel order still reconciles normally (Branch 1).
- Nightly case sweep settles a case whose real-time trigger was dropped.
- Full cancels never surface as a receivable.

**Rules**
- Owner reads any case; customer reads only own; cross-customer denied.
- Client write to `orderCancellations` denied.
- Refund payment/evidence immutable (`update/delete` denied).
- Storage `refund-proofs` create-only; cross-customer read denied.

## G. Slice boundary

**In this slice (additive, ships while current clients keep working):** the case
doc + rules, the callables, the `reconcileOnPaymentWrite` restructure +
`reconcileCaseRefund` + nightly case sweep, and the suites above. Files:
`firebase/functions/index.js`, `firebase/firestore.rules`,
`firebase/storage.rules`, new test files.

**Deferred (later slices):**
1. Route the live Edit/cancel buttons through the callables.
2. **Tighten rules — scoped.** Block direct-write cancellation EXCEPT preserve the
   customer unpaid `pending_approval → cancelled` transition (kept permanently per
   decision above). Migrate the customer request-cancellation flag-write to the
   callable. This scoping is also why there is no stale-client breakage: the one
   direct-write rule a cached browser depends on is not removed.
3. Receivables queues (Refunds due / Partial refunds / Proof missing / Historical
   review), dashboard badges, customer refund status, finance split.
4. Backfill historical cancelled orders into `legacy_imported` cases (dry-run then
   reviewed); positive-payment cases flagged for review, never auto-inferred as
   refunded.

## Acceptance (this slice)

- One approval transaction can never leave an approved **full** case with an active
  order.
- Case refund totals equal linked refund payments.
- Active partial-cancel orders still reconcile normally.
- Full cancellations never reappear as customer receivables.
- A refund can be recorded without proof but cannot appear verified.
- Every case can reconstruct the exact affected item state; caseless
  (unpaid-pending self-cancel) orders reconstruct from retained order + orderItems.

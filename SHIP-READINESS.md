# Vietnam Sparkle — Pre-ship stabilization board

**Status:** NO-GO for public launch or handover
**Started:** 2026-07-20
**Owners:** Codex + Claude Code
**Purpose:** finish only the work needed to make ordering, daily operations, money, deposits, and release recovery safe. Product expansion belongs after this board is green.

This document is the shared source of truth for pre-ship work. `ROADMAP.md` remains the broader history and ideas list. `.agent-status.md` remains the live file-claim board.

## How Codex and Claude use this file

1. Before editing anything, run `git status` and read `.agent-status.md`.
2. Claim the exact files and task ID in `.agent-status.md` before touching code.
3. Put your name beside only one in-progress task below. Do not start work in files held by the other agent.
4. A task is not complete because code exists. Its acceptance checks, focused tests, syntax checks, and required browser QA must all pass.
5. Record the commit and deployment evidence in this file when a task ships.
6. Never use `git add -A` or `git commit -a`. Stage only your own hunks.
7. Never run a Hosting deployment while another agent has live work anywhere under `firebase/web/`. Hosting publishes the whole directory.
8. If a finding proves false, do not silently delete it. Mark it closed with the evidence and date.

### Status notation

- `[ ]` not started
- `[~]` in progress — include agent name and UTC start time
- `[x]` complete and verified
- `[!]` blocked — state the blocker and the decision needed

## Ship gate

- **Minimized End/right-thumb controls, 2026-11-08.** Hosting-only `9ce4e7e012644d1f`, reconciled from `331c768fc8850d77` after the AI accessibility claim was released. Five assets uploaded; all 62 served paths matched SHA-256. Six shared return transaction checks and browser dock/map tests passed, covering cross-page End, declined confirmation, failed retry, completed-order guard, driver/payment field preservation, right-side touch targets and layout. See HANDOFF.md and `firebase/.firebase/right-handed-delivery-2026-11-07/` for evidence.

- **Delivery retry and Ask menu deployed, 2026-11-07.** Hosting-only `f7a6023f22a45c27`, reconciled from AI-order live release `cf2c023ea6b0ab42`. Exactly six prepared assets were overlaid after verifying their live versions matched the original tested baseline. All 60 served files matched the reconciled candidate SHA-256, including AI order additions. The return-photo gate is included. No Functions or rules deployment. Validation and the release bundle are recorded at the top of HANDOFF.md.

- **Driver Cash/QR methods, 2026-11-07.** Hosting-only version `287d6ec731a455e7` from live baseline `3dc62e2f51ed3bdb`. Only admin.html and order.html changed. All 58 live files matched SHA-256, and both live delivery selects were verified to contain exactly `cash` and `bank_qr`. Payment evidence code and all other served assets are byte-identical to the previous release. Receivables methods and historical records were outside this change. No Functions or rules deployment.

- **Delivery drawer and gestures, 2026-11-07.** Hosting-only release `3dc62e2f51ed3bdb` from live baseline `9df6d12f72a114a2`. Two assets changed; all 58 live files matched SHA-256. Browser QA used real Google Maps/routes, verified actual single-touch panning and the follow control, drawer tap and upward pointer swipe, collapse, translucent red styling, completion callback and minimize/resume. Collapsed map coverage remained 87.0%, 80.6% and 80.0% across the existing portrait/narrow/landscape matrix. Expanded order details were visually inspected. No financial, Functions or rules changes.

- **Visual Delivery Mode, 2026-11-07.** Hosting-only version `9df6d12f72a114a2`, three assets changed against live baseline `3895561d7672c437`. All 58 live files matched candidate SHA-256. Browser QA used real Google Maps and a real route with synthetic order/GPS data. Verified map coverage at 390×844, 320×568 and 844×390, visible touch targets, order-details open/close, completion callback, and minimize/resume. Removed written turn directions and their unused step-processing code/tests. Seven geometry/GPS tests passed. No payment or delivery commit logic changed.

- **Live web routing pilot, 2026-11-07.** Hosting-only version `3895561d7672c437` from isolated live baseline `77141f118857f94b`; three assets changed, all 58 live paths matched SHA-256. Enabled Routes API and appended it to the Maps key API allowlist while preserving both Hosting referrer restrictions. Verified the deployed controller using the real Google map, route geometry and written directions on the production origin with synthetic coordinates. Eight route geometry/GPS tests passed. Simulated movement exercised deviation rerouting, request throttling, poor accuracy, background pause/resume, stop and late-response cleanup. Mobile form assertions covered the existing return-photo and transfer evidence gates, retained inputs and rejected-save retry using emulators and a simulated callable. No production delivery or payment was recorded. Driving mode is used. Real Android/iPhone road testing remains open. Route requests are metered by Google, with reroute requests spaced at least 15 seconds apart per active session. Existing local photo-removal/onboarding work remains excluded.

- **Map-first Delivery Mode, 2026-11-06.** Hosting-only release `77141f118857f94b` from live snapshot `2f2df66e5bcd2d1c`. Three assets changed and all 57 live paths matched the candidate SHA-256 manifest. Confirmed live-key Maps tiles on the production origin and mobile browser order flow with a stubbed map and simulated save. The live key denied Routes API calls. The embedded map shows the pin and the navigation link hands off to Google Maps. No Functions or rules deployed.

- **Delivery Mode pilot, 2026-11-06.** Hosting-only release `2f2df66e5bcd2d1c` from an isolated snapshot of live version `338d149e6663212f` with 17 changed or new files. All 57 served paths matched the candidate SHA-256 manifest. Mobile browser QA used local Auth and Firestore with a simulated callable response to exercise missing evidence, form resume, rejected save and successful retry. Payments rules tests passed 17/17. No live order or payment was used. The pilot was released from the live snapshot without a Git release tag. The local return-photo removal and staff onboarding edits were excluded.

The app is ready to ship only when every item here is checked:

- [ ] All P0 tasks below are complete or deliberately disabled behind a safe operational boundary.
- [ ] Customer can submit once, recover from failure, and see every open order plus the correct net balance.
- [ ] Approval, cancellation, delivery, payment, refund, and container-return flows cannot leave partial financial state.
- [ ] Authenticated end-to-end QA has passed on Ty's actual phone.
- [ ] The deployed Hosting tree, rules, and Functions are reproducible from a pushed Git commit and release tag.
- [x] Firestore delete protection is enabled, and the no-monthly-cost decision to forgo paid PITR/backups/restore is documented as an accepted launch risk.
- [~] Firebase access, ownership, deployment, rollback, and support instructions are documented; the future business/customer operator's identity, contact route, and exact in-app permissions remain deliberately pending before launch.
- [ ] No agent has live uncommitted application work at release time.

## P0 — required before shipping

### P0-01 — Make production reproducible

**Status:** [ ]
**Owner:** unassigned
**Files/area:** Git history, production snapshot, release documentation

Production's 42 hosted files matched the local tree during the 2026-07-20 audit, but GitHub could not reproduce that tree: `main` was four commits ahead of `origin/main`, 34 tracked files were modified, six production-essential web files were untracked, and no release tag existed.

Acceptance:

- [ ] Reconcile every live file with its owning agent; do not sweep mixed work into one commit.
- [x] Add the six live essential files to intentional commits: `adminDashboardModel.js`, `customerOrderApp.js`, `editOrderAddress.js`, `financeApp.js`, `customer-order.html`, and `finance.html`.
- [ ] Push the verified source checkpoint.
- [ ] Tag the exact release candidate.
- [ ] Prove the hosted tree matches the tagged candidate by content hash.
- [x] Write the rollback procedure and identify the previous known-good Hosting release.

Evidence/commit/deploy:

- 2026-07-20: Codex committed the six production-essential files alone as `77acc23`; all six matched production by SHA-256, four modules passed staged syntax checks, and focused checks passed 8/8 + 24/24 + 8/8. The other agent's pre-existing staged `adminApp.js` hunk remained staged and was not included. Ownership/blocker inventory: `RELEASE-RECONCILIATION.md`.
- 2026-07-20: Authenticated Hosting inventory recorded live version `ceb7745d6aa10c3d` and the immediately preceding fully verified rollback target `9d83a2219e228e81`. `HANDOVER.md` documents the Console rollback route and tagged-worktree redeploy route. A pushed release commit, Git tag, and full tagged-tree hash proof are still required.
- 2026-07-20 12:31 UTC: repository evidence refreshed at HEAD `734eceb`, 9 commits ahead of `origin/main` (`04062e5`) with no tags. The four commits after `77acc23` are documentation/protection-policy records only. The working tree still contains 34 modified tracked files, 20 untracked status entries, and Claude's sole staged `adminApp.js` hunk, so a push/tag/hash proof remains unsafe until live file owners reconcile their work. No application file, index hunk, push, tag, or deployment was touched during this check.
- 2026-07-20 12:55 UTC: read-only repository evidence refreshed at HEAD `5f10e03`, 11 commits ahead of `origin/main` (`04062e5`) with no tags. The six commits after `77acc23` touch only `HANDOVER.md`, `RELEASE-RECONCILIATION.md`, and `SHIP-READINESS.md`. The working tree still contains the same 34 modified tracked files and 20 untracked status entries. Claude's only staged path remains `firebase/web/assets/adminApp.js`, blob `a42a37e545da0d90490ab9c1b4d690671accc0a4`, with 14 additions and 1 deletion. The unstaged application diff remains 7,189 additions and 874 deletions. P0-01 read-only reconciliation was the next safe unblocked readiness action; its release commit/tag/hash acceptance remains blocked on application owners reconciling the live tree.

### P0-02 — Make public order submission idempotent

**Status:** [x] shipped 2026-07-20 (owner-auth click-through QA still pending)
**Owner:** Claude
**Likely files:** `firebase/web/assets/publicApp.js`, `firebase/functions/index.js`, focused tests

The UI prevents an immediate double-click, but every callable attempt generates a new order ID. If Firestore commits and the response is lost, Retry creates a duplicate order.

Acceptance:

- [x] Generate one stable submission key before the first attempt and reuse it across retry/reload. — minted in `publicApp.js::submitOrder`, persisted to `localStorage` under `vs-order-submission-key` **before** the callable runs, cleared only after a success the customer saw.
- [x] The server creates the order transactionally under a deterministic mapping or returns the already-created order for the same key. — `createOrderUnderSubmissionKey` writes `orderSubmissions/{authUid}__{key}` in the same transaction as the order + items.
- [x] Same user + same submission key can never create a second order.
- [x] A new deliberate order still receives a new key. — `resolveSubmissionKey` rotates when the order fingerprint changes or the key is ≥24h old.
- [x] Tests cover double-click, timeout after commit, retry after reload, and two parallel requests.

Design notes:

- The key is scoped by `authUid`, so one shared browser cannot dedup two different customers' orders.
- **No `firestore.rules` change.** `orderSubmissions` has no `match` block, so every client is denied by default; only the Admin SDK inside the callable writes it.
- A missing/invalid key falls back to the old non-idempotent batch write, so a cached pre-P0-02 client keeps ordering (with the old duplicate risk) instead of breaking.
- When the server matches a retry to an existing order it returns `duplicate: true`, and the confirmation panel says the order was *already* received rather than implying a second delivery.

Evidence/commit/deploy:

- 2026-07-20: client key logic `web/assets/orderSubmissionKey.test.mjs` **9/9** (rebuilt-cart ordering, sub-meter pin jitter, changed cart, stale key, storage garbage/clock skew); server core `functions/orderSubmission.emulator.test.js` **7/7** on the Firestore emulator (sequential retry, two parallel requests → exactly one order, per-user key scoping, new-key second order, legacy no-key fallback, key-pattern validation). Emulator stderr clean. Regression: `depositLedger.test.mjs` 25/25 and `cancellation.emulator.test.js` 23/23 still green.
- 2026-07-20: deployed `--only functions` (all 9 functions updated) then `--only hosting` (**exactly 2/42 files uploaded**: `assets/publicApp.js`, `assets/shared.js`); both re-fetched byte-identical to disk, live markers present, `orderSubmissionKey.test.mjs` 404s as intended.
- **Not yet done:** authenticated customer click-through QA (no customer session available); the live callable was deliberately not exercised because that would create real production orders.

### P0-03 — Enforce valid delivery date and service area on the server

**Status:** [x] shipped + deployed 2026-07-21 (all items decided)
**Owner:** Claude
**Likely files:** `firebase/web/index.html`, `firebase/web/assets/publicApp.js`, `firebase/functions/index.js`, tests

The form defaults to today but does not prevent past dates, and the callable validates date format only. Saved coordinates can bypass the client-side Da Nang boundary.

Acceptance:

- [x] The date input has a current minimum and refreshes correctly across midnight. (`refreshDeliveryDateFloor` sets `input.min` on load and re-floors on `visibilitychange`/`focus`/60s tick; a static HTML `min` was deliberately NOT used because it would freeze at the build-time date.)
- [x] The callable rejects past dates using `Asia/Ho_Chi_Minh`, not server UTC. (`businessTodayKey` via `Intl` in the business zone; string-compared to a zero-padded ISO date.)
- [x] The business decides and documents whether same-day orders have a cutoff. **DECIDED 2026-07-21 (Ty): no cutoff — "stamp them as they come."** `SAME_DAY_CUTOFF_HOUR = null` is the intended final state, not a placeholder. A same-day order placed at any hour is accepted for that day.
- [x] The callable enforces the same service-area boundary as the map UI. (`isInsideDeliveryArea` against `DA_NANG_DELIVERY_BOUNDS`, mirrored client↔server; a pin outside the rectangle is rejected `failed-precondition`.)
- [x] Out-of-area legacy saved pins are rejected with a useful repair message. (Message points the customer to My account → Delivery addresses to re-pin.)
- [x] Tests cover timezone boundary, stale tab, malformed date, and boundary coordinates. (`deliveryValidation.parity.test.mjs` 11/11.)

Evidence/commit/deploy:

- 2026-07-21: canonical rule lives in `web/assets/shared.js` (`DA_NANG_DELIVERY_BOUNDS`, `isInsideDeliveryArea`, `todayKeyInZone`/`BUSINESS_TIME_ZONE`, `SAME_DAY_CUTOFF_HOUR`, `deliveryDateProblem`); `functions/index.js` mirrors it (CommonJS can't import the ESM module) behind a keep-in-sync note. `deliveryValidation.parity.test.mjs` loads BOTH copies and asserts they agree on a battery of dates and edge coordinates, so a future edit to one and not the other fails in test, not production. **11/11**, including the midnight case UTC gets wrong (a Da-Nang-yesterday date placed 00:00–07:00 local is rejected by the business-zone floor, which a UTC floor would wrongly accept).
- 2026-07-21: deployed `--only functions` (all 9 updated) then `--only hosting` (**exactly 2/42 files uploaded**: `assets/publicApp.js`, `assets/shared.js`; preflight hashed all 42 web files vs prod and only these two differed). Both re-fetched byte-identical to disk live. P0-02 emulator suite re-run green (7/7) after the `index.js` edits.
- **Not yet done:** authenticated customer click-through QA (no customer session; the live callable was not exercised because that would create/reject a real production order — the anonymous probe stops at the sign-in gate, which correctly runs before the area check). The 6-way duplication of the bounds constant across Codex-owned client files is documented in ROADMAP for a later single-source cleanup, not touched here.

### P0-04 — Stop phone edits and typos from corrupting customer identity

**Status:** [x] shipped + deployed 2026-07-21
**Owner:** Claude
**Likely files:** `firebase/functions/index.js`, `firebase/web/assets/accountApp.js`, `publicApp.js`, `adminApp.js`, rules/tests as required

A signed-in order still derives `customerId` from the typed phone. Phone edits can split one customer into multiple records, while a typo matching another record can cause approval to overwrite that customer's profile fields.

Acceptance:

- [x] Signed-in orders use the authenticated customer's stable linked ID. (`submitPublicOrder` now calls `resolveSignedInCustomerId(authUid)` — the doc linked to the uid, or the uid-derived id — instead of `buildCustomerId(phone)`.)
- [x] Phone is a guarded contact attribute, not the primary identity key for an authenticated customer. (Phone is still validated and stored on the order/profile, but never determines `customerId`.)
- [x] Approval blocks and explains any phone collision with another customer/auth UID. (Both approval paths — `adminApp.js` dashboard and `orderApp.js` order-detail — warn when the typed phone already belongs to a different customer record, and stop unless the owner confirms.)
- [x] No approval path overwrites a different customer's name, address, email, or phone. (Approval writes to the order's uid-anchored `customerId`, and a belt-and-braces guard throws before overwriting any doc whose `authUid` differs from the order's. The `authUid`/`email` writes stay behind `canLinkAuthUidToCustomer`.)
- [x] Tests preserve the existing account-takeover protections and cover one-digit typo, existing-number collision, and legitimate phone change.

Evidence/commit/deploy:

- 2026-07-21: **the fix is an identity re-anchor, not a rules change** — `firestore.rules` untouched. Two phone-keying spots removed: the server callable and BOTH owner approval paths (the dashboard `adminApp.js` and the order-detail `orderApp.js` each carry their own `upsertCustomerFromOrder`). Since ordering requires sign-in (P0-01), every order has an authUid, so identity always resolves from it. `mergeCustomers` already clears `authUid` off archived sources, so `where authUid == uid` returns one live doc — mirrored server-side by `resolveSignedInCustomerId`, matching the client's existing `findByAuthUid`-first resolution.
- 2026-07-21: tests — `functions/customerIdentity.test.mjs` **17/17** (pure `pickSignedInCustomerId` + source guards on BOTH approval copies, incl. the takeover gate in the unpinned `orderApp.js` duplicate), `functions/customerIdentity.emulator.test.js` **6/6** (typo, existing-number collision leaves the stranger's record intact, legitimate phone change keeps the id, archived-doc skip). **Account-takeover suites re-run green and unchanged: `authuid-linking` 11/11, `email-propagation-takeover` 4/4, `customers.rules` 24/24, `payments.rules` 17/17.** Only the documented-benign L187/L249/L266 stderr residuals; every assertion passes. P0-02 emulator suite still 7/7.
- 2026-07-21: deployed `--only functions` (all 9 updated) then `--only hosting` (**exactly 2/42 files uploaded**: `assets/adminApp.js`, `assets/orderApp.js`; preflight confirmed only these differ from prod). Both byte-identical live.
- **Not yet done:** authenticated owner click-through of the approval collision prompt (needs an owner session). **Note on in-flight orders:** orders created before this deploy carry a phone-derived `customerId`; on approval they write to that id (unchanged behaviour). The re-anchor protects every order created after the deploy. Pending-approval orders clear within days, so the window is small.

### P0-05 — Make customer open orders, balances, credits, and returns truthful

**Status:** [x] shipped + deployed 2026-07-21
**Owner:** Claude
**Likely files:** `firebase/web/assets/accountApp.js`, `publicApp.js`, `customerOrderApp.js`, `customer-order.html`, tests

The account calculates open orders and balance from only the newest ten orders. The order-form overview checks only the newest 25. Older active debt can disappear, and negative carry-forward credit is omitted. The customer order page also reads the unused `/returns` collection, so real returns can display as missing.

Acceptance:

- [x] Open-order queries are independent of paginated history and cannot hide an older active order. (Account loads the customer's full order set via `loadAllOrdersForSummary` for the open-orders list + balance, separate from the paginated history/reorder lists; the order-form strip dropped its `limit(25)`. Both use the existing `(authUid, createdAt)` index — no new index.)
- [x] Balance summary includes both debt and customer credit and labels the net result clearly. (`summarizeAccountBalance` returns `{debt, credit, net, ...}`; the panel shows outstanding, a credit line + net when both exist, or a calm "X in credit" when only credit.)
- [x] Customer order detail derives physical return history from the actual `depositEvents` model. (`physicalReturnsFromDepositEvents`: `credited`/`refunded` = returned; `forfeited` = lost, excluded.)
- [x] No customer-facing code reads `/returns` unless a real writer is introduced and documented. (The `ownedRows("returns", …)` read is removed from `customerOrderApp.js`. Note: `orderApp.js` — the OWNER order page — still has a `/returns` read; out of this customer-facing scope, flagged in ROADMAP.)
- [x] Tests cover more than 25 orders, old open debt, mixed debt + credit, pure credit, and a credited/refunded return.

Evidence/commit/deploy:

- 2026-07-21: pure logic in `shared.js` (`summarizeAccountBalance`, `openOrdersFrom`, `physicalReturnsFromDepositEvents`), tested by `web/assets/accountTruth.test.mjs` **11/11** (the >25-orders hidden-debt case, old delivered debt, mixed debt+credit, pure credit, cancelled/pending exclusion, and credited/refunded-vs-forfeited returns). `depositLedger` 25/25 + `orderSubmissionKey` 9/9 still green (both import `shared.js`).
- 2026-07-21: browser smoke test — served locally, `account.html` and `customer-order.html` both loaded with **no console errors**, the `shared.js` exports resolved in-page and computed a mixed debt/credit balance + a filtered return set correctly.
- 2026-07-21: deployed `--only hosting` (**exactly 4/42 files uploaded**: `accountApp.js`, `publicApp.js`, `customerOrderApp.js`, `shared.js`; preflight confirmed only these differ). No functions/rules change. All 4 byte-identical live.
- **Not yet done:** authenticated customer click-through (needs a customer session; the numbers are proven pure + in-browser, but the live rendered panel wasn't eyeballed signed-in). **Scale note:** loading a customer's full order set is fine at this volume; if any single customer ever has thousands of orders, switch to indexed range queries on `balanceDue` plus a status-scoped open-orders query (noted in `loadAllOrdersForSummary`).

### P0-06 — Make approval plus deposit charging atomic and retry-safe

**Status:** [x] shipped + deployed 2026-07-21
**Owner:** Claude
**Likely files:** `firebase/web/assets/adminApp.js`, `orderApp.js`, `firebase/functions/index.js`, rules/tests

Both approval paths update the order and then create deposit charges separately. The charge duplicate check uses stale client data and fresh IDs, so failure can leave an approved order without a charge and an ambiguous retry can double-charge.

Acceptance:

- [x] One server transaction handles the status precondition, customer linkage, order approval, and deposit charges. (New callable `approveOrder` → `approveOrderImpl`, one Admin-SDK transaction. Firestore rolls the whole thing back on any failure.)
- [x] Deposit charge IDs are deterministic per order and container type. (`depositChargeId(orderId, type)` → `${orderId}-charge-${slug}`; retries address the same doc instead of appending a random one.)
- [x] Repeating the same approval returns success without changing the ledger twice. (Existing charges are skipped; an already-approved order re-runs idempotently and does not re-transition.)
- [x] Approve is guarded against double-tap and stale status. (Server status precondition: only `pending_approval` transitions; `cancelled` is rejected; a second/concurrent call is a no-op on the ledger.)
- [x] Tests cover partial failure, parallel approval, retry, no-deposit products, and mixed container types. (`approveOrder.emulator.test.js` **9/9**.)

Evidence/commit/deploy:

- 2026-07-21: approval moved from two separate client flows (`adminApp.js` + `order.html`'s `orderApp.js`, each doing update-then-charge with a stale dup-check and random ids) into `approveOrderImpl`. The client approve buttons are now thin wrappers around the callable that keep only the P0-04 phone-collision confirmation. **The account-takeover gate (`canLinkAuthUidToCustomer`) moved with the customer linkage from `adminApp.js` to `functions/index.js`.** Rules unchanged (Admin SDK writes bypass rules; the client's other owner writes — delivery-dialog deposit events, later status transitions — are untouched).
- 2026-07-21: **takeover gate re-run after the relocation and GREEN** — `authuid-linking` (now pinning the server copy) 12/12, `email-propagation-takeover` 4/4, `customers.rules` 24/24, `payments.rules` 17/17, `customerIdentity` 15/15 + emulator 6/6; only the documented-benign L187/L249 stderr. New `approveOrder.emulator.test.js` 9/9 (happy path, no-deposit, mixed types, retry idempotency, parallel → exactly one charge set, partial-failure rollback, cancelled rejected, missing order, gate refuses to stamp an unclaimed doc). P0-02/03 + cancellation suites still green (7/11/23).
- 2026-07-21: deployed `--only functions` (`approveOrder` **created**; all others updated) then `--only hosting` (**exactly 2/42 files**: `adminApp.js`, `orderApp.js`). Live probe: unauthenticated `approveOrder` → `PERMISSION_DENIED` "Owner only." Owner pages browser-smoke-tested (admin.html, order.html load clean).
- **Behaviour change worth knowing:** the old client geocoded a missing pin on approval; the server does not (no browser geocoder). Since P0-03 every public order already carries a customer-confirmed pin, so this only affects rare legacy/owner-created orders with no pin — the server backfills from the customer record's saved location if present, otherwise the owner sets the pin via Edit details. **Not yet owner-click-through QA'd** (needs an owner session to approve a real order).

### P0-07 — Route every approved cancellation and refund through one atomic case workflow

**Status:** [~] increments A + B-part-1 shipped 2026-07-21 (routing + deposit reversal + refund-evidence UI + Storage tests); remaining: refunds-due queue + scoped rule tightening (B-part-2)
**Owner:** Claude
**Likely files:** `firebase/web/assets/adminApp.js`, `orderApp.js`, `firebase/functions/index.js`, cancellation tests, refund-proof tests/UI

Visible Cancel actions still directly update order status and then reverse deposits separately. They bypass the new cancellation/refund ledger, including for paid orders. Refund evidence can be marked missing, but there is no web action to attach it and no central queue to stop unfinished refunds being forgotten.

Acceptance:

- [x] Old direct approved-order cancellation paths are removed or disabled. (The client `cancelOrder`/`approveCancellationRequest` in BOTH `adminApp.js` and `orderApp.js` now call `submitOrderCancellation`; the direct status-flip + separate `emitDepositReversalsFor` were removed. The rule-layer block of a direct client cancel is deferred to increment B — noted below.)
- [x] One callable atomically creates/resolves the cancellation case, changes the order, and creates required ledger reversals. (`applyApprovalTransaction` now emits `charge_reversed` deposit events in the SAME transaction — full: all outstanding; partial: the removed lines, capped at outstanding — deterministic id `${caseId}-chargerev-${type}`.)
- [x] Paid and partially paid orders compute refund liability from immutable payments. (`computeRefundRequired` from the summed `payments`; already built in the server slice, now reached via the routed buttons.)
- [x] The owner can attach refund evidence from the UI. (order.html refund panel: each recorded refund missing proof gets an image/PDF upload → `uploadRefundProof` (create-only `refund-proofs/`) → `attachRefundEvidence`; proof status is read from the case's `refundEvidence[]`, and the case flips to `evidenceStatus: complete` once every refund is covered.)
- [ ] A central owner queue shows `refundRemaining > 0` and missing evidence. **Increment B part 2.**
- [x] Duplicate requests/refund IDs are idempotent. (Case id `${orderId}-cx-${clientRequestId}`; refund payment id `${caseId}-refund-${refundId}`; deposit reversal id per case — all deterministic. Covered by the emulator suite.)
- [x] Focused Storage tests cover `/refund-proofs` authorization, file type, size, and immutability. (`storage.rules.test.mjs` +10 refund-proofs cases: owner image/PDF ok, non-image/PDF denied, >10MB denied, **immutable — overwrite denied**, delete denied, customer/driver/anon denied, SDK read denied.)

Evidence/commit/deploy:

- 2026-07-21 (increment A): the money-critical core — the deferred `charge_reversed` deposit reversal (CANCELLATION-REFUND-PLAN §"Not yet done") built into `applyApprovalTransaction`, plus the coordinated client change so every "containers held" net learns `charge_reversed` (`shared.js` `summarizeHeldContainers` + 8 aggregation sites in `adminApp/orderApp/customerApp/customersApp/depositsApp/financeApp`). `charge_reversed` is deliberately NOT a physical return, so `physicalReturnsFromDepositEvents` excludes it (pinned). The visible Cancel + approve-request buttons in both owner surfaces route through `submitOrderCancellation`.
- 2026-07-21: `cancellation.emulator.test.js` **29/29** (23 prior + 6 new: full reverses all outstanding / only-remaining-after-a-return / nothing-outstanding writes none / partial reverses removed line / partial capped at outstanding / net-holding-zero). `depositLedger.test.mjs` **27/27** (+2 charge_reversed), `accountTruth.test.mjs` **12/12** (+1: charge_reversed is not a return). Full takeover + approval gate re-run green (email-propagation 4, customers 24, payments 17, approveOrder 9, orderSubmission 7; only documented-benign L187/L249 stderr). Owner pages browser-smoke-tested clean.
- 2026-07-21: deployed `--only functions` then `--only hosting` (**exactly 7/42 files**). Live probe: unauthenticated `submitOrderCancellation` → `UNAUTHENTICATED`. No `firestore.rules`/`storage.rules` change in this increment.
- **Increment B (pending):** the refund-evidence **attach** UI, the **refunds-due / proof-missing** owner queue, focused **Storage tests** for `/refund-proofs`, and the **scoped rule tightening** (block a direct client cancel of an approved order while preserving the customer unpaid `pending_approval → cancelled` transition). Until the rule tightening lands, a stale cached client could still perform a direct cancel — the current client no longer does.

### P0-08 — Revalidate container holdings at commit time

**Status:** [x] DONE — increment 1 (item 3) + increment 2 (the atomic-revalidation core, items 1/2/4/5) both shipped. Delivery commit is now a server callable that re-aggregates holdings inside one transaction.
**Owner:** Claude
**Likely files:** delivery transaction code in `adminApp.js`/`orderApp.js` or server Functions; `depositsApp.js`; deposit tests

Return collectors clamp against dialog state loaded earlier, but delivery transactions do not re-read/reaggregate current holdings. Two stale dialogs can return the same container. The standalone forfeit flow also trusts stale hidden values. Pickup requests are cleared after delivery even when no empties were collected.

**Architecture note (2026-07-21):** the Firestore **client** SDK cannot run a
query inside `runTransaction`, so the delivery transaction (both surfaces) can
only `transaction.get` the order doc — it cannot re-aggregate the customer's
holdings (a query over `/depositEvents`) atomically. Items 1/2/4/5 therefore
require moving delivery-commit to an Admin-SDK server callable (same
rearchitecture as P0-06 approval and P0-07 cancellation), which CAN query and
clamp inside one transaction. That is the next increment.

Acceptance:

- [x] Delivery commit revalidates current holdings atomically before writing return events. **(increment 2)** The new `commitDelivery` callable re-aggregates the customer's `/depositEvents` holdings INSIDE the transaction (Admin SDK can query; the client SDK cannot) and clamps every return + forfeit against those fresh numbers before writing.
- [x] Two parallel deliveries cannot drive any customer/container balance below zero. **(increment 2)** The transaction reads AND writes the customer doc, so two concurrent deliveries for the same customer serialize on it — the second retries, re-aggregates, sees the first's return events, and re-clamps. Proven by `commitDelivery.emulator.test.js` (two orders each try to return all 5 held → net held ends at 0, never −5).
- [x] Delivery requires the fresh order status to be `out_for_delivery`. **(increment 1, now server-authoritative in increment 2)** The callable re-reads status in-transaction and rejects anything but `out_for_delivery`; the two client guards remain as the UX half.
- [x] Failure to load holdings blocks close or requires an explicit, audited exception. **(increment 2)** The holdings query is inside the transaction, so any failure rejects the whole commit — the order stays `out_for_delivery` and the dialog surfaces the error; nothing partial is written.
- [x] Forfeit re-reads current balance transactionally and requires a deliberate reason/account. **(increment 2)** The callable ignores the dialog's hidden qty/per-unit: it re-clamps `lossQty` against fresh held qty (rejects if it exceeds held) and recomputes `depositPerUnit` from the ledger, and requires a non-empty `lossNote` (both clients now block an empty reason too). The write-off now uses a deterministic `${orderId}-forfeit-${type}` id (was a random `buildDepositEventId()` in both files, so a retry appended a duplicate).
- [x] Pickup request clears only when fulfilled or explicitly dismissed/rescheduled. **(increment 2)** The callable clears `emptiesPickupRequested` ONLY when a physical return (credit/refund) was actually recorded this delivery; a pure "owner will decide later" leaves it set to nag next time. Explicit dismissal remains the customer's own toggle on `account.html`. Previously both surfaces cleared it unconditionally after any delivery.
- [x] “Owner will decide later” cannot look like a recorded physical return when no ledger event is written. **(increment 2)** "keep" returns are dropped client-side and never reach the callable, so no `depositEvents` row is written for them and holdings are untouched.

Evidence/commit/deploy:

- **Increment 1 (item 3):** fresh-status guard tightened in both delivery transactions; `node --check` clean, `depositLedger` 27 + `accountTruth` 12 green, deployed `--only hosting` (2 files). Committed `dd5f396`.
- **Increment 2 (items 1/2/4/5 + forfeit + keep):** delivery commit moved to the Admin-SDK `commitDelivery` callable (`functions/index.js`) — one transaction that asserts fresh `out_for_delivery`, re-aggregates holdings, clamps returns + forfeit, writes payment + deposit events + order money (same deterministic ids; new `${orderId}-forfeit-${type}`), and clears the pickup flag only when fulfilled. Money math mirrors `orderApp.js::saveDeliveryPayment` and the `adminApp.js` delivery tx exactly (both rewired to call it; the client `runTransaction` blocks removed). New `commitDelivery.emulator.test.js` **8/8** (happy path, status guard, over-return clamp, PARALLEL cannot-go-negative, forfeit-needs-reason, forfeit re-read/deterministic id, fulfilled-only pickup, missing order). `depositLedger` 27 + `accountTruth` 12 still green. **`firestore.rules` deliberately unchanged** — the owner/driver delivery-transition branch is now defence-in-depth (delivery writes go through the Admin SDK, which bypasses rules); tightening it risks the other legitimate owner client writes (manual deposit adjustments, record-payment) and the append-only payments invariant, so it was left as-is with the full rules gate untouched. Deployed `--only functions:commitDelivery` (created in us-central1) + `--only hosting` (2 files, clean tree — no collateral). **NOT owner-click-through QA'd — no session, the standing gap.**

### P0-09 — Guard payment entry and keep Receivables honest

**Status:** [x] DONE — record-payment moved to a server callable (`recordPayment`); `commitDelivery` gained the same amount gates; Receivables is delivered-only.
**Owner:** Claude
**Likely files:** `firebase/web/assets/adminApp.js`, `orderApp.js`, `receivablesApp.js`, `shared.js`, `receivables.html`, `functions/index.js`, tests

Payment dialogs reject negative amounts but accept zero and arbitrarily large values. A stale dialog or extra zero can create a material overpayment. Receivables currently includes `new`, `assigned`, and `out_for_delivery` orders in a view labelled Delivered and can prompt customers before delivery.

Acceptance:

- [x] Collected payment must be a positive whole-VND amount when a balance remains. (`collectedPaymentProblem` in `shared.js`, mirrored in `functions/index.js` — negative, fractional, and zero-while-due all rejected on every payment surface; `paymentEntry.parity.test.mjs` pins the mirror. `commitDelivery` no longer silently `Math.round`s.)
- [x] Zero is routed to an explicit deferred/uncollected path with follow-up state. (Receivables dialog gained the delivery dialog's "Money received / Not collected — set follow-up" split; the deferred branch writes an amount-0 `deferred:true` payment with reason + follow-up date and stamps `followUpBy` on the order. A follow-up date is required server-side.)
- [x] Fresh order status and balance are re-read inside the transaction. (Both `recordPaymentImpl` and `commitDeliveryImpl` compute the due amount from the in-transaction order doc; the dialogs' numbers are never trusted.)
- [x] Overpayment requires an explicit confirmation that states the resulting customer credit. (Client confirms the credit and passes `acknowledgeCredit`/`acknowledgeCashCredit`; the server recomputes the credit from the FRESH balance and rejects a mismatch with the real figure in `HttpsError.details` — a stale dialog re-confirms against the truth and retries under the same paymentId.)
- [x] Cancelled orders reject payment. (`recordPayment`: explicit "cancelled" failed-precondition; delivery already rejects anything not `out_for_delivery`.)
- [x] Receivables separates delivered overdue debt from optional prepayment, or shows delivered orders only. (Delivered-only chosen: the "Delivered" column and the WhatsApp chase are now truthful; `recordPayment` rejects undelivered orders server-side to match, and a page note explains where undelivered money is collected.)
- [x] Tests cover stale dialog, zero, extra zero, exact payment, intentional credit, cancelled order, and undelivered order. (`recordPayment.emulator.test.js` 12/12 — includes the stale-dialog acknowledge-reject-reconfirm cycle, idempotent retry, and all four undelivered statuses; `commitDelivery.emulator.test.js` 8→12 with the delivery-side P0-09 cases.)

Evidence/commit/deploy:

- 2026-07-21: `recordPayment` Admin-SDK callable created (P0-06/07/08 pattern; the receivables dialog was the last client-side `/payments` writer). Idempotent per paymentId. No `firestore.rules` change — the append-only `/payments` owner-create branch stays as defence-in-depth, same posture as P0-08.
- 2026-07-21: suites — recordPayment 12/12, commitDelivery 12/12, paymentEntry parity 6/6; regressions depositLedger 27 / accountTruth 12 / deliveryValidation 11 / cancellation 29 / approveOrder 9 / orderSubmission 7; full takeover gate green (12/4/24/17/13/9, documented-benign stderr only, rules untouched). Receivables page smoke-tested in a real browser (module graph, radio toggle both ways, helper import, delivered-only note).
- 2026-07-21: deployed `--only functions:recordPayment,functions:commitDelivery` (create + update, us-central1; anonymous probe → PERMISSION_DENIED "Owner only.") + `--only hosting` (exactly 5/42 files: `receivables.html`, `receivablesApp.js`, `adminApp.js`, `orderApp.js`, `shared.js`; post-release full-tree audit 42/42 byte-identical).
- 2026-07-21 (later): **owner click-through QA DONE, both tracks — the standing gap is closed for P0-09.** (1) EMULATOR: full local stack (auth+firestore+functions+hosting), fake owner + seeded fixtures, all nine flows clicked through the real pages green (delivered-only list, zero/fractional/negative messages, extra-zero confirm deny+accept, exact payment, deferred, cancelled-behind-dialog rejection, stale-overpay fresh-figure re-confirm cycle, delivery dialog incl. a note-proof return — that last also exercises P0-08's client→commitDelivery wiring for the first time). (2) PRODUCTION, Ty's own owner session in the CC browser pane (Ty signed in himself; writes explicitly authorized — pre-handover reset planned): real Receivables shows 0 outstanding (all live unpaid orders are undelivered — the exact pre-P0-09 mislabel, now correctly excluded); rejection paths on the live dialogs write nothing; full lifecycle on a marked fixture (`ZZ QA TEST DELETE`) — create → assign → send out → deliver DEFERRED (commitDelivery) → partial 40k → intentional-credit 70k/60k with the stated 10,000 VND confirm (recordPayment) — and `reports.html` shows **zero real-time corrections** (every payment write left its order balanced). QA fixture manifest in HANDOFF housekeeping. Remaining P0-11 matrix items (customer flows, mobile) still open.

### P0-10 — Add a true final review and preserve the cart through sign-in

**Status:** [x] DONE — final-review dialog before submit; the order draft survives the email sign-in navigation; wording + mobile acceptance all met.
**Owner:** Claude
**Likely files:** `firebase/web/index.html`, `publicApp.js`, `account.html`, `accountApp.js`, `styles.css`, tests

One tap submits immediately. The visible totals do not give a final review of address, phone, delivery time, notes, and pickup intent. Google popup sign-in keeps the in-memory cart, but email sign-in navigates away and loses it despite the promise “Your cart is kept.”

Acceptance:

- [x] Final confirmation shows items, quantities, subtotal, deposit, total, phone, address, date/window, notes, and pickup request. (New `#order-review-dialog`: submitting the form opens it instead of sending; each section has an Edit control.)
- [x] It reads the existing computed state; it does not duplicate deposit calculations. (`renderOrderReviewBody` calls the same `selectedLines()` + `computeOrderTotals()` the sticky totals use — no second deposit math.)
- [x] Customer can return to edit any section without losing data. (Per-section "Edit" closes the dialog and scrolls/focuses that field; "Go back & edit" too. The form is never cleared — verified cart + fields intact after edit.)
- [x] Full draft survives email-link sign-in and returns to the order form. (`buildOrderDraft`/`parseStoredOrderDraft` in shared.js persist cart + fields + pin to `localStorage` before the email-sign-in navigation; account.html's `tryCompleteEmailLinkSignIn` bounces a fresh-draft visitor back to `index.html`, which restores on load after auth+catalog resolve. Google stays a popup and never needed this.)
- [x] “Due now” is renamed to match the actual collection moment. (→ "Pay on delivery", in the sticky totals and the review.)
- [x] Pickup-credit wording clearly says the driver counts empties and the estimate is non-binding. (Order-form estimate, review dialog, and confirmation line all now say the driver counts what comes back and the figure is an estimate, not a promise.)

Mobile acceptance at 375 px (all browser-verified in the emulator pane):

- [x] Action labels fit without clipping or text overlap. (Found + fixed: the 3-column totals summary overlapped inside the narrower review dialog — now stacked label-left/value-right there; the sticky panel is untouched.)
- [x] Empty sticky totals consume materially less than the audited 224/812 px viewport height. (Empty-state now hides the zero-value summary + review handles → **154px**, down from 224.)
- [x] Product add/remove and review controls provide approximately 44 × 44 px touch targets. (Compact qty buttons keep their 32px look but get a 44px effective hit area via a transparent `::after`; measured 44×56.)
- [x] Add/remove buttons include the product name in their accessible label and quantity changes are announced. (`aria-label="Add/Remove one <product>"`; a visually-hidden `#cart-live-status` role=status announces "<product>: N in cart".)
- [x] No horizontal overflow with a five-item cart. (Verified `scrollWidth <= 375` on the form and the review dialog with all five seeded products; the review body scrolls internally.)

Evidence/commit/deploy:

- 2026-07-21/22: no functions/rules change — hosting only. New pure suite `web/assets/orderDraft.test.mjs` **10/10** (empty-form → no draft, quantity/field cleaning, invalid-pin drop, JSON round-trip, garbage/foreign-version → null, 24h expiry, future-skew rejection, re-normalization so corrupt storage can't inject shapes). Regressions green: orderSubmissionKey 9, depositLedger 27, accountTruth 12, paymentEntry parity 6, deliveryValidation parity 11. All touched modules `node --check` clean; index.html 77 unique ids.
- 2026-07-21/22: **customer click-through QA DONE (emulator, fake Google + email paths).** Built a 375px cart, submit opened the review (correct items/deposit/total from the shared compute path), per-section Edit returned with the cart intact, Place order placed the order and locked the button. Draft round trip: signed-out cart + fields → email-link save → reload → **fully restored** (counters 2/1, total 409k, all fields, "Welcome back", draft consumed). En route, fixed a latent display bug — `renderCatalog` hardcoded the per-product counter to 0, so a restored/reordered cart showed 0 on the steppers while the total was right; now reflects `state.quantities` (also fixes reorder). Screenshots captured of the restored form and the review dialog.
- 2026-07-22: deployed `--only hosting` (exactly **5/42** files: `index.html`, `publicApp.js`, `accountApp.js`, `shared.js`, `styles.css`; post-release full-tree audit **42/42 byte-identical**). Added a `?v=p0-10-20260722` cache-bust to the `publicApp.js` module import (the codebase already versions `orderApp.js` this way) so customers get the new JS immediately. Tree was clean apart from my files; no other agent WIP carried.

### P0-11 — Complete authenticated end-to-end release QA

**Status:** [~] Emulator matrix DONE (authenticated owner + customer, both auth methods) — found + fixed a real P0 (customer reorder was fully broken). Residual items need Ty's real phone / real WhatsApp-email receipt / a production customer sign-in.
**Owner:** Claude
**Files/area:** production-equivalent release candidate, Ty's phone, emulator fixtures

Static and source-level tests are green, but the highest-risk flows have not been exercised end-to-end with owner/customer authentication.

Required matrix (emulator = production-equivalent stack: fake Google + real email-link via the Auth emulator oobCode, owner + customer):

- [x] New customer: Google sign-in, email-link sign-in, order, confirmation, account visibility. (Emulator: fresh Google customer ordered `WEB-…171903-3017`, saw confirmation + "View your orders", the order showed on account.html as "Waiting for confirmation", no console errors; a separate email-link customer signed in via the emulator oobCode, URL cleaned.)
- [x] Repeat order and retired-product reorder warning. **Found a P0 bug: reorder was completely broken** (orderItems list query wasn't authUid-constrained → rules denied it for every customer). Fixed client-side + added the missing retired-product warning. See the ROADMAP "customer reorder was completely broken" note. Both the `?reorder=` link and the Reorder dialog now rebuild the cart; a retired line surfaces "no longer available … add a replacement."
- [x] Deliberate double-tap and network timeout after server commit. (Two concurrent `submitPublicOrder` with the same submissionKey → both resolved to ONE orderId, one `duplicate:false`, one `duplicate:true`; exactly one order created. This is the P0-02 protection — a lost-response retry is the same path.)
- [x] Approval retry and stale approval tab. (First `approveOrder` + two concurrent retries → exactly one deterministic deposit charge `…-charge-20l_jug` 60000; order → `new`; retries no-op.)
- [~] Delivery: exact cash, deferred, deposit credit, cash refund, over-credit, no-return pickup, note proof, photo proof, upload failure. (Parallel + note-proof + deferred + over-credit exercised here and in prior P0-08/P0-09 QA; the full variant set incl. photo proof + upload failure is pinned by `commitDelivery.emulator.test.js` 12/12. **Photo-proof upload with a real image + a forced upload failure still want a real-device pass.**)
- [x] Two stale delivery tabs attempting the same container return. (Two OFD orders for one customer holding 3 jugs, both returning 3 concurrently → only 3 credited total, net held **0**, never negative. P0-08 core, E2E.)
- [~] Paid, partially paid, and unpaid cancellation; partial and final refund; proof attachment. (PAID full cancel → case `refundRequired` 100000; partial refund 50000 → remaining 50000/"partial"; final 50000 → remaining 0/"paid"; idempotent retry → "already_recorded"; order cancelled, payments net 0. Partial + unpaid variants pinned by `cancellation.emulator.test.js` 29/29. **Proof attachment via a real Storage upload still wants a live pass — storage.rules 31/31 covers auth/immutability.**)
- [x] Receivables payment from a stale dialog and intentional overpayment. (Done in P0-09 QA — emulator AND production with Ty's session: stale-dialog fresh-figure re-confirm cycle, acknowledged-credit overpay.)
- [~] Invoice received through WhatsApp and email after close flows. (Link SHAPE builds correctly and the PDF upload path is exercised, but **actual receipt on a real phone/inbox needs Ty** — no receipt is testable in the emulator.)
- [x] Reconciliation event appears after an intentional console payment and the nightly job remains healthy. (Admin-SDK "console" payment written without the atomic order update → `reconcileOnPaymentWrite` corrected the order amountPaid 0→100000 / balanceDue→0 in seconds and logged one `reconciliationEvents` doc with before/after. Nightly health production-verified 2026-07-20.)
- [~] Offline/network errors preserve entered data and offer a clear retry. (A callable error leaves the form populated and shows the message rather than resetting; the P0-10 draft + P0-02 submission key harden the reload case. **A true offline/flaky-connection pass wants a real device.**)
- [~] Chrome/Android phone QA at 360–390 px and one desktop pass. (Desktop 1280px pass done this session; 375px done extensively in P0-10. **A real Android phone at 360–390px is the remaining piece for Ty.**)

Evidence:

- 2026-07-21/22: emulator matrix run authenticated (owner `owner@qa.test`; customers via fake-Google `p11repeat@example.test` / `p11new-google@…` and email-link `p11new-email@…`). Fixtures: `CUS-p11repeat` + past order `P11-PAST-0001` (with a retired line), `P11-PENDING-0001` (approval), `P11-OFD-0001/0002` (parallel delivery), `P11-PAID-0001` (cancellation), `P11-RECON-0001` (reconciliation), product `P11-RETIRED` (active:false). All emulator-only — nothing written to production this session.
- 2026-07-22: **P0 fix shipped** — customer reorder (broken for all customers) + retired-product warning; `--only hosting` (2/42, 42/42 byte-identical); `orderitems.rules.test.mjs` 7/7 added; no rules/functions change. Committed with the P0-11 evidence.
- **Remaining for Ty (real device / real delivery / production customer):** a real Android phone pass at 360–390px; a real WhatsApp + email invoice RECEIPT; a photo-proof upload + forced upload-failure; a refund proof-attachment via a real Storage object; a true offline/flaky-network pass; and a production run with a genuine customer Google/email sign-in (the flows are identical to the emulator, which uses fake credentials).
- 2026-07-20 monitoring-only check: Cloud Scheduler was ENABLED for 03:00 `Asia/Ho_Chi_Minh`. Direct Cloud Run logs confirmed successful nightly completions on July 16–20 local, all with zero failures and zero drift; the latest scanned 9 orders and skipped 1. This verifies scheduler health only, not the remaining authenticated QA matrix or intentional-payment event check.
- 2026-07-20 monitoring-only check: Cloud Scheduler was ENABLED for 03:00 `Asia/Ho_Chi_Minh`. Direct Cloud Run logs confirmed successful nightly completions on July 16–20 local, all with zero failures and zero drift; the latest scanned 9 orders and skipped 1. This verifies scheduler health only, not the remaining authenticated QA matrix or intentional-payment event check.

### P0-12 — Establish backup, restore, access, and handover safety

**Status:** [!] technical/recovery controls documented; future business-operator binding is deferred and the no-backup-administrator risk is accepted
**Owner:** Codex — current documentation complete; launch-time operator binding pending
**Files/area:** Firebase/Google Cloud settings and `HANDOVER.md`

The repository's sheet export is dated 2026-07-05 and is not a production database backup. Production Firestore now has free delete protection enabled. By Ty's explicit no-monthly-cost decision, paid PITR, scheduled backups, backup storage, managed restore, and a restore drill are deliberately deferred. This prevents accidental deletion of the whole database but accepts that older document deletion/corruption may be unrecoverable. Ty remains the sole Firebase project owner, Cloud Billing administrator, deployment operator, and technical incident owner, and explicitly chose not to add a backup administrator or independent recovery contact. Ty's buddy will be the future business/customer operator and will launch the app for his customers; the buddy's identity, contact route, and exact in-app permissions are deliberately pending. This is not a transfer of Firebase ownership, and no Firebase/Google Cloud access has been added or implied.

Acceptance:

- [!] Project/billing/deployment/technical owner confirmed; Ty explicitly chose no backup administrator or independent recovery contact. This accepted technical-access risk is separate from the buddy's future business/customer role.
- [x] Verify and record Firestore PITR/delete-protection/backup state.
- [x] Enable and independently verify free delete protection while leaving PITR disabled.
- [x] Record paid backup/restore and restore-drill work as deliberately deferred under the no-monthly-cost launch policy.
- [x] Document Firebase CLI login, project selection, deploy scopes, rollback, custom-claim setup, Maps key, App Check key, and domain configuration.
- [x] Document monitoring locations for Functions, Eventarc, Firestore, Storage, reconciliation, and billing/quota alerts.
- [x] Confirm no service-account credential or private secret is tracked.
- [x] Document the launch responsibility boundary and escalation structure: buddy on business/customer operations; Ty on Firebase, billing, deployment, rollback, and technical incidents.
- [!] Bind the future business/customer operator's identity, contact route, and exact in-app permissions before customer launch. These details are intentionally deferred now; do not invent them or infer Firebase access.

Evidence/commit:

- 2026-07-20: `HANDOVER.md` created with scoped release/rollback, claims, backup/restore-drill, monitoring, Maps/App Check/domain, and escalation procedures. Tracked-tree and Git-history credential scans found no private-key/service-account signature.
- 2026-07-20 after reauthentication: project and billing IAM confirmed `tymailgarcia@gmail.com` as the sole project owner and sole billing administrator. The initial Firestore read found `(default)` Standard/Native in `asia-east2` with PITR disabled, delete protection disabled, one-hour version retention, no backup schedule, and no backups. No settings were changed during that inventory checkpoint; the later no-cost decision below supersedes its open protection decision.
- 2026-07-20 no-cost decision: official Firebase documentation confirms PITR data, backup data, and restore operations have no free usage, while delete protection is a database safety setting. Codex enabled only delete protection and independently re-read the database: `DELETE_PROTECTION_ENABLED`, `POINT_IN_TIME_RECOVERY_DISABLED`, Standard/Native, `freeTier: true`, one-hour retention. No backup schedule or backup was created. At this checkpoint, P0-12 still awaited the access/contact decision recorded below.
- 2026-07-20 12:31 UTC: Ty was asked to name the backup Firebase project/billing administrator email, an independent recovery email/contact route, and the technical-incident and customer-communication contacts. No IAM or billing binding was changed pending that decision.
- 2026-07-20 12:44 UTC, clarified at 12:55 UTC: Ty's sole-operator decision applies to Firebase ownership, billing, deployment, technical response, and the absence of a backup technical administrator. It does not mean Ty will permanently run the business/customer side. `HANDOVER.md` now records Ty's buddy as the future business/customer operator, with identity, contact route, and exact app permissions pending. No Firebase ownership transfer or IAM/billing change occurred.
- 2026-07-20 after the 12:55 UTC refresh: P0-12's remaining Maps API-key restriction and App Check registration/metrics inventory was identified as a safe read-only follow-up. Local tooling cannot query it (`gcloud` is absent and Firebase CLI 15.22.4 exposes no applicable command), and the in-app Google Cloud console required sign-in. The check remains pending; no restriction, registration, access, or billing setting changed.
- 2026-07-22 (Ty at the console; Claude guided/verified, changed no settings): operator identity bound — the future business/customer operator is **Matthias Campbell** (recorded in `HANDOVER.md`); his contact route and exact in-app permissions are still pending from Ty, so acceptance item stays partial. App Check web-app registration completed by Ty with the deployed reCAPTCHA Enterprise site key; `enforceAppCheck` deliberately still OFF in `functions/index.js` pending a verified-traffic metrics soak. Maps browser key (`AIzaSyBFC6…`) referrer + API restriction SAVED and verified live 2026-07-22 (Ty set it; Claude verified from the production `web.app` origin — Maps JS render, Geocoding, and Places New all returned OK with no referer/`gm_authFailure`): application restriction = Websites (`web.app/*` + `firebaseapp.com/*`); allow-list scoped to Maps JavaScript API + Geocoding API + Places API (New) [+ classic Places as a safety net], with Google Cloud Storage JSON API deliberately excluded (the Maps key never calls Storage); the Node backfill script uses a separate `GOOGLE_GEOCODING_API_KEY`, so the referrer restriction does not affect it.

## P1 — finish before broad customer use

These do not replace the P0 gate. Promote one to P0 if it blocks the real launch audience or operating process.

- [ ] **Off-app owner alerts:** new order, overdue approval, failed/stale reconciliation, pending refund, and missing proof must reach the owner when the dashboard is closed.
- [ ] **Invoice close-out step:** after either delivery dialog saves, keep the completed order available and present one clear Send invoice action using the uploaded PDF URL.
- [ ] **Payment/refund evidence:** require a bank/QR reference or proof according to payment method and require payout evidence for refunds.
- [ ] **Photo source choice:** provide explicit Take photo and Choose from library actions for every proof/image attachment.
- [ ] **Approved-order customer help:** show the policy and one-tap contact options when self-cancellation is no longer allowed.
- [ ] **Reorder integrity:** warn which retired/unavailable products were omitted and which prices/deposits changed.
- [ ] **Error recovery:** translate common Auth/Firestore/Storage/network errors into plain language, preserve work, and provide Retry.
- [ ] **Audit completeness:** persist `deliveredAt`, closing actor, receivables contact attempts, and next follow-up date.
- [ ] **Deposit ageing:** reset age after a balance is fully settled and later charged again.
- [ ] **Accessibility/autofill:** add appropriate autocomplete attributes, live status regions, product-specific control names, focus return, and keyboard/dialog checks.
- [ ] **Privacy and account exit:** publish a privacy notice and provide an anonymization/deletion-request route that explains retained financial records.
- [ ] **Legal/accounting sign-off:** confirm business type, tax/e-invoice obligations, retention, privacy handling, and invoice provider against current Vietnamese requirements.
- [ ] **Security headers:** add safe baseline headers (`nosniff`, frame restrictions, referrer and permissions policy); stage CSP separately after testing inline/external dependencies.
- [ ] **App Check:** repair/verify Enterprise registration, observe valid metrics, then decide enforcement. Never enforce before verified traffic passes.
- [ ] **Driver-role boundary:** keep driver rollout disabled until rules restrict drivers to assigned operational data rather than all customers/order items.

## Explicitly safe to defer until after launch

- Analytics/reporting expansion beyond reconciliation and launch-critical queues.
- Standalone purchases, supplier directory, and deeper inventory automation.
- Loyalty, referrals, subscriptions, weather hints, and demand forecasting.
- Full customer-site visual redesign and nonessential dashboard polish.
- Sticky-toast positioning experiment, except where it blocks a critical control.
- Scale optimization for full-collection pages until real volume justifies it. This does **not** include P0-05's correctness fix for hidden open orders.
- Multi-language, unless the actual launch customers cannot safely understand the English ordering and deposit terms.

## Verification baseline from the 2026-07-20 audit

- Production Hosting: 42/42 hosted files matched the inspected local tree.
- JavaScript syntax: 47 first-party modules passed `node --check`.
- Focused/source tests: 122 assertions passed across address, dashboard, cancellation policy/math, invoice duplicate-share, map planning, deposit ledger, and return-proof wiring.
- Current gaps: no CI, no single `test` command, no fresh complete authenticated browser pass, and no focused `/refund-proofs` Storage test.
- Mobile observation at 375 × 812: empty sticky totals occupied 224 px (28% of viewport), quantity buttons were 32 px wide, and “Sign in to order” overflowed its 105 px button.
- Operations: in-app alerts exist, but no verified off-app notification, current backup/restore test, or complete handover runbook exists.

## Work log

Add one row when work starts and update the same row when it stops. Detailed file ownership still belongs in `.agent-status.md`.

| UTC | Task | Agent | Status | Files claimed | Evidence / next step |
|---|---|---|---|---|---|
| 2026-07-20 11:08 | Board creation | Codex | complete | `SHIP-READINESS.md` | Created from parallel customer/admin/technical audit; no app files changed. |
| 2026-07-20 11:17 | P0-12 + P0-01 safe slice | Codex | blocked after repository work | `HANDOVER.md`, `RELEASE-RECONCILIATION.md`, `SHIP-READINESS.md`; six standalone web files | Six production-identical essentials committed as `77acc23`; handover/runbook committed as `62ebf43`. Next: Ty reauthenticates Firebase, confirms owners/backup policy, and approves a restore drill; other agents reconcile mixed live files. |
| 2026-07-20 12:10 | P0-12 authenticated inventory | Codex | blocked on decisions | `HANDOVER.md`, `SHIP-READINESS.md`; read-only Firebase/Google Cloud state | Reauthentication verified. Sole project owner and billing admin identified; no backup admin. Firestore has no PITR, delete protection, schedule, or backups. Hosting rollback IDs and healthy nightly scheduler/function evidence recorded. No external settings changed. |
| 2026-07-20 12:21 | P0-12 no-cost protection | Codex | database decision complete; access still blocked | `HANDOVER.md`, `SHIP-READINESS.md`; Firestore `(default)` setting | Ty chose no monthly recovery cost. Enabled and verified free delete protection only; PITR remains disabled and no schedule/backup/restore resource was created. Accepted recovery limit documented. |
| 2026-07-20 12:31 | P0-01/P0-12 safe continuation | Codex | blocked on shared-file reconciliation and Ty's contact decision | `HANDOVER.md`, `RELEASE-RECONCILIATION.md`, `SHIP-READINESS.md`; read-only Git evidence | Refreshed HEAD/ahead/dirty/staged/tag evidence without touching application work; requested the backup-admin, recovery, incident, and customer-contact details required to close P0-12. |
| 2026-07-20 12:44 | P0-12 sole-technical-operator decision | Codex | documentation corrected at 12:55; risk accepted | `HANDOVER.md`, `SHIP-READINESS.md` | Confirmed Ty is the sole Firebase/billing/deployment/technical operator and has no backup administrator or separate recovery contact. The later clarification assigns future business/customer operations to Ty's buddy. No external access changes made. |
| 2026-07-20 12:55 | P0-01/P0-12 responsibility correction | Codex | documentation complete; release tree and future operator binding remain pending | `HANDOVER.md`, `RELEASE-RECONCILIATION.md`, `SHIP-READINESS.md`; read-only Git/config evidence | Corrected the operational model: the buddy will run business/customer operations while Ty retains Firebase/billing/deployment/technical control. Refreshed HEAD/ahead/dirty/staged-blob evidence without touching application work. A read-only Maps/App Check console inventory was safe but could not proceed past console sign-in; no external state changed. |

## Decision log

Record business decisions that change acceptance criteria.

| UTC | Decision | Made by | Consequence |
|---|---|---|---|
| 2026-07-20 | Pre-ship work prioritizes ease of use and prevention of human/financial error; analytics and expansion features wait. | Ty | P0/P1 ordering in this document. |
| 2026-07-20 | Launch without monthly recovery cost: enable free database delete protection, but skip paid PITR, scheduled backups, backup storage, managed restore, and restore drill. | Ty | Whole-database deletion is guarded; document-level corruption/deletion older than the one-hour version window may be unrecoverable. Revisit when this accepted loss window is no longer tolerable. |
| 2026-07-20 | Ty retains sole Firebase ownership, billing administration, deployment, rollback, and technical control; no backup/recovery account is added. Ty's buddy will be the future business/customer operator and launch the app for his customers. The buddy's identity, contact route, and exact in-app permissions are deferred; this is not a Firebase ownership transfer. | Ty | Loss of Ty's primary Google account could block technical administration, billing response, deployment, and recovery. Business/customer operations are assigned by role to the future operator, but that person and app access still must be bound before launch. No Firebase access is implied. |

## Release sign-off

Complete only after the Ship gate is green.

- Release commit: _pending_
- Release tag: _pending_
- Hosting release/version: _pending_
- Rules release/version: _pending_
- Functions revision(s): _pending_
- Storage rules release/version: _pending_
- Production hash comparison: _pending_
- Database recovery decision/evidence: delete protection enabled; paid PITR/backups/restore deliberately deferred by Ty on 2026-07-20.
- Customer QA sign-off: _pending_
- Admin QA sign-off: _pending_
- Known accepted risks: _pending_
- Final approver/date: _pending_

# Handoff — as of 2026-07-21

## Read this first: current state (2026-07-21)

The tree-reconciliation the July-20 briefing below asked for is **DONE**: commit
`088d653` synced HEAD to production (all 42 hosted files byte-verified, full
rules gate green) and was pushed. Then a run of SHIP-READINESS P0 blockers
shipped. **All of the following are deployed, live, and verified — but committed
locally only. `main` is 15 commits ahead of `origin/main` (after the P0-09 and
P0-10 commits); nothing is pushed and there is no release tag.** Push/tag only
when Ty asks.

Commits since the sync (newest first), each deployed + gated:
- `6e05d82` P0-07 inc. B part 2 — **P0-07 COMPLETE (7/7).** Refunds-due/proof-missing owner queue on `reports.html`/`reportsApp.js` (read-only over `orderCancellations`: `refundStatus` pending/partial OR `evidenceStatus` missing) + scoped `firestore.rules` tightening (new `isCancelTransition()`; owner orders-update branch now denies any direct client cancel — owner cancels go through `submitOrderCancellation`; customer unpaid `pending_approval→cancelled` self-cancel untouched). Full rules gate green before+after; `customer-order-cancel` 6→9. Deployed `--only firestore:rules` + `--only hosting` (2 files).
- `1fe4ff0` P0-07 inc. B part 1 — refund-evidence attach UI + `/refund-proofs` Storage tests.
- `6ed3726` P0-07 inc. A — cancellation routes through the atomic case workflow; **new `charge_reversed` deposit event type** (reverses the deposit charge inside the cancellation transaction; 8 client "containers held" nets + `summarizeHeldContainers` learned it; `physicalReturnsFromDepositEvents` deliberately excludes it).
- `bb799e1` P0-06 — order approval is one server transaction (`approveOrder` callable / `approveOrderImpl`); **the account-takeover gate `canLinkAuthUidToCustomer` MOVED from `adminApp.js` to `functions/index.js`** — `rules-tests/authuid-linking.test.mjs` now pins the server copy. CLAUDE.md's hard-constraint pointer was updated to match.
- `6c89b03` P0-05 — truthful customer open orders/balance/credit/returns.
- `473c8ea` P0-03 + P0-04 — server-enforced delivery date/area; uid-anchored customer identity.
- `8da405e` P0-02 — idempotent public order submission (committed by Ty).

**P0-07 is COMPLETE (7 of 7 acceptance items), shipped as `6e05d82`.** Both
increment-B-part-2 items landed: the refunds-due/proof-missing owner queue (a
read-only "Refunds due & missing proof" panel on `reports.html`/`reportsApp.js`
over `orderCancellations` where `refundStatus` in `['pending','partial']` OR
`evidenceStatus == 'missing'`) and the scoped `firestore.rules` tightening (new
`isCancelTransition()`; the owner orders-update branch now denies any direct
client cancel, so owner cancels must go through the `submitOrderCancellation`
Admin-SDK callable, while the customer unpaid `pending_approval → cancelled`
self-cancel branch is untouched). Full `rules-tests/` gate re-run green before
and after (authuid-linking 12, email-takeover 4, customers 24, payments 17,
ordercancellations 13); `customer-order-cancel` extended 6→9. Only the
pre-existing documented-benign driver/customer bare-field stderr (L-shifted by
the added helper). Not owner-click-through QA'd — no session, the standing gap.

**P0-08 is COMPLETE (all acceptance items).** Increment 1 (`dd5f396`, item 3)
tightened the fresh-status guard in both client delivery transactions.
Increment 2 shipped the concurrency CORE (items 1/2/4/5 + forfeit + "keep"):
delivery commit moved to a new Admin-SDK callable **`commitDelivery`** in
`functions/index.js`. In ONE transaction it asserts fresh `out_for_delivery`,
**re-aggregates the customer's `/depositEvents` holdings** (the client SDK can't
query inside `runTransaction` — the whole reason for the callable), clamps every
return + forfeit against those fresh numbers, and writes the payment + deposit
events + order money with the same deterministic ids (new
`${orderId}-forfeit-${type}` replaces a random id that let retries duplicate a
write-off). Parallel safety: the transaction reads AND writes the customer doc,
so two concurrent deliveries for one customer serialize — the second retries,
re-aggregates, and re-clamps, so a balance can never go negative (pinned by
`commitDelivery.emulator.test.js`, 8/8). Forfeit re-reads the balance and now
requires a reason. Pickup flag clears ONLY when a physical return was recorded;
"owner will decide later" writes no ledger event. Both client surfaces
(`orderApp.js`, `adminApp.js`) had their `runTransaction` blocks removed and now
call `commitDeliveryFn`; the money math mirrors the old client math line-for-line
so nothing drifted. **`firestore.rules` deliberately unchanged** — the
owner/driver delivery branch is now defence-in-depth (Admin SDK bypasses rules);
tightening it risks other legitimate client owner writes, so the rules gate was
not touched. Deployed `--only functions:commitDelivery` (created, us-central1) +
`--only hosting` (2/42 files, clean tree). NOT owner-click-through QA'd — the
standing gap. See SHIP-READINESS P0-08 + ROADMAP "Shipped 2026-07-21 (P0-08
increment 2 …)".

**P0-09 is COMPLETE (all acceptance items).** Payment entry is guarded and
Receivables is honest: a new Admin-SDK callable **`recordPayment`** replaced the
receivables dialog's client transaction (the LAST client-side `/payments`
writer) — one transaction re-reads fresh status AND balance, rejects cancelled
and undelivered orders, requires a positive whole-VND amount, and is idempotent
per paymentId. Zero routes to an explicit deferred path (new "Money received /
Not collected — set follow-up" split in the receivables dialog; amount-0
`deferred:true` payment + `followUpBy` on the order). Overpayment goes through
only when the client acknowledges the EXACT resulting credit, which the server
recomputes from the fresh balance — a stale dialog is rejected with the real
figure in error details and re-confirms. `commitDelivery` gained the same
gates (zero-while-due rejected, fractional rejected, cash-overpay
acknowledgement; prepaid-zero still delivers). Shared rule
`collectedPaymentProblem` lives in `shared.js`, mirrored in `functions/index.js`,
pinned by `paymentEntry.parity.test.mjs`. **Receivables now lists DELIVERED
orders only** — it used to label new/assigned/out_for_delivery as "Delivered"
and offer WhatsApp-chase on undelivered water. No `firestore.rules` change
(same defence-in-depth posture as P0-08). Suites: `recordPayment.emulator`
12/12, `commitDelivery.emulator` 8→12, parity 6/6, all regressions + the full
takeover gate green (12/4/24/17/13/9, benign stderr only). Deployed
`--only functions:recordPayment,functions:commitDelivery` + `--only hosting`
(exactly 5/42 files, post-release 42/42 byte-identical). **Owner click-through
QA'd the same day — emulator AND production (Ty's session) — see the QA
manifest below. First P0 with the click-through gap closed; P0-11's
customer-side + mobile matrix stays open.**

**P0-10 is COMPLETE (all acceptance items + the 375px mobile list).** Submitting
the public order form now opens a **final review dialog** (items/qty/subtotal/
deposit/total/phone/address/date/notes/pickup, each with an Edit that returns
without losing data) instead of sending immediately; only "Place order" calls
the server. The review reads the same `selectedLines()`+`computeOrderTotals()`
as the totals panel (no duplicate deposit math). The **order draft now survives
the email sign-in navigation** — cart + fields + pin are saved to `localStorage`
(`vs-order-draft`) before the nav, account.html bounces a fresh-draft visitor
back to index.html, and it restores on load (pure logic in shared.js
`buildOrderDraft`/`parseStoredOrderDraft`, 24h expiry + re-normalization,
`orderDraft.test.mjs` 10/10). "Due now" → **"Pay on delivery"**; pickup wording
now says the driver counts and the estimate is non-binding. Mobile: empty sticky
totals 224→**154px**, ~44px tap targets on the compact steppers, product-named
`aria-label`s + a live region, and the review-dialog totals summary was
**overlapping** at 375px (fixed: stacked there only). Latent fix: `renderCatalog`
hardcoded the stepper counter to 0, so a restored/reordered cart showed 0 while
the total was right — now reflects `state.quantities`. Hosting only (5/42 files,
42/42 byte-identical), no functions/rules change. Customer click-through QA'd in
the emulator (fake Google + email draft round trip); NOT yet on production with a
real customer sign-in — that's P0-11.

Next in SHIP-READINESS.md: **P0-11** (authenticated end-to-end release QA
matrix). Trust SHIP-READINESS.md for per-P0 status/evidence and ROADMAP.md
"Shipped 2026-07-2x" for the how/why.

**P0-09 owner click-through QA was DONE on 2026-07-21 (emulator + production
with Ty's own session in the CC browser pane — Ty signed in himself and
explicitly authorized fixture writes because a full data reset is planned
before handover). All flows green; `reports.html` shows zero real-time
corrections. QA FIXTURE MANIFEST — production docs created, delete at the
pre-handover reset (or earlier with the Admin SDK; client rules block hard
deletes of payments/customers):**
- `customers/CUS-84900000099` — "ZZ QA TEST DELETE", phone +84900000099, notes
  say it is a QA fixture.
- `orders/ORD-20260721110826-5845` — delivered; total 100,000; paid 110,000;
  balance −10,000 (deliberate acknowledged credit). Plus its `orderItems` (1 ×
  P-UNI-20L-JUG) and any `depositEvents` keyed to that orderId.
- 3 `payments` docs for that orderId: the amount-0 deferred at delivery, 40,000
  ("QA partial"), 70,000 ("QA intentional credit").
- Until deleted these show in Finance (110,000 cash on 2026-07-21), the
  customers list, and orders history. Everything is findable by that orderId +
  customerId.

Housekeeping: `firebase/scratch-authusers.json` is an empty stray (emulator
export) — delete or ignore, do not commit. The `.manual-deploy-*` dirs and the
PNG-cutline personal tools stay out of git as always. Also NOT committed, by
design: `.claude/launch.json` (local static-serve config for browser QA).
**Ty's owner password was pasted into a Claude chat on 2026-07-21 — he was
advised to rotate it before handover.**

Verification bar used all session: pure/emulator tests green + the account-takeover
gate (authuid-linking / email-propagation-takeover / customers / payments) re-run
green with only the documented-benign L187/L249 stderr, before every money/rules/
identity deploy. Nothing was browser-QA'd with a real owner/customer login (no
session available) — that's the standing open item on every P0 above.

---

## Claude: read this July 20 ship-readiness briefing first

**(Superseded on status by the 2026-07-21 section above — the reconciliation it
asks for is done and the P0s it lists as pending have shipped. Its operational
decisions below still stand: Firebase ownership, no-paid-recovery, App Check
pending on Ty, Maps-key restriction pending.)**

The app is **NO-GO for public launch or handover**. The authoritative current documents are [SHIP-READINESS.md](SHIP-READINESS.md), [HANDOVER.md](HANDOVER.md), and [RELEASE-RECONCILIATION.md](RELEASE-RECONCILIATION.md). The documentation checkpoint immediately before this handoff was commit `1e232cc` (`Clarify future business operator handover`). It changed only those three documents. Nothing was deployed, pushed, or tagged.

### Shared-tree state that must be preserved

- `main` was 12 commits ahead of `origin/main` immediately before this handoff update. There is still no release tag.
- The working tree still has 34 tracked modified files and 20 untracked status entries. Most application changes are deployed-but-uncommitted, mixed-author work recorded on `.agent-status.md`.
- `firebase/web/assets/adminApp.js` is the only staged path. Its staged blob is exactly `a42a37e545da0d90490ab9c1b4d690671accc0a4`, with 14 additions and 1 deletion. It is Claude's pre-existing hunk. Do not unstage, overwrite, or include it in an unrelated commit.
- `ROADMAP.md` is dirty and mixed. Do not sweep it into an application or documentation commit.
- Manual deployment snapshots (`.manual-deploy-*-20260720/`) are scratch, not source history. `PNG Cutline Tool/`, `rembg-to-cutline-svg.bat`, and its shortcut are unrelated personal tools. Never sweep them into Vietnam Sparkle commits.
- Do not run Hosting deployment while any agent has an active `firebase/web/` claim. Do not push or tag until the live application tree is reconciled and verified from a clean checkout.

### Operational decisions—do not reinterpret them

- Ty retains Firebase ownership, Cloud Billing administration, deployment, rollback, and technical incident control after launch. He is the sole Firebase project owner and billing administrator and deliberately chose no backup technical administrator/recovery account.
- Ty's buddy will be the future business/customer operator and will launch the app for his customers. The buddy's name, contact route, and exact in-app permissions are deliberately pending and do not need to be requested yet.
- This is **not** a Firebase ownership transfer. Do not add Firebase/Google Cloud access or invent contact information.
- Firestore delete protection is enabled. PITR is disabled. There are no scheduled backups or existing backups. Ty deliberately deferred paid PITR, backup storage, managed restore, and restore drills under the no-monthly-cost launch policy. Do not enable a paid Firebase feature without new explicit approval.
- The nightly reconciliation scheduler/function is healthy. Current and previous known-good Hosting version IDs and rollback instructions are in `HANDOVER.md`.
- Maps-key restriction and App Check registration/metrics remain read-only inventory items. Local tooling cannot query them (`gcloud` is absent; Firebase CLI has no applicable command), and the in-app Cloud Console required sign-in. Do not enable App Check enforcement before verified production traffic passes.

### What Claude should do next

1. Re-read `.agent-status.md` and close the current deployed-but-uncommitted ownership backlog as focused commits, starting with the staged `adminApp.js` hunk. Use hunk staging for every mixed file and commit only owned work.
2. Preserve all Codex-origin untracked tests for their matching implementation slice. Do not make a miscellaneous test dump. `RELEASE-RECONCILIATION.md` lists which tests are Codex-origin versus Claude-origin.
3. After application owners reconcile the tree, run the syntax/focused/rules gates and authenticated customer/owner QA from a clean checkout. Then compare the complete Hosting tree to production by SHA-256.
4. Only after the clean candidate matches production: push the complete checkpoint, create the annotated release-candidate tag, and record the release evidence. Do not push or tag the current mixed tree.
5. The first new engineering P0 after reconciliation is P0-02, idempotent public-order submission. It touches `publicApp.js` and `functions/index.js`, which are currently Claude-claimed; finish their existing ownership split before starting it.

P0-12 is accurately reassessed as: technical/recovery controls documented, no-backup-administrator risk accepted, and future business-operator binding pending before launch. P0-01 read-only evidence is current through `1e232cc`, but reproducibility remains blocked on application-file reconciliation.

## Earlier development handoff and durable gotchas

The previous version of this file briefed the 2026-07-15 identity/security session. That work shipped and is documented under "Customer identity, merge, and auth" and "Security hardening" in [ROADMAP.md](ROADMAP.md). Nothing from it carries forward except the gotchas below.

## Read these first, in this order

1. **[ROADMAP.md](ROADMAP.md) → "Audit follow-ups → Critical"** — the account-takeover write-up. Still the most important thing in the repo. It explains why `upsertCustomerFromOrder` looks the way it does, and why the obvious "improvement" to it is a security regression. The customer missing-field fix is now deployed, with the no-widening rationale recorded there; read it before touching that rule.
2. **[ROADMAP.md](ROADMAP.md) → "Firebase Storage, invoice delivery, and payment proof"** — everything shipped 2026-07-16, including the one paragraph you must read before changing any Storage read rule.

## What happened on 2026-07-16

- **Firebase Storage exists now.** It never did before. Bucket `vietnamsparkle-36dfe.firebasestorage.app`, **asia-east2** (matched to Firestore), created via the API — the `storageBucket` line already in `firebaseWebConfig.js` was a placeholder that 404'd.
- **Invoice delivery** — the PDF uploads on share-click and the WhatsApp/email body carries a link. Retires the "owner downloads it and attaches it by hand" workaround.
- **Payment-proof photos** — capture control in the delivery + record-payment dialogs; `proofDocumentId` is no longer hardcoded `null`; thumbnail on the today board.
- **Order document reader shipped** — `/order.html` shows uploaded invoices/order confirmations and payment proofs, links proofs from their payment rows, and includes uploads in the audit timeline. It resolves both document-ledger references and legacy direct proof/Drive links; no rules changed.
- **Third test suite**: `rules-tests/storage.rules.test.mjs`, 15 cases.
- **Customer missing-field rule fix shipped** — missing `authUid` remains unclaimable, explicit `authUid: null` remains the deliberate email-claim state, and all Firestore gates passed 48/48 before the rules-only deployment. Written up in ROADMAP → Audit follow-ups → Critical.
- **Reconciliation viewer shipped** — `/reports.html` + `assets/reportsApp.js`, deployed. Owner-only, read-only, no rules change. The nightly job's drift is finally visible outside the Firestore console. See ROADMAP → "Shipped 2026-07-16 (reconciliation viewer)".
- **Reconciliation alert shipped (in-app half)** — the owner dashboard now toasts on load when the newest run drifted, failed, or is >30h old. Persistent (no auto-dismiss), dismiss-once-per-run via localStorage, stale re-nags daily. The **push half (email/WhatsApp with the browser closed) is blocked on Ty**: no mail/SMS provider exists anywhere in `functions/`, so it needs a provider choice + credentials first.

## Gotchas that will cost you an hour each

- **Java is installed but not on `PATH`** (`C:\Program Files\Eclipse Adoptium\jre-21.0.11.10-hotspot`). `which java` says it's missing; it isn't. The emulators need it.
- **Use pnpm, not npm**, in `firebase/`. npm fails with `Cannot read properties of null (reading 'matches')` against the pnpm-managed tree.
- **When running rules tests, read the emulator's stderr, not just the pass count.** Three of the four latent rules bugs this codebase has found were reported as evaluation errors while every assertion still passed. The 2026-07-16 finding came out of exactly this.
- **Bare field access in rules raises an error, it does not return null.** `resource.data.email` on a doc without that key denies the write. Use `.get(key, default)` without turning a missing key into an explicitly claimable state. This has now bitten this codebase five times; the known customer and order-correction instances are fixed, but the regression rationale remains in ROADMAP.
- **`getDownloadURL()` URLs bypass storage.rules.** The token in the URL is the access control. Tightening a rule does nothing to a link already sent. This is deliberate — it's what makes invoice links work for customers with no account.
- **`audit/` was a frozen stale copy of the app that misled a security review into reporting fixed issues. Deleted 2026-07-16 (commit `e6436ac`) — do not restore it to the working tree.** If a review ever cites files under `audit/`, it read stale history, not the live app. Live code is `firebase/`.
- **`.git` was an empty directory before 2026-07-15** — the project is in OneDrive, which contends over git internals. If history vanishes again, that's the first suspect.
- Emulator note: `emulators:exec --only storage` worked fine on 2026-07-16. The older "port 8080 already taken" advice only bites when a Firestore emulator is already running — check `netstat` before assuming.

## Uncommitted work — state as of 2026-07-16 ~13:0x UTC

The great entanglement is mostly resolved. Committed and pushed today: Claude's Storage work (`6a1ee6d`), the `audit/` deletion (`e6436ac`), and Codex's share (`150ecbe` account-phone E.164, `4e3daed` order reader + inventory foundation, `231ed95` receivables). Note `231ed95` committed `receivablesApp.js` whole, so it carries Claude's payment-proof hunks too — deliberate, the file is no longer split.

Still uncommitted, by owner:
- **Claude**: `web/reports.html` + `reportsApp.js` and `web/duplicates.html` + `duplicatesApp.js` (untracked, clean standalone commits), `rules-tests/ordercorrections.rules.test.mjs` (untracked, standalone), the App Check bootstrap in `firebaseClient.js`/`firebaseWebConfig.js`, the E.164 hunks in `publicApp.js`/`customerApp.js`/`customersApp.js`/`index.html`, the `styles.css` EOF blocks (`.order-alerts`, recon, `.dup-*`), one nav/toolbar link line in each owner `.html`, the recon-alert + Storage hunks in `adminApp.js`, and the phone gate in `functions/index.js`. All deployed.
- **Codex**: the email-confirmation + address-edit work in `account.html`/`accountApp.js` (deployed 2026-07-16 ~13:0x by Claude — see deploy log).
- **Nobody's committed**: `firestore.rules` — **deployed ruleset == disk** (verified via no-op release), but the inventory blocks, inquiries closure, and bare-field fixes exist only on this OneDrive disk plus in production. Highest-value thing left to commit. Also `rules-tests/customers.rules.test.mjs` (modified, Codex's) and the doc files.

## Console steps not done yet

- ~~**Enable "Email link (passwordless sign-in)"**~~ **Done — Ty enabled it 2026-07-16, verified by probing `accounts:sendOobCode` (`EMAIL_SIGNIN`) against production: it issues a code instead of throwing `auth/operation-not-allowed`.** Customer email sign-in is live end-to-end (provider + the in-page confirmation flow + deployed JS).
- **Restrict the Maps API key** to HTTP referrers of the hosting domain. It is public by design (ships in the bundle); the referrer restriction is the only thing protecting it.
- Storage needs no console step — the bucket and rules are deployed and verified.

## Sensible next milestones

**Everything below that said "implemented and verified locally, but not deployed" turned out to already be live — verified 2026-07-16 ~10:5x UTC** (Claude): every file under `web/` was fetched from the live site and byte-compared to disk (identical), and a `firebase deploy --only firestore:rules` reported "latest version already up to date" — the deployed ruleset was already byte-identical to the local file, inventory rules and the `inquiries` closure included. The full gate was re-run first and passed clean: 24+16+16+8 Firestore + 8 authuid-linking + 15 storage = **87/87**, with the only stderr evaluation error being the documented L193 authUid null-vs-string residual. The items formerly listed here — owner-side delivery addresses, quick-call, finance range summary, cancellation-request alerts, live delivery map, inventory phase 1, the inquiries closure — are all **in production**. Whoever deploys next should not treat them as pending.

Unblocked:
- **App Check on `submitPublicOrder` — key is LIVE, one console step + a metrics soak remain.** Ty's reCAPTCHA Enterprise site key is deployed in `firebaseWebConfig.js` and the Enterprise script verifiably loads on the live site. Token exchange currently 403s because the **Firebase-console App Check registration is still pending on Ty** (App Check → Apps → web app → reCAPTCHA Enterprise → paste the same site key). After that: a day or two of metrics showing verified traffic, THEN `enforceAppCheck: true` on the callable. **Do not enforce early — it breaks public ordering.** Full plan: ROADMAP → "App Check on submitPublicOrder".
- ~~**Delete `audit/`**~~ Done 2026-07-16, commit `e6436ac`.

Blocked on Ty, and have been since 2026-07-08:
- **Business type** (`hộ kinh doanh` vs `doanh nghiệp`) — gates the entire tax/e-invoice section. Note the 2026-07-16 work delivers *PDFs*, not tax documents; that section is untouched.
- **Real bank details** — gates the VietQR generator. (The invoice PDF already renders a VietQR from `settings/business.bank` the moment real values land.)

## Conventions worth keeping

- Deploy after edits: `cd firebase && firebase deploy` (scope with `--only hosting` / `--only functions` / `--only firestore:rules` / `--only storage`).
- When something ships, add a `Shipped 2026-MM-DD:` bullet under the relevant ROADMAP section. When something is *removed for a reason*, say why and say "do not restore" — the takeover survived a week because the roadmap described it as a fix.
- When you find a latent bug outside your task, write it up where the next person will hit it rather than fixing it in passing — especially in `firestore.rules`, where a "small cleanup" changes who can claim an account.

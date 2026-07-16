# Handoff — as of 2026-07-16

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

- **Enable "Email link (passwordless sign-in)"** on the Email/Password provider. Until then `sendSignInLinkToEmail` throws `auth/operation-not-allowed` and customers cannot sign in by email. **Still outstanding since 2026-07-15 — this blocks customer sign-in entirely.**
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

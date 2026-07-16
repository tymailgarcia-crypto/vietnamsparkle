# Handoff — as of 2026-07-16

The previous version of this file briefed the 2026-07-15 identity/security session. That work shipped and is documented under "Customer identity, merge, and auth" and "Security hardening" in [ROADMAP.md](ROADMAP.md). Nothing from it carries forward except the gotchas below.

## Read these first, in this order

1. **[ROADMAP.md](ROADMAP.md) → "Audit follow-ups → Critical"** — the account-takeover write-up. Still the most important thing in the repo. It explains why `upsertCustomerFromOrder` looks the way it does, and why the obvious "improvement" to it is a security regression. It now also carries a **new, unfixed finding** (bare field access in the customers update rule) — read it before touching that rule.
2. **[ROADMAP.md](ROADMAP.md) → "Firebase Storage, invoice delivery, and payment proof"** — everything shipped 2026-07-16, including the one paragraph you must read before changing any Storage read rule.

## What happened on 2026-07-16

- **Firebase Storage exists now.** It never did before. Bucket `vietnamsparkle-36dfe.firebasestorage.app`, **asia-east2** (matched to Firestore), created via the API — the `storageBucket` line already in `firebaseWebConfig.js` was a placeholder that 404'd.
- **Invoice delivery** — the PDF uploads on share-click and the WhatsApp/email body carries a link. Retires the "owner downloads it and attaches it by hand" workaround.
- **Payment-proof photos** — capture control in the delivery + record-payment dialogs; `proofDocumentId` is no longer hardcoded `null`; thumbnail on the today board.
- **Third test suite**: `rules-tests/storage.rules.test.mjs`, 15 cases.
- **Found but not fixed**: two bare-field-access evaluation errors in the customers update rule. Written up in ROADMAP → Audit follow-ups → Critical.

## Gotchas that will cost you an hour each

- **Java is installed but not on `PATH`** (`C:\Program Files\Eclipse Adoptium\jre-21.0.11.10-hotspot`). `which java` says it's missing; it isn't. The emulators need it.
- **Use pnpm, not npm**, in `firebase/`. npm fails with `Cannot read properties of null (reading 'matches')` against the pnpm-managed tree.
- **When running rules tests, read the emulator's stderr, not just the pass count.** Three of the four latent rules bugs this codebase has found were reported as evaluation errors while every assertion still passed. The 2026-07-16 finding came out of exactly this.
- **Bare field access in rules raises an error, it does not return null.** `resource.data.email` on a doc without that key denies the write. Use `.get(key, default)`. This has now bitten this codebase four times, and there are two live instances of it — see ROADMAP.
- **`getDownloadURL()` URLs bypass storage.rules.** The token in the URL is the access control. Tightening a rule does nothing to a link already sent. This is deliberate — it's what makes invoice links work for customers with no account.
- **`audit/` is a frozen stale copy of the app**, not the live one. It already misled one security review into reporting fixed issues. Live code is `firebase/`.
- **`.git` was an empty directory before 2026-07-15** — the project is in OneDrive, which contends over git internals. If history vanishes again, that's the first suspect.
- Emulator note: `emulators:exec --only storage` worked fine on 2026-07-16. The older "port 8080 already taken" advice only bites when a Firestore emulator is already running — check `netstat` before assuming.

## Uncommitted work is entangled — read before committing

Codex has WIP in this tree (`web/order.html` + `web/assets/orderApp.js`, customer insights, card views, an `orderCorrections` rule). **`order.html` is already deployed and live**, and Codex's edits to `adminApp.js`/`ordersApp.js`/`mapApp.js`/`customerApp.js`/`receivablesApp.js` link to it.

The 2026-07-16 Storage work touches **the same files** — `adminApp.js` and `receivablesApp.js` carry both Codex's changes and mine. There is no clean "commit only my files" split for those two. Nothing was committed on 2026-07-16 for that reason. Whoever commits next has to either coordinate with Codex or commit the tree as a whole and say so.

New files from 2026-07-16 that are unambiguously safe to commit on their own: `storage.rules`, `web/assets/storageUploads.js`, `rules-tests/storage.rules.test.mjs`.

## Console steps not done yet

- **Enable "Email link (passwordless sign-in)"** on the Email/Password provider. Until then `sendSignInLinkToEmail` throws `auth/operation-not-allowed` and customers cannot sign in by email. **Still outstanding since 2026-07-15 — this blocks customer sign-in entirely.**
- **Restrict the Maps API key** to HTTP referrers of the hosting domain. It is public by design (ships in the bundle); the referrer restriction is the only thing protecting it.
- Storage needs no console step — the bucket and rules are deployed and verified.

## Sensible next milestones

Unblocked:
- **Reconciliation report viewer** — owner-only page over `reconciliationReports/{runId}` + its `drifts` subcollection. Accumulating nightly since 2026-07-14 with no way to see it outside the Firestore console. Probably the highest-value unblocked item now.
- **App Check on `inquiries`** — the one open security item with a real abuse path (unauthenticated public writes → billing).
- **The customers-rule bare field access** — see ROADMAP → Critical. Small diff, needs real thought about the claim surface.
- **Delete `audit/`** — recoverable from git; keeps producing phantom findings while it exists.
- **Address editing on `/account.html`** — the trap logged 2026-07-15 is still there: Area impersonates an address field and saved addresses can't be edited.
- **Inventory phase 1** — nothing started; see ROADMAP.

Blocked on Ty, and have been since 2026-07-08:
- **Business type** (`hộ kinh doanh` vs `doanh nghiệp`) — gates the entire tax/e-invoice section. Note the 2026-07-16 work delivers *PDFs*, not tax documents; that section is untouched.
- **Real bank details** — gates the VietQR generator. (The invoice PDF already renders a VietQR from `settings/business.bank` the moment real values land.)

## Conventions worth keeping

- Deploy after edits: `cd firebase && firebase deploy` (scope with `--only hosting` / `--only functions` / `--only firestore:rules` / `--only storage`).
- When something ships, add a `Shipped 2026-MM-DD:` bullet under the relevant ROADMAP section. When something is *removed for a reason*, say why and say "do not restore" — the takeover survived a week because the roadmap described it as a fix.
- When you find a latent bug outside your task, write it up where the next person will hit it rather than fixing it in passing — especially in `firestore.rules`, where a "small cleanup" changes who can claim an account.

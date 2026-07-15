# Handoff — as of 2026-07-15

The previous version of this file briefed a route-planning session. That work shipped on 2026-07-13 and is documented under "Delivery map" in [ROADMAP.md](ROADMAP.md). Nothing from it carries forward.

## Read these first, in this order

1. **[ROADMAP.md](ROADMAP.md) → "Audit follow-ups → Critical"** — the account-takeover write-up. It explains why `upsertCustomerFromOrder` looks the way it does, and why the obvious "improvement" to it is a security regression.
2. **[ROADMAP.md](ROADMAP.md) → "Customer identity, merge, and auth"** and **"Security hardening"** — everything shipped 2026-07-15.

## What happened on 2026-07-15

- Owner-side **customer merge tool** (`mergeCustomers` callable + UI on `/customer.html`), plus `foldSelfServeStubInto`, which folds the `CUS-<uid>` stub into the canonical phone doc automatically on the first approved order.
- **Passwordless email-link sign-in** replaced email + password on `/account.html`. The owner still uses password sign-in on `/admin.html`, so the provider stays enabled.
- **Security**: verified email now required to claim a profile; customer doc ids pinned to `CUS-<uid>`; approval-time `authUid` stamping onto pre-existing unclaimed docs removed; WhatsApp webhook deleted from production (its secrets resolved to `""`, making the signature forgeable).
- **First tests** in the codebase, under `firebase/rules-tests/`.
- **First git commit**, pushed to a private GitHub repo.

## Gotchas that will cost you an hour each

- **Java is installed but not on `PATH`** (`C:\Program Files\Eclipse Adoptium\jre-21.0.11.10-hotspot`). `which java` says it's missing; it isn't. The Firestore emulator needs it.
- **A Firestore emulator may already be running on 8080.** `firebase emulators:exec` fails with "port taken" — run the test file directly against the live emulator instead.
- **Use pnpm, not npm**, in `firebase/`. npm fails with `Cannot read properties of null (reading 'matches')` against the pnpm-managed tree.
- **When running rules tests, read the emulator's stderr, not just the pass count.** Both latent rules bugs found on 2026-07-15 were reported as evaluation errors while every assertion still passed.
- **Bare field access in rules raises an error, it does not return null.** `request.resource.data.email` on a doc without that key denies the write. Use `.get(key, default)`. This has bitten this codebase three times now.
- **`audit/` is a frozen stale copy of the app**, not the live one. It already misled one security review into reporting fixed issues. Live code is `firebase/`.
- **`.git` was an empty directory before 2026-07-15** — the project is in OneDrive, which contends over git internals. If history vanishes again, that's the first suspect.

## Console steps not done yet

- **Enable "Email link (passwordless sign-in)"** on the Email/Password provider. Until then `sendSignInLinkToEmail` throws `auth/operation-not-allowed` and customers cannot sign in by email.
- **Restrict the Maps API key** to HTTP referrers of the hosting domain. It is public by design (ships in the bundle); the referrer restriction is the only thing protecting it.

## Sensible next milestones

Unblocked:
- **Invoice delivery + payment-proof photos** — do these as one piece of work. Both need Firebase Storage, which this project does not use anywhere yet, so whoever does the first one pays the setup cost (bucket, rules, upload helper) and the second becomes cheap. Both are on Ty's list; see "From Ty's notes" in ROADMAP.
- **Reconciliation report viewer** — owner-only page over `reconciliationReports/{runId}` + its `drifts` subcollection. The data has been accumulating nightly since 2026-07-14 with no way to see it outside the Firestore console.
- **App Check on `inquiries`** — the one open security item with a real abuse path (unauthenticated public writes → billing).
- **Delete `audit/`** — recoverable from git; keeps producing phantom findings while it exists.
- **Inventory phase 1** — nothing started; see ROADMAP.

Blocked on Ty, and have been since 2026-07-08:
- **Business type** (`hộ kinh doanh` vs `doanh nghiệp`) — gates the entire tax/e-invoice section.
- **Real bank details** — gates the VietQR generator.

## Conventions worth keeping

- Deploy after edits: `cd firebase && firebase deploy` (scope with `--only hosting` / `--only functions` / `--only firestore:rules`).
- When something ships, add a `Shipped 2026-MM-DD:` bullet under the relevant ROADMAP section. When something is *removed for a reason*, say why and say "do not restore" — the takeover survived a week because the roadmap described it as a fix.

# Release reconciliation — 2026-07-20

**Status:** in progress; production is not reproducible from Git yet
**Prepared by:** Codex
**Last checked:** 2026-07-20 12:31 UTC

This inventory supports `SHIP-READINESS.md` P0-01. It records what can be committed safely without sweeping another agent's work.

## Repository checkpoint

- Branch: `main`
- HEAD: `734eceb` (`Adopt no-cost Firestore protection policy`)
- Remote checkpoint: `origin/main` at `04062e5`
- Local branch: 9 commits ahead of `origin/main`
- Tags: none
- Tracked working-tree changes: 34 files
- Untracked top-level/status entries: 20
- Pre-existing staged paths: one — `firebase/web/assets/adminApp.js`
- Current unstaged application diff: 7,189 insertions and 874 deletions across 34 files

Do not push or tag this as a release candidate yet. The commit graph contains valuable deployed work, but the remaining live Hosting tree still depends on uncommitted mixed files.

## Completed clean slice

Commit `77acc23` intentionally added the six live, production-essential files named by P0-01. No mixed tracked file was included. The pre-existing staged `adminApp.js` hunk remained staged after the commit.

| Hosted file | SHA-256 | Production match at 2026-07-20 11:2x UTC |
|---|---|---|
| `assets/adminDashboardModel.js` | `8B86C621F76A4A5E0F47511D630DC04097B96DD64744B4A62547BE0357F00A1B` | yes |
| `assets/customerOrderApp.js` | `017BECE9F1C014F232144543A7FC111C3F8C4FB667B3E90C4A24473B3688F345` | yes |
| `assets/editOrderAddress.js` | `143ED7628279E2F5487F2531283B80F08D436370BEBBEAF82D4923883EF1EDD2` | yes |
| `assets/financeApp.js` | `4F02290FC597E7CE31D247A969E9067A9266DE4DF496926D3B4C5B6436030F5E` | yes |
| `customer-order.html` | `9AF6312AE82110DD83F3BB619693E98E7C48A26C1A9A9A78FBBB76704E643557` | yes |
| `finance.html` | `4F5D292E458EDCE7D4C9EAD7AAF7FC9729099BD2CD7B42218C3356D6F0A2D10C` | yes |

Verification before commit:

- Four JavaScript modules passed `node --check` from both the working tree and staged index.
- `adminDashboardModel.test.mjs`: 8/8.
- `editOrderAddress.test.mjs`: 24/24.
- `customerCancellationPolicy.test.mjs`: 8/8.
- All six local files returned HTTP 200 and matched production byte-for-byte by SHA-256.

## Ownership and blocking groups

### Mixed or actively Claude-claimed — do not stage whole

These areas have live Claude claims and/or known multi-author hunks:

- `firebase/web/admin.html`, `assets/adminApp.js`
- `firebase/web/order.html`, `assets/orderApp.js`
- `firebase/web/index.html`, `assets/publicApp.js`
- `firebase/web/account.html`, `assets/accountApp.js`
- `firebase/web/deposits.html`, `assets/depositsApp.js`
- `assets/shared.js`, `assets/styles.css`, `assets/invoice.js`, `assets/storageUploads.js`
- `firebase/functions/index.js`, `firebase/firestore.rules`, `firebase/firebase.json`

`assets/adminApp.js` is especially sensitive: its index contains a 15-line staged delta that predates this reconciliation, while the working tree contains additional unstaged edits (`MM`). Its owner must identify and commit/remove that staged hunk before anyone changes the index broadly.

### Claude-claimed deployed work awaiting owner commit

The live board records deployed-but-uncommitted work in address lookup, sign-in/App Check scaffolding, duplicates, deposit ledger, return proof, delivery COD, invoice itemization, inventory/Product Builder, cancellation panels, and related shared CSS/navigation. Claude must hunk-stage those changes or explicitly release ownership. Codex must not turn them into a bulk commit.

### Codex-origin tests/docs not yet safe to sweep

The following untracked files appear to be Codex-origin evidence, but most inspect mixed implementation files. Commit each with the implementation slice it verifies, not as a miscellaneous test dump:

- `DESIGN-AUDIT.md`
- `SHIP-READINESS.md`
- `firebase/rules-tests/customer-order-cancel.rules.test.mjs`
- `firebase/src/accountAddressEditor.test.mjs`
- `firebase/src/adminDashboardModel.test.mjs`
- `firebase/src/customerCancellationPolicy.test.mjs`
- `firebase/src/editOrderAddress.test.mjs`
- `firebase/src/invoiceDuplicateShare.test.mjs`
- `firebase/src/mapTripPlanner.test.mjs`

### Claude-origin tests

- `firebase/web/assets/depositLedger.test.mjs`
- `firebase/web/assets/returnProofGate.test.mjs`

Leave these for Claude's matching implementation commits.

### Release scratch and unrelated personal tools — never sweep

- `.manual-deploy-*-20260720/` directories are isolated deployment scratch/snapshots. They are not durable release artifacts and must not be treated as source history.
- `PNG Cutline Tool/`, `rembg-to-cutline-svg.bat`, and its shortcut are unrelated personal utilities. Exclude them from Vietnam Sparkle commits.

## Ahead commits awaiting a deliberate push

| Commit | Purpose |
|---|---|
| `8ffb749` | Public-order full-width mobile delivery fields |
| `1d688ef` | Reconciliation trigger, append-only payments, reconciliation page |
| `5e10f6d` | Cancellation/refund server slice |
| `39c33db` | Legacy cancellation backfill |
| `77acc23` | Six production-essential owner/customer pages and controllers |
| `62ebf43` | Ship gate, release reconciliation, and operational handover documentation |
| `c649e1e` | Initial Firebase handover blocker evidence |
| `3d1b101` | Authenticated Firebase project, access, Hosting, and scheduler inventory |
| `734eceb` | Approved no-cost Firestore protection policy and delete-protection evidence |

These commits are locally preserved but not a complete production checkpoint. Push only after the remaining live file owners reconcile their hunks, the full clean checkout passes the ship tests, and the Hosting tree matches production.

The 2026-07-20 12:31 UTC refresh confirmed that the four commits after `77acc23` touch only `HANDOVER.md`, `RELEASE-RECONCILIATION.md`, and `SHIP-READINESS.md`. They improve release and access documentation but do not resolve the mixed live Hosting tree. The working tree still has 34 tracked modified files, 20 untracked status entries, and exactly one staged path: Claude's pre-existing `firebase/web/assets/adminApp.js` hunk. No tag exists.

## Required next sequence

1. The owner of the staged `adminApp.js` hunk identifies and commits or unstages only their own lines.
2. Claude closes deployed work as focused commits, using hunk staging for every shared file.
3. Codex pairs each remaining Codex-origin test with its implementation commit; do not commit a test that fails against the resulting clean checkout.
4. Re-run `git status`; unrelated personal tools and manual deployment scratch must remain untracked/ignored or be moved outside the repository with Ty's approval.
5. From a clean checkout, run JavaScript syntax, focused tests, the full Firestore/Storage emulator gate, and authenticated browser QA.
6. Fetch all production Hosting files and compare SHA-256 against the clean release tree.
7. Push the complete checkpoint, create an annotated release-candidate tag, and record both commit and tag in `SHIP-READINESS.md`.
8. Record the current and previous known-good Firebase Hosting version IDs, then perform the documented rollback drill.

## Release-candidate evidence template

- Commit: _pending_
- Annotated tag: _pending_
- `origin` push: _pending_
- Clean worktree path/date: _pending_
- Test command/results: _pending_
- Production Hosting file count: _pending_
- Hash mismatches: _pending_
- Hosting version ID: _pending_
- Previous known-good version ID: _pending_
- Rollback drill result: _pending_

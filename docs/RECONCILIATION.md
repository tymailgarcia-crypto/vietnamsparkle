# Review preparation and reconciliation — 2026-11-08

## Source selection

Ty explicitly authorized a consolidated commit of verified Claude/Codex work,
with unfinished variants preserved separately, as an exception to the normal
own-changes-only rule in AGENTS.md.

The browser baseline is Hosting release `9ce4e7e012644d1f`. All 60 application
assets were SHA-256 compared with the live site on 2026-11-08 before copying them
from the release snapshot. The two Firebase-managed `__/firebase/init.*` responses
are not application source and were excluded. The current source retains the
live photo requirement for container returns; the older local photo-removal and
opening-container/onboarding work was not silently included.

Backend source starts from the previously committed financial/order handlers,
adding the release-recorded staff management, help, and AI parse/confirmed-save
modules. Backend packages were reconstructed from local source and release
records, not downloaded and byte-compared with cloud packages. The help guide
contains later local documentation, so it is not claimed identical to the deployed
help package. This is a verified source baseline, not a new cloud release.

Original variants of all 36 modified files and 22 new application files were
copied before reconciliation to the ignored local directory
`firebase/.firebase/template-reconciliation-2026-11-08/preserved-working/`.
The two excluded opening-container test files are also under `excluded-local/`.
`preserved-manifest.json`, `baseline.zip` and `live-verification.json` retain the
file inventory, prior Git snapshot and live comparison. These machine-local
backups are not committed or uploaded. Local HANDOVER.md additions containing a
staff member's identity/access inventory remain uncommitted; they are not needed
for the fictional-data review. Personal `.claude/` material is excluded.

## Checks

- Ten pure suites pass: customer error messages, reordering, submission keys,
  account balances, deposits, return-proof wiring, return-to-assigned behavior,
  route geometry/GPS, AI draft matching and help rendering.
- Twelve backend suites pass under Node 22 with separate Auth/Firestore
  emulators. They include parallel deliveries against the same holdings,
  idempotent order submission/payment, approval/account-link protection, payment
  validation, cancellations/refunds, staff onboarding and confirmed AI saves.
- Twelve existing rules suites pass against local Firestore/Storage, including
  account-link and email takeover protections, payments and proof-file access.
  Known evaluation errors still appear on denied requests (including the order
  update rule). Passing assertions do not clear those previously documented
  warnings; no production security rules were edited or deployed here.
- The lifecycle verifier used real local callables for submission/retry,
  approval, driver assignment through rules, partial delivery payment,
  settlement/retry, synthetic proof upload through Storage rules, return credit
  with linked proof, and rejection of anonymous payment attempts.
- Browser checks covered owner sign-in, active dispatch stages, mobile approval,
  delivery/payment submission, customer catalogue/cart totals and a 390px phone
  layout without horizontal overflow. No console errors were observed on the
  inspected customer page. Screenshots use fictional records only.
- JavaScript syntax and relative browser imports were checked under Node 22.
- A clean archive of the staged repository also passed the ten pure suites and
  the full local lifecycle, using the already installed dependency directories.
  No untracked application modules were needed. This did not repeat a fresh
  dependency download/install or verify WSL2.

## Reproduce

Follow [Firebase setup](../firebase/README.md). Start `pnpm demo`, then run
`pnpm demo:seed` and `pnpm demo:verify` in another terminal. Run `pnpm test`,
`pnpm test:backend`, and, while the demo is running, `pnpm test:rules`.

Screenshots are in [screenshots/](screenshots/README.md). The seeded example
orders can be replenished with `demo:seed`; the lifecycle verifier creates new
fictional orders each time. Dates use the current Vietnam business date so the
server's real past-date validation remains active.

## Deliberate limits

No real customer records, payments, messages or production mutations were used.
The generated demo exports no scheduled/database triggers, disables FCM in its
disposable code copy, and uses deterministic help instead of external AI.
Maps routing, external AI quality, push delivery, physical driving, cloud IAM,
billing, production recovery and WSL2 are outside these checks. The synthetic PNG
is a transport fixture, not a photograph proving a real-world return. Application
preparation does not establish Alignerr eligibility or waive its participant terms.

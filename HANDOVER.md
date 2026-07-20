# Vietnam Sparkle operations and handover runbook

**Status:** operational draft; single-operator access risk accepted and release-candidate checks remain open; paid database recovery is deliberately deferred
**Last verified:** 2026-07-20 12:44 UTC
**Project:** `vietnamsparkle-36dfe`
**Production Hosting:** <https://vietnamsparkle-36dfe.web.app/>

This is the launch and emergency runbook. `HANDOFF.md` contains development history and traps; `SHIP-READINESS.md` is the ship gate; `.agent-status.md` owns live file claims.

## 1. Verified facts and open confirmations

Verified from the repository and local tools:

- Firebase project alias `default` points to `vietnamsparkle-36dfe` in `firebase/.firebaserc`.
- Hosting publishes all of `firebase/web/`; there is no partial file deploy.
- Firestore rules, indexes, Storage rules, Functions, and Hosting have separate deploy scopes in `firebase/firebase.json`.
- Functions target Node.js 22. The local shell used during this check was Node `v24.18.0`; use Node 22 for release work so local discovery matches production.
- Firebase CLI `15.22.4`, pnpm `11.10.0`, Git `2.49.0.windows.1`, and Java 21 are installed. Java is at `C:\Program Files\Eclipse Adoptium\jre-21.0.11.10-hotspot\bin\java.exe`.
- The public Firebase web configuration and browser Maps/App Check site keys are deliberately shipped to browsers. They are identifiers, not Admin SDK credentials. API restrictions and Firebase rules are the security boundary.
- No private-key/service-account signatures were found in the tracked tree or Git history using the 2026-07-20 credential scan. `.gitignore` excludes common Admin SDK, PEM, P12, and environment-secret filenames.
- Firebase CLI reauthentication succeeded for `tymailgarcia@gmail.com`; the account can access the ACTIVE project `vietnamsparkle-36dfe` (project number `1092060902387`).
- Project IAM has one `roles/owner` member: `user:tymailgarcia@gmail.com`. There is no backup project owner or administrator recorded in IAM.
- Cloud Billing is enabled and linked to `billingAccounts/01D262-5F45BB-369158`. Its IAM policy has one `roles/billing.admin` member: `user:tymailgarcia@gmail.com`; no backup billing administrator was found. A linked billing account means no-cost quotas are allowances, not a hard spending cap.
- Ty confirmed he is the sole operator and does not have or want a separate backup administrator/recovery account at launch. Loss of access to `tymailgarcia@gmail.com` could therefore block project administration, billing response, deployment, and customer operations; this is an explicitly accepted launch risk, not access redundancy.
- The `(default)` Firestore database is Firestore Native, Standard edition, in `asia-east2`. Delete protection was enabled and verified on 2026-07-20; point-in-time recovery remains disabled and version retention is one hour (`3600s`).
- Firestore has no backup schedule and no backups in `asia-east2`. Under Ty's no-monthly-cost launch decision, paid PITR, scheduled backups, and managed restore are deliberately deferred.
- Nine Cloud Functions are ACTIVE on Node.js 22. `reconcileOnPaymentWrite` is in `asia-east2`; the other eight are in `us-central1`.
- Hosting live version `ceb7745d6aa10c3d` was created 2026-07-20 10:11:58 UTC (44 files). The immediately preceding fully verified version is `9d83a2219e228e81`, created 2026-07-20 09:57:19 UTC (44 files).
- The current site uses the Firebase `web.app` domain. No custom domain is recorded in the repository.

Authenticated verification status:

- [x] Firebase project owner binding confirmed.
- [!] No backup project administrator by Ty's explicit single-operator decision.
- [x] Cloud Billing link and billing-administrator binding confirmed.
- [!] No backup billing administrator or independent recovery email by Ty's explicit single-operator decision.
- [x] Firestore location, edition, point-in-time recovery, and delete-protection state recorded.
- [x] Scheduled-backup and existing-backup state recorded: neither exists.
- [x] Free database delete protection enabled; paid PITR/backups left disabled by decision.
- [ ] Maps key HTTP-referrer restrictions for the production Hosting domain.
- [ ] Firebase App Check registration and verified-traffic metrics. Do not enforce App Check before valid production traffic appears.
- [ ] Billing budget alerts, quota alerts, and their recipients.
- [ ] Custom-domain owner/registrar/DNS instructions if a custom domain is added later.

## 2. Access and project selection

Run from `firebase/`:

```powershell
firebase login --reauth
firebase login:list
firebase projects:list
firebase use vietnamsparkle-36dfe
firebase use
```

Expected active project: `vietnamsparkle-36dfe`.

Do not create or commit a Firebase CI token. Prefer interactive user login for this one-owner deployment workflow. A future CI workflow should use a narrowly scoped workload identity or managed service account stored outside Git.

### Owner and driver custom claims

The script requires an Admin SDK service-account JSON supplied through `FIREBASE_SERVICE_ACCOUNT_PATH`. Keep that file outside the repository.

```powershell
$env:FIREBASE_SERVICE_ACCOUNT_PATH = 'C:\secure\path\project-adminsdk.json'
node src/scripts/setUserClaims.js --email owner@example.com --role owner
node src/scripts/setUserClaims.js --email driver@example.com --role driver --driver-id H-001
```

After a claim changes, the user must sign out and sign back in. Never assign a driver claim until Firestore rules restrict drivers to their assigned operational records; the ship board currently keeps driver rollout disabled.

## 3. Release preflight

1. Run `git status --short --branch` from the repository root.
2. Read `.agent-status.md`. Stop if anyone has live work under `firebase/web/` and the release would use `--only hosting`.
3. Confirm the exact release commit and annotated tag exist on `origin`.
4. Use a clean checkout or isolated Git worktree at that tag. Never deploy the shared dirty working directory for a release candidate.
5. Install with pnpm. The repository has previously failed under npm.
6. Run syntax, focused tests, rules tests, and production-equivalent authenticated QA required by `SHIP-READINESS.md`.
7. Generate a SHA-256 manifest of the staged Hosting tree and save it with the release evidence.
8. Deploy one scope at a time and record the CLI output/revision/version in `SHIP-READINESS.md` and `.agent-status.md`.

Suggested clean worktree setup after a release tag exists:

```powershell
git fetch origin --tags
git worktree add '..\vietnam-sparkle-release' '<release-tag>'
Set-Location '..\vietnam-sparkle-release\firebase'
firebase use vietnamsparkle-36dfe
```

## 4. Deployment scopes

Always run from the clean release worktree's `firebase/` directory:

```powershell
firebase deploy --only hosting --project vietnamsparkle-36dfe
firebase deploy --only functions --project vietnamsparkle-36dfe
firebase deploy --only firestore:rules --project vietnamsparkle-36dfe
firebase deploy --only firestore:indexes --project vietnamsparkle-36dfe
firebase deploy --only storage --project vietnamsparkle-36dfe
```

Never substitute an unscoped `firebase deploy` during stabilization. In particular:

- Hosting uploads the whole `firebase/web/` directory.
- Do not deploy `firestore:rules` unless that exact rules file was reviewed and tested for the release.
- Functions deployment must be checked for callable/schedule discovery and for the `reconcileOnPaymentWrite` Eventarc trigger in `asia-east2`.
- The other Functions use the configured `us-central1` default; `nightlyReconcileOrderMath` runs at 03:00 `Asia/Ho_Chi_Minh`.

## 5. Rollback

### Hosting emergency rollback

Fastest operational route: Firebase Console → Hosting → Release history → select the last verified release → **Roll back**. Record the restored version and time on the live agent board.

The CLI does not expose a direct live-release rollback command. `firebase hosting:clone <site>:<preview-channel> <site>:live` is usable only when a known-good preview channel was intentionally retained. Do not guess a channel.

Reproducible route: use an isolated worktree at the previous known-good Git tag and deploy only Hosting:

```powershell
git worktree add '..\vietnam-sparkle-rollback' '<previous-good-tag>'
Set-Location '..\vietnam-sparkle-rollback\firebase'
firebase deploy --only hosting --project vietnamsparkle-36dfe
```

The current live Hosting version is `ceb7745d6aa10c3d` (2026-07-20 10:11:58 UTC). The immediately preceding fully verified rollback target is `9d83a2219e228e81` (2026-07-20 09:57:19 UTC). In an incident attributable to the current Hosting release, use the Console rollback route above and select `9d83a2219e228e81`; record the resulting release ID and verification. These version IDs provide an emergency operational target but do not replace the still-missing pushed release commit and Git tag.

### Rules, indexes, Storage rules, and Functions rollback

Deploy only the affected scope from the previous known-good tag. A Functions rollback is a redeploy that creates/restores revisions; verify every exported function and the Eventarc trigger afterward.

Do not roll Firestore data backward as part of a code rollback. Data restore is a separate incident action described below.

## 6. Firestore data protection and accepted recovery limit

### No-monthly-cost launch policy

Decision by Ty on 2026-07-20:

- Keep paid PITR, scheduled backups, backup storage, and managed restore disabled.
- Enable the no-cost database delete-protection setting. It is enabled on `(default)`.
- Accept for launch that delete protection prevents deletion of the entire database but does **not** recover documents deleted or corrupted by the application or an operator.
- With PITR disabled, Firestore retains a one-hour historical version window. This is not a backup and does not provide a verified full-database restore path.
- Revisit paid recovery before the accepted loss window becomes operationally or financially unacceptable.

Firestore's documented free quota for one database is 1 GiB stored data, 50,000 reads/day, 20,000 writes/day, 20,000 deletes/day, and 10 GiB outbound/month. Because this project has billing linked, exceeding a free allowance or using another paid Firebase/Google Cloud feature can still generate charges. Budget alerts notify; they do not cap usage. Monitor the Firestore Usage and Cloud Billing pages in section 7.

Official references: [Firestore usage and free quota](https://firebase.google.com/docs/firestore/quotas), [PITR pricing](https://firebase.google.com/docs/firestore/enterprise/pitr#pricing), [scheduled-backup requirements and costs](https://firebase.google.com/docs/firestore/backups), and [database delete protection](https://cloud.google.com/firestore/docs/manage-databases).

### Read-only verification

After `firebase login --reauth`:

```powershell
firebase firestore:databases:get '(default)' --project vietnamsparkle-36dfe
firebase firestore:backups:schedules:list -d '(default)' --project vietnamsparkle-36dfe
firebase firestore:backups:list --location asia-east2 --project vietnamsparkle-36dfe
```

Record the database's `pointInTimeRecoveryEnablement`, `deleteProtectionState`, backup schedule, retention, newest successful backup, and resource name.

Verified 2026-07-20 after the approved update: `(default)` is in `asia-east2`; delete protection is enabled, PITR is disabled, version retention is one hour, the backup-schedule list is empty, and no backups exist in `asia-east2`.

Paid recovery commands are retained for a future policy change; do not run them without explicit cost and retention approval:

```powershell
firebase firestore:databases:update '(default)' --point-in-time-recovery ENABLED --project vietnamsparkle-36dfe
firebase firestore:backups:schedules:create -d '(default)' --recurrence DAILY --retention 30d --project vietnamsparkle-36dfe
```

### Restore drill

There is currently no backup to restore, and a paid managed restore drill is deliberately deferred by the no-monthly-cost policy. If that policy changes, never restore over production for a test. Use a uniquely named non-production database in the same project or, preferably, a dedicated restore-drill project. Confirm billing and the destination name before creation.

```powershell
firebase firestore:databases:create restore-drill-YYYYMMDD --location asia-east2 --delete-protection ENABLED --project vietnamsparkle-36dfe
firebase firestore:databases:restore -d restore-drill-YYYYMMDD -b '<full-backup-resource-name>' --project vietnamsparkle-36dfe
```

Verify representative counts and one order/customer/payment/deposit relationship without exposing customer personal data in the evidence. Record cleanup ownership and retention. Deleting the drill database is destructive and requires an explicit approval at action time.

## 7. Monitoring locations

- In-app reconciliation: <https://vietnamsparkle-36dfe.web.app/reports.html>
- Firebase Functions: <https://console.firebase.google.com/project/vietnamsparkle-36dfe/functions>
- Cloud Logging: <https://console.cloud.google.com/logs/query?project=vietnamsparkle-36dfe>
- Eventarc triggers: <https://console.cloud.google.com/eventarc/triggers?project=vietnamsparkle-36dfe>
- Firestore data/usage/backups: <https://console.firebase.google.com/project/vietnamsparkle-36dfe/firestore>
- Storage: <https://console.firebase.google.com/project/vietnamsparkle-36dfe/storage>
- Authentication/users/providers: <https://console.firebase.google.com/project/vietnamsparkle-36dfe/authentication>
- App Check: <https://console.firebase.google.com/project/vietnamsparkle-36dfe/appcheck>
- Google Cloud quotas: <https://console.cloud.google.com/iam-admin/quotas?project=vietnamsparkle-36dfe>
- Billing linkage/budgets: <https://console.cloud.google.com/billing/linkedaccount?project=vietnamsparkle-36dfe>

Expected deployed Functions:

- `submitPublicOrder`
- `nightlyReconcileOrderMath`
- `mergeCustomers`
- `reconcileOnPaymentWrite`
- `submitOrderCancellation`
- `resolveOrderCancellation`
- `recordOrderRefund`
- `attachRefundEvidence`
- `resolveLegacyCancellation`

All nine were ACTIVE on Node.js 22 when checked on 2026-07-20. The Cloud Scheduler job `firebase-schedule-nightlyReconcileOrderMath-us-central1` was ENABLED on `0 3 * * *` in `Asia/Ho_Chi_Minh`; its latest attempt was 2026-07-20 03:00 local and returned HTTP 200. Direct Cloud Run logs showed successful application completions on July 16, 17, 18, 19, and 20 local, all with `failed: 0` and `drifted: 0`; the latest scanned 9 and skipped 1. For Gen 2 scheduled functions, query the Cloud Run service `nightlyreconcileordermath` if `firebase functions:log` omits recent structured entries.

After reauthentication, verify with:

```powershell
firebase functions:list --project vietnamsparkle-36dfe
firebase functions:log --project vietnamsparkle-36dfe
```

## 8. Maps, App Check, and domain configuration

- Maps requires Maps JavaScript API and Geocoding API. Restrict the browser key to the exact Hosting referrers used in production; never restrict it by IP.
- App Check uses a reCAPTCHA Enterprise site key in the public bundle. Registration/metrics are still unverified. Keep Functions enforcement off until valid production traffic is visible.
- The current Auth/Hosting domain is `vietnamsparkle-36dfe.firebaseapp.com` / `vietnamsparkle-36dfe.web.app`.
- When adding a custom domain, record registrar, DNS owner, Firebase verification records, certificate status, authorized Auth domains, Maps referrer entries, App Check domain entries, and rollback DNS values here.

## 9. Launch-day contacts and escalation

Complete before launch. Do not put passwords, recovery codes, or private credentials in this table.

Decision recorded 2026-07-20 12:44 UTC: Ty is the sole operator and contact for every launch responsibility. He confirmed there is no backup administrator or separate recovery contact. No access binding was changed.

| Responsibility | Primary | Backup | Contact route | Confirmed |
|---|---|---|---|---|
| Business/launch approver | Ty | None | `tymailgarcia@gmail.com` | Sole operator confirmed |
| Firebase project administration | `tymailgarcia@gmail.com` (`roles/owner`, verified) | None | `tymailgarcia@gmail.com` | Sole operator confirmed |
| Billing administration | `tymailgarcia@gmail.com` (`roles/billing.admin`, verified) | None | `tymailgarcia@gmail.com` | Sole operator confirmed |
| Technical incident response | Ty | None | `tymailgarcia@gmail.com` | Sole operator confirmed |
| Customer communication | Ty | None | `tymailgarcia@gmail.com` | Sole operator confirmed |

Escalation order:

1. Stop new deployments and record the incident/time in `.agent-status.md`.
2. Decide whether to disable the affected operation, roll back code, or pause public ordering.
3. Preserve logs, order IDs, payment IDs, and reconciliation evidence without copying customer data into Git.
4. For money/deposit drift, run reconciliation and inspect the append-only payment/deposit history before making corrections.
5. Corrections must be new auditable entries; never edit/delete an existing payment to hide an error.

## 10. Handover completion record

- [x] CLI reauthentication completed.
- [x] Project/billing owner confirmed; absence of a backup administrator explicitly accepted by Ty.
- [x] Delete protection enabled; PITR and backup schedule remain disabled under the documented no-monthly-cost policy.
- [x] Paid managed restore drill explicitly deferred by Ty; no backup exists to restore.
- [ ] Maps restriction verified.
- [ ] App Check registration/metrics decision recorded.
- [ ] Release and previous-good tags/Hosting versions recorded.
- [ ] Monitoring and budget alert recipients tested.
- [x] Launch contacts completed for the current sole-operator model.
- [ ] Customer and owner authenticated QA signed off in `SHIP-READINESS.md`.

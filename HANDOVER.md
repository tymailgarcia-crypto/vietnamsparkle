# Vietnam Sparkle operations and handover runbook

**Status:** operational draft; access, backup, restore, and release-candidate checks remain open
**Last verified:** 2026-07-20 11:45 UTC
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
- The current Firebase CLI account label is `tymailgarcia@gmail.com`, but its credential is expired. Project listing and all authenticated checks require reauthentication.
- The current site uses the Firebase `web.app` domain. No custom domain is recorded in the repository.

Must be confirmed in Firebase/Google Cloud after reauthentication:

- [ ] Firebase project owner(s) and at least one backup administrator.
- [ ] Cloud Billing account owner and a recovery email not dependent on one person/device.
- [ ] Firestore location, edition, point-in-time recovery, and delete-protection state.
- [ ] Scheduled Firestore backup policy and the newest successful backup.
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

As of this runbook's date there is no release tag and no recorded Hosting version ID, so the rollback target is still a P0 blocker. The deploy log identifies the fully verified 2026-07-20 10:0x release and the preceding 09:4x release by time, but the console version IDs must be recorded after reauthentication.

### Rules, indexes, Storage rules, and Functions rollback

Deploy only the affected scope from the previous known-good tag. A Functions rollback is a redeploy that creates/restores revisions; verify every exported function and the Eventarc trigger afterward.

Do not roll Firestore data backward as part of a code rollback. Data restore is a separate incident action described below.

## 6. Firestore backup and restore

### Read-only verification

After `firebase login --reauth`:

```powershell
firebase firestore:databases:get '(default)' --project vietnamsparkle-36dfe
firebase firestore:backups:schedules:list -d '(default)' --project vietnamsparkle-36dfe
firebase firestore:backups:list --location asia-east2 --project vietnamsparkle-36dfe
```

Record the database's `pointInTimeRecoveryEnablement`, `deleteProtectionState`, backup schedule, retention, newest successful backup, and resource name.

Possible enablement commands are shown for the approver; do not run them without confirming cost and retention:

```powershell
firebase firestore:databases:update '(default)' --point-in-time-recovery ENABLED --delete-protection ENABLED --project vietnamsparkle-36dfe
firebase firestore:backups:schedules:create -d '(default)' --recurrence DAILY --retention 30d --project vietnamsparkle-36dfe
```

### Restore drill

Never restore over production for a test. Use a uniquely named non-production database in the same project or, preferably, a dedicated restore-drill project. Confirm billing and the destination name before creation.

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

| Responsibility | Primary | Backup | Contact route | Confirmed |
|---|---|---|---|---|
| Business/launch approver | Ty | _pending_ | _pending_ | [ ] |
| Firebase project administration | `tymailgarcia@gmail.com` (role unverified) | _pending_ | _pending_ | [ ] |
| Billing owner | _pending_ | _pending_ | _pending_ | [ ] |
| Technical incident response | _pending_ | _pending_ | _pending_ | [ ] |
| Customer communication | _pending_ | _pending_ | _pending_ | [ ] |

Escalation order:

1. Stop new deployments and record the incident/time in `.agent-status.md`.
2. Decide whether to disable the affected operation, roll back code, or pause public ordering.
3. Preserve logs, order IDs, payment IDs, and reconciliation evidence without copying customer data into Git.
4. For money/deposit drift, run reconciliation and inspect the append-only payment/deposit history before making corrections.
5. Corrections must be new auditable entries; never edit/delete an existing payment to hide an error.

## 10. Handover completion record

- [ ] CLI reauthentication completed.
- [ ] Project/billing owners and backup administrator confirmed.
- [ ] PITR/delete protection/backup schedule recorded.
- [ ] Restore drill completed and evidence linked.
- [ ] Maps restriction verified.
- [ ] App Check registration/metrics decision recorded.
- [ ] Release and previous-good tags/Hosting versions recorded.
- [ ] Monitoring and budget alert recipients tested.
- [ ] Launch contacts completed.
- [ ] Customer and owner authenticated QA signed off in `SHIP-READINESS.md`.

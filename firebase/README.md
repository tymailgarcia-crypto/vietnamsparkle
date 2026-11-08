# Firebase application: local development

Use Node.js 22, pnpm and Java 21 for the emulators. On Windows, the Alignerr
listing additionally requires WSL2; PowerShell does not verify that requirement.
Browser SDK modules load from Google's CDN, so internet access is still needed.

From this directory:

```sh
pnpm install --frozen-lockfile
npm --prefix functions ci
pnpm test
```

The test command runs explicitly listed pure regression suites without Firebase
credentials. It is a focused check, not the complete release gate.

## Isolated fictional-data preview

```sh
pnpm demo
```

Keep that terminal running. In a second terminal, from firebase/:

```sh
pnpm demo:seed
```

Open <http://127.0.0.1:5000/admin.html>. The seed command prints a fictional
local-only owner login. Use a separate browser profile for this preview.

The demo copies current web files into ignored `.firebase/template-demo/`,
replaces the copied Firebase configuration with `demo-delivery-template`,
disables Maps/App Check/push configuration and replaces the copied messaging
worker with an inert file. It never edits source web configuration.
Authentication, Firestore, Storage and Hosting bind to loopback. The seed refuses
unexpected project/environment endpoints, loads no service-account file and
imports no business export. Data is not imported or exported between restarts;
seed again after restarting.

**Scope:** catalogue and owner-page browsing, plus direct emulator database
interactions. Cloud Functions are deliberately absent. Order submission,
approval, payment/delivery callables, AI, scheduled jobs, Maps and push are not
demonstrated end to end. Callable requests target localhost and fail without the
Functions emulator. Do not describe this as a full operational demo.

## Backend and security checks

Additional suites live in functions/, rules-tests/, src/ and web/assets/.
Some start or require emulators: inspect their instructions and project IDs first.
The full release gate and known gaps are in ../SHIP-READINESS.md.
Never point fixtures at production.

The existing emulators, seed:emulator, import:sheets and set:claims commands are
the older project-specific workflow, not this isolated preview. In particular,
seed:emulator reads a legacy product export.

## Production and handover

Production requires separately configured login providers, roles, indexes,
security rules, Storage, Functions, secrets, schedules and external integrations.
Changing browser configuration alone is insufficient. Consult ../HANDOVER.md,
verify dated facts and reconcile the release before deploying. Hosting publishes
its entire configured directory. This preparation makes no cloud changes.

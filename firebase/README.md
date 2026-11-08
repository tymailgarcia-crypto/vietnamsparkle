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

The test command runs ten explicitly listed pure regression suites without
Firebase credentials. It is a focused check, not the complete release gate.

## Isolated fictional-data preview

```sh
pnpm demo
```

Keep that terminal running. In a second terminal, from firebase/:

```sh
pnpm demo:seed
pnpm demo:verify
```

Open <http://127.0.0.1:5000/admin.html>. The seed command prints fictional local
owner and customer logins, creates two products and three example dispatch stages.
The verification command creates additional fictional orders and exercises the
real local handlers: submission/retry, approval, assignment, delivery, partial
payment, settlement/retry, proof upload and a container return. It also checks
that an anonymous payment is denied. It writes local evidence under .firebase/.
Use a separate browser profile for this preview. Re-seeding resets the three
named example orders; it does not erase orders created by the verifier.

The demo copies current web files into ignored `.firebase/template-demo/`,
replaces the copied Firebase configuration with `demo-delivery-template`,
disables Maps/App Check/push configuration and replaces the copied messaging
worker with an inert file. It never edits source web configuration.
Authentication, Firestore, Storage, Functions and Hosting bind to loopback. The seed refuses
unexpected project/environment endpoints, loads no service-account file and
imports no business export. Data is not imported or exported between restarts;
seed again after restarting.

The disposable Functions copy reuses real application handlers. Its push adapter
is inert; scheduled and database triggers are not exported. External AI is
disabled, with a deterministic help response. No real payment or message is sent.
Maps and push are not demonstrated. A synthetic one-pixel PNG tests the proof
upload and linkage; it is not a real container photograph. Do not deploy this
generated emulator configuration.

The complete local stack was verified with Node 22. On a machine whose default
Node differs, run the launcher with:

```sh
npm exec --yes --package=node@22 -- node scripts/template-demo.mjs
```

This obtains Node 22 from the npm registry if it is not already cached. Startup
also allows 60 seconds for Functions discovery on slower machines.

## Backend and security checks

```sh
pnpm test:backend
pnpm test:rules
```

The backend command starts its own disposable Auth/Firestore emulators on ports
9098/8082, runs twelve suites and shuts them down. Its fixture projects are
separate from the UI preview. The rules command requires the demo to be running
and runs twelve existing suites on loopback, using separate test projects.
The rules emulator still emits documented evaluation errors for some denied
requests; passing assertions do not resolve those warnings. No rules were changed
for this preparation. See ../docs/RECONCILIATION.md and ../SHIP-READINESS.md.
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

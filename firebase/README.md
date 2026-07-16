# Vietnamsparkle Firestore Migration

This folder now contains a runnable Firestore-backed replacement for the Sheets app.

## Included

- `package.json`: npm dependencies and runnable scripts
- `src/config/firebase.web.js`: safe frontend Firebase config
- `src/config/firebaseAdmin.js`: server/admin Firestore bootstrap using a service account file path
- `src/firestore/schema.js`: canonical Firestore collection names and field mapping
- `src/scripts/importSheetsJson.js`: import current Sheets-style JSON into Firestore
- `web/index.html`: public customer order page
- `web/admin.html`: owner dispatch dashboard
- `web/assets/*`: shared Firebase client code, dashboard logic, and styling
- `firestore.rules`: starter Firestore security rules
- `firestore.indexes.json`: starter composite indexes
- `firebase.json`: hosting + Firestore config

## Current v1 architecture

- `Firestore` = source of truth
- `Firebase Auth` email/password = owner login
- public customer form = frontend writes orders + orderItems directly into Firestore
- owner dashboard = signed-in Firestore client for approval, dispatch, manual orders, and payment logging
- service account = admin scripts / migration / privileged tasks
- Sheets = optional backup/export only

## Setup

### Local emulator catalog

After starting the emulators, seed the local product catalog once:

```bash
npm run seed:emulator
```

The command only accepts a localhost Firestore emulator and refuses non-local
hosts. It is safe to rerun because products are merged by their stable IDs.
The normal `npm run emulators` command imports `emulator-data` on startup and
exports it on exit, preserving local test logins, products, and test orders.

1. Copy this folder somewhere you want to run Node from.
2. Run:

```bash
npm install
```

3. Set your service account path:

PowerShell:

```powershell
$env:FIREBASE_SERVICE_ACCOUNT_PATH='C:\Users\garci\Downloads\vietnamsparkle-36dfe-firebase-adminsdk-fbsvc-9bb0ddd915.json'
```

4. If you want to import existing data, create a JSON file shaped like:

```json
{
  "customers": [],
  "orders": [],
  "orderItems": [],
  "products": [],
  "helpers": [],
  "payments": [],
  "deposits": [],
  "returns": [],
  "purchases": [],
  "expenses": [],
  "documents": [],
  "dailySummary": [],
  "inquiries": []
}
```

5. Run the importer:

```bash
npm run import:sheets -- --input "C:\path\to\sheets-export.json"

The importer also accepts the extracted folder-based export:

```bash
npm run import:sheets -- --input "C:\path\to\sheet-export"
```

## Owner dashboard setup

1. In Firebase Console, enable `Authentication -> Sign-in method -> Email/Password`.
2. Create the owner user manually in `Authentication -> Users`.
3. Grant the owner role via custom claim (see next section).
4. Deploy the Firestore rules and hosting files.
5. Open:

```text
/index.html
/admin.html
```

## Roles and access

Access is controlled by Firebase Auth custom claims, enforced in `firestore.rules`:

- `role: "owner"` — full read/write on every collection; approves public orders; records payments, deposits, purchases, expenses.
- `role: "driver"`, `driverId: "<matches drivers/{id}>"` — can read only orders assigned to their `driverId`, and can update only `status`, `updatedAt`, and `notes` on those orders. Read-only on `customers`, `products`, `drivers`, `orderItems`.
- Public (unauthenticated) — can create an order/orderItems in `pending_approval` status, and create an inquiry. All other collections are locked.

Set a claim (service account must be configured, same as `import:sheets`):

```bash
npm run set:claims -- --email owner@example.com --role owner
npm run set:claims -- --email driver1@example.com --role driver --driver-id H-001
```

The user must sign out and back in for the new claim to take effect.

## Hosting deployment

If you have the Firebase CLI installed:

```bash
firebase use vietnamsparkle-36dfe
firebase deploy --only firestore:rules,firestore:indexes,hosting
```

## Current owner features

- public structured order intake into `orders` + `orderItems`
- owner sign-in with Firebase Auth
- today board from Firestore
- approve pending website orders
- assign driver
- record quick cash/transfer payments
- create manual owner orders
- auto-create customer records for owner actions
- auto-log deposit charge events when deposit totals exist
```

## Collections

- `customers`
- `orders`
- `orderItems`
- `products`
- `drivers`
- `payments`
- `depositEvents`
- `returns`
- `purchases`
- `expenses`
- `documents`
- `dailySummaries`
- `inquiries`

## Notes

- The web config in this folder is safe for frontend use.
- Do not commit the service account JSON.
- The importer uses the current Sheets IDs as Firestore document IDs where possible so links remain stable.
- The current Firestore rules are pragmatic for one-owner v1: signed-in users can manage internal collections. Tighten them later with custom claims or a dedicated backend.

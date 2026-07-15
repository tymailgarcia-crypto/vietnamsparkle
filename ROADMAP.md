# Water Delivery System — Product Roadmap

Living document. Add freely, prune ruthlessly. Anything decided moves out of "open questions" into the section body. Anything shipped stays in the section body under a `Shipped` sub-bullet.

## Vision

A one-owner-first delivery ops system for a Da Nang water business, with just enough compliance, customer memory, and self-serve UX that:

- The owner never loses track of who owes what, who's holding which containers, or which orders are still open.
- Repeat customers reorder in seconds without re-typing anything.
- The books survive a Vietnamese tax review without a scramble.
- The system will eventually be handed to the customer's own Firebase project and domain.

## Payment collection gate (shipped 2026-07-08)

The problem this solves: the owner is laid back and loses money because "paid" was a status flip, delivery and collection were decoupled, and there was no forcing function.

The model shift: **payment is an event, delivery is a gate**.

Shipped:
- **`/payments` is now the source of truth**. Every delivery pairs a `payments` doc write with the order's status update, atomically in one `writeBatch`. Order fields `amountPaid` / `balanceDue` / `paymentStatus` become derived from the sum of events; the client recomputes them at write time.
- **Strict gate on the `out_for_delivery → delivered` transition** for both owner and driver. Firestore rule enforces:
  - `deliveryPaymentEventId` must be set on the order,
  - Must point to an existing `payments` doc (`exists(...)`),
  - Math must be valid (`orderMathValid()` still applies to any money-touching update).
  - Driver update's `affectedKeys` allowed set expands to include the delivery-specific fields; only `status: 'delivered'` transition unlocks them.
- **Driver can now create payments** on orders assigned to them. Rule: `assignedDriverId` on the parent order (via `get()`) must equal `myDriverId()`, and amount ≥ 0.
- **New button on the today board**: `Mark delivered & record payment` (replaces the bare `Mark delivered`). Opens a dialog with two paths:
  - **Collected**: amount (prefilled to `balanceDue`), method (Cash / Bank transfer / QR code / Other), optional reference. Writes a `payments` doc + updates the order.
  - **Not collected today**: reason (customer said next time / customer wasn't home / driver forgot / waived by owner / other), follow-up-by date (default +3 days), notes. Writes a `payments` doc with `deferred: true`, `amount: 0`, `deferralReason`, `followUpBy`, and stamps `followUpBy` on the order.
- No silent gaps. Every delivered order now has a paired payment event — collected OR explicitly deferred with a reason and a follow-up date.

Shipped 2026-07-08 (part 2):
- **`/receivables.html`** — dense list of every order with `balanceDue > 0` (excluding cancelled and pending-approval). Columns: delivered date, days since delivery (red at ≥7 days), customer name (link to profile), phone (`tel:`), order ID (link to today board), balance (right-aligned bold), follow-up date (red if overdue). Actions per row: **Record payment** (opens a lightweight dialog: amount / method / reference → writes payment + updates order in one batch) and **Chase via WhatsApp** (opens `https://wa.me/<digits>?text=<pre-filled template with the customer's name, balance, and delivery date>`).
- **`/deposits.html`** — dense list of every customer × container-type pair with net qty > 0. Columns: customer (link to profile), phone (`tel:`), container type, qty, deposit outstanding, since (oldest charged date), days held (yellow at 30d, red at 60d). Actions: **Mark as forfeit** (dialog with qty / reason dropdown / note → writes a `depositEvents` doc with `eventType: 'forfeited'`) and **Send reminder** (pre-filled WhatsApp message).
- **Nag tiles on admin hero**: two cards linking to receivables and deposits, each showing count + total VND. Red border on the receivables tile if the oldest unpaid is ≥3 days old; red border on the deposits tile if any containers are >60 days held.
- Nav links between `/admin.html` ↔ `/customers.html` ↔ `/orders.html` ↔ `/receivables.html` ↔ `/deposits.html` — all owner pages one click apart.

Shipped 2026-07-08 (part 3):
- **Customer-side balance summary** on `/account.html`, above the containers section. Renders total outstanding across all unpaid non-cancelled non-pending orders with the oldest delivery date. When the customer is all paid up, shows an affirming "You are all paid up. Thanks!" line instead.
- **How to pay block** appears when there is an outstanding balance: three pay-methods (cash on next delivery / bank transfer / QR coming soon) plus WhatsApp and Zalo message links so the customer can ask for bank details without hunting for a phone number.
- Existing **Containers you hold** panel now has clearer messaging: "Return empties on your next delivery. The driver will refund or credit the deposit against your next order." Same aggregation logic (deposit events minus returns, per container type).

Shipped 2026-07-08 (part 4):
- **`/settings/business` Firestore doc** — single central config for the whole app. Fields: `businessName`, `legalName`, `taxCode`, `registeredAddress`, `contact.{whatsapp,zalo,facebook,phone,email}`, `bank.{accountName,accountNumber,name,bin}`, `updatedAt`. Rules: `read: if true` (public — nothing sensitive), `write: if isOwner()`.
- **`/settings.html` admin editor** — new owner-only page with a form for every field. Nav link added on `/admin.html`. `settingsApp.js` handles load + save.
- **`/account.html` How-to-pay block** now renders **real bank details** from the settings doc when the customer has an outstanding balance. Line reads e.g. "Bank transfer — Vietcombank, Nguyen Owner, account `1234567890`. Please include your order ID in the reference." Falls back to "message us on WhatsApp for account details" if bank fields are empty. Contact-channel buttons at the bottom of the block also pull from the settings doc.
- **`/index.html` contact channels** (WhatsApp / Zalo / Facebook chips at the top of the hero) now render from the settings doc. Placeholder message shows if none configured yet.

Shipped 2026-07-14:
- **Nightly reconciliation Cloud Function** — `nightlyReconcileOrderMath` in `firebase/functions/index.js`, scheduled at 03:00 Asia/Ho_Chi_Minh via `firebase-functions/scheduler`. Aggregates every `payments` doc once (single paginated scan), groups by `orderId`, then pages `orders` and compares against each non-cancelled non-testFixture order's stored `amountPaid` / `balanceDue` / `paymentStatus`. Any drift → open a Firestore transaction, re-read the order + re-aggregate its payments inside the tx (so a payment that landed mid-run is not lost), and if drift persists, write `reconciliationReports/{runId}/drifts/{orderId}` (before/after money, paymentsCount, subtotal, depositTotal) and update the order with the recomputed fields plus `reconciledAt` / `reconciledRunId`. A summary doc at `reconciliationReports/{runId}` records `scanned` / `skipped` / `drifted` / `fixed` / `failed`. `paymentStatusFor` is mirrored from `shared.js` — matches `orderMathValid` in `firestore.rules` so the recomputed state always passes the same rules the client is held to.
- **Rules**: `reconciliationReports/{runId}` and its `drifts/{orderId}` subcollection are owner-read, no client write — writes come only from the Cloud Function via Admin SDK.

Still open (next session):
- ~~**Configurable thresholds**~~ Shipped 2026-07-14. Four thresholds folded into `settings/business.thresholds`: `followUpDays` (default 3), `receivableOverdueDays` (default 7), `depositWarningDays` (default 30), `depositForfeitDays` (default 60). `THRESHOLD_DEFAULTS` + `mergeThresholds(raw)` helpers in [firebase/web/assets/shared.js](firebase/web/assets/shared.js) fill in missing values with defaults and coerce non-numbers. A new **Thresholds** section on `/settings.html` gives the owner four number inputs; blank means "reset to default". Consumers read at load time: `adminApp.js` bootstrap → follow-up-by default in the delivery-payment "not collected" flow; `receivablesApp.js` → days-since-delivery red cell on the receivables table; `depositsApp.js` → warning (yellow) + forfeit (red) days-held on the deposits table; `accountApp.js` → "consider returning soon" nudge on the customer's containers panel. No more hardcoded 3 / 7 / 30 / 60 sprinkled across five files.
- **VietQR generator** — with `bank.bin` + `bank.accountNumber` + `bank.accountName` in the settings doc, we can generate a per-order VietQR image client-side. Blocked on the owner providing real bank details.
- **Reconciliation report viewer** — an owner-only page that lists recent `reconciliationReports` runs and expands each `drifts/{orderId}` doc, so drift is visible to the owner without opening the Firestore console. Optionally an email/WhatsApp alert when `drifted > 0` on a run.

## Deposit + container-return gate (shipped 2026-07-08)

Same event-based pattern as payment collection. Deposits get lost by inaction: not collected, container broken, container walked off. The delivery dialog now captures all of it in the same atomic batch as payment.

Shipped:
- **Rules**: driver can now create `depositEvents` on orders assigned to them (`get()` on parent order verifies `assignedDriverId == myDriverId()`, `qty >= 0`, `amount >= 0`).
- **Delivery dialog** grows a **Containers returned this trip** section. On open, we query `depositEvents where customerId == order.customerId` and aggregate by container type: `sum(charged.qty) - sum(refunded.qty) - sum(credited.qty) - sum(forfeited.qty)`. Renders one row per container type currently held with qty on hand, deposit outstanding, an input for **returned qty**, and a handling dropdown:
  - **Credit next order** (default) — writes a `depositEvents` doc with `eventType: 'credited'`. Better cash flow.
  - **Refund cash now** — writes `eventType: 'refunded'`. Driver hands back cash.
  - **Owner will decide later** — no event, container stays outstanding (deposit not resolved yet).
- **Loss report toggle** in the same dialog. Owner ticks the box → picks container type + qty + free-text note ("broken jug", "customer says lost", "waived") → save writes a `depositEvents` doc with the new **`forfeited`** event type. Deposit money stops being outstanding — becomes revenue for the business or gets written off, depending on how the accountant classifies it.
- **Deposit per unit is derived** from prior `charged` events (`totalChargedAmount / totalChargedQty` per type). So the refund/credit/forfeit event carries the right money value automatically — no owner math required.
- Every deposit event ends up in the same `writeBatch` as the payment doc + order status update. Atomic — nothing partially recorded.

Still open (next session):
- **`/deposits.html`** — aged report per customer with days-held and deposit-at-risk. Sortable by oldest first. Row action: **Mark as forfeit** (owner writes `forfeited` event without going through a delivery), **Send reminder** (pre-filled WhatsApp/Zalo message).
- **Nag tile on admin hero**: `Y containers held longer than 60 days — X VND at risk of forfeit`.
- **Customer-side deposit visibility**: show container balance on `/account.html` with the same clarity as order balance.
- **Forfeit thresholds**: configurable per-business (60d warning, 90d urgent, 120d suggested forfeit). No auto-action, just visual pressure.

## Manual order redesign (shipped 2026-07-08)

Manual order creation has moved off the dashboard entirely — it's now customer-centric.

- **Removed from `/admin.html`**: the manual order form, its product catalog, and totals section. The today board is the sole focus of the dashboard.
- **New flow**: owner opens `/customers.html`, searches for the customer, opens the profile, clicks **Create order for this customer**. Dialog with product picker (`-` / `+` / Remove per item), address prefilled from the customer, delivery date/window, notes. Save runs a single `writeBatch` that creates the order (status `new` — skips approval since owner is authoring), the `orderItems`, and a deposit event if `depositTotal > 0`. Order history refreshes in place.
- **If customer doesn't exist**: **Add customer** button on `/customers.html` opens a dialog with basic fields. As owner types phone, a live "might already exist as …" banner appears if any existing customer has the same normalized phone (E.164). Save uses `CUS-<E164 digits>` as the doc id so a second create attempt with the same phone silently merges into the same doc. Then the owner lands on that profile and can create the order.

## Sign-in claim + order backfill (shipped 2026-07-08)

Owner-created customer accounts (no `authUid`) now claim cleanly when the customer signs in.

- **Auto-link by email**: on first sign-in, `accountApp.js` looks for an unclaimed customer doc with matching `email`. If found, `authUid` and `email` are written to that doc — Firestore rules verify `request.resource.data.email == request.auth.token.email` on the transition from `authUid: null → myUid`. Since 2026-07-15 the rule also requires `email_verified == true`; see "Security hardening" below.
- ~~**Phone claim**~~ — **never existed as described.** There is no panel where the customer types a phone. `findUnclaimedByPhone` in `accountApp.js` reads `user.phoneNumber`, which is null for both Google and email-link sign-ins, so this path is dormant until phone auth exists. The claim panel is explanatory text only. A customer-typed phone could not be honoured anyway: it is an unverified claim, and trusting it is the same takeover described under "Audit follow-ups → Critical".
- **Order backfill**: after a link, a `writeBatch` sets `authUid` on every order where `customerId == linked.id` and `authUid` was null. Firestore rule uses `get()` on the parent customer to verify the caller owns it before allowing each order update. Only `authUid` and `updatedAt` are affected — no other order fields can be tampered with via this path.
- **Fresh doc fallback**: if no auto-link matches, `createFreshCustomer` mints a `CUS-<uid>` stub and the claim panel appears. The stub does *not* get "marked superseded" — that was never implemented. It is now collapsed by `foldSelfServeStubInto` on the first approved order, or by an owner merge.

Security tightening 2026-07-08 (in same-day follow-up):
- **Customer claim now requires the doc's pre-write email to already match the caller's token email.** Owner must have set `email` on the customer doc for claim to succeed. Prevents a signed-in customer from hijacking any unclaimed doc by overwriting its email during the same write. Rule diff now `hasOnly(['authUid', 'updatedAt'])` — email cannot be changed via this path.
- **Order writes now require valid math on any create and on any update that touches money fields**, even from the owner. `balanceDue == subtotal + depositTotal - amountPaid`, `paymentStatus == 'paid'` implies `balanceDue <= 0`, `paymentStatus == 'unpaid'` implies `amountPaid == 0`. Rule fails closed on inconsistent writes. Existing bad-data docs (e.g. from earlier DevTools tests) must be deleted or corrected by the owner in the Firestore console. Owner updates that don't touch money fields are unaffected — you can still cancel or edit metadata on an inconsistent legacy order.
- **Phone-claim client flow** now double-checks that the doc's email matches the caller's sign-in email before attempting the update. If not, the user sees an explanatory message ("ask the owner to add your email to your account") instead of a permission-error.

Still open:
- ~~**Owner-side merge tool**~~ Shipped 2026-07-15 — see "Customer identity, merge, and auth" below.
- ~~**Deleting the superseded fresh doc**~~ Resolved 2026-07-15, but by archiving rather than deleting: retention rules forbid hard-deleting a customer doc, so `mergeCustomers` archives the stub with `archived: true` + `mergedInto`.
- **Cloud Function or claimRequests collection** for phone-claim without email — so an owner-created customer without email can still claim via owner-approved review instead of being locked out. Still the right shape, and the only safe one: an owner-approved review supplies the ownership proof that a customer-typed phone number does not. Today those customers are handled by an owner merge.

## Customer identity, merge, and auth (shipped 2026-07-15)

Closes the duplicate-customer problem the 2026-07-14 work left open, and replaces the mechanism that was quietly holding it together.

**The shape of the problem.** Two independent paths mint customer identity and they key on different things. The order path always assigns `customerId = CUS-<phone>` (phone is validated as required in `submitPublicOrder`, so its `|| CUS-<uid>` fallback is unreachable). The identity path mints `CUS-<uid>` only when `findOrAutoLinkCustomer` strikes out on all three lookups. Sign in first, then order, and both fire — two docs, one `authUid`. `findByAuthUid` does `snap.docs[0]` on an unordered query, so **which profile the customer sees is arbitrary and can differ between page loads**. That non-determinism is the visible symptom of a duplicate.

Shipped:
- **`mergeCustomers` callable** in [firebase/functions/index.js](firebase/functions/index.js) — owner-only. Re-keys `orders` / `payments` / `depositEvents` / `returns` / `inquiries` from `fromId` → `toId`, stamps `authUid` on child records that lack one, stamps `orderItems` (keyed by `orderId`, not `customerId`, so they ride along with their parent), then archives the source. Refuses when both sides carry different `authUid`s rather than silently dropping one. Idempotent.
- **Merge UI** on `/customer.html` — searchable target picker, preview showing archive-vs-keep, warnings when both records have history or conflicting uids. Archived records open read-only with a banner pointing at the survivor.
- **`foldSelfServeStubInto`** in `adminApp.js` — the automatic path. The `CUS-<uid>` stub is **unavoidable**: at Google/magic-link sign-in `user.phoneNumber` is null, and the customers create rule deliberately forbids a customer from minting a phone-keyed doc (that is id squatting). So the first approved order is the earliest moment both halves of the identity are known, and approval folds the stub in then. **Gated on the phone doc having been created fresh for that same uid** — folding into a pre-existing doc would re-open the takeover, because `mergeCustomers` copies the source `authUid` onto a target that lacks one. That gate is the entire safety argument; do not relax it.
- **Passwordless email link** replaces email + password on `/account.html`. `sendSignInLinkToEmail` + `signInWithEmailLink`, email stashed in `localStorage` under `vs.magicLinkEmail` for the return hop, `prompt()` fallback when the link is opened in a different browser (a Firebase anti-hijack requirement, not suppressible). Completion runs before the auth observer is wired so the page doesn't flash signed-out, and the spent `oobCode` is stripped from the URL. Requires **Email link (passwordless sign-in)** enabled on the Email/Password provider in the console.
- **Claim panel copy fixed.** It previously promised order history would link "automatically" on next sign-in. That was false: the panel only renders *after* a stub exists, so `findByAuthUid` matches the stub on every later sign-in and the email lookup never runs. It now tells the customer their new orders work regardless and to ask us to link old history.

Net effect: duplicates stop forming on the common path without anyone doing anything. Manual merge remains for records that already diverged, and for owner-added customers with no email on file.

Still open:
- **`findByAuthUid` picks arbitrarily** when duplicates already exist in production. Not worth an `orderBy` — the merge tool is the actual fix — but worth knowing while cleaning up historical data.
- **Backfill of existing duplicates.** Nothing sweeps up `CUS-<uid>` stubs already in the database from earlier signups; they get folded on the customer's next approved order, or by hand.

## Security hardening (2026-07-15)

Prompted by a third-party audit plus a second-opinion review. Both were useful and both were wrong about the most urgent item — see "Points where the reviews were wrong" below.

Shipped:
- **Verified email is now required to read or claim an unclaimed profile.** `hasVerifiedEmail()` in [firebase/firestore.rules](firebase/firestore.rules) gates both unclaimed-by-email branches. Without it, Firebase's public `identitytoolkit` REST signUp endpoint — which needs only the web API key that ships in the browser bundle — lets anyone mint a token carrying an arbitrary `email` with `email_verified: false` and walk straight into a stranger's profile. **Removing the signup button from the UI does not close this**; the attack never goes through our client. The rules check is the whole fix.
- **Customer doc ids pinned to `CUS-<uid>` on create.** Stops id squatting: without it a customer could create `customers/CUS-<someone-elses-phone>` carrying their own `authUid`, and `upsertCustomerFromOrder` correctly refuses to overwrite a non-null `authUid` — so the squatter would hold that phone's canonical doc permanently and the real customer could never claim it.
- **Email pinned to the verified token on customer writes**, and merge tombstone fields (`archived` / `mergedInto` / `testFixture`) locked to the owner. Prevents a customer stamping a victim's address onto their own record to bait an owner into merging.
- **Approval-time `authUid` stamping onto pre-existing unclaimed docs removed** — see "Audit follow-ups → Critical" for the full account-takeover write-up. This is the most important entry in this section.
- **WhatsApp webhook + order-link resolver deleted from production.** Their `defineSecret()` bindings had been swapped for `process.env` shims falling back to `""`, Secret Manager was never enabled, and there was no `.env` — so both secrets resolved to the empty string. The GET verify branch compared `hub.verify_token === ""` (a request with an empty token passed; confirmed against the live endpoint, which echoed the challenge back with HTTP 200), and the POST branch computed its HMAC keyed with `""`, which anyone can reproduce. `timingSafeEqual` was doing its job perfectly against a key that wasn't secret. Source and the conditions for restoring it are parked in [firebase/functions/whatsapp.parked.js](firebase/functions/whatsapp.parked.js) — including a mandatory fail-closed guard on empty secrets.
- **Rules helpers made error-safe.** `isOwner()` / `isDriver()` / `myDriverId()` used bare `request.auth.token.role`, which **raises an evaluation error on every customer request** (customer tokens omit the claim). Masked today because `||` falls through, but it meant the helpers threw on the app's most common request. Now `.get(key, default)`. `isCustomer()` already carried a comment about this exact hazard — someone hit it before and fixed only that one helper.
- **First tests in the codebase.** [firebase/rules-tests/customers.rules.test.mjs](firebase/rules-tests/customers.rules.test.mjs) — 19 cases against the emulator, covering the attacks and the legitimate flows they must not break. [firebase/rules-tests/authuid-linking.test.mjs](firebase/rules-tests/authuid-linking.test.mjs) — 8 cases pinning the `canLinkAuthUidToCustomer` truth table, which rules cannot protect because the owner performs that write.
  - Run: `cd firebase && export JAVA_HOME="/c/Program Files/Eclipse Adoptium/jre-21.0.11.10-hotspot" && export FIRESTORE_EMULATOR_HOST="127.0.0.1:8080" && node rules-tests/customers.rules.test.mjs`. Java is installed but not on `PATH`.
  - Both latent rules bugs above were found by writing these, not by reading the rules. The emulator's stderr reports evaluation errors that passing assertions otherwise hide — **read the stderr, not just the pass count**.

Still open (deliberately deferred — no evidence they matter yet at one-owner scale):
- **Public `inquiries` create is unauthenticated and shape-validated only.** Real spam/billing risk. The audit's fix (require `isSignedIn()`) is wrong — it defeats a public contact form. App Check is the cheap correct answer; a callable with rate limiting is the thorough one.
- **Driver financial inputs unbounded** (`amount >= 0`, `qty >= 0`). Ranked lower than both reviews did: the nightly reconciler already recomputes money from `payments` within a day, and the threat model is a compromised account belonging to one of two known drivers. Hard caps in rules are a magic number that will reject a legitimate bulk order in eighteen months.
- **Maps API key referrer restriction.** The key is public by design (it ships in the bundle) — the referrer restriction in Cloud Console is the only thing protecting it. Now also in a GitHub repo; harmless while private, a scrape target within hours if it ever goes public.

### Points where the reviews were wrong

- **On the WhatsApp webhook**: the audit filed it under "verified architectural strengths" for its `timingSafeEqual` HMAC check. The second opinion said it was "not deployed or credential-bound". Both wrong, in opposite directions — it was deployed *and* fully bypassable. Correct code, defeated by configuration. It was the single most urgent item and neither review ranked it at all.
- **On the audit reviewing stale code**: it reported `createUserWithEmailAndPassword` in `accountApp.js` after that had been removed. Cause found 2026-07-15: the `audit/` directory at the repo root is a **frozen partial copy** of the app, still carrying password signup and pre-`email_verified` rules. The auditor was accurate about what it was reading. **Delete `audit/` or expect it to keep producing phantom findings** — it is recoverable from git.
- **On verification UX**: both reviews recommended adding verification-email flows to the client. Largely moot — Google and email-link sign-in both set `email_verified: true` on their own, so the rules check costs legitimate users nothing.

## Delivery map (shipped 2026-07-09)

Owner request: see every approved order on a Google Map, filter by assigned driver, and hop out to turn-by-turn directions for a driver's route.

Shipped:
- **`/map.html` + `assets/mapApp.js`** — owner-only page. Same nav strip, auth guard, and dense-list pattern as `/orders.html`. List and map are both driven off the same filtered set so what you see on the map matches the table below it.
- **Filters**: driver dropdown (populated from `/drivers`, plus "All drivers" and "Unassigned"), status dropdown (default = "Approved" = `new` + `assigned` + `out_for_delivery`; individual statuses selectable including `delivered` for retro-review), date range (defaults to today for both from and to). Driver + status filters run client-side; date range is pushed to Firestore via `where("deliveryDate", ">=" / "<=")` so we never load the whole orders collection.
- **Pins are colour-coded by driver** — one of ten preset colours per driver id, "Unassigned" is grey. Legend renders below the map for the drivers actually present in the filtered set.
- **Info window** on marker click: customer name, address, `tel:` phone, humanised status, driver name, and an "Open on today board" link that lands the owner on `/admin.html?date=<deliveryDate>` for the existing edit / assign / mark-delivered actions.
- **"Open route in Maps"** button appears when a single driver is selected and their filtered set has ≤ 25 pinned stops. Builds a `google.com/maps/dir/?api=1&waypoints=A|B|C&destination=D` URL — Google Maps app takes over from there. Hidden when driver = "All drivers" (a route across drivers makes no sense) or when the set is 0 or > 25 (Maps rejects long waypoint lists).
- **Geocoding + cache**: for each customer referenced by a filtered order, if the customer doc lacks `location: { lat, lng }`, the page geocodes the customer's address (or the address on the order if the customer field is empty) via `google.maps.Geocoder` and writes `location.{lat,lng,formattedAddress,geocodedAt}` back to the customer doc in a `writeBatch`. Owner rule already covers the write. Rate-limited by 120 ms between calls to stay well under Google's per-second cap. Renders as pins land so the map feels alive.
- **Missing-pins bar**: if any filtered order's customer still has no location after the geocode pass (address gibberish, geocoder returned ZERO_RESULTS, etc.), a top-of-page banner reports "N of M orders could not be pinned. Open the customer profile and check the address; the pin will fill in next time." The list view marks these rows with an open circle vs. the coloured dot on pinned rows.
- **Config**: `mapsApiKey` field added to `assets/firebaseWebConfig.js` alongside the Firebase config, plus `mapsDefaultCenter` (defaults to Da Nang centre). Requires both **Maps JavaScript API** and **Geocoding API** enabled on the same Google Cloud key; restrict by HTTP referrer of the deployed domain before shipping. If the key is empty, the page renders the list view and shows a "Add a Google Maps JS API key to enable the map" banner instead of loading the SDK.
- Nav link **Map** added to `/admin.html`, `/orders.html`, `/customers.html`, `/receivables.html`, `/deposits.html`, `/settings.html` — parity with the rest of the owner surface.
- Depends on the existing composite index `assignedDriverId + deliveryDate` in `firestore.indexes.json` (deployed for earlier work), so no new index rollout.

Shipped 2026-07-13 (trip planner + coordinates on orders):
- **Geocode-on-approval hook** in `adminApp.js` — before flipping `pending_approval → new`, the client lazy-loads Maps SDK and geocodes `order.address`, writing `deliveryLocation: { lat, lng, formattedAddress, geocodedAt }` onto the order doc. Falls back to `customer.location` when direct geocoding fails. Order edits that change the address re-geocode; owner-created orders (customerApp new-order) inherit `customer.location`.
- **`orders.deliveryLocation` field on every order** — coordinates now live on the order, not just the customer, so a customer who moves doesn't corrupt route planning for old orders. Backfill script at `firebase/src/scripts/backfillOrderLocations.js` (Admin SDK, needs unrestricted Geocoding key).
- **`settings/business.warehouse`** — new object holding the route origin `{ address, location: { lat, lng, geocodedAt } }`. Editable from a new "Warehouse (route origin)" section in `/settings.html`; saving triggers a client-side geocode.
- **`drivers/{id}.standardLoadout`** — per-driver truck capacity per container type (`glass_crate`, `18_9l_jug`, etc.). Editable from a new "Drivers & loadouts" section in `/settings.html`. Container types read dynamically from `products/*.containerType`, not hardcoded.
- **Trip planner integrated into `/map.html`** — reuses the existing driver dropdown (defaults to Matt on load via `/matt/i` name match). Below the map and pin list, a "Trip planner" panel shows a live "Ready to plan Matt's 2026-07-13 — N pinned orders demanding X crates · Y jugs" hint. "Plan trips" button (in the same toolbar row as the filters) runs the algorithm.
- **Two full-day itinerary strategies**: **A · Neighborhood clusters** (dense-cluster order, greedy-pack, 2-opt) and **B · Warehouse-out sweep** (closest-to-warehouse-first, greedy-pack, 2-opt). Each returns a sequence of trips that together cover every pinned order without overflowing loadout. Each trip: distance (haversine straight-line, tuning constant `CITY_KMH = 22` for time estimates), utilization %, ordered stop list, and an "Open in Google Maps" deep link with warehouse as origin + waypoints. SVG preview per itinerary showing all trips as colored polylines with numbered stop dots.
- **Deep-link pattern** for Google Maps navigation reused from `mapApp.js:327 renderRouteButton`.
- **Pure algorithm module** at `firebase/web/assets/routePlanning.js` — pure functions (`planItineraries`, `renderItineraryCards`, `tallyForOrders`, `itemCountsForOrder`, `humanizeContainerType`) so future pages can reuse.
- `/route.html` and `routeApp.js` were prototyped as standalone and then folded into `/map.html`; standalone files deleted.

Still open (next session, if the owner asks):
- **Distance Matrix integration** — replace haversine estimates with real Google-computed drive times + traffic. Handoff plan called this "turn 5" of route planning. Costs per element; cap request budget per plan click.
- **Pick location on map** action on `/customer.html` for addresses the geocoder can't resolve. Owner drops a pin, we save `customer.location` directly, skip geocoding for that customer.
- **Driver-side view of their own route** — auto-filter `/map.html` to `myDriverId()`. Driver auth is already wired at the rules level; need frontend role guard first (see Medium section below).
- **Live update as orders change status** — currently a static snapshot; a Firestore `onSnapshot` listener would let pins turn "out for delivery" the moment the owner clicks the button on `/admin.html`.
- **Batched geocoding via Cloud Function** — the current per-page-load geocode burns Maps API budget when addresses change. A trigger on `customers` / `orders` writes could geocode server-side and stamp `location` / `deliveryLocation`. Also insulates the Maps key from client exposure.
- **Unrestricted Geocoding key** for the Admin-SDK `backfillOrderLocations.js` script. The current `mapsApiKey` is HTTP-referrer restricted so the script can only fill from `customer.location` fallback; real geocoding needs either a second key or a temporary restriction relaxation.

## Admin dashboard workflow (shipped 2026-07-07)

State-driven action buttons on the today board — each order card only shows the actions valid for its status:

- `pending_approval`: Approve, Cancel order
- `new` (approved): assign driver dropdown, Cancel order
- `assigned`: assign driver dropdown, Send out for delivery, Cancel order
- `out_for_delivery`: Mark delivered, Cancel order
- `delivered`: read-only
- `cancelled`: read-only

Fixes:
- Assigning a driver to a `pending_approval` order no longer silently approves it (the dropdown only appears once approved).
- Marking delivered no longer requires "must be paid first" — payment tracking is intentionally decoupled from delivery.
- Hardcoded `Cash +100000` / `Transfer +100000` buttons removed. Payment recording will live in a dedicated money view.
- "Out" → "Send out for delivery". "Complete" → "Mark delivered".
- Cancel action added on every pre-delivered state; soft-cancel preserves the audit trail.

Shipped 2026-07-07:
- **Optional cancellation reason** — free-text prompt when the owner cancels an order. Stored as `cancellationReason` + `cancelledAt` on the order. Cancelled cards show the reason inline.
- **Edit order (full)** — Edit button on `pending_approval` / `new` / `assigned` cards opens a modal with editable customer name, phone, address, delivery date, delivery window, notes, **and items**. Item row has -/+/Remove buttons; new products can be added via a picker. Save runs a `writeBatch` that deletes the old `orderItems`, writes the new ones, and updates the order's `subtotal` + `depositTotal` + `balanceDue` + `paymentStatus` atomically — no partial writes.
- **Maps shortcut** — admin order card address is a link to Google Maps directions (`/dir/?api=1&destination=...`) that opens the Maps app on mobile. Bonus: phone number on the card is now a `tel:` link so tapping it dials.

Shipped 2026-07-07:
- **Customer-side cancel.** Two paths, gated by status:
  - **Pending approval** — customer sees a "Cancel this order" button on their history card. Prompted for an optional reason. Fires a direct update: `status: cancelled`, `cancellationReason`, `cancelledAt`, `cancelledBy: 'customer'`. Firestore rule enforces that this transition is only permitted from `pending_approval`.
  - **Already approved** (`new` / `assigned` / `out_for_delivery`) — customer sees a "Request cancellation" button that only writes `cancellationRequested: true` + `cancellationRequestReason` + `cancellationRequestedAt`. Status is unchanged. Rule enforces the customer can only touch those three fields.
  - The owner dashboard shows a red "Customer requested cancellation" banner on the card + two buttons: **Approve cancellation** (does the full cancel, using the customer's stored reason, sets `cancelledBy: 'owner_via_request'`, clears the request flags) or **Dismiss request** (clears the request flags, order stays active).
  - Cancelled and delivered orders can never be cancel-requested — rule blocks it.

## Current status (as of 2026-07-15)

- Firebase Firestore is the source of truth.
- Rules deployed with owner + driver role split. Public *order* creation now flows through the `submitPublicOrder` Cloud Function (browser-write path closed); public `inquiries` creation is still a direct shape-validated write.
- Composite index for `deliveryDate + status` on orders is deployed.
- Admin dashboard scoped to the selected date only (no full-collection scans).
- Sheets JSON dump imported into Firestore with date + phone normalization.
- Hosting: on the free `.web.app` URL until handover.
- **Deployed functions**: `submitPublicOrder`, `nightlyReconcileOrderMath`, `mergeCustomers`. Project is on Blaze (callables require it).
- **Customer auth**: Google popup or passwordless email link. Owner still signs in with email + password on `/admin.html`.
- **Version control since 2026-07-15.** There was none before — `.git` existed but was an empty directory, so everything up to that point survived in exactly one copy on one disk. Now `git init` + initial commit `be580bb`, pushed to the **private** repo `github.com/tymailgarcia-crypto/vietnamsparkle`. Keep it private, or restrict the Maps key first.
  - The project lives under `OneDrive\Desktop`. OneDrive and git contend over `.git` internals, which is a plausible account of how the repo got emptied. If it recurs, move the working copy outside the synced folder.
- **Tests**: `firebase/rules-tests/` — the only automated tests in the codebase. Run them before touching `firestore.rules` or `canLinkAuthUidToCustomer`.
- **Known stale artifacts**: `audit/` is a frozen partial copy of the app with pre-fix rules; [HANDOFF.md](HANDOFF.md) still reads as a pre-work brief for route planning that has since shipped. Both are recoverable from git if deleted.

## Compliance & audit

### Vietnamese tax compliance (minimal viable)

Goal: pass an accountant / tax review without special pleading, without over-building.

- **Blocker: business type is not yet known.** Rules differ sharply for:
  - `hộ kinh doanh` (household business) — simpler flat tax, no e-invoice for many cases.
  - `doanh nghiệp` (company / LLC) — VAT + e-invoice mandatory in most cases.
- Depending on the answer, we may need:
  - VAT (`thuế GTGT`) on line items — typically 10% for goods, 5% or 0% for specific water categories. Confirm which rate applies to bottled/mineral water sold as retail.
  - Tax code (`mã số thuế`) captured on the customer record when they request a VAT invoice.
  - e-invoice (`hóa đơn điện tử`) issued via an approved provider (MISA, VNPT, Viettel, FPT). Integration is per-provider.
  - Sequential invoice numbering + immutable audit log.
- The current data model already supports the ledger side: separate `payments`, `depositEvents`, `documents` collections mean the accountant can reconstruct any transaction from primary records.

Open questions:
- Which business type is the customer registered as?
- Do most customers ever ask for a VAT invoice, or is this a rare edge case?
- Preferred e-invoice provider (if any)?

### Retention & deletion policy (shipped 2026-07-08)

- **Customers cannot be hard-deleted.** Firestore rule is `allow delete: if isOwner() && resource.data.testFixture == true` on `/customers/{id}` — not the blanket `if false` this entry originally claimed. The exception exists so fixtures seeded from `/settings.html` can be cleaned up in bulk; they carry `testFixture: true` and never represent a real customer. Rationale for the rule otherwise unchanged: customer records tied to past transactions must be retained under Vietnamese commercial-record retention (5–10 years for tax review). PDPD right-to-erasure requests are honoured by anonymizing personal fields (name / phone / address / notes → placeholders) via an admin update, not by deleting the doc.
- **Orders cannot be hard-deleted.** Same shape: `allow delete: if isOwner() && resource.data.testFixture == true` on `/orders/{id}`. Rationale: orders are financial records. Voiding an order is always done via `status: cancelled` + `cancellationReason` (already wired). Hard delete would break the money ledger and violate audit retention.
- ~~**Field to add later**: `archived: boolean` on customer docs~~ Shipped 2026-07-15 as the merge tombstone. `mergeCustomers` sets `archived: true` + `mergedInto` + `mergedAt` + `mergedBy` on the source doc; `customersApp.js` filters archived docs out of the directory, and `customerApp.js` shows a banner linking to the survivor when one is opened by URL. Retention is satisfied because the archived doc is kept — only its `authUid` / `email` / `phone` are cleared (originals preserved as `preMerge*`) so it can never be re-claimed or re-matched.

### Invoice creation (deferred — 2026-07-08)

Explicitly parked. The owner wants to hold off on any invoice work until later. Notes below stay as reference so we don't re-derive them when it's picked up.

Vietnamese law (Decree 123/2020/ND-CP, Circular 78/2021/TT-BTC) requires businesses to issue **e-invoices (hóa đơn điện tử)** via a tax-authority-approved provider (MISA, VNPT, Viettel, or FPT), digitally signed and retained for **at least 10 years**. Household businesses (`hộ kinh doanh`) may qualify for simpler rules based on annual revenue threshold, but retention applies.

Two tiers of invoice to plan for:
1. **Customer receipt / business copy** — a PDF generated by our app that the customer takes home and the owner keeps on Drive. Purely informational. Doable entirely in-app.
2. **Tax e-invoice** — a signed, structured document (XML/PDF-A3) transmitted through the approved provider's API to the General Department of Taxation. Requires: business is registered with an e-invoice provider, provider gives API credentials, provider signs and forwards. Cannot be self-issued.

Data we already have that maps to invoice fields:
- Order: id, deliveryDate, subtotal, depositTotal, amountPaid, balanceDue, paymentStatus.
- OrderItems: productName, quantity, unitPrice, lineTotal.
- Customer: name, billingName, phone, taxId, address.
- Owner (config): business name, tax code (`mã số thuế`), address — need to store these once so every invoice can pull them.

MVP plan:
- Add `taxCode`, `legalName`, `registeredAddress` to a `businessProfile` config doc (single doc, `businessProfile/current`). Owner fills once.
- Build an "Issue invoice" action on completed orders that renders a PDF (jspdf or similar) with:
  - Business info header
  - Customer info block
  - Line items table
  - Subtotal / VAT (0% for now until we know the rate) / Total
  - Sequential invoice number stored on the order (`invoiceNumber`) + issued timestamp (`invoicedAt`)
- PDF gets uploaded to Firestore Storage or Google Drive, link stored on the order for future retrieval.
- Rule constraint: once an order has an `invoiceNumber`, that field becomes immutable (add to owner update guard).
- E-invoice integration is Phase 2, blocked on knowing the provider.

Open decisions before we build:
- Which provider (MISA / VNPT / Viettel / FPT / other)?
- Is VAT applicable? If yes, what rate on bottled water in Vietnam?
- Sequential numbering scheme — per-year restart (e.g., `INV-2026-0001`) or continuous?

### Data integrity

- Overpayments (negative `balance_due`) are already appearing in imported data (e.g. Ty Garcia, -2,550,000). Need a reconciliation view + a rule that flags orders where `amount_paid > subtotal + deposit_total`.
- Add server-side validation via Cloud Functions to compute `balance_due` from `payments` + `subtotal` + `deposit_total` on every mutation, instead of trusting client-computed values.

Shipped 2026-07-09:
- **Double-submit prevention across every form** via a shared `withSubmitLock(target, work, { busyLabel })` helper in `assets/shared.js`. Resolves the submit button from a submit-event's `submitter` (falls back to `form.querySelector('button[type="submit"]')`) or from a button element passed directly, disables it + swaps the label to "Saving…" / a custom busy label, runs the write, then restores in `finally` so an error keeps the form usable. Wrapped every write-path submit handler in the codebase:
  - Public order form on `/index.html` (`publicApp.js` — `submitOrder`, busy label "Submitting…"). The submit button lives outside the `<form>` and uses the `form="public-order-form"` attribute; `event.submitter` still resolves it correctly.
  - Owner-created order dialog + edit-customer form on `/customer.html` (`customerApp.js` — `saveNewOrder`, `saveCustomer`).
  - Add-customer dialog on `/customers.html` (`customersApp.js` — `handleSaveNewCustomer`).
  - Edit-order dialog + delivery-payment dialog on `/admin.html` (`adminApp.js` — `saveEditedOrder`, `saveDeliveryPayment`). The delivery-payment dialog is the highest-risk one: a double-submit would create two `payments` docs, double-count `amountPaid`, and flip `balanceDue` negative — exactly the overpayment shape we saw in imported data.
  - Record-payment dialog on `/receivables.html` (`receivablesApp.js` — `saveRecordPayment`).
  - Forfeit dialog on `/deposits.html` (`depositsApp.js` — `saveForfeit`).
  - Account page on `/account.html` (`accountApp.js`): Google sign-in button, profile-save form, and the add-address form. Non-form buttons pass the button element directly; forms pass the event. (The email sign-in / sign-up / password-reset / phone-claim handlers this originally listed were removed on 2026-07-15 with the move to email-link sign-in; the magic-link form is wrapped in their place.)
  - Settings save on `/settings.html` (`settingsApp.js` — replaces the file-local hand-rolled disable/label swap that was already there).
- Owner-side action buttons that fire via `prompt()` / `confirm()` (approve order, cancel order, assign driver, approve/dismiss cancellation request) are NOT wrapped: the modal blocks the UI thread so a second click cannot land before the write starts. Same for customer-side cancel / request-cancel buttons on `/account.html`.

## Inventory & product operations (ERP-lite, not started)

Goal: replace the ad-hoc "check the storage room and reorder" workflow with a proper inventory system. Track what we have, what we've sold, what we paid suppliers, and what our real margin is per SKU.

### Product catalog upgrades

Current `/products/{id}` has: `productName`, `category`, `containerType`, `unitLabel`, `unitPrice`, `defaultDepositAmount`, `active`, `notes`.

Add:
- `costPrice` — what we pay the supplier per unit today.
- `weightedAverageCost` — running average as purchases at different prices come in. Updated on every recorded purchase.
- `reorderThreshold` — trigger a "time to buy" notice when `onHand` drops below this.
- `supplierId` — link to the supplier directory.
- `sku` — internal stock-keeping code (may differ from the productId if we ever change catalog structure).

### Inventory tracking

New `/inventory/{productId}` collection — one doc per SKU:
- `onHand`: current physical count.
- `reserved`: allocated to accepted-but-not-yet-delivered orders.
- `available`: computed `onHand - reserved`.
- `lastCountedAt`: manual stock-take timestamp.
- `lastAdjustmentAt`: last movement time.

Every mutation writes to `/inventoryMovements/{id}` for the audit trail:
- `productId`, `qty` (positive = in, negative = out), `reason` (`purchase` / `sale` / `damage` / `stock_take_adjustment`), `linkedOrderId` or `linkedPurchaseId`, `at`, `by`.

Automatic flows:
- Order goes `assigned → out_for_delivery`: increment `reserved` by the ordered qty.
- Order marked `delivered`: decrement `onHand` and `reserved` (net effect: available unchanged, on-hand goes down); write a `sale` movement linked to the order.
- Order `cancelled` after being reserved: decrement `reserved`.
- Purchase recorded: increment `onHand`; write a `purchase` movement. Recompute `weightedAverageCost` on the product doc.
- Owner does a stock-take: enters a new `onHand` value; system writes an `adjustment` movement equal to the delta.

### Suppliers

New `/suppliers/{id}` — `name`, `phone`, `address`, `contactPerson`, `defaultPaymentTerms`, `notes`. Referenced from products and purchases.

### Purchases (mirror the Sheets collection into Firestore)

`/purchases/{id}` already exists from the Sheets import. Add owner-facing UI for creating and listing purchases:
- `/purchases.html` — dense list similar to `/orders.html` with search, date-range filter, supplier filter.
- **Create purchase** dialog on `/supplier.html?id=<id>` (once suppliers exist), OR standalone. Picks the supplier, adds line items (product + qty + unitCost), computes total, creates a purchase doc, and fires the inventory increment + weighted-average recompute atomically via `writeBatch`.

### Analytics / reporting

Owner dashboard page: `/reports.html`:
- **Best sellers** — top SKUs by units sold in the selected period (7d / 30d / 90d).
- **Slow movers** — SKUs with low turnover (`unitsSold / averageOnHand`).
- **Margin per SKU** — `(unitPrice - weightedAverageCost) × unitsSold` per period.
- **Reorder queue** — products where `onHand ≤ reorderThreshold`, sorted by urgency.
- **Cash tied up in stock** — Σ `onHand × weightedAverageCost` per SKU.
- **Deposit float** — total container deposits currently outstanding (data already there, needs a tile).
- **Spend per supplier per month** — aggregated purchases.

### UI plan

New admin pages:
- `/inventory.html` — dense list per product: on-hand, reserved, available, threshold status pill (OK / low / out), cost, retail price, computed margin, sold-last-30-days. Row action: **Stock take** (owner enters counted qty → writes adjustment movement).
- `/suppliers.html` — supplier directory with the same table pattern as `/customers.html`.
- `/supplier.html?id=<id>` — supplier profile with editable details, active products for this supplier, and a purchase history list.
- `/purchases.html` — purchases list + create action.
- `/reports.html` — analytics.

### Firestore rule outlines

- `/inventory/{productId}` — owner read/write. Driver read-only. Customer no access.
- `/inventoryMovements/{id}` — owner read/write. Immutable after write (only insert-append). Customer no access.
- `/suppliers/{id}` — owner read/write. Customer no access.
- `/purchases/{id}` — owner read/write. Driver read for the "how much am I carrying today" case. Customer no access.

### Open questions

- Single storage location (garage / shop) or multi-location from day one?
- Do drivers count as separate locations (containers assigned to driver truck) or is inventory only at the warehouse?
- How is stock currently tracked (notebook, whiteboard, nothing)? The migration path depends on this.
- Are there SKUs with sub-units that matter (e.g. individual bottles inside a crate)? Currently everything is treated as one "unit" via `unitLabel`.
- Do we need per-batch tracking (production date on jugs) or is one bottle same as another for our purposes?

### Rough phasing

1. **Phase 1**: add `costPrice` field to products; add `/inventory/{productId}` with manual `onHand` entry. Show current stock on the product catalog. No automatic flows yet.
2. **Phase 2**: automatic decrement on `delivered` orders + increment on recorded purchases. Weighted average cost. `inventoryMovements` audit trail.
3. **Phase 3**: `/inventory.html` page with reorder-threshold alerts. `/suppliers.html` + `/purchases.html`.
4. **Phase 4**: `/reports.html` with best-sellers / slow-movers / margin.
5. **Phase 5**: multi-location (only if needed).

## Customer records

### Indexing & lookup

Goal: type any of name / phone / email / address fragment and find the right customer in <1 second. Once found, be able to view, edit, and append notes without leaving the dashboard.

Shipped 2026-07-07:
- **`/customers.html`** — dedicated dense-list directory page. Table layout (name / phone / email / area / address / last order / order count / notes preview) with search, area filter, and sort dropdown.
- **`/customer.html?id=<customerId>`** — single-customer profile page. Editable name, phone, email, billing name, tax ID, area, address. Notes textarea with **Append dated note** (prepends `[YYYY-MM-DD HH:mm] <text>`). Order history list showing every order for this customer, each with a clickable order status pill.
- **Client-side substring search** across name, billing name, phone, secondary phone, email, address, area — no Firestore query per keystroke. Fine up to a few thousand customers.
- **Customer names in order cards on `/admin.html` are clickable** — they link to `/customer.html?id=<customerId>` so the owner jumps straight to that person's profile without leaving the dashboard flow.

Still open (future):
- Denormalized `nameTokens: string[]` + `phoneNormalized` for server-side search when the list grows past a few thousand.
- External search (Algolia / Typesense) if we ever pass 10k customers.
- Bulk-merge legacy customer duplicates (same phone imported as multiple docs).

### Order lookup

Goal: find any past order by order ID, customer name, phone, address fragment, or delivery date range.

Shipped 2026-07-07:
- **`/orders.html`** — dedicated dense-list page. Table columns: Delivery, Order ID, Customer (link to profile), Phone (`tel:`), Status pill, Payment pill, Subtotal, Balance, "Open on board" link.
- **Filters**: search input (substring on order ID / customer name / phone / address), status dropdown, from/to date range on `deliveryDate`, sort by delivery or created date (asc/desc). All client-side over a single load of the orders collection.
- **"Open on board"** navigates to `admin.html?date=<deliveryDate>` — the today board's `selectedDate` is initialised from that param, so the owner lands on the right day's board and can use the existing Edit / Approve / Cancel / Send-out / Mark-delivered actions.
- Nav links between `/admin.html` ↔ `/customers.html` ↔ `/orders.html` so all three owner pages are one click apart.

Still open (future):
- Bounded fetch + "load more" pagination once the collection grows past a few thousand orders.
- Composite index for `(status, deliveryDate)` + `(deliveryDate DESC)` for server-side filtering.
- Direct edit-on-row from the orders list (currently requires the "Open on board" hop).

### Container / deposit accountability

Goal: at any moment the owner can see per-customer: how many glass crates / 19 L jugs / 20 L jugs are currently in the customer's possession, and the deposit money outstanding for each.

- Already have `depositEvents` (charged/refunded/credited) and `returns` (with `container_type`, `qty`, `condition`).
- Need a materialized per-customer view: `sum(deposit charged) - sum(deposit refunded/credited)` by container type, `sum(qty out) - sum(qty returned)` by container type.
- Surface this on the Customers tab as "outstanding containers" + "deposit balance".
- Flag customers holding containers > 60 days as follow-up.

Open decisions:
- **What happens when the driver does not pick up empties on a delivery?** Current model: deposit stays outstanding, no auto-refund. The system can't infer "customer expected pickup but driver forgot" from raw data — we only know what was actually logged. Options:
  1. **Explicit driver pickup log** — driver marks "collected N empties of type X" alongside "delivered". No log ⇒ no return event ⇒ deposit stays. Clean, requires the driver flow.
  2. **Customer-side flag** — customer taps "please pick up my empties" on the next order; owner sees the flag next to that delivery on the today board.
  3. **Reminders** — after N days holding a container, nudge the customer to schedule a return / next order. Non-invasive.
- Decision blocker: we don't yet have a driver-side UI in the Firebase build (only rules-level access). Option 1 needs that first.

### Payment status & receivables

- Every order already has `balance_due` + `payment_status`.
- Missing: aged receivables view (0–7 days, 8–30 days, 30+ days).
- Missing: reminder workflow (send WhatsApp / Zalo message from the dashboard with pre-filled body + total due).

## Growth & retention

### Buying behavior insight

Goal: understand each customer's rhythm well enough to prompt a reorder before they run dry.

- Per customer, compute:
  - Average days between orders (cycle length).
  - Most-purchased SKU + quantity per order.
  - Predicted next-order date.
- Show "due soon" list on the today board: customers whose predicted next order falls in the next 3 days.
- Aggregate view: top 20 customers by revenue, by frequency, by deposit exposure.

### Recurring / subscription orders

Goal: let a customer say "same order every Monday" from the public form and never touch it again.

- Add a `subscriptions` collection: `customerId`, `items[]`, `cadence` (weekly / biweekly / monthly), `nextDeliveryDate`, `active`.
- Scheduled Cloud Function runs daily, materializes any due subscription into a real `orders` doc in `pending_approval` status.
- Owner approves as usual — no bypass of the audit trail.
- Public form gets a "Make this a repeating order" toggle.

## Customer-facing experience

### Visual redesign of the public site

Goal: the customer-facing site (index.html + account.html) should look like it belongs to the same business as the eventual customer's own brand. The current design is functional but generic.

Shipped 2026-07-13 — **danangwater.com flavor pass**:
- Palette swap across every page via the shared design tokens in [firebase/web/assets/styles.css](firebase/web/assets/styles.css): brand `#0b7a63` (green) → `#1b68e9` (blue) to match danangwater.com; sun-yellow primary CTA → blue primary; sand gradient background → soft blue-tinted white. Semantic status colors (`.status-*`, `.pay-*`) left green/yellow/red on purpose.
- Typography swap: Georgia serif → Inter (Google Fonts import at the top of `styles.css`). Inputs forced to `font-size: 16px` unconditionally so iOS Safari stops auto-zooming on focus.
- Real product photos in the public order catalog, keyed by product-name regex in `PRODUCT_IMAGE_MATCHERS` inside [firebase/web/assets/publicApp.js](firebase/web/assets/publicApp.js) — Danh Thanh, Thach Bich (glass + jug), Vikoda (still + 20L), Glassia, Uni, plus extras. Broken URLs degrade silently to the tinted placeholder via `onerror`. Hero-photo lockup and header logo added on the customer form.
- Deploy: `firebase deploy --only hosting` from `firebase/`. Live at https://vietnamsparkle-36dfe.web.app/.

Follow-up worth doing:
- **Rehost the product images.** They are currently hot-linked from `danangwatercom.swipepages.media` (the owner's CDN). Mirror them to Firebase Storage or Hosting so the site doesn't break if that CDN moves. Update `PRODUCT_IMAGE_MATCHERS` URLs after upload.
- **Wire images via Firestore, not regex.** Add an `imageUrl` field on `products/*` docs so the owner controls each thumbnail from the settings/products admin instead of us maintaining a name-matching table. `PRODUCT_IMAGE_MATCHERS` would become a fallback for docs where `imageUrl` is empty.

### Public order form

Goal: for a new customer, form is fast and clear; for a returning customer, form is one tap.

- Current form is functional but plain. Improvements to consider:
  - Item cards with images (glass bottle photo, jug photo).
  - Delivery windows as chips, not a text field.
  - Address autocomplete via Google Places (Da Nang scoped).
  - Trust cues: "already delivered X orders this month" or similar.

Shipped 2026-07-07:
- **Phone field now digit-validated.** HTML `pattern="(?=.*\d)[+0-9 ()\-]{6,40}"` on `type=tel` inputs in `/index.html` and `/account.html`, mirrored in `firestore.rules` (`isPublicOrderShape` regex on `d.phone`). A scripted client can't bypass it either.
- **Contact channels visible in the hero.** WhatsApp / Zalo / Facebook buttons at the top of `/index.html`, always one tap away. URLs hardcoded to placeholders for now — change them once at handover.

Shipped 2026-07-07 (part 2):
- **Sticky totals bar on mobile** — under 760 px, the totals panel sticks to the bottom of the viewport with a compact 3-column layout so the running subtotal, deposit, and due amount are always visible while scrolling the catalog. Desktop unchanged.
- **Denser mobile catalog + extras expander** — each catalog column renders as a 2-col grid on mobile with compact cards (smaller padding, 32 px qty buttons, 13 px font). The "Extra items" category is wrapped in a `<details>` element, collapsed by default so the primary glass + jug catalogs are what customers see first. Desktop unchanged.

### Customer accounts (self-serve)

Goal: returning customers sign in once, then reorder with prefilled fields.

- Login model (since 2026-07-15): **Google popup** OR **passwordless email link**. Email + password was removed from the customer surface — the owner still uses it on `/admin.html`, so the Email/Password provider stays enabled in the console. Both customer methods produce the same Firebase Auth `uid`, so downstream code and rules don't care which was used.
- Both methods set `email_verified: true` automatically, which is what makes the verified-email requirement in the customers rules free of friction. Any future sign-in method must preserve that, or legacy-profile claiming breaks.
- Customer identity is the Firebase Auth `uid`; each customer doc stores `authUid` and is looked up by that field.
- Firestore rules carry a `customer` tier that lets a signed-in user read/write only the customer doc where `authUid == request.auth.uid` and read only orders where `authUid == request.auth.uid`.

Shipped 2026-07-07:
- `/account.html` with Google + email-password sign-in, "create account", and password reset. **Superseded 2026-07-15** — password sign-in, sign-up, and reset were removed from the customer page in favour of the email link.
- Editable profile (name, phone, address, area, notes).
- Order history with per-order status pill AND payment status pill (paid / partial / unpaid).
- One-tap reorder: `/account.html` order card → **Reorder** → `/index.html?reorder=<orderId>` → items preselected with original quantities so the customer only has to confirm and submit.
- `authUid` stamped on new orders, order items, deposit events, and payments so history, reorder, and container accountability all work under rules.
- Prefill of `/index.html` form when signed in.
- **Containers you hold** panel on `/account.html` — aggregates deposit charges minus returns per container type (glass crates, jugs, etc.) with the deposit amount currently held.

Still open:
- Active subscriptions view.
- ~~Legacy customer docs from the Sheets import have no `authUid`… A small admin merge tool would fix this without a bulk migration.~~ Shipped 2026-07-15 — the merge tool exists, and the email path auto-links legacy docs that carry the customer's email. Legacy docs with **no** email still need a manual merge.
- **Customer-facing status vocabulary.** Shipped 2026-07-07: `humanizeOrderStatus` in `accountApp.js` maps `pending_approval` → "Waiting for confirmation", `new` → "Confirmed — being prepared", `assigned` → "Being prepared", `out_for_delivery` → "On the way", `delivered` → "Delivered", `cancelled` → "Cancelled". Owner dashboard still uses the internal names for precision.
- **Optional cancellation reason from the customer side.** If we let customers cancel their own pending order (not built yet), the cancel action should prompt for a reason. Owner-side cancellation reason is tracked separately under Admin dashboard workflow.

### Payments (QR)

Goal: customer pays via VietQR at the doorstep, driver marks paid, everyone's happy.

- VietQR is the Vietnam banking standard — QR codes with amount + bank account + reference pre-embedded. Any local bank app scans and pays.
- Two levels:
  - **Static QR** — one merchant QR reused, customer types amount. Cheap, no per-order flow.
  - **Dynamic QR** — one QR per order with amount + reference already filled. Auto-reconciles.
- Dynamic QR requires either:
  - A VietQR image generator (there are open source ones — no bank API).
  - A bank/PSP integration for auto-reconciliation (MB Bank, Techcombank, ACB, Vietcombank, or intermediaries like Payoo / VNPay / MoMo / ZaloPay).
- MVP: generate a dynamic QR per order client-side, driver taps "Payment received" after confirmation, dashboard records a `payment` row.
- Add reconciliation later if bank feeds are available.

Open questions:
- Which bank does the business use?
- Would they use MoMo / ZaloPay in addition to bank QR?

Next concrete step (prioritized): ship MVP dynamic VietQR per order.
- Client-side QR generation using the VietQR spec (merchant bank BIN + account number + amount + reference/order ID). No bank API needed for display; owner reconciles manually from the bank app.
- Add a "Show QR" button on the admin dashboard order card AND on the customer's account order card so either side can pull it up on the doorstep.
- Store bank details (BIN, account number, account name) in a config doc / env, not hardcoded in source, so handover-to-customer is a one-value swap.

## Handover to customer

Everything above needs to eventually be picked up by the customer's own team / Firebase project. Notes:

- Current Firebase project is under `tymailgarcia@gmail.com`.
- Two clean handover paths:
  1. Transfer project via Firebase Console → Users and permissions → add customer as Owner → they take billing → we downgrade to Viewer or leave.
  2. Rebuild in customer's own project: swap `src/config/firebase.web.js` + `.firebaserc`, re-deploy rules/indexes/hosting, re-run `import:sheets` and `set:claims`.
- Handover deliverables to write before that day:
  - `HANDOVER.md` — step-by-step for the customer.
  - Rotated service account (customer generates their own).
  - Rotated Auth passwords.
  - Custom domain instructions for their preferred registrar.

## Audit follow-ups (2026-07-09)

Third-party review flagged nine correctness/security issues + four scale bottlenecks. Reviewed and largely accepted; ranked below by priority. Nothing here is "just polish" — every item is either a bug affecting real data or a security concern under adversarial input.

### Critical — fix in the next work session

- ~~**Duplicate customer identity across entry points.**~~ Shipped 2026-07-14, **partially reverted 2026-07-15 — read this before touching `upsertCustomerFromOrder`.** Canonical `resolveCustomerId({ uid, phone })` in [firebase/web/assets/shared.js](firebase/web/assets/shared.js) — always prefers phone-based `CUS-<E164 digits>`, falls back to `CUS-<uid>` only when the caller has no phone. Wired into `buildOrderPayload` in [firebase/web/assets/publicApp.js](firebase/web/assets/publicApp.js) so a signed-in customer whose account was minted as `CUS-<uid>` still routes new orders onto the phone-keyed canonical doc. `findOrAutoLinkCustomer` in [firebase/web/assets/accountApp.js](firebase/web/assets/accountApp.js) grows a third `findUnclaimedByPhone` path so a `user.phoneNumber` sign-in (future phone-auth) collapses into the canonical doc instead of minting `CUS-<uid>`.

  **The part that was reverted, and why it must not come back.** This entry originally shipped `upsertCustomerFromOrder` linking `authUid` on approval "**only when the phone-keyed doc is unclaimed** OR already claimed by the same uid". That unclaimed branch was an account takeover, removed 2026-07-15. Nothing proves the person typing a phone number into the public order form owns that number. An attacker signs in with any account, places an order quoting a stranger's phone, and the owner's routine approve stamps the attacker's `authUid` onto the stranger's record — handing over the profile and, through the orders claim rule, the full order history. Every customer who has never signed in was a target, and the ones with the most history were the most valuable. Firestore rules cannot catch it: the owner performs the write, and owners may write anything.

  It was not an accident — auto-attaching on approval is precisely what kept duplicates from forming, which is what this roadmap entry set out to fix. Removing it brought the duplicate problem back, so `foldSelfServeStubInto` replaced it (see "Customer identity, merge, and auth" below). The guard now lives in `canLinkAuthUidToCustomer` in [firebase/web/assets/adminApp.js](firebase/web/assets/adminApp.js), pinned by a truth-table test at [firebase/rules-tests/authuid-linking.test.mjs](firebase/rules-tests/authuid-linking.test.mjs). **If a future change makes that test fail, the takeover is back. Do not "fix" the test.**

- ~~**Customer claim-from-browser is broken by rules.**~~ MVP fix already in place. `findUnclaimedByPhone` was removed; rules were later widened to `allow read: if isCustomer() && resource.data.authUid == null && resource.data.email == request.auth.token.email` so `findUnclaimedByEmail` in [firebase/web/assets/accountApp.js:88](firebase/web/assets/accountApp.js:88) succeeds against unclaimed docs whose email matches the caller's Firebase Auth email. Production Cloud Function version still worth doing for the phone-only path (owner-created customer without email) but no longer critical — email path covers the common case.

- ~~**XSS in owner dashboard.**~~ Shipped 2026-07-13. Audited every innerHTML template in `adminApp.js`, `publicApp.js`, `invoice.js`, `accountApp.js`, `customersApp.js`, `mapApp.js`, `routePlanning.js`, `receivablesApp.js`, `depositsApp.js`, `settingsApp.js`, `ordersApp.js`, `customerApp.js`. Findings: order-card rendering was already properly escaped in the main danger spots (`renderOrderCard` / `renderOrderCompact`); WhatsApp/mailto pre-fill templates go through `encodeURIComponent`. **Real bug found in [firebase/web/assets/mapApp.js:388](firebase/web/assets/mapApp.js:388)** (the trip-planner hint I added last week interpolated `${driver.driverName}` raw into innerHTML); fixed. **Weak `escapeAttr` in `publicApp.js`** (only escaped `&` and `"`) replaced with the shared `escapeHtml`; the local duplicate function deleted. Firebase-Auth email format constraints made that path a self-XSS only, but the fix is trivial.

- ~~**Vietnam local date bug.**~~ Already shipped — `todayKey()` in [firebase/web/assets/shared.js:10](firebase/web/assets/shared.js:10) uses `getFullYear` / `getMonth` / `getDate` (browser locale). Roadmap entry was stale.

### High — schedule after critical

- ~~**Partial-payment edit flow silently rules-fails.**~~ Shipped 2026-07-13. `paymentStatusFor` in [firebase/web/assets/shared.js:172](firebase/web/assets/shared.js:172) is now a three-branch `(amountPaid, balanceDue) → paid | partial | unpaid`. All callers pass both args (`publicApp.js:156`, `settingsApp.js:501`, `customerApp.js:376`, `adminApp.js:780`). Inline duplicates in `adminApp.js:1015` (delivery-payment recompute) and `receivablesApp.js:280` (record-payment recompute) consolidated to call the shared helper.

- ~~**Deposit ledger accuracy.**~~ Shipped 2026-07-13. All three stacked bugs fixed:
  1. **Per-container-type charges** now via `computeDepositBreakdown(items, productsById)` in [firebase/web/assets/shared.js](firebase/web/assets/shared.js). `ensureDepositCharge` in `adminApp.js:134` and the customer-new-order write in `customerApp.js:395` both emit one `charged` event per unique `containerType` in the order — no more `containerType: "mixed"`.
  2. **Correct qty per event** — products with empty `containerType` or zero `defaultDepositAmount` (accessories, straws) are excluded from the breakdown, so qty reflects only returnable containers.
  3. **Edit + cancel emit compensating events** — `saveEditedOrder` diffs the new items' breakdown against the order's existing charged-minus-refunded per-type net and emits a `charged` event for positive deltas or a `refunded` event for negative deltas (all inside the same writeBatch as the order update). `cancelOrder` and `approveCancellationRequest` call a new `emitDepositReversalsFor(orderId, order)` helper that re-reads all `depositEvents` for the order and emits `refunded` events for any remaining outstanding-per-type balance.
  4. Legacy "mixed" events get zeroed out naturally as the new per-type charges land on the same order via edit or cancel; no data migration needed.
  5. Aggregation code in `depositsApp.js`, `accountApp.js`, and the delivery dialog was already treating `refunded/credited/forfeited` as subtractions from `charged`, so no downstream changes required.

- ~~**Public order server-side re-pricing.**~~ Shipped 2026-07-13. First Cloud Function in the codebase: [firebase/functions/index.js `submitPublicOrder`](firebase/functions/index.js) — HTTPS callable on Node 22, us-central1, max 10 instances. Validates the customer payload shape (name/phone/address/deliveryDate patterns and lengths), reads canonical product docs from Firestore server-side, rejects any productId that isn't `active === true`, computes subtotal + deposit from `products/*.unitPrice` and `defaultDepositAmount` only. Client-supplied `unitPrice` is now ignored. Writes order + orderItems atomically via Admin SDK batch, returns `{ orderId }`.
  - **Client**: `publicApp.js.submitOrder` now calls `httpsCallable(functions, "submitPublicOrder")({ items: [{productId, quantity}], customer })`. No more `writeBatch` or `serverTimestamp` in the public form.
  - **Rules tightened**: `isPublicOrderShape` + `isPublicOrderItemShape` deleted; `orders/*.allow create` is now `isOwner() && orderMathValid()` only, `orderItems/*.allow create` is `isOwner()`. The browser-write path is closed — public orders land only via the Admin-SDK function.
  - **Lazy admin init**: `initializeApp()` runs inside the handler on first call, not at module scope, so CLI discovery doesn't time out on Windows.
  - Cost: project is now on Blaze (required for callable functions).

- ~~**Transactions for payment writes.**~~ Shipped 2026-07-13. `saveDeliveryPayment` in [firebase/web/assets/adminApp.js](firebase/web/assets/adminApp.js) and `saveRecordPayment` in [firebase/web/assets/receivablesApp.js](firebase/web/assets/receivablesApp.js) both now use `runTransaction(db, async (tx) => …)`. The transaction re-reads the order fresh every retry, so `newAmountPaid = order.amountPaid + amount` is computed against the freshest Firestore value — two concurrent tabs can no longer race and silently overwrite each other. All DOM inputs are snapshotted into a plain-object payload BEFORE the transaction opens, so retries don't leak stale UI values. Payment doc + order update (+ any container-return / loss deposit events for the delivery flow) all land in the same transaction, so partial writes aren't possible either.

### Medium — right time is after inventory phase 1

- ~~**Frontend role guard.**~~ Shipped 2026-07-13. `requireRole(user, role)` helper in [firebase/web/assets/shared.js](firebase/web/assets/shared.js) reads `user.getIdTokenResult().claims.role`; if wrong role, redirects to `/account.html` (with a same-page-loop guard). Wired into every owner page's `onAuthStateChanged` handler right after the `!user` branch: adminApp, customerApp, customersApp, ordersApp, mapApp, receivablesApp, depositsApp, settingsApp. A signed-in customer navigating to `/admin.html` now redirects immediately instead of watching the shell load then fail with permission-denied errors. Rules still enforce security; this only fixes UX.

### Scale bottlenecks — parked until we hit them

- **Full-collection loads.** `/orders.html`, `/customers.html`, `/deposits.html`, `/receivables.html` load whole collections client-side. Fine to ~5k orders / ~2k customers on modern connections. Fix later with indexed pagination (`orderBy(deliveryDate).limit(50)` + `startAfter` cursor) and a normalized `phoneNormalized` field on customers for server-side phone search.
- **Deposit / receivables recomputed every load.** Summary docs `depositBalances/{customerId_containerType}` and `orderReceivablesSummary/aggregate` updated by Cloud Function triggers on `depositEvents` / `payments` writes. Removes the O(all-events) client-side aggregation.
- **Browser-side geocoding.** Currently the map page geocodes missing addresses on load and caches on the customer doc. Fine at current volume. Long-term: Cloud Function trigger on customer writes that geocodes server-side. Also insulates the Maps API key from client exposure — right now the domain-restricted key sits in `firebaseWebConfig.js` (public JS). Domain restriction limits abuse but doesn't zero it.

### Points where I pushed back on the audit

- **On #3 (public order trusts browser)**: original audit called this "one of the most important production fixes". I downgraded to medium because the owner-approval gate catches spoofed prices before they become money. Still worth doing, but not the fire drill the audit implied.
- **On #5 (transactions vs batches)**: original called it a source of drift. Real, but the window is small for a one-owner shop. Medium priority.
- **On #8 (role handling)**: original framed this as impact-heavy. It's UX-only — rules enforce security. Medium priority.

## Parking lot

Ideas not yet triaged. Move up into the right section when they mature.

- Driver mobile app / driver-scoped view (already partially enabled by role rules — no UI yet; see also the "Driver-side view of their own route" open item under Delivery map).
- Multi-language: Vietnamese + English toggle on public form.
- Push notifications for owner (new order arrived, payment overdue).
- Inventory tracking (real stock counts, not just purchase log).
- Supplier reorder reminders (when purchased qty over a period drops below threshold).
- SMS / Zalo / WhatsApp auto-messages on order confirmed and out-for-delivery.
- Loyalty / referral credits.
- Weather-aware demand hints (hot days → jug demand ↑).
- Print-friendly delivery slip per order for accompanying the delivery.

## How we use this doc

- When we start a new work session, skim relevant section, decide the next milestone.
- When a decision gets made (business type, bank choice, QR provider), write it into the section body and delete the open question.
- When something ships, add a `Shipped 2026-MM-DD: <one line>` bullet under the relevant section.
- When an idea in Parking Lot matures, move it up and delete the placeholder.
- Don't over-plan. This is a scratchpad, not a spec.

# Handoff — Route planning feature

Previous session shipped the danangwater.com flavor pass + product photos on 2026-07-13 (see ROADMAP.md under "Visual redesign of the public site"). Everything else prior is documented in ROADMAP.md. Nothing else to carry forward.

## Session goal

Build a **route planning** feature so a driver can pick the day's approved orders, get **2–3 recommended routes** ranked by distance/time and by capacity fit against the driver's loadout, and one-tap open the winning route in Google Maps.

Why now: driver currently guesses stop order in their head and the owner assigns orders one-by-one with no capacity check. Wasted fuel, missed capacity, and no way to know if the truck can hold the day's list before the driver leaves.

The feature intentionally keeps the routing math on the client and hands the final drive-time turn-by-turn to Google Maps via a deep link (same pattern already used on `/map.html`). No new backend service, no Cloud Functions.

## Live URLs the work will land on

- New: https://vietnamsparkle-36dfe.web.app/route.html (route planner, driver-facing but also owner-usable)
- Edited: /settings.html (warehouse address + per-driver loadout editor), /admin.html (link to route planner from the today board)
- Deploy: `cd firebase && firebase deploy --only hosting` (see `firebase.json` — hosting is scoped to `web/`)

## What already exists you can reuse — do NOT rebuild

**Coordinates on customer docs.** The map page geocodes addresses on demand and caches `location: { lat, lng, formattedAddress, geocodedAt }` back onto the customer doc. See [`backfillMissingLocations` at firebase/web/assets/mapApp.js:420](firebase/web/assets/mapApp.js:420). This is the ONLY existing lat/lng plumbing in the app. **Read the pattern before writing anything new** — the routing feature should extend it, not replace it.

**Deep-link handoff to Google Maps navigation.** [`renderRouteButton` at firebase/web/assets/mapApp.js:327](firebase/web/assets/mapApp.js:327) builds a `https://www.google.com/maps/dir/?...` URL with waypoints. Copy this into `routeApp.js` for each of the 3 recommended routes — no Directions-API rendering required.

**Google Maps API key** is already deployed and domain-restricted at [firebase/web/assets/firebaseWebConfig.js:17](firebase/web/assets/firebaseWebConfig.js:17) (`mapsApiKey` + `mapsDefaultCenter` for framing). If you decide to call Distance Matrix (see decision #2 below), enable it in the Google Cloud console for the same key.

**Filter controls.** `map.html` has the exact `dateFrom` / `dateTo` / `driverFilter` / `statusFilter` control pattern the planner needs — copy the markup and the small handler wiring, don't reinvent.

**Design tokens.** The blue palette + Inter + 16px inputs + `.button.primary` all live in [firebase/web/assets/styles.css](firebase/web/assets/styles.css) after the 2026-07-13 flavor pass. Route cards should feel like the other cards on the site.

**Utility helpers in [firebase/web/assets/shared.js](firebase/web/assets/shared.js)**: `formatCurrency`, `todayKey` / `localDateKey`, `escapeHtml`, `buildOrderId('RUN')` for run IDs, `withSubmitLock` for any write button, `computeOrderTotals`. Use these — don't reimplement.

**Driver assignment already exists.** [`assignDriver` at firebase/web/assets/adminApp.js:213](firebase/web/assets/adminApp.js:213) flips `assignedDriverId` on an order and toggles status `new` ⇄ `assigned`. The planner only needs to READ this field to know which orders belong to which driver — no changes to assignment flow in phase 1.

## Data model additions

### `drivers/{driverId}.standardLoadout`

Object keyed by product `containerType` (which is what `products/*` docs already use):

```
standardLoadout: {
  glass_crate: 20,      // full 20-bottle crates the truck holds
  "18_9l_jug": 8,       // 18.9L jugs
  "19l_jug": 8,
  "20l_jug": 6,
  unit: 30              // accessories / addons
}
```

Editable from `/settings.html` under a new "Drivers & loadouts" section. Read at the top of `routeApp.js` alongside orders. Rules must allow the driver to read their own doc (currently drivers are readable to owner-only — check [firestore.rules](firestore.rules)).

### `settings/business.warehouse`

New object on the existing settings doc (leave `registeredAddress` alone — it's free text on the invoice header):

```
warehouse: {
  address: "12 Nguyen Hue, Da Nang",
  location: { lat: 16.0544, lng: 108.2022, geocodedAt: "2026-07-13T04:00:00Z" }
}
```

Geocoded once on save via the existing `google.maps.Geocoder` used in `mapApp.js`. This is the origin every route starts and ends at.

### `orders/{orderId}.deliveryLocation`

Currently orders only have free-text `address`. The map page opportunistically geocodes and stashes on the CUSTOMER doc, but that leaves orders themselves with no coordinate — bad for routing because a customer can move.

Add `deliveryLocation: { lat, lng, geocodedAt }` written at approval time. Hook: [`approveOrder` in firebase/web/assets/adminApp.js`](firebase/web/assets/adminApp.js) (grep for `pending_approval` → `new` transition). Before flipping status, geocode the address and stash the result. Fall back to `customer.location` if geocoding fails.

Also needed: a **one-off backfill script** at `firebase/src/scripts/backfillOrderLocations.js`, mirroring the shape of the existing [firebase/src/scripts/importSheetsJson.js](firebase/src/scripts/importSheetsJson.js). Uses the Admin SDK to iterate all orders where `deliveryLocation` is missing and geocode server-side. Run once with `node firebase/src/scripts/backfillOrderLocations.js`.

### `runs/*` — DO NOT BUILD IN PHASE 1

A snapshot of an accepted route (driver, date, ordered stops, per-stop timestamps, loadout used) is worth building, but only after phase 1 proves the planner is useful. The phase-1 planner is stateless: pick orders → compute → open in Maps. If Ty asks for run history / audit later, add the collection then.

## UI shape

### New: `/route.html` + `/assets/routeApp.js`

Layout (mobile-first — driver uses this on a phone in a moving vehicle):

1. **Top strip**: driver `<select>` (defaults to the signed-in driver's own name if auth is wired that way; otherwise the owner picks), date `<input type="date">` (defaults today).
2. **"Today's orders" panel**: reads orders where `deliveryDate == picked date` AND `assignedDriverId == picked driver` AND `status ∈ {new, assigned, out_for_delivery}` (mirror the "approved" filter default from `mapApp.js`). Renders as a compact list — customer name, address, container-count summary — with a checkbox per row. Default: all checked. Show a running "Selected: X orders / Y crates / Z jugs / …" tally below the list.
3. **Loadout row**: shows the driver's `standardLoadout` as read-only chips. A collapsible "Override for this run" section lets the driver bump each type up or down. Overrides live only in memory for the current planning session.
4. **Big "Plan route" button**. Disabled if any container type overflows loadout (highlight the overflowing chip red).
5. **Results panel** (renders below the button after compute): 3 route cards labeled **A / B / C**, each showing:
   - Weighting label ("Shortest distance", "Fastest time", "Best capacity fit")
   - Total distance (km), total time (min), utilization % per container type
   - Ordered stop list (1. Nguyen Hue, 2. …)
   - "Open in Google Maps" button — reuse `renderRouteButton` pattern

### Edited: `/settings.html` + `/assets/settingsApp.js`

Two new sections:
- **Warehouse** — single text input for address + "Save" button that geocodes and stores `settings/business.warehouse.{address,location}` in one `writeBatch`.
- **Drivers & loadouts** — one card per active driver. Number inputs per `containerType`. Save writes the whole `standardLoadout` object back onto the driver doc via `updateDoc`. Wrap the save in `withSubmitLock`.

### Edited: `/admin.html`

One link on the today-board hero: "Plan today's routes →" pointing to `/route.html?date=<today>&driver=<owner>`. Keep it small; the planner is a driver-first surface.

## Algorithm sketch

The planner runs client-side in `routeApp.js`. Two tiers so we spend Distance Matrix quota carefully:

**Tier 0 — capacity feasibility (free, ~O(N))**
For each candidate permutation, sum stop-level container counts by type. Reject any that exceeds `loadout[type]` for any type. This is a hard constraint, not a scoring factor.

**Tier 1 — haversine pre-rank (free, ~O(N!))**
Straight-line distance from warehouse → stop 1 → … → stop N → warehouse. Use haversine (see any implementation online — 6 lines of code). At N=8–10 orders full permutations are ~40k–3.6M — fine in the browser under a second. For N > 10, switch to nearest-neighbor construction + 2-opt improvement (also ~10 lines). Keep the top ~10 haversine-ranked feasible permutations.

**Tier 2 — real driving time (Distance Matrix API, costs money)**
Only for the top ~5 candidates from tier 1. Batch into one Distance Matrix call. Google prices per element (origin × destination). At 5 candidates × 10 stops = 50 elements each = 250 elements per plan → well under any per-day free tier.

**Score** (rank all remaining candidates and return the top 3, one favoring each dimension so the driver has real choice):
```
score = w1 * norm(totalDriveTime)
      + w2 * norm(totalDistance)
      + w3 * (1 - avgUtilization)   // reward tighter loadout use
```
Initial weights: `w1=0.5, w2=0.3, w3=0.2`. Tunable. Return one route with `w1=1`, one with `w2=1`, and one with the balanced formula — that gives the driver "fastest", "shortest", "most efficient" side-by-side.

## Points that need Ty's decision before coding starts

Do NOT start on the algorithm until Ty has answered these — the wrong choice costs a rewrite.

1. **Compute location — client or server?** Recommend client-side JS for MVP (ships in one session, no Functions setup). Trade-off: the Distance Matrix API key sits in the shipped bundle (already true today for the Maps JS key via `firebaseWebConfig.js`; domain-restricted). Long-term this belongs behind a Cloud Function that hides the key and can cache results.

2. **Distance source — haversine only, or two-tier haversine + Distance Matrix?** Recommend two-tier per §Algorithm. Haversine-only ignores one-ways / traffic / Da Nang's water crossings so routes will look weird. Distance Matrix costs per element (see current pricing) — cap requests hard in code.

3. **Warehouse origin — one address or per-driver?** Assumes single warehouse. If drivers start their day from different addresses (owner + a helper working from their own house), the schema needs `drivers/{driverId}.homeAddress` instead of a shared `settings/business.warehouse`. Confirm.

4. **Driver UI surface — driver auth or owner-only?** Two options:
   - Driver signs in to their own auth account (needs role-scoped Firestore rules — see ROADMAP "Frontend role guard" and existing driver-write rules on `payments` / `depositEvents`). Driver opens `/route.html` on their own phone, sees only their own orders.
   - Owner opens `/route.html`, picks a driver, texts the resulting Google Maps link to the driver.
   Recommend option 2 for phase 1 (no auth wiring needed). Move to option 1 in a follow-up. Confirm.

5. **Loadout units — crates or bottles?** A `glass_crate` product line is a crate (20 bottles). The loadout schema above assumes loadout counts CRATES. Verify — if the driver actually thinks in "50 bottles the truck can carry", we need a different unit.

6. **Container-size assumption.** Are 1 crate ≈ 1 jug in truck volume? If not, loadout needs volume/weight per type and the capacity math changes. Recommend deferring this — pick loadout numbers that already reflect real-world limits and don't try to model physics.

## Ordering the work (to minimize tokens per session)

Suggested turn-by-turn split, matching what the codebase already does:

1. **Turn 1**: Data-model migrations. Add warehouse fields to `settings/business`, add `standardLoadout` to drivers, add `deliveryLocation` to orders. Write the settings-page editor UI for both. Write the backfill script. Deploy. Verify by editing a driver and a warehouse from `/settings.html` and checking Firestore.
2. **Turn 2**: Geocode-on-approval hook in `adminApp.js`. Run the one-off backfill script against production. Verify all orders now have `deliveryLocation`.
3. **Turn 3**: `/route.html` shell — driver select, date picker, orders list with checkboxes, loadout chips, "Plan route" button (dumps candidate JSON to console). No routing math yet.
4. **Turn 4**: Tier 0 + Tier 1 routing math. Render 3 route cards with haversine-only estimates. Ship. Get feedback on route shape before spending Distance Matrix quota.
5. **Turn 5**: Tier 2 Distance Matrix integration. Real drive times + traffic. Rank + display final 3 routes.
6. **Turn 6** (only if driver auth chosen in decision #4): role scoping so drivers see only their own orders. Rules + `requireDriver()` helper (see ROADMAP "Frontend role guard").

Each turn should start by re-reading only the file(s) it touches. Don't re-audit the codebase — this file plus the files it links to are the source of truth.

## Related links + prior context

- [ROADMAP.md](ROADMAP.md) — "Driver mobile app" parking-lot item + "Browser-side geocoding" scale note under Security & scale, both directly relevant.
- [firebase/web/assets/mapApp.js](firebase/web/assets/mapApp.js) — the whole file. Read `backfillMissingLocations` (l.420), `renderRouteButton` (l.327), and the filter-strip markup in [firebase/web/map.html](firebase/web/map.html) before starting turn 3.
- [firebase/src/firestore/schema.js](firebase/src/firestore/schema.js) — `mapDriver` (l.109) and the order/customer/product mappers. Update these when the data model additions land in turn 1.
- [firebase/firebase.json](firebase/firebase.json) — hosting scoped to `web/`. No Functions. If Ty picks server-side compute in decision #1, this needs a `functions` block and a `firebase/functions/` directory (see Firebase docs — `firebase init functions`).
- [firestore.rules](firestore.rules) — driver-scoped rules already exist for `payments` and `depositEvents` (search for `myDriverId()`). Mirror the same pattern if driver auth is chosen.
- [firebase/web/assets/shared.js](firebase/web/assets/shared.js) — `withSubmitLock`, `buildOrderId`, `formatCurrency`, etc. Use them.

## Not in scope for the first cut

Explicitly parked so this doesn't scope-creep past one shippable feature:

- Real-time driver location tracking / ETA updates to customers.
- Multi-driver route balancing (assigning orders across drivers to minimize total fleet distance).
- Route re-optimization mid-run when a customer cancels or a new order lands.
- Historical run analytics / driver KPIs.
- Anything requiring Cloud Functions (defer until decision #1 forces it).
- Editing addresses from the planner (still done from the customer profile).
- Time-window scheduling (customer requested delivery windows are respected loosely today — the planner treats every order the same).

## Still open (from prior sessions, unchanged)

- Reconciliation view for overpayments (bad data pre-dates the strict math rule).
- Cloud Function server-side math on `amountPaid` / `balanceDue` / `paymentStatus`.
- Configurable thresholds (`followUpDays`, `depositRiskDays`, `depositForfeitDays`) in the settings doc.
- VietQR generator — blocked on real bank details in settings.
- Inventory Phase 1 — `costPrice` field + `/inventory/{productId}` manual on-hand entry.
- Rehost product photos off the danangwater.com CDN and wire per-product `imageUrl` from Firestore (see ROADMAP "Visual redesign of the public site" follow-up).

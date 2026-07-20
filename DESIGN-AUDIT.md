# Design & Structure Audit — 2026-07-20

Documentation only. Nothing here has been changed in code. Findings cite
`file:line` as of this date; line numbers will drift as the app evolves.

The app's styling lives in four layers, listed from most to least governed:

1. `firebase/web/assets/styles.css` (~3,300 lines) — the shared stylesheet and
   the 17-token `:root` layer (styles.css:3–19).
2. Per-page `<style>` blocks in 9 of 16 pages — biggest offenders:
   admin.html (~396 lines), orders.html (~119), map.html (~107), index.html
   (~85), account.html (~81), finance.html (~49).
3. ~220 inline `style="..."` attributes in the HTML — heaviest: admin (~50),
   account (~32), order (~28), customer (~19), orders (~16).
4. Template strings in `firebase/web/assets/*.js` — most of the UI is built
   here, not in the HTML files. Any audit or restyle that only reads HTML
   misses most of the app.

---

## 1. Consolidation Roadmap (highest impact first)

1. **Fix the danger-red drift.** The token is `--danger: #c0392b`
   (styles.css:18), but ~63 JS call sites write
   `var(--danger, #b3261e)` — a *different* red as the fallback (e.g.
   orderApp.js:241, adminApp.js:163). Today the token wins, so it's invisible;
   the moment `--danger` is renamed or a page loads without styles.css, every
   error message silently changes colour. Pick one red, make the fallback
   match the token (or drop the fallback), across 13 JS files + admin.html +
   order.html.
2. **Promote the success green to a token.** `#0b7a63` is the de-facto
   "paid / success / empties-pickup" green, hard-coded in adminApp.js:1068,
   adminApp.js:1867, invoice.js (5 sites), orderApp.js:1299, customer.html:38.
   There is **no green token at all** in `:root`. Add `--success` and replace.
3. **Deduplicate `escapeHtml`.** `shared.js:31` exports it, and all 19 app
   modules import shared.js — yet accountApp.js:1269, customerApp.js:48,
   mapApp.js:97, and invoice.js:10 each define their own local copy. If one
   copy ever gets an escaping bug fix, the others won't. Delete the four
   locals, import from shared.
4. **Deduplicate the money formatter.** `shared.js:1` exports
   `formatCurrency`; customerApp.js:58 and invoice.js:6 (`formatVnd`)
   re-implement the identical `Intl.NumberFormat("en-US") + " VND"` logic.
   Same risk as escapeHtml: three places to change one currency rule.
5. **Shrink admin.html's 396-line `<style>` block.** It restyles panels,
   badges, and tables that styles.css already defines, with its own blues
   (`#123b72` ×3, `#2f70c5` ×2, `#a9c9f5` ×4) that sit next to — but don't
   equal — `--brand`/`--brand-dark`/`--sky`. Either these are the admin
   sub-theme (then name them as tokens, e.g. `--admin-accent`) or they're
   drift (then collapse to the existing tokens). orders.html and
   receivables.html repeat `#2f70c5` too, so it has already started leaking.

---

## 2. Global Style Families

### Color

| Family | Intended token | Variants found (≤5 + count) | Type | Action |
| :--- | :--- | :--- | :--- | :--- |
| Danger red | `--danger: #c0392b` | `#b3261e` ×63 in JS as var() fallback (orderApp.js:241 et al.); `#b3261e` order.html, admin.html; `#a5221a` map.html; `#c84a55`, `#9b2c2c` orders/admin.html (~70 total) | drift | one red; fallbacks must equal the token |
| Success green | *(none)* | `#0b7a63` ×8 (adminApp.js:1068, invoice.js:84,203,207,209,252, orderApp.js:1299, customer.html:38); `rgba(11,122,99,…)` tints | undefined | add `--success` + `--success-tint` |
| Brand blue | `--brand: #1b68e9` | `#1b68e9` map.html + routePlanning.js:271; `#2f70c5` admin/orders/receivables.html ×6; `#123b72` admin/orders.html ×4; `#1458c0`, `#1f6da8` (~15 total) | duplicate + drift | replace exact dupes with `var(--brand)`; decide if `#2f70c5`/`#123b72` are an admin sub-theme or accidents |
| Muted text | `--muted: #5d6a74` | `#5d6a74` ×8 in JS; `#888`, `#555`, `#5e5e5e`, `#7f8c8d` (~16 total) | duplicate | `var(--muted)` |
| Borders/lines | `--line` | `#eee` ×4, `#e2e2e2`, `#ccc`, `#d8dee9` ×2, `#d8ddd9` ×2 | duplicate | `var(--line)` / `var(--line-strong)` |
| Surface white | `--surface: #ffffff` | `#fff` ×16 + `#ffffff` ×18 inside styles.css itself | duplicate | low priority; styles.css doesn't use its own token |

Notes:
- `--sun: #1b68e9` (styles.css:13) is identical to `--brand` — either a dead
  token or a lost intention (was presumably yellow once). `#e0b25a` in
  order.html and `#674700`/`#fff7dc`-family ambers in admin.html look like the
  orphaned remains of that yellow. Decide: revive `--sun` as the warning/amber
  token or delete it.
- `--surface-strong` ≡ `--surface` (both `#ffffff`) — same question.
- mapApp.js:29 and routePlanning.js:271 each define their own route-colour
  palettes with overlapping but non-identical colour lists. If a driver sees
  trip colours in both views, the same trip can render in different colours.
  One exported `ROUTE_COLORS` in shared.js would fix it.

### Typography
Single family (Inter, styles.css:1) loaded from Google Fonts — coherent.
invoice.js builds the printable invoice with its own inline font sizing
(12–24px, invoice.js:181–252), which is defensible for print but is the one
page that ignores the stylesheet entirely.

### Buttons
styles.css defines a real button system: `button.primary` (:238),
`.secondary` (:258), `.ghost` (:271), `.danger` (:276),
`.success-locked` (:2049). Adoption is good — only one inline-styled button in
all the JS (adminApp.js:1028, deliberately stripping styles for an image
button). **This family is healthy; treat it as the model for the others.**

### Badges / status pills
Fragmented. styles.css has `.badge`, `.pill`, and the `.status-*` family
(styles.css:567–581 for new/pending_approval/assigned/out_for_delivery/
delivered/cancelled), but around them have grown one-off variants:
`.dup-badge-*`, `.map-order-product-badge`, `.order-thumb-badge`,
`.nav-count-badge`, `.recon-badge-*` (clean/drift/failed/running),
`.admin-dock-status`, `.personal-details-status`, `.signin-dialog-status`.
Plus inline-styled badges in JS (adminApp.js:1068 builds a green badge with
inline background/colour instead of a class). Eight-plus naming schemes for
"small coloured label". Should converge on `.badge` + modifier classes.

---

## 3. Component & Feature Families (structural)

### Family: Status-line helper (`setStatus`-style)
* **Intent:** show a form/action result message, red on error, muted
  otherwise.
* **Current state:** the same two-line pattern
  (`node.style.color = isError ? "var(--danger, #b3261e)" : "var(--muted)"`)
  is copy-pasted across essentially every app module — orderApp.js:241, 318,
  611; adminApp.js:163, 510; and the other `*App.js` files account for most
  of the 63 `#b3261e` hits.
* **Discrepancy:** it's a one-function utility living as ~15 copies. One
  `setStatus(node, message, isError)` in shared.js ends the duplication and
  fixes the red-drift problem (Roadmap #1 and this are the same change).

### Family: HTML escaping
* **Canonical:** shared.js:31.
* **Orphans:** accountApp.js:1269, customerApp.js:48, mapApp.js:97,
  invoice.js:10 — local re-implementations in files that already import
  shared.js.

### Family: Money formatting
* **Canonical:** `formatCurrency` shared.js:1.
* **Orphans:** customerApp.js:58, invoice.js:6 (`formatVnd`).

### Family: Toast / transient notice
* adminApp.js and mapApp.js each have their own toast/notice mechanism; the
  other pages use the status-line pattern above. Three ways to say "saved".
  Not urgent, but worth a note in any future style guide.

### Family: Customer-facing vs admin theming
* The public order form (index.html, 85-line style block), account, and
  customer-order pages restyle on top of styles.css; the admin pages do too
  but with different values. There is no named boundary — no
  `body.customer` / `body.admin` scope, no second token set. That's why the
  admin blues (`#123b72`, `#2f70c5`) look like drift: nothing declares them
  intentional. **Recommendation:** if the two audiences are meant to look
  different, encode it (scoped token overrides on a body class); if not,
  collapse to one palette.

---

## 4. Undocumented / dead surface

- `--sun` and `--surface-strong`: tokens that duplicate other tokens exactly
  (styles.css:6, :13). Dead or unfinished.
- account.html's odd `#add` ×4 — a 3-digit hex light blue in inline styles;
  probably intended tint, matches nothing in the token set.
- The invoice (invoice.js) is a fully inline-styled document — reasonable for
  print isolation, but it should be *documented* as intentionally outside the
  design system so nobody "fixes" it.
- customer-order.html (17-line block), deposits.html (20), receivables.html
  (13) carry tiny style blocks that could fold into styles.css trivially —
  they exist only because there was nowhere obvious to put them.

## 5. Case study: why "add the address map" took three prompts

The owner had to ask three times to get the address-finding map into edit
order, dashboard, and add-new-address. The code explains why: **the feature
exists five times**, and each copy lives inside a different page's monolith,
so no single prompt could see them all.

### The five copies

| Where | Loader | Bounds check | Autocomplete | Geocoder | Marker drag |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `editOrderAddress.js` (the extracted controller) | injected | :1, :8 | :133 | :222 | :265–286 |
| `publicApp.js` (public order form) | :278 | :260 own copy | :391 | — | :867 |
| `accountApp.js` (add/edit address) | :69 | :45 own copy | :158 | :940, :1065 | :1054 |
| `adminApp.js` (dashboard edit-address) | :456 | :550 inline literals | — | :479, :544 | :569–581 |
| `mapApp.js` / `customerApp.js:338` / `customersApp.js:79` | mapApp:129 | — | — | 3 more Geocoders | — |

Concretely that's **4 copies of the Google Maps script loader**, **3 copies of
the Da Nang delivery-area bounds** (the literals `108.05 / 108.35 / 15.90 /
16.20` appear in publicApp.js:260, accountApp.js:45, adminApp.js:550, *and*
`DA_NANG_BOUNDS` in editOrderAddress.js:1), **6 `new google.maps.Geocoder()`
sites**, and **3 independent autocomplete-suggestion flows**. If the delivery
area ever widens, that's four edits — miss one and one page silently rejects
addresses the others accept.

The sharpest symptom: **adminApp.js imports the shared controller
(adminApp.js:70, `createEditOrderAddressController`) and *still* carries its
own parallel implementation** (`editAddressState`, adminApp.js:498–581). The
third prompt bolted the feature on next to the abstraction instead of through
it — the classic result of a copy already being on the page.

### Root cause (structural, not a style issue)

The app is organized as **one monolith per page**: `adminApp.js` (3,088
lines), `publicApp.js` (2,046), `orderApp.js` (1,710), `accountApp.js`
(1,701). A feature that appears on N pages gets implemented N times, because
each page's file is the unit of work. `shared.js` exists but historically
only accepted small pure helpers (formatting, IDs, phone) — anything with a
DOM or a map stayed in the page files.

### The fix already exists in miniature

`editOrderAddress.js` is the correct pattern and it's already proven:

- Factory with injected dependencies
  (`createEditOrderAddressController({ loadMaps, getElement })`,
  editOrderAddress.js:32) — page supplies its own element IDs, controller
  owns the behaviour.
- Exports the domain constants (`DA_NANG_BOUNDS`, `insideDeliveryArea`,
  :387) instead of letting each page re-declare them.
- **It has a test** (`firebase/src/editOrderAddress.test.mjs`) — the only
  address-picker copy that does.

The consolidation is not "build an abstraction" — it's "finish adopting the
one that exists":

1. publicApp.js and accountApp.js switch to
   `createEditOrderAddressController` (delete their loaders, bounds,
   autocomplete, and drag handlers).
2. adminApp.js deletes `editAddressState` (:498–581) and routes its
   edit-address dialog through the controller it already imports.
3. The maps script loader moves into editOrderAddress.js (or shared.js) as
   the single `loadMapsSdk`; mapApp.js uses it too.
4. Bounds live only in editOrderAddress.js and are imported everywhere.

After that, "add address-finding to page X" is one prompt: *"wire
createEditOrderAddressController into page X"* — and the AI can see the whole
feature in one file.

### Same disease, other features (candidates for the same treatment)

- **Reverse geocoding** — 6 Geocoder sites (table above); belongs in the
  controller.
- **Status-line helper** — ~15 copies (section 3); belongs in shared.js.
- **escapeHtml / money formatting** — 5 and 3 copies (sections 3).
- **Toast/notice** — 2 bespoke systems (adminApp, mapApp).
- **Route colours** — 2 palettes (mapApp.js:29, routePlanning.js:271).

### Counter-examples that show the pattern works here

`setupPhoneCountryPicker` (shared.js:161) and `renderDeliveryWindowOptions`
(shared.js:404) are DOM-touching features shared across pages via one
function — and the phone picker has never needed a "tell the AI three times"
round. The rule that falls out: **if a feature is wanted on a second page,
its first stop is a shared module, not a second copy.** Worth adding to
CLAUDE.md/AGENTS.md so both agents follow it.

## What's healthy (don't churn)

- The token layer itself: 17 tokens, coherent names, small enough to hold in
  your head.
- The button system — near-100% adoption.
- The core `.status-*` order-status family in styles.css:567–581 — the JS
  uses the classes, not inline colours.
- shared.js as the utilities home — the pattern exists and every module
  imports it; the problem is only the stragglers that didn't finish moving in.

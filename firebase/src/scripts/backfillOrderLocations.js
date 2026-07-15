// One-off: geocode every order that doesn't yet have a deliveryLocation and
// stash { lat, lng, formattedAddress, geocodedAt } onto the order doc. The
// route planner needs coordinates on the ORDER (not just on the customer)
// because customers move and orders can go to a one-off address.
//
// Uses the server-side Google Geocoding REST API. The Maps browser key at
// firebase/web/assets/firebaseWebConfig.js is HTTP-referrer restricted, so it
// will not work from Node. Provide an UNRESTRICTED (or IP-restricted)
// Geocoding key via GOOGLE_GEOCODING_API_KEY. Same key needs "Geocoding API"
// enabled in Google Cloud Console.
//
// Usage:
//   FIREBASE_SERVICE_ACCOUNT_PATH=/path/to/sa.json \
//   GOOGLE_GEOCODING_API_KEY=AIza... \
//   node firebase/src/scripts/backfillOrderLocations.js
//
// Optional flags:
//   --limit N   process at most N missing orders (safe first-run test)
//   --dry-run   log what would be written but don't touch Firestore
//
// Idempotent: orders that already have deliveryLocation with a valid lat/lng
// are skipped. Falls back to customer.location if the order's own address
// can't be geocoded.

import { getFirestore } from "../config/firebaseAdmin.js";
import { COLLECTIONS } from "../firestore/schema.js";

function parseArgs(argv) {
  const args = { limit: null, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--limit") {
      args.limit = Number(argv[i + 1]);
    } else if (argv[i] === "--dry-run") {
      args.dryRun = true;
    }
  }
  return args;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasValidLocation(loc) {
  return loc && typeof loc.lat === "number" && typeof loc.lng === "number";
}

async function geocode(address, apiKey) {
  const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  url.searchParams.set("address", address);
  url.searchParams.set("region", "vn");
  url.searchParams.set("key", apiKey);
  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`Geocoding HTTP ${res.status}`);
  }
  const body = await res.json();
  if (body.status === "OK" && body.results && body.results.length) {
    const first = body.results[0];
    const loc = first.geometry.location;
    return {
      lat: loc.lat,
      lng: loc.lng,
      formattedAddress: first.formatted_address
    };
  }
  if (body.status === "ZERO_RESULTS") return null;
  throw new Error(`Geocoding failed: ${body.status}${body.error_message ? ` — ${body.error_message}` : ""}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = process.env.GOOGLE_GEOCODING_API_KEY;
  if (!apiKey) {
    throw new Error("GOOGLE_GEOCODING_API_KEY is not set. See the header comment in this file.");
  }

  const db = getFirestore();
  console.log("Loading all orders...");
  const ordersSnap = await db.collection(COLLECTIONS.orders).get();
  const missing = ordersSnap.docs.filter((d) => {
    const data = d.data();
    return !hasValidLocation(data.deliveryLocation) && data.address;
  });
  const total = args.limit ? Math.min(args.limit, missing.length) : missing.length;
  console.log(`${missing.length} orders missing deliveryLocation; processing ${total}.`);
  if (!total) return;

  // Preload customers referenced by the missing orders so we can fall back to
  // the customer's stored location when direct geocoding fails.
  const customerIds = Array.from(new Set(
    missing.slice(0, total).map((d) => d.data().customerId).filter(Boolean)
  ));
  const customers = {};
  for (const id of customerIds) {
    const snap = await db.collection(COLLECTIONS.customers).doc(id).get();
    if (snap.exists) customers[id] = snap.data();
  }

  let geocoded = 0;
  let fromCustomer = 0;
  let failed = 0;

  for (let i = 0; i < total; i += 1) {
    const docSnap = missing[i];
    const order = docSnap.data();
    const address = String(order.address || "").trim();
    let result = null;

    if (address) {
      try {
        result = await geocode(address, apiKey);
        if (result) geocoded += 1;
      } catch (error) {
        console.warn(`Geocode error for ${docSnap.id}: ${error.message || error}`);
      }
    }

    if (!result) {
      const customerLoc = customers[order.customerId]?.location;
      if (hasValidLocation(customerLoc)) {
        result = {
          lat: customerLoc.lat,
          lng: customerLoc.lng,
          formattedAddress: customerLoc.formattedAddress || address
        };
        fromCustomer += 1;
      } else {
        failed += 1;
        console.warn(`No location for order ${docSnap.id} (address: "${address}")`);
      }
    }

    if (result) {
      const payload = {
        deliveryLocation: {
          lat: result.lat,
          lng: result.lng,
          formattedAddress: result.formattedAddress,
          geocodedAt: new Date().toISOString()
        },
        updatedAt: new Date().toISOString()
      };
      if (args.dryRun) {
        console.log(`[dry-run] ${docSnap.id} → ${result.lat.toFixed(5)}, ${result.lng.toFixed(5)}`);
      } else {
        await docSnap.ref.set(payload, { merge: true });
      }
    }

    // Google Geocoding QPS cap is generous but keep it polite.
    await sleep(120);

    if ((i + 1) % 25 === 0) {
      console.log(`  ${i + 1}/${total} processed (geocoded ${geocoded}, from customer ${fromCustomer}, failed ${failed})`);
    }
  }

  console.log(`Done. Geocoded: ${geocoded}. Filled from customer.location: ${fromCustomer}. Failed: ${failed}.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

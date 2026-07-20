// Route planning: capacity-aware multi-trip itinerary for a driver's day.
// Pure functions + rendering helpers. No DOM side effects; the consumer
// (mapApp.js today) wires up the buttons and containers.

import { escapeHtml } from "./shared.js";

const CONTAINER_LABELS = {
  glass_crate: "Glass crates",
  "18_9l_jug": "18.9 L jugs",
  "19l_jug": "19 L jugs",
  "20l_jug": "20 L jugs",
  unit: "Units"
};

export function humanizeContainerType(key) {
  if (!key) return "Other";
  return CONTAINER_LABELS[key] || String(key).replace(/_/g, " ");
}

// ------------------------------------------------------------ math

export function haversineKm(a, b) {
  const R = 6371;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

export function routeTotalKm(warehouseLoc, orderedStops) {
  let total = 0;
  let prev = warehouseLoc;
  for (const stop of orderedStops) {
    total += haversineKm(prev, stop.location);
    prev = stop.location;
  }
  total += haversineKm(prev, warehouseLoc);
  return total;
}

// Exhaustive permutation via Heap's algorithm. Safe for N ≤ 8 (8! ≈ 40k).
function bestPermutation(warehouseLoc, stops) {
  let best = { order: stops.slice(), km: routeTotalKm(warehouseLoc, stops) };
  const arr = stops.slice();
  const n = arr.length;
  const c = new Array(n).fill(0);
  let i = 0;
  while (i < n) {
    if (c[i] < i) {
      const swap = i % 2 === 0 ? 0 : c[i];
      [arr[swap], arr[i]] = [arr[i], arr[swap]];
      const km = routeTotalKm(warehouseLoc, arr);
      if (km < best.km) best = { order: arr.slice(), km };
      c[i] += 1;
      i = 0;
    } else {
      c[i] = 0;
      i += 1;
    }
  }
  return best;
}

function nearestNeighbor(warehouseLoc, stops) {
  const remaining = stops.slice();
  const route = [];
  let cur = warehouseLoc;
  while (remaining.length) {
    let bestIdx = 0;
    let bestKm = Infinity;
    for (let i = 0; i < remaining.length; i += 1) {
      const km = haversineKm(cur, remaining[i].location);
      if (km < bestKm) { bestKm = km; bestIdx = i; }
    }
    const [picked] = remaining.splice(bestIdx, 1);
    route.push(picked);
    cur = picked.location;
  }
  return route;
}

function twoOptImprove(warehouseLoc, initial) {
  let route = initial.slice();
  let bestKm = routeTotalKm(warehouseLoc, route);
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < route.length - 1; i += 1) {
      for (let k = i + 1; k < route.length; k += 1) {
        const candidate = route.slice(0, i).concat(
          route.slice(i, k + 1).reverse(),
          route.slice(k + 1)
        );
        const km = routeTotalKm(warehouseLoc, candidate);
        if (km < bestKm - 0.0001) {
          route = candidate;
          bestKm = km;
          improved = true;
        }
      }
    }
  }
  return { order: route, km: bestKm };
}

function optimizeRoute(warehouseLoc, stops) {
  if (stops.length <= 1) return { order: stops.slice(), km: routeTotalKm(warehouseLoc, stops) };
  if (stops.length <= 8) return bestPermutation(warehouseLoc, stops);
  return twoOptImprove(warehouseLoc, nearestNeighbor(warehouseLoc, stops));
}

// ------------------------------------------------------------ tally

// Compute per-container-type counts for one order, using the caller-provided
// productId → containerType lookup. Falls back to "unit" for unknown products.
export function itemCountsForOrder(order, orderItemsByOrderId, productContainerType) {
  const byType = {};
  const items = orderItemsByOrderId[order.id] || [];
  items.forEach((item) => {
    const type = productContainerType[item.productId] || "unit";
    byType[type] = (byType[type] || 0) + Number(item.quantity || 0);
  });
  return byType;
}

export function sumTallies(tallies) {
  const byType = {};
  tallies.forEach((t) => {
    Object.entries(t).forEach(([type, qty]) => {
      byType[type] = (byType[type] || 0) + qty;
    });
  });
  return byType;
}

export function tallyForOrders(orders, orderItemsByOrderId, productContainerType) {
  return sumTallies(orders.map((o) => itemCountsForOrder(o, orderItemsByOrderId, productContainerType)));
}

function totalUnits(counts) {
  return Object.values(counts).reduce((s, v) => s + v, 0);
}

// ------------------------------------------------------------ packing

function fitsWithinCapacity(counts, remaining) {
  for (const [type, qty] of Object.entries(counts)) {
    if (qty > (remaining[type] || 0)) return false;
  }
  return true;
}

function subtractCapacity(remaining, counts) {
  const next = { ...remaining };
  Object.entries(counts).forEach(([type, qty]) => {
    next[type] = (next[type] || 0) - qty;
  });
  return next;
}

function greedyPack(sortedStops, loadout) {
  let remaining = { ...loadout };
  const selected = [];
  const leftover = [];
  for (const stop of sortedStops) {
    if (fitsWithinCapacity(stop.counts, remaining)) {
      selected.push(stop);
      remaining = subtractCapacity(remaining, stop.counts);
    } else {
      leftover.push(stop);
    }
  }
  return { selected, leftover, remaining };
}

// Dense cluster: seed from the geographic center of gravity, then greedily
// add nearest-to-cluster stops.
function denseClusterOrder(stops) {
  if (stops.length <= 1) return stops.slice();
  let seed = stops[0];
  let seedScore = Infinity;
  stops.forEach((candidate) => {
    const sum = stops.reduce((s, o) => s + haversineKm(candidate.location, o.location), 0);
    if (sum < seedScore) { seedScore = sum; seed = candidate; }
  });
  const cluster = [seed];
  const remaining = stops.filter((s) => s !== seed);
  while (remaining.length) {
    let bestIdx = 0;
    let bestKm = Infinity;
    for (let i = 0; i < remaining.length; i += 1) {
      const km = Math.min(...cluster.map((c) => haversineKm(c.location, remaining[i].location)));
      if (km < bestKm) { bestKm = km; bestIdx = i; }
    }
    const [picked] = remaining.splice(bestIdx, 1);
    cluster.push(picked);
  }
  return cluster;
}

// ------------------------------------------------------------ planning

function planItineraryForStrategy(strategy, stops, warehouseLoc, loadout) {
  const trips = [];
  let remaining = stops.slice();
  const MAX_TRIPS = 12;
  while (remaining.length > 0 && trips.length < MAX_TRIPS) {
    const ordered = strategy.order(remaining, warehouseLoc);
    const packed = greedyPack(ordered, loadout);
    if (!packed.selected.length) break;
    const optimized = optimizeRoute(warehouseLoc, packed.selected);
    trips.push({
      selected: optimized.order,
      km: optimized.km,
      counts: sumTallies(optimized.order.map((s) => s.counts))
    });
    remaining = packed.leftover;
  }
  return {
    label: strategy.label,
    description: strategy.description,
    trips,
    unassigned: remaining,
    totalKm: trips.reduce((s, t) => s + t.km, 0),
    totalStops: trips.reduce((s, t) => s + t.selected.length, 0)
  };
}

export function planItineraries(stops, warehouseLoc, loadout) {
  const strategies = [
    {
      label: "A · Neighborhood clusters",
      description: "Groups orders into tight geographic clusters — each trip is one neighborhood.",
      order: (s) => denseClusterOrder(s)
    },
    {
      label: "B · Warehouse-out sweep",
      description: "Closest to the warehouse first, sweeping outward trip by trip.",
      order: (s, wh) => s.slice().sort((a, b) => haversineKm(wh, a.location) - haversineKm(wh, b.location))
    }
  ];
  const itineraries = strategies.map((s) => planItineraryForStrategy(s, stops, warehouseLoc, loadout));
  const key = (it) => it.trips.map((t) => t.selected.map((s) => s.orderId).join(",")).join("|");
  const seen = new Set();
  return itineraries.filter((it) => {
    const k = key(it);
    if (seen.has(k)) return false;
    seen.add(k);
    return it.trips.length > 0;
  });
}

// Pick the single itinerary the driver should actually run. Fewer trips means
// fewer warehouse reloads and less driving, so that wins first; ties break on
// total distance, then on placing the most orders. The planner still computes
// every strategy — the driver just never has to compare them.
export function pickBestItinerary(itineraries) {
  if (!itineraries.length) return null;
  return itineraries.slice().sort((a, b) => {
    if (a.unassigned.length !== b.unassigned.length) return a.unassigned.length - b.unassigned.length;
    if (a.trips.length !== b.trips.length) return a.trips.length - b.trips.length;
    return a.totalKm - b.totalKm;
  })[0];
}

// ------------------------------------------------------------ rendering

const TRIP_COLORS = ["#1b68e9", "#27ae60", "#d35400", "#8e44ad", "#0e6251", "#c0392b"];
const CITY_KMH = 22;

function estimateMinutes(km) { return Math.round((km / CITY_KMH) * 60); }
function formatDurationMinutes(minutes) {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h} h ${m} min` : `${h} h`;
}

function buildMapsDirUrl(warehouseLoc, orderedStops) {
  if (!orderedStops.length) return "";
  const points = orderedStops.map((s) => `${s.location.lat},${s.location.lng}`);
  const destination = points[points.length - 1];
  const waypoints = points.slice(0, -1).join("|");
  const params = new URLSearchParams({
    api: "1",
    origin: `${warehouseLoc.lat},${warehouseLoc.lng}`,
    destination,
    travelmode: "driving"
  });
  if (waypoints) params.set("waypoints", waypoints);
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

function renderPreviewSvg(warehouseLoc, trips) {
  const width = 400;
  const height = 240;
  const pad = 22;
  const allPoints = [warehouseLoc, ...trips.flatMap((t) => t.selected.map((s) => s.location))];
  const lats = allPoints.map((p) => p.lat);
  const lngs = allPoints.map((p) => p.lng);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const latRange = Math.max(maxLat - minLat, 0.0001);
  const lngRange = Math.max(maxLng - minLng, 0.0001);
  const inner = { w: width - 2 * pad, h: height - 2 * pad };
  const scale = Math.min(inner.w / lngRange, inner.h / latRange);
  const xOffset = pad + (inner.w - lngRange * scale) / 2;
  const yOffset = pad + (inner.h - latRange * scale) / 2;
  const project = (loc) => ({
    x: xOffset + (loc.lng - minLng) * scale,
    y: yOffset + (maxLat - loc.lat) * scale
  });

  const wh = project(warehouseLoc);
  const polylines = trips.map((trip, tripIdx) => {
    const color = TRIP_COLORS[tripIdx % TRIP_COLORS.length];
    const pts = [wh, ...trip.selected.map((s) => project(s.location)), wh];
    const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
    return `<path d="${d}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round" opacity="0.75"/>`;
  }).join("");
  const stopDots = trips.flatMap((trip, tripIdx) => {
    const color = TRIP_COLORS[tripIdx % TRIP_COLORS.length];
    return trip.selected.map((stop, stopIdx) => {
      const p = project(stop.location);
      return `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="9" fill="${color}" stroke="white" stroke-width="2"/>`
        + `<text x="${p.x.toFixed(1)}" y="${(p.y + 3.2).toFixed(1)}" fill="white" font-size="10" font-weight="700" text-anchor="middle">${stopIdx + 1}</text>`;
    });
  }).join("");
  const warehouseMarker = `<rect x="${(wh.x - 10).toFixed(1)}" y="${(wh.y - 10).toFixed(1)}" width="20" height="20" fill="#0f172a" stroke="white" stroke-width="2" rx="4"/>`
    + `<text x="${wh.x.toFixed(1)}" y="${(wh.y + 3.5).toFixed(1)}" fill="white" font-size="11" font-weight="700" text-anchor="middle">W</text>`;
  return `<svg viewBox="0 0 ${width} ${height}" class="route-preview-svg" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Route preview">
    ${polylines}
    ${stopDots}
    ${warehouseMarker}
  </svg>`;
}

function renderTripLegend(trips) {
  return `<div class="trip-legend">${trips.map((_, i) => {
    const color = TRIP_COLORS[i % TRIP_COLORS.length];
    return `<span class="trip-legend-item"><span class="trip-legend-swatch" style="background:${color}"></span>Trip ${i + 1}</span>`;
  }).join("")}</div>`;
}

// Compact "what's on the truck for this trip" chips — just the counts the
// driver loads, no capacity fractions or percentages. Utilization math was the
// biggest source of on-screen numbers and the driver doesn't act on it.
function renderTripLoad(tally) {
  const chips = Object.entries(tally || {})
    .filter(([, qty]) => Number(qty) > 0)
    .map(([type, qty]) => `<span class="loadout-chip">${escapeHtml(humanizeContainerType(type))} <strong>${qty}</strong></span>`)
    .join("");
  return chips ? `<div class="loadout-chips" style="margin-top:8px">${chips}</div>` : "";
}

// Render the one recommended plan as a plain-language suggestion the driver can
// act on: a single headline sentence (volume · trips · distance · time), the
// route sketch, then one navigable block per trip. No competing strategies, no
// utilization percentages — just how to run the day.
export function renderRecommendedItinerary(it, warehouseLoc) {
  if (!it || !it.trips.length) return "";
  const totalMin = estimateMinutes(it.totalKm);
  const preview = renderPreviewSvg(warehouseLoc, it.trips);
  const legend = it.trips.length > 1 ? renderTripLegend(it.trips) : "";
  const tripWord = it.trips.length === 1 ? "one trip" : `${it.trips.length} trips`;
  const headline = `Run ${it.totalStops} order${it.totalStops === 1 ? "" : "s"} in <strong>${tripWord}</strong> — about <strong>${it.totalKm.toFixed(0)} km</strong> and ~${formatDurationMinutes(totalMin)} of driving.`;
  const unassignedLine = it.unassigned.length
    ? `<div class="capacity-warning" style="display:block;margin-top:10px">${it.unassigned.length} order${it.unassigned.length === 1 ? "" : "s"} won't fit the loadout — split the order or adjust the truck load.</div>`
    : "";
  const trips = it.trips.map((trip, tripIdx) => {
    const color = TRIP_COLORS[tripIdx % TRIP_COLORS.length];
    const stopsHtml = trip.selected.map((stop) => `
      <li>
        <strong>${escapeHtml(stop.customerName || "?")}</strong>
        <span class="muted"> — ${escapeHtml(stop.address || "")}</span>
      </li>
    `).join("");
    const load = renderTripLoad(trip.counts);
    const mapsHref = buildMapsDirUrl(warehouseLoc, trip.selected);
    return `
      <div class="trip-block">
        <div class="trip-header">
          <span class="trip-color-dot" style="background:${color}"></span>
          <strong>Trip ${tripIdx + 1}</strong>
          <span class="muted">· ${trip.selected.length} stop${trip.selected.length === 1 ? "" : "s"} · ${trip.km.toFixed(0)} km</span>
          <a class="button-link primary" href="${escapeHtml(mapsHref)}" target="_blank" rel="noopener">Navigate</a>
        </div>
        ${load}
        <ol class="route-stop-list" style="margin:8px 0 0;padding-left:22px">${stopsHtml}</ol>
      </div>
    `;
  }).join("");
  return `
    <article class="card route-result-card">
      <p class="planner-suggestion">${headline}</p>
      ${preview}
      ${legend}
      ${unassignedLine}
      <div class="trip-list" style="margin-top:14px">${trips}</div>
    </article>
  `;
}

import assert from "node:assert/strict";
import { test } from "node:test";
import { coordinates, distanceMeters, matchRoute, usableFix } from "./deliveryRouting.js";

const start = { lat: 16, lng: 108 };
const east = { lat: 16, lng: 108.01 };
const north = { lat: 16.01, lng: 108.01 };

test("matches the middle of a long road segment, rather than either vertex", () => {
  const match = matchRoute([start, east], { lat: 16, lng: 108.005 });
  assert.ok(match.distance < 0.01);
  assert.ok(Math.abs(match.progress / match.total - 0.5) < 0.001);
});

test("distance from the route is measured in meters", () => {
  const match = matchRoute([start, east], { lat: 16.001, lng: 108.005 });
  assert.ok(match.distance > 110 && match.distance < 112);
});

test("a crossing cannot skip ahead beyond the allowed progress", () => {
  const path = [start, east, north, { lat: 16.01, lng: 108 }, start, east];
  const match = matchRoute(path, { lat: 16, lng: 108.001 }, 500);
  assert.equal(match.segment, 0);
  assert.ok(match.progress < 150);
});

test("duplicate road vertices do not produce NaN", () => {
  const match = matchRoute([start, start, east], start);
  assert.equal(match.distance, 0);
  assert.ok(Number.isFinite(match.total));
});

test("supports both Maps LatLng methods and route coordinate properties", () => {
  assert.deepEqual(coordinates({ lat: () => 16, lng: () => 108 }), start);
  assert.deepEqual(coordinates(start), start);
  assert.equal(coordinates({ lat: 91, lng: 0 }), null);
  assert.equal(coordinates({ lat: null, lng: null }), null);
});

test("rejects inaccurate, stale, invalid and future GPS fixes", () => {
  const now = 100000;
  const fix = { ...start, accuracy: 10, timestamp: now };
  assert.equal(usableFix(fix, now), true);
  assert.equal(usableFix({ ...fix, accuracy: 100 }, now), false);
  assert.equal(usableFix({ ...fix, timestamp: now - 21000 }, now), false);
  assert.equal(usableFix({ ...fix, timestamp: now + 10000 }, now), false);
  assert.equal(usableFix({ ...fix, lat: NaN }, now), false);
});

test("a fix near the destination still retains the route distance", () => {
  const match = matchRoute([start, east], east);
  assert.ok(match.total > 1000);
  assert.equal(match.progress, match.total);
  assert.equal(distanceMeters(east, east), 0);
});

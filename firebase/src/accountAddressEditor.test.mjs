import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("../web/account.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../web/assets/accountApp.js", import.meta.url), "utf8");

test("account address editor has an accessible Google Maps suggestion list", () => {
  assert.match(html, /id="account-address-autocomplete-list"[^>]+role="listbox"/);
  assert.match(html, /aria-controls="account-address-autocomplete-list"/);
  assert.match(app, /AutocompleteSuggestion\.fetchAutocompleteSuggestions/);
  assert.match(app, /includedRegionCodes:\s*\["vn"\]/);
  assert.match(app, /locationRestriction:\s*DA_NANG_DELIVERY_BOUNDS/);
});

test("account address editor blocks pins outside the delivery area", () => {
  assert.match(app, /if \(!isInsideDaNangDeliveryArea\(position\)\)/);
  assert.match(app, /if \(!isInsideDaNangDeliveryArea\(draggedPosition\)\)/);
  assert.match(app, /outside the Da Nang delivery area/);
});

test("a map result is not saveable until the customer explicitly confirms it", () => {
  assert.match(app, /confirmButton\.textContent = "Use this address"/);
  assert.match(app, /pendingAddressConfirmation\.address !== value/);
  assert.doesNotMatch(app, /capture\(position\);/);
});

test("moving the pin reverse-geocodes and requires confirmation again", () => {
  assert.match(app, /accountAddressMarker\.addListener\("dragstart"/);
  assert.match(app, /pendingAddressConfirmation = null/);
  assert.match(app, /geocoder\.geocode\(\{ location: draggedPosition \}/);
  assert.match(app, /showPinConfirmation\(\)/);
});

test("account address dialog uses a one-column phone layout", () => {
  assert.match(html, /#add-address-form\s*\{[\s\S]*?display:\s*grid/);
  assert.match(html, /@media \(max-width:\s*520px\)[\s\S]*?\.account-address-actions\s*\{\s*display:\s*grid/);
  assert.match(html, /\.account-address-actions button\s*\{\s*width:\s*100%/);
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { insideDeliveryArea } from "../web/assets/editOrderAddress.js";

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, "../web");
const helper = await readFile(resolve(web, "assets/editOrderAddress.js"), "utf8");

assert.equal(insideDeliveryArea({ lat: 16.0678, lng: 108.2208 }), true);
assert.equal(insideDeliveryArea({ lat: 21.0278, lng: 105.8342 }), false);
assert.match(helper, /fetchAutocompleteSuggestions/);
assert.match(helper, /includedRegionCodes:\s*\["vn"\]/);
assert.match(helper, /locationRestriction:\s*DA_NANG_BOUNDS/);
assert.match(helper, /geocode\(\{ location: draggedPosition \}/);
assert.match(helper, /That pin is outside the Da Nang delivery area/);
assert.match(helper, /button\.textContent = "Use this address"/);

for (const [htmlFile, appFile] of [
  ["admin.html", "assets/adminApp.js"],
  ["order.html", "assets/orderApp.js"]
]) {
  const html = await readFile(resolve(web, htmlFile), "utf8");
  const app = await readFile(resolve(web, appFile), "utf8");
  assert.match(html, /id="edit-address-autocomplete-list"/);
  assert.match(html, /id="edit-address-reset-pin"/);
  assert.match(html, />Use this address</);
  assert.match(app, /createEditOrderAddressController/);
  assert.match(app, /confirmedEditLocation = editAddressController\.confirmedFor\(newAddress\)/);
  assert.match(app, /locationReconfirmed = editAddressController\.hasFreshConfirmationFor\(newAddress\)/);
  assert.match(app, /addressChanged && !confirmedEditLocation/);
  assert.match(app, /deliveryLocation: confirmedEditLocation/);
}

console.log("edit-order advanced address checks: 24/24 passed");

import { auth, collection, db, functions, getDocs, httpsCallable, onAuthStateChanged } from "./firebaseClient.js";
import { formatCurrency, normalizePhoneE164VN, todayKeyInZone } from "./shared.js";
import { createEditOrderAddressController } from "./editOrderAddress.js";
import { mapsApiKey } from "./firebaseWebConfig.js";
import { customerMatches, fold, orderTotals } from "./aiOrderModel.js";

const el = id => document.getElementById(id);
const escape = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const button = el("ai-fill-button");
const stylesheet = document.createElement("link");
stylesheet.rel = "stylesheet";
stylesheet.href = new URL("./aiOrder.css", import.meta.url).href;
document.head.append(stylesheet);
const dialog = document.createElement("dialog");
dialog.id = "ai-order-dialog";
dialog.className = "edit-dialog";
dialog.setAttribute("aria-labelledby", "ai-title");
dialog.setAttribute("aria-describedby", "ai-intro");
dialog.innerHTML = `
  <header class="ai-dialog-header"><div><h2 id="ai-title">AI fill</h2><p id="ai-intro">Paste a message. Review the order before saving.</p></div><button type="button" id="ai-close" class="ghost" aria-label="Close AI fill">Close</button></header>
  <div class="ai-dialog-body">
  <ol class="ai-steps" aria-label="Order preparation"><li id="ai-step-paste" aria-current="step"><span>1</span> Paste message</li><li id="ai-step-review"><span>2</span> Review order</li></ol>
  <div id="ai-paste-step">
    <label for="ai-message">Customer's order message</label><p id="ai-message-help" class="ai-field-help">Paste it as received — spelling mistakes are okay.</p><textarea id="ai-message" aria-describedby="ai-message-help ai-privacy" rows="7" maxlength="5000" placeholder="Name: Varvara&#10;Address: 54 Lê Thước&#10;84329708584&#10;3 x Vikoda jugs"></textarea>
    <aside class="ai-notice" id="ai-privacy"><strong>Before you paste</strong><p>This message is sent to Google's free Gemini service, which may use it to improve its products. Your customer directory stays in this app.</p></aside>
    <button type="button" id="ai-read" class="primary">Fill draft</button>
  </div>
  <form id="ai-review" hidden>
    <h3 id="ai-review-heading" tabindex="-1">Review your draft</h3><p>Check every suggestion below. Nothing has been saved.</p>
    <div id="ai-warnings" role="status"></div>
    <fieldset><legend>Customer</legend>
      <label>Name<input id="ai-name" required maxlength="150"></label>
      <label>Phone<input id="ai-phone" required maxlength="40" inputmode="tel"></label>
      <label>Search existing customers<input id="ai-search" placeholder="Name, phone or address"></label>
      <label>Customer match<select id="ai-customer" required></select></label>
      <p id="ai-customer-info" class="muted"></p>
    </fieldset>
    <fieldset><legend>Delivery</legend>
      <label>Order delivery address<input id="ai-address" required maxlength="500" autocomplete="off"></label>
      <p class="muted">Changing this address affects this order only. Existing customer details are kept.</p>
      <div id="ai-address-autocomplete-list" hidden></div>
      <div class="button-row"><button type="button" id="ai-address-verify" class="secondary">Find on Google Maps</button><button type="button" id="ai-address-reset-pin" class="ghost">Reset pin</button></div>
      <p id="ai-address-status" role="status"></p>
      <div id="ai-address-map-wrap" hidden><div id="ai-address-map" style="height:260px;width:100%"></div><button type="button" id="ai-address-confirm" class="primary">Use this address</button></div>
      <label>Delivery date<input id="ai-date" type="date" required></label>
      <label>Delivery notes<textarea id="ai-notes" maxlength="1500" rows="2"></textarea></label>
    </fieldset>
    <fieldset><legend>Products</legend><p>Check suggested spelling corrections and quantities.</p><div id="ai-items"></div>
      <button type="button" class="secondary" id="ai-add-item">Add product</button>
    </fieldset>
    <p id="ai-totals"></p>
    <label class="ai-review-confirm"><input type="checkbox" id="ai-reviewed" required><span>I checked the customer, delivery details, products, quantities and total.</span></label>
    <div class="button-row ai-review-actions"><button type="submit" id="ai-save" class="primary">Create order</button><button type="button" id="ai-back" class="ghost">Back to message</button></div>
  </form>
  <p id="ai-status" role="status" aria-live="polite" aria-atomic="true"></p></div>`;
document.body.append(dialog);
let customers = [], products = [], draft = null, selectedCustomer = "", requestId = "", busy = false;
let mapsPromise;
function loadMaps() {
  if (window.google?.maps) return Promise.resolve(window.google.maps);
  if (!mapsPromise) mapsPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(mapsApiKey)}&v=weekly`;
    script.onload = () => resolve(window.google.maps);
    script.onerror = () => { mapsPromise = null; reject(new Error("Google Maps could not load. Try again.")); };
    document.head.append(script);
  });
  return mapsPromise;
}
const addressController = createEditOrderAddressController({ loadMaps, getElement: id => el(id.replace(/^edit-/, "ai-")) });
const status = message => { el("ai-status").textContent = message; };
function lock(value) {
  busy = value;
  dialog.setAttribute("aria-busy", String(value));
  ["ai-read", "ai-save", "ai-back", "ai-close"].forEach(id => { el(id).disabled = value; });
  el("ai-review").inert = value;
  el("ai-message").disabled = value;
}
dialog.addEventListener("cancel", event => { if (busy) event.preventDefault(); });
onAuthStateChanged(auth, () => { if (!auth.currentUser) { dialog.close(); el("ai-message").value = ""; draft = null; } });
button.addEventListener("click", () => { if (!busy) { status(""); document.documentElement.classList.add("ai-order-open"); dialog.showModal(); dialog.scrollTop = 0; (el("ai-review").hidden ? el("ai-message") : el("ai-review-heading")).focus({ preventScroll: true }); } });
dialog.addEventListener("close", () => { document.documentElement.classList.remove("ai-order-open"); if (auth.currentUser) button.focus(); });
el("ai-close").onclick = () => dialog.close();
function showStep(review) {
  el("ai-step-paste").toggleAttribute("aria-current", !review);
  el("ai-step-review").toggleAttribute("aria-current", review);
  el(review ? "ai-step-review" : "ai-step-paste").setAttribute("aria-current", "step");
}
el("ai-back").onclick = () => { el("ai-review").hidden = true; el("ai-paste-step").hidden = false; showStep(false); status(""); dialog.scrollTop = 0; el("ai-message").focus({ preventScroll: true }); };

function matchOptions() {
  const previous = el("ai-customer").value;
  const matches = customerMatches({ name: el("ai-name").value, phone: el("ai-phone").value, address: el("ai-address").value }, customers, normalizePhoneE164VN);
  const search = fold(el("ai-search").value);
  const choices = search ? customers.filter(c => c.archived !== true && fold(`${c.name} ${c.phone} ${c.address}`).includes(search)).map(customer => ({ customer, reason: "Search result" })) : matches;
  el("ai-customer").innerHTML = '<option value="">Choose a customer or create new…</option>'
    + choices.map(({ customer: c, reason }) => `<option value="${escape(c.id)}">${escape(reason)}: ${escape(c.name)} · ${escape(c.phone)} · ${escape(c.address)}</option>`).join("")
    + '<option value="__new__">Create a new customer — none of these match</option>';
  if (choices.some(m => m.customer.id === selectedCustomer) && !choices.some(m => m.customer.id === previous)) {
    el("ai-customer").value = selectedCustomer;
  } else if (previous && [...el("ai-customer").options].some(o => o.value === previous)) el("ai-customer").value = previous;
  else if (!selectedCustomer && matches.filter(m => m.exact).length === 1 && !search) el("ai-customer").value = matches.find(m => m.exact).customer.id;
  else if (selectedCustomer && selectedCustomer !== "__new__") {
    const c = customers.find(c => c.id === selectedCustomer);
    if (c) { const option = new Option(`Selected: ${c.name} · ${c.phone}`, c.id); el("ai-customer").add(option); el("ai-customer").value = c.id; }
  }
  el("ai-customer-info").textContent = matches.length ? `${matches.length} possible match(es). Check the phone, name and address before choosing. No profile will be overwritten.` : "No close matches found. Check the details, then choose Create a new customer.";
}
function selectCustomer() {
  selectedCustomer = el("ai-customer").value;
  const c = customers.find(c => c.id === selectedCustomer);
  if (c) {
    if (!el("ai-name").value) el("ai-name").value = c.name || "";
    if (!el("ai-phone").value) el("ai-phone").value = c.phone || "";
    if (!el("ai-address").value) el("ai-address").value = c.address || "";
    const address = el("ai-address").value.trim();
    const saved = (c.addressLocations || []).find(a => fold(a.address) === fold(address));
    const pin = saved || (fold(c.address) === fold(address) ? c.location : null);
    addressController.reset(pin ? { address, deliveryLocation: pin } : undefined);
    el("ai-customer-info").textContent = `Using ${c.name} · ${c.phone}. The saved profile will be kept; the address below is for this order.`;
  } else { addressController.reset(); }
  el("ai-reviewed").checked = false;
}
function readItems() {
  return [...el("ai-items").querySelectorAll("[data-line]")].map(row => ({ productId: row.querySelector("select").value, quantity: Number(row.querySelector("input").value) }));
}
function totals() {
  const t = orderTotals(readItems(), products);
  el("ai-totals").innerHTML = `<span class="ai-total-row"><span>Products</span><strong>${escape(formatCurrency(t.subtotal))}</strong></span><span class="ai-total-row"><span>Deposits</span><strong>${escape(formatCurrency(t.depositTotal))}</strong></span><span class="ai-total-row ai-grand-total"><span>Total due</span><strong>${escape(formatCurrency(t.subtotal + t.depositTotal))}</strong></span>`;
  return t.subtotal + t.depositTotal;
}
function renderItems(items) {
  el("ai-items").innerHTML = items.map((item, i) => `<div data-line="${i}" class="ai-product-line">
    <p class="ai-product-original"><strong>From the message:</strong> ${escape(item.original || "Added product")}</p>${item.reason ? `<p class="ai-product-reason"><strong>AI suggestion:</strong> ${escape(item.reason)}</p>` : ""}
    <label>Product<select required><option value="">Choose the correct product…</option>${products.map(p => `<option value="${escape(p.id)}"${p.id === item.productId ? " selected" : ""}>${escape(p.productName)} · ${escape(formatCurrency(p.unitPrice))}</option>`).join("")}</select></label>
    <label>Quantity<input type="number" min="1" max="999" step="1" required value="${escape(item.quantity ?? "")}"></label>
    <button type="button" class="ghost" data-remove="${i}" aria-label="Remove product line ${i + 1}">Remove line</button>
  </div>`).join("");
  totals();
}
el("ai-items").addEventListener("click", event => {
  const remove = event.target.closest("[data-remove]");
  if (remove) { remove.closest("[data-line]").remove(); totals(); el("ai-reviewed").checked = false; }
});
el("ai-add-item").onclick = () => { const items = readItems(); if (items.length < 30) renderItems([...items, { productId: "", quantity: 1 }]); };
el("ai-review").addEventListener("input", event => {
  if (event.target.id !== "ai-reviewed") el("ai-reviewed").checked = false;
  if (["ai-name", "ai-phone", "ai-search", "ai-address"].includes(event.target.id)) matchOptions();
  if (event.target.closest("#ai-items")) totals();
});
el("ai-customer").onchange = selectCustomer;
el("ai-read").onclick = async () => {
  if (!el("ai-message").value.trim()) { status("Paste the customer's message first."); return; }
  lock(true); status("Reading the message and checking the catalogue…");
  try {
    const snapshots = await Promise.all([getDocs(collection(db, "customers")), getDocs(collection(db, "products"))]);
    customers = snapshots[0].docs.map(d => ({ ...d.data(), id: d.id }));
    products = snapshots[1].docs.map(d => ({ ...d.data(), id: d.id })).filter(p => p.active === true);
    const result = await httpsCallable(functions, "parseAiOrder")({ message: el("ai-message").value });
    if (!auth.currentUser) return;
    draft = result.data; selectedCustomer = ""; requestId = crypto.randomUUID();
    el("ai-review").reset();
    ["name", "phone", "address", "notes"].forEach(field => { el(`ai-${field}`).value = draft[field] || ""; });
    el("ai-date").min = todayKeyInZone();
    el("ai-date").value = draft.deliveryDate || todayKeyInZone();
    el("ai-warnings").replaceChildren(...(draft.warnings || []).map(text => { const p = document.createElement("p"); p.textContent = `Check: ${text}`; return p; }));
    matchOptions(); selectCustomer(); renderItems(draft.items);
    el("ai-paste-step").hidden = true; el("ai-review").hidden = false;
    showStep(true);
    dialog.scrollTop = 0;
    status("Draft ready. Review all fields and confirm the delivery pin.");
  } catch (error) { status(error.message || "Could not read the order. Try again."); }
  finally { lock(false); if (!el("ai-review").hidden) el("ai-review-heading").focus({ preventScroll: true }); }
};
el("ai-review").onsubmit = async event => {
  event.preventDefault();
  if (busy) return;
  const customerId = el("ai-customer").value;
  const address = el("ai-address").value.trim();
  const phone = normalizePhoneE164VN(el("ai-phone").value);
  if (!phone) { status("Check the phone number, including its country code."); return; }
  const deliveryLocation = addressController.confirmedFor(address);
  if (!deliveryLocation) { status("Confirm this delivery address on Google Maps first."); return; }
  if (!readItems().length) { status("Add at least one product."); return; }
  if (customerId === "__new__" && customers.some(c => c.archived !== true && [c.phone, c.secondaryPhone].some(p => normalizePhoneE164VN(p) === phone))) {
    status("An existing customer has this phone. Choose that customer before saving."); return;
  }
  lock(true); status("Creating the reviewed order…");
  try {
    const result = await httpsCallable(functions, "saveAiOrder")({ requestId,
      customerId: customerId === "__new__" ? null : customerId,
      name: el("ai-name").value, phone, address, deliveryLocation,
      deliveryDate: el("ai-date").value, notes: el("ai-notes").value,
      items: readItems(), reviewedTotal: totals()
    });
    el("ai-message").value = "";
    location.href = `./order.html?id=${encodeURIComponent(result.data.orderId)}`;
  } catch (error) { status(error.message || "Could not save the order. Retry with the same draft."); }
  finally { lock(false); }
};

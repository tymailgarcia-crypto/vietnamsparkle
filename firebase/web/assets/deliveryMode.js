import { auth, db, doc, onAuthStateChanged, onSnapshot } from "./firebaseClient.js";
import { formatCurrency, normalizePhoneE164VN } from "./shared.js";
import { coordinates, createLiveRouting } from "./deliveryRouting.js";
import { returnDeliveryToAssignment } from "./returnDelivery.js";

const stylesheet = document.createElement("link");
stylesheet.rel = "stylesheet";
stylesheet.href = new URL("./deliveryMode.css", import.meta.url).href;
document.head.append(stylesheet);

const dock = document.createElement("aside");
dock.className = "delivery-mode-dock";
dock.setAttribute("aria-label", "Active delivery");
dock.hidden = true;
dock.innerHTML = '<div class="delivery-mode-dock-customer"><small>Active delivery</small><strong></strong></div><div class="delivery-mode-dock-actions"><button type="button" class="delivery-mode-end" data-end-delivery>End delivery</button><a class="button-link primary">Resume ↑</a></div><p data-end-status role="status" hidden></p>';
document.body.append(dock);

let storageKey = "";
let pinnedId = "";
let stopWatching;
let activeOrder;
let panel;
let openingOrder;
let lastStop;

function readPin() {
  const key = storageKey || (auth.currentUser && `vs-active-delivery:${auth.currentUser.uid}`);
  try { return key ? localStorage.getItem(key) || "" : ""; } catch { return ""; }
}

function renderDock() {
  dock.hidden = !pinnedId || !activeOrder || !!panel?.open;
  document.body.classList.toggle("has-active-delivery", !dock.hidden);
  if (dock.hidden) return;
  dock.querySelector("strong").textContent = activeOrder.customerName || pinnedId;
  dock.querySelector("a").href = `./order.html?id=${encodeURIComponent(pinnedId)}&delivery=resume`;
}

function setPanelUrl(expanded) {
  const url = new URL(location.href);
  if (expanded) url.searchParams.set("delivery", "resume");
  else url.searchParams.delete("delivery");
  history.replaceState(history.state, "", url);
}

function watchPin(id, order = null) {
  if (id === pinnedId && !order) return;
  stopWatching?.();
  if (id !== pinnedId) {
    dock.querySelector("[data-end-status]").hidden = true;
    if (panel?.open) panel.close();
    lastStop?.onUnpin();
    lastStop = null;
  }
  pinnedId = id;
  activeOrder = order;
  renderDock();
  if (!id) return;
  stopWatching = onSnapshot(doc(db, "orders", id), { includeMetadataChanges: true }, (snapshot) => {
    if (pinnedId !== id) return;
    const current = snapshot.data();
    if (current?.status === "out_for_delivery") {
      activeOrder = { ...current, id };
      renderDock();
    } else if (!snapshot.metadata.fromCache && !snapshot.metadata.hasPendingWrites) {
      finishDeliveryMode(id);
    }
  }, () => {
    // Preserve the pin on a connection error so a later reload can retry.
    renderDock();
  });
}

function savePin(id, order) {
  try {
    if (id) localStorage.setItem(storageKey, id);
    else localStorage.removeItem(storageKey);
  } catch { /* The current page can still hold the active stop. */ }
  watchPin(id, order);
}

onAuthStateChanged(auth, async (user) => {
  if (user && storageKey === `vs-active-delivery:${user.uid}`) return;
  storageKey = "";
  watchPin("");
  if (!user) return;
  const token = await user.getIdTokenResult().catch(() => null);
  if (auth.currentUser?.uid !== user.uid || token?.claims.role !== "owner") return;
  storageKey = `vs-active-delivery:${user.uid}`;
  watchPin(readPin());
});

window.addEventListener("storage", (event) => {
  if (storageKey && (event.key === storageKey || event.key === null)) watchPin(readPin());
});

dock.querySelector("a").addEventListener("click", (event) => {
  if (!lastStop || lastStop.order.id !== pinnedId || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  showStop({ ...lastStop, order: activeOrder });
});

dock.querySelector("[data-end-delivery]").addEventListener("click", async (event) => {
  const id = pinnedId;
  const button = event.currentTarget;
  if (!id || button.disabled || !window.confirm("End this delivery attempt and return the order to Assigned? The assigned driver will be kept.")) return;
  const status = dock.querySelector("[data-end-status]");
  button.disabled = true;
  status.hidden = false;
  status.textContent = "Ending delivery…";
  try {
    if (lastStop?.order.id === id && lastStop.returnForAnotherAttempt) {
      await lastStop.returnForAnotherAttempt();
    } else {
      await returnDeliveryToAssignment(id);
    }
    finishDeliveryMode(id);
  } catch (error) {
    if (pinnedId === id) {
      status.textContent = error.message || "Could not end delivery. Try again.";
    }
  } finally {
    button.disabled = false;
  }
});

export function finishDeliveryMode(id) {
  if (pinnedId !== id) return;
  const persisted = readPin();
  if (persisted && persisted !== id) watchPin(persisted);
  else savePin("");
}

export function isDeliveryModeOpen(id) {
  return pinnedId === id && !!panel?.open;
}

export async function openDeliveryMode(details) {
  const { order, start } = details;
  const uid = auth.currentUser?.uid;
  if (openingOrder || !uid || panel?.open) return;
  if (order.status !== "out_for_delivery" && !start) return;
  const previousId = pinnedId || readPin();
  if (previousId && previousId !== order.id &&
      !window.confirm("Switch your active delivery to this order? The previous order will still be out for delivery.")) return;
  openingOrder = order.id;
  try {
    if (start) await start();
    if (auth.currentUser?.uid !== uid) return;
    storageKey ||= `vs-active-delivery:${uid}`;
    savePin(order.id, { ...order, status: "out_for_delivery" });
    showStop(details);
  } finally {
    openingOrder = null;
  }
}

export function resumeDeliveryMode(details) {
  const mode = new URLSearchParams(location.search).get("delivery");
  if (mode === "open" || (mode === "resume" && (pinnedId || readPin()) === details.order.id)) {
    return openDeliveryMode(details);
  }
}

async function showDeliveryMap(dialog, destination, savedPin, loadMaps) {
  const canvas = dialog.querySelector("[data-map]");
  const status = dialog.querySelector("[data-map-status]");
  if (!destination) {
    status.textContent = "No delivery pin or address saved.";
    return;
  }

  try {
    await loadMaps();
    if (!dialog.open) return;
    const maps = window.google.maps;
    let position = savedPin;
    if (!position) {
      const { results } = await new maps.Geocoder().geocode({ address: destination, region: "vn" });
      position = results[0]?.geometry.location;
      if (!position) throw new Error("Address could not be located");
    }
    if (!dialog.open) return;
    const map = new maps.Map(canvas, {
      center: position,
      zoom: 16,
      mapTypeControl: false,
      streetViewControl: false,
      fullscreenControl: false,
      gestureHandling: "greedy"
    });
    new maps.Marker({ map, position, title: savedPin ? "Delivery pin" : "Approximate address" });
    status.textContent = savedPin ? "Delivery pin" : "Approximate address";
    const cleanup = createLiveRouting({ dialog, map, maps, destination: coordinates(position) });
    dialog.addEventListener("close", cleanup, { once: true });
    dialog.querySelector("[data-start-routing]").disabled = !navigator.geolocation;
  } catch {
    if (dialog.open) status.textContent = "Map unavailable. Open Order details to use Google Maps.";
  }
}

function showStop(details) {
  const { order, customer, items, markDelivered, loadMaps, returnForAnotherAttempt } = details;
  lastStop = details;
  const dialog = document.createElement("dialog");
  dialog.className = "delivery-mode-panel";
  dialog.setAttribute("aria-labelledby", "delivery-mode-title");
  dialog.innerHTML = `
    <section class="delivery-mode-map" aria-label="Delivery map">
      <header><button type="button" class="secondary" data-minimize>Minimize ↓</button></header>
      <div data-map></div><p data-map-status role="status">Loading map…</p>
      <div class="delivery-mode-guidance" data-guidance hidden>
        <strong data-instruction role="status"></strong>
        <span data-route-detail></span><small data-screen-status></small>
      </div>
      <button type="button" class="secondary delivery-mode-follow" data-follow-routing hidden>Follow my location</button>
      <div class="delivery-mode-routing-controls">
        <button type="button" class="primary" data-start-routing disabled>Start navigation</button>
        <button type="button" class="delivery-mode-stop" data-stop-routing hidden>Stop navigation</button>
      </div>
    </section>
    <div class="delivery-mode-details">
      <button type="button" class="delivery-mode-sheet-grip" data-order-info aria-label="Expand order details" aria-expanded="false" aria-controls="delivery-mode-extra">
        <span class="delivery-mode-grab-bar" aria-hidden="true"></span>
        <span class="delivery-mode-customer"><strong id="delivery-mode-title"></strong><span data-customer-address></span></span>
        <span class="delivery-mode-expand-cue" aria-hidden="true">⌃</span>
      </button>
      <div class="delivery-mode-links" aria-label="Delivery shortcuts"><button type="button" class="secondary" data-deliver>Mark delivered</button></div>
      <section id="delivery-mode-extra" class="delivery-mode-order-info" aria-label="Order details" hidden>
      <strong data-customer-name></strong><small data-order></small><p data-address></p>
      <div class="delivery-mode-summary">
        <strong>Items to deliver</strong><ul></ul>
        <div><span>Due before returns</span><strong data-due></strong></div>
      </div>
      <a class="button-link ghost" data-navigate target="_blank" rel="noopener">Open Google Maps</a>
      <button type="button" class="secondary" data-return-attempt>Return for another attempt</button>
      <p data-return-status role="status"></p>
      <button type="button" class="ghost" data-leave>Leave delivery mode</button>
      </section>
    </div>`;
  dialog.querySelector("[data-order]").textContent = `${order.id} · Out for delivery`;
  dialog.querySelector("#delivery-mode-title").textContent = order.customerName || customer.name || "Customer";
  dialog.querySelector("[data-customer-name]").textContent = order.customerName || customer.name || "Customer";
  dialog.querySelector("[data-address]").textContent = order.address || "No delivery address saved";
  dialog.querySelector("[data-customer-address]").textContent = order.address || "No delivery address saved";
  dialog.querySelector("[data-due]").textContent = formatCurrency(order.balanceDue);
  const list = dialog.querySelector("ul");
  for (const item of items) {
    const row = document.createElement("li");
    row.textContent = `${item.quantity} × ${item.productName || item.productId || "Item"}`;
    list.append(row);
  }
  list.hidden = !items.length;
  const pin = order.deliveryLocation;
  const lat = Number(pin?.lat ?? pin?.latitude ?? NaN);
  const lng = Number(pin?.lng ?? pin?.longitude ?? NaN);
  const savedPin = Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
  const destination = savedPin ? `${lat},${lng}` : String(order.address || "").trim();
  const navigation = dialog.querySelector("[data-navigate]");
  if (destination) {
    navigation.href = `https://www.google.com/maps/dir/?${new URLSearchParams({ api: "1", destination, dir_action: "navigate" })}`;
  } else {
    navigation.hidden = true;
    dialog.querySelector("[data-start-routing]").hidden = true;
  }
  const phone = normalizePhoneE164VN(order.phone || customer.phone);
  const shortcuts = [
    ["Message", phone && `sms:${phone}`],
    ["Call", phone && `tel:${phone}`]
  ];
  const links = dialog.querySelector(".delivery-mode-links");
  const complete = links.querySelector("[data-deliver]");
  for (const [label, href] of shortcuts) {
    const link = document.createElement(href ? "a" : "button");
    link.className = "button-link secondary";
    link.textContent = label;
    if (href) link.href = href;
    else { link.type = "button"; link.disabled = true; }
    links.insertBefore(link, complete);
  }
  dialog.querySelector("[data-minimize]").onclick = () => dialog.close();
  const info = dialog.querySelector(".delivery-mode-order-info");
  const sheet = dialog.querySelector(".delivery-mode-details");
  const grip = dialog.querySelector("[data-order-info]");
  let swipeStart = null;
  let suppressClickUntil = 0;
  function expandDetails(expanded) {
    sheet.classList.toggle("is-expanded", expanded);
    info.hidden = !expanded;
    grip.setAttribute("aria-expanded", String(expanded));
    grip.setAttribute("aria-label", expanded ? "Collapse order details" : "Expand order details");
  }
  grip.onclick = () => {
    if (Date.now() >= suppressClickUntil) expandDetails(info.hidden);
  };
  grip.addEventListener("pointerdown", (event) => {
    if (!event.isPrimary || event.button !== 0) return;
    swipeStart = event.clientY;
    grip.setPointerCapture(event.pointerId);
  });
  grip.addEventListener("pointerup", (event) => {
    if (swipeStart === null) return;
    const distance = event.clientY - swipeStart;
    swipeStart = null;
    if (Math.abs(distance) < 35) return;
    suppressClickUntil = Date.now() + 350;
    expandDetails(distance < 0);
  });
  grip.addEventListener("pointercancel", () => { swipeStart = null; });
  dialog.addEventListener("cancel", (event) => {
    if (!info.hidden) { event.preventDefault(); expandDetails(false); }
  });
  dialog.querySelector("[data-leave]").onclick = () => {
    if (window.confirm("Leave Delivery Mode? This order will still be out for delivery.")) finishDeliveryMode(order.id);
  };
  const returnButton = dialog.querySelector("[data-return-attempt]");
  returnButton.hidden = !returnForAnotherAttempt;
  returnButton.onclick = async () => {
    if (returnButton.disabled || !window.confirm("Return this order to Assigned for another delivery attempt? The active stop will close and the assigned driver will be kept.")) return;
    const status = dialog.querySelector("[data-return-status]");
    returnButton.disabled = true;
    status.textContent = "Returning order…";
    try {
      await returnForAnotherAttempt();
    } catch (error) {
      status.textContent = error.message || "Could not return the order. Try again.";
    } finally {
      returnButton.disabled = false;
    }
  };
  dialog.querySelector("[data-deliver]").onclick = markDelivered;
  dialog.addEventListener("close", () => {
    dialog.remove();
    if (panel !== dialog) return;
    panel = null;
    setPanelUrl(false);
    renderDock();
  });
  panel = dialog;
  document.body.append(dialog);
  dialog.showModal();
  void showDeliveryMap(dialog, destination, savedPin, loadMaps);
  setPanelUrl(true);
  renderDock();
}

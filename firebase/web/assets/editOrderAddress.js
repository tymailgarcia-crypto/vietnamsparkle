const DA_NANG_BOUNDS = Object.freeze({
  west: 108.05,
  south: 15.90,
  east: 108.35,
  north: 16.20
});

function insideDeliveryArea(position) {
  const lat = Number(typeof position?.lat === "function" ? position.lat() : position?.lat);
  const lng = Number(typeof position?.lng === "function" ? position.lng() : position?.lng);
  return Number.isFinite(lat) && Number.isFinite(lng)
    && lat >= DA_NANG_BOUNDS.south && lat <= DA_NANG_BOUNDS.north
    && lng >= DA_NANG_BOUNDS.west && lng <= DA_NANG_BOUNDS.east;
}

function installStyles() {
  if (document.getElementById("edit-order-address-styles")) return;
  const style = document.createElement("style");
  style.id = "edit-order-address-styles";
  style.textContent = `
    .edit-address-autocomplete { position:relative; z-index:4; display:grid; border:1px solid var(--line); border-radius:10px; overflow:hidden; background:#fff; box-shadow:0 8px 24px rgba(17,34,45,.14); }
    .edit-address-autocomplete[hidden] { display:none; }
    .edit-address-suggestion { width:100%; min-height:42px; padding:9px 12px; border:0; border-bottom:1px solid var(--line); border-radius:0; background:#fff; color:var(--ink); text-align:left; font:inherit; }
    .edit-address-suggestion:hover, .edit-address-suggestion[aria-selected="true"] { background:#eef6f1; }
    .edit-address-attribution { padding:5px 12px; color:var(--muted); font-size:11px; text-align:right; }
    .edit-address-map-actions { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
    @media (max-width:640px) { .edit-address-map-actions, .edit-address-map-actions button { width:100%; } }
  `;
  document.head.appendChild(style);
}

export function createEditOrderAddressController({ loadMaps, getElement = (id) => document.getElementById(id) }) {
  installStyles();
  const el = getElement;
  const input = el("edit-address");
  const searchButton = el("edit-address-verify");
  const confirmButton = el("edit-address-confirm");
  const resetButton = el("edit-address-reset-pin");
  const mapWrap = el("edit-address-map-wrap");
  const mapNode = el("edit-address-map");
  const suggestionsNode = el("edit-address-autocomplete-list");
  const statusNode = el("edit-address-status");

  const state = {
    map: null,
    marker: null,
    infoWindow: null,
    geocoder: null,
    pending: null,
    confirmed: null,
    confirmedForAddress: "",
    freshConfirmation: false,
    formattedAddress: "",
    approximate: false,
    autocompleteTimer: null,
    autocompleteRequestId: 0,
    predictions: [],
    activePrediction: -1,
    reverseLookupId: 0
  };

  function setStatus(message, isError = false) {
    if (!statusNode) return;
    statusNode.textContent = message || "";
    statusNode.style.color = isError ? "var(--danger, #b3261e)" : "var(--muted)";
  }

  function closeSuggestions() {
    state.autocompleteRequestId += 1;
    state.predictions = [];
    state.activePrediction = -1;
    suggestionsNode?.replaceChildren();
    if (suggestionsNode) suggestionsNode.hidden = true;
    input?.setAttribute("aria-expanded", "false");
    input?.removeAttribute("aria-activedescendant");
  }

  function setActiveSuggestion(index) {
    if (!state.predictions.length) return;
    state.activePrediction = (index + state.predictions.length) % state.predictions.length;
    suggestionsNode?.querySelectorAll("[role='option']").forEach((node, optionIndex) => {
      const active = optionIndex === state.activePrediction;
      node.setAttribute("aria-selected", String(active));
      if (active) input?.setAttribute("aria-activedescendant", node.id);
    });
  }

  function renderSuggestions(predictions) {
    if (!suggestionsNode || !input) return;
    state.predictions = predictions.slice(0, 5);
    state.activePrediction = -1;
    suggestionsNode.replaceChildren();
    if (!state.predictions.length) {
      closeSuggestions();
      return;
    }
    state.predictions.forEach((prediction, index) => {
      const button = document.createElement("button");
      button.id = `edit-address-autocomplete-option-${index}`;
      button.type = "button";
      button.className = "edit-address-suggestion";
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", "false");
      button.textContent = String(prediction.text || "");
      button.addEventListener("mouseenter", () => setActiveSuggestion(index));
      button.addEventListener("click", () => void chooseSuggestion(prediction));
      suggestionsNode.appendChild(button);
    });
    const attribution = document.createElement("div");
    attribution.className = "edit-address-attribution";
    attribution.setAttribute("translate", "no");
    attribution.textContent = "Google Maps";
    suggestionsNode.appendChild(attribution);
    suggestionsNode.hidden = false;
    input.setAttribute("aria-expanded", "true");
  }

  async function fetchSuggestions() {
    const queryText = String(input?.value || "").trim();
    if (queryText.length < 3) {
      closeSuggestions();
      return;
    }
    const requestId = ++state.autocompleteRequestId;
    try {
      const maps = await loadMaps();
      const { AutocompleteSuggestion } = await maps.importLibrary("places");
      const { suggestions } = await AutocompleteSuggestion.fetchAutocompleteSuggestions({
        input: queryText,
        includedRegionCodes: ["vn"],
        region: "vn",
        language: document.documentElement.lang || "en",
        locationRestriction: DA_NANG_BOUNDS
      });
      if (requestId !== state.autocompleteRequestId || queryText !== String(input.value || "").trim()) return;
      renderSuggestions((suggestions || []).map((item) => item.placePrediction).filter(Boolean));
    } catch (error) {
      if (requestId === state.autocompleteRequestId) closeSuggestions();
      console.warn("Google address suggestions unavailable; manual search remains enabled.", error);
    }
  }

  function scheduleSuggestions() {
    clearTimeout(state.autocompleteTimer);
    state.autocompleteTimer = setTimeout(() => void fetchSuggestions(), 320);
  }

  function invalidateConfirmation(message = "Address changed — choose a suggestion or find it on the map again.") {
    state.pending = null;
    state.confirmed = null;
    state.confirmedForAddress = "";
    state.freshConfirmation = false;
    state.infoWindow?.close();
    if (mapWrap) mapWrap.hidden = true;
    setStatus(message, true);
  }

  function capture(position, formattedAddress = state.formattedAddress) {
    state.pending = {
      lat: position.lat(),
      lng: position.lng(),
      formattedAddress: String(formattedAddress || input?.value || "").slice(0, 499),
      geocodedAt: new Date().toISOString()
    };
    state.confirmed = null;
    state.confirmedForAddress = "";
    state.freshConfirmation = false;
  }

  function confirmCurrent() {
    if (!state.pending || !input) return;
    state.confirmed = { ...state.pending };
    state.confirmedForAddress = input.value.trim();
    state.freshConfirmation = true;
    state.infoWindow?.close();
    setStatus("✓ Address and delivery pin confirmed.");
  }

  function showConfirmationPopup() {
    if (!state.map || !state.marker) return;
    const content = document.createElement("div");
    content.style.maxWidth = "240px";
    const title = document.createElement("strong");
    title.textContent = "Is this the delivery entrance?";
    const detail = document.createElement("p");
    detail.style.margin = "6px 0 10px";
    detail.textContent = state.approximate
      ? "Google found an approximate match. Drag the pin if needed, or confirm it here."
      : "Drag the pin if it needs correcting, or confirm it here.";
    const address = document.createElement("p");
    address.style.margin = "0 0 10px";
    address.style.overflowWrap = "anywhere";
    address.textContent = state.formattedAddress;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "primary";
    button.style.width = "100%";
    button.textContent = "Use this address";
    button.addEventListener("click", confirmCurrent);
    content.append(title, detail, address, button);
    state.infoWindow = state.infoWindow || new google.maps.InfoWindow({ maxWidth: 280 });
    state.infoWindow.setContent(content);
    state.infoWindow.open({ map: state.map, anchor: state.marker });
  }

  async function findAddress() {
    const address = String(input?.value || "").trim();
    if (address.length < 5) {
      setStatus("Enter a fuller delivery address first.", true);
      return;
    }
    searchButton.disabled = true;
    setStatus("Searching Google Maps...");
    closeSuggestions();
    state.pending = null;
    state.confirmed = null;
    state.confirmedForAddress = "";
    state.freshConfirmation = false;
    state.infoWindow?.close();
    try {
      await loadMaps();
      state.geocoder = state.geocoder || new google.maps.Geocoder();
      const match = await new Promise((resolve, reject) => {
        state.geocoder.geocode({
          address,
          region: "vn",
          componentRestrictions: { country: "vn" },
          bounds: new google.maps.LatLngBounds(
            { lat: DA_NANG_BOUNDS.south, lng: DA_NANG_BOUNDS.west },
            { lat: DA_NANG_BOUNDS.north, lng: DA_NANG_BOUNDS.east }
          )
        }, (results, resultStatus) => {
          if (resultStatus === "OK" && results?.[0]) resolve(results[0]);
          else reject(new Error("We couldn't find that address. Add a district or nearby landmark and try again."));
        });
      });
      const position = match.geometry.location;
      if (!insideDeliveryArea(position)) {
        throw new Error("Google Maps found a result outside the Da Nang delivery area. Choose a Da Nang suggestion or enter a more complete local address.");
      }
      state.formattedAddress = String(match.formatted_address || address);
      state.approximate = Boolean(match.partial_match);
      mapWrap.hidden = false;
      state.map = state.map || new google.maps.Map(mapNode, {
        center: position,
        zoom: 17,
        streetViewControl: false,
        mapTypeControl: false,
        fullscreenControl: false
      });
      google.maps.event.trigger(state.map, "resize");
      state.map.setCenter(position);
      if (state.marker) state.marker.setMap(null);
      state.marker = new google.maps.Marker({
        map: state.map,
        position,
        draggable: true,
        title: "Drag to the delivery entrance"
      });
      capture(position);
      setStatus(state.approximate
        ? "Check the approximate pin, move it if needed, then choose Use this address."
        : "Check the pin, then choose Use this address.");
      showConfirmationPopup();
      state.marker.addListener("dragstart", () => {
        state.reverseLookupId += 1;
        state.pending = null;
        state.confirmed = null;
        state.confirmedForAddress = "";
        state.freshConfirmation = false;
        state.infoWindow?.close();
        setStatus("Pin moved — check its position, then confirm it.");
      });
      state.marker.addListener("dragend", async () => {
        const draggedPosition = state.marker.getPosition();
        const lookupId = ++state.reverseLookupId;
        state.map.panTo(draggedPosition);
        if (!insideDeliveryArea(draggedPosition)) {
          state.pending = null;
          setStatus("That pin is outside the Da Nang delivery area. Move it back into Da Nang to continue.", true);
          return;
        }
        setStatus("Finding the address at the corrected pin...");
        try {
          const reverseMatches = await new Promise((resolve, reject) => {
            state.geocoder.geocode({ location: draggedPosition }, (results, resultStatus) => {
              if (resultStatus === "OK" && results?.[0]) resolve(results);
              else reject(new Error("Google Maps could not find a street address at that pin."));
            });
          });
          if (lookupId !== state.reverseLookupId) return;
          state.formattedAddress = String(reverseMatches[0].formatted_address || address);
          state.approximate = false;
          input.value = state.formattedAddress.slice(0, 499);
          capture(draggedPosition, state.formattedAddress);
          setStatus("Pin moved — check the updated address, then choose Use this address.");
          showConfirmationPopup();
        } catch (error) {
          if (lookupId !== state.reverseLookupId) return;
          state.pending = null;
          setStatus(`${error.message || String(error)} Move the pin again, or edit the address and search again.`, true);
        }
      });
      mapWrap.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } catch (error) {
      state.pending = null;
      if (mapWrap) mapWrap.hidden = true;
      setStatus(error.message || String(error), true);
    } finally {
      searchButton.disabled = false;
    }
  }

  async function chooseSuggestion(prediction) {
    const address = String(prediction?.text || "").trim();
    if (!address || !input) return;
    input.value = address.slice(0, 499);
    invalidateConfirmation("Address selected — checking its pin on Google Maps...");
    closeSuggestions();
    await findAddress();
  }

  function reset(order) {
    closeSuggestions();
    state.pending = null;
    state.freshConfirmation = false;
    state.infoWindow?.close();
    if (mapWrap) mapWrap.hidden = true;
    const existing = order?.deliveryLocation;
    if (existing && Number.isFinite(Number(existing.lat)) && Number.isFinite(Number(existing.lng))) {
      state.confirmed = { ...existing, lat: Number(existing.lat), lng: Number(existing.lng) };
      state.confirmedForAddress = String(order.address || "").trim();
      setStatus("Pin on file. If you change the address, re-check it on the map.");
    } else {
      state.confirmed = null;
      state.confirmedForAddress = "";
      setStatus("Find the address on Google Maps to confirm the delivery pin.");
    }
  }

  function confirmedFor(address) {
    return state.confirmed && state.confirmedForAddress === String(address || "").trim()
      ? { ...state.confirmed }
      : null;
  }

  function hasFreshConfirmationFor(address) {
    return state.freshConfirmation && state.confirmedForAddress === String(address || "").trim();
  }

  searchButton?.addEventListener("click", findAddress);
  confirmButton?.addEventListener("click", confirmCurrent);
  resetButton?.addEventListener("click", () => {
    invalidateConfirmation("Pin reset — find the address on Google Maps again.");
    input?.focus();
  });
  input?.addEventListener("input", () => {
    if (state.confirmed || state.pending || !mapWrap?.hidden) invalidateConfirmation();
    closeSuggestions();
    scheduleSuggestions();
  });
  input?.addEventListener("focus", scheduleSuggestions);
  input?.addEventListener("keydown", (event) => {
    if (!state.predictions.length) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveSuggestion(state.activePrediction + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveSuggestion(state.activePrediction < 0 ? state.predictions.length - 1 : state.activePrediction - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      void chooseSuggestion(state.predictions[Math.max(0, state.activePrediction)]);
    } else if (event.key === "Escape") {
      closeSuggestions();
    }
  });
  input?.addEventListener("blur", () => {
    setTimeout(() => {
      if (!suggestionsNode?.contains(document.activeElement)) closeSuggestions();
    }, 120);
  });

  return { confirmedFor, findAddress, hasFreshConfirmationFor, reset, setStatus };
}

export { DA_NANG_BOUNDS, insideDeliveryArea };

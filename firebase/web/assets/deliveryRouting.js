const EARTH_METERS = 6371000;
const REROUTE_DELAY = 15000;

export function coordinates(value) {
  const lat = typeof value?.lat === "function" ? value.lat() : value?.lat;
  const lng = typeof value?.lng === "function" ? value.lng() : value?.lng;
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
    ? { lat, lng } : null;
}

export function distanceMeters(a, b) {
  const radians = Math.PI / 180;
  const dx = (b.lng - a.lng) * radians * Math.cos((a.lat + b.lat) * radians / 2);
  const dy = (b.lat - a.lat) * radians;
  return EARTH_METERS * Math.hypot(dx, dy);
}

// Project a GPS fix onto road segments, rather than comparing it with sparse
// route vertices. A progress window keeps crossings from skipping ahead.
export function matchRoute(path, point, maxProgress = Infinity) {
  const scaleY = EARTH_METERS * Math.PI / 180;
  const scaleX = scaleY * Math.cos(point.lat * Math.PI / 180);
  let total = 0;
  let best = { distance: Infinity, progress: 0, segment: 0, total: 0 };
  for (let index = 0; index < path.length - 1; index += 1) {
    const a = path[index];
    const b = path[index + 1];
    const ax = (a.lng - point.lng) * scaleX;
    const ay = (a.lat - point.lat) * scaleY;
    const bx = (b.lng - a.lng) * scaleX;
    const by = (b.lat - a.lat) * scaleY;
    const squared = bx * bx + by * by;
    const fraction = squared ? Math.max(0, Math.min(1, -(ax * bx + ay * by) / squared)) : 0;
    const length = distanceMeters(a, b);
    const progress = total + length * fraction;
    const distance = Math.hypot(ax + fraction * bx, ay + fraction * by);
    if (progress <= maxProgress && distance < best.distance) {
      best = { distance, progress, segment: index, total: 0 };
    }
    total += length;
  }
  best.total = total;
  return best;
}

export function usableFix(fix, now = Date.now()) {
  return !!coordinates(fix) && Number.isFinite(fix.accuracy) && fix.accuracy >= 0 && fix.accuracy <= 50
    && Number.isFinite(fix.timestamp) && now - fix.timestamp <= 20000 && now >= fix.timestamp - 5000;
}

export function createLiveRouting({ dialog, map, maps, destination }) {
  const start = dialog.querySelector("[data-start-routing]");
  const stop = dialog.querySelector("[data-stop-routing]");
  const guidance = dialog.querySelector("[data-guidance]");
  const instruction = dialog.querySelector("[data-instruction]");
  const detail = dialog.querySelector("[data-route-detail]");
  const screen = dialog.querySelector("[data-screen-status]");
  const follow = dialog.querySelector("[data-follow-routing]");
  let active = false;
  let disposed = false;
  let watchId = null;
  let timer;
  let wakeLock;
  let wakePending = false;
  let requestId = 0;
  let pending = false;
  let lastRequest = -Infinity;
  let fix;
  let path = [];
  let lines = [];
  let locationMarker;
  let furthest = 0;
  let previousMatch;
  let offRouteSince = 0;
  let following = true;
  let routeUnavailable = false;
  let locationError = false;

  function say(text, extra = "") {
    if (instruction.textContent !== text) instruction.textContent = text;
    if (detail.textContent !== extra) detail.textContent = extra;
  }

  async function keepScreenAwake() {
    if (!active || wakeLock || wakePending || document.hidden) return;
    wakePending = true;
    try {
      const lock = await navigator.wakeLock?.request("screen");
      if (!active || disposed || document.hidden) { await lock?.release(); return; }
      wakeLock = lock;
      screen.textContent = lock ? "Screen kept awake" : "Keep this screen open";
      lock?.addEventListener("release", () => {
        if (wakeLock === lock) wakeLock = null;
        screen.textContent = "Keep this screen open";
      });
    } catch {
      screen.textContent = "Keep this screen open";
    } finally {
      wakePending = false;
    }
  }

  function clearWatch() {
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
    requestId += 1;
    pending = false;
    locationMarker?.setVisible(false);
    wakeLock?.release().catch(() => {});
    wakeLock = null;
  }

  function stopRouting() {
    active = false;
    clearWatch();
    clearInterval(timer);
    fix = null;
    path = [];
    previousMatch = null;
    furthest = 0;
    offRouteSince = 0;
    locationError = false;
    lines.forEach((line) => line.setMap(null));
    lines = [];
    start.hidden = false;
    stop.hidden = true;
    follow.hidden = true;
    guidance.hidden = true;
    screen.textContent = "";
  }

  function progress() {
    if (!fix || !path.length || pending || routeUnavailable || !usableFix(fix)) return;
    const maxAdvance = previousMatch
      ? previousMatch.progress + Math.max(250, (fix.timestamp - previousMatch.timestamp) / 1000 * 50)
      : 500;
    const match = matchRoute(path, fix, maxAdvance);
    const deviated = match.distance > Math.max(55, fix.accuracy * 1.5) || match.progress < furthest - 65;
    if (deviated) {
      offRouteSince ||= fix.timestamp;
      say("Checking a new route…");
      if (fix.timestamp - offRouteSince >= 4000) void calculateRoute();
      return;
    }
    offRouteSince = 0;
    furthest = Math.max(furthest, match.progress);
    previousMatch = { progress: match.progress, timestamp: fix.timestamp };
    const remaining = Math.max(0, match.total - match.progress);
    if (remaining < 70 && distanceMeters(fix, destination) < 35) {
      say("Near the delivery pin", "Check the address before completing delivery");
      return;
    }
    say("Route active", `${(remaining / 1000).toFixed(1)} km remaining`);
  }

  async function calculateRoute() {
    if (!active || disposed || document.hidden || pending || !usableFix(fix) || Date.now() - lastRequest < REROUTE_DELAY) return;
    pending = true;
    lastRequest = Date.now();
    const currentRequest = ++requestId;
    const origin = { lat: fix.lat, lng: fix.lng };
    say(path.length ? "Updating route…" : "Finding your route…");
    try {
      const { Route } = await maps.importLibrary("routes");
      const { routes } = await Route.computeRoutes({
        origin, destination, travelMode: "DRIVING", fields: ["path", "viewport"]
      });
      if (currentRequest !== requestId || !active || disposed || document.hidden) return;
      const route = routes[0];
      const newPath = (route?.path || []).map(coordinates);
      if (newPath.length < 2 || newPath.some((point) => !point)) throw new Error("No route");
      const newLines = route.createPolylines();
      lines.forEach((line) => line.setMap(null));
      lines = newLines;
      lines.forEach((line) => line.setMap(map));
      path = newPath;
      furthest = 0;
      previousMatch = null;
      offRouteSince = 0;
      routeUnavailable = false;
      if (following) {
        map.setZoom(17);
        map.panTo(fix);
      }
    } catch {
      if (currentRequest === requestId && active && !disposed) {
        routeUnavailable = true;
        say("Route unavailable", "Retrying automatically. Check your connection.");
      }
    } finally {
      if (currentRequest === requestId) {
        pending = false;
        progress();
      }
    }
  }

  function acceptPosition(position) {
    if (!active || disposed || document.hidden) return;
    fix = { lat: position.coords.latitude, lng: position.coords.longitude,
      accuracy: position.coords.accuracy, timestamp: position.timestamp };
    locationError = false;
    if (!usableFix(fix)) {
      locationMarker?.setVisible(false);
      say("Waiting for a more accurate location…");
      return;
    }
    if (!locationMarker) {
      locationMarker = new maps.Marker({
        map, position: fix, title: "Your location",
        icon: { path: maps.SymbolPath.CIRCLE, scale: 7, fillColor: "#1764d6", fillOpacity: 1, strokeColor: "#ffffff", strokeWeight: 2 }
      });
    }
    locationMarker.setPosition(fix);
    locationMarker.setVisible(true);
    if (following) map.panTo(fix);
    if (!path.length || routeUnavailable) void calculateRoute();
    else progress();
  }

  function watchLocation() {
    if (!active || disposed || document.hidden || watchId !== null) return;
    say("Waiting for your location…", "Allow location access to navigate inside Delivery Mode");
    watchId = navigator.geolocation.watchPosition(acceptPosition, (error) => {
      if (!active || disposed) return;
      fix = null;
      locationError = true;
      locationMarker?.setVisible(false);
      say(error.code === 1 ? "Location access is blocked" : "Location signal unavailable",
        error.code === 1 ? "Allow location in your browser settings, then restart navigation." : "Keep the app open while the signal recovers.");
    }, { enableHighAccuracy: true, maximumAge: 3000, timeout: 15000 });
    void keepScreenAwake();
  }

  function visibilityChanged() {
    if (!active) return;
    clearWatch();
    fix = null;
    say("Navigation paused", "Return to this screen to resume");
    if (!document.hidden) {
      lastRequest = -Infinity;
      routeUnavailable = true;
      watchLocation();
    }
  }

  const dragListener = map.addListener("dragstart", () => {
    following = false;
    if (active) follow.hidden = false;
  });
  follow.onclick = () => {
    following = true;
    follow.hidden = true;
    if (fix && usableFix(fix)) map.panTo(fix);
  };
  start.disabled = !navigator.geolocation;
  if (!navigator.geolocation) start.textContent = "Location unavailable in this browser";
  start.onclick = () => {
    if (active || disposed) return;
    active = true;
    start.hidden = true;
    stop.hidden = false;
    guidance.hidden = false;
    lastRequest = -Infinity;
    routeUnavailable = false;
    watchLocation();
    timer = setInterval(() => {
      if (!active || document.hidden) return;
      if (locationError) return;
      if (!fix || !usableFix(fix)) {
        locationMarker?.setVisible(false);
        say("Waiting for a fresh location…", "Keep Delivery Mode open");
      } else if (!path.length || routeUnavailable || offRouteSince) {
        void calculateRoute();
      }
    }, 5000);
  };
  stop.onclick = stopRouting;
  document.addEventListener("visibilitychange", visibilityChanged);

  return () => {
    disposed = true;
    stopRouting();
    locationMarker?.setMap(null);
    dragListener.remove();
    document.removeEventListener("visibilitychange", visibilityChanged);
  };
}

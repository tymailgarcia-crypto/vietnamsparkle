// Owner phone-alert opt-in via Firebase Cloud Messaging (web push).
//
// Loaded only by admin.html (the owner dashboard). It owns the "Enable phone
// alerts" button: it asks for notification permission, registers the root
// service worker, gets an FCM token, and stores it under pushTokens/{token}
// (owner-only rule). The Cloud Function sender reads those tokens and pushes
// order / overdue / reconciliation / refund alerts that pop up on the phone
// even with the dashboard closed.
//
// INERT until webPushVapidKey is set in firebaseWebConfig.js — mirrors the App
// Check staged rollout. With no key the button shows a "needs setup" state and
// no token is ever requested, so nothing about the app changes.
import {
  getMessaging,
  getToken,
  deleteToken,
  onMessage,
  isSupported
} from "https://www.gstatic.com/firebasejs/12.0.0/firebase-messaging.js";
import {
  app,
  auth,
  db,
  doc,
  setDoc,
  deleteDoc,
  serverTimestamp,
  functions,
  httpsCallable
} from "./firebaseClient.js";
import { webPushVapidKey } from "./firebaseWebConfig.js";

const SW_URL = "/firebase-messaging-sw.js";
const LS_TOKEN_KEY = "vs-owner-push-token";
const LS_PREFS_KEY = "vs-owner-push-prefs";
// The alert categories the owner can turn on/off per phone. Must match the
// `kind` values sendOwnerPush filters on in functions/index.js.
const PREF_KINDS = ["newOrder", "refund", "money"];

// Which alert types this phone wants. Stored in localStorage so the choice
// survives reloads, and mirrored onto pushTokens/{token}.prefs (what the server
// actually reads). Unset means "on" — an older phone with no prefs still gets
// everything.
function loadPrefs() {
  let raw = {};
  try { raw = JSON.parse(localStorage.getItem(LS_PREFS_KEY) || "{}") || {}; } catch (_) { raw = {}; }
  const prefs = {};
  for (const k of PREF_KINDS) prefs[k] = raw[k] !== false;
  return prefs;
}

function savePrefs(prefs) {
  try { localStorage.setItem(LS_PREFS_KEY, JSON.stringify(prefs)); } catch (_) { /* private mode */ }
}

function readCheckboxes() {
  const prefs = loadPrefs();
  document.querySelectorAll("[data-alert-pref]").forEach((cb) => {
    prefs[cb.getAttribute("data-alert-pref")] = cb.checked;
  });
  return prefs;
}

function applyPrefsToCheckboxes(prefs) {
  document.querySelectorAll("[data-alert-pref]").forEach((cb) => {
    cb.checked = prefs[cb.getAttribute("data-alert-pref")] !== false;
  });
}

function els() {
  return {
    button: document.getElementById("enable-phone-alerts"),
    testButton: document.getElementById("test-phone-alert"),
    status: document.getElementById("phone-alerts-status")
  };
}

// The "Send test alert" button only makes sense once this phone is registered.
function setTestVisible(on) {
  const { testButton } = els();
  if (testButton) testButton.classList.toggle("hidden", !on);
}

function setStatus(text) {
  const { status } = els();
  if (status) status.textContent = text || "";
}

function setButton({ label, disabled, on }) {
  const { button } = els();
  if (!button) return;
  if (label != null) button.textContent = label;
  button.disabled = Boolean(disabled);
  button.setAttribute("aria-pressed", on ? "true" : "false");
  button.classList.toggle("is-on", Boolean(on));
}

// The registration the FCM SDK should use. Registering explicitly (rather than
// letting getToken auto-register) lets us reuse the same worker for foreground
// display and keeps the scope predictable on iOS home-screen installs.
async function ensureServiceWorker() {
  const existing = await navigator.serviceWorker.getRegistration(SW_URL);
  if (existing) return existing;
  return navigator.serviceWorker.register(SW_URL);
}

function showLocalNotification(reg, data) {
  const payload = data || {};
  const title = payload.title || "Vietnam Sparkle";
  const options = {
    body: payload.body || "",
    icon: "/assets/icons/icon-192.png",
    badge: "/assets/icons/notification-icon.png",
    tag: payload.tag || undefined,
    data: { url: payload.url || "/admin.html" }
  };
  if (reg && reg.showNotification) reg.showNotification(title, options);
  else if (self.Notification && Notification.permission === "granted") new Notification(title, options);
}

export async function initOwnerPush() {
  const { button } = els();
  if (!button) return; // page didn't render the control

  // Reflect saved alert choices and let the owner change them regardless of the
  // enable state below — a change writes through to the token doc when a phone
  // is registered, and is remembered for whenever it is.
  applyPrefsToCheckboxes(loadPrefs());
  wirePrefs();

  // 1. Not configured yet — the console step (VAPID key) hasn't been done.
  if (!webPushVapidKey) {
    setButton({ label: "Phone alerts — needs setup", disabled: true, on: false });
    setStatus("Not active yet: add a Web Push key in the Firebase console, then redeploy.");
    return;
  }

  // 2. Browser/platform can't do web push. On iPhone this is the "open it in
  //    Safari instead of from the Home Screen" case — installing fixes it.
  let supported = false;
  try { supported = await isSupported(); } catch (_) { supported = false; }
  if (!supported || !("serviceWorker" in navigator) || !("Notification" in window)) {
    setButton({ label: "Phone alerts unavailable", disabled: true, on: false });
    setStatus("This browser can't show web push. On iPhone, add this site to your Home Screen first (needs iOS 16.4+), then open it from there.");
    return;
  }

  const messaging = getMessaging(app);

  // 3. Permanently blocked in phone/browser settings — can't re-prompt.
  if (Notification.permission === "denied") {
    setButton({ label: "Phone alerts blocked", disabled: true, on: false });
    setStatus("Notifications are blocked for this site in your phone/browser settings. Re-allow them there to use this.");
    return;
  }

  // Reflect current state: enabled if we granted permission and hold a token.
  const storedToken = localStorage.getItem(LS_TOKEN_KEY);
  const alreadyOn = Notification.permission === "granted" && Boolean(storedToken);
  setButton({
    label: alreadyOn ? "Phone alerts on — tap to turn off" : "Enable phone alerts",
    disabled: false,
    on: alreadyOn
  });
  setTestVisible(alreadyOn);
  setStatus(alreadyOn ? "This phone will buzz for new orders and money alerts, even with the dashboard closed." : "");

  wireTestButton();

  // Foreground messages (tab open + focused): show them too, so an alert isn't
  // silently swallowed while you happen to be looking at the dashboard.
  onMessage(messaging, (payload) => {
    ensureServiceWorker().then((reg) => showLocalNotification(reg, payload.data)).catch(() => {});
  });

  let busy = false;
  button.addEventListener("click", async () => {
    if (busy || button.disabled) return;
    busy = true;
    const turningOff = button.classList.contains("is-on");
    try {
      if (turningOff) {
        setStatus("Turning off…");
        try { await deleteToken(messaging); } catch (_) { /* token may already be gone */ }
        if (storedToken) {
          try { await deleteDoc(doc(db, "pushTokens", storedToken)); } catch (_) { /* rule/absent */ }
        }
        localStorage.removeItem(LS_TOKEN_KEY);
        setButton({ label: "Enable phone alerts", disabled: false, on: false });
        setTestVisible(false);
        setStatus("Phone alerts are off on this device.");
        return;
      }

      if (!auth.currentUser) {
        setStatus("Sign in first, then enable phone alerts.");
        return;
      }

      setStatus("Asking for permission…");
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setStatus("You didn't allow notifications, so nothing was turned on.");
        return;
      }

      setStatus("Registering this phone…");
      const reg = await ensureServiceWorker();
      const token = await getToken(messaging, {
        vapidKey: webPushVapidKey,
        serviceWorkerRegistration: reg
      });
      if (!token) {
        setStatus("Couldn't get a push token from the browser. Try again.");
        return;
      }

      await setDoc(doc(db, "pushTokens", token), {
        token,
        ownerUid: auth.currentUser.uid,
        platform: navigator.platform || "",
        userAgent: navigator.userAgent || "",
        prefs: readCheckboxes(),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      }, { merge: true });

      localStorage.setItem(LS_TOKEN_KEY, token);
      setButton({ label: "Phone alerts on — tap to turn off", disabled: false, on: true });
      setTestVisible(true);
      setStatus("Done. This phone will buzz for new orders and money alerts, even with the dashboard closed. Tap “Send test alert” to check it lands.");
    } catch (err) {
      console.error("Phone alerts toggle failed", err);
      setStatus("Something went wrong turning that on. Check your connection and try again.");
    } finally {
      busy = false;
    }
  });
}

// The test button proves the whole path end to end: it calls the same Cloud
// Function push sender a real order uses, aimed at every registered phone. A
// working test means real alerts will arrive; 0 delivered means no phone is
// registered (or its token died). Wired once, guarded so re-init won't double-bind.
// Persist an alert-type choice: always to localStorage, and — when this phone is
// registered — through to pushTokens/{token}.prefs, which is what the server
// reads to decide whether to send. Wired once, re-init safe.
let prefsWired = false;
function wirePrefs() {
  if (prefsWired) return;
  const boxes = document.querySelectorAll("[data-alert-pref]");
  if (!boxes.length) return;
  prefsWired = true;
  boxes.forEach((cb) => cb.addEventListener("change", async () => {
    const prefs = readCheckboxes();
    savePrefs(prefs);
    const token = localStorage.getItem(LS_TOKEN_KEY);
    if (!token || !auth.currentUser) {
      setStatus("Saved. Turn on phone alerts to start receiving the ones you picked.");
      return;
    }
    try {
      await setDoc(doc(db, "pushTokens", token), { prefs, updatedAt: serverTimestamp() }, { merge: true });
      setStatus("Alert choices saved for this phone.");
    } catch (err) {
      console.error("Saving alert prefs failed", err);
      setStatus("Couldn't save that choice — check your connection and try again.");
    }
  }));
}

let testWired = false;
function wireTestButton() {
  const { testButton } = els();
  if (!testButton || testWired) return;
  testWired = true;
  let sending = false;
  testButton.addEventListener("click", async () => {
    if (sending) return;
    if (!auth.currentUser) { setStatus("Sign in first, then send a test alert."); return; }
    sending = true;
    testButton.disabled = true;
    setStatus("Sending a test alert to your phone…");
    try {
      const call = httpsCallable(functions, "sendTestPush");
      const res = await call({});
      const sent = Number(res && res.data && res.data.sent) || 0;
      if (sent > 0) {
        setStatus(`Test alert sent to ${sent} ${sent === 1 ? "device" : "devices"}. Check your phone — with the dashboard closed it should pop up within a few seconds.`);
      } else {
        setStatus("Nothing was sent — no phone is registered yet. Tap “Enable phone alerts” on the phone you want alerts on, then try the test again.");
      }
    } catch (err) {
      console.error("Test alert failed", err);
      setStatus("Couldn't send the test. Check your connection and try again.");
    } finally {
      sending = false;
      testButton.disabled = false;
    }
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => { initOwnerPush(); });
} else {
  initOwnerPush();
}

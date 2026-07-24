/* Firebase Cloud Messaging service worker — owner phone alerts.
 *
 * Runs OUTSIDE the page, in worker scope, so it cannot import the app's ES
 * modules. It uses the compat CDN builds (the standard FCM SW pattern) and a
 * hardcoded minimal config. Every value here is already public in
 * firebaseWebConfig.js (it ships in the client bundle by design) — there is
 * nothing secret in a Firebase web config, so duplicating it is safe.
 *
 * Its only job: when a push arrives while the dashboard/tab is CLOSED or in the
 * background, draw the notification on the phone. Foreground messages are
 * handled in the page by assets/pushNotifications.js (onMessage) instead.
 *
 * Must live at the hosting ROOT so its scope is "/" and getToken() can find it
 * at /firebase-messaging-sw.js. Do not move it under /assets.
 */
importScripts("https://www.gstatic.com/firebasejs/12.0.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/12.0.0/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyC7kP_jrQUFTkxxOuMVamsCSTEwn-TUCOc",
  projectId: "vietnamsparkle-36dfe",
  messagingSenderId: "1092060902387",
  appId: "1:1092060902387:web:a2ac047dff57907df69886"
});

const messaging = firebase.messaging();

// The Cloud Function sends DATA-only messages (no top-level `notification`), so
// this handler always runs and we fully control how the alert looks. A
// notification-type payload would be auto-displayed by the browser and could
// double up with this — keep the sender data-only.
messaging.onBackgroundMessage((payload) => {
  const data = payload.data || {};
  const title = data.title || "Vietnam Sparkle";
  const options = {
    body: data.body || "",
    icon: "/assets/icons/icon-192.png",
    badge: "/assets/icons/notification-icon.png",
    // A stable tag per alert kind coalesces repeats instead of stacking.
    tag: data.tag || undefined,
    renotify: Boolean(data.tag),
    data: { url: data.url || "/admin.html" }
  };
  return self.registration.showNotification(title, options);
});

// Tapping the notification focuses an already-open dashboard tab if there is
// one, otherwise opens the target page.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/admin.html";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url.indexOf(target) !== -1 && "focus" in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(target);
      return undefined;
    })
  );
});

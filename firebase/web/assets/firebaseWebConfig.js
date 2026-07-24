export const firebaseWebConfig = {
  apiKey: "AIzaSyC7kP_jrQUFTkxxOuMVamsCSTEwn-TUCOc",
  authDomain: "vietnamsparkle-36dfe.firebaseapp.com",
  projectId: "vietnamsparkle-36dfe",
  storageBucket: "vietnamsparkle-36dfe.firebasestorage.app",
  messagingSenderId: "1092060902387",
  appId: "1:1092060902387:web:a2ac047dff57907df69886",
  measurementId: "G-ZENCGJC747"
};

// Firebase App Check (anti-abuse attestation for the public order callable).
// Empty string disables App Check entirely — the app behaves exactly as
// before. To activate:
//   1. Firebase console → App Check → Apps → register this web app with a
//      reCAPTCHA key (Enterprise, or classic v3 from
//      https://www.google.com/recaptcha/admin/create with the hosting domains).
//   2. Paste the SITE key here and set the provider type below to match.
//   3. Deploy hosting, then watch App Check metrics until real traffic is
//      verified BEFORE anyone adds enforceAppCheck to submitPublicOrder —
//      enforcing first breaks public ordering. Full plan: ROADMAP → App Check.
// Local dev never needs a real key: with a key set, emulator-mode pages use a
// debug token; with it empty, App Check never initializes at all.
export const appCheckSiteKey = "6LdMwVYtAAAAAOcsjR7wVnF3V40ERSqT66w5Dv33";
// "enterprise" for a reCAPTCHA Enterprise key, "v3" for a classic v3 key.
export const appCheckProviderType = "enterprise";

// Google Maps JavaScript API key for the /map.html owner view. Requires both
// "Maps JavaScript API" and "Geocoding API" enabled on this key in Google Cloud
// Console. Restrict the key to HTTP referrers of the deployed hosting domain.
// Empty string disables the map (page shows a config-needed message instead).
export const mapsApiKey = "AIzaSyBFC6PjvDPPg-cQ72t8ZGNE3UAZu6XEObo";
// Rough map centre used before any pins load. Da Nang city centre.
export const mapsDefaultCenter = { lat: 16.0544, lng: 108.2022 };

// Firebase Cloud Messaging (web push) VAPID key for owner phone alerts.
// Empty string keeps push OFF everywhere — the "Enable phone alerts" button on
// the dashboard shows a "needs setup" state and no token is ever requested, so
// the app behaves exactly as before. Mirrors the App Check staged rollout above.
// To activate:
//   1. Firebase console → Project settings (gear) → Cloud Messaging tab → under
//      "Web Push certificates" click Generate key pair.
//   2. Paste the generated "Key pair" value (a long Base64 string) here.
//   3. Deploy hosting. Then, on the phone that should receive alerts, open the
//      dashboard, Add to Home Screen, and tap "Enable phone alerts" once.
// This is the PUBLIC VAPID key — safe to ship in the bundle, like the keys above.
export const webPushVapidKey = "BI9aay3VYCcCIycWtfKyPK2auX2A9yhkCeRxM2hfZCKgwNjr50jEtznKqQFM6dm7ud5ohea0Ng2es_Glo1e_DGk";

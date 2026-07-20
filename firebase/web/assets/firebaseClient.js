import { initializeApp } from "https://www.gstatic.com/firebasejs/12.0.0/firebase-app.js";
import {
  createUserWithEmailAndPassword,
  connectAuthEmulator,
  getAuth,
  GoogleAuthProvider,
  isSignInWithEmailLink,
  onAuthStateChanged,
  sendPasswordResetEmail,
  sendSignInLinkToEmail,
  signInWithEmailAndPassword,
  signInWithEmailLink,
  signInWithCredential,
  signInWithPopup,
  signOut
} from "https://www.gstatic.com/firebasejs/12.0.0/firebase-auth.js";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getCountFromServer,
  getDoc,
  getDocs,
  getFirestore,
  connectFirestoreEmulator,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  startAfter,
  updateDoc,
  where,
  writeBatch
} from "https://www.gstatic.com/firebasejs/12.0.0/firebase-firestore.js";
import {
  connectFunctionsEmulator,
  getFunctions,
  httpsCallable
} from "https://www.gstatic.com/firebasejs/12.0.0/firebase-functions.js";
import {
  connectStorageEmulator,
  getDownloadURL,
  getStorage,
  ref as storageRef,
  uploadBytes
} from "https://www.gstatic.com/firebasejs/12.0.0/firebase-storage.js";
import {
  initializeAppCheck,
  ReCaptchaEnterpriseProvider,
  ReCaptchaV3Provider
} from "https://www.gstatic.com/firebasejs/12.0.0/firebase-app-check.js";
import { appCheckProviderType, appCheckSiteKey, firebaseWebConfig } from "./firebaseWebConfig.js";

const app = initializeApp(firebaseWebConfig);

// App Check attestation — inert until a reCAPTCHA site key lands in
// firebaseWebConfig.js (see the staged rollout plan there and in ROADMAP).
// Must run before the first callable/Firestore request so those carry tokens.
// Enforcement is a separate, later step on the Functions side; initializing
// here changes nothing about who is allowed to do what.
//
// Scoped to pages that opt in via `self.__ENABLE_APP_CHECK__` (set by an inline
// script BEFORE this module loads). Only the public order page needs it — it is
// the sole caller of the unauthenticated submitPublicOrder callable. The
// owner/admin pages are login-gated and would only pay the reCAPTCHA bootstrap
// cost on every navigation for no benefit, so they leave the flag unset.
if (appCheckSiteKey && self.__ENABLE_APP_CHECK__) {
  if (location.hostname === "localhost" || location.hostname === "127.0.0.1") {
    // Emulator/local pages mint a debug token instead of running reCAPTCHA.
    // The token prints to the browser console; register it in the console's
    // App Check → Debug tokens page only if local calls must pass PROD checks.
    self.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
  }
  initializeAppCheck(app, {
    provider: appCheckProviderType === "v3"
      ? new ReCaptchaV3Provider(appCheckSiteKey)
      : new ReCaptchaEnterpriseProvider(appCheckSiteKey),
    isTokenAutoRefreshEnabled: true
  });
}
const auth = getAuth(app);
const db = getFirestore(app);
const functions = getFunctions(app);
const storage = getStorage(app);
const isEmulatorMode = location.hostname === "localhost" || location.hostname === "127.0.0.1";

if (isEmulatorMode) {
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
  connectFunctionsEmulator(functions, "127.0.0.1", 5001);
  connectStorageEmulator(storage, "127.0.0.1", 9199);
}

async function signInWithGoogleForEnvironment() {
  if (!isEmulatorMode) {
    return signInWithPopup(auth, new GoogleAuthProvider());
  }
  const email = window.prompt("Fake Google email", "customer1@example.test");
  if (!email) return null;
  const name = window.prompt("Fake Google display name", "Test Customer") || "Test Customer";
  const sub = `google-test-${String(email).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
  const credential = GoogleAuthProvider.credential(JSON.stringify({
    sub,
    email: String(email).trim(),
    email_verified: true,
    name
  }));
  return signInWithCredential(auth, credential);
}

export {
  addDoc,
  auth,
  collection,
  createUserWithEmailAndPassword,
  db,
  deleteDoc,
  doc,
  functions,
  getCountFromServer,
  getDoc,
  getDocs,
  getDownloadURL,
  GoogleAuthProvider,
  httpsCallable,
  isEmulatorMode,
  isSignInWithEmailLink,
  limit,
  onAuthStateChanged,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  sendPasswordResetEmail,
  sendSignInLinkToEmail,
  serverTimestamp,
  setDoc,
  signInWithEmailAndPassword,
  signInWithEmailLink,
  signInWithGoogleForEnvironment,
  signInWithPopup,
  signOut,
  startAfter,
  storage,
  storageRef,
  updateDoc,
  uploadBytes,
  where,
  writeBatch
};

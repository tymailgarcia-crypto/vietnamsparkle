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
  getDoc,
  getDocs,
  getFirestore,
  connectFirestoreEmulator,
  limit,
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
import { firebaseWebConfig } from "./firebaseWebConfig.js";

const app = initializeApp(firebaseWebConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const functions = getFunctions(app);
const isEmulatorMode = location.hostname === "localhost" || location.hostname === "127.0.0.1";

if (isEmulatorMode) {
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
  connectFunctionsEmulator(functions, "127.0.0.1", 5001);
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
  getDoc,
  getDocs,
  GoogleAuthProvider,
  httpsCallable,
  isEmulatorMode,
  isSignInWithEmailLink,
  limit,
  onAuthStateChanged,
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
  updateDoc,
  where,
  writeBatch
};

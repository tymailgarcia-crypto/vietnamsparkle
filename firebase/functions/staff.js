// manageStaff — owner-only callable behind Settings → "Staff". Lets an owner
// give another person's sign-in staff access, and take it away again.
//
// Staff access is the `role: "owner"` custom claim — the only staff role the
// app's pages accept today (driver rollout is still disabled; see HANDOVER →
// "Owner and driver custom claims"). Ticking "delivery driver" also creates or
// reactivates a drivers/{H-###} doc linked by staffUid, so they appear in the
// driver drop-downs and the trip planner. A removed employee's driver doc is
// set active:false, never deleted, because past orders reference its id.
//
// Guards: caller must be an owner; nobody can remove their own access (no
// self-lockout); an account whose email isn't verified needs an explicit
// confirmUnverified (anyone can sign up with someone else's address using a
// password); removal revokes refresh tokens so access ends within the hour.
// Every change is appended to staffChanges/ (Admin SDK only; no client rule).

const { randomBytes } = require("node:crypto");
const { onCall, HttpsError } = require("firebase-functions/https");
const { getApp, initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

const STAFF_ROLES = new Set(["owner", "driver"]);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function admin() {
  try { getApp(); } catch (_) { initializeApp(); }
  return { auth: getAuth(), db: getFirestore() };
}

function requireOwnerCaller(request) {
  const role = request.auth && request.auth.token ? request.auth.token.role : null;
  if (role !== "owner") throw new HttpsError("permission-denied", "Only staff with owner access can manage staff.");
  return { uid: request.auth.uid, email: request.auth.token.email || null };
}

function nextDriverId(ids) {
  const max = ids.reduce((top, id) => {
    const match = /^H-(\d+)$/.exec(id);
    return match ? Math.max(top, Number(match[1])) : top;
  }, 0);
  return `H-${String(max + 1).padStart(3, "0")}`;
}

function staffRow(user, driversByUid, callerUid) {
  const driver = driversByUid[user.uid] || null;
  return {
    uid: user.uid,
    email: user.email || "",
    name: (driver && driver.driverName) || user.displayName || "",
    emailVerified: Boolean(user.emailVerified),
    role: user.customClaims.role,
    lastSignIn: user.metadata && user.metadata.lastSignInTime ? user.metadata.lastSignInTime : null,
    isSelf: user.uid === callerUid,
    driverId: driver && driver.active !== false ? driver.id : null
  };
}

async function listStaff({ auth, db }, caller) {
  const driversSnap = await db.collection("drivers").get();
  const driversByUid = {};
  driversSnap.docs.forEach((doc) => {
    const data = doc.data();
    if (data.staffUid) driversByUid[data.staffUid] = { id: doc.id, ...data };
  });
  const staff = [];
  let pageToken;
  do {
    const page = await auth.listUsers(1000, pageToken);
    page.users
      .filter((user) => user.customClaims && STAFF_ROLES.has(user.customClaims.role))
      .forEach((user) => staff.push(staffRow(user, driversByUid, caller.uid)));
    pageToken = page.pageToken;
  } while (pageToken);
  staff.sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email));
  return { staff };
}

async function logChange(db, entry) {
  await db.collection("staffChanges").add({ ...entry, at: FieldValue.serverTimestamp() });
}

// Creates, or reactivates, the driver doc linked to this sign-in. Returns its id.
// Only an explicitly typed name renames an existing driver; the account's
// display name is just the default for a brand-new one.
async function ensureDriverDoc(db, { uid, email, name, fallbackName, phone, callerUid }) {
  const drivers = db.collection("drivers");
  return db.runTransaction(async (tx) => {
    const all = await tx.get(drivers);
    const linked = all.docs.find((doc) => doc.data().staffUid === uid);
    if (linked) {
      tx.update(linked.ref, {
        active: true,
        ...(name ? { driverName: name } : {}),
        ...(phone ? { phone } : {}),
        updatedAt: FieldValue.serverTimestamp()
      });
      return linked.id;
    }
    const id = nextDriverId(all.docs.map((doc) => doc.id));
    tx.create(drivers.doc(id), {
      driverName: name || fallbackName || email,
      phone: phone || "",
      active: true,
      standardLoadout: null,
      notes: "",
      staffUid: uid,
      email,
      createdAt: FieldValue.serverTimestamp(),
      createdBy: callerUid
    });
    return id;
  });
}

async function addStaff({ auth, db }, caller, data) {
  const email = String(data.email || "").trim().toLowerCase();
  const name = String(data.name || "").trim().slice(0, 80);
  const phone = String(data.phone || "").trim().slice(0, 40);
  const isDriver = data.isDriver === true;
  if (!EMAIL_RE.test(email)) throw new HttpsError("invalid-argument", "Enter the email address they sign in with.");

  let user;
  let createdAccount = false;
  try {
    user = await auth.getUserByEmail(email);
  } catch (error) {
    if (error.code !== "auth/user-not-found") throw error;
    try {
      // Only the employee can choose a usable password, via the email reset link.
      user = await auth.createUser({
        email,
        ...(name ? { displayName: name } : {}),
        password: randomBytes(32).toString("hex")
      });
      createdAccount = true;
    } catch (createError) {
      if (createError.code !== "auth/email-already-exists") throw createError;
      // A concurrent registration still goes through the existing-account checks.
      user = await auth.getUserByEmail(email);
    }
  }
  const claims = { ...(user.customClaims || {}) };
  const alreadyStaff = claims.role === "owner";
  if (!createdAccount && !alreadyStaff && !user.emailVerified && data.confirmUnverified !== true) {
    throw new HttpsError("failed-precondition", "unverified-email", { unverified: true });
  }

  claims.role = "owner";
  delete claims.driverId;
  if (!alreadyStaff) await auth.setCustomUserClaims(user.uid, claims);
  const driverId = isDriver ? await ensureDriverDoc(db, { uid: user.uid, email, name, fallbackName: user.displayName || "", phone, callerUid: caller.uid }) : null;

  await logChange(db, {
    action: "add",
    targetUid: user.uid,
    targetEmail: email,
    emailVerified: Boolean(user.emailVerified),
    driverId,
    byUid: caller.uid,
    byEmail: caller.email
  });
  return { uid: user.uid, alreadyStaff, createdAccount, driverId, emailVerified: Boolean(user.emailVerified) };
}

async function removeStaff({ auth, db }, caller, data) {
  const uid = String(data.uid || "").trim();
  if (!uid) throw new HttpsError("invalid-argument", "Missing account.");
  if (uid === caller.uid) throw new HttpsError("failed-precondition", "You can't remove your own staff access.");
  const user = await auth.getUser(uid).catch(() => null);
  if (!user) throw new HttpsError("not-found", "That account no longer exists.");

  const claims = { ...(user.customClaims || {}) };
  delete claims.role;
  delete claims.driverId;
  await auth.setCustomUserClaims(uid, claims);
  await auth.revokeRefreshTokens(uid);

  const linked = await db.collection("drivers").where("staffUid", "==", uid).get();
  await Promise.all(linked.docs.map((doc) => doc.ref.update({ active: false, updatedAt: FieldValue.serverTimestamp() })));

  await logChange(db, {
    action: "remove",
    targetUid: uid,
    targetEmail: user.email || null,
    driverIds: linked.docs.map((doc) => doc.id),
    byUid: caller.uid,
    byEmail: caller.email
  });
  return { removed: true };
}

async function manageStaffImpl(deps, caller, data = {}) {
  switch (data.action) {
    case "list": return listStaff(deps, caller);
    case "add": return addStaff(deps, caller, data);
    case "remove": return removeStaff(deps, caller, data);
    default: throw new HttpsError("invalid-argument", "Unknown action.");
  }
}

const manageStaff = onCall(async (request) => {
  const caller = requireOwnerCaller(request);
  return manageStaffImpl(admin(), caller, request.data || {});
});

module.exports = {
  manageStaff,
  _staffTestApi: { manageStaffImpl, nextDriverId }
};

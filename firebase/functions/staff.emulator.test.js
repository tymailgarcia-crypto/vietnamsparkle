"use strict";

// Settings → Staff (manageStaff). Runs manageStaffImpl against the Auth +
// Firestore emulators with the Admin SDK. Pins: new account password setup, an
// unverified email needs explicit confirmation, adding grants role:owner and
// (for drivers) exactly one linked drivers doc with the next H-### id, re-adding
// is idempotent, nobody can remove themselves, removal clears the claim and
// deactivates (never deletes) the driver doc, and every change is logged.
//
// Run (Java is installed but not on PATH — see HANDOFF.md):
//   cd firebase
//   export JAVA_HOME="/c/Program Files/Eclipse Adoptium/jre-21.0.11.10-hotspot"
//   firebase emulators:exec --only auth,firestore \
//     "cd functions && node staff.emulator.test.js"

process.env.NODE_ENV = "test";

const assert = require("node:assert");
const admin = require("firebase-admin");

admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || "demo-staff-emulator" });
const db = admin.firestore();
const auth = admin.auth();
const deps = { auth, db };

const { manageStaffImpl, nextDriverId } = require("./staff.js")._staffTestApi;

let passed = 0;
let failed = 0;
async function it(name, fn) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed += 1;
  } catch (err) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err && err.message ? err.message.split("\n")[0] : err}`);
    failed += 1;
  }
}
async function rejects(fn, code) {
  try {
    await fn();
  } catch (e) {
    assert.strictEqual(e.code, code, `expected '${code}', got '${e.code}' (${e.message})`);
    return e;
  }
  throw new Error(`expected rejection '${code}'`);
}

async function main() {
  const boss = await auth.createUser({ email: "boss@example.test", password: "secret123", emailVerified: true });
  await auth.setCustomUserClaims(boss.uid, { role: "owner" });
  const caller = { uid: boss.uid, email: "boss@example.test" };
  const alex = await auth.createUser({ email: "alex@example.test", password: "secret123", emailVerified: false, displayName: "Alex" });
  const lan = await auth.createUser({ email: "lan@example.test", password: "secret123", emailVerified: true });
  await auth.createUser({ email: "customer@example.test", password: "secret123", emailVerified: true });
  // An imported driver with a gap in the numbering: next id must be H-006.
  await db.doc("drivers/H-005").set({ driverName: "Imported driver", active: true });

  await it("next driver id follows the highest H-### id", async () => {
    assert.strictEqual(nextDriverId(["H-001", "H-005", "other"]), "H-006");
    assert.strictEqual(nextDriverId([]), "H-001");
  });

  await it("an unverified email needs explicit confirmation", async () => {
    const e = await rejects(() => manageStaffImpl(deps, caller, { action: "add", email: "alex@example.test", isDriver: true }), "failed-precondition");
    assert.deepStrictEqual(e.details, { unverified: true });
    const user = await auth.getUser(alex.uid);
    assert.ok(!user.customClaims || !user.customClaims.role, "no role before confirmation");
  });

  await it("adding grants owner and creates one linked driver doc", async () => {
    const result = await manageStaffImpl(deps, caller, { action: "add", email: "ALEX@example.test ", isDriver: true, confirmUnverified: true, phone: "+84905000111" });
    assert.strictEqual(result.driverId, "H-006");
    assert.strictEqual((await auth.getUser(alex.uid)).customClaims.role, "owner");
    const driver = (await db.doc("drivers/H-006").get()).data();
    assert.strictEqual(driver.staffUid, alex.uid);
    assert.strictEqual(driver.driverName, "Alex");
    assert.strictEqual(driver.active, true);
  });

  await it("re-adding is idempotent (no second driver doc)", async () => {
    const result = await manageStaffImpl(deps, caller, { action: "add", email: "alex@example.test", isDriver: true, confirmUnverified: true });
    assert.strictEqual(result.alreadyStaff, true);
    assert.strictEqual(result.driverId, "H-006");
    const linked = await db.collection("drivers").where("staffUid", "==", alex.uid).get();
    assert.strictEqual(linked.size, 1);
  });

  await it("a non-driver employee gets access but no driver doc", async () => {
    const result = await manageStaffImpl(deps, caller, { action: "add", email: "lan@example.test", isDriver: false });
    assert.strictEqual(result.driverId, null);
    assert.strictEqual((await auth.getUser(lan.uid)).customClaims.role, "owner");
    assert.strictEqual((await db.collection("drivers").where("staffUid", "==", lan.uid).get()).size, 0);
  });

  await it("list shows staff only, marks the caller, links drivers", async () => {
    const { staff } = await manageStaffImpl(deps, caller, { action: "list" });
    const emails = staff.map((s) => s.email).sort();
    assert.deepStrictEqual(emails, ["alex@example.test", "boss@example.test", "lan@example.test"]);
    assert.strictEqual(staff.find((s) => s.email === "boss@example.test").isSelf, true);
    const alexRow = staff.find((s) => s.email === "alex@example.test");
    assert.strictEqual(alexRow.driverId, "H-006");
    assert.strictEqual(alexRow.emailVerified, false);
  });

  await it("nobody can remove their own access", async () => {
    await rejects(() => manageStaffImpl(deps, caller, { action: "remove", uid: boss.uid }), "failed-precondition");
    assert.strictEqual((await auth.getUser(boss.uid)).customClaims.role, "owner");
  });

  await it("removing clears the role and deactivates (not deletes) the driver doc", async () => {
    await manageStaffImpl(deps, caller, { action: "remove", uid: alex.uid });
    const user = await auth.getUser(alex.uid);
    assert.ok(!user.customClaims || !user.customClaims.role);
    assert.ok(user.tokensValidAfterTime, "refresh tokens revoked");
    const driver = await db.doc("drivers/H-006").get();
    assert.ok(driver.exists, "driver doc kept for order history");
    assert.strictEqual(driver.data().active, false);
  });

  await it("re-adding a removed driver reactivates the same driver doc", async () => {
    await db.doc("drivers/H-006").update({ driverName: "Alex (truck 2)" });
    const result = await manageStaffImpl(deps, caller, { action: "add", email: "alex@example.test", isDriver: true, confirmUnverified: true });
    assert.strictEqual(result.driverId, "H-006");
    const driver = (await db.doc("drivers/H-006").get()).data();
    assert.strictEqual(driver.active, true);
    assert.strictEqual(driver.driverName, "Alex (truck 2)", "a blank name must not overwrite the existing driver name");
  });

  await it("every change is logged", async () => {
    const log = await db.collection("staffChanges").get();
    const actions = log.docs.map((d) => d.data().action).sort();
    assert.deepStrictEqual(actions, ["add", "add", "add", "add", "remove"]);
    assert.ok(log.docs.every((d) => d.data().byUid === boss.uid));
  });

  await it("unknown actions are rejected", async () => {
    await rejects(() => manageStaffImpl(deps, caller, { action: "promote" }), "invalid-argument");
  });

  await it("a new driver sets their password through email and signs in with admin access", async () => {
    const email = "newdriver@example.test";
    const input = { action: "add", email, name: "New driver", isDriver: true };
    const added = await manageStaffImpl(deps, caller, input);
    assert.strictEqual(added.createdAccount, true);
    assert.strictEqual(added.emailVerified, false);
    const retried = await manageStaffImpl(deps, caller, input);
    assert.strictEqual(retried.uid, added.uid);
    assert.strictEqual(retried.driverId, added.driverId);

    const base = `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`;
    async function authRequest(action, body) {
      return fetch(`${base}/identitytoolkit.googleapis.com/v1/accounts:${action}?key=emulator`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
    }
    const password = "driver-chosen-password";
    const signup = await authRequest("signUp", { email, password });
    assert.strictEqual((await signup.json()).error.message, "EMAIL_EXISTS");
    const sent = await authRequest("sendOobCode", { email, requestType: "PASSWORD_RESET" });
    assert.ok(sent.ok, "password setup email requested");
    const codes = await fetch(`${base}/emulator/v1/projects/${admin.app().options.projectId}/oobCodes`);
    assert.ok(codes.ok);
    const { oobCodes } = await codes.json();
    const reset = oobCodes.find((code) => code.email === email && code.requestType === "PASSWORD_RESET");
    assert.ok(reset, "mailbox has a password reset code");
    const changed = await authRequest("resetPassword", { oobCode: reset.oobCode, newPassword: password });
    assert.ok(changed.ok, "driver set their password");
    const signedIn = await authRequest("signInWithPassword", { email, password, returnSecureToken: true });
    assert.ok(signedIn.ok, "driver signed in with their new password");
    const { idToken } = await signedIn.json();
    const token = await auth.verifyIdToken(idToken);
    assert.strictEqual(token.uid, added.uid);
    assert.strictEqual(token.role, "owner");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().finally(() => db.terminate()).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

import fs from "fs";
import admin from "firebase-admin";

function readServiceAccountPath() {
  const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (!serviceAccountPath) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_PATH is not set.");
  }
  if (!fs.existsSync(serviceAccountPath)) {
    throw new Error(`Service account file not found: ${serviceAccountPath}`);
  }
  return serviceAccountPath;
}

export function getAdminApp() {
  if (admin.apps.length) {
    return admin.app();
  }

  const serviceAccount = JSON.parse(
    fs.readFileSync(readServiceAccountPath(), "utf8")
  );

  return admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: serviceAccount.project_id
  });
}

export function getFirestore() {
  return getAdminApp().firestore();
}

import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

const projectId = 'demo-delivery-template';
for (const [name, expected] of Object.entries({
  FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099'
})) {
  if (process.env[name] && process.env[name] !== expected) throw new Error('Refusing unexpected ' + name);
  process.env[name] = expected;
}
for (const name of ['GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT']) {
  if (process.env[name] && process.env[name] !== projectId) throw new Error('Refusing unexpected ' + name);
}
const app = initializeApp({ projectId });
const auth = getAuth(app);
const uid = 'template-demo-owner';
const password = 'Local-demo-only-2026!';
const email = 'owner@example.test';
try {
  await auth.createUser({ uid, email, password, emailVerified: true, displayName: 'Fictional Demo Owner' });
} catch (error) {
  if (error.code !== 'auth/uid-already-exists') throw error;
  await auth.updateUser(uid, { email, password, emailVerified: true });
}
await auth.setCustomUserClaims(uid, { role: 'owner' });
const db = getFirestore(app);
const batch = db.batch();
batch.set(db.doc('products/DEMO-JUG'), {
  productName: 'Demo refill jug', unitPrice: 50000, defaultDepositAmount: 40000,
  unitLabel: 'jug', category: 'Demo water', containerType: '20l_jug',
  active: true, notes: 'Fictional demo product'
});
batch.set(db.doc('products/DEMO-PACK'), {
  productName: 'Demo bottle pack', unitPrice: 30000, defaultDepositAmount: 0,
  unitLabel: 'pack', category: 'Demo water', containerType: null,
  active: true, notes: 'Fictional demo product'
});
await batch.commit();
console.log('Seeded fictional products and owner in ' + projectId + ' (localhost only).');
console.log('Local demo login: ' + email + ' / ' + password);
await app.delete();

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
  if ((await auth.getUser(uid)).email !== email) throw new Error('Unexpected demo owner identity; start fresh emulators.');
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
await db.doc('drivers/DEMO-DRIVER').set({ driverName: 'Demo Driver', active: true, standardLoadout: { '20l_jug': 10 } });
await db.doc('settings/business').set({ catalogLayout: 'cards', contact: {} });
const customerUid = 'template-demo-customer';
try {
  await auth.createUser({ uid: customerUid, email: 'customer@example.test', password, emailVerified: true,
    displayName: 'Fictional Demo Customer' });
} catch (error) {
  if (error.code !== 'auth/uid-already-exists') throw error;
}
const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const location = { lat: 16.0544, lng: 108.2022, formattedAddress: 'Fictional Demo Stop' };
await db.doc('customers/DEMO-CUSTOMER').set({ name: 'Fictional Demo Customer', authUid: customerUid,
  phone: '+12025550124', email: 'customer@example.test', address: 'Fictional Demo Stop, Da Nang',
  location, additionalAddresses: [], createdAt: new Date().toISOString() });
for (const [id, status] of [['DEMO-PENDING', 'pending_approval'], ['DEMO-ASSIGNED', 'assigned'], ['DEMO-ENROUTE', 'out_for_delivery']]) {
  await db.doc(`orders/${id}`).set({ status, authUid: customerUid, customerId: 'DEMO-CUSTOMER',
    customerName: 'Fictional Demo Customer', phone: '+12025550124', email: 'customer@example.test',
    address: 'Fictional Demo Stop, Da Nang', deliveryLocation: location, deliveryDate: date,
    assignedDriverId: status === 'pending_approval' ? null : 'DEMO-DRIVER', sourceChannel: 'demo',
    subtotal: 30000, depositTotal: 0, amountPaid: 0, balanceDue: 30000, paymentStatus: 'unpaid',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), notes: 'Fictional demo fixture' });
  await db.doc(`orderItems/${id}-item`).set({ orderId: id, authUid: customerUid, customerId: 'DEMO-CUSTOMER',
    productId: 'DEMO-PACK', productName: 'Demo bottle pack', quantity: 1, unitPrice: 30000, lineTotal: 30000 });
}
console.log('Seeded fictional products and owner in ' + projectId + ' (localhost only).');
console.log('Local demo login: ' + email + ' / ' + password);
console.log('Local customer login: customer@example.test / ' + password);
await app.delete();

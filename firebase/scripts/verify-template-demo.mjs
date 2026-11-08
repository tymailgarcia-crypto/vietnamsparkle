import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { initializeApp, deleteApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, signInWithEmailAndPassword } from 'firebase/auth';
import { getStorage, connectStorageEmulator, ref, uploadBytes, getDownloadURL } from 'firebase/storage';

// Fixed destinations, with no service-account or external API access.
const project = 'demo-delivery-template';
const authBase = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1';
const dbBase = `http://127.0.0.1:8080/v1/projects/${project}/databases/(default)/documents`;
const functionsBase = `http://127.0.0.1:5001/${project}/us-central1`;
const configResponse = await fetch('http://127.0.0.1:5000/assets/firebaseWebConfig.js');
const config = await configResponse.text();
assert.ok(configResponse.ok && config.includes(project) && !config.includes('AIza'), 'Start the isolated demo, not the project-specific hosting setup.');
async function json(url, body, token, method = 'POST') {
  const response = await fetch(url, {
    method, headers: { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60000)
  });
  const result = await response.json();
  if (!response.ok || result.error) throw new Error(`${response.status}: ${JSON.stringify(result.error || result)}`);
  return result;
}
const owner = await json(`${authBase}/accounts:signInWithPassword?key=demo-key`, {
  email: 'owner@example.test', password: 'Local-demo-only-2026!', returnSecureToken: true
});
const suffix = randomUUID().slice(0, 8);
const customer = await json(`${authBase}/accounts:signUp?key=demo-key`, {
  email: `customer-${suffix}@example.test`, password: 'Local-demo-only-2026!', returnSecureToken: true
});
async function call(name, data, token = owner.idToken) {
  return (await json(`${functionsBase}/${name}`, { data }, token)).result;
}
const read = async p => json(`${dbBase}/${p}`, null, owner.idToken, 'GET');
const patch = async (p, values) => {
  const fields = Object.fromEntries(Object.entries(values).map(([k, value]) => [k, { stringValue: value }]));
  const masks = Object.keys(values).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
  return json(`${dbBase}/${p}?${masks}`, { fields }, owner.idToken, 'PATCH');
};
const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const attempt = {
  submissionKey: randomUUID(),
  customer: { name: 'Fictional Demo Customer', phone: '+12025550123', email: `customer-${suffix}@example.test`,
    address: 'Fictional Demo Stop, Da Nang', deliveryDate: date,
    deliveryLocation: { lat: 16.0544, lng: 108.2022, formattedAddress: 'Fictional Demo Stop' } },
  items: [{ productId: 'DEMO-JUG', quantity: 1 }]
};
const order = await call('submitPublicOrder', attempt, customer.idToken);
const retry = await call('submitPublicOrder', attempt, customer.idToken);
assert.equal(retry.orderId, order.orderId, 'submission retry must reuse one order');
await call('approveOrder', { orderId: order.orderId });
await patch(`orders/${order.orderId}`, { assignedDriverId: 'DEMO-DRIVER', status: 'assigned' });
await patch(`orders/${order.orderId}`, { status: 'out_for_delivery' });
const delivered = await call('commitDelivery', { orderId: order.orderId, paymentId: `demo-${suffix}-delivery`,
  payment: { collected: true, amount: 50000, method: 'cash' }, returns: [] });
assert.equal(delivered.status, 'delivered');
assert.equal(delivered.balanceDue, 40000);
const payment = { orderId: order.orderId, paymentId: `demo-${suffix}-settlement`, payment: { collected: true, amount: 40000, method: 'cash' } };
await call('recordPayment', payment);
await call('recordPayment', payment);
let stored = await read(`orders/${order.orderId}`);
assert.equal(Number(stored.fields.amountPaid.integerValue || stored.fields.amountPaid.doubleValue), 90000);
assert.equal(Number(stored.fields.balanceDue.integerValue || stored.fields.balanceDue.doubleValue || 0), 0);

// A second delivery returns the first jug. Its deposit credit reduces cash due.
const second = await call('submitPublicOrder', { ...attempt, submissionKey: randomUUID() }, customer.idToken);
await call('approveOrder', { orderId: second.orderId });
await patch(`orders/${second.orderId}`, { assignedDriverId: 'DEMO-DRIVER', status: 'assigned' });
await patch(`orders/${second.orderId}`, { status: 'out_for_delivery' });
// A synthetic one-pixel PNG is a transport fixture, not a real container photo.
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZkAAAAASUVORK5CYII=', 'base64');
const storagePath = `payment-proofs/${second.orderId}/synthetic-return.png`;
const proofApp = initializeApp({ apiKey: 'demo-key', projectId: project, storageBucket: `${project}.appspot.com` }, 'demo-proof-check');
const proofAuth = getAuth(proofApp);
connectAuthEmulator(proofAuth, 'http://127.0.0.1:9099', { disableWarnings: true });
const storage = getStorage(proofApp);
connectStorageEmulator(storage, '127.0.0.1', 9199);
await signInWithEmailAndPassword(proofAuth, 'owner@example.test', 'Local-demo-only-2026!');
const proofRef = ref(storage, storagePath);
await uploadBytes(proofRef, image, { contentType: 'image/png' });
const downloadUrl = await getDownloadURL(proofRef);
await deleteApp(proofApp);
const proofId = `DEMO-PROOF-${suffix}`;
await patch(`documents/${proofId}`, { entityType: 'order', entityId: second.orderId,
  documentType: 'container_return_proof', storagePath, contentType: 'image/png',
  downloadUrl,
  notes: 'Synthetic transport fixture; not a real container photograph.' });
const returned = await call('commitDelivery', { orderId: second.orderId, paymentId: `demo-${suffix}-return`,
  payment: { collected: true, amount: 50000, method: 'cash' },
  returns: [{ type: '20l_jug', returnedQty: 1, handling: 'credit' }],
  returnProofDocumentId: proofId, returnProofType: 'photo_note',
  returnProofNote: 'Fictional demo: one empty jug collected and counted at the demo stop.' });
assert.equal(returned.creditTotal, 40000);
assert.equal(returned.balanceDue, 0);
const proof = await read(`payments/${second.orderId}-deposit-credit`);
assert.match(proof.fields.proofNote.stringValue, /Fictional demo/);
assert.equal(proof.fields.proofDocumentId.stringValue, proofId);
const anonymous = await fetch(`${functionsBase}/recordPayment`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: payment })
});
assert.equal(anonymous.status, 403);
const evidence = { verifiedAt: new Date().toISOString(), project, orderIds: [order.orderId, second.orderId],
  checks: ['authenticated public submission', 'idempotent submission retry', 'owner approval',
    'driver assignment through rules', 'partial delivery payment', 'remaining payment',
    'idempotent payment retry', 'synthetic proof upload through Storage rules',
    'container return with linked proof and note', 'anonymous payment denied'],
  externalServices: 'disabled; no real payment or message sent' };
await mkdir(new URL('../.firebase/template-demo/', import.meta.url), { recursive: true });
await writeFile(new URL('../.firebase/template-demo/lifecycle-verification.json', import.meta.url), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 2));

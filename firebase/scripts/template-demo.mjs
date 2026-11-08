import { cp, mkdir, writeFile, readFile, symlink, lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const projectId = 'demo-delivery-template';
const target = path.join(root, '.firebase/template-demo');
const web = path.join(target, 'web');
await mkdir(target, { recursive: true });
await cp(path.join(root, 'web'), web, { recursive: true });
for (const name of ['firestore.rules', 'firestore.indexes.json', 'storage.rules']) {
  await cp(path.join(root, name), path.join(target, name));
}
await writeFile(path.join(web, 'assets/firebaseWebConfig.js'), `
export const firebaseWebConfig = {
  apiKey: 'demo-not-a-real-api-key', authDomain: 'localhost',
  projectId: 'demo-delivery-template', storageBucket: 'demo-delivery-template.appspot.com',
  appId: 'demo-template', messagingSenderId: '000000000000'
};
export const appCheckSiteKey = '';
export const appCheckProviderType = 'enterprise';
export const mapsApiKey = '';
export const mapsDefaultCenter = { lat: 16.0544, lng: 108.2022 };
export const webPushVapidKey = '';
`);
await writeFile(path.join(web, 'firebase-messaging-sw.js'), '// Push disabled in isolated preview.\n');
const functionsDir = path.join(target, 'functions');
await mkdir(functionsDir, { recursive: true });
for (const name of ['package.json', 'index.js', 'cancellationMath.js', 'staff.js', 'helpChat.js', 'helpGuide.md', 'aiOrder.js']) {
  await cp(path.join(root, 'functions', name), path.join(functionsDir, name === 'index.js' ? 'appFunctions.cjs' : name));
}
// Modify only the disposable copy: even seeded push tokens cannot send messages.
const sourcePath = path.join(functionsDir, 'appFunctions.cjs');
const source = await readFile(sourcePath, 'utf8');
const pushSignature = 'async function sendOwnerPush({ title, body, url, tag, kind }) {';
if (!source.includes(pushSignature)) throw new Error('Push adapter changed; review demo isolation before starting.');
await writeFile(sourcePath, source.replace(pushSignature, pushSignature + '\n  return { sent: 0, demo: true }; // Isolated demo: never contact FCM.'));
await writeFile(path.join(functionsDir, 'index.js'), `
const { onCall, HttpsError } = require('firebase-functions/https');
const source = require('./appFunctions.cjs');
for (const name of ['submitPublicOrder', 'approveOrder', 'commitDelivery', 'recordPayment',
  'submitOrderCancellation', 'resolveOrderCancellation', 'recordOrderRefund',
  'attachRefundEvidence', 'resolveLegacyCancellation', 'mergeCustomers', 'manageStaff', 'saveAiOrder']) {
  if (source[name]) exports[name] = source[name];
}
exports.parseAiOrder = onCall(() => { throw new HttpsError('failed-precondition', 'External AI is disabled in this fictional-data demo. Use manual order entry.'); });
exports.askHelp = onCall(request => {
  if (request.auth?.token?.role !== 'owner') throw new HttpsError('permission-denied', 'Sign in as the demo owner.');
  return { answer: 'Local demo: approve an order in Orders, assign the Demo Driver, mark it out for delivery, then record delivery and payment. External AI is disabled.' };
});
`);
const deps = path.join(functionsDir, 'node_modules');
try { await lstat(deps); } catch (error) {
  if (error.code !== 'ENOENT') throw error;
  await symlink(path.join(root, 'functions/node_modules'), deps, process.platform === 'win32' ? 'junction' : 'dir');
}
const config = {
  functions: [{ source: 'functions', codebase: 'template-demo', runtime: 'nodejs22' }],
  firestore: { rules: 'firestore.rules', indexes: 'firestore.indexes.json' },
  storage: { rules: 'storage.rules' },
  hosting: { public: 'web', ignore: ['**/.*', '**/*.test.mjs'],
    headers: [{ source: '**', headers: [{ key: 'Cache-Control', value: 'no-store' }] }] },
  emulators: {
    auth: { host: '127.0.0.1', port: 9099 },
    firestore: { host: '127.0.0.1', port: 8080 },
    storage: { host: '127.0.0.1', port: 9199 },
    hosting: { host: '127.0.0.1', port: 5000 },
    functions: { host: '127.0.0.1', port: 5001 },
    ui: { enabled: false }, singleProjectMode: true
  }
};
const configPath = path.join(target, 'firebase.json');
await writeFile(configPath, JSON.stringify(config, null, 2));
console.log('Prepared isolated preview for ' + projectId + '. Source config unchanged.');
if (!process.argv.includes('--prepare-only')) {
  const require = createRequire(import.meta.url);
  const cli = require.resolve('firebase-tools/lib/bin/firebase.js');
  const child = spawn(process.execPath, [cli, 'emulators:start', '--project', projectId,
    '--config', configPath, '--only', 'auth,firestore,storage,hosting,functions'], {
      cwd: root, stdio: 'inherit',
      env: { ...process.env, GEMINI_API_KEY: '', FIREBASE_SERVICE_ACCOUNT_PATH: '', GOOGLE_APPLICATION_CREDENTIALS: '',
        GCLOUD_PROJECT: projectId, GOOGLE_CLOUD_PROJECT: projectId, FIREBASE_CLI_DISABLE_UPDATE_CHECK: 'true',
        FUNCTIONS_DISCOVERY_TIMEOUT: '60' }
    });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
}

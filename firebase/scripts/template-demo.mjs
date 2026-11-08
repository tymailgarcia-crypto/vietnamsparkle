import { cp, mkdir, writeFile } from 'node:fs/promises';
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
const config = {
  firestore: { rules: 'firestore.rules', indexes: 'firestore.indexes.json' },
  storage: { rules: 'storage.rules' },
  hosting: { public: 'web', ignore: ['**/.*', '**/*.test.mjs'],
    headers: [{ source: '**', headers: [{ key: 'Cache-Control', value: 'no-store' }] }] },
  emulators: {
    auth: { host: '127.0.0.1', port: 9099 },
    firestore: { host: '127.0.0.1', port: 8080 },
    storage: { host: '127.0.0.1', port: 9199 },
    hosting: { host: '127.0.0.1', port: 5000 },
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
    '--config', configPath, '--only', 'auth,firestore,storage,hosting'], { cwd: root, stdio: 'inherit' });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
}

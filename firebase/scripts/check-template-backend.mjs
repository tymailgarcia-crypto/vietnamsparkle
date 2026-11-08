import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, cp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
if (!process.argv.includes('--inside')) {
  const dir = path.join(root, '.firebase/template-backend');
  await mkdir(dir, { recursive: true });
  await cp(path.join(root, 'firestore.rules'), path.join(dir, 'firestore.rules'));
  await writeFile(path.join(dir, 'firebase.json'), JSON.stringify({
    firestore: { rules: 'firestore.rules' }, emulators: {
      auth: { host: '127.0.0.1', port: 9098 }, firestore: { host: '127.0.0.1', port: 8082 },
      hub: { host: '127.0.0.1', port: 4402 }, logging: { host: '127.0.0.1', port: 4502 },
      ui: { enabled: false }, singleProjectMode: false
    }
  }, null, 2));
  const require = createRequire(import.meta.url);
  const command = `"${process.execPath}" "${fileURLToPath(import.meta.url)}" --inside`;
  const child = spawn(process.execPath, [require.resolve('firebase-tools/lib/bin/firebase.js'),
    'emulators:exec', '--project', 'demo-template-backend', '--config', path.join(dir, 'firebase.json'),
    '--only', 'auth,firestore', command], { cwd: dir, stdio: 'inherit' });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
for (const [key, expected] of Object.entries({ FIRESTORE_EMULATOR_HOST: '127.0.0.1:8082', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9098' })) {
  if (process.env[key] && process.env[key] !== expected) throw new Error(`Refusing unexpected ${key}`);
}
const suites = ['orderSubmission.emulator.test.js', 'approveOrder.emulator.test.js',
  'commitDelivery.emulator.test.js', 'recordPayment.emulator.test.js',
  'cancellation.emulator.test.js', 'staff.emulator.test.js', 'aiOrder.emulator.test.js',
  'paymentEntry.parity.test.mjs', 'deliveryValidation.parity.test.mjs',
  'customerIdentity.test.mjs', 'customerIdentity.emulator.test.js', 'cancellationMath.test.js'];
let failed = 0;
for (const [i, suite] of suites.entries()) {
  console.log(`\nBackend: ${suite}`);
  // Distinct demo project per suite prevents fixture collisions with the demo UI.
  const project = suite === 'staff.emulator.test.js' ? 'demo-template-backend' : `demo-template-suite-${i}`;
  const result = spawnSync(process.execPath, [suite], {
    cwd: fileURLToPath(new URL('../functions/', import.meta.url)), stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'test', GCLOUD_PROJECT: project, GOOGLE_CLOUD_PROJECT: project,
      FIRESTORE_EMULATOR_HOST: '127.0.0.1:8082', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9098',
      GOOGLE_APPLICATION_CREDENTIALS: '', GEMINI_API_KEY: '', FIREBASE_SERVICE_ACCOUNT_PATH: '' }
  });
  if (result.status !== 0) failed++;
}
console.log(`\n${suites.length - failed}/${suites.length} backend suites passed.`);
process.exitCode = failed ? 1 : 0;
}

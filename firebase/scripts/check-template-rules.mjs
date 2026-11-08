import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Start `pnpm demo` first. All existing rules suites explicitly bind loopback.
const ready = await fetch('http://127.0.0.1:4400/emulators', { signal: AbortSignal.timeout(5000) });
const emulators = await ready.json();
if (emulators.firestore?.host !== '127.0.0.1' || emulators.firestore?.port !== 8080 ||
    emulators.storage?.host !== '127.0.0.1' || emulators.storage?.port !== 9199) {
  throw new Error('Start the isolated template demo before running rules checks.');
}
const root = fileURLToPath(new URL('../', import.meta.url));
const suites = (await readdir(new URL('../rules-tests/', import.meta.url))).filter(p => p.endsWith('.test.mjs')).sort();
let failed = 0;
for (const suite of suites) {
  console.log(`\nRules: ${suite}`);
  const result = spawnSync(process.execPath, [`rules-tests/${suite}`], { cwd: root, stdio: 'inherit',
    env: { ...process.env, FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080', FIREBASE_STORAGE_EMULATOR_HOST: '127.0.0.1:9199' } });
  if (result.status !== 0) failed++;
}
console.log(`\n${suites.length - failed}/${suites.length} rules suites passed.`);
process.exitCode = failed ? 1 : 0;

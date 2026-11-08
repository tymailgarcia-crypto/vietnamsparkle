import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const cwd = fileURLToPath(new URL('../', import.meta.url));
const suites = [
  'web/assets/customerErrors.test.mjs',
  'web/assets/reorderChanges.test.mjs',
  'web/assets/orderSubmissionKey.test.mjs',
  'web/assets/accountTruth.test.mjs',
  'web/assets/depositLedger.test.mjs',
  'web/assets/returnProofGate.test.mjs',
  'web/assets/returnDelivery.test.mjs',
  'web/assets/deliveryRouting.test.mjs',
  'web/assets/aiOrderModel.test.mjs',
  'web/assets/helpChatRender.test.mjs'
];
let failures = 0;
for (const suite of suites) {
  console.log('\nRunning ' + suite);
  const result = spawnSync(process.execPath, [suite], { cwd, stdio: 'inherit' });
  if (result.status !== 0) failures++;
}
console.log('\n' + (suites.length - failures) + '/' + suites.length + ' focused suites passed.');
process.exitCode = failures ? 1 : 0;

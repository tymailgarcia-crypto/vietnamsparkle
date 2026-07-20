import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const account = await readFile(new URL("../web/assets/accountApp.js", import.meta.url), "utf8");
const rules = await readFile(new URL("../firestore.rules", import.meta.url), "utf8");
const functions = await readFile(new URL("../functions/index.js", import.meta.url), "utf8");

const cancelUi = account.slice(account.indexOf("function renderCancelAction"), account.indexOf("function renderOrders"));
assert.match(cancelUi, /order\.status === "pending_approval"/);
assert.doesNotMatch(cancelUi, /data-request-cancel|Request cancellation|cancellationRequested|prompt\(/);
assert.match(cancelUi, /confirm\("Cancel this unapproved order\?"\)/);
assert.doesNotMatch(cancelUi, /cancellationReason/);

assert.match(rules, /resource\.data\.status == 'pending_approval'[\s\S]*request\.resource\.data\.status == 'cancelled'/);
assert.doesNotMatch(rules, /hasOnly\(\['cancellationRequested', 'cancellationRequestReason'/);

const callable = functions.slice(functions.indexOf("exports.submitOrderCancellation"), functions.indexOf("exports.resolveOrderCancellation"));
assert.match(callable, /if \(role !== "owner"\) throw new HttpsError\("permission-denied"/);
assert.doesNotMatch(callable, /requestedByRole: "customer"|cancellationRequested:/);

console.log("customer cancellation policy checks: 8/8 passed");

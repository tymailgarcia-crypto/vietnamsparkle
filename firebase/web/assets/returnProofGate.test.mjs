// Tests that BOTH delivery dialogs actually enforce, and actually surface, the
// container-return evidence rule. No emulator, no DOM library. Run:
//   cd firebase
//   node web/assets/returnProofGate.test.mjs
//
// Point it at a different tree — e.g. files fetched from production — with:
//   WEB_ROOT=/path/to/web node web/assets/returnProofGate.test.mjs
//
// The rule's own arithmetic (photo vs note vs length) is covered in
// depositLedger.test.mjs. What these pin instead is the wiring around it:
//
//   1. The owner must never be blocked from closing an order while the controls
//      that would unblock it are hidden. That strands a driver mid-delivery with
//      no way forward, and it is the one failure mode this whole feature can
//      introduce. It holds only because the field toggle and the save gate
//      derive from the SAME collector call, and because both the photo input and
//      the note textarea live inside the single element that gets toggled.
//   2. A return recorded from either dialog carries its evidence into the ledger
//      — the document id onto the deposit_credit payment and the return events,
//      and the proof type alongside. A credit with no account of it is exactly
//      how a deposit goes missing: the driver credits it but forgets to load the
//      empty.
//   3. Neither dialog hardcodes its own wording or its own bar. The dashboard
//      shipped for months with no proof requirement at all while the order page
//      enforced one; the shared rule is what stops that reopening.
//
// The functions under test are sliced out of the real modules at run time rather
// than copied, so these cannot quietly drift from what ships.

import assert from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = process.env.WEB_ROOT || join(HERE, "..");
const read = (p) => readFileSync(join(WEB, p), "utf8");

const adminSrc = read("assets/adminApp.js");
const orderSrc = read("assets/orderApp.js");
const adminHtml = read("admin.html");
const orderHtml = read("order.html");
const { containerReturnProofProblem } =
  await import(pathToFileURL(join(WEB, "assets/shared.js")).href);

let passed = 0;
let failed = 0;
function it(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed += 1;
  } catch (err) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err && err.message ? err.message.split("\n")[0] : err}`);
    failed += 1;
  }
}

// Lifts a function's source straight out of the shipped module, so the test
// exercises the real implementation instead of a copy that can rot.
function sliceFn(src, name, label) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} not found in ${label}`);
  let depth = 0;
  let i = src.indexOf("{", start);
  for (; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return src.slice(start, i + 1);
}

const collectSrc = sliceFn(adminSrc, "collectAdminDeliveryReturns", "adminApp.js");

// Just enough DOM for the collector and the one toggle line that follows it.
function runCollect(rows, held) {
  const qtyNodes = rows.map((row) => ({
    dataset: { returnQty: row.type },
    value: String(row.qty)
  }));
  const handling = Object.fromEntries(rows.map((row) => [row.type, { value: row.handling }]));
  const field = { className: "hidden" };
  field.classList = {
    toggle(cls, force) {
      field.className = force ? cls : "";
    }
  };
  const document = {
    querySelectorAll: (sel) => (sel === "[data-return-qty]" ? qtyNodes : []),
    querySelector: (sel) => {
      const match = /\[data-return-handling="(.+?)"\]/.exec(sel);
      return match ? handling[match[1]] || null : null;
    },
    getElementById: (id) => (id === "delivery-return-proof-field" ? field : null)
  };
  const returns = new Function(
    "document",
    "deliveryDialogState",
    `${collectSrc}; return collectAdminDeliveryReturns();`
  )(document, { heldContainers: held });
  // the exact toggle expression that ships in recalcAdminDeliveryCod
  document.getElementById("delivery-return-proof-field")?.classList.toggle("hidden", returns.length === 0);
  return { returns, hidden: field.className === "hidden" };
}

const HELD = { jug: { qty: 5, depositPerUnit: 50000 } };
const NONE = { jug: { qty: 0, depositPerUnit: 50000 } };

console.log("\ncollector — what counts as a container physically changing hands\n");

it("a credited return counts, and reveals the evidence block", () => {
  const { returns, hidden } = runCollect([{ type: "jug", qty: 2, handling: "credit" }], HELD);
  assert.strictEqual(returns.length, 1);
  assert.strictEqual(hidden, false);
});

it("a refunded return counts too — cash back is still a handover", () => {
  const { returns, hidden } = runCollect([{ type: "jug", qty: 1, handling: "refund" }], HELD);
  assert.strictEqual(returns.length, 1);
  assert.strictEqual(hidden, false);
});

it("qty 0 is not a return, and demands nothing", () => {
  const { returns, hidden } = runCollect([{ type: "jug", qty: 0, handling: "credit" }], HELD);
  assert.strictEqual(returns.length, 0);
  assert.strictEqual(hidden, true);
});

it("'owner will decide later' defers the deposit, so nothing is demanded yet", () => {
  const { returns, hidden } = runCollect([{ type: "jug", qty: 2, handling: "keep" }], HELD);
  assert.strictEqual(returns.length, 0);
  assert.strictEqual(hidden, true);
});

it("a customer holding nothing cannot return anything", () => {
  const { returns, hidden } = runCollect([{ type: "jug", qty: 2, handling: "credit" }], NONE);
  assert.strictEqual(returns.length, 0);
  assert.strictEqual(hidden, true);
});

it("returned qty is clamped to what they actually hold", () => {
  const { returns } = runCollect([{ type: "jug", qty: 99, handling: "credit" }], HELD);
  assert.strictEqual(returns[0].returnedQty, 5);
});

console.log("\nthe invariant — never blocked behind controls that are hidden\n");

it("save is never blocked while the evidence block is hidden", () => {
  const evidence = [
    { hasPhoto: false, note: "" },
    { hasPhoto: false, note: "short" },
    { hasPhoto: true, note: "" },
    { hasPhoto: false, note: "3 crates collected from Ms Hoa at the shop" }
  ];
  const scenarios = [
    [{ type: "jug", qty: 2, handling: "credit" }],
    [{ type: "jug", qty: 1, handling: "refund" }],
    [{ type: "jug", qty: 0, handling: "credit" }],
    [{ type: "jug", qty: 2, handling: "keep" }],
    []
  ];
  for (const rows of scenarios) {
    for (const held of [HELD, NONE]) {
      const { returns, hidden } = runCollect(rows, held);
      for (const supplied of evidence) {
        const blocked = returns.length > 0 && containerReturnProofProblem(supplied) !== null;
        assert.ok(
          !(blocked && hidden),
          `blocked with the block hidden: ${JSON.stringify({ rows, held, supplied })}`
        );
      }
    }
  }
});

console.log("\nmarkup — the controls the rule can demand exist, and travel together\n");

for (const [label, html] of [["admin.html", adminHtml], ["order.html", orderHtml]]) {
  it(`${label}: the evidence block is defined exactly once and ships hidden`, () => {
    assert.strictEqual((html.match(/id="delivery-return-proof-field"/g) || []).length, 1);
    assert.match(html, /id="delivery-return-proof-field"[^>]*class="hidden"/);
  });

  it(`${label}: both the photo input and the note textarea sit INSIDE that block`, () => {
    const from = html.indexOf('id="delivery-return-proof-field"');
    const inner = html.slice(from, from + html.slice(from).indexOf("</div>"));
    assert.ok(inner.includes('id="delivery-return-proof"'), "photo input escaped the toggled block");
    assert.ok(inner.includes('id="delivery-return-note"'), "note textarea escaped the toggled block");
  });
}

console.log("\nwiring — one shared bar, and the evidence reaches the ledger\n");

for (const [label, src] of [["adminApp.js", adminSrc], ["orderApp.js", orderSrc]]) {
  const collector = label === "adminApp.js" ? "collectAdminDeliveryReturns()" : "collectDeliveryReturns()";
  const recalcName = label === "adminApp.js" ? "recalcAdminDeliveryCod" : "recalcDeliveryCod";
  const save = sliceFn(src, "saveDeliveryPayment", label);
  const recalc = sliceFn(src, recalcName, label);

  it(`${label}: takes the bar from shared.js rather than its own copy`, () => {
    assert.match(src, /import\s*\{[^}]*\bcontainerReturnProofProblem\b[^}]*\}\s*from "\.\/shared\.js"/);
  });

  // Without this the suite above would still pass while the app deadlocked: the
  // invariant is checked against the toggle expression, so something has to
  // confirm the module still performs it.
  it(`${recalcName}: still reveals the block, driven by the same collector`, () => {
    assert.ok(recalc.includes(collector), `${recalcName} no longer reads ${collector}`);
    assert.match(
      recalc,
      /delivery-return-proof-field"\)\??\.classList\.toggle\("hidden", returns\.length === 0\)/,
      `${recalcName} no longer toggles the evidence block off the collector result`
    );
  });

  it(`${label}: the gate and the toggle read the same collector`, () => {
    assert.ok(save.includes(collector), `save does not call ${collector}`);
    assert.ok(save.includes("containerReturnProofProblem("), "save does not consult the shared rule");
  });

  it(`${label}: the photo is uploaded before calling the atomic backend`, () => {
    const upload = save.indexOf("uploadContainerReturnProof(");
    const call = save.indexOf("commitDeliveryFn(");
    assert.ok(upload > -1, "no upload call");
    assert.ok(call > upload, "the callable must receive an already uploaded photo");
    assert.ok(!save.includes('runTransaction('), 'delivery money writes belong to the backend');
  });

  it(`${label}: forwards photo, proof type and written evidence to the backend`, () => {
    const call = save.slice(save.indexOf('commitDeliveryFn('));
    assert.match(call, /\breturnProofDocumentId\s*,/);
    assert.match(call, /\breturnProofType\s*,/);
    assert.match(call, /\breturnProofNote\b/);
  });
}

const server = readFileSync(join(HERE, '../../functions/index.js'), 'utf8');
const commit = sliceFn(server, 'commitDeliveryImpl', 'functions/index.js');
it('atomic backend: records the photo and proof type on deposit credit', () => {
  assert.match(commit, /method: "deposit_credit"[\s\S]*proofDocumentId: returnProofDocumentId/);
  assert.match(commit, /method: "deposit_credit"[\s\S]*proofType: returnProofType/);
});
it('atomic backend: links the photo and written evidence to return events', () => {
  assert.match(commit, /linkedDocumentId: returnProofDocumentId/);
  assert.match(commit, /proofNote: returnProofNote/);
});

console.log("\nanti-drift — the dashboard cannot fall behind the order page again\n");

it("neither dialog hardcodes the wording; the shared rule owns it", () => {
  const adminSave = sliceFn(adminSrc, "saveDeliveryPayment", "adminApp.js");
  const orderSave = sliceFn(orderSrc, "saveDeliveryPayment", "orderApp.js");
  for (const [label, save] of [["adminApp.js", adminSave], ["orderApp.js", orderSave]]) {
    assert.ok(
      !save.includes("Add a photo of the returned containers"),
      `${label} hardcodes the message instead of using the rule`
    );
  }
});

it("both dialogs read the same two control ids", () => {
  const adminSave = sliceFn(adminSrc, "saveDeliveryPayment", "adminApp.js");
  const orderSave = sliceFn(orderSrc, "saveDeliveryPayment", "orderApp.js");
  for (const id of ["delivery-return-proof", "delivery-return-note"]) {
    assert.ok(adminSave.includes(id), `adminApp.js never reads #${id}`);
    assert.ok(orderSave.includes(id), `orderApp.js never reads #${id}`);
  }
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);

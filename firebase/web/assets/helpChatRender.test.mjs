// Tests for the staff help-chat answer renderer. Pure — no DOM. Run:
//   cd firebase
//   node web/assets/helpChatRender.test.mjs
//
// What these pin: a Gemini answer is untrusted text. It must be escaped before
// any markup is added back, and the only links allowed are relative links to
// our own pages — never javascript:, off-site, or protocol-relative URLs.

import assert from "node:assert";
import { renderAnswer } from "./helpChatRender.js";

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

it("escapes raw HTML in an answer", () => {
  const html = renderAnswer('<img src=x onerror="alert(1)"> <script>alert(2)</script>');
  assert.ok(!html.includes("<img"));
  assert.ok(!html.includes("<script"));
  assert.ok(html.includes("&lt;img"));
});

it("turns a relative page link into an anchor", () => {
  assert.strictEqual(
    renderAnswer("Open [Deposits](./deposits.html) first."),
    '<p>Open <a href="./deposits.html">Deposits</a> first.</p>'
  );
});

it("keeps a query string on a page link", () => {
  assert.ok(renderAnswer("[Dashboard](./admin.html?date=2026-10-23)").includes('href="./admin.html?date=2026-10-23"'));
});

it("leaves javascript:, off-site and protocol-relative links as text", () => {
  for (const url of ["javascript:alert(1)", "https://evil.example/x.html", "//evil.example/a.html", "../secret.html"]) {
    const html = renderAnswer(`[click](${url})`);
    assert.ok(!html.includes("<a"), url);
  }
});

it("cannot break out of the href attribute with a quote", () => {
  const html = renderAnswer('[x](./orders.html?a="onmouseover=alert(1))');
  assert.ok(!/href="[^"]*"[^>]*onmouseover/.test(html));
});

it("renders bold and numbered steps", () => {
  assert.strictEqual(
    renderAnswer("Do this:\n1. Tap **Approve**\n2. Done"),
    "<p>Do this:</p><ol><li>Tap <strong>Approve</strong></li><li>Done</li></ol>"
  );
});

it("renders dashed lists and separates them from paragraphs", () => {
  assert.strictEqual(
    renderAnswer("- one\n- two\n\nWant step-by-step help?"),
    "<ul><li>one</li><li>two</li></ul><p>Want step-by-step help?</p>"
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

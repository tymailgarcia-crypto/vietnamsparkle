import {
  auth,
  collection,
  db,
  getDocs,
  limit,
  onAuthStateChanged,
  orderBy,
  query
} from "./firebaseClient.js";
import { escapeHtml, formatCurrency, requireRole } from "./shared.js";

// Read-only view over reconciliationReports/{runId} + its drifts/{orderId}
// subcollection, both written by nightlyReconcileOrderMath (Admin SDK) and
// owner-read / no-client-write in firestore.rules. Nothing here writes.

const RUN_LIMIT = 30;
const DRIFT_LIMIT = 200;
const EVENT_LIMIT = 100;
// The whole cancellation ledger is tiny; pull a generous recent window and
// filter client-side for the two "needs attention" conditions. There is no
// compound OR query for refundStatus-in OR evidenceStatus, and a bounded recent
// window keeps this a single read.
const CANCELLATION_LIMIT = 300;

// The job runs daily at 03:00 Asia/Ho_Chi_Minh. Past this much silence,
// something is wrong with the schedule rather than with the data.
const STALE_HOURS = 30;

const state = {
  runs: [],
  drifts: {},
  expanded: {},
  driftedOnly: false,
  events: [],
  eventsError: null,
  cancellations: [],
  cancellationsError: null
};

function el(id) {
  return document.getElementById(id);
}

function setStatus(message) {
  const node = el("list-status");
  if (node) node.textContent = message || "";
}

function toDate(value) {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// Runs are scheduled in Da Nang time, so show them in Da Nang time — a run
// labelled 03:00 should read as 03:00 wherever the owner opens this page.
function formatRunTime(date) {
  if (!date) return "Unknown time";
  return date.toLocaleString("en-GB", {
    timeZone: "Asia/Ho_Chi_Minh",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}

function hoursSince(date) {
  if (!date) return Infinity;
  return (Date.now() - date.getTime()) / (1000 * 60 * 60);
}

function durationLabel(run) {
  const started = toDate(run.startedAt);
  const finished = toDate(run.finishedAt);
  if (!started || !finished) return "";
  const seconds = Math.max(0, Math.round((finished.getTime() - started.getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function statusBadge(run) {
  const status = String(run.status || "");
  if (status === "failed") return `<span class="badge recon-badge-failed">Failed</span>`;
  if (status === "running") return `<span class="badge recon-badge-running">Running</span>`;
  if (Number(run.failed || 0) > 0) return `<span class="badge recon-badge-failed">${Number(run.failed)} fix failed</span>`;
  if (Number(run.drifted || 0) > 0) return `<span class="badge recon-badge-drift">Drift corrected</span>`;
  return `<span class="badge recon-badge-clean">Clean</span>`;
}

function moneyDelta(before, after) {
  const diff = Number(after || 0) - Number(before || 0);
  if (diff === 0) return "";
  const sign = diff > 0 ? "+" : "−";
  return `<span class="recon-delta">${sign}${escapeHtml(formatCurrency(Math.abs(diff)))}</span>`;
}

function renderDriftRows(runId) {
  const rows = state.drifts[runId];
  if (rows === "loading") {
    return `<p class="muted" style="margin:0;padding:12px">Loading corrected orders…</p>`;
  }
  if (typeof rows === "string") {
    return `<p class="muted" style="margin:0;padding:12px;color:var(--danger)">${escapeHtml(rows)}</p>`;
  }
  if (!rows || !rows.length) {
    return `<p class="muted" style="margin:0;padding:12px">No drift records were written for this run.</p>`;
  }

  const body = rows.map((drift) => {
    const before = drift.before || {};
    const after = drift.after || {};
    const orderHref = `./order.html?id=${encodeURIComponent(drift.orderId || "")}`;
    const owed = Number(drift.subtotal || 0) + Number(drift.depositTotal || 0);
    return `
      <tr class="recon-drift-row">
        <td data-label="Order" class="recon-drift-order">
          <a href="${orderHref}"><code>${escapeHtml(drift.orderId || "")}</code></a>
        </td>
        <td data-label="Order total">${escapeHtml(formatCurrency(owed))}</td>
        <td data-label="Payments">${Number(drift.paymentsCount || 0)}</td>
        <td data-label="Paid — was">${escapeHtml(formatCurrency(before.amountPaid))}</td>
        <td data-label="Paid — now" class="recon-drift-after">
          ${escapeHtml(formatCurrency(after.amountPaid))} ${moneyDelta(before.amountPaid, after.amountPaid)}
        </td>
        <td data-label="Balance — was">${escapeHtml(formatCurrency(before.balanceDue))}</td>
        <td data-label="Balance — now" class="recon-drift-after">
          ${escapeHtml(formatCurrency(after.balanceDue))} ${moneyDelta(before.balanceDue, after.balanceDue)}
        </td>
        <td data-label="Status">
          <span class="muted">${escapeHtml(before.paymentStatus || "—")}</span>
          → <strong>${escapeHtml(after.paymentStatus || "—")}</strong>
        </td>
      </tr>
    `;
  }).join("");

  return `
    <div class="customer-table-wrap">
      <table class="customer-table recon-drift-table">
        <thead>
          <tr>
            <th>Order</th>
            <th>Order total</th>
            <th>Payments</th>
            <th>Paid — was</th>
            <th>Paid — now</th>
            <th>Balance — was</th>
            <th>Balance — now</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>${body}</tbody>
      </table>
    </div>
  `;
}

function renderRuns() {
  const list = el("run-list");
  const visible = state.driftedOnly
    ? state.runs.filter((run) => Number(run.drifted || 0) > 0 || run.status === "failed")
    : state.runs;

  setStatus(state.driftedOnly
    ? `${visible.length} of ${state.runs.length} recent runs needed a correction`
    : `${state.runs.length} most recent run${state.runs.length === 1 ? "" : "s"}`);

  if (!visible.length) {
    list.innerHTML = `<p class="muted" style="padding:20px;text-align:center">${
      state.runs.length
        ? "No drift in any recent run. Every order's money matches its payments."
        : "No reconciliation runs recorded yet. The job runs nightly at 03:00."
    }</p>`;
    return;
  }

  list.innerHTML = visible.map((run) => {
    const drifted = Number(run.drifted || 0);
    const failed = Number(run.failed || 0);
    const duration = durationLabel(run);
    const expanded = !!state.expanded[run.id];
    const attention = drifted > 0 || failed > 0 || run.status === "failed";

    const errorLine = run.error
      ? `<p class="recon-error">The run did not finish: ${escapeHtml(run.error)}</p>`
      : "";

    const expander = drifted > 0
      ? `<button class="ghost recon-expand" type="button" data-run="${escapeHtml(run.id)}"
           aria-expanded="${expanded}">${expanded ? "Hide" : "Show"} ${drifted} corrected order${drifted === 1 ? "" : "s"}</button>`
      : "";

    return `
      <article class="recon-run${attention ? " is-attention" : ""}">
        <div class="recon-run-head">
          <div>
            <strong>${escapeHtml(formatRunTime(toDate(run.startedAt)))}</strong>
            ${duration ? `<span class="muted"> · took ${escapeHtml(duration)}</span>` : ""}
          </div>
          ${statusBadge(run)}
        </div>
        <div class="recon-run-stats">
          <span><strong>${Number(run.scanned || 0)}</strong> scanned</span>
          <span><strong>${Number(run.skipped || 0)}</strong> skipped</span>
          <span class="${drifted > 0 ? "recon-stat-hot" : ""}"><strong>${drifted}</strong> drifted</span>
          <span><strong>${Number(run.fixed || 0)}</strong> fixed</span>
          <span class="${failed > 0 ? "recon-stat-hot" : ""}"><strong>${failed}</strong> failed</span>
        </div>
        ${errorLine}
        ${expander}
        ${expanded ? `<div class="recon-drifts">${renderDriftRows(run.id)}</div>` : ""}
      </article>
    `;
  }).join("");

  list.querySelectorAll("[data-run]").forEach((btn) => {
    btn.addEventListener("click", () => toggleRun(btn.dataset.run));
  });
}

function renderSummaryTiles() {
  const tiles = el("recon-summary-tiles");
  if (!tiles) return;

  if (!state.runs.length) {
    tiles.innerHTML = `
      <div class="card">
        <span class="muted">Last run</span>
        <strong>Never</strong>
        <div class="muted">No run has been recorded yet.</div>
      </div>
    `;
    return;
  }

  const last = state.runs[0];
  const lastStarted = toDate(last.startedAt);
  const stale = hoursSince(lastStarted) > STALE_HOURS;
  const lastDrifted = Number(last.drifted || 0);
  const lastBroken = last.status === "failed" || Number(last.failed || 0) > 0;

  const driftedRuns = state.runs.filter((run) => Number(run.drifted || 0) > 0).length;
  const totalDrifted = state.runs.reduce((sum, run) => sum + Number(run.drifted || 0), 0);

  const alarm = 'style="border:2px solid rgb(192,57,43)"';
  const warn = 'style="border:2px solid rgb(178,109,0)"';

  const lastTile = `
    <div class="card" ${lastBroken || stale ? alarm : lastDrifted > 0 ? warn : ""}>
      <span class="muted">Last run</span>
      <strong>${escapeHtml(formatRunTime(lastStarted))}</strong>
      <div class="muted">${
        lastBroken
          ? "The run failed. Check the Cloud Function logs."
          : stale
            ? `No run in over ${STALE_HOURS} hours — the nightly schedule may be broken.`
            : lastDrifted > 0
              ? `Corrected ${lastDrifted} order${lastDrifted === 1 ? "" : "s"}.`
              : "Clean — every order matched its payments."
      }</div>
    </div>
  `;

  const historyTile = `
    <div class="card">
      <span class="muted">Last ${state.runs.length} runs</span>
      <strong>${totalDrifted} order${totalDrifted === 1 ? "" : "s"} corrected</strong>
      <div class="muted">${
        driftedRuns === 0
          ? "No drift in any recorded run."
          : `Across ${driftedRuns} run${driftedRuns === 1 ? "" : "s"} that found drift.`
      }</div>
    </div>
  `;

  tiles.innerHTML = lastTile + historyTile;
}

async function toggleRun(runId) {
  if (!runId) return;
  state.expanded[runId] = !state.expanded[runId];
  if (!state.expanded[runId] || Array.isArray(state.drifts[runId])) {
    renderRuns();
    return;
  }

  state.drifts[runId] = "loading";
  renderRuns();
  try {
    const snap = await getDocs(query(
      collection(db, "reconciliationReports", runId, "drifts"),
      limit(DRIFT_LIMIT)
    ));
    state.drifts[runId] = snap.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }));
  } catch (error) {
    state.drifts[runId] = `Could not load corrected orders: ${error.message || error}`;
  }
  renderRuns();
}

// Real-time corrections written by the reconcileOnPaymentWrite trigger. Unlike
// the nightly runs these are a flat list keyed only by time — each row is one
// order the trigger had to correct the instant a payment changed.
function renderEvents() {
  const listNode = el("event-list");
  const statusNode = el("event-status");
  if (!listNode) return;

  if (state.eventsError) {
    if (statusNode) statusNode.textContent = "";
    listNode.innerHTML = `<p class="muted" style="padding:20px;text-align:center;color:var(--danger)">${escapeHtml(state.eventsError)}</p>`;
    return;
  }

  const events = state.events;
  if (statusNode) {
    statusNode.textContent = events.length
      ? `${events.length} correction${events.length === 1 ? "" : "s"} made outside the nightly run`
      : "";
  }

  if (!events.length) {
    listNode.innerHTML = `<p class="muted" style="padding:20px;text-align:center">No real-time corrections. Every payment write left its order already balanced — which is how it should be.</p>`;
    return;
  }

  const body = events.map((ev) => {
    const before = ev.before || {};
    const after = ev.after || {};
    const orderHref = `./order.html?id=${encodeURIComponent(ev.orderId || "")}`;
    return `
      <tr class="recon-drift-row">
        <td data-label="When">${escapeHtml(formatRunTime(toDate(ev.at)))}</td>
        <td data-label="Order" class="recon-drift-order">
          <a href="${orderHref}"><code>${escapeHtml(ev.orderId || "")}</code></a>
        </td>
        <td data-label="Payments">${Number(ev.paymentsCount || 0)}</td>
        <td data-label="Paid — was">${escapeHtml(formatCurrency(before.amountPaid))}</td>
        <td data-label="Paid — now" class="recon-drift-after">
          ${escapeHtml(formatCurrency(after.amountPaid))} ${moneyDelta(before.amountPaid, after.amountPaid)}
        </td>
        <td data-label="Balance — was">${escapeHtml(formatCurrency(before.balanceDue))}</td>
        <td data-label="Balance — now" class="recon-drift-after">
          ${escapeHtml(formatCurrency(after.balanceDue))} ${moneyDelta(before.balanceDue, after.balanceDue)}
        </td>
        <td data-label="Status">
          <span class="muted">${escapeHtml(before.paymentStatus || "—")}</span>
          → <strong>${escapeHtml(after.paymentStatus || "—")}</strong>
        </td>
      </tr>
    `;
  }).join("");

  listNode.innerHTML = `
    <p class="muted" style="margin:0 0 12px">These orders were corrected the instant a payment changed, outside the nightly run. Because an in-app payment updates its order in the same step, a correction here points at a payment added another way — a data import or a console edit — and is worth a look.</p>
    <div class="customer-table-wrap">
      <table class="customer-table recon-drift-table">
        <thead>
          <tr>
            <th>When</th>
            <th>Order</th>
            <th>Payments</th>
            <th>Paid — was</th>
            <th>Paid — now</th>
            <th>Balance — was</th>
            <th>Balance — now</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>${body}</tbody>
      </table>
    </div>
  `;
}

async function loadEvents() {
  const statusNode = el("event-status");
  if (statusNode) statusNode.textContent = "Loading…";
  try {
    const snap = await getDocs(query(
      collection(db, "reconciliationEvents"),
      orderBy("at", "desc"),
      limit(EVENT_LIMIT)
    ));
    state.events = snap.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }));
    state.eventsError = null;
  } catch (error) {
    state.eventsError = `Could not load real-time corrections: ${error.message || error}`;
  }
  renderEvents();
}

// Read-only owner queue over orderCancellations/{caseId} (server-written, owner
// read in firestore.rules). A case lands here while money is still owed back
// (refundStatus pending/partial) or the refund proof has not been filed
// (evidenceStatus missing) — the two states that need an owner to act. Every
// other case (paid + evidence complete, or refund not required) drops off.
function needsAttention(c) {
  const refund = String(c.refundStatus || "");
  const evidence = String(c.evidenceStatus || "");
  return refund === "pending" || refund === "partial" || evidence === "missing";
}

function refundBadge(status) {
  const s = String(status || "");
  if (s === "pending") return `<span class="badge recon-badge-drift">Refund pending</span>`;
  if (s === "partial") return `<span class="badge recon-badge-drift">Refund partial</span>`;
  if (s === "paid") return `<span class="badge recon-badge-clean">Refund paid</span>`;
  return `<span class="badge">${escapeHtml(s || "—")}</span>`;
}

function evidenceBadge(status) {
  const s = String(status || "");
  if (s === "missing") return `<span class="badge recon-badge-failed">Proof missing</span>`;
  if (s === "complete") return `<span class="badge recon-badge-clean">Proof filed</span>`;
  if (s === "legacy_attested") return `<span class="badge">Legacy attested</span>`;
  return `<span class="badge">${escapeHtml(s || "—")}</span>`;
}

function renderCancellations() {
  const listNode = el("refunds-list");
  const statusNode = el("refunds-status");
  if (!listNode) return;

  if (state.cancellationsError) {
    if (statusNode) statusNode.textContent = "";
    listNode.innerHTML = `<p class="muted" style="padding:20px;text-align:center;color:var(--danger)">${escapeHtml(state.cancellationsError)}</p>`;
    return;
  }

  const open = state.cancellations.filter(needsAttention);
  if (statusNode) {
    statusNode.textContent = open.length
      ? `${open.length} case${open.length === 1 ? "" : "s"} awaiting a refund or its proof`
      : "";
  }

  if (!open.length) {
    listNode.innerHTML = `<p class="muted" style="padding:20px;text-align:center">No refunds due and no missing proof. Every cancellation case has been refunded and evidenced.</p>`;
    return;
  }

  const body = open.map((c) => {
    const orderHref = `./order.html?id=${encodeURIComponent(c.orderId || "")}`;
    const required = Number(c.refundRequired || 0);
    const remaining = Number(c.refundRemaining || 0);
    return `
      <tr class="recon-drift-row">
        <td data-label="Order" class="recon-drift-order">
          <a href="${orderHref}"><code>${escapeHtml(c.orderId || "")}</code></a>
        </td>
        <td data-label="Customer">${escapeHtml(c.customerId || "—")}</td>
        <td data-label="Kind">${escapeHtml(c.kind || "—")}</td>
        <td data-label="Refund required">${escapeHtml(formatCurrency(required))}</td>
        <td data-label="Still owed"><strong>${escapeHtml(formatCurrency(remaining))}</strong></td>
        <td data-label="Refund">${refundBadge(c.refundStatus)}</td>
        <td data-label="Proof">${evidenceBadge(c.evidenceStatus)}</td>
        <td data-label="Cancelled">${escapeHtml(formatRunTime(toDate(c.decidedAt || c.updatedAt || c.createdAt)))}</td>
      </tr>
    `;
  }).join("");

  listNode.innerHTML = `
    <p class="muted" style="margin:0 0 12px">Cancellation cases where money is still owed back to the customer, or where the refund was paid but its proof has not been attached yet. Open the order to record a refund or attach the receipt.</p>
    <div class="customer-table-wrap">
      <table class="customer-table recon-drift-table">
        <thead>
          <tr>
            <th>Order</th>
            <th>Customer</th>
            <th>Kind</th>
            <th>Refund required</th>
            <th>Still owed</th>
            <th>Refund</th>
            <th>Proof</th>
            <th>Cancelled</th>
          </tr>
        </thead>
        <tbody>${body}</tbody>
      </table>
    </div>
  `;
}

async function loadCancellations() {
  const statusNode = el("refunds-status");
  if (statusNode) statusNode.textContent = "Loading…";
  try {
    const snap = await getDocs(query(
      collection(db, "orderCancellations"),
      orderBy("updatedAt", "desc"),
      limit(CANCELLATION_LIMIT)
    ));
    state.cancellations = snap.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }));
    state.cancellationsError = null;
  } catch (error) {
    state.cancellationsError = `Could not load cancellation cases: ${error.message || error}`;
  }
  renderCancellations();
}

async function loadRuns() {
  setStatus("Loading runs…");
  try {
    const snap = await getDocs(query(
      collection(db, "reconciliationReports"),
      orderBy("startedAt", "desc"),
      limit(RUN_LIMIT)
    ));
    state.runs = snap.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }));
    renderSummaryTiles();
    renderRuns();
  } catch (error) {
    setStatus(`Could not load reconciliation runs: ${error.message || error}`);
  }
}

el("refresh-button").addEventListener("click", () => {
  state.drifts = {};
  loadRuns();
  loadEvents();
  loadCancellations();
});
el("drifted-only").addEventListener("change", (event) => {
  state.driftedOnly = event.target.checked;
  renderRuns();
});

onAuthStateChanged(auth, async (user) => {
  const authView = el("auth-view");
  const appView = el("app-view");
  if (!user) {
    authView.classList.remove("hidden");
    appView.classList.add("hidden");
    return;
  }
  if (!(await requireRole(user, "owner"))) return;
  authView.classList.add("hidden");
  appView.classList.remove("hidden");
  await Promise.all([loadRuns(), loadEvents(), loadCancellations()]);
});

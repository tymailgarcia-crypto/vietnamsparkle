import {
  auth,
  collection,
  db,
  doc,
  getDoc,
  getDocs,
  onAuthStateChanged,
  setDoc,
  signOut
} from "./firebaseClient.js";
import { buildDepositEventId, formatCurrency, mergeThresholds, requireRole, THRESHOLD_DEFAULTS, todayKey, withSubmitLock } from "./shared.js";

const CONTAINER_LABELS = {
  glass_crate: "Glass crates",
  "18_9l_jug": "18.9 L jugs",
  "19l_jug": "19 L jugs",
  "20l_jug": "20 L jugs",
  mixed: "Mixed containers"
};

function humanizeContainerType(key) {
  if (!key) return "Other";
  return CONTAINER_LABELS[key] || String(key).replace(/_/g, " ");
}

const state = {
  rows: [],
  customers: {},
  search: "",
  thresholds: { ...THRESHOLD_DEFAULTS }
};

function el(id) {
  return document.getElementById(id);
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function setStatus(message) {
  const node = el("list-status");
  if (node) node.textContent = message || "";
}

function daysSince(dateString) {
  if (!dateString) return 0;
  const then = new Date(dateString);
  if (Number.isNaN(then.getTime())) return 0;
  const diffMs = Date.now() - then.getTime();
  return Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
}

function phoneDigits(phone) {
  return String(phone || "").replace(/[^0-9+]/g, "");
}

function whatsappHref(phone, text) {
  const digits = phoneDigits(phone).replace(/^\+/, "");
  if (!digits) return "";
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

function matchesSearch(row) {
  if (!state.search) return true;
  const q = state.search.toLowerCase();
  return [row.customerName, row.phone].some((f) => String(f || "").toLowerCase().includes(q));
}

function renderRows() {
  const tbody = el("deposit-rows");
  const filtered = state.rows.filter(matchesSearch);
  setStatus(state.search
    ? `${filtered.length} of ${state.rows.length} outstanding containers`
    : `${state.rows.length} outstanding container line${state.rows.length === 1 ? "" : "s"}`);

  if (!filtered.length) {
    tbody.innerHTML = `<tr class="deposit-empty"><td colspan="8" class="muted" style="padding:20px;text-align:center">No containers outstanding.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map((row) => {
    const days = daysSince(row.since);
    const dayCell = days >= state.thresholds.depositForfeitDays
      ? `<span style="color:rgb(122,32,22);font-weight:600">${days}d</span>`
      : days >= state.thresholds.depositWarningDays
        ? `<span style="color:rgb(178,109,0);font-weight:600">${days}d</span>`
        : `${days}d`;
    const customerLink = row.customerId
      ? `<a href="./customer.html?id=${encodeURIComponent(row.customerId)}">${escapeHtml(row.customerName || "Unknown")}</a>`
      : escapeHtml(row.customerName || "Unknown");
    const phoneCell = row.phone
      ? `<a href="tel:${phoneDigits(row.phone)}">${escapeHtml(row.phone)}</a>`
      : "";
    const reminderText = `Hi ${row.customerName || ""}, just checking — we still have ${row.qty} of our ${humanizeContainerType(row.containerType).toLowerCase()} with you (${formatCurrency(row.amount)} deposit). Our driver can pick them up on the next delivery. Thanks!`;
    const reminderHref = whatsappHref(row.phone, reminderText);
    const reminderButton = reminderHref
      ? `<a class="button-link secondary" href="${reminderHref}" target="_blank" rel="noopener">Send reminder</a>`
      : `<span class="muted">No phone on file</span>`;
    return `
      <tr class="deposit-row">
        <td data-label="Customer" class="deposit-customer">${customerLink}</td>
        <td data-label="Phone">${phoneCell}</td>
        <td data-label="Container">${escapeHtml(humanizeContainerType(row.containerType))}</td>
        <td data-label="Quantity">${row.qty}</td>
        <td data-label="Deposit" class="deposit-amount">${escapeHtml(formatCurrency(row.amount))}</td>
        <td data-label="Since">${escapeHtml(row.since || "")}</td>
        <td data-label="Age">${dayCell}</td>
        <td data-label="Actions" class="deposit-actions">
          <div class="button-row" style="gap:6px;flex-wrap:wrap">
            <button class="ghost" type="button"
              data-forfeit-customer="${escapeHtml(row.customerId)}"
              data-forfeit-type="${escapeHtml(row.containerType)}">Mark as forfeit</button>
            ${reminderButton}
          </div>
        </td>
      </tr>
    `;
  }).join("");

  tbody.querySelectorAll("[data-forfeit-customer]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const row = state.rows.find((r) =>
        r.customerId === btn.dataset.forfeitCustomer && r.containerType === btn.dataset.forfeitType);
      if (row) openForfeitDialog(row);
    });
  });
}

function renderSummaryTiles() {
  const tiles = el("deposit-summary-tiles");
  if (!tiles) return;

  const containerCount = state.rows.reduce((sum, row) => sum + Number(row.qty || 0), 0);
  const depositTotal = state.rows.reduce((sum, row) => sum + Math.max(0, Number(row.amount || 0)), 0);
  const atRiskCount = state.rows.reduce((sum, row) => {
    return daysSince(row.since) >= state.thresholds.depositForfeitDays
      ? sum + Number(row.qty || 0)
      : sum;
  }, 0);
  const atRiskStyle = atRiskCount > 0 ? 'style="border:2px solid rgb(192,57,43)"' : "";

  tiles.innerHTML = `
    <div class="card" ${atRiskStyle}>
      <span class="muted">Containers out</span>
      <strong>${containerCount} · ${formatCurrency(depositTotal)}</strong>
      ${atRiskCount > 0
        ? `<div class="muted">${atRiskCount} held ≥${state.thresholds.depositForfeitDays} days</div>`
        : ""}
    </div>
  `;
}

async function loadThresholdsFromSettings() {
  try {
    const snap = await getDoc(doc(db, "settings", "business"));
    const settings = snap.exists() ? snap.data() : {};
    state.thresholds = mergeThresholds(settings.thresholds);
  } catch (_) {
    state.thresholds = { ...THRESHOLD_DEFAULTS };
  }
}

async function loadDeposits() {
  await loadThresholdsFromSettings();
  setStatus("Loading deposits...");
  try {
    const snap = await getDocs(collection(db, "depositEvents"));
    const byPair = {};
    snap.docs.forEach((docSnap) => {
      const event = docSnap.data();
      const customerId = event.customerId;
      if (!customerId) return;
      const type = String(event.containerType || "other");
      const key = `${customerId}|${type}`;
      if (!byPair[key]) {
        byPair[key] = {
          customerId,
          containerType: type,
          qty: 0,
          amount: 0,
          totalChargedAmount: 0,
          totalChargedQty: 0,
          oldestChargedDate: null
        };
      }
      const bucket = byPair[key];
      const qty = Number(event.qty || 0);
      const amount = Number(event.amount || 0);
      const eventDate = event.eventDate || null;
      if (event.eventType === "charged") {
        bucket.qty += qty;
        bucket.amount += amount;
        bucket.totalChargedAmount += amount;
        bucket.totalChargedQty += qty;
        if (eventDate && (!bucket.oldestChargedDate || eventDate < bucket.oldestChargedDate)) {
          bucket.oldestChargedDate = eventDate;
        }
      } else if (["refunded", "credited", "forfeited"].includes(event.eventType)) {
        bucket.qty -= qty;
        bucket.amount -= amount;
      }
    });

    const outstanding = Object.values(byPair).filter((row) => row.qty > 0 || row.amount > 0);
    const customerIds = Array.from(new Set(outstanding.map((r) => r.customerId)));
    await Promise.all(customerIds.map(async (id) => {
      if (state.customers[id]) return;
      try {
        const custDoc = await getDoc(doc(db, "customers", id));
        if (custDoc.exists()) {
          state.customers[id] = custDoc.data();
        }
      } catch (_) {}
    }));

    state.rows = outstanding
      .map((row) => {
        const customer = state.customers[row.customerId] || {};
        return {
          customerId: row.customerId,
          containerType: row.containerType,
          qty: row.qty,
          amount: row.amount,
          since: row.oldestChargedDate,
          depositPerUnit: row.totalChargedQty > 0 ? row.totalChargedAmount / row.totalChargedQty : 0,
          customerName: customer.name || "",
          phone: customer.phone || ""
        };
      })
      .sort((a, b) => String(a.since || "9999-12-31").localeCompare(String(b.since || "9999-12-31")));

    renderRows();
    renderSummaryTiles();
  } catch (error) {
    setStatus(`Could not load deposits: ${error.message || error}`);
  }
}

function openForfeitDialog(row) {
  const dialog = el("forfeit-dialog");
  if (!dialog || typeof dialog.showModal !== "function") return;
  el("forfeit-customer-id").value = row.customerId;
  el("forfeit-container-type").value = row.containerType;
  el("forfeit-max-qty").value = row.qty;
  el("forfeit-deposit-per-unit").value = row.depositPerUnit;
  el("forfeit-customer").textContent = row.customerName || "customer";
  el("forfeit-summary").textContent = `${row.qty} × ${humanizeContainerType(row.containerType)} · ${formatCurrency(row.amount)} deposit`;
  const qtyInput = el("forfeit-qty");
  qtyInput.value = row.qty;
  qtyInput.max = row.qty;
  el("forfeit-reason").value = "lost";
  el("forfeit-note").value = "";
  const statusNode = el("forfeit-status");
  if (statusNode) {
    statusNode.textContent = "";
    statusNode.style.color = "";
  }
  dialog.showModal();
}

async function saveForfeit(event) {
  event.preventDefault();
  const statusNode = el("forfeit-status");
  const customerId = el("forfeit-customer-id").value;
  const containerType = el("forfeit-container-type").value;
  const maxQty = Number(el("forfeit-max-qty").value || 0);
  const depositPerUnit = Number(el("forfeit-deposit-per-unit").value || 0);
  const qty = Number(el("forfeit-qty").value || 0);
  const reason = el("forfeit-reason").value;
  const note = el("forfeit-note").value.trim() || null;
  if (qty <= 0 || qty > maxQty) {
    statusNode.textContent = `Qty must be between 1 and ${maxQty}.`;
    statusNode.style.color = "var(--danger, #b3261e)";
    return;
  }
  await withSubmitLock(event, async () => {
    try {
      statusNode.textContent = "Saving...";
      statusNode.style.color = "";
      const now = new Date().toISOString();
      const today = todayKey();
      const eventId = buildDepositEventId();
      await setDoc(doc(db, "depositEvents", eventId), {
        orderId: null,
        customerId,
        authUid: null,
        containerType,
        qty,
        amount: qty * depositPerUnit,
        eventType: "forfeited",
        eventDate: today,
        linkedDocumentId: null,
        notes: [reason, note].filter(Boolean).join(" — "),
        forfeitReason: reason,
        createdAt: now
      });
      el("forfeit-dialog").close();
      await loadDeposits();
    } catch (error) {
      statusNode.textContent = error.message || String(error);
      statusNode.style.color = "var(--danger, #b3261e)";
    }
  });
}

el("search-input").addEventListener("input", (event) => {
  state.search = event.target.value.trim();
  renderRows();
});
el("refresh-button").addEventListener("click", loadDeposits);
el("forfeit-form").addEventListener("submit", saveForfeit);
el("forfeit-cancel-button").addEventListener("click", () => {
  el("forfeit-dialog").close();
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
  await loadDeposits();
});

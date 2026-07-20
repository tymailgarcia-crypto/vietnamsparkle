import {
  auth,
  collection,
  db,
  functions,
  getCountFromServer,
  getDocs,
  httpsCallable,
  onAuthStateChanged,
  query,
  where
} from "./firebaseClient.js";
import {
  buildCustomerId,
  buildDuplicateGroups,
  escapeHtml,
  requireRole,
  withSubmitLock
} from "./shared.js";

// Bulk sweep for the same-person-twice records left by the Sheets import
// (created before CUS-<E164> became the canonical id, so the same phone can
// sit under several doc ids). Merging goes through the existing
// mergeCustomers callable and inherits all of its semantics: losers are
// archived with a mergedInto pointer (never deleted), history is re-keyed
// onto the survivor, and a merge between two records with different sign-ins
// is refused server-side.
//
// One deliberate UI rail on top of the server's: when a losing record
// carries an authUid and the survivor has none, the merge transfers that
// sign-in to the survivor. That is the exact shape of the account takeover
// documented in ROADMAP → Audit follow-ups → Critical (an attacker's stub
// quoting a victim's phone), so the dialog forces an explicit "I recognise
// this sign-in" acknowledgement before the button works. The owner is the
// last line of defence here — no rule can decide whether two same-phone
// records are really one human.

const mergeCustomersFn = httpsCallable(functions, "mergeCustomers");

const state = {
  customers: [],
  groups: [],
  orderCounts: {},
  pendingMerge: null
};

function el(id) {
  return document.getElementById(id);
}

function setStatus(message) {
  const node = el("list-status");
  if (node) node.textContent = message || "";
}


// Suggested survivor: the canonical CUS-<E164> doc when present, then the doc
// carrying a sign-in, then the one with the most orders. resolveCustomerId
// routes new orders onto the canonical id, so keeping it means history stops
// splitting again tomorrow.
function suggestSurvivor(group) {
  const canonicalId = group.kind === "phone" ? buildCustomerId(group.key) : "";
  const canonical = group.docs.find((d) => d.id === canonicalId);
  if (canonical) return canonical.id;
  const withUid = group.docs.find((d) => d.authUid);
  if (withUid) return withUid.id;
  const byOrders = [...group.docs]
    .sort((a, b) => (state.orderCounts[b.id] || 0) - (state.orderCounts[a.id] || 0));
  return byOrders[0].id;
}

// --- Rendering ------------------------------------------------------------

function distinctAuthUids(docs) {
  return [...new Set(docs.map((d) => d.authUid).filter(Boolean))];
}

function renderSummaryTiles() {
  const tiles = el("dup-summary-tiles");
  if (!tiles) return;
  const phoneGroups = state.groups.filter((g) => g.kind === "phone").length;
  const emailGroups = state.groups.filter((g) => g.kind === "email").length;
  const redundant = state.groups.reduce((sum, g) => sum + g.docs.length - 1, 0);
  tiles.innerHTML = `
    <div class="card" ${state.groups.length ? 'style="border:2px solid rgb(178,109,0)"' : ""}>
      <span class="muted">Duplicate groups</span>
      <strong>${state.groups.length}</strong>
      <div class="muted">${phoneGroups} by phone · ${emailGroups} by email</div>
    </div>
    <div class="card">
      <span class="muted">Records that would be archived</span>
      <strong>${redundant}</strong>
      <div class="muted">Nothing is ever deleted — losers keep a pointer to the survivor.</div>
    </div>
  `;
}

function renderGroups() {
  const list = el("group-list");
  setStatus(state.groups.length
    ? `${state.groups.length} group${state.groups.length === 1 ? "" : "s"} across ${state.customers.length} active customers`
    : `No duplicates found across ${state.customers.length} active customers.`);

  if (!state.groups.length) {
    list.innerHTML = `<p class="muted" style="padding:20px;text-align:center">Every active customer has a unique phone and email. Nothing to merge.</p>`;
    return;
  }

  list.innerHTML = state.groups.map((group, groupIndex) => {
    const suggested = suggestSurvivor(group);
    const uids = distinctAuthUids(group.docs);
    const conflictBanner = uids.length > 1
      ? `<p class="dup-conflict">Two of these records have different sign-in accounts attached. The server refuses that merge — resolve which sign-in is correct first (usually by checking with the customer). You can still merge the records that carry no sign-in.</p>`
      : "";
    const rows = group.docs.map((docRow) => {
      const orders = state.orderCounts[docRow.id];
      const canonical = group.kind === "phone" && docRow.id === buildCustomerId(group.key);
      return `
        <label class="dup-row">
          <input type="radio" name="keep-${groupIndex}" value="${escapeHtml(docRow.id)}"
            ${docRow.id === suggested ? "checked" : ""}>
          <span class="dup-row-body">
            <span class="dup-row-head">
              <a href="./customer.html?id=${encodeURIComponent(docRow.id)}" target="_blank" rel="noopener">${escapeHtml(docRow.name || "(no name)")}</a>
              <code>${escapeHtml(docRow.id)}</code>
              ${canonical ? `<span class="badge dup-badge-canonical">canonical id</span>` : ""}
              ${docRow.authUid ? `<span class="badge dup-badge-uid">has sign-in</span>` : ""}
            </span>
            <span class="muted dup-row-meta">
              ${escapeHtml(docRow.phone || "no phone")} · ${escapeHtml(docRow.email || "no email")}
              · ${orders == null ? "…" : `${orders} order${orders === 1 ? "" : "s"}`}
              ${docRow.address ? ` · ${escapeHtml(String(docRow.address).slice(0, 60))}` : ""}
            </span>
          </span>
        </label>
      `;
    }).join("");

    return `
      <article class="dup-group">
        <div class="dup-group-head">
          <strong>${group.kind === "phone" ? "Same phone" : "Same email"}: ${escapeHtml(group.key)}</strong>
          <span class="muted">${group.docs.length} records — keep one:</span>
        </div>
        ${conflictBanner}
        <div class="dup-rows">${rows}</div>
        <div class="button-row">
          <button class="secondary" type="button" data-merge-group="${groupIndex}">Merge into selected</button>
        </div>
      </article>
    `;
  }).join("");

  list.querySelectorAll("[data-merge-group]").forEach((btn) => {
    btn.addEventListener("click", () => openMergeDialog(Number(btn.dataset.mergeGroup)));
  });
}

// --- Merge flow -----------------------------------------------------------

function openMergeDialog(groupIndex) {
  const group = state.groups[groupIndex];
  if (!group) return;
  const chosen = document.querySelector(`input[name="keep-${groupIndex}"]:checked`);
  if (!chosen) return;
  const survivorId = chosen.value;
  const survivor = group.docs.find((d) => d.id === survivorId);
  let losers = group.docs.filter((d) => d.id !== survivorId);

  // The server refuses a merge between two different sign-ins. Split those
  // out up front so one refusal doesn't read as the whole batch failing.
  const blocked = losers.filter((d) => d.authUid && survivor.authUid && d.authUid !== survivor.authUid);
  losers = losers.filter((d) => !blocked.includes(d));
  if (!losers.length) {
    alert("Every other record in this group has a different sign-in attached — nothing here can be merged automatically.");
    return;
  }

  const transfersUid = !survivor.authUid && losers.some((d) => d.authUid);
  state.pendingMerge = { survivor, losers, transfersUid };

  el("merge-summary").innerHTML = `
    <div class="card">
      <div><strong>Keep:</strong> ${escapeHtml(survivor.name || "(no name)")} <code>${escapeHtml(survivor.id)}</code></div>
      <div style="margin-top:6px"><strong>Archive ${losers.length}:</strong> ${losers.map((d) => `${escapeHtml(d.name || "(no name)")} <code>${escapeHtml(d.id)}</code>`).join(", ")}</div>
      ${blocked.length ? `<div class="muted" style="margin-top:6px">Skipped (different sign-in, server would refuse): ${blocked.map((d) => `<code>${escapeHtml(d.id)}</code>`).join(", ")}</div>` : ""}
      <div class="muted" style="margin-top:6px">Orders, payments, and container history move onto the kept record. Archived records keep a pointer back and are never deleted.</div>
    </div>
  `;
  el("merge-uid-warning").classList.toggle("hidden", !transfersUid);
  el("merge-uid-ack").checked = false;
  const statusNode = el("merge-status");
  statusNode.textContent = "";
  statusNode.style.color = "";
  el("merge-dialog").showModal();
}

async function runMerge(event) {
  event.preventDefault();
  const pending = state.pendingMerge;
  if (!pending) return;
  const statusNode = el("merge-status");
  if (pending.transfersUid && !el("merge-uid-ack").checked) {
    statusNode.textContent = "Tick the confirmation first — this merge hands a sign-in to the surviving record.";
    statusNode.style.color = "var(--danger, #b3261e)";
    return;
  }
  await withSubmitLock(event, async () => {
    let done = 0;
    const failures = [];
    for (const loser of pending.losers) {
      statusNode.style.color = "";
      statusNode.textContent = `Merging ${loser.id}… (${done + 1}/${pending.losers.length})`;
      try {
        const result = await mergeCustomersFn({ fromId: loser.id, toId: pending.survivor.id });
        if (!(result && result.data && result.data.ok)) {
          throw new Error("Merge did not confirm.");
        }
        done += 1;
      } catch (error) {
        failures.push(`${loser.id}: ${error.message || error}`);
      }
    }
    if (failures.length) {
      statusNode.textContent = `${done} merged, ${failures.length} failed — ${failures.join(" · ")}`;
      statusNode.style.color = "var(--danger, #b3261e)";
      // Leave the dialog open so the failure is actually read.
      await loadCustomers();
      return;
    }
    el("merge-dialog").close();
    state.pendingMerge = null;
    await loadCustomers();
  }, { busyLabel: "Merging…" });
}

// --- Data loading ----------------------------------------------------------

async function loadOrderCounts(groups) {
  const ids = [...new Set(groups.flatMap((g) => g.docs.map((d) => d.id)))];
  await Promise.all(ids.map(async (id) => {
    try {
      const snap = await getCountFromServer(
        query(collection(db, "orders"), where("customerId", "==", id))
      );
      state.orderCounts[id] = snap.data().count;
    } catch (_) {
      state.orderCounts[id] = null; // renders as "…", better than a wrong 0
    }
  }));
}

async function loadCustomers() {
  setStatus("Scanning customers…");
  try {
    const snap = await getDocs(collection(db, "customers"));
    state.customers = snap.docs
      .map((d) => ({ id: d.id, ...(d.data() || {}) }))
      .filter((c) => c.archived !== true && c.testFixture !== true);
    state.groups = buildDuplicateGroups(state.customers);
    state.orderCounts = {};
    renderSummaryTiles();
    renderGroups();
    if (state.groups.length) {
      await loadOrderCounts(state.groups);
      renderGroups(); // second pass fills the order counts in
    }
  } catch (error) {
    setStatus(`Could not scan customers: ${error.message || error}`);
  }
}

el("refresh-button").addEventListener("click", loadCustomers);
el("merge-form").addEventListener("submit", runMerge);
el("merge-cancel-button").addEventListener("click", () => {
  state.pendingMerge = null;
  el("merge-dialog").close();
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
  await loadCustomers();
});

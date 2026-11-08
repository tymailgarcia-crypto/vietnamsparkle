// Settings → Staff: list, add and remove employees' staff access through the
// owner-only manageStaff callable (functions/staff.js). Adding with "Delivery
// driver" ticked also puts them in the driver list, so this module tells
// settingsApp to reload "Drivers & loadouts" via a `vs:drivers-changed` event.

import { auth, functions, httpsCallable, onAuthStateChanged } from "./firebaseClient.js";
import { escapeHtml } from "./shared.js";

const manageStaff = httpsCallable(functions, "manageStaff");
const el = (id) => document.getElementById(id);

function setStaffStatus(message, isError = false) {
  const node = el("staff-status");
  if (!node) return;
  node.textContent = message || "";
  node.classList.toggle("is-error", isError);
  node.style.color = isError ? "var(--danger)" : "";
}

function lastSeen(value) {
  if (!value) return "Never signed in";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : `Last sign-in ${date.toLocaleDateString()}`;
}

function renderStaff(staff) {
  const list = el("staff-list");
  if (!staff.length) {
    list.innerHTML = `<p class="muted">No staff yet.</p>`;
    return;
  }
  list.innerHTML = staff.map((person) => {
    const badges = [
      person.isSelf ? `<span class="badge">You</span>` : "",
      person.driverId ? `<span class="badge staff-badge-driver">Driver ${escapeHtml(person.driverId)}</span>` : "",
      person.emailVerified ? "" : `<span class="badge staff-badge-warn" title="Anyone can sign up with an email they don't own. Make sure this person created the account.">Email not verified</span>`
    ].join("");
    return `
      <div class="card staff-row">
        <div class="staff-row-main">
          <strong>${escapeHtml(person.name || person.email)}</strong>
          <div class="muted">${person.name ? `${escapeHtml(person.email)} · ` : ""}${escapeHtml(lastSeen(person.lastSignIn))}</div>
          ${badges ? `<div class="staff-row-badges">${badges}</div>` : ""}
        </div>
        ${person.isSelf ? "" : `<button class="danger" type="button" data-staff-remove="${escapeHtml(person.uid)}" data-staff-label="${escapeHtml(person.name || person.email)}">Remove</button>`}
      </div>`;
  }).join("");
}

async function loadStaff() {
  try {
    const result = await manageStaff({ action: "list" });
    renderStaff((result.data && result.data.staff) || []);
  } catch (error) {
    el("staff-list").innerHTML = "";
    setStaffStatus(error.message || "Could not load staff.", true);
  }
}

async function addEmployee(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button[type=submit]");
  const payload = {
    action: "add",
    email: el("staff-email").value.trim(),
    name: el("staff-name").value.trim(),
    phone: el("staff-phone").value.trim(),
    isDriver: el("staff-is-driver").checked
  };
  button.disabled = true;
  setStaffStatus("Adding…");
  try {
    let result;
    try {
      result = await manageStaff(payload);
    } catch (error) {
      if (!(error && error.details && error.details.unverified)) throw error;
      const ok = confirm(`${payload.email} has not verified this email address. Anyone can sign up with an address they don't own, so only continue if this person told you they created the account themselves.\n\nGive them staff access anyway?`);
      if (!ok) {
        setStaffStatus("Not added.");
        return;
      }
      result = await manageStaff({ ...payload, confirmUnverified: true });
    }
    const data = result.data || {};
    form.reset();
    el("staff-is-driver").checked = true;
    setStaffStatus(`${data.alreadyStaff ? "Already staff" : "Added"}${data.driverId ? ` · driver ${data.driverId}` : ""}. Ask them to sign out and sign back in, then open the Dashboard.`);
    await loadStaff();
    if (data.driverId) window.dispatchEvent(new CustomEvent("vs:drivers-changed"));
  } catch (error) {
    setStaffStatus(error.message || "Could not add this employee.", true);
  } finally {
    button.disabled = false;
  }
}

async function removeEmployee(button) {
  const label = button.dataset.staffLabel;
  if (!confirm(`Remove staff access for ${label}? They lose access to the staff pages within an hour (immediately once they reload after signing in again). Their past orders and driver history are kept.`)) return;
  button.disabled = true;
  setStaffStatus("Removing…");
  try {
    await manageStaff({ action: "remove", uid: button.dataset.staffRemove });
    setStaffStatus(`Removed ${label}.`);
    await loadStaff();
    window.dispatchEvent(new CustomEvent("vs:drivers-changed"));
  } catch (error) {
    button.disabled = false;
    setStaffStatus(error.message || "Could not remove this employee.", true);
  }
}

function wire() {
  const form = el("staff-add-form");
  if (!form || form.dataset.wired) return;
  form.dataset.wired = "1";
  form.addEventListener("submit", addEmployee);
  el("staff-list").addEventListener("click", (event) => {
    const button = event.target.closest("[data-staff-remove]");
    if (button) removeEmployee(button);
  });
}

onAuthStateChanged(auth, async (user) => {
  if (!user || !el("staff-panel")) return;
  const token = await user.getIdTokenResult().catch(() => null);
  if (!token || token.claims.role !== "owner") return;
  wire();
  await loadStaff();
});

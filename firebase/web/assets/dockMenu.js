// Mobile burger for the owner nav dock (Ty, 2026-07-17): the money pages —
// Receivables, Deposits, Reconciliation — collapse behind a "☰ Finance"
// toggle so the fixed bottom dock stays two rows tall on a phone. Desktop is
// untouched: the wrapper and panel render `display: contents`, so the links
// remain ordinary inline children of the button row, and the toggle is
// display:none outside the mobile media query. All of that lives in the
// `.dock-menu` block at the tail of styles.css; this file only rearranges the
// DOM and toggles a class.

const FINANCE_HREFS = ["./finance.html", "./receivables.html", "./deposits.html", "./reports.html"];

function initDockMenu() {
  const row = document.querySelector(".admin-dock .button-row");
  if (!row) return;
  if (!row.querySelector('a[href="./finance.html"]')) {
    const financeLink = document.createElement("a");
    financeLink.className = "button-link secondary";
    financeLink.href = "./finance.html";
    financeLink.textContent = "Finance";
    if (/finance\.html$/.test(location.pathname)) financeLink.setAttribute("aria-current", "page");
    const firstMoneyLink = row.querySelector('a[href="./receivables.html"], a[href="./deposits.html"], a[href="./reports.html"]');
    row.insertBefore(financeLink, firstMoneyLink || null);
  }
  const links = FINANCE_HREFS
    .map((href) => row.querySelector(`a[href="${href}"]`))
    .filter(Boolean);
  // A reduced dock (order.html) still gets the burger; a dock with fewer than
  // two finance links has nothing worth collapsing.
  if (links.length < 2) return;

  const wrap = document.createElement("div");
  wrap.className = "dock-menu";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "button-link secondary dock-menu-toggle";
  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-haspopup", "true");
  toggle.innerHTML = `<span aria-hidden="true">☰</span> Finance`;

  const panel = document.createElement("div");
  panel.className = "dock-menu-panel";

  // Insert where the first finance link sat, so desktop link order is stable.
  row.insertBefore(wrap, links[0]);
  for (const link of links) panel.appendChild(link);
  wrap.appendChild(toggle);
  wrap.appendChild(panel);

  // When the current page lives inside the menu (e.g. /receivables.html),
  // the collapsed toggle carries the active highlight in its place.
  if (panel.querySelector('[aria-current="page"]')) {
    toggle.classList.add("holds-current");
  }

  const close = () => {
    wrap.classList.remove("is-open");
    toggle.setAttribute("aria-expanded", "false");
  };
  toggle.addEventListener("click", (event) => {
    event.stopPropagation();
    const opening = !wrap.classList.contains("is-open");
    wrap.classList.toggle("is-open", opening);
    toggle.setAttribute("aria-expanded", String(opening));
  });
  document.addEventListener("click", (event) => {
    if (!wrap.contains(event.target)) close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });
}

initDockMenu();

// Top-right owner menu (Ty, 2026-07-17): the floating ⚙ cog becomes a ☰
// menu holding Settings and the Product builder, so tool pages that don't
// belong in the bottom nav dock still have a consistent home. The existing
// settings anchor is MOVED into the panel (relabeled), so every page keeps
// exactly one settings link and no markup had to change.
function initTopMenu(createIfMissing = false) {
  if (document.querySelector(".top-menu")) return;
  let cog = document.querySelector("a.cog-button.floating-settings");
  if (!cog && createIfMissing) {
    const app = document.getElementById("app-view");
    if (!app) return;
    cog = document.createElement("a");
    cog.href = "./settings.html";
    app.prepend(cog);
  }
  if (!cog || cog.closest(".top-menu")) return;

  const wrap = document.createElement("div");
  wrap.className = "floating-settings top-menu";
  cog.parentNode.insertBefore(wrap, cog);

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "cog-button top-menu-toggle";
  toggle.setAttribute("aria-haspopup", "true");
  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-label", "Owner tools menu");
  toggle.textContent = "☰";

  const panel = document.createElement("div");
  panel.className = "top-menu-panel";

  cog.classList.remove("cog-button", "floating-settings");
  cog.className = "button-link secondary";
  cog.textContent = "⚙ Settings";
  cog.removeAttribute("title");

  const catalogLink = document.createElement("a");
  catalogLink.className = "button-link secondary";
  catalogLink.href = "./catalog.html";
  catalogLink.textContent = "🛒 Product builder";

  if (/settings\.html$/.test(location.pathname)) cog.setAttribute("aria-current", "page");
  if (/catalog\.html$/.test(location.pathname)) catalogLink.setAttribute("aria-current", "page");

  panel.appendChild(cog);
  panel.appendChild(catalogLink);
  wrap.appendChild(toggle);
  wrap.appendChild(panel);

  const close = () => {
    wrap.classList.remove("is-open");
    toggle.setAttribute("aria-expanded", "false");
  };
  toggle.addEventListener("click", (event) => {
    event.stopPropagation();
    const opening = !wrap.classList.contains("is-open");
    wrap.classList.toggle("is-open", opening);
    toggle.setAttribute("aria-expanded", String(opening));
  });
  document.addEventListener("click", (event) => {
    if (!wrap.contains(event.target)) close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });
}

initTopMenu();

export function getOwnerToolsMenu() {
  initTopMenu(true);
  return document.querySelector(".top-menu-panel");
}

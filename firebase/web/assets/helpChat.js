// Staff help chat: an "Ask" entry in the owner tools menu opens a small chat
// panel backed by the askHelp callable (Gemini, answering only from the staff
// guide in functions/helpGuide.md). It shows only for owner/driver accounts.
//
// The conversation lives in sessionStorage so it survives moving between
// pages in one tab. Answers are rendered by helpChatRender.js (escape first,
// then only bold, lists and links to our own *.html pages).

import { auth, functions, httpsCallable, onAuthStateChanged } from "./firebaseClient.js";
import { escapeHtml, renderAnswer } from "./helpChatRender.js";
import { getOwnerToolsMenu } from "./dockMenu.js";

const STORAGE_KEY = "vs-help-chat";
const STAFF_ROLES = ["owner", "driver"];
const SUGGESTIONS = [
  "How do I approve an order?",
  "How do I record a delivery?",
  "What does forfeit mean?",
  "What is this page for?"
];

const askHelp = httpsCallable(functions, "askHelp");
let messages = loadMessages();
let busy = false;
let ui = null;

function loadMessages() {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter((m) => m && typeof m.text === "string") : [];
  } catch (_) {
    return [];
  }
}

function saveMessages() {
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(messages.slice(-30))); } catch (_) { /* private mode */ }
}

function currentPage() {
  const name = location.pathname.split("/").pop() || "admin.html";
  return /^[a-z-]+\.html$/.test(name) ? name : "admin.html";
}

function buildUi() {
  const menu = getOwnerToolsMenu();
  if (!menu) return null;
  const tools = menu.closest(".top-menu");
  const menuToggle = tools.querySelector(".top-menu-toggle");
  const launcher = document.createElement("button");
  launcher.type = "button";
  launcher.className = "button-link secondary";
  launcher.setAttribute("aria-haspopup", "dialog");
  launcher.setAttribute("aria-expanded", "false");
  launcher.innerHTML = `<span aria-hidden="true">?</span> Ask`;

  const panel = document.createElement("section");
  panel.className = "help-chat-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Ask about the app");
  panel.hidden = true;
  panel.innerHTML = `
    <header class="help-chat-head">
      <div>
        <strong>Ask about the app</strong>
        <small>Explains pages and how things work · English or Tiếng Việt</small>
      </div>
      <button type="button" class="help-chat-icon" data-help-clear title="Start a new chat" aria-label="Start a new chat">↺</button>
      <button type="button" class="help-chat-icon" data-help-close title="Close" aria-label="Close">✕</button>
    </header>
    <div class="help-chat-log" role="log" aria-live="polite"></div>
    <form class="help-chat-form">
      <textarea rows="1" maxlength="1500" placeholder="Ask a question…" aria-label="Your question"></textarea>
      <button type="submit" class="primary">Send</button>
    </form>
    <p class="help-chat-note">It can't see your orders or customers — please don't type customer details.</p>
  `;
  menu.append(launcher);
  document.body.append(panel);

  const log = panel.querySelector(".help-chat-log");
  const form = panel.querySelector(".help-chat-form");
  const input = form.querySelector("textarea");
  const send = form.querySelector("button[type=submit]");

  const open = () => {
    tools.classList.remove("is-open");
    menuToggle.setAttribute("aria-expanded", "false");
    panel.hidden = false;
    launcher.setAttribute("aria-expanded", "true");
    render();
    input.focus();
  };
  const close = () => {
    panel.hidden = true;
    launcher.setAttribute("aria-expanded", "false");
    menuToggle.focus();
  };

  launcher.addEventListener("click", () => (panel.hidden ? open() : close()));
  panel.querySelector("[data-help-close]").addEventListener("click", close);
  panel.querySelector("[data-help-clear]").addEventListener("click", () => {
    messages = [];
    saveMessages();
    render();
    input.focus();
  });
  panel.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    ask(input.value);
  });
  log.addEventListener("click", (event) => {
    const chip = event.target.closest("[data-help-suggestion]");
    if (chip) ask(chip.textContent);
  });

  return { launcher, panel, log, input, send };
}

function render(pending = false, error = "") {
  if (!ui) return;
  const { log, send, input } = ui;
  if (!messages.length && !pending) {
    log.innerHTML = `
      <div class="help-chat-empty">
        <p>Ask how to do something, or what a page or word means.</p>
        <div class="help-chat-suggestions">
          ${SUGGESTIONS.map((s) => `<button type="button" data-help-suggestion>${escapeHtml(s)}</button>`).join("")}
        </div>
      </div>`;
  } else {
    log.innerHTML = messages.map((m) => m.role === "model"
      ? `<div class="help-chat-msg is-bot">${renderAnswer(m.text)}</div>`
      : `<div class="help-chat-msg is-user">${escapeHtml(m.text)}</div>`
    ).join("")
      + (pending ? `<div class="help-chat-msg is-bot is-pending" aria-label="Thinking">…</div>` : "")
      + (error ? `<div class="help-chat-error">${escapeHtml(error)}</div>` : "");
  }
  send.disabled = pending;
  input.disabled = pending;
  log.scrollTop = log.scrollHeight;
}

async function ask(rawText) {
  const text = String(rawText || "").trim();
  if (!text || busy) return;
  busy = true;
  messages.push({ role: "user", text });
  saveMessages();
  ui.input.value = "";
  ui.input.style.height = "auto";
  render(true);
  try {
    const result = await askHelp({ messages: messages.slice(-12), page: currentPage() });
    messages.push({ role: "model", text: String((result.data && result.data.answer) || "") });
    saveMessages();
    render();
  } catch (error) {
    // Drop the unanswered question so a retry doesn't send it twice.
    messages.pop();
    saveMessages();
    render(false, (error && error.message) || "Something went wrong. Try again.");
    ui.input.value = text;
  } finally {
    busy = false;
    ui.input.disabled = false;
    ui.send.disabled = false;
    ui.input.focus();
  }
}

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    if (ui) { ui.launcher.remove(); ui.panel.remove(); ui = null; }
    return;
  }
  try {
    const token = await user.getIdTokenResult();
    if (!STAFF_ROLES.includes(token.claims.role) || ui) return;
    ui = buildUi();
  } catch (_) {
    // No chat if the role can't be read; the page itself still works.
  }
});

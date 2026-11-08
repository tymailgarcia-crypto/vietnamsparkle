// askHelp — staff help chat (owner + drivers), backed by Gemini.
//
// The assistant answers ONLY from helpGuide.md (bundled with the functions
// source and sent as the system instruction), so it explains how the app works
// and where things are. It never reads Firestore business data, and the client
// tells staff not to type customer details: the Gemini API free tier may use
// prompts to improve Google's products.
//
// The API key is the GEMINI_API_KEY secret. It must come from an AI Studio key
// in a Google project WITHOUT billing — a key from the Blaze-plan Firebase
// project is billed per request, breaking the no-monthly-cost policy.
// Model: the Flash-Lite "latest" alias, overridable with HELP_MODEL in
// functions/.env (a defineString param would prompt during deploy/emulator).
//
// Abuse/quota guard: signed-in owner/driver only, short inputs, and a per-user
// daily cap kept in helpChatUsage/{uid} (Admin SDK only; no client rule).

const fs = require("node:fs");
const path = require("node:path");
const { onCall, HttpsError } = require("firebase-functions/https");
const { defineSecret } = require("firebase-functions/params");
const { logger } = require("firebase-functions");
const { getApp, initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

const geminiApiKey = defineSecret("GEMINI_API_KEY");
const HELP_MODEL = process.env.HELP_MODEL || "gemini-flash-lite-latest";

const DAILY_LIMIT = 80;
const MAX_MESSAGE_CHARS = 1500;
const MAX_HISTORY = 12;
const STAFF_ROLES = new Set(["owner", "driver"]);

let guideText = null;
function staffGuide() {
  if (guideText === null) {
    guideText = fs.readFileSync(path.join(__dirname, "helpGuide.md"), "utf8");
  }
  return guideText;
}

function db() {
  try { getApp(); } catch (_) { initializeApp(); }
  return getFirestore();
}

// "2026-10-23" in Da Nang time, so the daily cap resets at local midnight.
function businessDayKey(now = new Date()) {
  return new Date(now.getTime() + 7 * 3600 * 1000).toISOString().slice(0, 10);
}

function cleanPage(value) {
  const page = String(value || "").trim();
  return /^[a-z-]+\.html$/.test(page) ? page : "unknown";
}

// Client-held conversation → Gemini contents. Must end on a user turn.
function cleanMessages(raw) {
  const list = Array.isArray(raw) ? raw.slice(-MAX_HISTORY) : [];
  const messages = list
    .map((m) => ({
      role: m && m.role === "model" ? "model" : "user",
      text: String((m && m.text) || "").trim().slice(0, MAX_MESSAGE_CHARS)
    }))
    .filter((m) => m.text);
  if (!messages.length || messages[messages.length - 1].role !== "user") {
    throw new HttpsError("invalid-argument", "Type a question first.");
  }
  return messages;
}

function systemInstruction(page, role) {
  return [
    "You are the in-app help assistant for the staff of Vietnam Sparkle, a water-delivery business in Da Nang.",
    "Staff are the owner and the delivery drivers. They ask how the app works and where to find things.",
    "",
    "RULES",
    "- Answer ONLY from the STAFF GUIDE below. If it does not cover the question, say you don't know and suggest asking the owner. Never invent buttons, pages or rules.",
    "- First answer to a new question: at most 2-3 short sentences saying where to go and the key action. Then end with one short offer of more detail, e.g. \"Want step-by-step help?\" (in the user's language).",
    "- If the user accepts (yes / ok / có / chi tiết …) or asks for more, give numbered steps (at most 8) with the exact button and tab labels from the guide.",
    "- Reply in the language of the user's latest message (Vietnamese or English). Keep button labels in English, as they appear in the app, and you may add a Vietnamese gloss in brackets.",
    "- You cannot see any orders, customers, payments or amounts. For a question about a specific customer or order, explain where to look it up instead. Never ask for names, phone numbers, addresses or money amounts.",
    "- Every time you name an app page, write it as a markdown link with the page name as the text and its ./file.html address as the target, e.g. [Dashboard](./admin.html), [Deposits](./deposits.html). Never write a bare address like ./admin.html or (admin.html).",
    "- Write button, tab and field labels in bold, e.g. **Approve**, not in quotes.",
    "- Format: plain sentences, numbered or dashed lists. No headings, no tables, no code.",
    "",
    "EXAMPLE",
    "User: how do I approve an order?",
    "Assistant: Open the [Dashboard](./admin.html), tap the **To approve** filter, check the order card and press **Approve**. The order then moves to **To assign**.\nWant step-by-step help?",
    "",
    `The user is signed in as: ${role}. They are currently on page: ${page}.`,
    "",
    "STAFF GUIDE",
    staffGuide()
  ].join("\n");
}

async function chargeDailyQuota(uid) {
  const ref = db().collection("helpChatUsage").doc(uid);
  const day = businessDayKey();
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.exists ? snap.data() : {};
    const count = data.day === day ? Number(data.count || 0) : 0;
    if (count >= DAILY_LIMIT) {
      throw new HttpsError("resource-exhausted", `Daily limit of ${DAILY_LIMIT} questions reached. It resets at midnight.`);
    }
    tx.set(ref, { day, count: count + 1, updatedAt: new Date().toISOString() });
    return count + 1;
  });
}

async function callGemini({ key, model, system, messages }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: messages.map((m) => ({ role: m.role, parts: [{ text: m.text }] })),
          generationConfig: { temperature: 0.2, maxOutputTokens: 900 }
        })
      }
    );
    const body = await response.json().catch(() => ({}));
    if (response.status === 429) {
      throw new HttpsError("resource-exhausted", "The help assistant is busy (free quota reached). Try again in a minute.");
    }
    if (!response.ok) {
      logger.error("askHelp: Gemini error", { status: response.status, error: body && body.error });
      throw new HttpsError("unavailable", "The help assistant is unavailable right now. Try again later.");
    }
    const candidate = body.candidates && body.candidates[0];
    const text = ((candidate && candidate.content && candidate.content.parts) || [])
      .map((part) => part.text || "")
      .join("")
      .trim();
    if (!text) {
      logger.warn("askHelp: empty Gemini answer", { finishReason: candidate && candidate.finishReason });
      throw new HttpsError("unavailable", "No answer came back. Try rephrasing the question.");
    }
    return text;
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    logger.error("askHelp: Gemini request failed", { message: error && error.message });
    throw new HttpsError("unavailable", "The help assistant could not be reached. Check the connection and try again.");
  } finally {
    clearTimeout(timer);
  }
}

const askHelp = onCall({ secrets: [geminiApiKey], timeoutSeconds: 40 }, async (request) => {
  const role = request.auth && request.auth.token ? request.auth.token.role : null;
  if (!STAFF_ROLES.has(role)) {
    throw new HttpsError("permission-denied", "The help assistant is for staff accounts.");
  }
  const data = request.data || {};
  const messages = cleanMessages(data.messages);
  const page = cleanPage(data.page);

  const key = geminiApiKey.value();
  if (!key) {
    if (process.env.FUNCTIONS_EMULATOR === "true") {
      return { answer: `(Emulator stub — no GEMINI_API_KEY set.) You asked: "${messages[messages.length - 1].text}" on ${page}. Open [Orders](./orders.html) to try a link. Want step-by-step help?` };
    }
    throw new HttpsError("failed-precondition", "The help assistant is not set up yet.");
  }

  const used = await chargeDailyQuota(request.auth.uid);
  const answer = await callGemini({
    key,
    model: HELP_MODEL,
    system: systemInstruction(page, role),
    messages
  });
  return { answer, remainingToday: Math.max(0, DAILY_LIMIT - used) };
});

module.exports = {
  askHelp,
  _helpChatTestApi: { businessDayKey, cleanPage, cleanMessages, systemInstruction }
};

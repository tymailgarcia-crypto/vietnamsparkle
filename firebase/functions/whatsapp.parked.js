// PARKED — NOT DEPLOYED. Nothing imports this file, so Firebase's function
// discovery never sees these exports and they never reach production.
//
// Why this was pulled (2026-07-15):
//   The `defineSecret()` bindings were replaced with `process.env` shims that
//   fall back to "" when the variable is unset. Secret Manager was never
//   enabled on this project and there is no .env, so BOTH secrets evaluated to
//   the empty string in production. That made the webhook fully bypassable:
//
//     - The GET verify branch compared `hub.verify_token === ""`, so a request
//       with an empty verify_token passed. Confirmed against the live endpoint:
//       `?hub.mode=subscribe&hub.verify_token=&hub.challenge=PROBE` -> 200.
//     - The POST branch computed HMAC-SHA256 keyed with "". Anyone could
//       reproduce that signature without knowing any secret, so the
//       `timingSafeEqual` check passed on forged payloads. A stranger could
//       drive Firestore writes (whatsappInbound/*, whatsappOrderLinks/*) and
//       function invocations on the project's billing.
//
//   The crypto here is correct. The failure was configuration: correct code
//   keyed with a secret that wasn't secret.
//
// To bring this back, ALL of the following must be true:
//   1. Enable the Secret Manager API on the project.
//   2. Re-instate real `defineSecret()` bindings (see the commented import
//      below) — NOT process.env shims — and bind each to a real value via
//      `firebase functions:secrets:set WHATSAPP_APP_SECRET` (and friends).
//   3. Add a startup guard that throws when any secret resolves empty, so a
//      missing binding fails closed instead of silently accepting everything.
//   4. Re-export these from index.js and redeploy.
//   5. Re-add the `?wa=` handler to web/assets/publicApp.js (removed in the
//      same change; see applyWhatsAppOrderLink in this file's history).
//
// Original design intent: a customer messages the business on WhatsApp first;
// we reply once with a short-lived opaque link that opens the order page
// prefilled with their saved details and most recent order. Product selection
// and submission stay in the web app.

/*
const { onCall, onRequest, HttpsError } = require("firebase-functions/https");
const { logger } = require("firebase-functions");
const { defineSecret } = require("firebase-functions/params");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const crypto = require("crypto");

const whatsappAccessToken = defineSecret("WHATSAPP_ACCESS_TOKEN");
const whatsappVerifyToken = defineSecret("WHATSAPP_VERIFY_TOKEN");
const whatsappPhoneNumberId = defineSecret("WHATSAPP_PHONE_NUMBER_ID");
const whatsappAppSecret = defineSecret("WHATSAPP_APP_SECRET");
const PUBLIC_ORDER_URL = "https://vietnamsparkle-36dfe.web.app/";

// NOTE: whichever module re-adopts this code needs db(), buildCustomerId(),
// and normalizePhoneE164VN() — they live in index.js.

function hashWhatsAppLinkToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

async function createWhatsAppOrderLink(phone) {
  const normalizedPhone = normalizePhoneE164VN(phone);
  if (!normalizedPhone) throw new Error("Invalid WhatsApp phone number.");
  const customerId = buildCustomerId(normalizedPhone);
  const token = crypto.randomBytes(24).toString("base64url");
  const tokenHash = hashWhatsAppLinkToken(token);
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
  await db().doc(`whatsappOrderLinks/${tokenHash}`).set({
    customerId,
    phone: normalizedPhone,
    createdAt: FieldValue.serverTimestamp(),
    expiresAt
  });
  return `${PUBLIC_ORDER_URL}?wa=${encodeURIComponent(token)}`;
}

exports.resolveWhatsAppOrderLink = onCall(async (request) => {
  const token = String((request.data && request.data.token) || "");
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) {
    throw new HttpsError("invalid-argument", "This order link is invalid.");
  }

  const linkSnap = await db().doc(`whatsappOrderLinks/${hashWhatsAppLinkToken(token)}`).get();
  if (!linkSnap.exists) throw new HttpsError("not-found", "This order link is invalid or expired.");
  const link = linkSnap.data() || {};
  const expiresAt = link.expiresAt && typeof link.expiresAt.toDate === "function"
    ? link.expiresAt.toDate()
    : new Date(link.expiresAt || 0);
  if (!(expiresAt.getTime() > Date.now())) {
    throw new HttpsError("deadline-exceeded", "This order link has expired. Message us again for a new one.");
  }

  const customerSnap = await db().doc(`customers/${link.customerId}`).get();
  const customer = customerSnap.exists ? customerSnap.data() || {} : {};
  const orderSnap = await db().collection("orders")
    .where("customerId", "==", link.customerId)
    .limit(20)
    .get();
  const recentOrder = orderSnap.docs
    .map((snap) => ({ id: snap.id, ...snap.data() }))
    .filter((order) => order.status !== "cancelled")
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))[0] || null;
  let items = [];
  if (recentOrder) {
    const itemSnap = await db().collection("orderItems").where("orderId", "==", recentOrder.id).get();
    items = itemSnap.docs.map((snap) => {
      const item = snap.data() || {};
      return { productId: String(item.productId || ""), quantity: Number(item.quantity || 0) };
    }).filter((item) => item.productId && item.quantity > 0);
  }

  return {
    customer: {
      name: String(customer.name || customer.customerName || ""),
      phone: String(customer.phone || link.phone || ""),
      address: String(customer.address || "")
    },
    items
  };
});

async function sendWhatsAppLink(to, link) {
  const response = await fetch(
    `https://graph.facebook.com/v23.0/${whatsappPhoneNumberId.value()}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${whatsappAccessToken.value()}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "text",
        text: {
          preview_url: true,
          body: `Review or repeat your water order here: ${link}`
        }
      })
    }
  );
  if (!response.ok) throw new Error(`WhatsApp send failed (${response.status}): ${await response.text()}`);
}

exports.whatsappWebhook = onRequest(
  { secrets: [whatsappVerifyToken, whatsappAppSecret, whatsappAccessToken, whatsappPhoneNumberId] },
  async (request, response) => {
    // GUARD TO ADD BEFORE REDEPLOY: fail closed on empty secrets.
    //   if (!whatsappAppSecret.value() || !whatsappVerifyToken.value()) {
    //     logger.error("WhatsApp secrets unbound; refusing request.");
    //     response.sendStatus(500);
    //     return;
    //   }
    if (request.method === "GET") {
      if (request.query["hub.mode"] === "subscribe"
        && request.query["hub.verify_token"] === whatsappVerifyToken.value()) {
        response.status(200).send(String(request.query["hub.challenge"] || ""));
        return;
      }
      response.sendStatus(403);
      return;
    }
    if (request.method !== "POST") {
      response.sendStatus(405);
      return;
    }

    const suppliedSignature = String(request.get("x-hub-signature-256") || "");
    const expectedSignature = "sha256=" + crypto
      .createHmac("sha256", whatsappAppSecret.value())
      .update(request.rawBody || Buffer.from(JSON.stringify(request.body || {})))
      .digest("hex");
    const signatureOk = suppliedSignature.length === expectedSignature.length
      && crypto.timingSafeEqual(Buffer.from(suppliedSignature), Buffer.from(expectedSignature));
    if (!signatureOk) {
      response.sendStatus(401);
      return;
    }

    // Acknowledge Meta quickly; processing is intentionally tiny and each
    // inbound message id is recorded so webhook retries do not send twice.
    const messages = [];
    for (const entry of request.body?.entry || []) {
      for (const change of entry.changes || []) {
        for (const message of change.value?.messages || []) messages.push(message);
      }
    }
    for (const message of messages) {
      const messageId = String(message.id || "");
      const from = String(message.from || "");
      if (!messageId || !from) continue;
      const seenRef = db().doc(`whatsappInbound/${messageId}`);
      try {
        const isNew = await db().runTransaction(async (tx) => {
          if ((await tx.get(seenRef)).exists) return false;
          tx.create(seenRef, { from, receivedAt: FieldValue.serverTimestamp() });
          return true;
        });
        if (!isNew) continue;
        const link = await createWhatsAppOrderLink(from);
        await sendWhatsAppLink(from, link);
      } catch (error) {
        logger.error("whatsappWebhook processing failed", { messageId, error: String(error?.message || error) });
      }
    }
    response.sendStatus(200);
  }
);
*/

// --- Client-side counterpart, removed from web/assets/publicApp.js ---------
// Re-add alongside `const resolveWhatsAppOrderLinkFn = httpsCallable(functions,
// "resolveWhatsAppOrderLink");` and call it from the load path before
// applyReorderFromQuery().
/*
async function applyWhatsAppOrderLink() {
  const token = new URLSearchParams(location.search).get("wa");
  if (!token) return false;
  const feedback = document.getElementById("public-feedback");
  try {
    const result = await resolveWhatsAppOrderLinkFn({ token });
    const data = result?.data || {};
    const customer = data.customer || {};
    const form = document.getElementById("public-order-form");
    if (customer.name) form.customerName.value = customer.name;
    if (customer.phone) form.phone.value = customer.phone;
    if (customer.address) form.address.value = customer.address;
    state.quantities = {};
    for (const item of data.items || []) {
      if (item.productId && Number(item.quantity) > 0) {
        state.quantities[item.productId] = Number(item.quantity);
      }
    }
    renderCatalog();
    renderTotals();
    if (feedback) feedback.textContent = "Your saved order is ready to review.";
    history.replaceState({}, "", location.pathname);
    return true;
  } catch (error) {
    if (feedback) feedback.textContent = error?.message || "This WhatsApp order link is invalid or expired.";
    return true;
  }
}
*/

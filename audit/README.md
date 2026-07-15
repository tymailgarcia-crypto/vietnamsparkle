# Third-party security audit bundle

This folder contains the source files most relevant to reviewing authentication,
authorization, public order submission, Firestore access, and the planned
WhatsApp reorder-link integration.

## Important status

- `submitPublicOrder` and `resolveWhatsAppOrderLink` are deployed.
- `whatsappWebhook` is implemented in `functions/index.js` but is not deployed
  or connected to Meta credentials yet.
- No access tokens, app secrets, service-account keys, `.env` files, Firebase
  CLI credentials, or installed dependencies are included.

## Files

- `functions/index.js`: trusted server-side order and WhatsApp logic.
- `functions/package.json`: server runtime and direct dependencies.
- `firestore.rules`: database authorization and validation.
- `firestore.indexes.json`: database indexes.
- `firebase.json`: hosting, Functions, rules, and emulator configuration.
- `web/index.html`: public ordering interface.
- `web/assets/publicApp.js`: browser-side ordering and secure-link resolution.
- `web/assets/firebaseClient.js`: Firebase client initialization and emulator routing.
- `web/assets/firebaseWebConfig.js`: intentionally public Firebase web identifiers.
- `web/assets/shared.js`: shared browser-side validation and calculations.
- `web/assets/accountApp.js`: customer account and reorder behavior.

The Firebase web configuration is not a server secret. Access control must be
enforced by Firestore rules and server-side Functions, which should receive the
closest scrutiny.

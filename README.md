# Water Delivery System v2

This deliverable now prioritizes **audit-ready customer and money records**.

## Included

- `apps-script/`: Google Apps Script source for:
  - public landing page
  - internal admin console
  - audit-focused ledger workflow
- `site-preview/`: static preview of the customer-facing landing page
- `water-delivery-template.xlsx`: starter workbook matching the audit data model

## Sheets created by the Apps Script project

- `Customers`
- `Orders`
- `OrderItems`
- `Products`
- `Helpers`
- `Payments`
- `Deposits`
- `Returns`
- `Purchases`
- `Expenses`
- `Documents`
- `DailySummary`
- `Inquiries`

## What changed from v1

- Orders are no longer treated as paid with a single checkbox.
- Payment records now live in `Payments`.
- Container liability now lives in `Deposits` and `Returns`.
- Supplier buys and non-inventory costs now live in `Purchases` and `Expenses`.
- Proof links now live in `Documents`.
- `DailySummary` is derived from orders, payments, and deposits rather than acting as the primary audit source.
- The public landing page is now form-first: every website order request lands in `Inquiries` as structured columns and creates or updates a linked customer stub.

## Core server functions

- `saveOrder`
- `updateOrderDispatch`
- `recordOrderPayment`
- `recordDepositReturn`
- `recordPurchase`
- `recordExpense`
- `recordDocumentEntry`
- `submitPublicInquiry`

## Admin workflow

- `Orders`: audit-aware order board with balance and deposit summaries
- `New Order`: create order, initial payment, and deposit charge together
- `Customers`: review balances and deposit liabilities
- `Products`: review product and default deposit settings
- `Audit`: log payments, returns, purchases, expenses, and document links
- `Public form`: capture name, phone, address, delivery date, time slot, requested items, and preferred follow-up channel into Sheets before chat follow-up

## Deployment steps

1. Create or open the Google Sheet that will act as the operational database.
2. Open `Extensions -> Apps Script` from that sheet.
3. Copy the files from `apps-script/` into the Apps Script project.
4. Save the project and run `setupWaterDeliveryWorkbook` once.
5. If you want sample data, run `seedWaterDeliveryDemoData`.
6. Deploy as a web app.
7. Use:
   - `/exec` or `/dev` for the public page
   - `/exec?view=admin` for the admin console

## First things to customize

- Replace placeholder WhatsApp, Facebook, and Zalo links in `00_Config.gs`.
- Rename the business in `APP_CONFIG.businessName`.
- Replace demo helper names, product pricing, and default deposit amounts.
- Edit `apps-script/Public.html` to change homepage copy or form fields.
- Decide who is allowed to use the admin console and restrict deployment accordingly.
- Standardize how Google Drive proof files are named and shared.

## Notes

- This version is designed to survive accountant and tax review better than the v1 ops-only model.
- The legal business type is still unknown, so no Vietnam-specific VAT or e-invoice logic is hardcoded yet.
- Proof files are indexed by Drive link only; the system does not manage the files themselves.
- Purchase tracking is basic ledger tracking, not full inventory control.

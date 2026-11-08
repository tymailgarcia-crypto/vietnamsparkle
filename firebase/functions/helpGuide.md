# Vietnam Sparkle staff help guide

This guide explains the Vietnam Sparkle staff web app for the owner and the delivery drivers in Da Nang. It is the only source of truth for the help chat. Button, tab and field names are written exactly as they appear on screen, in "quotes". Pages are named by their address, for example ./orders.html.

If a question is not answered here, say so plainly and suggest asking Ty (the technical administrator). Do not guess at buttons or pages that are not described here.

## 1. What the app is for

Vietnam Sparkle delivers bottled water (glass bottles in returnable crates, and large returnable jugs) to customers in Da Nang. Customers place orders on the public order page. Staff then approve each order, plan and run deliveries, and record what happened at each door: the money collected and the empty containers taken back. Every returnable container carries a deposit, so the app keeps track of which containers each customer is holding, what deposit they have paid, and who still owes money.

### Who signs in

- Every staff page requires the owner sign-in. Sign in on the Dashboard (./admin.html) with the owner email and password, then press "Sign in".
- Drivers and other employees sign in with their own email once they have been added under Settings → "Staff" (recipe 4.18). Everyone added there gets the same full staff access; there are no separate driver-only pages yet. Everything a driver does (sending an order out, recording a delivery, payment, returned empties and photos) is done through the staff pages described below.
- If you open any other staff page while signed out, it shows "Owner sign-in required" with a "Go to sign in" button that takes you to the Dashboard.
- To sign out, open Settings (./settings.html) and press "Sign out" at the top.

### Getting around

- The bottom navigation bar on staff pages has "Dashboard", "Customers", "Orders", "Map", "Finance", "Receivables", "Deposits" and "Reconciliation".
- On a phone, "Finance", "Receivables", "Deposits" and "Reconciliation" are grouped behind a "☰ Finance" button in the bottom bar. Tap it to open them.
- The "☰" button in the top-right corner opens the owner tools menu: "⚙ Settings" and "🛒 Product builder".
- Duplicate customers (./duplicates.html) is opened from the Customers page with the "Find duplicates" button.
- The single order page (./order.html) has a shorter bottom bar: "Dashboard", "Customers", "Orders", "Receivables", "Deposits" (plus "☰ Finance" on a phone).

## 2. The life of an order

1. **Customer orders.** The customer fills in the public order form (./index.html). They choose products, delivery date and time window, and confirm their address on a map. The order arrives with status **Pending approval**. The order total already includes the deposit for any returnable containers in it.
2. **New-order alert.** The Dashboard shows a pop-up "New order to approve" with a "View" button. The browser tab title shows a count, for example "(2) Vietnam Sparkle Owner Dashboard". With phone alerts turned on, the phone buzzes as well.
3. **Owner approves.** Press "Approve". The status becomes **Approved** (shown under the "To assign" filter). Approving links the order to the customer's record and books the container deposit for the containers in the order on that customer's container record. Approving does not collect any money.
4. **Assign a driver.** Choose a driver in the driver drop-down on the order card. The status becomes **Assigned** ("To send" filter). Choosing "Unassigned" moves it back to Approved.
5. **Out for delivery.** When the driver leaves, press "Send out for delivery". The status becomes **Out for delivery** ("En route" filter).
6. **Delivered.** At the door, press "Mark delivered & record payment". In one form you record the empties taken back (with a photo), any lost or broken containers, and the payment: either "Collected" (amount and method) or "Not collected today" (reason and follow-up date). Saving with "Save & mark delivered" sets the status to **Delivered**.
7. **Receivables follow-up.** Any delivered order that still has a balance due appears on Receivables (./receivables.html). Press "Record payment" there when the money arrives later, or set a new follow-up date.

**Owner-created orders** (made from Customers or a customer's profile) skip approval. They start as **Approved**, and their container deposit is booked straight away.

### Cancellation and refund paths

- **Customer cancels before approval.** On their account page a customer can cancel their own order while it is still Pending approval. No staff action is needed.
- **Owner cancels.** Press "Cancel order" on the order card or the order page. The app asks for a reason (optional). Cancelling sets the status to **Cancelled** and reverses the container deposit that was booked for the order (shown as "charge reversed"). If the customer had already paid anything, a refund case is opened.
- **Out for delivery orders cannot be cancelled directly.** First press "Reset" on the Dashboard card (or "Reset to assigned" on the order page) to return the order to Assigned, then cancel it.
- **Delivered orders cannot be cancelled.** They cannot be put back to an earlier status either.
- **Refunds.** If money was paid before the cancellation, record the refund and attach its proof on the order page (recipe 4.7). Until both are done, the case is listed on Reconciliation (./reports.html) under "Refunds due & missing proof".
- **Cancellation requests.** Some orders may carry a "Cancellation requested" banner with "Approve cancel" and "Dismiss" buttons. "Approve cancel" cancels the order. "Dismiss" leaves the order active, so follow up with the customer.

## 3. Pages

### Dashboard: ./admin.html

**What it is for:** the daily working screen. Use it for sign-in, approvals, driver assignment, sending orders out and recording deliveries.

**What you see:**
- **"Active orders"**: every unfinished order (Pending approval, Approved, Assigned, Out for delivery), one card per order, with a count badge.
- **Status filter buttons:** "To approve", "To assign", "To send", "En route", "All active", each with a count. After sign-in the Dashboard opens on "To approve" if anything is waiting for approval. Otherwise it opens on "All active".
- **"Delivery timing" drop-down:** "All delivery dates", "Needs a date", "Overdue", "Today", "Upcoming".
- **Sorting:** important orders come first, then the earliest delivery date, then the oldest order.
- **Each card shows:** the customer name (links to their profile), a status badge, a timing line ("Today", "Tomorrow", a date, "N days overdue · date", or "Needs delivery date"), the order ID (links to the order page), the short address, a mini map ("Tap to enlarge"; or an "Open map" button), product photos with quantities, the driver name, and the order total (goods plus deposit).
- **Extra card details:** payment-proof thumbnails (tap to enlarge; "Open in new tab"), an "Important" note if the order is flagged, and "♻ Pick up empties" if the customer asked for their empties to be collected.
- **"Quick summary":** "Today orders", "Cash today", "Transfer/QR today" (bank transfer and QR code together), "Unpaid", plus a "Finance" link.
- **Pop-ups:** "New order to approve" ("View"), "Cancellation requested" ("Review"). Reconciliation warnings ("Open report") appear when the nightly money check found or fixed a problem, or has not run for over 30 hours.

**Buttons on a card, by status:**
- **Pending approval:** "Approve", "☆ Important", "Cancel order", "Edit details", and the contact button (chat icon, which opens WhatsApp, Zalo and Phone).
- **Approved:** driver drop-down, "☆ Important", "Cancel order", "Edit details", contact.
- **Assigned:** driver drop-down, "Send out for delivery", "☆ Important", "Cancel order", "Edit details", contact.
- **Out for delivery:** "Mark delivered & record payment", "Reset" (returns the order to Assigned and keeps the driver), "☆ Important", "Edit details", contact. There is no "Cancel order" at this stage; press "Reset" first.

**Dialogs:**
- **"Delivery map":** a large map of the confirmed pin, with "Directions" (opens Google Maps) and "Close".
- **"Edit order":** see recipe 4.3.
- **"Mark delivered":** see recipe 4.5.
- **"Important order":** a required "Note" (up to 300 characters), "Save important", "Remove label", "Cancel".

### Orders: ./orders.html

**What it is for:** finding any order, past or present, including delivered and cancelled ones.

**AI fill:** tap **AI fill**, paste a customer's loose-text message, then **Fill draft**. This sends the message to Google's free Gemini service; Google may use it to improve its products. The customer directory is matched inside the app, not sent to Gemini. Review suggested product typo corrections and quantities. Choose the matching customer (phone matches first, then similar names/addresses), or explicitly choose **Create a new customer — none of these match**. New records are created only with the final order, and duplicate phones are blocked. Check or confirm the order's delivery pin on Google Maps, date, notes and total; tick the review box, then **Create order**. Nothing is saved by **Fill draft** alone. Existing customer profiles are never overwritten. Saved orders start Approved, ready to assign, and include normal container deposits. AI cannot record payments or returned containers. If free quota is reached, use Customers → New order instead. Drivers currently use staff accounts with the owner role; driver-only access is not enabled.

**What you see:**
- "Cards" / "List" view switch.
- "Search..." box. It searches order ID, customer name, phone and address.
- Status drop-down: "All statuses", "Pending approval", "Approved", "Assigned", "Out for delivery", "Delivered", "Cancelled".
- "From" / "To" delivery-date range.
- Sort drop-down: "Delivery date (newest)", "Delivery date (oldest)", "Created (newest)", "Created (oldest)".
- "Refresh" button.
- **Cards** show customer, delivery date, status, "Subtotal", "Balance", address, a map preview, products, proof photos, a payment badge ("Paid", "Partial", "Unpaid") and the order ID. Card buttons: "Open order", "Customer", contact, "☆ Important".
- **List** columns: Customer, Phone, Status, Payment, Subtotal, Balance, Order ID.

You cannot approve or deliver from this page. Open the order, or use the Dashboard.

### Single order: ./order.html?id=…

**What it is for:** the complete record of one order and all its actions. Open it from any order ID link or with "Open order".

**Sections, top to bottom:**
- **Order number** and a line "Order for [name] · delivery [date]".
- **Summary:** status badge, payment badge, "Open customer", customer phone/email, delivery date and window, delivery address and "Order notes".
- **"Order actions":**
  - Pending approval: "Approve", "Edit details", "Cancel order".
  - Approved: "Driver" drop-down, "Edit details", "Cancel order".
  - Assigned: "Send out for delivery", "Driver" drop-down, "Edit details", "Cancel order".
  - Out for delivery: "Mark delivered & record payment", "Call customer", "Reset to assigned" (back to Assigned, driver kept; then you can edit or cancel). There is no "Edit details" or "Cancel order" at this stage.
  - Delivered: "Delivered — invoice is below."
  - Cancelled: "Cancelled — [reason]".
- **"Old-customer empties to record":** appears only when the customer said they already hold containers from before the app. See recipe 4.10.
- **"Invoice":** shown only once the order is Delivered. "Download PDF", "Email" (shown when the customer has an email address; it downloads the PDF for you to attach) and "WhatsApp" (shown when there is a phone number). Invoices are PDF documents, not official tax e-invoices.
- **"Items":** Item, Qty, Unit price, Line total.
- **"Financial summary":** "Subtotal", "Container deposits", "Paid", "Balance due".
- **"Cancellation & refund":** shown only if the order has a cancellation case. It shows the case details, "Refund required", "Refund remaining", and each refund with "proof ✓" or "proof missing". Buttons: "Record refund", "Attach proof" (recipe 4.7). A case still waiting for a decision shows "Approve cancellation" / "Dismiss request".
- **"Payment history":** every payment with amount, method, Payment ID, Date, Reference, "Received by", and "Open payment proof" when there is a photo. Refunds appear as negative amounts.
- **"Stored documents":** uploaded invoices, order confirmations and payment-proof photos ("Open proof" / "Open document").
- **"Container and deposit history":** every container event for this order, for example "charged · 2 glass crate", "credited", "refunded", "forfeited", "charge reversed".
- **"Returns":** empties taken back on this order, with the quantity, date and whether the deposit was "taken off the bill" or given as "cash back" (plus any returns imported from the old spreadsheet). The same returns also appear as "credited" / "refunded" in "Container and deposit history".
- **"Correction note"** (marked "Append only"): see recipe 4.15.
- **"Audit timeline":** every event for the order, newest first.
- **"Record metadata":** IDs, source, created/updated times, assigned driver ID, pin coordinates, cancellation reason.

### Customers: ./customers.html

**What it is for:** the customer directory, adding customers, and starting an order for anyone.

**What you see:**
- "Cards" / "List" view switch.
- "Find duplicates" button. A number badge on it shows how many possible duplicate groups exist.
- "Search..." box.
- Attention filter: "All attention", "Needs attention", "Payment due", "Containers held", "Likely reorder", "Inactive", "All clear".
- Sort drop-down: "Name (A → Z)", "Name (Z → A)", "Most recent order", "Oldest order first", "Most orders".
- Buttons: "Refresh", "Add customer", "New order".
- **Cards** show the name, order count, an attention line, "Balance", "Containers", "Last order", the address, phone, lifetime sales and usual reorder gap. Card buttons: "Open customer", "Call", "Map".
- **Attention lines:** "[amount] VND needs collecting", "N containers held N days" (30 days or more), "Likely ready to reorder", "No order for N days" (60 days or more), "Nothing needs attention".
- **List** columns: Name, Contact, Address, Notes, Last order, Orders.

"Add customer" and "New order" open the same dialog (see recipe 4.8). If the phone matches an existing customer, it offers "Use this existing customer" (the default) or "Create a separate new record".

### Single customer: ./customer.html?id=…

**What it is for:** one customer's profile, delivery addresses, order history, and merging.

**What you see:**
- **"Customer insights":** an attention line, plus "Outstanding", "Containers out", "Last order" and "Lifetime sales", and a line about their ordering rhythm.
- **Buttons at the top:** "Create order for this customer", "All customers".
- **"Details":**
  - Fields: "Name", "Phone", "Email", "Billing name", "Tax ID", "Notes".
  - "Append dated note" adds a time-stamped line to the top of Notes.
  - "Save changes" saves. A phone number must include the country code, for example +84 905 123 456.
- **"Delivery addresses":**
  - Each address shows "Default" (if it is the default) and "Pin confirmed" or "Pin needs refresh", with "Edit", "Set as default" and "Remove".
  - To add an address, type it in "Add another delivery address", press "Find on map", drag the pin to the entrance, then press "Save confirmed address". Use "Cancel edit" to stop editing.
  - The default address is filled in automatically on new orders.
- **"Order history":** each order with date, ID link, status, payment badge, Subtotal, Deposit, Paid, Balance.
- **"Merge this customer into another":** "Choose a target and merge…". See recipe 4.9.
- **Merged records:** an archived (merged) record shows "This record was merged." with a link to the record it was merged into. You cannot create orders on it.

### Product builder: ./catalog.html

**What it is for:** the products customers can order, with their price and deposit. Prices apply to future orders only; past orders keep their totals. Products are retired, never deleted.

**What you see:**
- **"Customer storefront":** choose "Cards" or "List" for how the catalog looks on the public order page.
- **"Products":** "Add product", "Refresh". Each product shows price, storefront column, deposit and container, and a stock line, for example "12 crates on hand · 12 available · 90,000 VND cost · 30,000 VND margin/unit" or "Not counted". Buttons on each: "Edit", "Stock & cost", "Retire".
- **"Retired products (N)":** retired items, each with "Put back on sale".

The product and "Stock & cost" dialogs are described in recipe 4.11. Customers never see stock or supplier cost.

### Finance: ./finance.html

**What it is for:** a read-only money summary for "This month", from the 1st of the month to today.

**Tiles:**
- **"Delivered sales":** goods subtotal of delivered orders, without deposits.
- **"Collected":** all payments dated this month, split into Cash, Bank/QR and Other.
- **"Outstanding":** the balance still owed on this month's orders (not cancelled, not pending approval). It includes deposits.
- **"Deposits held":** the total container deposit customers have paid and not yet had returned.

There are no buttons on this page.

### Receivables: ./receivables.html

**What it is for:** chasing unpaid money. It lists delivered orders only. Money for undelivered orders is collected at the door in the delivery form.

**What you see:**
- **"Unpaid" tile:** count, total, and "Oldest Nd". The tile gets a red border when the oldest is 3 days or more.
- "Search customer / order / phone" box and "Refresh".
- **Table columns:** Delivered (date), Days (red once it reaches the "Receivable overdue" threshold, 7 days by default), Customer, Phone, Order, Balance, Follow-up ("Not set" if empty; red when the date has passed).
- **Row buttons:** "Record payment", "Invoice", "Chase via WhatsApp" (opens WhatsApp with a ready-made reminder).

The "Record payment" dialog is described in recipe 4.6.

### Deposits: ./deposits.html

**What it is for:** containers currently with customers, per container type, oldest first. Use it to chase returns and to write off lost containers.

**What you see:**
- **"Containers out" tile:** count and deposit value, plus how many have been held at least the forfeit-threshold days.
- **Red warning panel:** "N container records need fixing", listing customers whose records show more returned than they were ever charged. See the rules of thumb (section 6).
- "Search customer / phone" box and "Refresh".
- **Age filter chips:** "All", "At risk" (held at least the warning days, 30 by default), "Overdue" (held at least the forfeit days, 60 by default).
- "Container" drop-down.
- **Table columns:** Customer, Phone, Container, Qty, Deposit, Since, Days (yellow at the warning days, red at the forfeit days).
- **Row buttons:** "Mark as forfeit", "Send reminder" (WhatsApp message asking to collect the containers on the next delivery).

The "Mark as forfeit" dialog is described in recipe 4.17.

### Reconciliation: ./reports.html

**What it is for:** checking that every order's stored money totals match its payments. The app re-checks each order the moment a payment changes, and again in a full nightly check at 03:00. This page also lists refunds that are still owed.

**What you see:**
- **Tiles:** "Last run" (time, plus "Clean — every order matched its payments.", "Corrected N orders.", a failure message, or "No run in over 30 hours"), and "Last N runs" with how many orders were corrected.
- **"Recent runs":** each run marked "Clean", "Drift corrected", "Failed" or "Running", expandable to see the corrected orders. Tick "Only runs with drift" to filter. "Refresh".
- **"Real-time corrections":** orders fixed the instant a payment changed.
- **"Refunds due & missing proof":** cancellation cases still owing money ("Refund pending", "Refund partial") or missing proof ("Proof missing"). Columns: Order, Customer, Kind, Refund required, Still owed, Refund, Proof, Cancelled. Open the order to record the refund or attach the receipt.

The page is read-only. Fixes are made on the order page.

### Duplicate customers: ./duplicates.html

**What it is for:** merging customer records that share a phone number or email, which mostly happens with records imported from the old spreadsheet.

**What you see:** tiles "Duplicate groups" and "Records that would be archived", a "Rescan" button, and one group per shared phone or email ("Same phone: …" / "Same email: …", "N records — keep one:"). Each record shows its name, ID, badges ("canonical id", "has sign-in"), phone, email, order count and address. See recipe 4.9 for merging.

### Map and trip planner: ./map.html

**What it is for:** seeing active orders on a map and planning a driver's route.

**What you see:**
- Driver drop-down: "All drivers", "Unassigned", or each driver.
- Status drop-down: "All approved orders" (Approved, Assigned and Out for delivery; orders still Pending approval are not on the map), "Approved only", "Assigned only", "Out for delivery only".
- Buttons: "Refresh", "Build a trip".
- **The map:** a coloured pin per order, coloured by driver, with a legend. Tapping a pin shows the customer, order ID, address, status, driver and "Open order".
- **A banner** if some orders "could not be pinned" (fix the address on the customer profile).
- **Table columns:** Trip (tick box), Customer, Products, Delivery ("Today", "Overdue" or a date), Phone, Address (● pinned or ○ no pin; the link opens Google Maps), Order ID, Driver.
- **"Trip planner"** panel with hints, the driver's loadout and the result.

The map does not assign drivers. Assign drivers on the Dashboard or the order page.

### Settings: ./settings.html

**What it is for:** business configuration.

**Sections:**
- **"Business identity":** "Display name (public)", "Legal name (invoices)", "Tax code (mã số thuế)", "Registered address".
  - "Contact channels": "WhatsApp URL", "Zalo URL", "Facebook Messenger URL", "Public phone", "Public email".
  - "Bank details (customer receipts / How to pay)": "Account name", "Account number", "Bank name", "Bank BIN (for VietQR)".
  - Press "Save changes". Customers see the bank and contact details on their pages and invoices.
- **"Phone alerts":** "Enable phone alerts", "Send test alert". "What to alert me about": "New orders", "Refunds owed", "Payment corrections".
- **"Thresholds":**
  - "Follow-up default (days)", default 3.
  - "Receivable overdue (days)", default 7.
  - "Deposit warning (days)", default 30.
  - "Deposit forfeit (days)", default 60.
  - Press "Save thresholds". Leave a field blank to reset it to the default.
- **"Warehouse (route origin)":** "Warehouse address", "Save warehouse". It shows the saved pin coordinates.
- **"Test data":** "Populate test orders" and "Delete test orders & customers". These only create or remove clearly tagged test records, never real ones. Do not use them during real operations unless you mean to.
- **"Staff":** everyone who can sign in to the staff pages, with badges "You", "Driver H-…" and "Email not verified", and a "Remove" button (you cannot remove yourself). Below the list is the "Add employee" form: "Email they sign in with", "Name", "Phone (optional)", and "Delivery driver — add to the driver list". See recipe 4.18.
- **"Drivers & loadouts":** for each driver, the number of each container type their truck carries on a standard run. Press "Save loadout". New drivers are added under "Staff" with "Delivery driver" ticked.
- **"Sign out"** is at the top of the page.

## 4. How do I…

### 4.1 Approve an order

1. Open the Dashboard. It opens on "To approve" when something is waiting. You can also press "View" on the "New order to approve" pop-up.
2. Check the card: products, date, address and pin. If something is wrong, press "Edit details" first (see 4.3).
3. Press "Approve". The order moves to "To assign".
4. If the order's phone belongs to a different existing customer, a warning appears. Press "Cancel" and fix a typo with "Edit details", or confirm to approve anyway. The order stays on the ordering customer's own account either way.

On the order page, the same "Approve" button is under "Order actions".

### 4.2 Assign a driver

1. On the Dashboard, filter "To assign".
2. On the card, pick the driver from the drop-down. It saves immediately and the order moves to "To send".
3. On the order page, use the "Driver" drop-down under "Order actions".
4. To unassign, pick "Unassigned". The order goes back to Approved.

### 4.3 Edit an order's details or address

1. Press "Edit details" on the Dashboard card or the order page. It is available before delivery. On the order page it is not shown once the order is Out for delivery.
2. The "Edit order" dialog lets you change: "Customer name", "Phone", "Address", "Delivery date", "Delivery window", "Notes", and "Items" (use "Add product" to add, the + and − buttons to change quantities).
3. **If you change the address:** press "Find on Google Maps", drag the pin to the exact entrance, then press "Use this address". Reset the pin with "Reset pin". The app will not save a changed address until it has been confirmed on the map ("Confirm the new address on Google Maps before saving.").
4. Press "Save changes", or "Discard" to close without saving. An order needs at least one item.
5. Changing container quantities automatically adds or removes the matching deposit. On a Pending approval order nothing is booked until you press "Approve", which then charges the deposit for the items as they are.

To change a customer's saved addresses for future orders, use "Delivery addresses" on the customer profile instead.

### 4.4 Send an order out for delivery

1. The order must be Assigned (a driver chosen).
2. Press "Send out for delivery" on the Dashboard card ("To send" filter) or on the order page.
3. To undo before delivery, press "Reset" on the Dashboard card or "Reset to assigned" on the order page. The order returns to Assigned with the same driver.

### 4.5 Record a delivery (driver at the door)

Press "Mark delivered & record payment" on the Dashboard card ("En route" filter) or the order page. The "Mark delivered — [customer]" form opens.

**Part 1: "Empties collected this trip".**
- The form lists each container type the customer is holding, for example "Glass crates · 3 held". If they hold none it says "No empties to take back."
- Tap + or − to enter how many came back. You cannot enter more than they hold.
- For each type choose what happens to the deposit:
  - "Off this bill": the deposit is taken off what they owe today.
  - "Cash back now": the driver hands the deposit back in cash.
  - "Decide later": nothing is recorded, and the containers stay on the customer's record.
- Enter the count of containers collected and choose how to handle the deposit. Add a note if there is anything to explain.
- If the form shows "This customer's container record is wrong", deliver and take payment as normal. Do not record returns or write-offs for that customer until the record is fixed.
- "♻ The customer asked for an empties pickup this delivery." appears when the customer requested a pickup. The request clears once a return is actually recorded.

**Lost or broken containers:**
- Tick "Report lost or broken containers".
- Choose "Container type" (only types they hold) and "Qty lost".
- Fill in "Reason / note". It is required.
- This writes those containers off as forfeited (see the glossary).

**Part 2: "Payment".**
- "Amount due" shows the balance. When empties are taken off the bill, a summary shows "Order due", "− Empties credit", "Cash to collect" and "Cash to hand back".
- If the empties are worth more than the bill, "Empties worth more than the bill" asks what to do with the leftover: "Keep as credit" (for next time) or "Give cash back" (now).
- **"Collected":** enter "Amount collected" (pre-filled with what is due) and choose "Method": "Cash", "Bank transfer", "QR code", "Other". Bank transfer and QR code need either a "Reference" or a "Proof photo" ("📷 Take photo"). Cash needs neither.
- **"Not collected today":** choose "Reason" ("Customer said next time", "Customer wasn't home", "Driver forgot to ask", "Waived by owner", "Other"). "Follow up by" is pre-filled with today plus the follow-up default days. Add "Notes".
- An amount of 0 is refused while money is still owed. Choose "Not collected today" instead.
- If the amount collected is more than is due, the app asks you to confirm. The extra stays on the customer's account as credit.

**Save:** press "Save & mark delivered". Press "Discard" to close without saving. The order becomes Delivered. If anything is still owed, it appears on Receivables with the follow-up date.

### 4.6 Record a payment later

1. Open Receivables (./receivables.html) and find the order. Search by customer, order or phone.
2. Press "Record payment".
3. **Money received:** choose "Money received" and enter "Amount collected" and "Method" ("Cash", "Bank transfer", "QR code", "Other"). Bank transfer and QR code need a "Reference" or a "Proof photo" ("📷 Take photo"). Press "Save payment".
4. **Still not paid:** choose "Not collected — set follow-up", pick a "Reason" ("Customer said next time", "Customer unreachable", "Amount disputed", "Waived by owner", "Other") and a "Follow up by" date (required), add "Notes", then press "Save payment".
5. Paying more than the balance asks for confirmation, and the extra becomes customer credit.
6. Payments are always dated today. Only delivered orders can take a payment here.

### 4.7 Cancel an order and handle a refund

1. If the order is Out for delivery, first press "Reset" on its Dashboard card or "Reset to assigned" on the order page.
2. Press "Cancel order" on the Dashboard card or the order page.
3. Type a reason when asked (optional; it is kept for the audit), then press OK. Pressing Cancel on that prompt aborts.
4. The order becomes Cancelled and its container deposit is reversed.
5. **If the customer had paid anything,** open the order page. The "Cancellation & refund" section shows "Refund required" and "Refund remaining".
   - Give the money back, then fill in "Amount", "Method" ("Bank transfer", "QR code", "Cash", "Wallet") and "Reference", and press "Record refund". Bank, QR and Wallet refunds need a reference (the transfer ID or a note). Cash does not.
   - You can record several partial refunds until "Refund remaining" is 0.
6. **Attach refund proof:** next to the refund line marked "proof missing", choose the file (photo or PDF) and press "Attach proof". For a cash refund, use a photo of the signed slip. The line changes to "proof ✓".
7. Reconciliation's "Refunds due & missing proof" list clears once the refund is fully paid and proved.

Delivered orders cannot be cancelled. If a customer wants money back after delivery, ask Ty how to handle it.

### 4.8 Add a customer, or create an order for a customer

**New customer:**
1. Customers page → "Add customer".
2. Fill in "Name" and "Phone" (pick the country code first). "Email" is optional.
3. Type the "Address" and pick a Google suggestion, or press "Find on Google Maps". Drag the pin to the entrance and press "Use this location".
4. Add "Notes" if useful.
5. Optionally add products to create their first order straight away.
6. Press "Save customer". The app opens the new profile.

**Order for an existing customer:**
1. Open their profile and press "Create order for this customer". You can also use Customers → "New order" and type their phone (then choose "Use this existing customer").
2. Set "Delivery date" and "Delivery window". Check the "Address"; the default address is pre-filled and already confirmed. A different address must be confirmed on the map.
3. Add products with "Add product" and add "Notes" if needed.
4. Press "Create order".
5. The order starts as Approved (no approval needed). Assign a driver from the Dashboard.

### 4.9 Merge duplicate customers

**Option A: Duplicate customers page.**
1. Customers → "Find duplicates".
2. In each group, select the record to keep. Prefer the one with the most orders or with "has sign-in".
3. Press "Merge into selected", check the summary, then press "Merge".
4. If the dialog warns "This merge attaches a sign-in account to the surviving record", tick "I am certain this sign-in belongs to this customer" only if you are sure.

**Option B: from a profile.**
1. On the record you want to get rid of, press "Choose a target and merge…".
2. Search by name, phone or CUS-… id and pick the record to keep.
3. Check "From (archive)" / "Into (keep)", then press "Merge and archive this record".

**What merging does:** all orders, payments, deposits and container history move onto the kept record. The other record is archived, never deleted. Two records with different sign-ins cannot be merged.

### 4.10 Confirm an old customer's pre-app empties

Customers who had containers before the app existed can say so on the order form. That order's page then shows "Old-customer empties to record".

1. Check with the customer or driver how many containers they really hold.
2. Correct "How many" for each container.
3. Set "Deposit each" to the deposit they actually paid back then. It is pre-filled with today's catalog deposit.
4. Check "Total opening deposit" and press "Record opening deposit".
5. The panel changes to "Opening empties recorded". From then on, returning those containers balances correctly instead of breaking the record.

This only records what they hold and paid long ago. It does not charge the customer anything new or change the order's bill. It can be recorded only once.

### 4.11 Add or retire a product, and set stock and cost

- **Add:** Product builder → "Add product". Fill in:
  - "Product name", "Price (VND)", "Deposit per unit (VND)".
  - "Storefront column": "Glass bottle water", "Large water jugs" or "Extra items".
  - "Returnable container": "None — not returnable", "Glass crate", "18.9 L jug", "19 L jug" or "20 L jug". A container type is required if the deposit is above 0.
  - Optional: "Unit label", "Sort order" (lower shows first), "Image URL" or "…or upload a photo", "Notes shown to customers".
  - Press "Save product" ("Discard" closes without saving).
- **Change the price:** "Edit" → change "Price (VND)" → "Save product". This affects new orders only.
- **Retire:** press "Retire". The product disappears from the order form but stays in history. Bring it back with "Put back on sale" under "Retired products".
- **Stock and cost:** "Stock & cost" → enter "On hand" (whole units) and "Supplier cost per unit (VND)". The dialog shows "Reserved (read-only)", "Available (computed)" and the margin per unit. Press "Save stock count". Orders do not reduce stock automatically, so recount and update it by hand.

### 4.12 Plan a trip on the map

Before you start, a warehouse address must be saved in Settings → "Warehouse (route origin)", and the driver must have a loadout saved in Settings → "Drivers & loadouts".

1. Open Map. In the driver drop-down, pick one specific driver (not "All drivers" or "Unassigned").
2. Press "Build a trip" (it changes to "Stop selecting").
3. Select stops by ticking the Trip boxes or tapping map pins, or press "Select all shown". Orders without a pin cannot be selected. Press "Clear" to start over.
4. Press "Plan selected". The planner shows "Run N orders in … — about N km and ~… of driving".
   - The run is split into "Trip 1", "Trip 2" and so on, so each trip fits the truck's loadout.
   - Each trip has a "Navigate" button that opens Google Maps with the stops in order.
   - Orders that do not fit the loadout are listed as "won't fit the loadout".
5. Changing a filter clears the plan. Planning does not assign drivers or change order statuses.

### 4.13 Turn on phone alerts

1. On the phone, add the site to the Home Screen first. This is required on iPhone (iOS 16.4 or later), and you must open the app from the Home Screen icon.
2. Sign in, open Settings → "Phone alerts", and press "Enable phone alerts". Allow notifications when asked.
3. Choose what to be alerted about: "New orders", "Refunds owed", "Payment corrections".
4. Press "Send test alert" to check it works.
5. Do this on each phone that should get alerts. To stop, press "Phone alerts on — tap to turn off".
6. If it says "Phone alerts blocked", re-allow notifications for the site in the phone or browser settings.

### 4.14 Change thresholds, warehouse or business details

All of these are on Settings (./settings.html); see that page's section above for the fields.
- **Thresholds:** change the days, then press "Save thresholds".
- **Warehouse:** type the address, then press "Save warehouse".
- **Business details, contact links and bank details:** press "Save changes".
- **Driver loadouts:** change the numbers, then press "Save loadout".

### 4.15 Add a correction note or flag an important order

- **Correction note:** on the order page, open "Correction note".
  - Pick a category: "Correction", "Exception", "Customer request" or "Internal compliance note".
  - Explain what was wrong and what was done (at least 10 characters), then press "Append correction".
  - Saved notes cannot be edited or deleted.
- **Important order:** press "☆ Important" on a Dashboard or Orders card. Write the required "Note" and press "Save important". The card then shows "★ Important" and the note, and it sorts to the top of the Dashboard. To remove the flag, press "★ Important" then "Remove label".

### 4.16 Send an invoice

- For a delivered order, press "Invoice" on the Dashboard card or the Receivables row.
- In "Invoice preview", use "Download PDF", "Send via email" or "Send via WhatsApp". The message carries a link to the PDF.
- The app warns you if this invoice was already sent before.
- On the order page, the "Invoice" section has "Download PDF", "Email" and "WhatsApp".

### 4.17 Write off containers outside a delivery

1. Open Deposits and find the customer and container row.
2. Press "Mark as forfeit".
3. Enter "Qty to forfeit" and choose a "Reason": "Lost", "Destroyed / broken", "Never returned after multiple attempts", "Waived as goodwill" or "Other". Add a "Note" if useful.
4. Press "Confirm forfeit" ("Discard" closes without saving).

To write off during a delivery instead, use "Report lost or broken containers" in the delivery form.

### 4.18 Add or remove an employee (staff access, drivers)

1. Open Settings (./settings.html) → "Staff".
2. Fill in their email, name and optional phone number.
3. Keep "Delivery driver — add to the driver list" ticked for drivers. They appear in the driver drop-downs and under "Drivers & loadouts". Untick it for office staff.
4. Press "Add employee". If the app warns about an existing account with an unverified email, continue only if the employee confirms they created that account.
5. Send them to the admin sign-in page (./admin.html). They can enter their email and select "Set or reset password", follow the email link, then return to sign in. Staff who already have a password can use it. If they're already signed in, ask them to sign out and back in to pick up their access.

**To remove someone:** press "Remove" next to their name in "Staff". They lose access within an hour. Their past orders keep their name, and they disappear from the driver drop-downs. You cannot remove yourself.

Everyone in "Staff" has full access, including money and settings, so only add people you trust with that.

## 5. Glossary

**Order statuses** (Dashboard filter in brackets):
- **Pending approval** ("To approve"): ordered by the customer, not yet approved. No deposit is booked.
- **Approved** ("To assign"): approved or owner-created, no driver yet. Sometimes called "new".
- **Assigned** ("To send"): a driver is chosen.
- **Out for delivery** ("En route"): the driver is on the way. "Reset" it before cancelling.
- **Delivered:** final. It cannot be cancelled, reset or edited.
- **Cancelled:** final, with no delivery.

**Payment status:** "Paid" (nothing owing), "Partial" (some paid, some owing), "Unpaid" (nothing paid).

**Money terms:**
- **Subtotal:** the price of the goods only.
- **Container deposits / Deposit:** money charged per returnable container (crate or jug). It is part of the order total, and the customer gets it back (as credit or cash) when the container comes back.
- **Deposit booked / charged:** on approval, or when the owner creates an order, the containers in the order are added to the customer's container record with their deposit value. Shown as "charged".
- **Empties:** empty returnable containers (crates, jugs) held by a customer.
- **Container return:** empties taken back by the driver. Recorded in the delivery form as "Off this bill" (shown as "credited") or "Cash back now" (shown as "refunded").
- **Decide later:** a return that is not recorded. The containers stay on the customer's record.
- **Forfeit / forfeited:** containers written off as lost, broken, never returned, or waived. They leave the customer's record, the customer gets no deposit back, and the business keeps the deposit already paid. A reason is always required.
- **Charge reversed:** the deposit booking undone because the order was cancelled. It is not a physical return.
- **Balance due:** what the customer still owes on an order. It is the subtotal plus deposits, minus what has been paid and credited.
- **Credit:** money on the customer's account beyond what they owe. It comes from overpaying, or from "Keep as credit" when returned empties are worth more than the bill.
- **Receivables:** delivered orders that still have a balance due. They are listed on ./receivables.html.
- **Not collected / deferred:** delivered without payment. Recorded with a reason and a "Follow up by" date. It is not a payment and does not reduce the balance; even "Waived by owner" leaves the balance owing on the order.
- **Follow-up date:** when to chase the customer next. Shown in the Receivables "Follow-up" column.

**Containers and customers:**
- **Containers out / held:** containers a customer currently has, from their container record.
- **Pre-app empties / opening deposit:** containers an old customer had before the app. The owner confirms them on the order page so later returns balance correctly.
- **Broken container record:** a customer shown as having returned more containers, or more deposit, than they were ever charged. It needs fixing before more returns are recorded.
- **Pickup requested (♻ Pick up empties):** the customer asked, from their account page, for empties to be collected on the next delivery.
- **Merged / archived customer:** a duplicate record that has been folded into another. It is kept for audit only.

**Other terms:**
- **Reconciliation / drift:** the app recomputes each order's paid and balance figures from its payments. "Drift" means the stored totals did not match and were corrected automatically. Normal use should not cause drift, so investigate any correction.
- **Refund case:** a record opened when an order with payments is cancelled. It tracks "Refund required", "Refund remaining", refund status ("pending", "partial", "paid") and proof ("Proof missing" / "Proof filed").
- **Importance flag ("Important"):** a staff-only label with a required note. It puts the order at the top of the Dashboard.
- **Delivery window:** "Any time", "Morning (10:00–13:00)", "Afternoon (13:00–16:00)", "Late afternoon (16:00–19:00)", "Evening (19:00–22:00)".
- **Loadout:** how many of each container type a driver's truck carries. Used by the trip planner.
- **Pin:** the confirmed map location of a delivery address, set by dragging the pin to the entrance and confirming.

## 6. Rules of thumb

- **Payments are append-only.** A saved payment, refund or correction note can never be edited or deleted. To fix a mistake, add a new entry (for example a refund, a further payment, or a "Correction note" explaining it). Never try to hide an error.
- **Delivered is final.** A delivered order cannot be cancelled, reset or edited, so check the delivery form before pressing "Save & mark delivered".
- **Only record containers the driver physically counted.** Returns and write-offs move deposit money, and the app limits them to what the customer actually holds. If unsure, choose "Decide later" rather than guessing.
- **Bank transfer and QR payments need proof:** a reference number or a photo. Cash does not.
- **Never record 0 as "Collected"** when money is owed. Use "Not collected today" or "Not collected — set follow-up" so the order gets a follow-up date.
- **Check the amount before saving.** An extra zero is a 10× overpayment. The app asks you to confirm any amount above what is due, and the extra becomes credit.
- **"Waived by owner" does not clear the debt.** It only records why nothing was collected, and the balance stays on Receivables.
- **To cancel an order that is out for delivery,** press "Reset" (or "Reset to assigned") first, then "Cancel order".
- **Always confirm the pin on the map** for new or changed addresses. The app will not save an unconfirmed address, and the trip planner skips orders without a pin.
- **Do not record returns for a customer whose container record is shown as wrong.** Ask Ty to fix it first, or the customer's next deposit disappears into the gap.
- **Retire products, never delete them,** so order history stays correct. Price changes only affect new orders.
- **Stock numbers are manual.** Recount and update "Stock & cost" after a physical stock count.
- **Refunds need proof.** After "Record refund", always "Attach proof", or the case stays on Reconciliation as "Proof missing".
- **Investigate reconciliation alerts.** A correction means something changed an order's money outside the normal steps.
- **Do not type customer personal details into the help chat.** Describe the problem in general terms instead.

export const COLLECTIONS = {
  customers: "customers",
  orders: "orders",
  orderItems: "orderItems",
  products: "products",
  drivers: "drivers",
  payments: "payments",
  depositEvents: "depositEvents",
  returns: "returns",
  purchases: "purchases",
  expenses: "expenses",
  documents: "documents",
  dailySummaries: "dailySummaries",
  inquiries: "inquiries"
};

export function normalizeValue(value) {
  if (value === "" || value === undefined) return null;
  return value;
}

// Convert a Sheets-exported value to a "YYYY-MM-DD" string in Vietnam local
// time (UTC+7). Sheets dates come through as full ISO UTC timestamps via
// JSON.stringify, so naive slice(0, 10) is off by one day for anything after
// 17:00 UTC.
export function toDateKey(value) {
  if (value === "" || value === null || value === undefined) return null;
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return typeof value === "string" ? value.slice(0, 10) : null;
  }
  const shifted = new Date(parsed.getTime() + 7 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

export function toStringValue(value) {
  if (value === "" || value === null || value === undefined) return null;
  return String(value);
}

export function mapCustomer(row) {
  return {
    name: normalizeValue(row.name),
    billingName: normalizeValue(row.billing_name),
    phone: toStringValue(row.phone),
    secondaryPhone: toStringValue(row.secondary_phone),
    taxId: normalizeValue(row.tax_id),
    address: normalizeValue(row.address),
    area: normalizeValue(row.area),
    addressHistory: normalizeValue(row.address_history),
    notes: normalizeValue(row.notes),
    lastSourceChannel: normalizeValue(row.last_source_channel),
    lastOrderAt: normalizeValue(row.last_order_at),
    orderCount: Number(row.order_count || 0),
    createdAt: normalizeValue(row.created_at),
    updatedAt: normalizeValue(row.updated_at)
  };
}

export function mapOrder(row) {
  return {
    createdAt: normalizeValue(row.created_at),
    sourceChannel: normalizeValue(row.source_channel),
    customerId: normalizeValue(row.customer_id),
    customerName: normalizeValue(row.customer_name),
    phone: toStringValue(row.phone),
    address: normalizeValue(row.address),
    // { lat, lng, formattedAddress, geocodedAt } — written on approval and by
    // backfillOrderLocations.js. Pass through if the import row has it; UI sets
    // it otherwise.
    deliveryLocation: (row.delivery_location && typeof row.delivery_location === "object")
      ? row.delivery_location
      : null,
    deliveryDate: toDateKey(row.delivery_date),
    deliveryWindow: normalizeValue(row.delivery_window),
    assignedDriverId: normalizeValue(row.assigned_helper_id),
    status: normalizeValue(row.status),
    subtotal: Number(row.subtotal || 0),
    depositTotal: Number(row.deposit_total || 0),
    amountPaid: Number(row.amount_paid || 0),
    balanceDue: Number(row.balance_due || 0),
    paymentStatus: normalizeValue(row.payment_status),
    notes: normalizeValue(row.notes),
    updatedAt: normalizeValue(row.updated_at)
  };
}

export function mapOrderItem(row) {
  return {
    orderId: normalizeValue(row.order_id),
    productId: normalizeValue(row.product_id),
    productName: normalizeValue(row.product_name),
    quantity: Number(row.quantity || 0),
    unitPrice: Number(row.unit_price || 0),
    lineTotal: Number(row.line_total || 0)
  };
}

export function mapProduct(row) {
  return {
    productName: normalizeValue(row.product_name),
    category: normalizeValue(row.category),
    containerType: normalizeValue(row.container_type),
    unitLabel: normalizeValue(row.unit_label),
    unitPrice: Number(row.unit_price || 0),
    defaultDepositAmount: Number(row.default_deposit_amount || 0),
    active: row.active === true || row.active === "TRUE",
    notes: normalizeValue(row.notes)
  };
}

export function mapDriver(row) {
  return {
    driverName: normalizeValue(row.helper_name),
    phone: toStringValue(row.phone),
    active: row.active === true || row.active === "TRUE",
    // Object keyed by product containerType (e.g. { glass_crate: 20,
    // "18_9l_jug": 8, "20l_jug": 6 }). Edited from /settings.html; the route
    // planner treats this as a hard capacity cap.
    standardLoadout: (row.standard_loadout && typeof row.standard_loadout === "object")
      ? row.standard_loadout
      : null,
    notes: normalizeValue(row.notes)
  };
}

export function mapPayment(row) {
  return {
    orderId: normalizeValue(row.order_id),
    customerId: normalizeValue(row.customer_id),
    paymentDate: toDateKey(row.payment_date),
    method: normalizeValue(row.method),
    amount: Number(row.amount || 0),
    reference: normalizeValue(row.reference),
    receivedBy: normalizeValue(row.received_by),
    proofDocumentId: normalizeValue(row.proof_document_id),
    notes: normalizeValue(row.notes)
  };
}

export function mapDepositEvent(row) {
  return {
    orderId: normalizeValue(row.order_id),
    customerId: normalizeValue(row.customer_id),
    containerType: normalizeValue(row.container_type),
    qty: Number(row.qty || 0),
    amount: Number(row.amount || 0),
    eventType: normalizeValue(row.event_type),
    eventDate: toDateKey(row.event_date),
    linkedDocumentId: normalizeValue(row.linked_document_id),
    notes: normalizeValue(row.notes)
  };
}

export function mapReturn(row) {
  return {
    orderId: normalizeValue(row.order_id),
    customerId: normalizeValue(row.customer_id),
    containerType: normalizeValue(row.container_type),
    qty: Number(row.qty || 0),
    returnedAt: toDateKey(row.returned_at),
    condition: normalizeValue(row.condition),
    linkedDepositEventId: normalizeValue(row.linked_deposit_event_id),
    linkedDocumentId: normalizeValue(row.linked_document_id),
    notes: normalizeValue(row.notes)
  };
}

export function mapPurchase(row) {
  return {
    supplierName: normalizeValue(row.supplier_name),
    purchaseDate: toDateKey(row.purchase_date),
    item: normalizeValue(row.item),
    qty: Number(row.qty || 0),
    unitCost: Number(row.unit_cost || 0),
    totalCost: Number(row.total_cost || 0),
    invoiceNumber: normalizeValue(row.invoice_number),
    paymentStatus: normalizeValue(row.payment_status),
    proofDocumentId: normalizeValue(row.proof_document_id),
    notes: normalizeValue(row.notes)
  };
}

export function mapExpense(row) {
  return {
    expenseDate: toDateKey(row.expense_date),
    category: normalizeValue(row.category),
    description: normalizeValue(row.description),
    amount: Number(row.amount || 0),
    paymentMethod: normalizeValue(row.payment_method),
    paidTo: normalizeValue(row.paid_to),
    proofDocumentId: normalizeValue(row.proof_document_id),
    notes: normalizeValue(row.notes)
  };
}

export function mapDocument(row) {
  return {
    entityType: normalizeValue(row.entity_type),
    entityId: normalizeValue(row.entity_id),
    documentType: normalizeValue(row.document_type),
    driveLink: normalizeValue(row.drive_link),
    uploadedAt: normalizeValue(row.uploaded_at),
    notes: normalizeValue(row.notes)
  };
}

export function mapDailySummary(row) {
  return {
    totalOrders: Number(row.total_orders || 0),
    deliveredOrders: Number(row.delivered_orders || 0),
    grossRevenue: Number(row.gross_revenue || 0),
    cashCollected: Number(row.cash_collected || 0),
    transferCollected: Number(row.transfer_collected || 0),
    totalCollected: Number(row.total_collected || 0),
    unpaidBalance: Number(row.unpaid_balance || 0),
    outstandingDeposits: Number(row.outstanding_deposits || 0),
    updatedAt: normalizeValue(row.updated_at)
  };
}

export function mapInquiry(row) {
  return {
    createdAt: normalizeValue(row.created_at),
    customerId: normalizeValue(row.customer_id),
    requestStatus: normalizeValue(row.request_status),
    sourcePage: normalizeValue(row.source_page),
    referrerUrl: normalizeValue(row.referrer_url),
    name: normalizeValue(row.name),
    phone: toStringValue(row.phone),
    email: normalizeValue(row.email),
    address: normalizeValue(row.address),
    deliveryDate: toDateKey(row.delivery_date),
    deliveryTimeSlot: normalizeValue(row.delivery_time_slot),
    glassOrder: normalizeValue(row.glass_order),
    jugOrder: normalizeValue(row.jug_order),
    extras: normalizeValue(row.extras),
    preferredChannel: normalizeValue(row.preferred_channel),
    submissionChannel: normalizeValue(row.submission_channel),
    convertedOrderId: normalizeValue(row.converted_order_id),
    notes: normalizeValue(row.notes)
  };
}

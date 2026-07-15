function getWorkbook_() {
  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) {
    throw new Error('Open the bound spreadsheet before using the workbook.');
  }
  return spreadsheet;
}

function getSheet_(sheetName) {
  var sheet = getWorkbook_().getSheetByName(sheetName);
  if (!sheet) {
    throw new Error('Missing sheet: ' + sheetName + '. Run setupWaterDeliveryWorkbook first.');
  }
  return sheet;
}

function readSheetObjects_(sheetName) {
  var sheet = getSheet_(sheetName);
  var lastRow = sheet.getLastRow();
  var lastColumn = sheet.getLastColumn();
  if (lastRow < 2) {
    return [];
  }

  var values = sheet.getRange(1, 1, lastRow, lastColumn).getValues();
  var headers = values.shift().map(String);
  return values
    .filter(function(row) {
      return row.some(function(cell) { return cell !== ''; });
    })
    .map(function(row, rowIndex) {
      var record = { _rowNumber: rowIndex + 2 };
      headers.forEach(function(header, columnIndex) {
        record[header] = row[columnIndex];
      });
      return record;
    });
}

function appendObjectRow_(sheetName, record) {
  var sheet = getSheet_(sheetName);
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var row = headers.map(function(header) {
    return record[header] !== undefined ? record[header] : '';
  });
  var rowNumber = findFirstEmptyDataRow_(sheet);
  sheet.getRange(rowNumber, 1, 1, headers.length).setValues([row]);
  return rowNumber;
}

function updateObjectRow_(sheetName, rowNumber, record) {
  var sheet = getSheet_(sheetName);
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var row = headers.map(function(header) {
    return record[header] !== undefined ? record[header] : '';
  });
  sheet.getRange(rowNumber, 1, 1, headers.length).setValues([row]);
}

function findFirstEmptyDataRow_(sheet) {
  var lastColumn = Math.max(sheet.getLastColumn(), 1);
  var lastRow = Math.max(sheet.getLastRow(), 1);
  if (lastRow < 2) {
    return 2;
  }

  var values = sheet.getRange(2, 1, lastRow - 1, lastColumn).getValues();
  for (var index = 0; index < values.length; index += 1) {
    var hasContent = values[index].some(function(cell) {
      return cell !== '' && cell !== null;
    });
    if (!hasContent) {
      return index + 2;
    }
  }

  return lastRow + 1;
}

function compactSheetRows_(sheetName) {
  var sheet = getSheet_(sheetName);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return 0;
  }

  var lastColumn = sheet.getLastColumn();
  var values = sheet.getRange(1, 1, lastRow, lastColumn).getValues();
  var headers = values.shift();
  var rows = values.filter(function(row) {
    return row.some(function(cell) {
      return cell !== '' && cell !== null;
    });
  });

  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, lastColumn).clearContent();
  }

  if (rows.length) {
    sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
  }

  return rows.length;
}

function toIsoTimestamp_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm:ss");
}

function normalizeDateInput_(value) {
  if (!value) {
    return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  if (Object.prototype.toString.call(value) === '[object Date]') {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  return String(value).slice(0, 10);
}

function normalizeTimestampValue_(value) {
  if (!value) {
    return '';
  }
  if (Object.prototype.toString.call(value) === '[object Date]') {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm:ss");
  }
  return String(value);
}

function sanitizeText_(value) {
  return String(value || '').trim();
}

function safeNumber_(value) {
  var numeric = Number(value || 0);
  return isNaN(numeric) ? 0 : numeric;
}

function normalizePhone_(value) {
  return sanitizeText_(value).replace(/[^\d+]/g, '');
}

function generateId_(prefix) {
  return prefix + '-' + Utilities.getUuid().slice(0, 8).toUpperCase();
}

function buildOrderSequenceKey_(dateKey) {
  return 'order-seq-' + dateKey;
}

function generateOrderId_(dateKey) {
  var properties = PropertiesService.getScriptProperties();
  var key = buildOrderSequenceKey_(dateKey);
  var nextValue = Number(properties.getProperty(key) || '0') + 1;
  properties.setProperty(key, String(nextValue));
  return 'ORD-' + dateKey.replace(/-/g, '') + '-' + Utilities.formatString('%03d', nextValue);
}

function withScriptLock_(callback) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return callback();
  } finally {
    lock.releaseLock();
  }
}

function getProducts_() {
  return readSheetObjects_(APP_CONFIG.sheetNames.products).filter(function(product) {
    return product.active !== false && product.active !== 'FALSE';
  });
}

function getHelpers_() {
  return readSheetObjects_(APP_CONFIG.sheetNames.helpers).filter(function(helper) {
    return helper.active !== false && helper.active !== 'FALSE';
  });
}

function getCustomers_() {
  return readSheetObjects_(APP_CONFIG.sheetNames.customers);
}

function getOrders_() {
  return readSheetObjects_(APP_CONFIG.sheetNames.orders);
}

function getOrderItems_() {
  return readSheetObjects_(APP_CONFIG.sheetNames.orderItems);
}

function getPayments_() {
  return readSheetObjects_(APP_CONFIG.sheetNames.payments);
}

function getDeposits_() {
  return readSheetObjects_(APP_CONFIG.sheetNames.deposits);
}

function getReturns_() {
  return readSheetObjects_(APP_CONFIG.sheetNames.returns);
}

function getPurchases_() {
  return readSheetObjects_(APP_CONFIG.sheetNames.purchases);
}

function getExpenses_() {
  return readSheetObjects_(APP_CONFIG.sheetNames.expenses);
}

function getDocuments_() {
  return readSheetObjects_(APP_CONFIG.sheetNames.documents);
}

function getInquiries_() {
  return readSheetObjects_(APP_CONFIG.sheetNames.inquiries);
}

function readWorkbookData_(requestedSheets) {
  var selected = requestedSheets || {};
  var useAll = !Object.keys(selected).length;
  var data = {};

  function include(key, loader) {
    if (useAll || selected[key]) {
      data[key] = loader();
    }
  }

  include('customers', getCustomers_);
  include('orders', getOrders_);
  include('orderItems', getOrderItems_);
  include('products', getProducts_);
  include('helpers', getHelpers_);
  include('payments', getPayments_);
  include('deposits', getDeposits_);
  include('returns', getReturns_);
  include('purchases', getPurchases_);
  include('expenses', getExpenses_);
  include('documents', getDocuments_);
  include('dailySummary', function() {
    return readSheetObjects_(APP_CONFIG.sheetNames.dailySummary);
  });
  include('inquiries', getInquiries_);

  return data;
}

function groupRowsBy_(rows, fieldName) {
  return (rows || []).reduce(function(map, row) {
    var key = sanitizeText_(row[fieldName]);
    if (!map[key]) {
      map[key] = [];
    }
    map[key].push(row);
    return map;
  }, {});
}

function indexRowsBy_(rows, fieldName) {
  return (rows || []).reduce(function(map, row) {
    map[sanitizeText_(row[fieldName])] = row;
    return map;
  }, {});
}

function buildDocumentCountMap_(documents, entityType) {
  return (documents || []).reduce(function(map, document) {
    if (entityType && document.entity_type !== entityType) {
      return map;
    }
    var key = sanitizeText_(document.entity_id);
    map[key] = (map[key] || 0) + 1;
    return map;
  }, {});
}

function buildOutstandingDepositsByCustomer_(deposits, cutoffDate) {
  return (deposits || []).reduce(function(map, event) {
    if (cutoffDate && normalizeDateInput_(event.event_date) > cutoffDate) {
      return map;
    }
    var customerId = sanitizeText_(event.customer_id);
    if (!customerId) {
      return map;
    }
    if (!map[customerId]) {
      map[customerId] = 0;
    }
    if (event.event_type === 'charged') {
      map[customerId] += safeNumber_(event.amount);
    } else if (event.event_type === 'refunded' || event.event_type === 'credited') {
      map[customerId] -= safeNumber_(event.amount);
    }
    return map;
  }, {});
}

function getEnrichedOrdersFromData_(data, dateKey, options) {
  var orders = data.orders || [];
  var orderItemsByOrderId = groupRowsBy_(data.orderItems || [], 'order_id');
  var helperMap = indexRowsBy_(data.helpers || [], 'helper_id');
  var documentCountByOrderId = buildDocumentCountMap_(data.documents || [], 'order');
  var includeDocumentCounts = !options || options.includeDocumentCounts !== false;

  return orders
    .filter(function(order) {
      return !dateKey || normalizeDateInput_(order.delivery_date) === dateKey;
    })
    .map(function(order) {
      var orderItems = orderItemsByOrderId[order.order_id] || [];
      return {
        orderId: order.order_id,
        createdAt: normalizeTimestampValue_(order.created_at),
        sourceChannel: order.source_channel,
        customerId: order.customer_id,
        customerName: order.customer_name,
        phone: order.phone,
        address: order.address,
        deliveryDate: normalizeDateInput_(order.delivery_date),
        deliveryWindow: order.delivery_window,
        assignedHelperId: order.assigned_helper_id,
        assignedHelperName: helperMap[order.assigned_helper_id] ? helperMap[order.assigned_helper_id].helper_name : '',
        status: order.status,
        subtotal: safeNumber_(order.subtotal),
        depositTotal: safeNumber_(order.deposit_total),
        amountPaid: safeNumber_(order.amount_paid),
        balanceDue: safeNumber_(order.balance_due),
        paymentStatus: order.payment_status,
        notes: order.notes,
        documentCount: includeDocumentCounts ? (documentCountByOrderId[order.order_id] || 0) : 0,
        items: orderItems.map(function(item) {
          return {
            orderItemId: item.order_item_id,
            productId: item.product_id,
            productName: item.product_name,
            quantity: safeNumber_(item.quantity),
            unitPrice: safeNumber_(item.unit_price),
            lineTotal: safeNumber_(item.line_total)
          };
        })
      };
    })
    .sort(function(a, b) {
      return String(b.createdAt).localeCompare(String(a.createdAt));
    });
}

function getCustomerAuditProfilesFromData_(data) {
  var customers = data.customers || [];
  var ordersByCustomerId = groupRowsBy_(data.orders || [], 'customer_id');
  var outstandingDepositsByCustomer = buildOutstandingDepositsByCustomer_(data.deposits || []);

  return customers.map(function(customer) {
    var customerOrders = ordersByCustomerId[customer.customer_id] || [];
    return {
      customerId: customer.customer_id,
      name: customer.name,
      phone: customer.phone,
      address: customer.address,
      area: customer.area,
      addressHistory: customer.address_history,
      preferredSource: customer.last_source_channel,
      taxId: customer.tax_id,
      notes: customer.notes,
      orderCount: customerOrders.length,
      outstandingBalance: customerOrders.reduce(function(sum, order) { return sum + safeNumber_(order.balance_due); }, 0),
      outstandingDeposits: outstandingDepositsByCustomer[customer.customer_id] || 0,
      lastOrderAt: customer.last_order_at
    };
  }).sort(function(a, b) {
    return (b.outstandingBalance + b.outstandingDeposits) - (a.outstandingBalance + a.outstandingDeposits);
  });
}

function buildDailySummaryFromData_(data, dateKey) {
  var summaryDate = normalizeDateInput_(dateKey);
  var orders = (data.orders || []).filter(function(order) {
    return normalizeDateInput_(order.delivery_date) === summaryDate;
  });
  var payments = (data.payments || []).filter(function(payment) {
    return normalizeDateInput_(payment.payment_date) === summaryDate;
  });
  var outstandingDeposits = (data.deposits || []).reduce(function(sum, event) {
    if (normalizeDateInput_(event.event_date) > summaryDate) {
      return sum;
    }
    if (event.event_type === 'charged') {
      return sum + safeNumber_(event.amount);
    }
    if (event.event_type === 'refunded' || event.event_type === 'credited') {
      return sum - safeNumber_(event.amount);
    }
    return sum;
  }, 0);

  return {
    summary_date: summaryDate,
    total_orders: orders.length,
    delivered_orders: orders.filter(function(order) { return order.status === 'delivered'; }).length,
    gross_revenue: orders.reduce(function(sum, order) { return sum + safeNumber_(order.subtotal); }, 0),
    cash_collected: payments.filter(function(payment) { return payment.method === 'cash'; }).reduce(function(sum, payment) { return sum + safeNumber_(payment.amount); }, 0),
    transfer_collected: payments.filter(function(payment) { return payment.method !== 'cash'; }).reduce(function(sum, payment) { return sum + safeNumber_(payment.amount); }, 0),
    total_collected: payments.reduce(function(sum, payment) { return sum + safeNumber_(payment.amount); }, 0),
    unpaid_balance: orders.reduce(function(sum, order) { return sum + safeNumber_(order.balance_due); }, 0),
    outstanding_deposits: outstandingDeposits,
    updated_at: toIsoTimestamp_()
  };
}

function buildOwnerDashboardSummary_(enrichedOrders, effectiveDate) {
  var orders = enrichedOrders || [];
  return {
    summary_date: normalizeDateInput_(effectiveDate),
    total_orders: orders.length,
    delivered_orders: orders.filter(function(order) { return order.status === 'delivered'; }).length,
    gross_revenue: orders.reduce(function(sum, order) { return sum + safeNumber_(order.subtotal); }, 0),
    cash_collected: 0,
    transfer_collected: 0,
    total_collected: orders.reduce(function(sum, order) { return sum + safeNumber_(order.amountPaid); }, 0),
    unpaid_balance: orders.reduce(function(sum, order) { return sum + safeNumber_(order.balanceDue); }, 0),
    outstanding_deposits: orders.reduce(function(sum, order) { return sum + safeNumber_(order.depositTotal); }, 0),
    updated_at: toIsoTimestamp_()
  };
}

function syncDailySummaryForDateFromData_(data, dateKey) {
  var summary = buildDailySummaryFromData_(data, dateKey);
  var existing = (data.dailySummary || []).find(function(row) {
    return normalizeDateInput_(row.summary_date) === summary.summary_date;
  });

  if (existing) {
    updateObjectRow_(APP_CONFIG.sheetNames.dailySummary, existing._rowNumber, summary);
  } else {
    appendObjectRow_(APP_CONFIG.sheetNames.dailySummary, summary);
  }
  return summary;
}

function getAuditSnapshotFromData_(data, dateKey) {
  var effectiveDate = normalizeDateInput_(dateKey);
  var enrichedOrders = getEnrichedOrdersFromData_(data, '', { includeDocumentCounts: false });
  var customers = getCustomerAuditProfilesFromData_(data).slice(0, 20);
  var payments = data.payments || [];
  var deposits = data.deposits || [];
  var purchases = data.purchases || [];
  var expenses = data.expenses || [];
  var orders = data.orders || [];

  return {
    summary: {
      totalSales: orders.reduce(function(sum, order) { return sum + safeNumber_(order.subtotal); }, 0),
      totalCollectedCash: payments.filter(function(payment) { return payment.method === 'cash'; }).reduce(function(sum, payment) { return sum + safeNumber_(payment.amount); }, 0),
      totalCollectedTransfer: payments.filter(function(payment) { return payment.method !== 'cash'; }).reduce(function(sum, payment) { return sum + safeNumber_(payment.amount); }, 0),
      unpaidBalances: orders.reduce(function(sum, order) { return sum + safeNumber_(order.balance_due); }, 0),
      outstandingDeposits: deposits.reduce(function(sum, event) {
        if (event.event_type === 'charged') {
          return sum + safeNumber_(event.amount);
        }
        if (event.event_type === 'refunded' || event.event_type === 'credited') {
          return sum - safeNumber_(event.amount);
        }
        return sum;
      }, 0),
      totalPurchases: purchases.reduce(function(sum, purchase) { return sum + safeNumber_(purchase.total_cost); }, 0),
      totalExpenses: expenses.reduce(function(sum, expense) { return sum + safeNumber_(expense.amount); }, 0),
      selectedDate: effectiveDate
    },
    recentPayments: payments.slice().sort(function(a, b) {
      return String(b.payment_date).localeCompare(String(a.payment_date));
    }).slice(0, 20),
    recentDeposits: deposits.slice().sort(function(a, b) {
      return String(b.event_date).localeCompare(String(a.event_date));
    }).slice(0, 20),
    recentReturns: (data.returns || []).slice().sort(function(a, b) {
      return String(b.returned_at).localeCompare(String(a.returned_at));
    }).slice(0, 20),
    recentPurchases: purchases.slice().sort(function(a, b) {
      return String(b.purchase_date).localeCompare(String(a.purchase_date));
    }).slice(0, 20),
    recentExpenses: expenses.slice().sort(function(a, b) {
      return String(b.expense_date).localeCompare(String(a.expense_date));
    }).slice(0, 20),
    recentDocuments: (data.documents || []).slice().sort(function(a, b) {
      return String(b.uploaded_at).localeCompare(String(a.uploaded_at));
    }).slice(0, 20),
    unpaidOrders: enrichedOrders.filter(function(order) {
      return order.balanceDue > 0;
    }).slice(0, 20),
    customerBalances: customers,
    purchasePeriodTotals: buildPeriodTotals_(purchases, 'purchase_date', 'total_cost').slice(0, 6),
    expensePeriodTotals: buildPeriodTotals_(expenses, 'expense_date', 'amount').slice(0, 6)
  };
}

function findCustomerByPhone_(phone) {
  var normalized = normalizePhone_(phone);
  if (!normalized) {
    return null;
  }

  return getCustomers_().find(function(customer) {
    return normalizePhone_(customer.phone) === normalized || normalizePhone_(customer.secondary_phone) === normalized;
  }) || null;
}

function appendAddressHistory_(existingHistory, address) {
  var nextAddress = sanitizeText_(address);
  var history = sanitizeText_(existingHistory);
  if (!nextAddress) {
    return history;
  }

  var parts = history ? history.split(' | ') : [];
  if (parts.indexOf(nextAddress) === -1) {
    parts.push(nextAddress);
  }
  return parts.join(' | ');
}

function upsertCustomer_(payload) {
  var existing = findCustomerByPhone_(payload.phone);
  var now = toIsoTimestamp_();

  if (existing) {
    existing.name = sanitizeText_(payload.customerName) || existing.name;
    existing.billing_name = sanitizeText_(payload.billingName) || existing.billing_name || existing.name;
    existing.phone = normalizePhone_(payload.phone) || existing.phone;
    existing.tax_id = sanitizeText_(payload.taxId) || existing.tax_id;
    existing.address = sanitizeText_(payload.address) || existing.address;
    existing.area = sanitizeText_(payload.area) || existing.area;
    existing.address_history = appendAddressHistory_(existing.address_history, payload.address);
    existing.notes = sanitizeText_(payload.notes) || existing.notes;
    existing.last_source_channel = sanitizeText_(payload.sourceChannel) || existing.last_source_channel;
    existing.last_order_at = now;
    existing.order_count = safeNumber_(existing.order_count) + 1;
    existing.updated_at = now;
    updateObjectRow_(APP_CONFIG.sheetNames.customers, existing._rowNumber, existing);
    return existing;
  }

  var customer = {
    customer_id: generateId_('CUS'),
    name: sanitizeText_(payload.customerName),
    billing_name: sanitizeText_(payload.billingName) || sanitizeText_(payload.customerName),
    phone: normalizePhone_(payload.phone),
    secondary_phone: '',
    tax_id: sanitizeText_(payload.taxId),
    address: sanitizeText_(payload.address),
    area: sanitizeText_(payload.area),
    address_history: appendAddressHistory_('', payload.address),
    notes: sanitizeText_(payload.notes),
    last_source_channel: sanitizeText_(payload.sourceChannel),
    last_order_at: now,
    order_count: 1,
    created_at: now,
    updated_at: now
  };
  appendObjectRow_(APP_CONFIG.sheetNames.customers, customer);
  return customer;
}

function findProductById_(productId) {
  return getProducts_().find(function(product) {
    return product.product_id === productId;
  }) || null;
}

function buildOrderRecord_(payload, customer, orderId) {
  var items = Array.isArray(payload.items) ? payload.items : [];
  var subtotal = items.reduce(function(sum, item) {
    return sum + (safeNumber_(item.quantity) * safeNumber_(item.unitPrice));
  }, 0);
  var now = toIsoTimestamp_();

  return {
    order_id: orderId,
    created_at: now,
    source_channel: sanitizeText_(payload.sourceChannel) || 'whatsapp',
    customer_id: customer.customer_id,
    customer_name: customer.name,
    phone: customer.phone,
    address: sanitizeText_(payload.address),
    delivery_date: normalizeDateInput_(payload.deliveryDate),
    delivery_window: sanitizeText_(payload.deliveryWindow),
    assigned_helper_id: sanitizeText_(payload.assignedHelperId),
    status: sanitizeText_(payload.status) || 'new',
    subtotal: subtotal,
    deposit_total: 0,
    amount_paid: 0,
    balance_due: subtotal,
    payment_status: 'unpaid',
    notes: sanitizeText_(payload.notes),
    updated_at: now
  };
}

function replaceOrderItems_(orderId, items) {
  var sheet = getSheet_(APP_CONFIG.sheetNames.orderItems);
  readSheetObjects_(APP_CONFIG.sheetNames.orderItems)
    .filter(function(row) { return row.order_id === orderId; })
    .sort(function(a, b) { return b._rowNumber - a._rowNumber; })
    .forEach(function(row) {
      sheet.deleteRow(row._rowNumber);
    });

  items.forEach(function(item) {
    var product = findProductById_(item.productId);
    var quantity = safeNumber_(item.quantity);
    var unitPrice = safeNumber_(item.unitPrice || (product ? product.unit_price : 0));
    appendObjectRow_(APP_CONFIG.sheetNames.orderItems, {
      order_item_id: generateId_('ITEM'),
      order_id: orderId,
      product_id: sanitizeText_(item.productId),
      product_name: product ? product.product_name : sanitizeText_(item.productName),
      quantity: quantity,
      unit_price: unitPrice,
      line_total: quantity * unitPrice
    });
  });
}

function createDocumentRecord_(payload) {
  var driveLink = sanitizeText_(payload && payload.driveLink);
  if (!driveLink) {
    return null;
  }

  var document = {
    document_id: generateId_('DOC'),
    entity_type: sanitizeText_(payload.entityType),
    entity_id: sanitizeText_(payload.entityId),
    document_type: sanitizeText_(payload.documentType) || 'other',
    drive_link: driveLink,
    uploaded_at: toIsoTimestamp_(),
    notes: sanitizeText_(payload.notes)
  };
  appendObjectRow_(APP_CONFIG.sheetNames.documents, document);
  return document;
}

function recordPayment_(payload) {
  var amount = safeNumber_(payload.amount);
  if (amount <= 0) {
    return null;
  }

  var document = createDocumentRecord_({
    entityType: 'payment',
    entityId: payload.paymentId || '',
    documentType: 'payment_proof',
    driveLink: payload.proofLink,
    notes: payload.notes
  });

  var payment = {
    payment_id: payload.paymentId || generateId_('PAY'),
    order_id: sanitizeText_(payload.orderId),
    customer_id: sanitizeText_(payload.customerId),
    payment_date: normalizeDateInput_(payload.paymentDate),
    method: sanitizeText_(payload.method) || 'cash',
    amount: amount,
    reference: sanitizeText_(payload.reference),
    received_by: sanitizeText_(payload.receivedBy),
    proof_document_id: document ? document.document_id : '',
    notes: sanitizeText_(payload.notes)
  };

  appendObjectRow_(APP_CONFIG.sheetNames.payments, payment);
  if (document) {
    document.entity_id = payment.payment_id;
    updateDocumentEntity_(document.document_id, payment.payment_id);
  }
  return payment;
}

function recordDepositEvent_(payload) {
  var amount = safeNumber_(payload.amount);
  var qty = safeNumber_(payload.qty);
  if (amount <= 0 && qty <= 0) {
    return null;
  }

  var document = createDocumentRecord_({
    entityType: 'deposit',
    entityId: payload.depositEventId || '',
    documentType: payload.documentType || 'other',
    driveLink: payload.proofLink,
    notes: payload.notes
  });

  var event = {
    deposit_event_id: payload.depositEventId || generateId_('DEP'),
    order_id: sanitizeText_(payload.orderId),
    customer_id: sanitizeText_(payload.customerId),
    container_type: sanitizeText_(payload.containerType),
    qty: qty,
    amount: amount,
    event_type: sanitizeText_(payload.eventType) || 'charged',
    event_date: normalizeDateInput_(payload.eventDate),
    linked_document_id: document ? document.document_id : '',
    notes: sanitizeText_(payload.notes)
  };

  appendObjectRow_(APP_CONFIG.sheetNames.deposits, event);
  if (document) {
    updateDocumentEntity_(document.document_id, event.deposit_event_id);
  }
  return event;
}

function recordReturn_(payload) {
  var qty = safeNumber_(payload.qty);
  if (qty <= 0) {
    return null;
  }

  var document = createDocumentRecord_({
    entityType: 'return',
    entityId: payload.returnId || '',
    documentType: payload.documentType || 'other',
    driveLink: payload.proofLink,
    notes: payload.notes
  });

  var row = {
    return_id: payload.returnId || generateId_('RET'),
    order_id: sanitizeText_(payload.orderId),
    customer_id: sanitizeText_(payload.customerId),
    container_type: sanitizeText_(payload.containerType),
    qty: qty,
    returned_at: normalizeDateInput_(payload.returnedAt),
    condition: sanitizeText_(payload.condition) || 'good',
    linked_deposit_event_id: sanitizeText_(payload.linkedDepositEventId),
    linked_document_id: document ? document.document_id : '',
    notes: sanitizeText_(payload.notes)
  };

  appendObjectRow_(APP_CONFIG.sheetNames.returns, row);
  if (document) {
    updateDocumentEntity_(document.document_id, row.return_id);
  }
  return row;
}

function recordPurchase_(payload) {
  var qty = safeNumber_(payload.qty);
  var unitCost = safeNumber_(payload.unitCost);
  var totalCost = safeNumber_(payload.totalCost || (qty * unitCost));
  var document = createDocumentRecord_({
    entityType: 'purchase',
    entityId: payload.purchaseId || '',
    documentType: 'purchase_invoice',
    driveLink: payload.proofLink,
    notes: payload.notes
  });

  var purchase = {
    purchase_id: payload.purchaseId || generateId_('PUR'),
    supplier_name: sanitizeText_(payload.supplierName),
    purchase_date: normalizeDateInput_(payload.purchaseDate),
    item: sanitizeText_(payload.item),
    qty: qty,
    unit_cost: unitCost,
    total_cost: totalCost,
    invoice_number: sanitizeText_(payload.invoiceNumber),
    payment_status: sanitizeText_(payload.paymentStatus) || 'unpaid',
    proof_document_id: document ? document.document_id : '',
    notes: sanitizeText_(payload.notes)
  };

  appendObjectRow_(APP_CONFIG.sheetNames.purchases, purchase);
  if (document) {
    updateDocumentEntity_(document.document_id, purchase.purchase_id);
  }
  return purchase;
}

function recordExpense_(payload) {
  var amount = safeNumber_(payload.amount);
  if (amount <= 0) {
    return null;
  }

  var document = createDocumentRecord_({
    entityType: 'expense',
    entityId: payload.expenseId || '',
    documentType: 'expense_receipt',
    driveLink: payload.proofLink,
    notes: payload.notes
  });

  var expense = {
    expense_id: payload.expenseId || generateId_('EXP'),
    expense_date: normalizeDateInput_(payload.expenseDate),
    category: sanitizeText_(payload.category) || 'other',
    description: sanitizeText_(payload.description),
    amount: amount,
    payment_method: sanitizeText_(payload.paymentMethod) || 'cash',
    paid_to: sanitizeText_(payload.paidTo),
    proof_document_id: document ? document.document_id : '',
    notes: sanitizeText_(payload.notes)
  };

  appendObjectRow_(APP_CONFIG.sheetNames.expenses, expense);
  if (document) {
    updateDocumentEntity_(document.document_id, expense.expense_id);
  }
  return expense;
}

function updateDocumentEntity_(documentId, entityId) {
  var documents = getDocuments_();
  var document = documents.find(function(item) {
    return item.document_id === documentId;
  });
  if (!document) {
    return;
  }
  document.entity_id = entityId;
  updateObjectRow_(APP_CONFIG.sheetNames.documents, document._rowNumber, document);
}

function sumPaymentsForOrder_(orderId) {
  return getPayments_()
    .filter(function(payment) { return payment.order_id === orderId; })
    .reduce(function(sum, payment) {
      return sum + safeNumber_(payment.amount);
    }, 0);
}

function sumDepositChargesForOrder_(orderId) {
  return getDeposits_()
    .filter(function(event) { return event.order_id === orderId && event.event_type === 'charged'; })
    .reduce(function(sum, event) {
      return sum + safeNumber_(event.amount);
    }, 0);
}

function getCustomerOutstandingDeposit_(customerId, cutoffDate) {
  return getDeposits_()
    .filter(function(event) {
      return event.customer_id === customerId && (!cutoffDate || normalizeDateInput_(event.event_date) <= cutoffDate);
    })
    .reduce(function(sum, event) {
      if (event.event_type === 'charged') {
        return sum + safeNumber_(event.amount);
      }
      if (event.event_type === 'refunded' || event.event_type === 'credited') {
        return sum - safeNumber_(event.amount);
      }
      return sum;
    }, 0);
}

function computeOrderPaymentStatus_(totalDue, amountPaid) {
  if (amountPaid <= 0) {
    return 'unpaid';
  }
  if (amountPaid + 0.0001 < totalDue) {
    return 'partial';
  }
  return 'paid';
}

function recomputeOrderFinancials_(orderId) {
  var orders = getOrders_();
  var order = orders.find(function(row) {
    return row.order_id === orderId;
  });
  if (!order) {
    return null;
  }

  var depositTotal = sumDepositChargesForOrder_(orderId);
  var amountPaid = sumPaymentsForOrder_(orderId);
  var subtotal = safeNumber_(order.subtotal);
  var totalDue = subtotal + depositTotal;

  order.deposit_total = depositTotal;
  order.amount_paid = amountPaid;
  order.balance_due = totalDue - amountPaid;
  order.payment_status = computeOrderPaymentStatus_(totalDue, amountPaid);
  order.updated_at = toIsoTimestamp_();
  updateObjectRow_(APP_CONFIG.sheetNames.orders, order._rowNumber, order);
  return order;
}

function syncDailySummaryForDate_(dateKey) {
  var summaryDate = normalizeDateInput_(dateKey);
  var orders = getOrders_().filter(function(order) {
    return normalizeDateInput_(order.delivery_date) === summaryDate;
  });
  var payments = getPayments_().filter(function(payment) {
    return normalizeDateInput_(payment.payment_date) === summaryDate;
  });

  var summary = {
    summary_date: summaryDate,
    total_orders: orders.length,
    delivered_orders: orders.filter(function(order) { return order.status === 'delivered'; }).length,
    gross_revenue: orders.reduce(function(sum, order) { return sum + safeNumber_(order.subtotal); }, 0),
    cash_collected: payments.filter(function(payment) { return payment.method === 'cash'; }).reduce(function(sum, payment) { return sum + safeNumber_(payment.amount); }, 0),
    transfer_collected: payments.filter(function(payment) { return payment.method !== 'cash'; }).reduce(function(sum, payment) { return sum + safeNumber_(payment.amount); }, 0),
    total_collected: payments.reduce(function(sum, payment) { return sum + safeNumber_(payment.amount); }, 0),
    unpaid_balance: orders.reduce(function(sum, order) { return sum + safeNumber_(order.balance_due); }, 0),
    outstanding_deposits: getDeposits_().filter(function(event) {
      return normalizeDateInput_(event.event_date) <= summaryDate;
    }).reduce(function(sum, event) {
      if (event.event_type === 'charged') {
        return sum + safeNumber_(event.amount);
      }
      if (event.event_type === 'refunded' || event.event_type === 'credited') {
        return sum - safeNumber_(event.amount);
      }
      return sum;
    }, 0),
    updated_at: toIsoTimestamp_()
  };

  var existing = readSheetObjects_(APP_CONFIG.sheetNames.dailySummary).find(function(row) {
    return normalizeDateInput_(row.summary_date) === summaryDate;
  });

  if (existing) {
    updateObjectRow_(APP_CONFIG.sheetNames.dailySummary, existing._rowNumber, summary);
  } else {
    appendObjectRow_(APP_CONFIG.sheetNames.dailySummary, summary);
  }
  return summary;
}

function getCustomerAuditProfiles_() {
  var customers = getCustomers_();
  var orders = getOrders_();
  return customers.map(function(customer) {
    var customerOrders = orders.filter(function(order) {
      return order.customer_id === customer.customer_id;
    });
    return {
      customerId: customer.customer_id,
      name: customer.name,
      phone: customer.phone,
      address: customer.address,
      area: customer.area,
      addressHistory: customer.address_history,
      preferredSource: customer.last_source_channel,
      taxId: customer.tax_id,
      notes: customer.notes,
      orderCount: customerOrders.length,
      outstandingBalance: customerOrders.reduce(function(sum, order) { return sum + safeNumber_(order.balance_due); }, 0),
      outstandingDeposits: getCustomerOutstandingDeposit_(customer.customer_id),
      lastOrderAt: customer.last_order_at
    };
  }).sort(function(a, b) {
    return (b.outstandingBalance + b.outstandingDeposits) - (a.outstandingBalance + a.outstandingDeposits);
  });
}

function getEntityDocumentCount_(entityType, entityId) {
  return getDocuments_().filter(function(document) {
    return document.entity_type === entityType && document.entity_id === entityId;
  }).length;
}

function getEnrichedOrders_(dateKey) {
  var orders = getOrders_();
  var items = getOrderItems_();
  var helpers = getHelpers_();
  var helperMap = {};
  helpers.forEach(function(helper) {
    helperMap[helper.helper_id] = helper;
  });

  return orders
    .filter(function(order) {
      return !dateKey || normalizeDateInput_(order.delivery_date) === dateKey;
    })
    .map(function(order) {
      var orderItems = items.filter(function(item) { return item.order_id === order.order_id; });
      return {
        orderId: order.order_id,
        createdAt: normalizeTimestampValue_(order.created_at),
        sourceChannel: order.source_channel,
        customerId: order.customer_id,
        customerName: order.customer_name,
        phone: order.phone,
        address: order.address,
        deliveryDate: normalizeDateInput_(order.delivery_date),
        deliveryWindow: order.delivery_window,
        assignedHelperId: order.assigned_helper_id,
        assignedHelperName: helperMap[order.assigned_helper_id] ? helperMap[order.assigned_helper_id].helper_name : '',
        status: order.status,
        subtotal: safeNumber_(order.subtotal),
        depositTotal: safeNumber_(order.deposit_total),
        amountPaid: safeNumber_(order.amount_paid),
        balanceDue: safeNumber_(order.balance_due),
        paymentStatus: order.payment_status,
        notes: order.notes,
        documentCount: getEntityDocumentCount_('order', order.order_id),
        items: orderItems.map(function(item) {
          return {
            orderItemId: item.order_item_id,
            productId: item.product_id,
            productName: item.product_name,
            quantity: safeNumber_(item.quantity),
            unitPrice: safeNumber_(item.unit_price),
            lineTotal: safeNumber_(item.line_total)
          };
        })
      };
    })
    .sort(function(a, b) {
      return String(b.createdAt).localeCompare(String(a.createdAt));
    });
}

function buildPeriodTotals_(rows, dateField, amountField) {
  var periods = {};
  rows.forEach(function(row) {
    var dateValue = normalizeDateInput_(row[dateField]);
    var periodKey = dateValue.slice(0, 7);
    periods[periodKey] = (periods[periodKey] || 0) + safeNumber_(row[amountField]);
  });

  return Object.keys(periods).sort().reverse().map(function(periodKey) {
    return {
      period: periodKey,
      total: periods[periodKey]
    };
  });
}

function getAuditSnapshot_(dateKey) {
  var effectiveDate = normalizeDateInput_(dateKey);
  var recentPayments = getPayments_().sort(function(a, b) {
    return String(b.payment_date).localeCompare(String(a.payment_date));
  }).slice(0, 20);
  var recentDeposits = getDeposits_().sort(function(a, b) {
    return String(b.event_date).localeCompare(String(a.event_date));
  }).slice(0, 20);
  var recentReturns = getReturns_().sort(function(a, b) {
    return String(b.returned_at).localeCompare(String(a.returned_at));
  }).slice(0, 20);
  var recentPurchases = getPurchases_().sort(function(a, b) {
    return String(b.purchase_date).localeCompare(String(a.purchase_date));
  }).slice(0, 20);
  var recentExpenses = getExpenses_().sort(function(a, b) {
    return String(b.expense_date).localeCompare(String(a.expense_date));
  }).slice(0, 20);
  var recentDocuments = getDocuments_().sort(function(a, b) {
    return String(b.uploaded_at).localeCompare(String(a.uploaded_at));
  }).slice(0, 20);
  var unpaidOrders = getEnrichedOrders_().filter(function(order) {
    return order.balanceDue > 0;
  }).slice(0, 20);
  var customers = getCustomerAuditProfiles_().slice(0, 20);
  var purchasePeriodTotals = buildPeriodTotals_(getPurchases_(), 'purchase_date', 'total_cost');
  var expensePeriodTotals = buildPeriodTotals_(getExpenses_(), 'expense_date', 'amount');
  var payments = getPayments_();
  var deposits = getDeposits_();
  var summary = {
    totalSales: getOrders_().reduce(function(sum, order) { return sum + safeNumber_(order.subtotal); }, 0),
    totalCollectedCash: payments.filter(function(payment) { return payment.method === 'cash'; }).reduce(function(sum, payment) { return sum + safeNumber_(payment.amount); }, 0),
    totalCollectedTransfer: payments.filter(function(payment) { return payment.method !== 'cash'; }).reduce(function(sum, payment) { return sum + safeNumber_(payment.amount); }, 0),
    unpaidBalances: getOrders_().reduce(function(sum, order) { return sum + safeNumber_(order.balance_due); }, 0),
    outstandingDeposits: deposits.reduce(function(sum, event) {
      if (event.event_type === 'charged') {
        return sum + safeNumber_(event.amount);
      }
      if (event.event_type === 'refunded' || event.event_type === 'credited') {
        return sum - safeNumber_(event.amount);
      }
      return sum;
    }, 0),
    totalPurchases: getPurchases_().reduce(function(sum, purchase) { return sum + safeNumber_(purchase.total_cost); }, 0),
    totalExpenses: getExpenses_().reduce(function(sum, expense) { return sum + safeNumber_(expense.amount); }, 0),
    selectedDate: effectiveDate
  };

  return {
    summary: summary,
    recentPayments: recentPayments,
    recentDeposits: recentDeposits,
    recentReturns: recentReturns,
    recentPurchases: recentPurchases,
    recentExpenses: recentExpenses,
    recentDocuments: recentDocuments,
    unpaidOrders: unpaidOrders,
    customerBalances: customers,
    purchasePeriodTotals: purchasePeriodTotals.slice(0, 6),
    expensePeriodTotals: expensePeriodTotals.slice(0, 6)
  };
}

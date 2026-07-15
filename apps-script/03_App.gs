function doGet(e) {
  var params = e && e.parameter ? e.parameter : {};
  var action = params.action || '';
  var view = params.view || 'public';
  var publicConfig = JSON.stringify(getPublicConfig()).replace(/</g, '\\u003c');

  if (action === 'populate_test_orders') {
    return jsonResponse_({
      ok: true,
      result: populateOrdersSheetOnly()
    });
  }

  if (action === 'export_workbook_json') {
    return jsonResponse_(createWorkbookExportFile());
  }

  if (view === 'admin') {
    var initialAdminData = JSON.stringify(buildInitialAdminData_()).replace(/</g, '\\u003c');
    return renderTemplate_('Admin', {
      appConfig: publicConfig,
      initialAdminData: initialAdminData
    }).setTitle(APP_CONFIG.businessName + ' Admin');
  }

  return renderTemplate_('Public', {
    appConfig: publicConfig
  }).setTitle(APP_CONFIG.businessName);
}

function buildInitialAdminData_() {
  try {
    var bootstrap = getAdminCatalogBootstrap();
    var board = getTodayBoardMobile(normalizeDateInput_(new Date()));
    return {
      bootstrap: bootstrap,
      board: board
    };
  } catch (error) {
    return {
      bootstrap: {
        ok: false,
        error: error && error.message ? error.message : String(error),
        config: getPublicConfig(),
        products: [],
        helpers: []
      },
      board: {
        ok: false,
        error: error && error.message ? error.message : String(error),
        effectiveDate: normalizeDateInput_(new Date()),
        orders: [],
        totals: buildOwnerDashboardSummary_([], normalizeDateInput_(new Date()))
      }
    };
  }
}

function doPost(e) {
  try {
    var payload = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (payload.action === 'seed_test_data') {
      return jsonResponse_({
        ok: true,
        result: seedTestDataForOwner_()
      });
    }
    return jsonResponse_({
      ok: false,
      error: 'Unsupported action.'
    });
  } catch (error) {
    return jsonResponse_({
      ok: false,
      error: error && error.message ? error.message : String(error)
    });
  }
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

function jsonResponse_(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function renderTemplate_(filename, templateData) {
  var template = HtmlService.createTemplateFromFile(filename);
  Object.keys(templateData || {}).forEach(function(key) {
    template[key] = templateData[key];
  });
  return template
    .evaluate()
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function getAdminBootstrap(dateKey) {
  try {
    ensureWorkbookReady_();
    var effectiveDate = normalizeDateInput_(dateKey);
    var data = readWorkbookData_({
      orders: true,
      orderItems: true,
      products: true,
      helpers: true
    });
    var orders = getEnrichedOrdersFromData_(data, effectiveDate, { includeDocumentCounts: false });
    return {
      ok: true,
      config: getPublicConfig(),
      effectiveDate: effectiveDate,
      products: (data.products || []).map(function(product) {
        return {
          productId: product.product_id,
          productName: product.product_name,
          category: product.category,
          containerType: product.container_type,
          unitLabel: product.unit_label,
          unitPrice: safeNumber_(product.unit_price),
          defaultDepositAmount: safeNumber_(product.default_deposit_amount),
          active: product.active !== false && product.active !== 'FALSE',
          notes: product.notes
        };
      }),
      helpers: (data.helpers || []).map(function(helper) {
        return {
          helperId: helper.helper_id,
          helperName: helper.helper_name,
          phone: helper.phone,
          active: helper.active !== false && helper.active !== 'FALSE'
        };
      }),
      orders: orders,
      totals: buildOwnerDashboardSummary_(orders, effectiveDate)
    };
  } catch (error) {
    return {
      ok: false,
      error: error && error.message ? error.message : String(error),
      config: getPublicConfig(),
      effectiveDate: normalizeDateInput_(dateKey),
      products: [],
      helpers: [],
      orders: [],
      totals: buildOwnerDashboardSummary_([], normalizeDateInput_(dateKey))
    };
  }
}

function getAdminCatalogBootstrap() {
  try {
    ensureWorkbookReady_();
    var data = readWorkbookData_({
      products: true,
      helpers: true
    });
    return {
      ok: true,
      config: getPublicConfig(),
      products: (data.products || []).map(function(product) {
        return {
          productId: product.product_id,
          productName: product.product_name,
          category: product.category,
          containerType: product.container_type,
          unitLabel: product.unit_label,
          unitPrice: safeNumber_(product.unit_price),
          defaultDepositAmount: safeNumber_(product.default_deposit_amount),
          active: product.active !== false && product.active !== 'FALSE',
          notes: product.notes
        };
      }),
      helpers: (data.helpers || []).map(function(helper) {
        return {
          helperId: helper.helper_id,
          helperName: helper.helper_name,
          phone: helper.phone,
          active: helper.active !== false && helper.active !== 'FALSE'
        };
      })
    };
  } catch (error) {
    return {
      ok: false,
      error: error && error.message ? error.message : String(error),
      config: getPublicConfig(),
      products: [],
      helpers: []
    };
  }
}

function getTodayBoardMobile(dateKey) {
  try {
    ensureWorkbookReady_();
    var effectiveDate = normalizeDateInput_(dateKey);
    var data = {
      orders: getOrders_(),
      orderItems: getOrderItems_(),
      helpers: getHelpers_(),
      documents: []
    };
    var orders = getEnrichedOrdersFromData_(data, effectiveDate, { includeDocumentCounts: false });
    return {
      ok: true,
      effectiveDate: effectiveDate,
      orders: orders,
      totals: buildOwnerDashboardSummary_(orders, effectiveDate)
    };
  } catch (error) {
    return {
      ok: false,
      error: error && error.message ? error.message : String(error),
      effectiveDate: normalizeDateInput_(dateKey),
      orders: [],
      totals: buildOwnerDashboardSummary_([], normalizeDateInput_(dateKey))
    };
  }
}

function getTodayBoardProbe(dateKey) {
  try {
    ensureWorkbookReady_();
    var effectiveDate = normalizeDateInput_(dateKey);
    var orders = getOrders_().filter(function(order) {
      return normalizeDateInput_(order.delivery_date) === effectiveDate;
    });
    return {
      ok: true,
      effectiveDate: effectiveDate,
      orderCount: orders.length,
      sampleOrderId: orders.length ? String(orders[0].order_id || '') : ''
    };
  } catch (error) {
    return {
      ok: false,
      error: error && error.message ? error.message : String(error),
      effectiveDate: normalizeDateInput_(dateKey),
      orderCount: 0,
      sampleOrderId: ''
    };
  }
}

function getAdminCustomerDirectory() {
  ensureWorkbookReady_();
  var data = readWorkbookData_({
    customers: true,
    orders: true,
    deposits: true
  });
  return getCustomerAuditProfilesFromData_(data);
}

function getAdminMoneySnapshot(dateKey) {
  ensureWorkbookReady_();
  var effectiveDate = normalizeDateInput_(dateKey);
  var data = readWorkbookData_({
    customers: true,
    orders: true,
    orderItems: true,
    helpers: true,
    payments: true,
    deposits: true,
    returns: true,
    purchases: true,
    expenses: true,
    documents: true
  });
  return getAuditSnapshotFromData_(data, effectiveDate);
}

function getWorkbookExportData() {
  ensureWorkbookReady_();
  return readWorkbookData_({
    customers: true,
    orders: true,
    orderItems: true,
    products: true,
    helpers: true,
    payments: true,
    deposits: true,
    returns: true,
    purchases: true,
    expenses: true,
    documents: true,
    dailySummary: true,
    inquiries: true
  });
}

function createWorkbookExportFile() {
  ensureWorkbookReady_();
  var exportData = getWorkbookExportData();
  var timestamp = Utilities.formatDate(
    new Date(),
    Session.getScriptTimeZone() || 'Asia/Saigon',
    'yyyyMMdd-HHmmss'
  );
  var folderName = 'water-delivery-export-' + timestamp;
  var folder = DriveApp.createFolder(folderName);
  var sheetKeys = Object.keys(exportData);
  var manifest = {
    exportedAt: new Date().toISOString(),
    folderName: folderName,
    sheetCount: sheetKeys.length,
    files: []
  };

  sheetKeys.forEach(function(sheetKey) {
    var rows = exportData[sheetKey] || [];
    var fileName = sheetKey + '.json';
    var file = folder.createFile(
      fileName,
      JSON.stringify(rows),
      MimeType.PLAIN_TEXT
    );
    manifest.files.push({
      key: sheetKey,
      rowCount: rows.length,
      fileId: file.getId(),
      fileName: fileName,
      url: file.getUrl()
    });
  });

  var manifestFile = folder.createFile(
    'manifest.json',
    JSON.stringify(manifest, null, 2),
    MimeType.PLAIN_TEXT
  );

  return {
    ok: true,
    folderId: folder.getId(),
    name: folder.getName(),
    url: folder.getUrl(),
    manifestFileId: manifestFile.getId(),
    manifestUrl: manifestFile.getUrl(),
    sheetCount: manifest.sheetCount,
    files: manifest.files,
    createdAt: new Date().toISOString()
  };
}

function seedTestDataForOwner() {
  return seedTestDataForOwner_();
}

function populateOrdersSheetOnly() {
  ensureWorkbookReady_();
  var compactedOrders = compactSheetRows_(APP_CONFIG.sheetNames.orders);
  var compactedItems = compactSheetRows_(APP_CONFIG.sheetNames.orderItems);
  var existingTodaySeeded = getOrders_().filter(function(order) {
    return normalizeDateInput_(order.delivery_date) === normalizeDateInput_(new Date()) &&
      String(order.notes || '').indexOf('[seeded-test-order]') !== -1;
  });

  if (existingTodaySeeded.length) {
    return {
      createdOrders: [],
      skipped: true,
      message: 'Seeded test orders already exist for today.',
      existingCount: existingTodaySeeded.length,
      compactedOrders: compactedOrders,
      compactedItems: compactedItems,
      effectiveDate: normalizeDateInput_(new Date())
    };
  }

  var seeded = seedTestDataForOwner_();
  seeded.compactedOrders = compactedOrders;
  seeded.compactedItems = compactedItems;
  return seeded;
}

function saveOrder(payload) {
  return withScriptLock_(function() {
    ensureWorkbookReady_();
    if (!payload || !Array.isArray(payload.items) || payload.items.length === 0) {
      throw new Error('At least one order item is required.');
    }

    var customer = upsertCustomer_(payload);
    var dateKey = normalizeDateInput_(payload.deliveryDate);
    var orderId = generateOrderId_(dateKey);
    var orderRecord = buildOrderRecord_(payload, customer, orderId);

    appendObjectRow_(APP_CONFIG.sheetNames.orders, orderRecord);
    replaceOrderItems_(orderId, payload.items);

    if (sanitizeText_(payload.orderDocumentLink)) {
      createDocumentRecord_({
        entityType: 'order',
        entityId: orderId,
        documentType: 'chat_screenshot',
        driveLink: payload.orderDocumentLink,
        notes: payload.orderDocumentNotes
      });
    }

    if (safeNumber_(payload.depositAmount) > 0 || safeNumber_(payload.depositQty) > 0) {
      recordDepositEvent_({
        orderId: orderId,
        customerId: customer.customer_id,
        containerType: payload.depositContainerType,
        qty: payload.depositQty,
        amount: payload.depositAmount,
        eventType: 'charged',
        eventDate: dateKey,
        proofLink: payload.depositProofLink,
        notes: payload.depositNotes
      });
    }

    if (safeNumber_(payload.initialPaymentAmount) > 0) {
      recordPayment_({
        orderId: orderId,
        customerId: customer.customer_id,
        paymentDate: payload.initialPaymentDate || dateKey,
        method: payload.initialPaymentMethod,
        amount: payload.initialPaymentAmount,
        reference: payload.initialPaymentReference,
        receivedBy: payload.initialPaymentReceivedBy,
        proofLink: payload.initialPaymentProofLink,
        notes: payload.initialPaymentNotes
      });
    }

    var updatedOrder = recomputeOrderFinancials_(orderId);
    var totals = syncDailySummaryForDate_(dateKey);

    return {
      ok: true,
      orderId: orderId,
      totals: totals,
      customerId: customer.customer_id,
      order: updatedOrder
    };
  });
}

function buildPublicOrderPayload_(payload) {
  var products = getProducts_();
  var productMap = products.reduce(function(map, product) {
    map[String(product.product_id || '')] = product;
    return map;
  }, {});
  var requestedItems = Array.isArray(payload && payload.items) ? payload.items : [];
  var items = requestedItems.map(function(item) {
    var productId = sanitizeText_(item && item.productId);
    var quantity = safeNumber_(item && item.quantity);
    var product = productMap[productId];
    if (!product || quantity <= 0) {
      return null;
    }
    return {
      productId: product.product_id,
      productName: product.product_name,
      quantity: quantity,
      unitPrice: safeNumber_(product.unit_price)
    };
  }).filter(Boolean);

  if (!items.length) {
    throw new Error('Select at least one valid product before submitting.');
  }

  var extras = sanitizeText_(payload && payload.extras);
  var preferredChannel = sanitizeText_(payload && payload.preferredChannel);
  var email = sanitizeText_(payload && payload.email);
  var sourcePage = sanitizeText_(payload && payload.sourcePage);
  var referrerUrl = sanitizeText_(payload && payload.referrerUrl);

  return {
    sourceChannel: 'website',
    customerName: sanitizeText_(payload && payload.name),
    billingName: '',
    phone: normalizePhone_(payload && payload.phone),
    address: sanitizeText_(payload && payload.address),
    area: '',
    taxId: '',
    deliveryDate: normalizeDateInput_(payload && payload.deliveryDate),
    deliveryWindow: sanitizeText_(payload && payload.timeSlot),
    assignedHelperId: '',
    status: 'pending_approval',
    notes: [
      'Submitted from public order form',
      email ? 'Email: ' + email : '',
      preferredChannel ? 'Preferred follow-up: ' + preferredChannel : '',
      sourcePage ? 'Source page: ' + sourcePage : '',
      referrerUrl ? 'Referrer: ' + referrerUrl : '',
      extras ? 'Customer note: ' + extras : ''
    ].filter(Boolean).join(' | '),
    items: items
  };
}

function updateOrderDispatch(payload) {
  return withScriptLock_(function() {
    ensureWorkbookReady_();
    if (!payload || !payload.orderId) {
      throw new Error('Order ID is required.');
    }

    var order = getOrders_().find(function(record) {
      return record.order_id === payload.orderId;
    });

    if (!order) {
      throw new Error('Order not found: ' + payload.orderId);
    }

    var nextStatus = sanitizeText_(payload.status) || order.status;
    if (nextStatus === 'delivered' && sanitizeText_(order.payment_status) !== 'paid') {
      throw new Error('Order can only be completed after it is fully paid.');
    }

    order.assigned_helper_id = sanitizeText_(payload.assignedHelperId) || order.assigned_helper_id;
    order.status = nextStatus;
    order.notes = payload.notes !== undefined ? sanitizeText_(payload.notes) : order.notes;
    order.updated_at = toIsoTimestamp_();

    updateObjectRow_(APP_CONFIG.sheetNames.orders, order._rowNumber, order);
    var refreshedOrder = recomputeOrderFinancials_(payload.orderId);
    var totals = syncDailySummaryForDate_(normalizeDateInput_(refreshedOrder.delivery_date));

    return {
      ok: true,
      totals: totals,
      order: refreshedOrder
    };
  });
}

function approvePublicOrder(payload) {
  return withScriptLock_(function() {
    ensureWorkbookReady_();
    if (!payload || !payload.orderId) {
      throw new Error('Order ID is required for approval.');
    }

    var order = getOrders_().find(function(record) {
      return record.order_id === payload.orderId;
    });

    if (!order) {
      throw new Error('Order not found: ' + payload.orderId);
    }

    order.status = 'new';
    order.updated_at = toIsoTimestamp_();
    if (sanitizeText_(payload.approvalNote)) {
      order.notes = [sanitizeText_(order.notes), 'Approval note: ' + sanitizeText_(payload.approvalNote)]
        .filter(Boolean)
        .join(' | ');
    }
    updateObjectRow_(APP_CONFIG.sheetNames.orders, order._rowNumber, order);

    var refreshedOrder = recomputeOrderFinancials_(payload.orderId);
    var totals = syncDailySummaryForDate_(normalizeDateInput_(refreshedOrder.delivery_date));

    return {
      ok: true,
      order: refreshedOrder,
      totals: totals
    };
  });
}

function recordOrderPayment(payload) {
  return withScriptLock_(function() {
    ensureWorkbookReady_();
    if (!payload || !payload.orderId) {
      throw new Error('Order ID is required for payment.');
    }

    var order = getOrders_().find(function(row) {
      return row.order_id === payload.orderId;
    });
    if (!order) {
      throw new Error('Order not found: ' + payload.orderId);
    }

    recordPayment_({
      orderId: order.order_id,
      customerId: order.customer_id,
      paymentDate: payload.paymentDate,
      method: payload.method,
      amount: payload.amount,
      reference: payload.reference,
      receivedBy: payload.receivedBy,
      proofLink: payload.proofLink,
      notes: payload.notes
    });

    var refreshedOrder = recomputeOrderFinancials_(payload.orderId);
    var totals = syncDailySummaryForDate_(normalizeDateInput_(refreshedOrder.delivery_date));

    return {
      ok: true,
      order: refreshedOrder,
      totals: totals
    };
  });
}

function recordDepositReturn(payload) {
  return withScriptLock_(function() {
    ensureWorkbookReady_();
    if (!payload || !payload.customerId) {
      throw new Error('Customer ID is required for return logging.');
    }

    var depositEvent = null;
    if (safeNumber_(payload.refundAmount) > 0 && sanitizeText_(payload.refundAction)) {
      depositEvent = recordDepositEvent_({
        orderId: payload.orderId,
        customerId: payload.customerId,
        containerType: payload.containerType,
        qty: payload.qty,
        amount: payload.refundAmount,
        eventType: payload.refundAction,
        eventDate: payload.returnedAt,
        proofLink: payload.proofLink,
        notes: payload.notes
      });
    }

    var returnRow = recordReturn_({
      orderId: payload.orderId,
      customerId: payload.customerId,
      containerType: payload.containerType,
      qty: payload.qty,
      returnedAt: payload.returnedAt,
      condition: payload.condition,
      linkedDepositEventId: depositEvent ? depositEvent.deposit_event_id : '',
      proofLink: payload.proofLink,
      notes: payload.notes
    });

    if (payload.orderId) {
      recomputeOrderFinancials_(payload.orderId);
    }

    return {
      ok: true,
      returnId: returnRow ? returnRow.return_id : '',
      depositEventId: depositEvent ? depositEvent.deposit_event_id : ''
    };
  });
}

function recordPurchase(payload) {
  return withScriptLock_(function() {
    ensureWorkbookReady_();
    var purchase = recordPurchase_(payload || {});
    return {
      ok: true,
      purchaseId: purchase ? purchase.purchase_id : ''
    };
  });
}

function recordExpense(payload) {
  return withScriptLock_(function() {
    ensureWorkbookReady_();
    var expense = recordExpense_(payload || {});
    return {
      ok: true,
      expenseId: expense ? expense.expense_id : ''
    };
  });
}

function recordDocumentEntry(payload) {
  return withScriptLock_(function() {
    ensureWorkbookReady_();
    var document = createDocumentRecord_({
      entityType: payload.entityType,
      entityId: payload.entityId,
      documentType: payload.documentType,
      driveLink: payload.driveLink,
      notes: payload.notes
    });
    return {
      ok: true,
      documentId: document ? document.document_id : ''
    };
  });
}

function getCustomerHistoryByPhone(phone) {
  ensureWorkbookReady_();
  var customer = findCustomerByPhone_(phone);
  if (!customer) {
    return { customer: null, orders: [] };
  }

  var orders = getEnrichedOrders_().filter(function(order) {
    return order.customerId === customer.customer_id;
  });

  return {
    customer: {
      customerId: customer.customer_id,
      name: customer.name,
      billingName: customer.billing_name,
      phone: customer.phone,
      address: customer.address,
      area: customer.area,
      addressHistory: customer.address_history,
      preferredSource: customer.last_source_channel,
      taxId: customer.tax_id,
      notes: customer.notes,
      outstandingBalance: orders.reduce(function(sum, order) { return sum + safeNumber_(order.balanceDue); }, 0),
      outstandingDeposits: getCustomerOutstandingDeposit_(customer.customer_id)
    },
    orders: orders
  };
}

function getCustomerQuickLookup(phone) {
  ensureWorkbookReady_();
  var history = getCustomerHistoryByPhone(phone);
  if (!history.customer) {
    return { customer: null, recentOrder: null };
  }

  return {
    customer: history.customer,
    recentOrder: history.orders && history.orders.length ? history.orders[0] : null
  };
}

function createRepeatOrderDraft(orderId) {
  ensureWorkbookReady_();
  if (!orderId) {
    throw new Error('Order ID is required.');
  }

  var order = getEnrichedOrders_().find(function(row) {
    return row.orderId === orderId;
  });
  if (!order) {
    throw new Error('Order not found: ' + orderId);
  }

  var customer = getCustomers_().find(function(row) {
    return row.customer_id === order.customerId;
  });

  return {
    customer: customer ? {
      customerId: customer.customer_id,
      name: customer.name,
      billingName: customer.billing_name,
      phone: customer.phone,
      address: customer.address,
      area: customer.area,
      taxId: customer.tax_id,
      notes: customer.notes
    } : null,
    order: {
      sourceChannel: order.sourceChannel,
      customerName: order.customerName,
      billingName: customer ? customer.billing_name : '',
      phone: order.phone,
      address: order.address,
      area: customer ? customer.area : '',
      taxId: customer ? customer.tax_id : '',
      deliveryWindow: order.deliveryWindow,
      assignedHelperId: order.assignedHelperId,
      notes: order.notes,
      items: order.items.map(function(item) {
        return {
          productId: item.productId,
          productName: item.productName,
          quantity: item.quantity,
          unitPrice: item.unitPrice
        };
      })
    }
  };
}

function submitPublicInquiry(payload) {
  return withScriptLock_(function() {
    ensureWorkbookReady_();
    var email = sanitizeText_(payload && payload.email);
    var extras = sanitizeText_(payload && payload.extras);
    var customer = upsertCustomer_({
      name: sanitizeText_(payload && payload.name),
      phone: normalizePhone_(payload && payload.phone),
      address: sanitizeText_(payload && payload.address),
      area: '',
      billingName: '',
      taxId: '',
      notes: [email ? 'Public form email: ' + email : '', extras ? 'Public form note: ' + extras : ''].filter(Boolean).join(' | '),
      sourceChannel: 'website'
    });
    var inquiry = {
      inquiry_id: generateId_('INQ'),
      created_at: toIsoTimestamp_(),
      customer_id: customer.customer_id,
      request_status: 'new',
      source_page: sanitizeText_(payload && payload.sourcePage) || 'public-homepage',
      referrer_url: sanitizeText_(payload && payload.referrerUrl),
      name: sanitizeText_(payload && payload.name),
      phone: normalizePhone_(payload && payload.phone),
      email: email,
      address: sanitizeText_(payload && payload.address),
      delivery_date: normalizeDateInput_(payload && payload.deliveryDate),
      delivery_time_slot: sanitizeText_(payload && payload.timeSlot),
      glass_order: sanitizeText_(payload && payload.glassOrder),
      jug_order: sanitizeText_(payload && payload.jugOrder),
      extras: extras,
      preferred_channel: sanitizeText_(payload && payload.preferredChannel),
      submission_channel: 'website_form',
      converted_order_id: '',
      notes: sanitizeText_(payload && payload.notes)
    };

    appendObjectRow_(APP_CONFIG.sheetNames.inquiries, inquiry);
    return {
      ok: true,
      inquiryId: inquiry.inquiry_id,
      customerId: customer.customer_id
    };
  });
}

function submitPublicOrder(payload) {
  ensureWorkbookReady_();
  var result = saveOrder(buildPublicOrderPayload_(payload));
  return {
    ok: true,
    orderId: result.orderId,
    customerId: result.customerId
  };
}

function seedTestDataForOwner_() {
  ensureWorkbookReady_();
  var today = normalizeDateInput_(new Date());
  var createdOrders = [];

  createdOrders.push(saveOrder({
    sourceChannel: 'whatsapp',
    customerName: 'Nguyen An',
    phone: '0901234501',
    address: '45 Le Duan, Hai Chau',
    area: 'Hai Chau',
    deliveryDate: today,
    deliveryWindow: '09:00-11:00',
    assignedHelperId: 'H-001',
    status: 'new',
    notes: '[seeded-test-order] First office order',
    items: [
      { productId: 'P-DANH-THANH-SPARKLING-CRATE', quantity: 1, unitPrice: 199000 },
      { productId: 'P-GLASS-STRAW', quantity: 2, unitPrice: 35000 }
    ],
    initialPaymentAmount: 100000,
    initialPaymentMethod: 'cash',
    initialPaymentReceivedBy: 'Owner',
    depositContainerType: 'glass_crate',
    depositQty: 1,
    depositAmount: 30000
  }).orderId);

  createdOrders.push(saveOrder({
    sourceChannel: 'zalo',
    customerName: 'Le Hoa',
    phone: '0901234502',
    address: '12 Pham Van Dong, Son Tra',
    area: 'Son Tra',
    deliveryDate: today,
    deliveryWindow: '11:00-13:00',
    assignedHelperId: 'H-002',
    status: 'assigned',
    notes: '[seeded-test-order] Household refill customer',
    items: [
      { productId: 'P-UNI-20L-JUG', quantity: 3, unitPrice: 50000 }
    ],
    initialPaymentAmount: 300000,
    initialPaymentMethod: 'transfer',
    initialPaymentReference: 'VCB-LEHOA-01',
    initialPaymentReceivedBy: 'Owner',
    depositContainerType: '20l_jug',
    depositQty: 3,
    depositAmount: 150000
  }).orderId);

  createdOrders.push(saveOrder({
    sourceChannel: 'facebook',
    customerName: 'Tran Binh',
    phone: '0901234503',
    address: '88 Vo Nguyen Giap, Ngu Hanh Son',
    area: 'Ngu Hanh Son',
    deliveryDate: today,
    deliveryWindow: '14:00-16:00',
    assignedHelperId: '',
    status: 'new',
    notes: '[seeded-test-order] Needs call before arrival',
    items: [
      { productId: 'P-VIKODA-19L-JUG', quantity: 2, unitPrice: 95000 },
      { productId: 'P-TAP-TEST-DIGITAL', quantity: 1, unitPrice: 25000 }
    ],
    initialPaymentAmount: 0,
    initialPaymentMethod: 'cash',
    depositContainerType: '19l_jug',
    depositQty: 2,
    depositAmount: 100000
  }).orderId);

  createdOrders.push(saveOrder({
    sourceChannel: 'phone',
    customerName: 'Nguyen An',
    phone: '0901234501',
    address: '45 Le Duan, Hai Chau',
    area: 'Hai Chau',
    deliveryDate: today,
    deliveryWindow: '17:00-19:00',
    assignedHelperId: 'H-001',
    status: 'out_for_delivery',
    notes: '[seeded-test-order] Repeat evening delivery',
    items: [
      { productId: 'P-THACH-BICH-18L9-JUG', quantity: 2, unitPrice: 75000 }
    ],
    initialPaymentAmount: 150000,
    initialPaymentMethod: 'cash',
    initialPaymentReceivedBy: 'Owner',
    depositContainerType: '18_9l_jug',
    depositQty: 2,
    depositAmount: 100000
  }).orderId);

  return {
    createdOrders: createdOrders,
    createdCustomers: ['0901234501', '0901234502', '0901234503'],
    effectiveDate: today
  };
}

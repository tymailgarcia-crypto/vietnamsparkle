function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Water Delivery')
    .addItem('Initialize Workbook', 'setupWaterDeliveryWorkbook')
    .addItem('Sync Product Catalog', 'syncProductCatalog')
    .addItem('Populate Test Orders', 'populateOrdersSheetOnly')
    .addItem('Seed Audit Demo Data', 'seedWaterDeliveryDemoData')
    .addItem('Export Workbook JSON', 'showWorkbookExportDialog')
    .addToUi();
}

function showWorkbookExportDialog() {
  ensureWorkbookReady_();
  var appUrl = ScriptApp.getService().getUrl();
  var exportUrl = appUrl ? appUrl + '?action=export_workbook_json' : '';
  SpreadsheetApp.getUi().showModalDialog(
    HtmlService.createHtmlOutput(
      '<div style="font-family:Arial,sans-serif;padding:16px">' +
      '<h3 style="margin-top:0">Workbook JSON Export</h3>' +
      '<p>Create a Google Drive export folder with one JSON file per sheet.</p>' +
      '<button id="start-export" style="background:#0f9d58;color:#fff;border:none;border-radius:6px;padding:10px 14px;cursor:pointer">Create export folder</button>' +
      '<p id="export-status" style="margin-top:12px;color:#555">Ready.</p>' +
      '<div id="export-result" style="display:none;margin-top:12px"></div>' +
      (exportUrl
        ? '<p style="margin-top:16px">Web export endpoint:</p>' +
          '<p><a href="' + exportUrl + '" target="_blank" rel="noopener">Generate another export file via web app</a></p>' +
          '<p style="word-break:break-all;font-size:12px;color:#555">' + exportUrl + '</p>'
        : '') +
      '<script>' +
      'var button=document.getElementById("start-export");' +
      'var status=document.getElementById("export-status");' +
      'var result=document.getElementById("export-result");' +
      'button.addEventListener("click",function(){' +
      'button.disabled=true;' +
      'button.textContent="Creating...";' +
      'status.textContent="Building export folder in Google Drive...";' +
      'google.script.run' +
      '.withSuccessHandler(function(payload){' +
      'button.disabled=false;' +
      'button.textContent="Create export folder";' +
      'status.textContent="Export complete.";' +
      'result.style.display="block";' +
      'result.innerHTML=' +
      '"<p><a href=\\"" + payload.url + "\\" target=\\"_blank\\" rel=\\"noopener\\">Open export folder</a></p>" +' +
      '"<p><a href=\\"" + payload.manifestUrl + "\\" target=\\"_blank\\" rel=\\"noopener\\">Open manifest.json</a></p>" +' +
      '"<p style=\\"font-size:12px;color:#555\\">" + payload.name + " with " + payload.sheetCount + " files</p>";' +
      '})' +
      '.withFailureHandler(function(error){' +
      'button.disabled=false;' +
      'button.textContent="Create export folder";' +
      'status.textContent="Export failed: " + (error && error.message ? error.message : error);' +
      '})' +
      '.createWorkbookExportFile();' +
      '});' +
      '</script>' +
      '</div>'
    ).setWidth(560).setHeight(360),
    'Workbook JSON Export'
  );
}

function setupWaterDeliveryWorkbook() {
  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) {
    throw new Error('Open the bound spreadsheet before running setupWaterDeliveryWorkbook.');
  }

  var specs = [
    {
      key: 'customers',
      headers: ['customer_id', 'name', 'billing_name', 'phone', 'secondary_phone', 'tax_id', 'address', 'area', 'address_history', 'notes', 'last_source_channel', 'last_order_at', 'order_count', 'created_at', 'updated_at'],
      widths: [140, 180, 180, 130, 130, 140, 240, 140, 240, 220, 140, 170, 100, 170, 170]
    },
    {
      key: 'orders',
      headers: ['order_id', 'created_at', 'source_channel', 'customer_id', 'customer_name', 'phone', 'address', 'delivery_date', 'delivery_window', 'assigned_helper_id', 'status', 'subtotal', 'deposit_total', 'amount_paid', 'balance_due', 'payment_status', 'notes', 'updated_at'],
      widths: [150, 170, 130, 140, 180, 130, 240, 120, 120, 140, 140, 110, 110, 110, 110, 130, 220, 170]
    },
    {
      key: 'orderItems',
      headers: ['order_item_id', 'order_id', 'product_id', 'product_name', 'quantity', 'unit_price', 'line_total'],
      widths: [150, 150, 140, 180, 90, 110, 110]
    },
    {
      key: 'products',
      headers: ['product_id', 'product_name', 'category', 'container_type', 'unit_label', 'unit_price', 'default_deposit_amount', 'active', 'notes'],
      widths: [150, 180, 120, 130, 100, 110, 140, 80, 220]
    },
    {
      key: 'helpers',
      headers: ['helper_id', 'helper_name', 'phone', 'active', 'notes'],
      widths: [110, 180, 130, 80, 220]
    },
    {
      key: 'payments',
      headers: ['payment_id', 'order_id', 'customer_id', 'payment_date', 'method', 'amount', 'reference', 'received_by', 'proof_document_id', 'notes'],
      widths: [140, 150, 140, 120, 120, 110, 160, 140, 160, 220]
    },
    {
      key: 'deposits',
      headers: ['deposit_event_id', 'order_id', 'customer_id', 'container_type', 'qty', 'amount', 'event_type', 'event_date', 'linked_document_id', 'notes'],
      widths: [150, 150, 140, 140, 80, 110, 120, 120, 160, 220]
    },
    {
      key: 'returns',
      headers: ['return_id', 'order_id', 'customer_id', 'container_type', 'qty', 'returned_at', 'condition', 'linked_deposit_event_id', 'linked_document_id', 'notes'],
      widths: [140, 150, 140, 140, 80, 120, 120, 160, 160, 220]
    },
    {
      key: 'purchases',
      headers: ['purchase_id', 'supplier_name', 'purchase_date', 'item', 'qty', 'unit_cost', 'total_cost', 'invoice_number', 'payment_status', 'proof_document_id', 'notes'],
      widths: [140, 180, 120, 180, 90, 110, 110, 160, 120, 160, 220]
    },
    {
      key: 'expenses',
      headers: ['expense_id', 'expense_date', 'category', 'description', 'amount', 'payment_method', 'paid_to', 'proof_document_id', 'notes'],
      widths: [140, 120, 120, 220, 110, 120, 160, 160, 220]
    },
    {
      key: 'documents',
      headers: ['document_id', 'entity_type', 'entity_id', 'document_type', 'drive_link', 'uploaded_at', 'notes'],
      widths: [140, 120, 150, 140, 260, 170, 220]
    },
    {
      key: 'dailySummary',
      headers: ['summary_date', 'total_orders', 'delivered_orders', 'gross_revenue', 'cash_collected', 'transfer_collected', 'total_collected', 'unpaid_balance', 'outstanding_deposits', 'updated_at'],
      widths: [120, 110, 120, 120, 120, 130, 120, 130, 150, 170]
    },
    {
      key: 'inquiries',
      headers: ['inquiry_id', 'created_at', 'customer_id', 'request_status', 'source_page', 'referrer_url', 'name', 'phone', 'email', 'address', 'delivery_date', 'delivery_time_slot', 'glass_order', 'jug_order', 'extras', 'preferred_channel', 'submission_channel', 'converted_order_id', 'notes'],
      widths: [140, 170, 140, 120, 180, 220, 160, 130, 180, 240, 120, 150, 220, 220, 240, 140, 150, 150, 220]
    }
  ];

  specs.forEach(function(spec) {
    ensureSheetStructure_(spreadsheet, APP_CONFIG.sheetNames[spec.key], spec.headers, spec.widths);
  });

  applySheetValidations_(spreadsheet);
  seedDefaultRows_(spreadsheet);
  syncProductCatalog_();
  spreadsheet.toast('Audit-ready water delivery workbook is ready.', 'Setup complete', 5);
}

function syncProductCatalog() {
  ensureWorkbookReady_();
  syncProductCatalog_();
  SpreadsheetApp.getActive().toast('Product catalog synced.', 'Catalog sync', 5);
}

function seedWaterDeliveryDemoData() {
  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) {
    throw new Error('Open the bound spreadsheet before seeding demo data.');
  }

  setupWaterDeliveryWorkbook();

  var sampleOrder = {
    sourceChannel: 'whatsapp',
    customerName: 'Tran Minh',
    billingName: 'Tran Minh',
    phone: '0900000001',
    address: '12 Nguyen Hue',
    area: 'District 1',
    deliveryDate: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'),
    deliveryWindow: 'Morning',
    assignedHelperId: 'H-001',
    status: 'assigned',
    notes: 'Sample repeat customer',
    items: [
      { productId: 'P-DANH-THANH-SPARKLING-CRATE', quantity: 1, unitPrice: 199000 }
    ],
    initialPaymentAmount: 120000,
    initialPaymentMethod: 'cash',
    initialPaymentReference: 'cash-first-drop',
    initialPaymentReceivedBy: 'Owner',
    depositContainerType: 'glass_crate',
    depositQty: 1,
    depositAmount: 30000
  };

  var sampleOrderId = saveOrder(sampleOrder).orderId;

  recordOrderPayment({
    orderId: sampleOrderId,
    paymentDate: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'),
    method: 'transfer',
    amount: 70000,
    reference: 'bank top-up',
    receivedBy: 'Owner',
    notes: 'Customer settled remaining balance'
  });

  recordPurchase({
    supplierName: 'Thach Bich Supplier',
    purchaseDate: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'),
    item: '19L Water Jug',
    qty: 20,
    unitCost: 28000,
    invoiceNumber: 'INV-001',
    paymentStatus: 'partial',
    proofLink: 'https://drive.google.com/example-purchase',
    notes: 'Starter stock'
  });

  recordExpense({
    expenseDate: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'),
    category: 'fuel',
    description: 'Scooter fuel top-up',
    amount: 120000,
    paymentMethod: 'cash',
    paidTo: 'Fuel station',
    proofLink: 'https://drive.google.com/example-expense',
    notes: 'Delivery route fuel'
  });

  SpreadsheetApp.getActive().toast('Audit demo data inserted.', 'Demo data', 5);
}

function ensureWorkbookReady_() {
  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) {
    throw new Error('Open the bound spreadsheet before using the workbook.');
  }

  var missingSheets = Object.keys(APP_CONFIG.sheetNames).map(function(key) {
    return APP_CONFIG.sheetNames[key];
  }).filter(function(sheetName) {
    return !spreadsheet.getSheetByName(sheetName);
  });

  if (missingSheets.length) {
    throw new Error('Workbook is not initialized. Missing sheets: ' + missingSheets.join(', ') + '. Run Initialize Workbook from the Water Delivery menu.');
  }

  var ordersSheet = spreadsheet.getSheetByName(APP_CONFIG.sheetNames.orders);
  var orderHeader = String(ordersSheet.getRange(1, 1).getValue() || '').trim();
  if (orderHeader !== 'order_id') {
    throw new Error('Workbook structure is incomplete. Run Initialize Workbook from the Water Delivery menu.');
  }

  // Keep request-time checks cheap. Full formatting and validation belong in setup,
  // not on every export, dashboard load, or order write.
  syncDefaultHelpers_(spreadsheet);

  return spreadsheet;
}

function getValidationEndRow_(sheet) {
  return Math.max(sheet.getMaxRows(), 5000);
}

function ensureSheetStructure_(spreadsheet, sheetName, headers, widths) {
  var sheet = spreadsheet.getSheetByName(sheetName) || spreadsheet.insertSheet(sheetName);
  if (sheet.getMaxRows() < 2) {
    sheet.insertRows(1, 10);
  }

  var headerRange = sheet.getRange(1, 1, 1, headers.length);
  headerRange.setValues([headers]);
  headerRange
    .setFontWeight('bold')
    .setBackground('#16324f')
    .setFontColor('#ffffff')
    .setHorizontalAlignment('center');

  widths.forEach(function(width, index) {
    sheet.setColumnWidth(index + 1, width);
  });

  sheet.setFrozenRows(1);
  if (sheet.getFilter()) {
    sheet.getFilter().remove();
  }
  sheet.getRange(1, 1, Math.max(sheet.getLastRow(), 2), headers.length).createFilter();
  sheet.setHiddenGridlines(true);

  applySheetFormatting_(sheetName, sheet);
}

function applySheetFormatting_(sheetName, sheet) {
  if (sheetName === APP_CONFIG.sheetNames.orders) {
    sheet.getRange('H2:H1000').setNumberFormat('yyyy-mm-dd');
    sheet.getRange('L2:O1000').setNumberFormat('#,##0');
  }

  if (sheetName === APP_CONFIG.sheetNames.products) {
    sheet.getRange('F2:G1000').setNumberFormat('#,##0');
  }

  if (sheetName === APP_CONFIG.sheetNames.orderItems) {
    sheet.getRange('E2:G1000').setNumberFormat('#,##0');
  }

  if (sheetName === APP_CONFIG.sheetNames.payments) {
    sheet.getRange('D2:D1000').setNumberFormat('yyyy-mm-dd');
    sheet.getRange('F2:F1000').setNumberFormat('#,##0');
  }

  if (sheetName === APP_CONFIG.sheetNames.deposits) {
    sheet.getRange('E2:F1000').setNumberFormat('#,##0');
    sheet.getRange('H2:H1000').setNumberFormat('yyyy-mm-dd');
  }

  if (sheetName === APP_CONFIG.sheetNames.returns) {
    sheet.getRange('E2:E1000').setNumberFormat('#,##0');
    sheet.getRange('F2:F1000').setNumberFormat('yyyy-mm-dd');
  }

  if (sheetName === APP_CONFIG.sheetNames.purchases) {
    sheet.getRange('C2:C1000').setNumberFormat('yyyy-mm-dd');
    sheet.getRange('E2:G1000').setNumberFormat('#,##0');
  }

  if (sheetName === APP_CONFIG.sheetNames.expenses) {
    sheet.getRange('B2:B1000').setNumberFormat('yyyy-mm-dd');
    sheet.getRange('E2:E1000').setNumberFormat('#,##0');
  }

  if (sheetName === APP_CONFIG.sheetNames.documents) {
    sheet.getRange('F2:F1000').setNumberFormat('yyyy-mm-dd hh:mm');
  }

  if (sheetName === APP_CONFIG.sheetNames.dailySummary) {
    sheet.getRange('A2:A1000').setNumberFormat('yyyy-mm-dd');
    sheet.getRange('B2:I1000').setNumberFormat('#,##0');
  }

  if (sheetName === APP_CONFIG.sheetNames.inquiries) {
    sheet.getRange('K2:K1000').setNumberFormat('yyyy-mm-dd');
  }
}

function applySheetValidations_(spreadsheet) {
  var ordersSheet = spreadsheet.getSheetByName(APP_CONFIG.sheetNames.orders);
  var productsSheet = spreadsheet.getSheetByName(APP_CONFIG.sheetNames.products);
  var helpersSheet = spreadsheet.getSheetByName(APP_CONFIG.sheetNames.helpers);
  var paymentsSheet = spreadsheet.getSheetByName(APP_CONFIG.sheetNames.payments);
  var depositsSheet = spreadsheet.getSheetByName(APP_CONFIG.sheetNames.deposits);
  var returnsSheet = spreadsheet.getSheetByName(APP_CONFIG.sheetNames.returns);
  var purchasesSheet = spreadsheet.getSheetByName(APP_CONFIG.sheetNames.purchases);
  var expensesSheet = spreadsheet.getSheetByName(APP_CONFIG.sheetNames.expenses);
  var documentsSheet = spreadsheet.getSheetByName(APP_CONFIG.sheetNames.documents);

  if (ordersSheet) {
    var ordersEndRow = getValidationEndRow_(ordersSheet);
    ordersSheet.getRange(2, 3, ordersEndRow - 1, 1).setDataValidation(
      SpreadsheetApp.newDataValidation()
        .requireValueInList(APP_CONFIG.sourceChannels, true)
        .setAllowInvalid(false)
        .build()
    );

    ordersSheet.getRange(2, 10, ordersEndRow - 1, 1).setDataValidation(
      SpreadsheetApp.newDataValidation()
        .requireValueInRange(helpersSheet.getRange('A2:A200'), true)
        .setAllowInvalid(true)
        .build()
    );

    ordersSheet.getRange(2, 11, ordersEndRow - 1, 1).setDataValidation(
      SpreadsheetApp.newDataValidation()
        .requireValueInList(APP_CONFIG.orderStatuses, true)
        .setAllowInvalid(false)
        .build()
    );

    ordersSheet.getRange(2, 16, ordersEndRow - 1, 1).setDataValidation(
      SpreadsheetApp.newDataValidation()
        .requireValueInList(APP_CONFIG.orderPaymentStatuses, true)
        .setAllowInvalid(false)
        .build()
    );
  }

  if (productsSheet) {
    var productsEndRow = getValidationEndRow_(productsSheet);
    productsSheet.getRange(2, 8, productsEndRow - 1, 1).setDataValidation(
      SpreadsheetApp.newDataValidation()
        .requireCheckbox()
        .build()
    );
  }

  if (helpersSheet) {
    var helpersEndRow = getValidationEndRow_(helpersSheet);
    helpersSheet.getRange(2, 4, helpersEndRow - 1, 1).setDataValidation(
      SpreadsheetApp.newDataValidation()
        .requireCheckbox()
        .build()
    );
  }

  if (paymentsSheet) {
    var paymentsEndRow = getValidationEndRow_(paymentsSheet);
    paymentsSheet.getRange(2, 5, paymentsEndRow - 1, 1).setDataValidation(
      SpreadsheetApp.newDataValidation()
        .requireValueInList(APP_CONFIG.paymentMethods, true)
        .setAllowInvalid(false)
        .build()
    );
  }

  if (depositsSheet) {
    var depositsEndRow = getValidationEndRow_(depositsSheet);
    depositsSheet.getRange(2, 7, depositsEndRow - 1, 1).setDataValidation(
      SpreadsheetApp.newDataValidation()
        .requireValueInList(APP_CONFIG.depositEventTypes, true)
        .setAllowInvalid(false)
        .build()
    );
  }

  if (returnsSheet) {
    var returnsEndRow = getValidationEndRow_(returnsSheet);
    returnsSheet.getRange(2, 7, returnsEndRow - 1, 1).setDataValidation(
      SpreadsheetApp.newDataValidation()
        .requireValueInList(APP_CONFIG.returnConditions, true)
        .setAllowInvalid(false)
        .build()
    );
  }

  if (purchasesSheet) {
    var purchasesEndRow = getValidationEndRow_(purchasesSheet);
    purchasesSheet.getRange(2, 9, purchasesEndRow - 1, 1).setDataValidation(
      SpreadsheetApp.newDataValidation()
        .requireValueInList(APP_CONFIG.purchasePaymentStatuses, true)
        .setAllowInvalid(false)
        .build()
    );
  }

  if (expensesSheet) {
    var expensesEndRow = getValidationEndRow_(expensesSheet);
    expensesSheet.getRange(2, 3, expensesEndRow - 1, 1).setDataValidation(
      SpreadsheetApp.newDataValidation()
        .requireValueInList(APP_CONFIG.expenseCategories, true)
        .setAllowInvalid(false)
        .build()
    );

    expensesSheet.getRange(2, 6, expensesEndRow - 1, 1).setDataValidation(
      SpreadsheetApp.newDataValidation()
        .requireValueInList(APP_CONFIG.paymentMethods, true)
        .setAllowInvalid(false)
        .build()
    );
  }

  if (documentsSheet) {
    var documentsEndRow = getValidationEndRow_(documentsSheet);
    documentsSheet.getRange(2, 4, documentsEndRow - 1, 1).setDataValidation(
      SpreadsheetApp.newDataValidation()
        .requireValueInList(APP_CONFIG.documentTypes, true)
        .setAllowInvalid(false)
        .build()
    );
  }

  var customersSheet = spreadsheet.getSheetByName(APP_CONFIG.sheetNames.customers);
  if (customersSheet) {
    var customersEndRow = getValidationEndRow_(customersSheet);
    customersSheet.getRange(2, 8, customersEndRow - 1, 1).setDataValidation(
      SpreadsheetApp.newDataValidation()
        .requireValueInList(APP_CONFIG.serviceAreas, true)
        .setAllowInvalid(true)
        .build()
    );
  }
}

function seedDefaultRows_(spreadsheet) {
  syncDefaultHelpers_(spreadsheet);
}

function seedRowsIfEmpty_(sheet, rows) {
  if (!sheet || sheet.getLastRow() > 1) {
    return;
  }

  sheet.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
}

function syncDefaultHelpers_(spreadsheet) {
  var sheet = spreadsheet.getSheetByName(APP_CONFIG.sheetNames.helpers);
  if (!sheet) {
    return;
  }

  var rows = readSheetObjects_(APP_CONFIG.sheetNames.helpers);
  if (!rows.length) {
    seedRowsIfEmpty_(
      sheet,
      APP_CONFIG.defaultHelpers.map(function(helper) {
        return [
          helper.helperId,
          helper.helperName,
          helper.phone,
          helper.active,
          helper.notes
        ];
      })
    );
    return;
  }

  var byId = {};
  rows.forEach(function(row) {
    byId[String(row.helper_id || '')] = row;
  });

  APP_CONFIG.defaultHelpers.forEach(function(helper) {
    var existing = byId[helper.helperId];
    if (existing) {
      existing.helper_name = helper.helperName;
      existing.phone = helper.phone;
      existing.active = helper.active;
      existing.notes = helper.notes;
      updateObjectRow_(APP_CONFIG.sheetNames.helpers, existing._rowNumber, existing);
      return;
    }

    appendObjectRow_(APP_CONFIG.sheetNames.helpers, {
      helper_id: helper.helperId,
      helper_name: helper.helperName,
      phone: helper.phone,
      active: helper.active,
      notes: helper.notes
    });
  });
}

function syncProductCatalog_() {
  var existingProducts = readSheetObjects_(APP_CONFIG.sheetNames.products);
  var existingById = {};
  var legacyDemoIds = {
    'P-WATER-CRATE-01': true,
    'P-JUG-19L-01': true
  };

  existingProducts.forEach(function(product) {
    existingById[product.product_id] = product;
  });

  APP_CONFIG.defaultProducts.forEach(function(product) {
    var record = {
      product_id: product.productId,
      product_name: product.productName,
      category: product.category,
      container_type: product.containerType,
      unit_label: product.unitLabel,
      unit_price: product.unitPrice,
      default_deposit_amount: product.defaultDepositAmount,
      active: product.active,
      notes: product.notes
    };
    var existing = existingById[product.productId];
    if (existing) {
      updateObjectRow_(APP_CONFIG.sheetNames.products, existing._rowNumber, record);
    } else {
      appendObjectRow_(APP_CONFIG.sheetNames.products, record);
    }
  });

  Object.keys(legacyDemoIds).forEach(function(productId) {
    var legacy = existingById[productId];
    if (!legacy) {
      return;
    }
    updateObjectRow_(APP_CONFIG.sheetNames.products, legacy._rowNumber, {
      product_id: legacy.product_id,
      product_name: legacy.product_name,
      category: legacy.category,
      container_type: legacy.container_type,
      unit_label: legacy.unit_label,
      unit_price: legacy.unit_price,
      default_deposit_amount: legacy.default_deposit_amount,
      active: false,
      notes: [sanitizeText_(legacy.notes), 'Legacy demo SKU archived by catalog sync'].filter(Boolean).join(' | ')
    });
  });
}

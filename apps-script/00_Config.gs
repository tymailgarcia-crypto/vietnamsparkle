var APP_CONFIG = {
  businessName: 'Fresh Water Delivery',
  currencySymbol: 'VND',
  sheetNames: {
    customers: 'Customers',
    orders: 'Orders',
    orderItems: 'OrderItems',
    products: 'Products',
    helpers: 'Helpers',
    payments: 'Payments',
    deposits: 'Deposits',
    returns: 'Returns',
    purchases: 'Purchases',
    expenses: 'Expenses',
    documents: 'Documents',
    dailySummary: 'DailySummary',
    inquiries: 'Inquiries'
  },
  orderStatuses: ['pending_approval', 'new', 'assigned', 'out_for_delivery', 'delivered', 'cancelled'],
  orderPaymentStatuses: ['unpaid', 'partial', 'paid'],
  paymentMethods: ['cash', 'transfer', 'bank_qr', 'wise', 'other'],
  purchasePaymentStatuses: ['unpaid', 'partial', 'paid'],
  depositEventTypes: ['charged', 'refunded', 'credited'],
  returnConditions: ['good', 'damaged', 'missing_parts'],
  expenseCategories: ['fuel', 'packaging', 'labor', 'repairs', 'admin', 'other'],
  documentTypes: ['payment_proof', 'purchase_invoice', 'expense_receipt', 'chat_screenshot', 'customer_receipt', 'other'],
  sourceChannels: ['website', 'whatsapp', 'facebook', 'zalo', 'phone', 'email', 'walk_in'],
  serviceAreas: ['Hai Chau', 'Son Tra', 'Ngu Hanh Son', 'Thanh Khe', 'Da Nang nearby areas'],
  businessHours: [
    'Every day: 09:00-21:00',
    'Special delivery times can be arranged'
  ],
  publicOrderLinks: {
    whatsapp: 'https://wa.me/84900000000?text=Hello%20I%20want%20to%20order%20water',
    facebook: 'https://m.me/your-page-name',
    zalo: 'https://zalo.me/84900000000'
  },
  publicCatalog: [
    {
      itemId: 'PUB-DANH-THANH-SPARKLING',
      productId: 'P-DANH-THANH-SPARKLING-CRATE',
      itemName: 'Danh Thanh',
      group: 'glass',
      orderLabel: 'Danh Thanh sparkling crate',
      unitLabel: 'crate',
      description: 'Extra-bubbly sparkling mineral water in glass bottles. A popular choice for strong carbonation and a more intense mineral-water profile.'
    },
    {
      itemId: 'PUB-THACH-BICH-SPARKLING',
      productId: 'P-THACH-BICH-SPARKLING-CRATE',
      itemName: 'Thach Bich',
      group: 'glass',
      orderLabel: 'Thach Bich sparkling crate',
      unitLabel: 'crate',
      description: 'Lightly sparkling mineral water in glass bottles for people who want something gentler and less filling.'
    },
    {
      itemId: 'PUB-VIKODA-STILL-GLASS',
      productId: 'P-VIKODA-PH9-GLASS-CRATE',
      itemName: 'Vikoda PH 9.0',
      group: 'glass',
      orderLabel: 'Vikoda PH 9.0 glass crate',
      unitLabel: 'crate',
      description: 'Still alkaline spring water in glass bottles, positioned as a premium mineral-water option for home and hospitality use.'
    },
    {
      itemId: 'PUB-GLASSIA-STILL-GLASS',
      productId: 'P-GLASSIA-RO-GLASS-CRATE',
      itemName: 'Glassia',
      group: 'glass',
      orderLabel: 'Glassia purified glass crate',
      unitLabel: 'crate',
      description: 'Purified water in screw-top glass bottles for customers who want glass packaging without carbonation.'
    },
    {
      itemId: 'PUB-THACH-BICH-18L9',
      productId: 'P-THACH-BICH-18L9-JUG',
      itemName: 'Thach Bich 18.9L',
      group: 'jug',
      orderLabel: 'Thach Bich 18.9L jug',
      unitLabel: 'jug',
      description: 'Still mineral water in a large jug with tap, good for regular household use or small offices.'
    },
    {
      itemId: 'PUB-VIKODA-19L',
      productId: 'P-VIKODA-19L-JUG',
      itemName: 'Vikoda 19L',
      group: 'jug',
      orderLabel: 'Vikoda 19L jug',
      unitLabel: 'jug',
      description: 'PH 9.0 alkaline mineral water in a reusable jug with tap for customers who want a higher-end still-water option.'
    },
    {
      itemId: 'PUB-UNI-20L',
      productId: 'P-UNI-20L-JUG',
      itemName: 'Uni by Sunrise 20L',
      group: 'jug',
      orderLabel: 'Uni by Sunrise 20L jug',
      unitLabel: 'jug',
      description: 'Purified reverse-osmosis water in BPA-free reusable plastic jugs with taps.'
    },
    {
      itemId: 'PUB-SHOWER-FILTER',
      productId: 'P-SHOWER-FILTER',
      itemName: 'Microfiber Shower Filter',
      group: 'addon',
      orderLabel: 'Microfiber Shower Filter',
      unitLabel: 'unit',
      description: 'Monthly shower filter with installation and plumbing tape included.'
    },
    {
      itemId: 'PUB-GLASS-STRAW',
      productId: 'P-GLASS-STRAW',
      itemName: 'Extra-tall Glass Straw',
      group: 'addon',
      orderLabel: 'Extra-tall Glass Straw',
      unitLabel: 'unit',
      description: 'Glass straw sized to fit the tall glass bottles.'
    },
    {
      itemId: 'PUB-TAP-TEST-16IN1',
      productId: 'P-TAP-TEST-16IN1',
      itemName: '16-in-1 Tap Water Test',
      group: 'addon',
      orderLabel: '16-in-1 Tap Water Test',
      unitLabel: 'unit',
      description: 'Test strip kit that shows chlorine and pH.'
    },
    {
      itemId: 'PUB-TAP-TEST-DIGITAL',
      productId: 'P-TAP-TEST-DIGITAL',
      itemName: 'Digital Tap Water Test',
      group: 'addon',
      orderLabel: 'Digital Tap Water Test',
      unitLabel: 'unit',
      description: 'Digital TDS and pH meter for tap water checks.'
    },
    {
      itemId: 'PUB-COCONUT',
      productId: 'P-COCONUT',
      itemName: 'Fresh Coconuts',
      group: 'addon',
      orderLabel: 'Fresh Coconut',
      unitLabel: 'coconut',
      description: 'Pre-cut for easy access. Price changes daily and is confirmed before delivery.'
    }
  ],
  defaultProducts: [
    {
      productId: 'P-DANH-THANH-SPARKLING-CRATE',
      productName: 'Danh Thanh Sparkling Crate',
      category: 'glass',
      containerType: 'glass_crate',
      unitLabel: 'crate',
      unitPrice: 199000,
      defaultDepositAmount: 30000,
      active: true,
      notes: '20 x 460ml glass bottles; best seller; 9.9k per bottle or 199k per crate'
    },
    {
      productId: 'P-THACH-BICH-SPARKLING-CRATE',
      productName: 'Thach Bich Sparkling Crate',
      category: 'glass',
      containerType: 'glass_crate',
      unitLabel: 'crate',
      unitPrice: 149000,
      defaultDepositAmount: 30000,
      active: true,
      notes: '20 x 430ml glass bottles; 7.5k per bottle or 149k per crate'
    },
    {
      productId: 'P-VIKODA-PH9-GLASS-CRATE',
      productName: 'Vikoda PH 9.0 Glass Crate',
      category: 'glass',
      containerType: 'glass_crate',
      unitLabel: 'crate',
      unitPrice: 279000,
      defaultDepositAmount: 30000,
      active: true,
      notes: '20 x 480ml glass bottles; 14k per bottle or 279k per crate'
    },
    {
      productId: 'P-GLASSIA-RO-GLASS-CRATE',
      productName: 'Glassia Purified Glass Crate',
      category: 'glass',
      containerType: 'glass_crate',
      unitLabel: 'crate',
      unitPrice: 199000,
      defaultDepositAmount: 30000,
      active: true,
      notes: '20 x 500ml screw-top glass bottles; 10k per bottle or 199k per crate'
    },
    {
      productId: 'P-THACH-BICH-18L9-JUG',
      productName: 'Thach Bich 18.9L Jug',
      category: 'jug',
      containerType: '18_9l_jug',
      unitLabel: 'jug',
      unitPrice: 75000,
      defaultDepositAmount: 50000,
      active: true,
      notes: 'Mineral water jug with tap; free shipping from 3 jugs'
    },
    {
      productId: 'P-VIKODA-19L-JUG',
      productName: 'Vikoda 19L Jug',
      category: 'jug',
      containerType: '19l_jug',
      unitLabel: 'jug',
      unitPrice: 95000,
      defaultDepositAmount: 50000,
      active: true,
      notes: 'PH 9.0 alkaline mineral water jug with tap'
    },
    {
      productId: 'P-UNI-20L-JUG',
      productName: 'Uni by Sunrise 20L Jug',
      category: 'jug',
      containerType: '20l_jug',
      unitLabel: 'jug',
      unitPrice: 50000,
      defaultDepositAmount: 50000,
      active: true,
      notes: 'Purified reverse-osmosis BPA-free jug with tap'
    },
    {
      productId: 'P-SHOWER-FILTER',
      productName: 'Microfiber Shower Filter',
      category: 'accessory',
      containerType: '',
      unitLabel: 'unit',
      unitPrice: 100000,
      defaultDepositAmount: 0,
      active: true,
      notes: 'Installation and plumbing tape included'
    },
    {
      productId: 'P-GLASS-STRAW',
      productName: 'Extra-tall Glass Straw',
      category: 'accessory',
      containerType: '',
      unitLabel: 'unit',
      unitPrice: 35000,
      defaultDepositAmount: 0,
      active: true,
      notes: 'Fits tall glass bottles'
    },
    {
      productId: 'P-TAP-TEST-16IN1',
      productName: '16-in-1 Tap Water Test',
      category: 'accessory',
      containerType: '',
      unitLabel: 'unit',
      unitPrice: 25000,
      defaultDepositAmount: 0,
      active: true,
      notes: 'Shows chlorine and pH'
    },
    {
      productId: 'P-TAP-TEST-DIGITAL',
      productName: 'Digital Tap Water Test',
      category: 'accessory',
      containerType: '',
      unitLabel: 'unit',
      unitPrice: 25000,
      defaultDepositAmount: 0,
      active: true,
      notes: 'TDS and pH meter'
    },
    {
      productId: 'P-FRESH-COCONUT',
      productName: 'Fresh Coconut',
      category: 'produce',
      containerType: '',
      unitLabel: 'coconut',
      unitPrice: 0,
      defaultDepositAmount: 0,
      active: true,
      notes: 'Price changes daily; confirm before delivery'
    }
  ],
  defaultHelpers: [
    {
      helperId: 'H-001',
      helperName: 'Matt',
      phone: '',
      active: true,
      notes: 'Default driver'
    },
    {
      helperId: 'H-002',
      helperName: 'Alex',
      phone: '',
      active: true,
      notes: 'Driver'
    },
    {
      helperId: 'H-003',
      helperName: 'Brother',
      phone: '',
      active: true,
      notes: 'Driver'
    }
  ]
};

function getPublicConfig() {
  return {
    businessName: APP_CONFIG.businessName,
    currencySymbol: APP_CONFIG.currencySymbol,
    sourceChannels: APP_CONFIG.sourceChannels.slice(),
    paymentMethods: APP_CONFIG.paymentMethods.slice(),
    orderStatuses: APP_CONFIG.orderStatuses.slice(),
    orderPaymentStatuses: APP_CONFIG.orderPaymentStatuses.slice(),
    expenseCategories: APP_CONFIG.expenseCategories.slice(),
    documentTypes: APP_CONFIG.documentTypes.slice(),
    returnConditions: APP_CONFIG.returnConditions.slice(),
    serviceAreas: APP_CONFIG.serviceAreas.slice(),
    businessHours: APP_CONFIG.businessHours.slice(),
    publicOrderLinks: APP_CONFIG.publicOrderLinks,
    publicCatalog: APP_CONFIG.publicCatalog.slice()
  };
}

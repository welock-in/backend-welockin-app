/**
 * REAL deliveries from the-hnh.lemonsqueezy.com (store 364783), captured from
 * the dashboard on 2026-08-06: test order 9090213 for the lifetime variant
 * (1960881), created on 2026-07-30 and fully refunded on 2026-07-31.
 *
 * Verbatim on purpose — these are the bytes production actually receives, and
 * they document things no hand-written payload would think to include:
 *
 *   - `tax_rate` is the NUMBER 0 in order_created and the STRING "0.00" in
 *     order_refunded. Lemon Squeezy changes field types between events on the
 *     same order, so any parser assumption of the form "this field is a number"
 *     is one delivery away from being wrong.
 *   - Timestamps carry MICROSECONDS ("2026-07-30T12:07:50.000000Z"), not the
 *     millisecond form the JS date spec describes. V8 parses them, but that is
 *     a property worth pinning, because `parseDate` falling back would silently
 *     stamp every purchase with the delivery time instead of the purchase time.
 *   - `meta.test_mode` and `attributes.test_mode` are BOTH present and true.
 *   - The refund carries `refunded_amount_usd` equal to `total_usd` (full), and
 *     `status: "refunded"` — the two signals `isFullRefund` reads, agreeing.
 *
 * Only the receipt-URL signatures differ from the captured bytes in no way at
 * all; they are dashboard-signed links that expire, not secrets.
 */

export const REAL_ORDER_CREATED = {
  data: {
    id: "9090213",
    type: "orders",
    links: {
      self: "https://api.lemonsqueezy.com/v1/orders/9090213",
    },
    attributes: {
      tax: 0,
      urls: {
        receipt:
          "https://app.lemonsqueezy.com/my-orders/77338e89-5d40-4c3c-b069-3a6b8e10f780?expires=1785434872&signature=baf5a05fc0fbccc6b6169b106e0a8e3482678d80b06f482d4452b62fd1393206",
      },
      total: 1999,
      status: "paid",
      tax_usd: 0,
      currency: "EUR",
      refunded: false,
      store_id: 364783,
      subtotal: 1999,
      tax_name: "VAT",
      tax_rate: 0,
      setup_fee: 0,
      test_mode: true,
      total_usd: 2292,
      user_name: "Fourati",
      created_at: "2026-07-30T12:07:50.000000Z",
      identifier: "77338e89-5d40-4c3c-b069-3a6b8e10f780",
      updated_at: "2026-07-30T12:07:52.000000Z",
      user_email: "hfourati2007@gmail.com",
      customer_id: 9512763,
      refunded_at: null,
      affiliate_id: null,
      order_number: 3647831,
      subtotal_usd: 2292,
      currency_rate: "1.14680740",
      setup_fee_usd: 0,
      tax_formatted: "€0.00",
      tax_inclusive: false,
      discount_total: 0,
      referral_amount: null,
      refunded_amount: 0,
      total_formatted: "€19.99",
      first_order_item: {
        id: 9016889,
        price: 1999,
        order_id: 9090213,
        price_id: 3294770,
        quantity: 1,
        test_mode: true,
        created_at: "2026-07-30T12:07:52.000000Z",
        product_id: 1254414,
        updated_at: "2026-07-30T12:07:52.000000Z",
        variant_id: 1960881,
        product_name: "LifeTime WeLockIn",
        variant_name: "Default",
      },
      status_formatted: "Paid",
      discount_total_usd: 0,
      subtotal_formatted: "€19.99",
      refunded_amount_usd: 0,
      setup_fee_formatted: "€0.00",
      discount_total_formatted: "€0.00",
      refunded_amount_formatted: "€0.00",
    },
    relationships: {
      store: {
        links: {
          self: "https://api.lemonsqueezy.com/v1/orders/9090213/relationships/store",
          related: "https://api.lemonsqueezy.com/v1/orders/9090213/store",
        },
      },
      customer: {
        links: {
          self: "https://api.lemonsqueezy.com/v1/orders/9090213/relationships/customer",
          related: "https://api.lemonsqueezy.com/v1/orders/9090213/customer",
        },
      },
      affiliate: {
        links: {
          self: "https://api.lemonsqueezy.com/v1/orders/9090213/relationships/affiliate",
          related: "https://api.lemonsqueezy.com/v1/orders/9090213/affiliate",
        },
      },
      "order-items": {
        links: {
          self: "https://api.lemonsqueezy.com/v1/orders/9090213/relationships/order-items",
          related: "https://api.lemonsqueezy.com/v1/orders/9090213/order-items",
        },
      },
      "license-keys": {
        links: {
          self: "https://api.lemonsqueezy.com/v1/orders/9090213/relationships/license-keys",
          related: "https://api.lemonsqueezy.com/v1/orders/9090213/license-keys",
        },
      },
      subscriptions: {
        links: {
          self: "https://api.lemonsqueezy.com/v1/orders/9090213/relationships/subscriptions",
          related: "https://api.lemonsqueezy.com/v1/orders/9090213/subscriptions",
        },
      },
      "discount-redemptions": {
        links: {
          self: "https://api.lemonsqueezy.com/v1/orders/9090213/relationships/discount-redemptions",
          related: "https://api.lemonsqueezy.com/v1/orders/9090213/discount-redemptions",
        },
      },
    },
  },
  meta: {
    test_mode: true,
    event_name: "order_created",
    webhook_id: "a261e463-5cbf-4bfc-9ffd-92985b0a62ed",
    custom_data: {
      user_id: "6a4e188f2781b36c9db811e9",
    },
  },
} as const;

export const REAL_ORDER_REFUNDED = {
  data: {
    id: "9090213",
    type: "orders",
    links: {
      self: "https://api.lemonsqueezy.com/v1/orders/9090213",
    },
    attributes: {
      tax: 0,
      urls: {
        receipt:
          "https://app.lemonsqueezy.com/my-orders/77338e89-5d40-4c3c-b069-3a6b8e10f780?expires=1785538994&signature=dcc8e01738cf2dc7eacd4b85d0df0bf7cb35543ca1a88a29674776346f08304a",
      },
      total: 1999,
      status: "refunded",
      tax_usd: 0,
      currency: "EUR",
      refunded: true,
      store_id: 364783,
      subtotal: 1999,
      tax_name: "VAT",
      // A STRING here, a NUMBER in order_created. Same store, same order, one
      // day apart. This is why the parser must never trust a field's type.
      tax_rate: "0.00",
      setup_fee: 0,
      test_mode: true,
      total_usd: 2292,
      user_name: "Fourati",
      created_at: "2026-07-30T12:07:50.000000Z",
      identifier: "77338e89-5d40-4c3c-b069-3a6b8e10f780",
      updated_at: "2026-07-31T17:03:13.000000Z",
      user_email: "hfourati2007@gmail.com",
      customer_id: 9512763,
      refunded_at: "2026-07-31T17:03:13.000000Z",
      affiliate_id: null,
      order_number: 3647831,
      subtotal_usd: 2292,
      currency_rate: "1.14680740",
      setup_fee_usd: 0,
      tax_formatted: "€0.00",
      tax_inclusive: false,
      discount_total: 0,
      referral_amount: null,
      refunded_amount: 1999,
      total_formatted: "€19.99",
      first_order_item: {
        id: 9016889,
        price: 1999,
        order_id: 9090213,
        price_id: 3294770,
        quantity: 1,
        test_mode: true,
        created_at: "2026-07-30T12:07:52.000000Z",
        product_id: 1254414,
        updated_at: "2026-07-30T12:07:52.000000Z",
        variant_id: 1960881,
        product_name: "LifeTime WeLockIn",
        variant_name: "Default",
      },
      status_formatted: "Refunded",
      discount_total_usd: 0,
      subtotal_formatted: "€19.99",
      refunded_amount_usd: 2292,
      setup_fee_formatted: "€0.00",
      discount_total_formatted: "€0.00",
      refunded_amount_formatted: "€19.99",
    },
    relationships: {
      store: {
        links: {
          self: "https://api.lemonsqueezy.com/v1/orders/9090213/relationships/store",
          related: "https://api.lemonsqueezy.com/v1/orders/9090213/store",
        },
      },
      customer: {
        links: {
          self: "https://api.lemonsqueezy.com/v1/orders/9090213/relationships/customer",
          related: "https://api.lemonsqueezy.com/v1/orders/9090213/customer",
        },
      },
      affiliate: {
        links: {
          self: "https://api.lemonsqueezy.com/v1/orders/9090213/relationships/affiliate",
          related: "https://api.lemonsqueezy.com/v1/orders/9090213/affiliate",
        },
      },
      "order-items": {
        links: {
          self: "https://api.lemonsqueezy.com/v1/orders/9090213/relationships/order-items",
          related: "https://api.lemonsqueezy.com/v1/orders/9090213/order-items",
        },
      },
      "license-keys": {
        links: {
          self: "https://api.lemonsqueezy.com/v1/orders/9090213/relationships/license-keys",
          related: "https://api.lemonsqueezy.com/v1/orders/9090213/license-keys",
        },
      },
      subscriptions: {
        links: {
          self: "https://api.lemonsqueezy.com/v1/orders/9090213/relationships/subscriptions",
          related: "https://api.lemonsqueezy.com/v1/orders/9090213/subscriptions",
        },
      },
      "discount-redemptions": {
        links: {
          self: "https://api.lemonsqueezy.com/v1/orders/9090213/relationships/discount-redemptions",
          related: "https://api.lemonsqueezy.com/v1/orders/9090213/discount-redemptions",
        },
      },
    },
  },
  meta: {
    test_mode: true,
    event_name: "order_refunded",
    webhook_id: "a2645100-568c-4f94-ac5e-532ecce2424f",
    custom_data: {
      user_id: "6a4e188f2781b36c9db811e9",
    },
  },
} as const;

/** The account the real checkout stamped into custom_data. */
export const REAL_USER_ID = "6a4e188f2781b36c9db811e9";

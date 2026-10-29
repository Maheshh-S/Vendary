# Vendary Money & Trust Fixes — Design Spec

Date: 2026-10-29. Status: user-approved (roadmap Phase 1). Context: artisan
marketplace, Razorpay test mode, prices stored as plain numbers = rupees,
amounts on the wire = paise (×100). Roadmap: `docs/ROADMAP.md` items 1–7.

## Problem

`PlaceOrder` trusts client-supplied prices: totals are summed from the
localStorage `checkoutSession`, the client price is written into `OrderItem.price`,
and the paid amount is never compared against a server-computed total. A tampered
localStorage session can place an order at any price. Separately, the cart
displays an 8% tax that is never charged, payment state never advances without
manual admin action (no webhook), order writes are non-transactional, stock does
not exist, guests can complete payment before hitting `Unauthorized`, and Redis
product caches are never invalidated.

## Locked decisions

- Server is the only source of prices. Client `unit_amount` values are ignored
  end to end; every total is re-derived from `Product.price` in the DB.
- Tax policy: charge **subtotal + 8% GST**. The cart already displays 8%;
  checkout and the persisted order now agree. Tax rate lives in one shared
  constant (`lib/money.ts`).
- `PlaceOrder` requires payment details and verifies (a) HMAC signature,
  (b) the Razorpay order's amount (fetched server-side) equals the
  server-computed total, (c) each product is in stock. Payment-verified orders
  are created with status `confirmed`.
- Stock: `stockQty Int` on Product (default 25 for existing rows). Checkout
  decrements atomically inside `prisma.$transaction`; a row that cannot
  decrement (insufficient stock / not IN_STOCK) aborts the whole order.
  Availability flips to `OUT_OF_STOCK` automatically at zero.
- The Razorpay webhook is a backstop for missed client callbacks, not the
  primary status driver (avoids the webhook-vs-PlaceOrder race).
- Name-based product matching in `PlaceOrder` is removed (id matching shipped
  2026-10-11; stale localStorage sessions break loudly instead of silently
  mis-ordering).
- `RAZORPAY_WEBHOOK_SECRET` is a new required env var (documented in
  `.env.example`; webhook route 501s without it).

## Units

### 1. `lib/money.ts` (shared, client-safe)
`GST_RATE = 0.08`; `computeOrderTotals(items: {unitPaise, quantity}[])` →
`{ subtotalPaise, taxPaise, totalPaise }` with tax rounded to whole paise.
Used by cart page (display), checkout summary (display), `createRazorpayOrder`
(charge), `PlaceOrder` (persist). No server-only imports.

### 2. Server-authoritative pricing (`actions/orders/index.ts`)
- `createRazorpayOrder`: loads products by `line_items[].productId`, validates
  availability + stock, computes `subtotal + GST` in paise, creates the
  Razorpay order with that amount. Client prices never touch the charge.
- `PlaceOrder`: requires `paymentDetails`; re-prices from the DB; verifies
  signature; `razorpay.orders.fetch(orderId)` must return
  `amount === totalPaise`; creates address → order (status `confirmed`,
  `taxAmount` persisted) → items (DB price) → stock decrement, all in one
  `$transaction`. Invalidates affected product caches.
- `CheckoutSession` type is trimmed to `{ line_items }` (Stripe-shaped
  `mode/success_url/cancel_url` dropped); `currency` fixed `"inr"`.

### 3. Razorpay webhook (`app/api/razorpay/webhook/route.ts`)
POST only; raw-body HMAC-SHA256 against `x-razorpay-signature` with
`RAZORPAY_WEBHOOK_SECRET` (timing-safe compare). Events:
`payment.captured` → order (matched by `transactionId` = razorpay order id)
`pending → confirmed`; `refund.processed` → any → `cancelled`. Transitions use
`updateMany` with `where status` guards → naturally idempotent. Unknown
signatures → 400; unhandled events → 200 no-op. Route sits outside auth
(existing middleware `isApiRoute` bypass).

### 4. Stock + migration
Schema: `stockQty Int @default(25)`, `taxAmount Decimal @db.Decimal(10,2)
@default(0)` on Order, enum/field `Avaiavility/avaiavility` renamed to
`Availability/availability` (column renamed in the same migration).
Admin create-product form's discarded "Quantity" field is wired to `stockQty`
(schema + action). Checkout decrements with
`updateMany({ where: { id, availability: IN_STOCK, stockQty: { gte: qty } } })`;
`count === 0` → throw (rolls back the transaction). Post-decrement
`stockQty <= 0` rows flip to `OUT_OF_STOCK`.

### 5. Guest-checkout guard
`/checkout` moves out of `publicRoutes` in `routes.ts` → anonymous users are
redirected by the existing default-deny middleware (cart stays public for
browsing). `PlaceOrder`'s `Unauthorized` remains as the server-side backstop.

### 6. Cache invalidation + TTLs
`lib/product-cache.ts`: `invalidateProductCache(productId?)` deletes
`product-basic-details:{id}` (when id given) and `featured-products`; existing
cache writes gain TTLs (basic details 300s, featured 600s). Called from every
product mutation: create, delete, take-offline, price/short/long edits,
image add, and order placement (per ordered product).

### 7. Hygiene sweep
- Delete: legacy Stripe route (`app/api/checkout`), Stripe/`razorpay-checkout`
  stub components, unused Stripe/AWS/`feed` deps + self-referential junk deps,
  `/home` session-dump debug page, `/location` debug page, checkout
  `localStorage.clear()` button, fake promo-code UI, fake "15% OFF" logic,
  `/feed.xml` advertisement in layout metadata.
- Rename: `deletePorduct` → `deleteProduct`, `GetFeaturedPrpducts` →
  `GetFeaturedProducts`, enum/field per unit 4.
- Copy fixes: "$12.99 express shipping" / "$50 free shipping" accordions →
  INR-consistent shipping copy; "credit cards and PayPal" → Razorpay;
  hot-products placeholder `$ 0.00` → `formatINR(0)`.
- Replace boilerplate changelog with a real "What's new" MDX page.
- Remove misleading `"use server"` directives from plain server pages/layouts
  where they render UI and export no actions.

## Data flow (order)

Cart (localStorage, display totals via `lib/money.ts`) → checkout session
(product ids + quantities only) → `createRazorpayOrder` (server re-price →
charge) → Razorpay test checkout → `PlaceOrder` (signature + amount + stock
verify → `$transaction`: address, order `confirmed`, items, decrement → cache
invalidation) → `clearCart()` → `/my-orders`. Webhook backstop: captured →
`confirmed`, refund → `cancelled`.

## Error handling

Insufficient stock / offline product: rejected in `createRazorpayOrder` (before
any payment) and again in `PlaceOrder` (before any write) with a product-named
toast. Amount mismatch: rejected before order creation; nothing persisted.
Webhook: bad signature 400, unknown event 200, transition races resolved by
`where` guards. Existing `place-order` toast id pattern preserved.

## Verification

`npx tsc --noEmit`, `npm run lint`, `npm run build` gate. Manual Razorpay
test-mode walkthrough: cart totals == checkout summary == Razorpay amount ==
order row (`total`, `taxAmount`, status `confirmed`, stock decremented).
Tamper check: edit localStorage `unit_amount` → order still charged/recorded at
DB price. Webhook replay of the same event twice → no double transition.

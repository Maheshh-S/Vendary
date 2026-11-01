# Phase 1A — implementation report

**Status:** complete. Tasks 1.1, 1.2, 1.3 plus the `Refund` / `OrderEvent`
schema that Phase 1B (1.4) depends on. No Phase 1B behaviour (cancel/refund
actions, emails, admin surface, UX sweep, payment e2e) was implemented.

**Branch:** `worktree-phase-1-4` (worktree `/Users/mahesh/Developer/Vendary/.qoder/worktrees/phase-1-4`)

**Commits**

| SHA | Subject |
| --- | --- |
| `755cc70` | `feat(cart): quote server prices and store paise-native cart items` |
| `79606cc` | `feat(catalog): paginate, sort and filter the product list` |
| `1326fcb` | `feat(orders): add customer order detail, timeline and refund/event schema` |

---

## Task 1.1 — server cart quote + paise-native cart + drift UI

### New modules
- `schemas/cart/quote-schema.ts` — `cartQuoteSchema` (`checkoutLineItemSchema`
  array, `.min(1).max(50)`), quote line/issue types (`MISSING`,
  `OUT_OF_STOCK`, `INSUFFICIENT_STOCK`), `hasBlockingQuoteIssue`, `hasPriceDrift`.
  Client-safe (type-only money import), so both pages and tests share the
  classification.
- `actions/cart/quote.ts` — `getCartQuote(lineItems)` wrapped in
  `runAction("cart.quote", …)`. One `product.findMany` by id set, then per
  requested line: authoritative `unitPaise = round(Decimal price × 100)`,
  availability/stock issue, snapshot name/image. Totals go through
  `computeOrderTotals`. Missing products return issue `MISSING` (name `""`,
  price 0); non-`IN_STOCK` (including `PRE_ORDER`, matching the charge path)
  returns `OUT_OF_STOCK`; `stockQty < quantity` returns `INSUFFICIENT_STOCK`.
- `lib/cart.ts` — client-safe `CartItem` (`unitPaise` integer), `normalizeCartItems`
  (legacy rupee `price` → `Math.round(price × 100)`, drops the old field,
  clamps quantity 1–99, merges duplicate ids, filters malformed images, drops
  corrupt rows), `cartTotalPaise`, `clampCartQuantity`.
- `hooks/use-cart-quote.ts` — react-query wrapper keyed by a stable
  `productId:quantity` serialization, 15 s stale time, disabled for an empty
  cart, returns `{ quote, errorMessage, isLoading, refetch }`.
- `modules/checkout/components/_quote-banner.tsx` — one banner for cart and
  checkout: red blocking box listing per-line issue copy, amber price-drift
  message, amber "couldn't verify" state. Renders nothing on the happy path.

### Changed
- `providers/cart-provider.tsx` — `useLocalStorage` now deserializes through
  `normalizeCartItems` and serializes the current shape; a one-time mount
  effect writes the migrated cart back. Context exposes `cartTotalPaise`
  (renamed from `cartTotal` rupees). Add/update clamp quantities; `addItem`
  normalizes its input.
- `app/cart/page.tsx` — fetches the quote, renders `QuoteBanner`, shows
  authoritative per-line prices and server totals (local paise totals only
  before/without a quote), disables "Proceed to Checkout" when any blocking
  issue exists, and builds the checkout session with the quote's current
  name/image/`unit_amount` (display only).
- `modules/checkout/components/_checkout-page.tsx` — fetches the quote for the
  stored session, renders the banner, passes `blocked` to the form and the
  quote to the summary.
- `modules/checkout/components/_checkout-form.tsx` — `createRazorpayOrder` now
  receives `{ line_items: [{ productId, quantity }] }` only (prices stripped);
  the "Proceed to Payment" button is disabled and `onSubmit` refuses when the
  quote reports a blocking issue.
- `modules/checkout/components/_items-summary.tsx` — prefers quote lines/totals;
  falls back to the stored session snapshot when the quote is unavailable;
  renders per-line issue labels ("Out of stock", "Only N left", "No longer
  available").
- `modules/products/types/checkout.d.ts` — added `CheckoutLineItem` /
  `CheckoutLineItems` (the only shape the charge path accepts); documented
  `price_data` as a display snapshot in integer paise.
- `actions/orders/index.ts` — `createRazorpayOrder` parameter narrowed to
  `CheckoutLineItems` (`import type`). Pricing/confirm/refund logic untouched.
- `modules/products/sections/product-description.tsx` — cart item stores
  `unitPaise`.
- `modules/shopping/components/shopping-nav/index.tsx` — cart dialog totals
  from `cartTotalPaise / 100`.
- `lib/money.ts` — added `paiseToRupees` (decimal-string rupees, used by the
  catalog price filter).

### Tests
- `tests/cart-quote.test.ts` (10) — authoritative pricing/query shape,
  fractional rupee rounding, missing/out-of-stock/pre-order/insufficient
  classification, exact-stock acceptance, multi-line totals, empty/51-line/
  quantity bounds rejected before querying, drift/blocking helpers.
- `tests/cart-storage.test.ts` (13) — legacy migration, current shape
  untouched, corrupt rows dropped, quantity clamp + duplicate merge, image
  filtering, `cartTotalPaise`, `clampCartQuantity`.
- `e2e/cart-quote.spec.ts` (2) — tampered local price shows the drift warning
  while the subtotal stays authoritative; a legacy rupee cart is migrated to
  `unitPaise` in localStorage after reload.

---

## Task 1.2 — catalog pagination/sort/filter + indexes

### Schema/action
- `schemas/products/products-query-schema.ts` — added `minPricePaise` /
  `maxPricePaise` (coerced non-negative ints; `""`/`null` mean no filter) and a
  `.refine` enforcing `min <= max`. Existing `page`/`pageSize`/`category`/`sort`
  unchanged (pageSize still 1–48, default 24).
- `actions/products/products/index.ts` — `GetProducts` builds one `where`
  (availability + category + optional price range) shared by `findMany` and
  `count`; price bounds convert paise → decimal-string rupees
  (`paiseToRupees`) for the Decimal column.

### UI
- `app/(shopping)/products/page.tsx` — URL state `?page=&sort=&category=&min=&max=`.
  URL prices are rupees and are converted to paise; invalid/negative/inverted
  values sanitize to no filter. Uses `components/ui/pagination.tsx` (prev/next
  plus a numbered window with gaps) and preserves all params in every link.
  Renders "Showing x–y of total" and a `data-testid="product-grid"`.
  Page size is fixed at 12 (three rows on the 4-column grid) so a small
  catalog still paginates; the action default remains 24.
- `modules/products/components/catalog-filters.tsx` (new client component) —
  sort select (auto-applies), rupee min/max inputs + Apply/Clear. Every change
  pushes a fresh URL and drops `page`.

### Migration / indexes
- `prisma/migrations/20261115001000_catalog_indexes/migration.sql` plus matching
  `@@index` declarations: `Product(availability, createdAt)`,
  `Product(categoryId, price)`, `Order(userId, createdAt)`,
  `Order(status, createdAt)`, `OrderItem(orderId)`, `OrderItem(productId)`,
  `Review(productId, createdAt)`.

### Tests
- `tests/public-actions.test.ts` (+3) — paise bounds converted to decimal
  string filters shared by findMany/count, zero lower bound kept, inverted
  bounds rejected before querying.
- `e2e/catalog.spec.ts` (4) — page 2 reachable (12 + 3 seeded products), sort
  select reorders and updates the URL, category filter narrows to Pottery,
  price filter applies from the controls and every visible price is in range.

---

## Task 1.3 — customer order detail + timeline (+ 1.4 schema)

### Schema (single copy; Phase 1B must not re-create it)
- `prisma/migrations/20261115000000_refunds_and_events/migration.sql`:
  - `Refund` — `id`, `orderId` (FK cascade), `razorpayRefundId` unique,
    `paymentId`, `amount Decimal(10,2)`, `reason`, `status` (default
    `created`), timestamps, index on `orderId`.
  - `OrderEvent` — `id`, `orderId` (FK cascade), `type` (string), optional
    `fromStatus`/`toStatus` (`OrderStatus`), optional `actorId`, optional
    `metadata` (`Json` → JSONB), `createdAt`, index `(orderId, createdAt)`.
  - `Order.events` / `Order.refunds` relations added; no `User` relation on
    `actorId` (kept a plain id so system/webhook actors can be represented).
- String `type`/`status` (not DB enums) is deliberate: Phase 1B can add event
  kinds and refund states without another migration; values are enforced at
  the action boundary.

### Page
- `app/(my-orders)/my-orders/[id]/page.tsx` — `requireUser()` (middleware
  already redirects guests), then `order.findFirst({ where: { id, userId } })`
  including items/address/events asc/refunds desc. Foreign and missing ids both
  `notFound()`. Renders snapshot item names/images (or a placeholder after
  product deletion), paise-derived subtotal/tax/total (stored rupee Decimals ×
  100), masked payment id (`pay_e…7890`, full id never rendered), address,
  status pill, refund rows when present, and the timeline. No cancel button.
- `modules/orders/components/order-timeline.tsx` — client-safe presentational
  list; maps known event types, humanizes unknown ones, shows
  `fromStatus → toStatus` when both exist, and falls back to
  "Order placed" + current status + `createdAt` when no events exist.
- `app/(my-orders)/my-orders/page.tsx` — each row is now a link to the detail
  page ("View details →").
- `e2e/order-detail.spec.ts` (2) — Prisma fixtures (snapshot item with
  `productId: null`, masked payment id, total ₹1,332.72) assert rendering; a
  foreign user's order id and a random id both return HTTP 404. Fixtures and
  the foreign user are deleted in `afterAll`.

---

## Migrations applied locally

`prisma migrate dev` had three Phase 0 migrations pending on the local DB; it
applied them plus this phase's two, then `prisma generate` was run:

1. `20261101000000_order_integrity`
2. `20261101001000_review_integrity`
3. `20261101002000_drop_analytics`
4. `20261115000000_refunds_and_events` (new)
5. `20261115001000_catalog_indexes` (new)

`prisma migrate status` reports the schema up to date. All nine new indexes
were verified in `pg_indexes`.

---

## Verification results

| Command | Result |
| --- | --- |
| `DATABASE_URL=…local… bunx prisma migrate dev --skip-seed` | 5 migrations applied, client generated |
| `bunx prisma generate` | OK |
| `npx vitest run` | **18 files, 474 tests passed** (448 pre-existing + 26 new) |
| `npx tsc --noEmit` | clean |
| `npm run lint` | "No ESLint warnings or errors" |
| `DATABASE_URL=…local… npm run e2e -- --grep-invert @payment` | **14 passed** (smoke 6, catalog 4, cart-quote 2, order-detail 2) |
| `next build` with placeholder env | succeeded; `/products` and `/my-orders/[id]` are dynamic routes |

`payment.spec.ts` was not modified and was excluded from the run as instructed.

Build note: the standalone build logs a pre-existing Redis cache-read warning
because `.env` carries `REDIS_URL`; it is unrelated to these changes (the e2e
webServer sets `REDIS_URL=""` and is clean).

---

## Files changed

**Cart quote (755cc70):** `actions/cart/quote.ts`, `actions/orders/index.ts`,
`app/cart/page.tsx`, `e2e/cart-quote.spec.ts`, `hooks/use-cart-quote.ts`,
`lib/cart.ts`, `lib/money.ts`, `modules/checkout/components/_checkout-form.tsx`,
`_checkout-page.tsx`, `_items-summary.tsx`, `_quote-banner.tsx`,
`modules/products/sections/product-description.tsx`,
`modules/products/types/checkout.d.ts`,
`modules/shopping/components/shopping-nav/index.tsx`,
`providers/cart-provider.tsx`, `schemas/cart/quote-schema.ts`,
`tests/cart-quote.test.ts`, `tests/cart-storage.test.ts`.

**Catalog (79606cc):** `actions/products/products/index.ts`,
`app/(shopping)/products/page.tsx`, `e2e/catalog.spec.ts`,
`modules/products/components/catalog-filters.tsx`, `prisma/schema.prisma`
(index declarations), `prisma/migrations/20261115001000_catalog_indexes/`,
`schemas/products/products-query-schema.ts`, `tests/public-actions.test.ts`.

**Order detail + schema (1326fcb):** `app/(my-orders)/my-orders/[id]/page.tsx`,
`app/(my-orders)/my-orders/page.tsx`, `e2e/order-detail.spec.ts`,
`modules/orders/components/order-timeline.tsx`, `prisma/schema.prisma`
(Refund/OrderEvent + Order relations),
`prisma/migrations/20261115000000_refunds_and_events/`.

---

## Self-review

- **Single pricing source.** The quote only accepts ids/quantities and derives
  paise from the DB with the same formula as `verifyAndPriceLines`
  (`Math.round(Number(price) × 100)`), and totals use `computeOrderTotals`.
  `createRazorpayOrder`'s input type no longer carries display prices, and the
  confirm/refund/webhook logic is unchanged.
- **Drift cannot be silent.** Cart and checkout compare quote `unitPaise`
  against the stored value (`hasPriceDrift` ignores missing lines, which are
  reported as issues) and render the warning even when the cart is otherwise
  purchasable. Blocking issues disable both "Proceed to Checkout" and "Proceed
  to Payment"; the server would refuse the charge anyway.
- **Legacy carts.** Migration is pure and test-pinned; the provider writes the
  new shape back on first read. Quantities are clamped to the 1–99 server
  bounds and duplicate lines merged, so a stale cart cannot generate an
  invalid quote.
- **Catalog consistency.** `findMany`/`count` share one `where`; price bounds
  are integers on the action boundary and decimal strings in SQL; the page
  sanitizes bad URLs (negative, non-numeric, inverted) to defaults instead of
  erroring.
- **Ownership.** The detail query filters by `userId` rather than loading then
  comparing, so a foreign id performs no cross-user read and 404s identically
  to a missing id.
- **Schema scope.** `Refund`/`OrderEvent` are created exactly once, here; 1B
  should extend the actions without adding another migration.

## Concerns / notes for Phase 1B

1. Quote totals include unavailable lines at their listed price (missing lines
   contribute 0) while payment is blocked; the banner explains this. If a
   different "payable subtotal" display is preferred, adjust `getCartQuote`.
2. The catalog page fixes `pageSize` at 12 while the action default stays 24
   (pinned by `tests/public-actions.test.ts`). Expose `pageSize` in the URL if
   a user-selectable page size is wanted.
3. Corrupt legacy cart rows (bad price/quantity) are dropped, not repaired;
   the cart is reconstructible and totals never become NaN.
4. `OrderTimeline` formats timestamps with `toLocaleString("en-IN")` in a
   server component. If 1B renders it inside a client component, pass
   preformatted strings (or a fixed timezone) to avoid hydration differences.
5. `Refund.status` / `OrderEvent.type` are strings by design; 1B owns the
   allowed value sets and must make the `razorpayRefundId` insert idempotent.
6. `e2e/order-detail.spec.ts` writes fixtures through Prisma using
   `DATABASE_URL`. It is safe against the local/CI database but must not be
   pointed at production.
7. The checkout page still sources line items from the localStorage
   `checkout-session` snapshot (existing flow). The quote validates that
   snapshot; it does not rebuild the session from `cart-items`.

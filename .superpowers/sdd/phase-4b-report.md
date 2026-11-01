# Phase 4B report — Admin analytics + search v2 + coupon follow-ups

## 4.3 Admin analytics dashboard
- Added `recharts@^3.10.1` (the only new runtime dependency).
- `lib/analytics/queries.ts`:
  - `parseAnalyticsRange` / `defaultAnalyticsRange`: UTC `YYYY-MM-DD`
    bounds, 30-day default (a lone `to` anchors the 30 days ending there),
    `from <= to`, 365 inclusive-day cap, calendar overflow (2026-02-31)
    rejected.
  - Dense revenue series (zero-filled days), revenue/order sums, AOV rounded
    once, zero-filled status breakdown, top-product ranking by quantity and
    revenue (tie-broken), low-stock filter/sort.
  - Four bounded queries in parallel: daily revenue/orders via `$queryRaw`,
    top product groups via `$queryRaw` (`LIMIT 50` scan, top 5 each list),
    `order.groupBy(status)` for the range, and at most 10 in-stock products
    with `stockQty <= 5`.
  - Revenue/AOV/rankings filter `status::text IN ('confirmed','shipped',
    'delivered')`; `pending`, `cancelled` and `refunded` never contribute.
    Queries use the existing `Order(status, createdAt)`, `OrderItem(orderId,
    productId)` indexes; no schema change.
- `app/(admin)/admin/analytics/page.tsx`: re-verifies ADMIN (layout also
  gates), renders KPI cards, the chart, status counts, top-product tables and
  the low-stock table; invalid ranges show a banner and fall back to 30 days.
- `modules/admin/components/revenue-chart.tsx`: client-only recharts
  `LineChart` (revenue/day) + `BarChart` (paid orders/day), fed plain JSON.
- Admin header now links to Analytics next to Coupons. Two analytics e2e
  smoke tests were added to `e2e/admin.spec.ts` (render + invalid range).

## 4.4 Search v2 (pg_trgm)
- Migration `20270101002000_search_trgm`: attempts
  `CREATE EXTENSION IF NOT EXISTS pg_trgm` inside a guarded DO block; when the
  extension exists it creates GIN `gin_trgm_ops` indexes on `Product.name`,
  `Product.tag` and `Product.description`. On a tier where the extension is
  unavailable the migration logs a NOTICE, skips the indexes and still
  applies (runtime falls back to ILIKE).
- `lib/search.ts` holds the ranked query and the fallback. One parameterized
  `$queryRaw` orders: exact lower(name), exact lower(tag), name prefix, name
  substring, then `GREATEST(similarity(lower(name), q), similarity(lower(tag),
  q))`; the filter covers name/tag/description ILIKE plus the indexable `%`
  trigram operator (pg_trgm default 0.3 threshold). Bound: 10 rows; selected
  fields remain id/name/thumbnail/price; price is the same 2-decimal string.
- The filter deliberately stays on `Product` columns only (no Category join):
  a cross-relation OR arm forces a join filter and defeats every trigram
  index. Consequence: category-name matching from v1 was dropped;
  description substring matching is retained.
- `actions/products/search/index.ts` keeps Zod (2-64 trimmed), 60/min/IP rate
  limit, `runAction` and `ActionResult`; on any raw-query failure it runs the
  old ILIKE query and logs `search_trigram_fallback` with a fixed reason code
  (never the raw error/SQL).
- Integration test `tests/integration/search-ranking.test.ts` (skips without
  `TEST_DATABASE_URL`) proves the three indexes exist, EXPLAIN can pick
  `Bitmap Index Scan` on the trgm indexes, typo `madhuani` ranks the
  Madhubani product, exact name/tag beat substring-only matches, and results
  cap at 10. `tests/search-fallback.test.ts` covers a mocked raw failure
  (query shape + redacted log). `tests/public-actions.test.ts` now pins the
  ranked query, parameterization and bound.

## Coupon follow-ups
- At-limit reuse: `lib/orders/coupon-redemption.ts` now exports
  `callerHoldsAbandonedRedemption` (own redemption on a `pending` order with
  `paymentId: ""`). `createRazorpayOrder` waives the `USAGE_LIMIT` rejection
  only for that caller and recomputes the discount with `usedCount: 0`; the
  existing guarded cancel + release inside the transaction still has to win.
  The cart quote performs the same authenticated check, otherwise payment
  would stay disabled for the retry the server now accepts.
- ₹1 floor copy: `minPayableAmountMessage(hasCoupon)` keeps "after the
  discount" only when a coupon was sent. The quote reports the floor for
  coupon-less carts too (unless a line issue already owns the message), and
  the checkout banner only appends "Remove or correct the coupon" when a code
  is applied. Coupon form errors are only rendered when a code is involved.
- Tests cover: final use held by the caller's abandoned order (quote and
  charge), paid redemption still rejected, another customer's final use still
  rejected, coupon-less sub-₹1 quote+charge copy.

## Verification
- `bunx prisma generate`: clean.
- `DATABASE_URL=postgresql://vendary:vendary@localhost:5432/vendary npx prisma migrate deploy`:
  `20270101002000_search_trgm` applied to the local DB; all three trgm indexes
  confirmed via `pg_indexes`.
- `npx vitest run`: 40 files passed / 2 skipped, 796 passed / 8 skipped
  (skips are the two DB-gated integration files).
- `TEST_DATABASE_URL=local npx vitest run tests/integration/search-ranking.test.ts`:
  5 passed.
- `npx tsc --noEmit`: clean.
- `npm run lint`: clean.
- `npm run format:check`: clean.
- `npm run build`: exit 0 (`/admin/analytics` 117 kB route chunk).
- `DATABASE_URL=local npm run e2e -- --grep-invert @payment`: 33 passed
  (adds the two analytics smoke tests; coupon/search suites green).

## Self-review
- Revenue math converts Decimal rupees to paise once; AOV divides integers
  and rounds once. Refunded/cancelled exclusion is pinned by asserting the
  bound status parameters in the raw queries (`pending` is absent too).
- Ranges are half-open at the query level (`>= from`, `< toExclusive`) so the
  last day is fully included; the day series is dense and capped at 365.
- Search keeps every existing boundary (rate limit before validation,
  trim/bounds, 10 rows, minimal select) and the old ILIKE query is preserved
  verbatim as the fallback; no error details reach logs.
- Coupon reuse cannot lock out a customer whose only held use is an abandoned
  checkout, while paid/confirmed or payment-proof orders still return
  CONFLICT. The quote and charge paths share one helper.
- No new PII/secret logging; admin analytics is server-fetched under the ADMIN
  layout plus an explicit page check.

## Concerns
- The pg_trgm migration is portable (guarded extension/index creation), but a
  tier without the extension gets ILIKE-only search and no typo ranking. A
  deploy that wants ranked search needs `pg_trgm` available and a role that
  may create the extension (or a pre-provisioned extension).
- `schema.prisma` cannot express GIN trigram indexes; `prisma migrate dev` may
  see them as drift, like the existing partial unique index. The project
  workflow uses `migrate deploy`.
- Top-product revenue is `SUM(OrderItem.price * quantity)` (pre-GST, gross of
  coupon allocation), while dashboard revenue/AOV use `Order.total`
  (post-discount, incl. GST). They are intentionally different lenses and do
  not sum to each other.
- Top-by-quantity is derived from the top 50 groups by revenue, so an item
  with high quantity but very low revenue outside that scan is not listed.
- Category-name search was dropped to keep the filter indexable on Product;
  if it is needed, it should be a separate category query merged after the
  ranked hits rather than an OR arm.
- `couponError` in the cart quote doubles as the generic pricing-block message
  for coupon-less carts; the name is historical and unchanged to avoid
  rippling through the quote schema and client contract.
- The `@payment` e2e subset was not rerun (out of this batch's gate); the
  non-payment suite covers the changed cart/checkout coupon paths.

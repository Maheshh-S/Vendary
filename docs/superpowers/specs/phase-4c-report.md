# Phase 4C report — recommendations, runbooks and 4B follow-ups

## Task 4.5 — "Customers also bought"

- `lib/recommendations.ts`:
  - Co-occurrence SQL over `OrderItem` self-joins, `COUNT(DISTINCT orderId)`,
    paid statuses only (`confirmed`/`shipped`/`delivered`; a pending order is an
    abandoned checkout, not a purchase), in-stock products only, current product
    excluded in SQL and defensively in JS, scan capped at 12, limit 4.
  - `rankCoPurchases` is a pure ranker (count desc, then product id) covered by
    unit tests; raw `Decimal` prices convert once to rupee numbers.
  - Cold start: when there are no co-purchases, or the raw query fails, it falls
    back to `availability: IN_STOCK`, `id != current`, ordered
    `isFeatured desc, createdAt desc`, take 4. If both queries fail the section
    is hidden (the product page never 500s for recommendations).
  - Per-product cache `recommendations:<id>:v1`, TTL 600s, JSON; Redis read/write
    failures fall through to the database. `invalidateProductCache(productId)`
    now drops this key; the TTL bounds cross-product/order staleness.
- `modules/products/components/also-bought.tsx` (server, presentational cards
  linking to product pages) rendered on `/products/[id]` after reviews.
- Tests `tests/recommendations.test.ts` (15): ranking/tie-break/exclusion,
  bigint counts, limit, paid-status + in-stock + scan SQL assertions, cache
  hit/write, read/write outage, cold-start fallback, query/fallback failure,
  invalid id guard, cache-key invalidation.
- E2E: product detail shows four fallback recommendation cards.

## Task 4.6 — deploy/incident runbooks and smoke

- `docs/runbooks/deploy.md`: Vercel + Neon Postgres + Upstash Redis + verified
  Resend domain + Razorpay webhook; environment matrix (including
  `AUTH_TRUST_HOST`, Node 22, `SKIP_ENV_VALIDATION` never in production);
  migrate-before-deploy order with direct-URL migrations and `pg_trgm`
  verification; Vercel/preview guidance; automated + manual smoke checklist;
  rollback (previous deployment, forward-only DB, `migrate resolve` policy);
  known limitations (Razorpay test vs live, optional/partial Sentry, extension
  fallback, optional Redis, external cron, print-to-PDF invoice).
- `docs/runbooks/incident.md`: triage for payment captured/no order (pending,
  cancelled late capture, OOS/amount-mismatch auto-refund, unknown order),
  refund failures (ledger/events, retry-once, `refund.processed` reconciliation,
  confirmed-only restock), stock mismatches, Redis down, webhook signature
  failures, cleanup cron (501/401/500), evidence checklist and escalation.
- `scripts/smoke.sh`: `--base-url` or positional URL, read-only `/`, `/products`,
  `/api/status` (`db: up`) checks, optional signed unknown-event webhook only
  when `RAZORPAY_WEBHOOK_SECRET` is set (never printed), non-zero exit on
  failure. `chmod +x`, `bash -n` clean; not executed against a live server
  because none was running on port 3000.
- README: fake live URL replaced with a placeholder, new "Live demo" and
  expanded "Deployment" sections link both runbooks and the smoke script;
  status/test-count copy refreshed.
- `.env.example`: documented `AUTH_TRUST_HOST`.
- `docs/ROADMAP.md`: Phase 2 items 9/10/12/13/14 completed, 15 partial;
  Phase 3 items 16–22 completed; Phase 4 24/26 completed, 23 (public demo) and
  25 (PDF file) left partial, 27 deferred.

## Phase 4B follow-ups

1. **Category-name search:** `categoryNameSearch` runs only after a successful
   ranked trigram query with slots left, filtered to `IN_STOCK`, excluding
   already-ranked ids, parameterized and bounded; results append after the
   ranked hits and are deduped to 10. The ILIKE fallback is unchanged and still
   covers category/description/name/tag. Unit tests cover merge/dedupe, the
   remaining-take bound and skipping the query when ranked hits fill ten.
2. **Analytics UTC bucketing:** revenue days now use
   `to_char(createdAt AT TIME ZONE 'UTC' AT TIME ZONE 'UTC', 'YYYY-MM-DD')` so
   the rendered day matches the UTC range bounds regardless of session
   `TimeZone`; the unit test asserts the SQL, and the SQL was executed against
   the local database.
3. **Cart floor message:** the cart page renders `quote.couponError` in a red
   status banner (quote-level blockers that are not per-line issues), so a
   coupon-less sub-₹1 cart shows why checkout is disabled.
4. **Analytics labels/tests:** top-product money is labelled "Gross item
   revenue" with a note that it is pre-tax/gross of coupon allocation and does
   not reconcile with order revenue; the daily and top-product raw queries are
   now asserted separately for the cancelled/refunded/pending exclusion.
5. **`server-only`:** added to `lib/analytics/queries.ts` and `lib/search.ts`;
   the unit and DB-gated tests mock it.

## Verification

- `npx vitest run`: 41 passed / 2 skipped files; 813 passed / 8 skipped tests.
- `TEST_DATABASE_URL=... npx vitest run tests/integration/search-ranking.test.ts`:
  5 passed (real pg_trgm path + new category merge).
- Recommendation, daily-revenue and fallback SQL executed read-only against the
  local seeded database: valid (`rows: 0/1/4`).
- `npx tsc --noEmit`: clean.
- `npm run lint`: clean.
- `npm run format:check`: clean.
- `DATABASE_URL=local npm run e2e -- --grep-invert @payment`: 34 passed
  (adds the also-bought fallback test; analytics/coupons/search suites green).
- `npm run build`: exit 0.
- `bash -n scripts/smoke.sh`: clean (no live base URL available to run it).

## Commits

- `540db73` feat(recommendations): cached also-bought co-purchase cards
- `a06f275` docs(ops): deploy and incident runbooks with a smoke script
- `24cafb1` fix(phase-4b): category search, UTC buckets, cart floor copy

## Self-review

- Money/order/refund/stock/webhook/status invariants untouched; no new runtime
  dependencies; no secrets or PII logged (smoke never echoes the secret, cache
  logs carry no payloads).
- Recommendations are read-only, bounded twice and failure-isolated from the
  product page.
- Search ranking keeps its indexable Product-only filter and its 10-row bound;
  the category query is a separate bounded statement, not an OR arm.
- UTC bucketing is explicit and session-independent (double `AT TIME ZONE`).
- Runbook commands match the repo (`prisma migrate deploy`, npm scripts) and
  the actual webhook/refund behavior; no fake deployment URL.

## Concerns

- Recommendation invalidation is partial by nature: an order or another
  product's stock change cannot enumerate affected product keys, so lists can
  be stale for up to 600s. Acceptable for non-money display data.
- The category search arm is in-stock only, while name/tag/description matches
  from the primary query still include out-of-stock products (pre-existing
  behavior, left unchanged).
- The cart floor banner has no component test (no React testing library in the
  repo) and cannot be reached in e2e without a sub-₹1 seeded product; the quote
  message itself is covered by coupon/cart-quote unit tests and the checkout
  page path by e2e.
- `SENTRY_DSN` initializes the SDK but the build is not wrapped with
  `withSentryConfig`; documented as a limitation rather than changed.
- The smoke script was syntax-checked only — no dev server or preview URL was
  running in this environment.

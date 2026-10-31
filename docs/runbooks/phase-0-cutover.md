# Phase 0 cutover runbook

Scope: deploy Phase 0.4 (order integrity) and 0.5 (review integrity, Analytics drop)
**together**. The migrations are `20261101000000_order_integrity`,
`20261101001000_review_integrity` and `20261101002000_drop_analytics`.

## 1. Pre-flight (read-only SQL, production)

Run every query and record the output. Do not auto-reconcile: fix rows by hand.

```sql
-- Must be 0 rows. Duplicates make the transactionId unique index fail.
SELECT "transactionId", COUNT(*) FROM "Order"
GROUP BY 1 HAVING COUNT(*) > 1;

-- Must be a subset of the enum. Any other value aborts the status cast.
SELECT DISTINCT "status" FROM "Order";

-- Must be 0 rows. Reconcile duplicates (keep the newest review) before the
-- Review_userId_productId_key unique index is created.
SELECT "userId", "productId", COUNT(*) FROM "Review"
GROUP BY 1, 2 HAVING COUNT(*) > 1;

-- Must be 0. The table is dropped; export rows first if this is not zero.
SELECT COUNT(*) FROM "Analytics";

-- OrderItem.productName is added and backfilled by the migration. Estimate the
-- placeholder rows first (deleted products get 'Unknown product'), then verify
-- after deploy: productName must never be NULL.
SELECT COUNT(*) FROM "OrderItem" oi
LEFT JOIN "Product" p ON p.id = oi."productId"
WHERE oi."productId" IS NOT NULL AND p.id IS NULL;
```

Take a verified `pg_dump` backup before scheduling the window.

## 2. Cutover

1. Freeze checkout (maintenance page or disable the create-order action) **or**
   drain open Razorpay checkouts first: no `pending` order may be paid while
   the migrations run.
2. Deploy 0.4 and 0.5 as one release. The previous release writes text
   statuses, which the enum cast rejects after commit — never mix versions.
3. Apply migrations in order, single instance or in the maintenance window:
   `20261101000000_order_integrity` → `20261101001000_review_integrity` →
   `20261101002000_drop_analytics`
   (`npm run db:migrate`, i.e. `prisma migrate deploy`).
4. Confirm `prisma migrate status` is clean, then re-open checkout.
5. Verify the backfill: `SELECT COUNT(*) FROM "OrderItem" WHERE "productName" IS NULL;`
   must be 0; the `'Unknown product'` count should match the pre-flight estimate.

## 3. Environment

Required in production: `DATABASE_URL`, `AUTH_SECRET` (≥32 chars),
`NEXT_PUBLIC_RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`,
`RAZORPAY_WEBHOOK_SECRET`, `NEXT_PUBLIC_SITE_URL`.
Optional: `AUTH_GOOGLE_ID`/`AUTH_GOOGLE_SECRET` (set together), `RESEND_API_KEY`,
`REDIS_URL` (cache and rate limiter fall back to memory when absent).

`SKIP_ENV_VALIDATION` must never be set in production: it bypasses the startup
fail-fast in `instrumentation.ts`. Startup must log no `[env]` error.

## 4. Rollback

- Redeploy the previous release first. Keep the DB forward-only.
- Do **not** reverse the enum or drop the unique indexes without a written plan:
  reverting the enum re-admits arbitrary status strings, and dropping
  `Order_transactionId_key` / `Review_userId_productId_key` re-admits duplicate
  payments/reviews that the app now assumes impossible.
- If data must be restored, use the pre-cutover backup; migration reversal is a
  last resort, not a rollback button.
- A pending order cancelled before Phase 1 has no refund path — admins cannot
  cancel pending orders in this release, so do not re-enable that edge manually.

## 5. Post-deploy smoke

1. **Init → confirm**: checkout a low-value item; the row is `pending` with a
   `transactionId`, then paying confirms it, decrements stock, and invalidates
   the product cache.
2. **Webhook backstop**: resend `payment.captured` for that order; the route
   returns 200 and the confirmed order is unchanged (idempotent).
3. **Refund webhook restock**: refund a confirmed order in Razorpay; the
   `refund.processed` webhook moves it to `refunded` and restores each line
   exactly once (null `productId` lines skipped).
4. **Admin mutation**: `/admin` status select works for confirmed → shipped;
   pending rows show no options; cancel/refund asks for confirmation and the
   action remains record-only (no Razorpay refund).
5. **Search**: a ≥2-character term returns results; a >64-character term is
   capped client-side and the server rejects an oversized term.
6. **Logs**: no `[env]`, `[redis]` fallback loops, or `order_refund_close_race`
   entries after the smoke.

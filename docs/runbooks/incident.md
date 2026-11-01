# Incident runbook — Vendary

Task 4.6. Triage and recovery for the money, stock, cache and webhook paths.
All production access is read-only until a fix is agreed; every manual mutation
needs a second pair of eyes and an audit note (Razorpay dashboard action, admin
action or a reviewed SQL statement).

## 0. First five minutes

1. Check the deep health endpoint:
   `curl -sS https://<your-domain>/api/status` → `{status, checks:{db, redis}}`.
   DB down is a hard outage; Redis down is degraded but self-healing.
2. Open Vercel logs for the deployment and filter for `level:"error"` and the
   event names below. Check Sentry if `SENTRY_DSN` is configured.
3. Check the Razorpay dashboard (payments/refunds/webhook deliveries) and the
   Neon/Upstash status pages.
4. Classify:
   - **SEV1** — checkout/payment/refund broken, data loss, wrong money or stock.
   - **SEV2** — one feature degraded (search, recommendations, email, analytics).
   - **SEV3** — cosmetic or a workaround exists.
5. Escalate SEV1 immediately to the repository owner/on-call engineer with the
   evidence below. Freeze deploys until the incident is understood.

Never: create an order by hand from a payment, mark an unpaid order `confirmed`,
issue a second refund without checking the Razorpay refund list, delete
`OrderEvent`/`Refund` rows, or run `migrate dev`/`db push`/`migrate reset`
against production.

## 1. Payment captured, no order (or order still pending)

The client callback (`PlaceOrder`) and the signed webhook are both status
drivers; the webhook is the backstop. The order id on Razorpay is our
`Order.transactionId`.

1. Find the order:
   ```sql
   SELECT id, status, "paymentId", "transactionId", total, "createdAt", "updatedAt"
   FROM "Order"
   WHERE "transactionId" = '<razorpay_order_id>';
   ```
2. Find the payment in the Razorpay dashboard and note `payment.id`, status,
   amount and captured time.
3. Cases:
   - **No order row:** log event `webhook_order_not_found`. The app cannot
     conjure an order from a payment. Refund the capture in the Razorpay
     dashboard (reason "no matching order") and open a bug with both ids.
   - **Order `pending`, payment captured:** check webhook deliveries for
     `payment.captured`. If not delivered, resend it from the dashboard. The
     webhook confirms with the same stock-safe claim as the client. If the
     amount differs, the webhook auto-refunds with reason `AMOUNT_MISMATCH`;
     do not confirm manually.
   - **Order `pending`, webhook confirmed but failed `OUT_OF_STOCK`:** the
     webhook auto-refunded with reason `OUT_OF_STOCK`; the order becomes
     `refunded` and the `Refund` ledger row records the refund. If the Razorpay
     refund call itself failed, the order stays `pending` with the payment id
     recorded, the webhook logs `webhook_refund_failed` and acknowledges (a
     retry would no-op), so recovery is support-led.
   - **Order `cancelled` with `paymentId = ""`:** a late capture after
     cancellation. The webhook refunds it in full and leaves it `cancelled`
     (`refund.processed` will restock nothing because stock was never
     decremented).
   - **Order `cancelled` with a `paymentId`:** a replay/duplicate delivery; the
     route acknowledges and skips. Verify only one refund exists.
   - **Order already `confirmed`/`shipped`/`delivered`:** the capture was
     already handled; a duplicate delivery is a no-op.
4. Evidence: Razorpay order id + payment id, amount/captured time, order row,
   `OrderEvent` rows (`SELECT * FROM "OrderEvent" WHERE "orderId" = ...`),
   webhook delivery attempts (status codes), matching Vercel log lines
   (`webhook_order_not_found`, `webhook_confirm_lost_claim`,
   `webhook_refund_failed`, `payment_failed`).

## 2. Refund failures

Refunds are full-order only. A failed Razorpay call records a `refund_failed`
event and leaves the order status untouched; the customer may retry from the
order page, or an admin can retry from `/admin`.

1. Inspect the ledger and the event trail:
   ```sql
   SELECT * FROM "Refund" WHERE "orderId" = '<order_id>';
   SELECT * FROM "OrderEvent" WHERE "orderId" = '<order_id>' ORDER BY "createdAt";
   ```
2. Check the Razorpay dashboard: was a refund actually created despite the
   error (timeout/DNS)? If yes, do **not** retry; wait for/replay the
   `refund.processed` webhook, which reconciles the ledger row and restocks.
3. If no refund exists, retry **once** through the admin/order-page action.
   `Refund.orderId` is unique, so two operators cannot double-refund; a retry
   reuses the ledger claim.
4. If Razorpay keeps failing (invalid key, insufficient balance, KYC), record
   the provider error code in the incident, keep the order in its current paid
   status, and escalate to the Razorpay dashboard/manual refund flow after
   reconciling.
5. `refund.processed` restocks only orders that were `confirmed` when the
   refund was requested. Shipped/delivered goods are not restocked; a pending
   order never decremented stock. Do not "correct" stock by hand for those.

Evidence: order id, payment id, refund id/status, provider error code and
timestamp, `Refund` row, `OrderEvent` rows, webhook deliveries.

## 3. Stock mismatch

Stock is decremented exactly once inside the order-confirm transaction, and
restored exactly once by the refund transition. `pending` orders never reserve
stock, so an abandoned checkout does not move it.

1. Compare the product row with the paid order lines:
   ```sql
   SELECT p.id, p.name, p."stockQty", p.availability,
          COUNT(o.id) AS paid_lines,
          COALESCE(SUM(oi.quantity) FILTER (WHERE o.id IS NOT NULL), 0) AS paid_qty
   FROM "Product" p
   LEFT JOIN "OrderItem" oi ON oi."productId" = p.id
   LEFT JOIN "Order" o ON o.id = oi."orderId"
    AND o.status::text IN ('confirmed', 'shipped', 'delivered')
   WHERE p.id = '<product_id>'
   GROUP BY p.id;
   ```
   Only lines whose order is `confirmed`/`shipped`/`delivered` count: `o.id`
   is null for items of pending, cancelled or refunded orders, and both
   aggregates ignore those rows. (A `LEFT JOIN` without the `o.id` guard would
   report every `OrderItem` ever created as a paid line.)
2. Check the product's order history and refunds:
   `pending`/`cancelled` orders without payment did not move stock;
   `refunded` orders restored it only if they were `confirmed` at refund time.
3. Confirm whether checkout is currently overselling (stock 0 but
   `availability = IN_STOCK`). If so, take the product offline via
   `/admin` until reconciled.
4. Adjust `stockQty`/`availability` only with approval, using a reviewed
   `UPDATE "Product" ...` plus an incident note. There is no dedicated stock-edit
   screen in this release; do not invent one during an incident.
5. After the fix, re-check `low stock` on `/admin/analytics` and place a test
   checkout to prove decrement, then refund it to prove restore.

Evidence: product id, before/after stock, affected order ids and statuses,
refund rows, event trail, timeline of mutations.

## 4. Redis down

Redis is optional and derived: every cache read falls back to Postgres, and the
rate limiter falls back to a per-instance memory window. `/api/status` reports
`degraded` with `redis: "down"` but stays HTTP 200. No data is lost.

1. Confirm the outage in `/api/status` and the Upstash console; check the Vercel
   logs for `redis_client_error`.
2. Common causes: Upstash database paused/deleted, wrong URL, missing TLS
   (`rediss://` on Upstash), or network restrictions.
3. If the URL changed, update `REDIS_URL`, redeploy/restart, and confirm
   `/api/status` returns `ok`.
4. While degraded, expect slower catalog pages and weaker rate limiting across
   multiple Vercel instances; no other action is required. Caches repopulate
   automatically (600s featured/recommendation TTL, 300s product details).

Escalate only if Postgres is also unhealthy or the cache outage causes error
responses (it should not).

## 5. Webhook signature failures

A rejected webhook is HTTP 400 `Invalid signature` and has **no side effects**;
Razorpay retries with backoff. Do not disable verification to "fix" it.

1. Confirm the endpoint URL and mode. Test-mode and live-mode webhooks have
   different secrets; a live webhook registered with a test secret (or vice
   versa) rejects every delivery.
2. Verify `RAZORPAY_WEBHOOK_SECRET` in Vercel matches the dashboard exactly
   (no whitespace/newline from copy-paste). Rotate both sides together, then
   redeploy.
3. Check the raw request body was not modified by a proxy. The HMAC is computed
   over the exact bytes; our route reads `req.text()` before parsing.
4. Validate the path with the smoke probe:
   `RAZORPAY_WEBHOOK_SECRET='...' scripts/smoke.sh --base-url https://<your-domain>`
   (an unknown event must return 200).
5. After fixing, replay the failed deliveries from the Razorpay dashboard and
   confirm `pending` orders advance. Signatures are always verified; there is no
   bypass flag.

Evidence: delivery attempt status codes, dashboard event ids, webhook endpoint,
secret last-rotated time (never paste the secret), matching Vercel logs.

## 6. Cleanup cron

`POST /api/cron/cleanup` cancels abandoned `pending` orders older than 60
minutes with no recorded payment, deletes stale checkout addresses older than
24h, drops the featured cache, and returns
`{cancelledOrders, deletedAddresses}`.

1. Status codes:
   - **501** — `CRON_SECRET` is not set; the endpoint stays closed.
   - **401** — missing/wrong `Authorization: Bearer <CRON_SECRET>` header.
   - **500** — transaction/DB failure; the scheduler should retry, reruns are
     idempotent.
2. Verify the scheduler sends the exact bearer header and runs in UTC; a paused
   scheduler lets `pending` rows and addresses accumulate.
3. Manual run (safe, idempotent):
   `curl -sS -X POST https://<your-domain>/api/cron/cleanup -H "Authorization: Bearer $CRON_SECRET"`
4. Rows with a recorded `paymentId` are never touched — they belong to the
   money path and must be reconciled through the payment/refund sections.
5. After a cleanup run, spot-check that a recent pending checkout was not
   cancelled (the 60-minute cutoff is based on `createdAt`).

## 7. Evidence checklist

Collect, with timestamps in UTC:

- `/api/status` response and the time it was taken.
- Order id, `transactionId`, `paymentId`, amount, status; `OrderItem` snapshot.
- Razorpay payment/refund ids and dashboard status; webhook delivery attempts.
- `OrderEvent` and `Refund` rows for the affected order(s).
- Vercel log excerpts around the incident (`webhook_*`, `[env]`,
  `redis_client_error`, `search_trigram_fallback`, `order_email_failed`,
  `password_reset_email_*`, unhandled 500s).
- Mail evidence: Resend delivery status and the configured `EMAIL_FROM` sender
  (never the API key). All transactional mail — verification, reset and order —
  sends from `EMAIL_FROM` and is skipped, not queued, when `RESEND_API_KEY` or
  `EMAIL_FROM` is missing.
- Deployment SHA/URL and the last successful deploy time.
- Reproduction steps, affected customer/order counts, and whether money or
  stock is wrong.

Redact PII and secrets: order/payment ids are enough; never attach full
addresses, emails, card data or env values.

## 8. Escalation

- **SEV1:** repository owner/on-call engineer immediately; freeze deploys, open
  an incident doc, update status every 30 minutes. If money is involved, involve
  the Razorpay dashboard owner for refunds/reconciliation.
- **SEV2:** owner within the business day; workaround first, fix forward.
- **SEV3:** normal issue tracker.
- A rollback decision follows `docs/runbooks/deploy.md` §7: application first,
  schema forward-only. Record every manual DB action in the incident doc.

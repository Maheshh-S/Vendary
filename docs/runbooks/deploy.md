# Deploy runbook — Vendary

Task 4.6. This runbook deploys Vendary to **Vercel** with **Neon Postgres**,
**Upstash Redis**, a **verified Resend domain** and a **Razorpay webhook**. It is
provider-specific but the app has no other runtime services: the storefront,
server actions, webhook route and admin all run in one Next.js deployment.

The repo ships no live URL. Replace `<your-domain>` below with the custom domain
you attach in Vercel.

## 1. Topology and prerequisites

| Component | Purpose | Notes |
|---|---|---|
| Vercel (Next.js 15, Node 22.x) | App, server actions, webhook route, cron target | `output: "standalone"` is also used by the Docker image |
| Neon Postgres | Orders, catalog, auth, coupons, refunds | `pg_trgm` recommended for ranked search |
| Upstash Redis | Product/featured/recommendation cache, rate limiting | Optional; every cache read falls back to Postgres |
| Resend | Verification + order lifecycle email | Requires a verified sending domain for production |
| Razorpay | Payments + refunds + webhook backstop | Start in test mode; live mode requires KYC |
| External scheduler | `POST /api/cron/cleanup` with `CRON_SECRET` | Not configured by this repo |

Node runtime: Vercel project settings → **Node.js 22.x**. `AUTH_TRUST_HOST=true`
is required behind Vercel's proxy so Auth.js trusts the forwarded host. The app
fails fast at boot when a required variable is missing or malformed
(`instrumentation.ts` → `lib/env.ts`); the thrown message lists variable names
only.

## 2. Environment matrix

Set these in Vercel → Project → Settings → Environment Variables (Production;
repeat for Preview with **separate** infrastructure).

| Variable | Required | Example / notes |
|---|---|---|
| `DATABASE_URL` | yes | Neon **pooled** connection string (`...-pooler...`, `sslmode=require`) used by the app |
| `AUTH_SECRET` | yes | ≥ 32 chars, `openssl rand -base64 32`; rotating it signs everyone out |
| `AUTH_TRUST_HOST` | yes on Vercel | `true` |
| `NEXT_PUBLIC_RAZORPAY_KEY_ID` | yes | Razorpay key id (safe for the browser) |
| `RAZORPAY_KEY_SECRET` | yes | Server only; test and live keys differ |
| `RAZORPAY_WEBHOOK_SECRET` | yes | Must match the webhook registered for the **same mode** |
| `NEXT_PUBLIC_SITE_URL` | yes | `https://<your-domain>`; used in emails and metadata |
| `BASE_URL` | optional | Overrides the email link origin; defaults to `NEXT_PUBLIC_SITE_URL` |
| `REDIS_URL` | recommended | Upstash TLS URL (`rediss://...`); blank disables cache/central rate limiting |
| `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` | optional | Set both or neither; redirect URI `https://<your-domain>/api/auth/callback/google` |
| `RESEND_API_KEY` | optional | Required for verification/order email |
| `EMAIL_FROM` | optional | e.g. `Vendary <orders@your-domain>`; domain must be verified in Resend |
| `ORDER_NOTIFICATION_EMAIL` | optional | Store inbox copy of order emails |
| `SELLER_GSTIN` | optional | Printed on invoices; omitted when blank |
| `SENTRY_DSN` | optional | Enables the SDK in `initMonitoring`; no build plugin is wired |
| `LOG_LEVEL` | optional | `debug` \| `info` \| `warn` \| `error` (blank = `info`) |
| `CRON_SECRET` | optional | Bearer secret for `/api/cron/cleanup`; route returns 501 when unset |
| `SKIP_ENV_VALIDATION` | **never in production** | `1` bypasses the startup assertion; CI/Docker builds only |

Keep `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `CRON_SECRET` and
`DATABASE_URL` out of logs and out of preview deployments that share production
data.

## 3. Provisioning

### Neon

1. Create a project/database (Postgres 16+). Copy the **pooled** connection
   string for `DATABASE_URL` and keep the **direct** (non-pooler) host for
   migrations.
2. Ensure the role can create extensions, or pre-create `pg_trgm` as the
   database owner:
   `CREATE EXTENSION IF NOT EXISTS pg_trgm;`
   The migration `20270101002000_search_trgm` is guarded: without the extension
   it logs a NOTICE, skips the GIN indexes and still applies. Search then uses
   the ILIKE fallback instead of trigram ranking.
3. Take a backup or a Neon branch before the first production migration.

### Upstash

Create a Redis database and copy the TLS URL into `REDIS_URL`. Without it the
app works, but caches fall through to Postgres and the rate limiter uses a
per-instance memory window (approximate across Vercel instances).

### Resend

Add and verify the sending domain, then set `RESEND_API_KEY` and `EMAIL_FROM`.
Unverified domains/`onboarding@resend.dev` are for local testing only; production
order emails are skipped when `EMAIL_FROM` is blank.

### Razorpay

1. Register `https://<your-domain>/api/razorpay/webhook` in Dashboard →
   Settings → Webhooks with events `payment.captured`, `payment.failed` and
   `refund.processed`.
2. Copy the generated webhook secret into `RAZORPAY_WEBHOOK_SECRET`. Test-mode
   and live-mode webhooks have different secrets; never mix them.
3. Set `NEXT_PUBLIC_RAZORPAY_KEY_ID` + `RAZORPAY_KEY_SECRET` for the same mode.
4. The minimum payable amount is ₹1 (Razorpay's floor); carts below it are
   blocked in the quote with an explicit message.

## 4. Migration order (before deploy)

Migrations are additive and the previous deployment keeps serving while they
run. Always apply them **before** deploying code that needs them — never after.

1. **Back up**: Neon branch or `pg_dump`.
2. From the exact release commit (CI or a trusted workstation):
   ```bash
   DATABASE_URL='postgresql://...direct-host.../vendary?sslmode=require' \
     npx prisma migrate deploy
   ```
   This is `npm run db:migrate` / `bun run db:migrate`. It applies pending
   migrations in timestamp order and never runs seeds or `migrate dev`.
3. Verify:
   ```bash
   DATABASE_URL='...direct...' npx prisma migrate status
   ```
   No pending or failed migrations. On a `pg_trgm`-capable database:
   ```sql
   SELECT indexname FROM pg_indexes
   WHERE tablename = 'Product' AND indexname LIKE '%trgm%';
   ```
4. Deploy the application (Vercel build). The build runs `prisma generate`
   (postinstall) only — it never migrates or seeds.

If a migration fails mid-run, stop. Do **not** rerun blindly; inspect
`_prisma_migrations`, fix the cause, and use `prisma migrate resolve` only for a
known partial state (see rollback).

## 5. Vercel project

1. Import the repository; framework preset **Next.js**, build command
   `npm run build`, install command default (bun when `bun.lock` is detected).
2. Add the production variables from the matrix. `SKIP_ENV_VALIDATION` must be
   absent.
3. Deploy, attach the custom domain, and set `NEXT_PUBLIC_SITE_URL` (and
   `BASE_URL` if used) to the final `https://` origin. Redeploy after changing a
   `NEXT_PUBLIC_*` value — it is inlined at build time.
4. Preview deployments: point `DATABASE_URL` at a Neon branch and use test-mode
   Razorpay keys. Never share the production database or live webhook secret.

## 6. Smoke checklist

Automated (read-only, exits non-zero on failure):

```bash
scripts/smoke.sh --base-url https://<your-domain>
# With a signed webhook probe (test or live mode secret):
RAZORPAY_WEBHOOK_SECRET='...' scripts/smoke.sh --base-url https://<your-domain>
```

The script checks `/`, `/products`, `/api/status` (`db: up`) and, only when a
webhook secret is supplied, one signed unknown-event webhook that must return
200 with no side effects.

Manual, in a signed-out browser:

1. Home, catalog (pagination/sort/price filter) and a product detail page render;
   "Customers also bought" shows four in-stock products (featured fallback).
2. Search `madhuani` returns the Madhubani product; a category name returns its
   products.
3. Add to cart, open `/cart`: quote agrees with the total; a sub-₹1 cart shows
   the minimum-amount message and checkout stays disabled.
4. Sign in with a test customer, apply a valid coupon, place a **Razorpay test
   mode** order (test card/UPI). Confirm:
   - order moves `pending → confirmed`, stock decrements once,
   - Razorpay dashboard shows the payment for the same amount,
   - order confirmation email arrives (if Resend configured),
   - `/my-orders/<id>` and the printable invoice render.
5. Resend the `payment.captured` webhook from the Razorpay dashboard: the route
   returns 200 and the order is unchanged (idempotent).
6. Cancel/refund the test order from admin or the order page; verify the refund
   row, the `refund.processed` webhook handling and stock restoration.
7. Admin: analytics range renders (revenue excludes cancelled/refunded), coupons
   CRUD works, order status transitions are allowed.
8. `/api/status` is `ok` (or `degraded` only when Redis is intentionally down);
   Vercel logs contain no `[env]`, `webhook_processing_failed` or unhandled 500s.
9. Schedule the cleanup job externally: `POST /api/cron/cleanup` with
   `Authorization: Bearer $CRON_SECRET`; expect 200 and a JSON result.

## 7. Rollback

**Application:** Vercel → Deployments → previous successful deployment →
Promote to Production (or `vercel rollback <deployment-url>`). Re-run the smoke
script against the restored URL.

**Database:** forward-only. Never edit an applied migration, run
`migrate dev`/`db push` against production, or manually reverse a migration as a
rollback button.

- Roll back the app first; additive schema changes are harmless to older code.
- If the schema change itself must be undone, ship a **new compensating
  migration**, test it on a Neon branch, then deploy.
- `prisma migrate resolve --rolled-back <migration>` is only for a failed,
  partially applied migration after manual inspection — reconcile the actual
  database state first.
- Restore data from the Neon branch/`pg_dump` only for real data loss; record the
  restore timestamp and the orders/payments created after it.
- After rollback, replay missed Razorpay webhooks from the dashboard and
  reconcile `pending` orders before re-enabling checkout.

## 8. Known limitations

- **Razorpay test vs live.** The demo can run entirely in test mode; test keys
  cannot collect real money. Live mode needs completed KYC, live keys and a
  separately registered live webhook + secret. Never mix test/live credentials.
- **Sentry is optional and partially wired.** The SDK initializes when
  `SENTRY_DSN` is set, but the build is not wrapped with `withSentryConfig`
  (no source-map/release upload). Structured logs remain the primary signal.
- **Ranked search needs `pg_trgm`.** On a tier where the extension cannot be
  created, the migration still applies and search degrades to ILIKE.
- **Redis is optional.** Without Upstash, caches fall through to Postgres and
  rate limiting is per-instance memory, not global.
- **Cleanup cron is external.** The repo does not create a Vercel cron; without
  a scheduler, abandoned `pending` orders and stale addresses are not swept.
  The route 501s until `CRON_SECRET` is set.
- **Invoices are printable HTML,** not generated PDFs; use the browser's
  print-to-PDF.
- **Emails need a verified Resend domain.** Order/verification email is skipped
  when Resend or `EMAIL_FROM` is missing.
- **`SKIP_ENV_VALIDATION` must never be set** on a real deployment; it disables
  the startup fail-fast.

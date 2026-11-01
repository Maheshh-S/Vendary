# Vendary implementation report — Phase 0 to Phase 4

**Status:** complete and merged into `main`
**Verification:** 818 unit tests + 8 database integration tests + 36 Playwright e2e
tests (including a paid Razorpay checkout) passing; `tsc`, ESLint, Prettier,
production build, Docker health check and the smoke script pass.

This report explains what was built, how it works, how to exercise it manually,
and how the app behaves compared with the original version.

---

## 1. What changed, by phase

### Phase 0 — Validation, authorization and money integrity

**Outcome:** the payment path is database-guarded rather than hope-based.

- One result contract for server actions (`ActionResult`, `AppError`,
  `runAction`, `parseInput`) and shared auth guards (`requireUser`,
  `requireAdmin`).
- Runtime environment validation (`lib/env.ts`) with production fail-fast and a
  build-safe escape hatch.
- Redis-backed rate limiting with a bounded timeout and memory fail-open:
  login, registration, payment init, search, reviews and every admin mutation.
- Durable checkout: a `pending` order, address and item snapshots are created
  **before** the client receives a payable Razorpay order id.
- Database-enforced integrity: `OrderStatus` enum, unique Razorpay transaction
  id, order-item name/image snapshots with `ON DELETE SET NULL`, one review per
  user/product.
- Typed Razorpay webhook (HMAC → JSON → Zod → DB) for `payment.captured`,
  `payment.failed`, `refund.processed`; idempotent claim-based confirmations,
  refunds and stock restoration.
- Admin mutations: Zod validation, ADMIN role, rate limiting, single-store
  catalog, shared image-host allowlist.
- Order status state machine; admins cannot confirm or cancel unpaid pending
  orders. Stock is decremented/restored exactly once through compare-and-set
  claims.
- Public query bounds (search, product list), review integrity, featured filter,
  Analytics model removed.
- Cutover runbook: `docs/runbooks/phase-0-cutover.md`.

### Phase 1 — Checkout truth, order lifecycle and customer visibility

**Outcome:** the total shown is the total charged, and orders can be inspected,
cancelled and refunded.

- Server cart quote: paise-native cart storage, authoritative prices, drift and
  availability banners, payment blocked while the quote is loading, stale or
  invalid.
- Catalog pagination, sorting, category and price filters, real database
  indexes; URL-driven state.
- Customer order detail with item snapshots, address, masked payment id,
  timeline and refund history; foreign ids 404.
- Cancel/refund: customer cancel (pending/confirmed), admin refund
  (confirmed/shipped/delivered), Razorpay full refunds, `Refund` ledger rows,
  `OrderEvent` audit trail, stock restored only from confirmed, late-capture
  backstop for cancelled pending orders.
- Transactional order emails (confirmation, shipped, delivered, cancelled,
  refunded) with idempotency and non-fatal failures.
- Admin search/pagination across products and orders, creator email.
- Result-contract UX sweep across every client mutation.
- E2E: catalog, cart drift, order detail, cancellation, payment.

### Phase 2 — Accounts, reviews and invoices

**Outcome:** customers can recover accounts, manage addresses and profile, trust
reviews, and print an invoice.

- Password reset (forgot/reset pages, one-time expiring tokens, enumeration-safe
  response, per-email/per-IP limits, fixed token-by-email lookup).
- Saved address book (max 10, one default, partial unique index, checkout
  prefill) with an immutable order-address snapshot.
- Profile and password change (current-password check, avatar allowlist, reset
  token invalidation, JWT caveat documented).
- Verified-purchase badge, one review per user/product, edit/delete own review,
  aggregate rating/count across all reviews.
- Printable GST invoice for paid orders only, owner-only, stored snapshot
  totals, optional `SELLER_GSTIN`, print/save-as-PDF.
- E2E: account, password reset, invoice, address clearing, pending-invoice 404.

### Phase 3 — Operations, security and CI

**Outcome:** failures are observable and the deployment/CI path is explicit.

- Structured, redacting logger; optional Sentry capture (server side, no DSN →
  no-op) with frame-variable scrubbing and a chunk-split regression test.
- Deep `/api/status` (DB + Redis, 200/503, no-store); Hono stub removed.
- Enforced CSP (Razorpay hosts, worker-src, report-uri) and a rate-limited CSP
  report collector; a real Razorpay checkout modal is loaded under enforcement
  in e2e with zero violations.
- CI: Postgres service, migrations, seed, Playwright browser cache, e2e subset,
  migration drift check with a shadow DB, dependency audit (non-blocking),
  lint/type/unit/build.
- Prettier, Husky + lint-staged, format check, no tracked `.DS_Store`.
- Operational indexes and a secret-gated cleanup cron: cancels stale unpaid
  pending orders, releases coupons, deletes orphan addresses, invalidates the
  featured cache.

### Phase 4 — Differentiators

**Outcome:** discounts, saved products, revenue insight, relevant search and a
real deploy path.

- Coupons: percent/fixed paise math, windows, minimum subtotal, usage caps,
  max-discount, GST on the discounted subtotal, one redemption per order,
  abandoned-checkout reuse, release on unpaid cancellation, admin CRUD,
  checkout apply/remove.
- Wishlist: one row per user/product, idempotent toggle, product-card and detail
  hearts, `/wishlist`, login return path with open-redirect protection.
- Admin analytics: revenue by day, AOV, order status, top products, low stock;
  recharts dashboard; date-range validation; refunds/cancelled excluded.
- Search v2: `pg_trgm` extension + GIN indexes, similarity ranking, ILIKE
  fallback, category merge, bounded and rate-limited.
- “Customers also bought”: co-purchase ranking, cache, featured fallback.
- Deploy/incident runbooks, `scripts/smoke.sh`, README/roadmap updates.

---

## 2. How it works (key architecture)

- **Money:** PostgreSQL `Decimal(10,2)` rupees; the wire, quote and invoice math
  use integer paise (`Math.round`). The server re-prices every cart from the
  database; client prices are display-only.
- **Orders:** order rows are created `pending` at checkout init; the Razorpay
  signature and captured amount are verified before a claim moves the order to
  `confirmed`. Stock is conditional (`stockQty >= quantity`) and restored only
  from `confirmed` by a claim winner.
- **Refunds:** a unique `Refund.orderId` row is the lock; Razorpay is called
  after the claim, and the order/stock/audit events finalize only on success.
  Failed refunds leave the order unchanged with a `refund_failed` event.
- **Webhooks:** raw-body HMAC, then JSON, then Zod, then DB. Events are
  idempotent and reconcile orders the client callback missed.
- **Actions/UI:** every server action validates with Zod and returns
  `{ok:true,data}` or `{ok:false,code,message,fieldErrors}`. Client forms check
  `res.ok` and surface the message.
- **Caching:** Redis-backed product/featured caches with TTLs and invalidation
  on mutations/restocks; cache outages fall through to the DB.
- **Observability:** JSON logs with redaction; optional Sentry; deep health;
  CSP violation reports.

---

## 3. Verification results

| Gate | Result |
|---|---|
| Unit tests | 818 passed, 8 DB-gated skipped |
| DB integration tests | 8 passed (address book, trigram search) |
| Playwright e2e | 36 passed: smoke, catalog, cart drift, coupons, wishlist, order detail, cancel, invoice, account, password reset, admin, CSP/Razorpay modal, **paid checkout** |
| Type check | `tsc --noEmit` exit 0 |
| Lint / format | clean |
| Production build | exit 0 |
| Docker | image built, container healthy, `/api/status` 200 |
| Smoke script | 4/4 against a local server (signed webhook 200) |

Commands used:

```bash
npm test                                  # unit
TEST_DATABASE_URL=... npx vitest run tests/integration
npx tsc --noEmit && npm run lint && npm run format:check
npm run build
npm run e2e                               # all, including @payment
```

---

## 4. How to test it manually

### 4.1 Start locally

```bash
docker compose up -d db redis

# local env (overrides the production/Neon .env)
cat > .env.local <<'EOF'
DATABASE_URL=postgresql://vendary:vendary@localhost:5432/vendary
REDIS_URL=redis://localhost:6379
NEXT_PUBLIC_SITE_URL=http://localhost:3000
BASE_URL=http://localhost:3000
EOF

bun install
bunx prisma migrate deploy
bun run db:seed
npm run dev
```

Open <http://localhost:3000>.
Demo admin: **admin@vendary.test / Admin@1234**.
For a paid checkout, set Razorpay **test-mode** keys in `.env` and pay with the
test card shown in the Razorpay dashboard.

### 4.2 Customer walkthrough

1. **Home / catalog** — browse, then use `/products` pagination, sort, category
   and price filters. Open a product.
2. **Search** — open search and type `madhuani` (typo); the Madhubani product
   should rank. Exact names/tags rank first.
3. **Wishlist** — click the heart as a guest; log in and you should return to
   the product. Open `/wishlist`, add an item to the cart, remove it.
4. **Cart** — add two products, open `/cart`. The quote comes from the server.
   To see the drift banner, edit `cart-items` in localStorage (bump
   `unitPaise`), reload the cart.
5. **Coupons** — as admin create a code at `/admin/coupons` (e.g. `WELCOME10`,
   10% off). Apply it at checkout; the discount is taken before GST. Try an
   invalid or expired code: payment stays disabled.
6. **Checkout** — use a saved address, complete the Razorpay test payment. You
   should land on `/my-orders` with a `confirmed` order.
7. **Order detail** — open the order: snapshots, totals, timeline, masked
   payment id, refunds. Print the invoice from a paid order; a pending order has
   no invoice link and its invoice URL 404s.
8. **Cancel / refund** — a pending unpaid order can be cancelled by the
   customer; a confirmed order triggers a full Razorpay refund and restores
   stock. The order detail shows the `Refund` row and events.
9. **Account** — update your name, add/edit addresses (clear Label/Line 2 and
   confirm they persist as empty), change your password (current password
   required), and use “Forgot password” (requires Resend/verified sender; the
   token link is in the email, or create a token in the DB for local testing).
10. **Reviews** — after a confirmed purchase, add a review; it shows “Verified
    purchase”. Add a second one: it is rejected. Edit/delete your own review.
    The product rating uses all reviews.

### 4.3 Admin walkthrough

1. `/admin` — search products/orders, paginate, edit price/description,
   availability, images, delete; create a manual product.
2. Change an order to `shipped` then `delivered`; try an illegal transition
   (rejected). Cancel/refund requires confirmation that no Razorpay refund is
   issued by the record-only status override; use the real refund action for
   money movement.
3. `/admin/analytics` — pick a date range; revenue/AOV/top products exclude
   cancelled and refunded orders; low stock is listed.
4. `/admin/coupons` — create, edit, reactivate/deactivate a coupon.

### 4.4 Ops walkthrough

```bash
curl -s localhost:3000/api/status | jq          # 200 with db/redis checks
CRON_SECRET=... curl -s -H "Authorization: Bearer $CRON_SECRET" \
  localhost:3000/api/cron/cleanup | jq          # stale pending cleanup
./scripts/smoke.sh http://localhost:3000        # read-only smoke
```

Stop the DB container and call `/api/status` again: it returns 503 and marks the
DB check failed. The Docker `HEALTHCHECK` uses the same endpoint.

---

## 5. Old vs new behaviour

| Area | Before | After |
|---|---|---|
| Checkout pricing | Client cart/localStorage totals; partial server re-price | Server quote from DB in paise; drift/unavailable banners; payment blocked on a stale quote |
| Order creation | Order created only after the client callback | Durable `pending` order + snapshots created before payment; webhook backstop reconciles a lost callback |
| Payment verification | Signature checked; amount loosely trusted | Signature + captured amount + claim; duplicate `transactionId` impossible |
| Stock | Decrement after payment, no claim | Conditional decrement only on the confirm winner; exactly-once restore on confirmed refunds/cancels |
| Refunds | Webhook set `cancelled`, no money moved | Razorpay full refund, `Refund` ledger, events, stock restore, late-capture refund for cancelled pending orders |
| Webhook | Untyped `any`, 2 events, no cache invalidation | HMAC → JSON → Zod, captured/failed/refunded handling, idempotent, cache invalidation |
| Validation | Ad-hoc checks, several admin actions unvalidated | Zod at every server boundary; env fail-fast; result contract |
| Auth/abuse | Login/register rate limit only, in-memory | Redis limiter (memory fallback) on auth, payment init, search, reviews, admin; reset/profile flows |
| Admin | Per-admin product scoping, no role on some actions | Single-store, ADMIN + rate limit on every mutation, image allowlist, search/pagination, coupons, analytics |
| Catalog | Hard cap of 24, no sort/filter | Pagination, sort, category/price filters, trigram search with typo tolerance |
| Orders | Flat list | Detail page, timeline, refunds, invoice (paid only), customer cancel |
| Accounts | Half-built reset, no addresses/profile | Password reset, profile/password, saved addresses, default address |
| Reviews | Multiple per user, unverified, 10-review average | One per user/product, verified badge, edit/delete, whole-table aggregate |
| Ops | No health/logging/CSP/CI e2e | Logger/Sentry, deep health, enforced CSP + collector, CI e2e/drift/audit, cleanup cron, runbooks |
| Growth | No coupons/wishlist/search quality | Coupons with redemption ledger, wishlist, recommendations, analytics |

---

## 6. Known limits and deferred work

- **Email delivery** needs a verified Resend domain and `EMAIL_FROM`; without
  it verification/reset/order emails are skipped/logged. E2E forces blank
  email env, so no real mail is sent in tests.
- **Sentry** is optional and server-side only; client-side capture is not
  configured. The CSP keeps `'unsafe-inline'`/`'unsafe-eval'` until nonce work.
  The real Razorpay *modal* is verified under CSP; the *paid* flow is verified
  with the signature-computing stub.
- **Deployment** is documented in `docs/runbooks/deploy.md` but was not
  performed here (no provider credentials / no push).
- **Refunds** are full-amount only; partial refunds, returns/RMA, multi-currency
  and a tax-jurisdiction engine are out of scope.
- **Recommendations** are display data and can be up to 10 minutes stale.
- **Dependency advisories** (`next-auth` beta, `picomatch`) remain; the audit is
  non-blocking in CI and should be triaged before a public launch.
- DB integration tests are gated by `TEST_DATABASE_URL`; e2e fixtures refuse
  non-local databases by default.

---

## 7. Where the code lives

- Plan: `docs/superpowers/plans/2026-10-31-vendary-phase-plan.md`
- Phase reports: `docs/superpowers/specs/` and the phase ledgers.
- Runbooks: `docs/runbooks/` (`deploy.md`, `incident.md`, `phase-0-cutover.md`).
- Smoke: `scripts/smoke.sh`.
- Key modules: `lib/orders/*` (claims, events, refunds, invoice),
  `lib/coupons.ts`, `lib/search.ts`, `lib/recommendations.ts`,
  `lib/analytics/queries.ts`, `lib/monitoring.ts`, `lib/logger.ts`.
- UI modules: `modules/checkout`, `modules/orders`, `modules/account`,
  `modules/admin`, `modules/products`.

# Vendary Roadmap

Prioritized backlog reviewed through four lenses: senior software engineer, senior DevOps engineer,
product manager, and end user. Effort: **S** (<1 day) · **M** (1–3 days) · **L** (3+ days).
★ = portfolio/recruiter impressiveness (max ★★★).

Status markers: `[ ]` planned · `[~]` in progress · `[x]` shipped.

---

## Phase 1 — Money & trust correctness (P0)

| # | Feature | Priority | Effort | ★ | Outcome |
|---|---------|----------|--------|---|---------|
| [x] 1 | Server-authoritative pricing | P0 | M | ★★★ | `PlaceOrder` re-derives line totals from DB prices, validates the paid Razorpay amount equals the computed total, stores DB price in `OrderItem`. Tamper-proof checkout. |
| [x] 2 | One source of truth for totals | P0 | S | ★★ | Cart, Razorpay charge, and persisted `Order.total` all agree: subtotal + 8% GST persisted as `taxAmount`. No more "cart says one total, you pay another". |
| [x] 3 | Razorpay webhook | P0 | M | ★★★ | `/api/razorpay/webhook` handles `payment.captured` / `refund.processed` with signature verification + idempotency; orders auto-advance `pending → confirmed`. |
| [x] 4 | Transactional orders + real stock | P0 | M | ★★ | `prisma.$transaction` wraps address+order+items; `stockQty` on Product (migration), validated and decremented at checkout, auto `OUT_OF_STOCK` at zero. No orphan orders, no overselling. |
| [x] 5 | Guest-checkout guard | P0 | S | ★ | Checkout requires login before payment — nobody pays and then hits "Unauthorized". |
| [x] 6 | Cache invalidation + TTLs | P1 | S | ★ | Product/featured Redis caches are purged on mutations and carry TTLs. No stale prices or availability. |
| [x] 7 | Hygiene sweep | P1 | S | ★ | Dead Stripe/AWS paths and junk deps removed; contract typos fixed (`deletePorduct`, `GetFeaturedPrpducts`, `Avaiavility`); fake promo, fake 15% discount, USD copy, boilerplate changelog, debug pages removed. |

## Phase 2 — DevOps foundation (P1; biggest recruiter lever)

| # | Feature | Priority | Effort | ★ | Outcome |
|---|---------|----------|--------|---|---------|
| [x] 8 | GitHub Actions CI | P1 | S | ★★★ | Lint + typecheck + build + tests on every push/PR; badge in README. |
| [x] 9 | Test suite | P1 | M–L | ★★★ | Vitest units for the money paths, coupons, refunds, analytics, search and webhook, plus Playwright e2e for the browse → cart → checkout → order loop; both wired into CI. |
| [x] 10 | Env validation | P1 | S | ★★ | Zod env schema with a production fail-fast in `instrumentation.ts` (names only, never values), and a complete `.env.example`. |
| [x] 11 | Hardened Docker + compose | P2 | M | ★★ | Standalone output, non-root user, pruned deps, HEALTHCHECK; docker-compose for Postgres + Redis local dev. |
| [x] 12 | Security posture | P1 | M | ★★★ | Security headers, enforcing CSP with a rate-limited report collector, and Redis-backed rate limiting with a memory fallback. CSP nonce/strict-dynamic remains deferred. |
| [x] 13 | Observability | P2 | M | ★★ | Structured redacted logger, optional Sentry initialization, deep `/api/status` (DB + Redis), dead `Analytics` model dropped. |
| [x] 14 | Seed + db scripts | P1 | S | ★★ | `prisma/seed.ts` with a realistic artisan catalog; `db:seed` / `db:migrate` scripts. Clone → run → demo. |
| [~] 15 | Repo polish | P2 | S | ★ | README overhaul (architecture diagram, setup, tests, deployment runbooks), Prettier + husky pre-commit shipped; `engines`/`.nvmrc`/`.mailmap` still pending. |

## Phase 3 — Product depth (P1; what users feel)

| # | Feature | Priority | Effort | ★ | Outcome |
|---|---------|----------|--------|---|---------|
| [x] 16 | Password reset | P1 | S | ★ | Token model + email helper, forgot-password page/action, single-use rotation, rate limiting. |
| [x] 17 | Profile & address book | P1 | M | ★★ | Account page (name, avatar, password change) + saved addresses selectable at checkout, with a default-address guard. |
| [x] 18 | Order lifecycle emails | P1 | S | ★★ | Branded order confirmation/status/refund emails via Resend; skipped when Resend is unconfigured, marker-based idempotency. |
| [x] 19 | Order detail + cancel/refund | P1 | M | ★★ | `/my-orders/[id]` status timeline; customer cancel while pending/confirmed triggers a Razorpay refund; `Refund` ledger + events. |
| [x] 20 | Catalog UX | P1 | M | ★★ | Pagination, sorting, price filter, category landing pages and the indexes that keep them bounded. |
| [x] 21 | Real coupons | P2 | M | ★★ | `Coupon` model + admin CRUD + checkout validation; transactional redemptions released on abandoned/cancelled orders. |
| [x] 22 | Wishlist | P2 | S–M | ★★ | User-scoped model + heart toggle + `/wishlist` page with add-to-cart. |

## Phase 4 — Differentiators (P2; the "wow" tier)

| # | Feature | Priority | Effort | ★ | Outcome |
|---|---------|----------|--------|---|---------|
| [~] 23 | Deploy live | P1 | M | ★★★ | Deploy + incident runbooks and a signed smoke script are shipped; the public demo URL (Vercel + Neon + Upstash + verified Resend + Razorpay webhook) is still pending. |
| [x] 24 | Admin analytics | P2 | M | ★★ | Revenue / paid orders / AOV / top products / low stock with Recharts over real data; cancelled and refunded orders excluded, UTC day buckets. |
| [~] 25 | Invoice PDF | P2 | M | ★★ | Printable, owner-gated GST invoice shipped (browser print-to-PDF); server-generated PDF file is deferred. |
| [x] 26 | Review integrity | P2 | S | ★ | Verified-purchase badge; one review per user per product enforced by a unique index. |
| [ ] 27 | Stretch | P3 | — | ★ | AI product-description generator for admins; real i18n (next-intl); locale selector visible on mobile. |

---

## Recruiter strategy

1. **Live demo first** (#23) — the URL is the first thing a reviewer clicks.
2. **Security narrative** (#1, #3, #4, #12) — "server-authoritative pricing, signed webhooks,
   transactional stock, rate limiting" are interview talking points most portfolio projects can't make.
3. **CI + tests around payment logic** (#8, #9) — signals senior engineering habits.
4. **README that sells** (#15) — architecture diagram, screenshots, badges.
5. **Keep the spec-first convention** — a short design spec per feature under `docs/superpowers/specs/`.

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
| 9 | Test suite | P1 | M–L | ★★★ | Vitest units for money paths (totals, GST, signature verification, webhook, schemas) + Playwright e2e (browse → cart → checkout with mocked Razorpay → my-orders; admin status change). |
| [~] 10 | Env validation | P1 | S | ★★ | Zod env schema, fail-fast at boot; `.env.example` matches reality. *Partial: fail-fast checks live in the money paths (Razorpay client, webhook) and `.env.example` is complete; a dedicated zod env layer is still pending.* |
| 11 | Hardened Docker + compose | P2 | M | ★★ | Standalone output, non-root user, pruned deps, HEALTHCHECK; docker-compose for Postgres + Redis local dev. |
| 12 | Security posture | P1 | M | ★★★ | Rate limiting on auth/verification/checkout; security headers + CSP in `next.config`. |
| 13 | Observability | P2 | M | ★★ | Sentry, structured logging, deep `/api/status` (DB + Redis checks); resolve dead `Analytics` model. |
| 14 | Seed + db scripts | P1 | S | ★★ | `prisma/seed.ts` with a realistic artisan catalog; `db:seed` / `db:migrate` scripts. Clone → run → demo. |
| 15 | Repo polish | P2 | S | ★ | README overhaul (architecture diagram, setup, screenshots, badges), Prettier + husky pre-commit, `engines`/`.nvmrc`, `.mailmap`. |

## Phase 3 — Product depth (P1; what users feel)

| # | Feature | Priority | Effort | ★ | Outcome |
|---|---------|----------|--------|---|---------|
| 16 | Password reset | P1 | S | ★ | Finish the half-built flow (token model + email helper exist; add page, action, forgot-password link). |
| 17 | Profile & address book | P1 | M | ★★ | Account page (name, avatar, password change) + saved addresses selectable at checkout. |
| 18 | Order lifecycle emails | P1 | S | ★★ | Branded order confirmation + status-update emails via Resend (needs verified sender domain). |
| 19 | Order detail + cancel/refund | P1 | M | ★★ | `/my-orders/[id]` status timeline; customer cancel while pending/confirmed triggers Razorpay refund API. |
| 20 | Catalog UX | P1 | M | ★★ | Pagination, sorting, price filter, category landing pages; catalog beyond 24 items becomes reachable. |
| 21 | Real coupons | P2 | M | ★★ | `Coupon` model + admin CRUD + checkout validation (replaces the always-failing promo input). |
| 22 | Wishlist | P2 | S–M | ★★ | Model + heart toggle + `/wishlist` page. |

## Phase 4 — Differentiators (P2; the "wow" tier)

| # | Feature | Priority | Effort | ★ | Outcome |
|---|---------|----------|--------|---|---------|
| 23 | Deploy live | P1 | M | ★★★ | Vercel + Neon Postgres + Upstash Redis + verified Resend domain → public demo URL with preview deploys. The single strongest recruiter artifact. |
| 24 | Admin analytics | P2 | M | ★★ | Revenue / orders / top-products charts (Recharts) over real data. |
| 25 | Invoice PDF | P2 | M | ★★ | Downloadable invoice per order from the order detail page. |
| 26 | Review integrity | P2 | S | ★ | Verified-purchase badge; one review per user per product. |
| 27 | Stretch | P3 | — | ★ | AI product-description generator for admins; real i18n (next-intl); locale selector visible on mobile. |

---

## Recruiter strategy

1. **Live demo first** (#23) — the URL is the first thing a reviewer clicks.
2. **Security narrative** (#1, #3, #4, #12) — "server-authoritative pricing, signed webhooks,
   transactional stock, rate limiting" are interview talking points most portfolio projects can't make.
3. **CI + tests around payment logic** (#8, #9) — signals senior engineering habits.
4. **README that sells** (#15) — architecture diagram, screenshots, badges.
5. **Keep the spec-first convention** — a short design spec per feature under `docs/superpowers/specs/`.

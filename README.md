# Vendary

[![CI](https://github.com/Maheshh-S/Vendary/actions/workflows/ci.yml/badge.svg)](https://github.com/Maheshh-S/Vendary/actions/workflows/ci.yml)

**Vendary** is an INR-first marketplace for Indian artisan handicrafts — Madhubani
paintings, Channapatna toys, Jaipur blue pottery, pashmina weaves, Bidriware
jewelry. Built as a single Next.js (App Router) application with Prisma,
Razorpay payments, and a hardened, tamper-proof checkout.

Live: [vendary.vercel.app](https://vendary.vercel.app) · [Roadmap](docs/ROADMAP.md) · [Design specs](docs/superpowers/specs/)

## Highlights

- **Server-authoritative checkout.** Every amount is computed on the server
  from database prices — client cart values are ignored. The paid Razorpay
  amount is verified against a server-computed total (HMAC signature,
  timing-safe, plus an amount match on the fetched order), so a tampered
  localStorage cart cannot change what an order is worth.
- **Transactional orders with real stock.** Address, order, line items and
  stock decrements commit atomically; items sell out automatically at zero.
- **Razorpay webhook.** `payment.captured` confirms orders, `refund.processed`
  cancels them — signed, idempotent, retry-friendly.
- **Honest money.** Cart, checkout summary, and the charge agree on
  subtotal + 8% GST, persisted on the order. INR formatting everywhere, with
  a display-only currency selector for international visitors.
- **Tested money paths.** 30+ Vitest units over totals, schemas, signature
  verification and the webhook handler, plus Playwright e2e for the full
  browse → cart → checkout → order loop (paid flow included, mocked
  checkout.js).
- **Auth that respects the basics.** Email verification, timing-safe login
  with dummy-hash equalization, email de-enumeration, per-IP rate limiting on
  auth endpoints, security headers.

## Architecture

```mermaid
flowchart LR
    subgraph Client
        B[Browser<br/>RSC + Server Actions + react-query]
    end
    subgraph Next[Next.js 15 App Router]
        M[Middleware<br/>default-deny auth gate]
        SA[Server Actions<br/>zod-validated API layer]
        WH[Webhook route<br/>/api/razorpay/webhook]
        R[RSC pages<br/>storefront · admin · my-orders]
    end
    subgraph Data
        PG[(PostgreSQL<br/>Prisma · 12 models)]
        RD[(Redis<br/>optional cache, TTL'd)]
    end
    RZ[Razorpay<br/>orders API + Checkout.js + webhooks]
    RE[Resend<br/>verification email]

    B --> M --> R --> PG
    B --> SA --> PG
    SA --> RD
    R --> RD
    SA --> RZ
    RZ -. payment.captured .-> WH --> PG
    SA --> RE
```

The API surface is Server Actions (zod-validated on both ends), not REST.
Redis is optional — every cache read falls through to Postgres when it's
absent, and caches carry TTLs plus explicit invalidation on mutations.

## Getting started

Requires [Bun](https://bun.sh) (or Node 22 + npm) and a PostgreSQL database.

```bash
git clone https://github.com/Maheshh-S/Vendary.git && cd Vendary
bun install                 # runs prisma generate via postinstall
cp .env.example .env        # fill in DATABASE_URL, AUTH_SECRET, Razorpay test keys
docker compose up -d        # optional: local Postgres 16 + Redis 7

bunx prisma migrate deploy  # apply schema
npm run db:seed             # 5 categories, 15 artisan products, demo admin
npm run dev                 # http://localhost:3000
```

Demo admin (from the seed, for local clones only): `admin@vendary.test` /
`Admin@1234`.

### Environment

See [.env.example](.env.example) — Auth.js secret, Google OAuth (optional),
Razorpay key pair + webhook secret, Resend key, Postgres URL, and optional
Redis URL. In production, register the webhook endpoint
(`/api/razorpay/webhook`) in the Razorpay dashboard with the same secret.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Dev server |
| `npm run build` / `start` | Production build / serve |
| `npm run lint` | ESLint |
| `npm run test` | Vitest unit suite (money paths, schemas, webhook) |
| `npm run e2e` | Playwright suite; add `-- --grep-invert @payment` for the subset that needs no Razorpay keys |
| `npm run db:migrate` | `prisma migrate deploy` |
| `npm run db:seed` | Idempotent demo catalog |

## Testing strategy

- **Unit (Vitest)** — the trust boundaries: order totals + GST rounding, the
  checkout/place-order schemas (tampered carts, legacy sessions), Razorpay
  signature verification (valid/tampered/wrong-secret/missing-secret), the
  webhook route end-to-end with signed payloads, and the rate limiter.
- **E2E (Playwright)** — the shopping loop as a user runs it. The `@payment`
  test drives a real Razorpay test-mode order and mocks only
  `checkout.razorpay.com` with a stub that signs with the same
  `RAZORPAY_KEY_SECRET` the server runs with, so `PlaceOrder`'s verification
  passes honestly.
- **CI (GitHub Actions)** — Prisma generate → typecheck → unit tests → lint →
  build on every push/PR.

## Deployment

Docker: `docker build -t vendary .` — standalone Next output, non-root user,
schema + Prisma bundled so the container can run `migrate deploy`, and a
`/api/status` HEALTHCHECK. On Vercel, add the env vars from
[.env.example](.env.example) and deploy.

## Status

Under active development — password reset, saved addresses, order emails,
catalog pagination and admin analytics are next. See the
[roadmap](docs/ROADMAP.md) for the full prioritized backlog.

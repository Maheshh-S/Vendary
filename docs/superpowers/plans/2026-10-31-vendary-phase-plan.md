# Vendary — Phase-Wise Implementation Plan (2026-10-31)

**Goal:** Close every payment-integrity and authorization gap first, then make checkout totals truthful end-to-end, then complete the customer order lifecycle, operations, and differentiators — each phase independently shippable.

**Architecture approach:** Extend the existing Next.js App Router monolith. Keep Server Actions as the API surface, add one thin `ActionResult` contract, move money-path invariants into small testable modules (`lib/orders/*`), and make the database enforce what code previously assumed (unique payment ids, enum statuses, order-item snapshots). No rewrite, no parallel API layer.

**Tech stack:** Next.js 15.2 App Router, React 19, TypeScript 5, Prisma 6 + PostgreSQL 16, NextAuth v5 beta (JWT), Razorpay, Resend, ioredis, Tailwind 4, Vitest 5, Playwright 1.64, Bun installs, Docker standalone.

**For agentic workers:**
- [ ] Work phase by phase; do not start Phase 1 until Phase 0 acceptance criteria pass.
- [ ] Run the `Validate` command for a task before ticking it; run the full gate (`npx tsc --noEmit && npm test && npm run lint && npm run build`) at each phase boundary.
- [ ] One conventional commit per task group (sequence in §9); never combine a migration with unrelated refactors.
- [ ] Every migration ships with a pre-check query in the PR description; never auto-delete financial rows.

---

## 1. Global constraints

1. **Money:** rupees as `Decimal(10,2)` in PostgreSQL/Prisma; **paise as integers on every wire boundary** (Razorpay, cart quote, invoice math). Convert at the edge only, with `Math.round`. Never persist a float from `Number(input)` without a 2-dp check.
2. **Validation:** every exported server action parses its input with a Zod schema at the boundary, even when the TypeScript type looks safe. Types are not runtime guarantees.
3. **Authorization:** every admin mutation requires `session.user.role === "ADMIN"`. Ownership scoping (`userId`) is only used where multi-vendor behavior is explicitly chosen (see open decision 1); admin pages must never silently hide other admins' products.
4. **Schema:** no destructive change without a checked-in migration and a pre-migration audit query. New non-null columns are added nullable → backfilled → set `NOT NULL` in the same migration.
5. **Green gates:** each phase leaves `npx tsc --noEmit`, `npm test`, `npm run lint`, `npm run build` green, and `npm run e2e -- --grep-invert @payment` green where the environment allows.
6. **Conventions:** keep route groups (`actions/(admin)/...`), `"use server"` modules exporting only async functions, `index.ts` folder actions for products, flat files for admin/auth, `serializePrismaObject` at RSC→client boundaries, and `invalidateProductCache` after product mutations.
7. **Dependencies:** no new runtime dependencies except `@sentry/nextjs` (Phase 3) and `recharts` (Phase 4); dev-only `prettier`, `husky`, `lint-staged` (Phase 3). Everything else uses existing `zod`, `ioredis`, `razorpay`, `resend`, `@tanstack/react-query`, `react-hot-toast`. Invoices use browser print, not a PDF library.
8. **No secrets in logs:** Razorpay keys, webhook secrets, auth secrets, full addresses, and emails are redacted or hashed in structured logs.

---

## 2. Requirements restatement and success criteria

### P0 — security and integrity (Phase 0)
1. `createRazorpayOrder` must require an authenticated user and be rate-limited.
2. A captured payment must always map to a durable `Order`; closing the tab after paying must not lose money.
3. Payment idempotency must be database-enforced (`transactionId @unique`), not `findFirst`.
4. Deleting a product must not destroy order history; `OrderItem` stores a name/image snapshot and uses `onDelete: SetNull`.
5. Every admin mutation validates inputs, checks `ADMIN`, and checks category/product existence.
6. `updateOrderStatus` enforces a transition map (no `delivered → confirmed`, no un-cancel).
7. Runtime environment variables are validated with Zod, without breaking CI/build placeholders.
8. Webhook payloads are typed; `payment.failed` is handled; refunds restore stock when eligible.
9. `searchProducts` / `GetProducts` are bounded; `hot-products` honors `isFeatured`.
10. Reviews validate product existence, integer ratings, length, uniqueness, and verified purchase.
11. Rate limiting is Redis-backed when available, memory-backed otherwise, and applied beyond login/register.
12. The dead `Analytics` model is removed or repurposed.

### P1 — product and UX (Phases 1–2)
13. Cart displays server-authoritative prices and warns before charging a different total.
14. Catalog supports pagination, sort, and price/category filters beyond 24 items.
15. Customer order detail page with timeline and ownership check.
16. Password reset, profile, and saved address book.
17. Transactional order emails (confirmation, shipped, cancelled, refunded).
18. All admins see the whole catalog; orders remain global.
19. Expected server-action rejections reach the user verbatim via `ActionResult`.
20. Cancel/refund flow restores stock exactly once and is auditable.

### DevOps / observability (Phase 3)
21. Structured logging + Sentry, deep `/api/status` (DB + Redis), Playwright in CI, migration drift check, dependency audit, enforced CSP, Prettier/husky.
22. Remove the `/hello` Hono stub; keep Docker HEALTHCHECK working.

### Measurable success criteria
- Anonymous `createRazorpayOrder` calls: **0** reach the Razorpay API (unit test asserts the SDK is not called).
- Captured payments without an `Order` row after webhook retries: **0** (order row exists at init; webhook confirms or refunds).
- Duplicate `Order.transactionId` rows: **0** (DB unique constraint).
- Deleting a product: `OrderItem` rows unchanged, `productName` still renders on `/my-orders` and `/admin`.
- Fuzz corpus for admin inputs (`NaN`, `Infinity`, `-1`, `1e12`, `"1e3"`, `0.001`) → **all rejected**.
- Stock decrement/restore under concurrent confirmation → **exactly once** (integration test).
- Every expected failure returns a typed `code` + user-safe `message`; generic "Failed to place order" only for `INTERNAL`.
- Full gate green at every phase boundary; e2e smoke + payment (local keys) green.

---

## 3. Pattern grounding table

| Convention | Existing pattern (file:line) | Use in this plan |
|---|---|---|
| Action naming/layout | `actions/products/search/index.ts:5`; `actions/(admin)/product/create-product.ts:8` | Keep folder-per-action for products; flat files for admin/auth |
| Server-action auth guard | `actions/orders/index.ts:153-156`; role guard `actions/(admin)/product/create-product.ts:9-12` | Centralize in `lib/auth-guards.ts` (`requireUser`, `requireAdmin`) |
| Page-level role guard | `app/(admin)/layout.tsx:11-15` | Defense in depth; never rely on layout alone for mutations |
| Zod parse at boundary | `actions/orders/index.ts:58-61`, `:102-105`; `actions/(admin)/product/add-image.ts:23-30` | `parseInput(schema, input)` throwing `AppError("VALIDATION")` |
| Client form validation | `modules/checkout/components/_checkout-form.tsx:57-58` (`zodResolver`) | Keep resolver; server still re-parses |
| Error separation | `OrderRejectionError` `actions/orders/index.ts:26`; catch/rethrow `:290-296` | Replace with `AppError` codes; unexpected errors masked by `runAction` |
| Prisma transaction + conditional stock | `actions/orders/index.ts:217-279`, `:258-268` (`updateMany` with `stockQty gte`) | Same shape in `lib/orders/confirm-order.ts` |
| Idempotent status transitions | `app/api/razorpay/webhook/route.ts:50-66` (`updateMany` + status guard) | Reuse for confirm/cancel/refund |
| Serialization | `lib/db/serializer.ts:6-31` | Every RSC→client payload |
| Cache invalidation | `lib/product-cache.ts:21-33`; key `:12` | Bump featured key to `v3` when query changes |
| Rate limiting | `lib/rate-limit.ts:13-41`; key helper `actions/auth/index.ts:18-22` | Extend to Redis with same call style |
| Unit-test style | `tests/webhook-route.test.ts:7-20` (mock Prisma/cache); `tests/money.test.ts:4-45` (pure math) | Mock DB at module boundary; pure logic tested directly |
| Action result from UI | `modules/checkout/components/_checkout-form.tsx:74-89` | Replace generic toast with `res.message` mapping |
| Money display | `lib/format-inr.ts:6-13` (rupees); `_items-summary.tsx:27-37` (paise→rupees) | Quote/invoice use paise internally, formatINR at render |

---

## 4. Phase 0 — Validation & authorization hardening (P0)

**Objective:** Make every trust boundary explicit and database-enforced: authenticated payment initiation, durable orders before capture, typed webhook handling, validated/admin-gated mutations, constrained public reads, env fail-fast, and rate limits.

**Outcome:** No anonymous payment-order spam; no captured payment without an order; no double order; no order history loss; no NaN/negative price writes; no arbitrary status jumps; actionable errors reach users.

**Why it matters**
- **SWE:** One result contract and one guard module replace ad-hoc `throw new Error` in 10+ actions.
- **DevOps:** Env validation and rate limiting are production prerequisites; Redis becomes optional-but-useful.
- **Backend:** Unique constraints and transactional confirmations move invariants from hope to PostgreSQL.
- **PM:** Fewer support incidents ("paid, no order"), trustworthy order history, usable admin surface.
- **User:** Errors say "Only 2 left of X" instead of "Failed to place order".

**Effort:** L (6–8 engineer-days). **Dependencies:** none; do not start Phase 1 until this ships.

### 4.1 Phase to-do checklist
- [ ] 0.1 Result contract, `AppError`, and auth guards
- [ ] 0.2 Runtime env validation + build-safe instrumentation
- [ ] 0.3 Redis-backed rate limiter + request keys
- [ ] 0.4 Durable checkout intent + order-integrity migration
- [ ] 0.5 Typed webhook, shared confirmation, auto-refund backstop
- [ ] 0.6 Admin mutation hardening (price/description/availability/create/delete/images)
- [ ] 0.7 Order status state machine + stock restore
- [ ] 0.8 Public action bounds, review integrity, featured query, Analytics removal

---

### Task 0.1 — Result contract, `AppError`, auth guards

**Files**
- Create: `lib/errors.ts`, `lib/action-result.ts`, `lib/auth-guards.ts`, `lib/run-action.ts`, `lib/validation.ts`
- Test: `tests/action-result.test.ts`

**Action**
Define a client-safe result type (no server imports in `lib/action-result.ts`) and a server-only wrapper:

```ts
// lib/action-result.ts
export type ActionErrorCode =
  | "UNAUTHORIZED" | "FORBIDDEN" | "VALIDATION" | "NOT_FOUND"
  | "OUT_OF_STOCK" | "PRICE_CHANGED" | "AMOUNT_MISMATCH"
  | "RATE_LIMITED" | "CONFLICT" | "PAYMENT_FAILED" | "INTERNAL";

export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: ActionErrorCode; message: string; fieldErrors?: Record<string, string[]> };
```

```ts
// lib/errors.ts
export class AppError extends Error {
  constructor(
    public code: ActionErrorCode,
    public userMessage: string,
    public fieldErrors?: Record<string, string[]>,
    public cause?: unknown
  ) { super(userMessage); this.name = "AppError"; }
}
```

```ts
// lib/run-action.ts
export async function runAction<T>(name: string, fn: () => Promise<T>): Promise<ActionResult<T>> {
  try { return { ok: true, data: await fn() }; }
  catch (e) {
    if (e instanceof AppError) return { ok: false, code: e.code, message: e.userMessage, fieldErrors: e.fieldErrors };
    const requestId = crypto.randomUUID();
    console.error(JSON.stringify({ level: "error", action: name, requestId,
      error: e instanceof Error ? e.message : String(e) }));
    return { ok: false, code: "INTERNAL", message: `Something went wrong. Reference: ${requestId}` };
  }
}
```

`requireUser()` throws `AppError("UNAUTHORIZED", "Please sign in to continue.")`; `requireAdmin()` throws `AppError("FORBIDDEN", "You do not have permission to do that.")`. Add `import "server-only"` to `lib/auth-guards.ts` and `lib/run-action.ts` (not `lib/action-result.ts`).

**Mirror:** pure module + tests like `lib/razorpay.ts:9-25`; client IP helper `actions/auth/index.ts:18-22`.

**Validate:** `npx tsc --noEmit && npx vitest run tests/action-result.test.ts`

**Risk:** importing `next-auth` into a client bundle — keep guards server-only; `lib/action-result.ts` must have zero runtime imports.

**Done when:** tests prove `AppError` preserves code/message/fieldErrors, unknown errors are masked with a reference id, `requireAdmin` rejects `USER` and unauthenticated callers.

---

### Task 0.2 — Runtime env validation + build-safe instrumentation

**Files**
- Create: `lib/env.ts`, `instrumentation.ts`, `tests/env.test.ts`
- Modify: `.env.example`, `next.config.ts` (add `experimental.serverActions.bodySizeLimit: "1mb"` if supported by 15.2; otherwise document default)
- Test: `tests/env.test.ts`

**Action**
Pure schema + production-only assertion:

```ts
// lib/env.ts
export const serverEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().url().startsWith("postgres"),
  AUTH_SECRET: z.string().min(32),
  AUTH_GOOGLE_ID: z.string().min(1).optional(),
  AUTH_GOOGLE_SECRET: z.string().min(1).optional(),
  NEXT_PUBLIC_RAZORPAY_KEY_ID: z.string().min(1),
  RAZORPAY_KEY_SECRET: z.string().min(1),
  RAZORPAY_WEBHOOK_SECRET: z.string().min(1),
  RESEND_API_KEY: z.string().min(1).optional(),
  REDIS_URL: z.string().url().optional().or(z.literal("")),
  NEXT_PUBLIC_SITE_URL: z.string().url().default("http://localhost:3000"),
}).refine((e) => Boolean(e.AUTH_GOOGLE_ID) === Boolean(e.AUTH_GOOGLE_SECRET), {
  message: "AUTH_GOOGLE_ID and AUTH_GOOGLE_SECRET must be set together",
});
```

`instrumentation.ts` calls `assertRuntimeEnv()` only when `process.env.NODE_ENV === "production" && process.env.NEXT_PHASE !== "phase-production-build"`, with escape hatch `SKIP_ENV_VALIDATION=1` for CI. In development, log missing keys as warnings, not fatal (browsing must work without Razorpay keys). `.env.example` stays the canonical list; add comments that Google is optional and Redis is optional.

**Mirror:** Zod object + transform `schemas/checkout/place-order-schema.ts:12-28`; fail-closed secret checks `lib/razorpay.ts:16-18`.

**Validate:** `npx vitest run tests/env.test.ts && npx tsc --noEmit && npm run build`

**Risk:** `next build` imports instrumentation and fails on placeholders — the `NEXT_PHASE` guard is mandatory; verify Docker build `Dockerfile:19-23` still passes.

**Done when:** malformed `DATABASE_URL` or missing Razorpay secret fails server start in production; CI/Docker build with placeholders still succeeds; tests cover paired Google vars and optional Redis.

---

### Task 0.3 — Redis-backed rate limiter + request keys

**Files**
- Modify: `lib/redis.ts` (add `incr`, `pexpire`, export `isRedisEnabled`), `lib/rate-limit.ts`, `actions/auth/index.ts:15,79,149`, `tests/rate-limit.test.ts`
- Create: `lib/request-key.ts`, `tests/rate-limit-redis.test.ts`

**Action**
Replace the sync memory-only limiter with an async fixed-window limiter:

```ts
// lib/rate-limit.ts
export type RateLimitResult = { allowed: boolean; retryAfterS: number; remaining: number };
export async function checkRateLimit(opts: {
  bucket: string; subject: string; limit: number; windowMs: number;
}): Promise<RateLimitResult>
```

- Redis path: key `rl:{bucket}:{subject}:{Math.floor(Date.now()/windowMs)}`; `INCR`; on first hit `PEXPIRE windowMs`; allowed if count <= limit.
- Fallback: existing in-memory map when `!isRedisEnabled` or Redis throws; log one structured warning per minute, **fail-open** (availability over strictness).
- `enforceRateLimit(...)` remains as a throwing wrapper for auth call sites; update to `await`.
- `lib/request-key.ts`: `clientKey(bucket, userId?)` from `headers()` (`x-forwarded-for` first hop), matching `actions/auth/index.ts:18-22`.

Limits: login 5/min/IP; register 5/15 min/IP; `createRazorpayOrder` 10/min/user; search 60/min/IP; `addReview` 5/hour/user; admin mutations 60/min/user; password reset 3/hour/email + 10/hour/IP (Phase 2).

**Mirror:** existing cleanup/bucket semantics `lib/rate-limit.ts:11-40`; caller pattern `actions/auth/index.ts:79,149`.

**Validate:** `npx vitest run tests/rate-limit.test.ts tests/rate-limit-redis.test.ts`

**Risk:** async signature changes call sites and tests; Redis `INCR`+`PEXPIRE` is not atomic — acceptable for abuse control, document it.

**Done when:** 11th payment init in a minute returns `RATE_LIMITED`; auth still works with Redis absent; Redis error does not lock users out.

---

### Task 0.4 — Durable checkout intent + order-integrity migration

**Files**
- Modify: `prisma/schema.prisma` (`OrderStatus`, `Order.status`, `Order.transactionId @unique`, `Order.paymentId @default("")`, `OrderItem` snapshot + optional product, `Review` unique + `verifiedPurchase`)
- Create: `prisma/migrations/20261101000000_order_integrity/migration.sql`, `prisma/migrations/20261101001000_review_integrity/migration.sql`, `prisma/migrations/20261101002000_drop_analytics/migration.sql`
- Modify: `actions/orders/index.ts`, `schemas/checkout/place-order-schema.ts`, `modules/checkout/components/_checkout-form.tsx`, `app/(my-orders)/my-orders/page.tsx`, `app/(admin)/admin/page.tsx`
- Create: `schemas/checkout/confirm-payment-schema.ts`, `lib/razorpay-client.ts`, `lib/orders/confirm-order.ts`
- Test: `tests/order-confirmation.test.ts`, `tests/checkout-schema.test.ts` (extend)

**Action**
1. **Schema:** enum `OrderStatus { pending confirmed shipped delivered cancelled refunded }`; `Order.status OrderStatus @default(pending)`; `transactionId String @unique`; `paymentId String @default("")`; `OrderItem.productName String`, `productImage String?`, `productId String?`, relation `onDelete: SetNull`; `Review @@unique([userId, productId])`, `verifiedPurchase Boolean @default(false)`; remove `Analytics` model and `User.analytics`.
2. **Init flow (`createRazorpayOrder`)** — order row exists before the client can pay:
   - `requireUser()`, `await checkRateLimit(...)`, `parseInput(placeOrderSchema, orderData)`, `parseInput(checkoutSessionSchema, checkoutSession)`.
   - Price from DB (reuse `verifyAndPriceLines`, reject < 100 paise).
   - Create the Razorpay order first (`amount`, `receipt: "rcpt_" + crypto.randomUUID().slice(0,18)`, `notes: { userId }`).
   - In one `$transaction`: create `Address`, `Order` (`status: "pending"`, `transactionId: razorpayOrder.id`, `paymentId: ""`, `total`, `taxAmount`), and `OrderItem`s with `productName`/`productImage`/`price` snapshots.
   - Return `{ orderId, razorpayOrderId, amountPaise, currency }`. If DB fails after Razorpay create, return `INTERNAL` and log the orphan Razorpay order id for reconciliation.
3. **Confirm flow (`PlaceOrder`)** — no client address/cart trusted:
   - New input `confirmPaymentSchema = z.object({ razorpayOrderId, razorpayPaymentId, razorpaySignature })`.
   - `requireUser`; load order by `transactionId` with items; `order.userId === session.user.id` or `FORBIDDEN`.
   - If `confirmed` → return `{ orderId }` (idempotent). If `cancelled/refunded` → `CONFLICT`.
   - Verify HMAC (`lib/razorpay.ts`), fetch Razorpay order, require `paid.amount === round(order.total*100)`, status not `attempted`.
   - Re-price from current DB rows; if totals differ from the paid amount → auto-refund, mark `refunded`, return `PRICE_CHANGED`.
   - Call `confirmOrder(order.id, paymentId)`.

```ts
// lib/orders/confirm-order.ts (shape)
export async function confirmOrder(orderId: string, paymentId: string) {
  return prisma.$transaction(async (tx) => {
    const claimed = await tx.order.updateMany({
      where: { id: orderId, status: "pending" },
      data: { status: "confirmed", paymentId },
    });
    if (claimed.count === 0) {
      const current = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true } });
      return { status: "already" as const, current: current.status };
    }
    const items = await tx.orderItem.findMany({ where: { orderId } });
    for (const item of items) {
      const res = await tx.product.updateMany({
        where: { id: item.productId!, availability: "IN_STOCK", stockQty: { gte: item.quantity } },
        data: { stockQty: { decrement: item.quantity } },
      });
      if (res.count !== 1) throw new AppError("OUT_OF_STOCK", `"${item.productName}" just sold out.`);
      await tx.product.updateMany({
        where: { id: item.productId!, stockQty: { lte: 0 } },
        data: { availability: "OUT_OF_STOCK" },
      });
    }
    return { status: "confirmed" as const };
  });
}
```

**Migration pre-checks (must be run before deploy):**
```sql
SELECT "transactionId", COUNT(*) FROM "Order" GROUP BY 1 HAVING COUNT(*) > 1;
SELECT DISTINCT "status" FROM "Order"; -- must be subset of the new enum
SELECT COUNT(*) FROM "Analytics";       -- must be 0 before DROP
SELECT "userId", "productId", COUNT(*) FROM "Review" GROUP BY 1,2 HAVING COUNT(*) > 1;
```
Backfill `OrderItem.productName` from `Product.name` before `SET NOT NULL`; use `'Unknown product'` only for orphans. If duplicate `transactionId`/reviews exist, reconcile manually — do not auto-delete.

**Mirror:** transaction `actions/orders/index.ts:217-279`; conditional decrement `:258-268`; idempotency `:172-178`; rejection class `:26`.

**Validate:** `bunx prisma migrate dev --name order_integrity` (local) → `npx tsc --noEmit` → `npx vitest run tests/order-confirmation.test.ts tests/checkout-schema.test.ts` → `npm run build`

**Risk:** unique index fails on existing duplicates; enum cast locks `Order` briefly. Deploy single-instance or in a maintenance window because old code writes text statuses.

**Done when:** two concurrent `PlaceOrder` calls produce one confirmed order and one stock decrement; a captured payment always has an order row created before payment; `OrderItem` survives product deletion; duplicate `transactionId` is impossible at the DB level.

---

### Task 0.5 — Typed webhook, shared confirmation, refund backstop

**Files**
- Modify: `app/api/razorpay/webhook/route.ts`, `lib/razorpay.ts` (keep pure verifiers), `tests/webhook-route.test.ts`
- Create: `lib/razorpay-client.ts` (`getRazorpayClient`, `refundPayment`), `schemas/razorpay/webhook-schema.ts`, `lib/orders/refund.ts`, `tests/webhook-schema.test.ts`

**Action**
- Parse the signed raw body with Zod; delete the `any` cast at `webhook/route.ts:16-24`:

```ts
const paymentEntity = z.object({
  id: z.string().min(1),
  order_id: z.string().min(1),
  amount: z.number().int().nonnegative(),
  status: z.string(),
  error_code: z.string().optional(),
});
const refundEntity = z.object({
  id: z.string().min(1),
  payment_id: z.string().min(1),
  amount: z.number().int().nonnegative(),
  status: z.string(),
});
const webhookSchema = z.object({
  event: z.string(),
  payload: z.object({
    payment: z.object({ entity: paymentEntity }).optional(),
    refund: z.object({ entity: refundEntity }).optional(),
  }),
});
```

- `payment.captured`: find order by `transactionId = payment.order_id`; verify `payment.amount === round(order.total*100)`; call `confirmOrder`. On `OUT_OF_STOCK` or amount mismatch, call `refundCapturedPayment(orderId, payment.id, reason)` and mark `refunded`.
- `payment.failed`: structured warning with `orderId`, `paymentId`, `error_code`; **no state change** (another attempt may succeed).
- `refund.processed`: find order by `paymentId`; transition `confirmed → refunded` **and** restore stock in one transaction; transition `shipped/delivered → refunded` without stock restore; idempotent via `updateMany` guards.
- Unknown event → 200; invalid signature/JSON/schema → 400; DB outage → 500 (Razorpay retries). Missing secret → 501 (unchanged).
- `refundPayment` uses the Razorpay SDK `payments.refund(paymentId, { amount, notes })`; on failure, log and leave order `pending` with a loud alert (never mark refunded without a refund id in Phase 1 when `Refund` exists).

**Mirror:** route structure `app/api/razorpay/webhook/route.ts:26-75`; idempotent `updateMany` `:50-66`; tests `tests/webhook-route.test.ts:35-44`.

**Validate:** `npx vitest run tests/webhook-route.test.ts tests/webhook-schema.test.ts`

**Risk:** webhook and client callback race — `confirmOrder`’s status guard makes exactly one win; the loser returns success/already.

**Done when:** captured payment for a pending order confirms once; a sold-out confirmation triggers a refund; refund restores stock once; malformed signed payload is rejected without DB writes.

---

### Task 0.6 — Admin mutation hardening

**Files**
- Create: `schemas/admin/products/edit-price-schema.ts`, `edit-description-schema.ts`, `take-offline-schema.ts`, `delete-product-schema.ts`
- Modify: `schemas/admin/products/create-product-schema.ts`, `add-image-schema.ts`
- Modify: `actions/(admin)/edit/price.ts`, `actions/(admin)/edit/description.ts`, `actions/(admin)/product/take-product-offline.ts`, `create-product.ts`, `delete-product.ts`, `add-image.ts`
- Modify: `modules/admin/edit/price.tsx`, `modules/admin/edit/description-form.tsx`, `modules/admin/components/take-offline-switch.tsx`, `modules/admin/components/add-image-form.tsx`, `modules/admin/components/delete-product-button.tsx`
- Create: `lib/images.ts`; modify `next.config.ts` to derive `remotePatterns` from it
- Test: `tests/admin-schemas.test.ts`

**Action**
- Price: `z.object({ productId: z.string().min(1), price: z.coerce.number().finite().min(1).max(10_000_000) })`, then reject >2 decimal places via `.refine((n) => Math.round(n*100) === n*100)`. Persist `(Math.round(price*100)/100).toFixed(2)`.
- Descriptions: `shortDescription` 10–300 chars, `description` 10–5000 chars, trimmed; `productId` non-empty.
- Availability: `z.enum(["IN_STOCK","OUT_OF_STOCK","PRE_ORDER"])` — runtime validated, not just TypeScript.
- Create product: parse the form, coerce price/stock, `stock` integer 0–100000, `categoryId` must exist (`prisma.category.findUnique` else `NOT_FOUND`), name ≤120, `thumbnail` optional URL on the allowlist.
- Delete product: `requireAdmin`, validate id, `deleteMany({where:{id}})` + `count===0 → NOT_FOUND`; `OrderItem` SetNull preserves history. Do not swallow `AppError` in a catch-all.
- Add images: max 8 images; URL must be https and host in `ALLOWED_IMAGE_HOSTS` (`images.unsplash.com`, `images.pexels.com`, `m.media-amazon.com`, `pixabay.com`, `tailwindcss.com`, `lh3.googleusercontent.com`; `localhost:3000` dev only); `isMain` uniqueness enforced per request.
- Remove `userId` scoping from admin mutations and the admin listing filter (`app/(admin)/admin/page.tsx:37-39`) — see open decision 1; keep `Product.userId` as creator audit.

**Mirror:** role guard `create-product.ts:9-12`; Zod usage `add-image.ts:23-30`; cache invalidation `edit/price.ts:20`; pattern of masking internals `delete-product.ts:27-30` (do not copy the swallow-all catch).

**Validate:** `npx vitest run tests/admin-schemas.test.ts && npx tsc --noEmit`

**Risk:** existing clients send rupee strings; keep `z.coerce` for backward compatibility. Image allowlist must match `next.config.ts` or images 400 at render.

**Done when:** fuzz inputs rejected; non-ADMIN gets `FORBIDDEN`; unknown category `NOT_FOUND`; non-allowlisted image host rejected; delete preserves `OrderItem` rows.

---

### Task 0.7 — Order status state machine + stock restore

**Files**
- Create: `lib/orders/status.ts`, `tests/order-status.test.ts`
- Modify: `actions/orders/index.ts` (`updateOrderStatus`), `modules/admin/components/order-status-select.tsx`, `app/(my-orders)/my-orders/page.tsx` (status typing)

**Action**

```ts
// lib/orders/status.ts
export const ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  pending:   ["confirmed", "cancelled"],
  confirmed: ["shipped", "cancelled", "refunded"],
  shipped:   ["delivered", "refunded"],
  delivered: ["refunded"],
  cancelled: [],
  refunded:  [],
};
export function canTransition(from: OrderStatus, to: OrderStatus) {
  return ORDER_TRANSITIONS[from]?.includes(to) ?? false;
}
```

`updateOrderStatus` takes `(orderId, status)` where status is `z.enum([...])`; `requireAdmin`; transaction reads current status, rejects illegal transitions with `CONFLICT` and an explicit message, then `updateMany({where:{id, status: from}, data:{status: to}})`. If `from === "confirmed"` and target is `cancelled`/`refunded`, restore each item’s stock (`increment`, set `availability: "IN_STOCK"`) in the same transaction. UI only offers `ORDER_TRANSITIONS[status]`.

**Mirror:** current guard `actions/orders/index.ts:303-322`; conditional update pattern `webhook/route.ts:52-55`.

**Validate:** `npx vitest run tests/order-status.test.ts`

**Risk:** admin expectations of arbitrary jumps; surface allowed next states in the dropdown. Stock restore for shipped/delivered is intentionally **not** performed — goods left the warehouse.

**Done when:** `pending → shipped`, `delivered → cancelled`, and un-cancel are rejected; `confirmed → cancelled` restores stock once; replayed transition returns `CONFLICT`.

---

### Task 0.8 — Public action bounds, review integrity, featured, Analytics

**Files**
- Create: `schemas/products/search-schema.ts`, `schemas/products/products-query-schema.ts`
- Modify: `actions/products/search/index.ts`, `actions/products/products/index.ts`, `actions/products/reviews/add-review/index.ts`, `schemas/products/reviews/review-schema.ts`, `actions/products/hot-products/index.ts`, `lib/product-cache.ts`, `app/(shopping)/products/page.tsx`, `modules/shopping/components/shopping-nav/search-input/google-style-search-component.tsx`
- Test: `tests/product-schemas.test.ts`, `tests/review-schema.test.ts`

**Action**
- Search: `q` trimmed 2–64 chars; `take` fixed 10; `select` id/name/thumbnail/price only; rate limit 60/min/IP; return `ActionResult<SearchHit[]>`.
- `GetProducts`: `page` int ≥1 (default 1), `pageSize` 1–48 (default 24), `category` ≤60, `sort` enum `newest|price_asc|price_desc|name_asc`; return `{ items, total, page, pageSize, totalPages }`.
- Reviews: `productId` non-empty, `rating` **integer** 1–5, `review` trimmed 10–2000; verify product exists (`NOT_FOUND`); compute `verifiedPurchase` from `orderItem` joined to `order.userId = session.user.id` and status in `confirmed/shipped/delivered`; catch Prisma `P2002` → `CONFLICT "You already reviewed this product."`; rate limit 5/hour/user.
- Featured: add `where.isFeatured = true`, clamp `take` 1–12, bump `FEATURED_PRODUCTS_KEY` to `featured-products:v3`.
- Analytics: drop via migration `20261101002000_drop_analytics` after `COUNT(*) = 0`; remove `User.analytics`.

**Mirror:** current queries `searchProducts:5-44`, `GetProducts:11-47`, `hot-products:22-28`; schema style `review-schema.ts:3-9`.

**Validate:** `npx vitest run tests/product-schemas.test.ts tests/review-schema.test.ts && npx tsc --noEmit`

**Risk:** `GetProducts` return shape changes; only `app/(shopping)/products/page.tsx:10` consumes it — update in the same commit. Search client expects an array — unwrap `ActionResult`.

**Done when:** empty/1000-char searches rejected; `take=10000` clamped; second review returns `CONFLICT`; featured excludes non-featured seeded products; Analytics table gone.

---

### Phase 0 acceptance criteria
- [ ] Anonymous `createRazorpayOrder` returns `UNAUTHORIZED` and never calls Razorpay.
- [ ] Every payment has a durable pending order before the client receives the Razorpay order id.
- [ ] `transactionId` unique; replay returns the same order; stock decremented exactly once.
- [ ] Cancelled/refunded confirmations restore stock exactly once (confirmed orders only).
- [ ] Product deletion leaves order items readable via snapshots.
- [ ] All admin actions are `ADMIN`-gated and Zod-validated; fuzz corpus rejected.
- [ ] State machine enforced; no un-cancel or backwards jumps.
- [ ] Webhook payload typed; `payment.failed` handled without corrupting state.
- [ ] Env validation fails fast in production, build still green.
- [ ] Rate limits active for payment init, search, reviews, admin mutations, auth.
- [ ] `npx tsc --noEmit && npm test && npm run lint && npm run build` green; e2e smoke green.

---

## 5. Phase 1 — Checkout truth & customer order visibility (P1)

**Objective:** Make the displayed total the charged total, expose paginated catalog, give customers an order detail/timeline, and add cancel/refund with auditable stock restoration.

**Outcome:** No silent cart/charge drift; catalog beyond 24 items reachable; customers can inspect and cancel eligible orders; refunds are recorded.

**Why it matters**
- **SWE:** Server quote reuses `lib/money.ts`; order detail reuses serializer; no duplicated pricing logic.
- **DevOps:** Cancel/refund adds explicit failure logging and idempotent transitions.
- **Backend:** `Refund`/`OrderEvent` make money movements auditable; indexes keep pagination fast.
- **PM:** Fewer "price changed at checkout" complaints; support can see refund history.
- **User:** Truthful cart, real order tracking, self-serve cancel before shipment.

**Effort:** L (6–8 days). **Dependencies:** Phase 0 complete (especially 0.4/0.5/0.7).

### Phase to-do checklist
- [ ] 1.1 Server cart quote + paise-native cart storage + drift UI
- [ ] 1.2 Catalog pagination/sort/filter + indexes
- [ ] 1.3 Customer order detail page + timeline
- [ ] 1.4 Cancel/refund flow + `Refund`/`OrderEvent` migration
- [ ] 1.5 Transactional order emails
- [ ] 1.6 Admin catalog/order surface for multi-admin
- [ ] 1.7 Result-contract UX sweep across all client mutations
- [ ] 1.8 E2E: price drift, order detail, cancel

### Task 1.1 — Server cart quote + paise-native cart + drift UI
**Files:** Create `actions/cart/quote.ts`, `schemas/cart/quote-schema.ts`, `tests/cart-quote.test.ts`; modify `providers/cart-provider.tsx`, `app/cart/page.tsx`, `app/(shopping)/checkout/page.tsx`, `modules/checkout/components/_checkout-page.tsx`, `_items-summary.tsx`, `modules/products/types/checkout.d.ts`, `modules/products/sections/product-description.tsx`.
**Action:** `getCartQuote(lineItems)` parses `checkoutLineItemSchema.array().max(50)`, returns authoritative `unitPaise`, availability, stock, totals, and issues (`MISSING|OUT_OF_STOCK|INSUFFICIENT_STOCK`). Store `unitPaise` (integer) in `CartItem`; migrate legacy `price` rupees ×100 on read. Cart/checkout fetch the quote via react-query; show a banner when any returned `unitPaise` differs from localStorage or an item is unavailable; disable payment on blocking issues.
**Mirror:** `computeOrderTotals` `lib/money.ts:23-35`; summary math `_items-summary.tsx:27-37`; cart provider `cart-provider.tsx:9-17,99`.
**Validate:** `npx vitest run tests/cart-quote.test.ts && npm run e2e -- --grep "cart totals"`.
**Risk:** legacy localStorage shape; normalize on first read and write back.
**Done when:** changing a product price in DB updates the cart total on refresh with a visible warning; no client price is sent to the charge path.

### Task 1.2 — Catalog pagination/sort/filter + indexes
**Files:** Modify `schemas/products/products-query-schema.ts`, `actions/products/products/index.ts`, `app/(shopping)/products/page.tsx`; create `prisma/migrations/20261115001000_catalog_indexes/migration.sql`; reuse `components/ui/pagination.tsx`; test `e2e/catalog.spec.ts`.
**Action:** URL state `?page=&sort=&category=&min=&max=`; server validates and returns `{items,total,...}`; price filters in paise or rupees with explicit conversion; add indexes `Product(availability, createdAt)`, `Product(categoryId, price)`, `Order(userId, createdAt)`, `Order(status, createdAt)`, `OrderItem(orderId)`, `OrderItem(productId)`, `Review(productId, createdAt)`.
**Mirror:** `GetProducts` shape `actions/products/products/index.ts:11-47`; Pagination component `components/ui/pagination.tsx:5-101`.
**Validate:** `npx tsc --noEmit && npm run e2e -- --grep "catalog"`.
**Risk:** `count` + `findMany` must share the same `where`; build it once.
**Done when:** page 2+ reachable; sort/filter reflected in URL and results; `EXPLAIN` shows index scans for catalog and admin order queries.

### Task 1.3 — Customer order detail + timeline
**Files:** Create `app/(my-orders)/my-orders/[id]/page.tsx`, `modules/orders/components/order-timeline.tsx`; modify `app/(my-orders)/my-orders/page.tsx` to link rows.
**Action:** `requireUser`; load order with items/address/events/refunds; `order.userId !== session.user.id → notFound()`; render snapshot names, paise-derived totals, GST, payment id (masked), address, and timeline from `OrderEvent` (fallback to `createdAt` + status). Show cancel button only for allowed transitions.
**Mirror:** ownership + `notFound` `app/(shopping)/products/[id]/page.tsx:42-44`; flat list `my-orders/page.tsx:14-23`.
**Validate:** `npm run e2e -- --grep "order detail"`.
**Risk:** order id enumeration — use `notFound()` for both missing and unauthorized.
**Done when:** other users’ order ids 404; snapshot names render after product deletion.

### Task 1.4 — Cancel/refund flow + `Refund`/`OrderEvent`
**Files:** Create `prisma/migrations/20261115000000_refunds_and_events/migration.sql`, `actions/orders/cancel.ts`, `actions/(admin)/orders/refund.ts`, `lib/orders/refund.ts`, `modules/orders/components/cancel-order-button.tsx`; modify `actions/orders/index.ts` (`confirmOrder` writes events), `lib/razorpay-client.ts`; test `tests/cancel-order.test.ts`, `tests/refund.test.ts`, `e2e/cancel-order.spec.ts`.
**Action:** Customer cancel allowed `pending|confirmed`; admin refund allowed `confirmed|shipped|delivered`; Razorpay refund via `payments.refund` full amount; transaction writes `Refund` (unique `razorpayRefundId`) and `OrderEvent` (`fromStatus`, `toStatus`, `actorId`, `metadata`); stock restored only from `confirmed`; refund failure leaves status unchanged and records `OrderEvent { type: "refund_failed" }`; webhook reconciles to `refunded`.
**Mirror:** transition guard Phase 0 `lib/orders/status.ts`; webhook idempotency `webhook/route.ts:58-66`.
**Validate:** `npx vitest run tests/cancel-order.test.ts tests/refund.test.ts && npm run e2e -- --grep "cancel"`.
**Risk:** refund API idempotency — use Razorpay refund id uniqueness; never issue a second refund for the same order (query `Refund` first).
**Done when:** cancel restores stock once; replay is a no-op; refund row and event visible on order detail/admin.

### Task 1.5 — Transactional order emails
**Files:** Modify `lib/mail.ts`, `.env.example` (`EMAIL_FROM`, `ORDER_NOTIFICATION_EMAIL`), `lib/env.ts`; create `templates/mail/order-confirmation.tsx`, `templates/mail/order-status.tsx`, `tests/order-emails.test.ts`; call from `lib/orders/confirm-order.ts` and status actions after commit.
**Action:** `sendOrderEmail(orderId, kind)` reads the order + snapshot items, renders HTML, sends via Resend from `EMAIL_FROM`; idempotency keyed by `OrderEvent` type (`confirmation_sent`, `shipped_sent`, etc.) written before send; failures logged, never fail the order.
**Mirror:** Resend usage `lib/mail.ts:8-40`; template import `templates/mail/onboarding-mail`.
**Validate:** `npx vitest run tests/order-emails.test.ts`.
**Risk:** unverified sender domain (Resend only allows `onboarding@resend.dev`); document domain verification as a deployment prerequisite.
**Done when:** one email per transition even under retries; e2e/staging logs the send; failures do not roll back orders.

### Task 1.6 — Admin catalog/order surface for multi-admin
**Files:** Modify `app/(admin)/admin/page.tsx` (remove `where.userId`, add pagination/search), `modules/admin/components/product-search-controls.tsx`, create `actions/(admin)/orders/list.ts` if server-side filtering is needed.
**Action:** All `ADMIN` users see all products and all orders; show creator email (requires `include.user` on products); paginate 50 rows; search by name/order id/email; keep mutations `ADMIN`-gated.
**Mirror:** current orders query `admin/page.tsx:43-62`; product table `:31-41`.
**Validate:** `npx tsc --noEmit && npm run e2e -- --grep "admin"`.
**Risk:** single-store assumption — see open decision 1.
**Done when:** a second admin account sees products created by the first; no `userId` filter remains.

### Task 1.7 — Result-contract UX sweep
**Files:** Modify `modules/checkout/components/_checkout-form.tsx`, `modules/admin/edit/price.tsx`, `description-form.tsx`, `take-offline-switch.tsx`, `add-image-form.tsx`, `create-product-form.tsx`, `delete-product-button.tsx`, `order-status-select.tsx`, `modules/products/components/reviews/add-review-form.tsx`, `modules/shopping/components/shopping-nav/search-input/google-style-search-component.tsx`.
**Action:** Every mutation checks `res.ok`; on failure `toast.error(res.message)` and maps `fieldErrors` to form fields; remove generic messages; on success use `res.data`.
**Mirror:** current generic toast `_checkout-form.tsx:85-88`.
**Validate:** `npx tsc --noEmit && npm run e2e -- --grep "smoke"`.
**Risk:** forgetting a call site leaves `undefined` access — TypeScript catches shape changes.
**Done when:** “Only 2 left”, “Price changed”, and “You already reviewed” reach the UI verbatim.

### Task 1.8 — E2E coverage
**Files:** Create `e2e/checkout-drift.spec.ts`, `e2e/order-detail.spec.ts`, `e2e/cancel-order.spec.ts`; modify `e2e/payment.spec.ts`.
**Action:** Drift test edits localStorage price and asserts warning + server total; order detail asserts ownership; cancel asserts status + stock badge; payment test follows the new init/confirm contract.
**Validate:** `npm run e2e -- --grep-invert @payment`.
**Risk:** flaky Razorpay stub — keep the existing signature-computing stub.
**Done when:** all three specs pass in CI (non-payment subset).

### Phase 1 acceptance criteria
- [ ] Cart/checkout totals come from the server quote; drift is visible before payment.
- [ ] Catalog pages 2+ reachable, sortable, filterable.
- [ ] `/my-orders/[id]` renders snapshot items, timeline, and 404s for foreign orders.
- [ ] Cancel/refund restores stock once and writes `Refund` + `OrderEvent`.
- [ ] Emails sent once per transition; failures do not corrupt orders.
- [ ] All client mutations surface typed messages.
- [ ] Full gate + e2e subset green.

---

## 6. Phase 2 — Accounts, lifecycle & review integrity

**Objective:** Complete the half-built account features and make order data self-service: password reset, saved addresses, profile/password change, verified-purchase reviews, printable invoice.

**Outcome:** Users can recover accounts and manage addresses; support load drops; reviews carry trust signals.

**Why it matters**
- **SWE:** Reuses `PasswordResetToken`, `lib/token.ts`, `lib/mail.ts`; adds one model (`SavedAddress`) instead of mutating order `Address` snapshots.
- **DevOps:** Reset flow gets rate limits and token hygiene; no new infrastructure.
- **Backend:** `SavedAddress` separates editable customer data from immutable order addresses.
- **PM:** Password reset is table stakes for paid accounts; saved addresses reduce checkout drop-off.
- **User:** Recover access, check out in two taps, print a GST invoice.

**Effort:** M (4–5 days). **Dependencies:** Phase 1 (order detail for invoice link); Phase 0 result/rate-limit infrastructure.

### Phase to-do checklist
- [ ] 2.1 Password reset (forgot + reset pages, actions, token fix)
- [ ] 2.2 Saved address book + checkout selector
- [ ] 2.3 Profile & password change
- [ ] 2.4 Verified-purchase review badge + edit/delete own review
- [ ] 2.5 Printable GST invoice
- [ ] 2.6 Account tests (unit + e2e)

### Task 2.1 — Password reset
**Files:** Create `app/(auth)/forgot-password/page.tsx`, `app/(auth)/password/reset/page.tsx`, `actions/auth/password-reset.ts`, `schemas/auth/password-reset-schema.ts`, `tests/password-reset.test.ts`; modify `routes.ts:33-46`, `lib/token.ts`, `actions/token/index.ts:33-45`, `lib/mail.ts:22-40`.
**Action:** `requestPasswordReset(email)` always returns the same message (no enumeration), rate limit 3/hour/email; invalidate prior tokens; send link `${NEXT_PUBLIC_SITE_URL}/password/reset?token=...`. `resetPassword(token, password)` validates token + `expires > now`, updates bcrypt hash, deletes token. Fix `getPasswordResetTokenByEmail` to query by `email` (currently queries `token` despite its name).
**Mirror:** token generation `lib/token.ts:30-50`; verification flow `actions/auth/index.ts:200-238`.
**Validate:** `npx vitest run tests/password-reset.test.ts`.
**Risk:** JWT sessions cannot be revoked — state in UI that other sessions stay valid until expiry; add token versioning only if required.
**Done when:** valid token resets once; expired/reused token rejected; unknown email returns the same response.

### Task 2.2 — Saved address book + checkout selector
**Files:** Create `prisma/migrations/20261201000000_saved_addresses/migration.sql`, `actions/account/addresses.ts`, `schemas/account/address-schema.ts`, `app/(my-orders)/account/addresses/page.tsx`, `modules/account/components/address-form.tsx`; modify `modules/checkout/components/_checkout-form.tsx`.
**Action:** `SavedAddress` model (userId, label, name, phone, line1/line2, area, landmark, state, postalCode, country, isDefault); CRUD scoped to `session.user.id`; max 10 per user; setting default clears others in a transaction; checkout selector populates the address fields and still submits through `placeOrderSchema`; order `Address` remains an immutable snapshot.
**Mirror:** transaction style `actions/orders/index.ts:217-231`; Zod address rules `place-order-schema.ts:12-28`.
**Validate:** `npx tsc --noEmit && npx vitest run tests/address-schema.test.ts`.
**Risk:** address reuse must not mutate historical orders — never link `Order` to `SavedAddress`.
**Done when:** default address pre-fills checkout; deleting a saved address never changes past orders.

### Task 2.3 — Profile & password change
**Files:** Create `app/(my-orders)/account/page.tsx`, `actions/account/profile.ts`, `schemas/account/profile-schema.ts`; modify `auth.ts` only if session name refresh is needed.
**Action:** Update first/last name (1–60), avatar URL (allowlisted hosts), and password (current password required, bcrypt compare, new password 8–72, reject same); revalidate account page; audit log line.
**Mirror:** bcrypt usage `actions/auth/index.ts:174`; time-safe compare `auth.config.ts:37-41`.
**Validate:** `npx tsc --noEmit && npx vitest run tests/profile-schema.test.ts`.
**Risk:** name change not reflected in existing JWT until next request; `auth.ts:31-40` refreshes from DB per request, so acceptable.
**Done when:** wrong current password rejected; password change requires re-login for other devices (documented).

### Task 2.4 — Verified-purchase reviews + own-review management
**Files:** Modify `actions/products/reviews/add-review/index.ts` (set `verifiedPurchase`), create `actions/products/reviews/manage-review/index.ts`, modify `modules/products/components/reviews/reviews.tsx`, `add-review-form.tsx`.
**Action:** Show “Verified purchase” badge when `verifiedPurchase`; allow one review per user/product (DB unique already); edit/delete own review with ownership check; recompute average over all reviews (not just the 10 loaded — load aggregate in page).
**Mirror:** review creation `add-review/index.ts:8-36`; UI list `reviews.tsx:19-27`.
**Validate:** `npx vitest run tests/review-schema.test.ts && npx tsc --noEmit`.
**Risk:** average rating currently computed from only 10 reviews (`products/[id]/page.tsx:27-38`) — switch to `prisma.review.aggregate`.
**Done when:** badge only for buyers; second review blocked; average matches DB aggregate.

### Task 2.5 — Printable GST invoice
**Files:** Create `app/(my-orders)/my-orders/[id]/invoice/page.tsx`, `modules/orders/components/invoice.tsx`, `app/(my-orders)/my-orders/[id]/invoice/print.css` (or Tailwind print variants).
**Action:** Owner-only invoice with `INV-{YYYY}-{orderId.slice(0,8)}`, seller GSTIN placeholder from env, line items with snapshot names, subtotal/tax/total in rupees derived from paise, “Print / Save as PDF” button (`window.print()`); no new dependency.
**Mirror:** order totals `Order.total/taxAmount`; INR formatting `lib/format-inr.ts:6-13`.
**Validate:** `npm run e2e -- --grep "invoice"`.
**Risk:** GSTIN must be configurable; use `SELLER_GSTIN` env and omit the row when unset.
**Done when:** invoice renders only for owner, totals match order, print CSS hides navigation.

### Task 2.6 — Account tests
**Files:** `tests/integration/address-book.test.ts` (skips without `TEST_DATABASE_URL`), `e2e/account.spec.ts`.
**Action:** Integration test creates a user + addresses, asserts default uniqueness and ownership; e2e updates profile and checks the name in the header.
**Validate:** `TEST_DATABASE_URL=... npx vitest run tests/integration/address-book.test.ts && npm run e2e -- --grep "account"`.
**Risk:** integration DB drift — run `prisma migrate deploy` against the test DB in the script.
**Done when:** tests pass locally and in the Phase 3 CI service.

### Phase 2 acceptance criteria
- [ ] Password reset works once, expires, and does not enumerate emails.
- [ ] Saved addresses are user-scoped and never mutate order history.
- [ ] Profile/password changes validated and audited.
- [ ] Reviews show verified-purchase and enforce one per user/product.
- [ ] Invoice matches stored totals and is owner-only.
- [ ] Full gate green.

---

## 7. Phase 3 — Operations, observability & CI hardening

**Objective:** Make the system operable: structured logs/Sentry, deep health, real e2e in CI, drift/audit checks, enforced CSP, formatting hooks, and removal of the Hono stub.

**Outcome:** Production failures are diagnosable; CI catches schema drift and broken checkout; security posture moves from report-only to enforced.

**Why it matters**
- **SWE:** One logger and one health contract; no bespoke `console.error` strings.
- **DevOps:** CI becomes the deployment gate; Sentry closes the feedback loop.
- **Backend:** DB/Redis health and migration drift are explicit signals.
- **PM:** Faster incident resolution; fewer “works on my machine” regressions.
- **User:** Checkout CSP enforcement is tested, not hoped for.

**Effort:** M (4–6 days). **Dependencies:** Phase 0 env schema; Phase 1 e2e specs.

### Phase to-do checklist
- [ ] 3.1 Structured logger + Sentry (`@sentry/nextjs`)
- [ ] 3.2 Deep `/api/status`; remove Hono `/hello` and dependency
- [ ] 3.3 CI: Postgres service, e2e subset, migration drift, dependency audit
- [ ] 3.4 CSP enforce + report collector
- [ ] 3.5 Prettier/husky/lint-staged + repo hygiene
- [ ] 3.6 Performance indexes and stale-pending-order cleanup

### Task 3.1 — Logger + Sentry
**Files:** Create `lib/logger.ts`, `sentry.client.config.ts`, `sentry.server.config.ts`, `sentry.edge.config.ts`, `tests/logger.test.ts`; modify `instrumentation.ts`, `next.config.ts` (compose `withSentryConfig` around `withMDX`), `lib/env.ts`, `.env.example` (`SENTRY_DSN`, `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT`, `LOG_LEVEL`).
**Action:** JSON logger `{ level, msg, action, requestId, orderId?, durationMs? }`, redacting `authorization`, `cookie`, `razorpay*`, emails; Sentry captures unknown exceptions from `runAction` with tags `action`/`code`; no PII in breadcrumbs. Add dependency `@sentry/nextjs` via `bun add @sentry/nextjs`.
**Mirror:** existing structured-ish logs `actions/orders/index.ts:32,131`.
**Validate:** `npx vitest run tests/logger.test.ts && npm run build`.
**Risk:** Sentry SDK increases bundle size; disable source-map upload when `SENTRY_AUTH_TOKEN` is absent.
**Done when:** a forced `INTERNAL` error appears in Sentry with request id; secret values never appear in logs.

### Task 3.2 — Deep `/api/status`; remove Hono stub
**Files:** Create `app/api/status/route.ts`, `tests/status-route.test.ts`; delete `app/api/[[...route]]/route.ts`; modify `package.json` (`bun remove hono`), `Dockerfile` unchanged.
**Action:** `GET` returns `{ status, checks: { db, redis }, version: process.env.GIT_SHA ?? "dev", uptimeS }`; DB check `SELECT 1`; Redis check only when configured; 200 only if DB ok, 503 otherwise; `cache-control: no-store`. Docker HEALTHCHECK keeps `wget /api/status`.
**Mirror:** current endpoint `app/api/[[...route]]/route.ts:14-20`; healthcheck `Dockerfile:48-49`.
**Validate:** `npx vitest run tests/status-route.test.ts && docker build -t vendary .`.
**Risk:** healthcheck flapping during migrations — DB check timeout 1s, start-period already 20s.
**Done when:** container reports healthy with DB up, unhealthy with DB down; `/api/hello` is gone.

### Task 3.3 — CI: Postgres, e2e, drift, audit
**Files:** Modify `.github/workflows/ci.yml`; create `.github/workflows/e2e.yml` (or one job with services).
**Action:** `postgres:16` service; `bunx prisma migrate deploy`; `npm run db:seed`; `npx playwright install --with-deps chromium`; `npm run e2e -- --grep-invert @payment`; drift step:
`bunx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url "$SHADOW_DATABASE_URL" --exit-code`;
`bun audit` (triage high/critical); keep typecheck/test/lint/build.
**Mirror:** current CI `.github/workflows/ci.yml:13-42`; e2e config `playwright.config.ts:25-45`.
**Validate:** open a draft PR; all jobs green.
**Risk:** e2e runtime/flakiness — one worker, retries 1, cache `.next` by lockfile hash.
**Done when:** CI fails on schema drift and broken browse/cart/checkout subset; audit findings are triaged in the job log.

### Task 3.4 — CSP enforce + report collector
**Files:** Create `app/api/csp-report/route.ts`, `lib/csp.ts`; modify `middleware.ts` (nonce per request), `next.config.ts` (switch `Content-Security-Policy-Report-Only` to `Content-Security-Policy`), `tests/csp.test.ts`.
**Action:** Nonce-based `script-src` for Next inline scripts, `'strict-dynamic'`, keep `https://checkout.razorpay.com`, `https://api.razorpay.com`, `https://lumberjack.razorpay.com`, `frame-src` checkout/api, `report-uri /api/csp-report`; report route logs violations (rate-limited). Keep `unsafe-eval` only in development.
**Mirror:** current policy `next.config.ts:77-90`; middleware `middleware.ts:10-49`.
**Validate:** staged deploy, complete a Razorpay test checkout, assert zero CSP violations for 48h; `npx vitest run tests/csp.test.ts`.
**Risk:** Razorpay injects inline/frame resources — this is the highest-risk task; keep a one-commit rollback to report-only.
**Done when:** enforcing header present in production; no checkout breakage; violations visible in logs.

### Task 3.5 — Prettier/husky/lint-staged + hygiene
**Files:** Create `.prettierrc`, `.prettierignore`, `.husky/pre-commit`, `lint-staged.config.mjs`; modify `package.json` (scripts `format`, `format:check`), `.gitignore` (`.DS_Store`), CI (format check); untrack committed `.DS_Store` files.
**Action:** `bun add -d prettier husky lint-staged`; pre-commit runs `lint-staged` (prettier + eslint on staged files); full `tsc` stays in CI. `git rm --cached` the tracked `.DS_Store` files (`actions/.DS_Store`, `app/.DS_Store`, etc.).
**Mirror:** existing ESLint config `eslint.config.mjs`.
**Validate:** `npx prettier --check . && npm run lint`.
**Risk:** mass formatting diff — run Prettier once in its own commit after feature work.
**Done when:** commits are formatted automatically; no `.DS_Store` tracked.

### Task 3.6 — Performance indexes + pending-order cleanup
**Files:** Create `prisma/migrations/20261215000000_ops_indexes/migration.sql`, `app/api/cron/cleanup/route.ts`, `tests/cleanup.test.ts`; modify `lib/env.ts` (`CRON_SECRET`).
**Action:** Indexes for `OrderItem(productId)`, `Order(status, createdAt)`, `Product(availability, isFeatured, createdAt)`; cleanup route (secret header) cancels `pending` orders older than 60 minutes with no payment (no stock change), deletes stale `Address` rows not referenced by orders, invalidates featured cache; log counts.
**Mirror:** webhook auth-by-secret pattern `webhook/route.ts:27-33`.
**Validate:** `npx vitest run tests/cleanup.test.ts && npx tsc --noEmit`.
**Risk:** deleting addresses referenced by orders — restrict to `order: { is: null }`; never touch confirmed orders.
**Done when:** abandoned pending orders do not accumulate; cleanup is idempotent and logged.

### Phase 3 acceptance criteria
- [ ] Sentry receives masked errors with action/request ids.
- [ ] `/api/status` checks DB + Redis; Docker health still works.
- [ ] CI runs unit + e2e subset + drift + audit.
- [ ] CSP enforced with a working Razorpay checkout.
- [ ] Pre-commit formatting active; repo hygiene clean.
- [ ] Stale pending orders cleaned safely.

---

## 8. Phase 4 — Differentiators

**Objective:** Add revenue and retention features that sit on the now-solid order core: coupons, wishlist, admin analytics, search quality, recommendations, and a deploy runbook.

**Outcome:** A demonstrable, portfolio-grade commerce app with discounts, saved items, revenue insight, and relevant search.

**Why it matters**
- **SWE:** Coupon math is a pure paise function; analytics are SQL aggregates, not a new event pipeline.
- **DevOps:** No new services; optional `pg_trgm` extension only.
- **Backend:** Redemptions are transactional and auditable.
- **PM:** Discounts and wishlists are conversion levers; analytics answer “what sells”.
- **User:** Relevant search, saved products, transparent discounts.

**Effort:** L (6–8 days). **Dependencies:** Phases 0–1; analytics can reuse Phase 3 Sentry/logging for errors.

### Phase to-do checklist
- [ ] 4.1 Coupons + redemptions (migration, admin CRUD, checkout)
- [ ] 4.2 Wishlist
- [ ] 4.3 Admin analytics dashboard (`recharts`)
- [ ] 4.4 Search v2 with `pg_trgm`
- [ ] 4.5 “Customers also bought” recommendations
- [ ] 4.6 Deploy runbook + public demo checklist

### Task 4.1 — Coupons
**Files:** Create `prisma/migrations/20270101000000_coupons/migration.sql`, `lib/coupons.ts`, `schemas/admin/coupons/coupon-schema.ts`, `actions/(admin)/coupons/*`, `actions/cart/apply-coupon.ts`, `app/(admin)/admin/coupons/page.tsx`, `tests/coupons.test.ts`; modify `PlaceOrder`/`createRazorpayOrder` and `Order`.
**Action:** `CouponType PERCENT|FIXED`; validate window, min subtotal, usage limit; `discountPaise = min(...)`; apply before GST (`tax` on discounted subtotal); store `discountAmount`, `couponCode`; create `CouponRedemption` at init with `orderId @unique`; increment `usedCount` with conditional update (`usedCount < usageLimit`) inside the same transaction; release on cancellation before payment. All math in paise, percent rounded once.
**Mirror:** totals `lib/money.ts:23-35`; conditional update `actions/orders/index.ts:258-268`.
**Validate:** `npx vitest run tests/coupons.test.ts && npx tsc --noEmit`.
**Risk:** discount/GST ordering changes totals — pin with tests (`₹1000, 10% → 900 + 72 GST = 972`).
**Done when:** expired/over-limit/invalid coupons rejected; redemption counted once; cancellation releases usage.

### Task 4.2 — Wishlist
**Files:** Create `prisma/migrations/20270101001000_wishlist/migration.sql`, `actions/wishlist/index.ts`, `app/(my-orders)/wishlist/page.tsx`, `modules/products/components/wishlist-button.tsx`, `tests/wishlist.test.ts`.
**Action:** `WishlistItem @@unique([userId, productId])`; toggle action returns `{added:boolean}`; page lists in-stock/out-of-stock with add-to-cart; cache-free (user-specific).
**Mirror:** review ownership `actions/products/reviews/add-review/index.ts:9-16`; product card `modules/products/components/product-card.tsx`.
**Validate:** `npx vitest run tests/wishlist.test.ts`.
**Risk:** auth-required toggle — redirect guests to login with `callbackUrl`.
**Done when:** toggle is idempotent; page is user-scoped.

### Task 4.3 — Admin analytics dashboard
**Files:** Create `app/(admin)/admin/analytics/page.tsx`, `lib/analytics/queries.ts`, `modules/admin/components/revenue-chart.tsx`, `tests/analytics-queries.test.ts`; add `recharts` via `bun add recharts`.
**Action:** SQL aggregates over `Order`/`OrderItem`: revenue by day, AOV, orders by status, top products by qty/revenue, low-stock list; date range via search params, validated; exclude `cancelled/refunded` from revenue; server component fetches, client chart renders.
**Mirror:** admin query style `app/(admin)/admin/page.tsx:43-62`.
**Validate:** `npx vitest run tests/analytics-queries.test.ts && npm run build`.
**Risk:** large tables — use `createdAt` indexes from Phase 1/3; cap range to 365 days.
**Done when:** totals reconcile with raw SQL for the seed data; charts render server data.

### Task 4.4 — Search v2 with `pg_trgm`
**Files:** Create `prisma/migrations/20270101002000_search_trgm/migration.sql`; modify `actions/products/search/index.ts`; test `tests/search-ranking.test.ts`.
**Action:** `CREATE EXTENSION IF NOT EXISTS pg_trgm;` + GIN indexes on `Product.name`, `Product.tag`; query `similarity` ordering with `ILIKE` fallback; keep bounds/rate limits; return top 10.
**Mirror:** current search `actions/products/search/index.ts:5-44`.
**Validate:** integration test against seeded DB; `EXPLAIN` shows bitmap index scan.
**Risk:** extension may be unavailable on managed Postgres tiers — migration guards with `CREATE EXTENSION IF NOT EXISTS` and fallback code path.
**Done when:** typo query (“madhuani”) returns the Madhubani product; p95 < 200ms on 10k rows.

### Task 4.5 — “Customers also bought”
**Files:** Create `lib/recommendations.ts`, `modules/products/components/also-bought.tsx`, `tests/recommendations.test.ts`; modify product detail page.
**Action:** Co-occurrence query over `OrderItem` pairs for the same order, ranked by count, limited to in-stock products; cache per product with TTL; fallback to featured products.
**Mirror:** cache pattern `lib/product-cache.ts:21-33`; featured query `hot-products/index.ts:22-28`.
**Validate:** `npx vitest run tests/recommendations.test.ts`.
**Risk:** cold start with few orders — fallback is mandatory.
**Done when:** a product with co-purchases shows them; empty DB falls back gracefully.

### Task 4.6 — Deploy runbook + public demo
**Files:** Create `docs/runbooks/deploy.md`, `docs/runbooks/incident.md`; modify `README.md` (live URL, architecture, screenshots), `.env.example`; add `scripts/smoke.sh` (read-only curl checks).
**Action:** Vercel + Neon + Upstash + verified Resend domain + Razorpay webhook registration; env matrix; migration order; rollback (previous deployment + `migrate resolve` policy); smoke checklist (`/`, `/products`, `/api/status`, signed webhook test).
**Mirror:** existing README structure `README.md:34-123`.
**Validate:** run `scripts/smoke.sh https://<preview>`.
**Risk:** provider-specific env differences — document Node runtime and `AUTH_TRUST_HOST`.
**Done when:** a fresh preview deploy passes smoke and one test-mode checkout.

### Phase 4 acceptance criteria
- [ ] Coupons validated server-side and redeem exactly once.
- [ ] Wishlist is user-scoped and idempotent.
- [ ] Analytics reconcile with orders and exclude refunded revenue.
- [ ] Search handles typos with bounded latency.
- [ ] Recommendations degrade to featured.
- [ ] Deploy runbook produces a working public demo.

---

## 9. Zod boundary matrix

| Input surface | File:line | Current state | Schema / rule | Enforced |
|---|---|---|---|---|
| Checkout cart | `schemas/checkout/place-order-schema.ts:3-10` | productId min 1, qty 1–99; no array max | `.max(50)` lines; productId `.min(1).max(64)` | Both (client resolver + server) |
| Shipping address | `schemas/checkout/place-order-schema.ts:12-28` | names/address unbounded; pinCode only min 1 | fName 1–60, lName ≤60, pin `/^\d{6}$/`, address 5–200, area 2–100, landmark 1–120, country tuple ≤60 | Both |
| Payment init | `actions/orders/index.ts:93-105` | parsed orderData; **no auth/rate limit** | `requireUser` + 10/min/user + `placeOrderSchema` + `checkoutSessionSchema` | Server |
| Payment confirm | `actions/orders/index.ts:140-169` | address/cart re-parsed; payment details manual checks | `confirmPaymentSchema` (3 non-empty strings, ≤128) | Server |
| Order status | `actions/orders/index.ts:305-313` | string in a list; arbitrary jumps | `z.enum(OrderStatus)` + transition map | Server + UI options |
| Admin price | `actions/(admin)/edit/price.ts:7-19` | no Zod, no role, accepts NaN/negative/overflow | finite 1–10,000,000, ≤2 dp, `ADMIN` | Server + client input `step` |
| Admin description | `actions/(admin)/edit/description.ts:7-63` | no Zod, no length, session only | short 10–300, long 10–5000, `ADMIN` | Server |
| Admin availability | `actions/(admin)/product/take-product-offline.ts:9-22` | TypeScript type only | `z.enum(["IN_STOCK","OUT_OF_STOCK","PRE_ORDER"])`, `ADMIN` | Server |
| Admin create product | `schemas/admin/products/create-product-schema.ts:3-21` | price/stock strings “valid number”; category unchecked | price 1–10,000,000 (2 dp), stock int 0–100000, name ≤120, category exists | Both + server existence query |
| Admin delete | `actions/(admin)/product/delete-product.ts:8-30` | session only; catch hides auth | productId non-empty, `ADMIN`, `deleteMany` count | Server |
| Admin images | `schemas/admin/products/add-image-schema.ts:3-10` | any URL; ownership unchecked | https URL + host allowlist, 1–8 images, `ADMIN` | Both |
| Product search | `actions/products/search/index.ts:5-44` | raw string, unbounded result | q 2–64 trimmed, take 10, 60/min/IP | Server |
| Product list | `actions/products/products/index.ts:11-47` | raw take/skip/category | page ≥1, pageSize 1–48, category ≤60, sort enum | Server |
| Review | `schemas/products/reviews/review-schema.ts:3-9` | rating any number; no max length; product unchecked | product exists, rating int 1–5, text 10–2000, one per user/product | Both + DB unique |
| Webhook | `app/api/razorpay/webhook/route.ts:16-24,47` | `any`, only 2 events | `webhookSchema`; captured/failed/refunded/unknown | Server |
| Login / register | `schemas/auth/*.ts` | Zod present; register password min 8 only | add max 72, email ≤254 | Both |
| Password reset (P2) | new `schemas/auth/password-reset-schema.ts` | none | email ≤254, password 8–72, token UUID | Both |
| Env | none today | placeholders only | `serverEnvSchema` (§4.2) | Server boot |
| Coupons (P4) | new `schemas/admin/coupons/coupon-schema.ts` | n/a | code `/^[A-Z0-9_-]{3,24}$/`, percent 1–100 or fixed 1–1,000,000, window valid | Both + server repricing |

---

## 10. Data-model changes

### Phase 0 — `20261101000000_order_integrity`
```prisma
enum OrderStatus { pending confirmed shipped delivered cancelled refunded }

model Order {
  status        OrderStatus @default(pending)
  paymentId     String      @default("")
  transactionId String      @unique
  // existing total, taxAmount, addressId, userId ...
}

model OrderItem {
  product      Product? @relation(fields: [productId], references: [id], onDelete: SetNull)
  productId    String?
  productName  String
  productImage String?
  // quantity, price unchanged
}
```
SQL highlights:
```sql
CREATE TYPE "OrderStatus" AS ENUM ('pending','confirmed','shipped','delivered','cancelled','refunded');
ALTER TABLE "Order" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Order" ALTER COLUMN "status" TYPE "OrderStatus" USING ("status"::"OrderStatus");
ALTER TABLE "Order" ALTER COLUMN "status" SET DEFAULT 'pending';
ALTER TABLE "Order" ADD CONSTRAINT "Order_transactionId_key" UNIQUE ("transactionId");
ALTER TABLE "OrderItem" ADD COLUMN "productName" TEXT;
ALTER TABLE "OrderItem" ADD COLUMN "productImage" TEXT;
UPDATE "OrderItem" oi SET "productName" = p."name", "productImage" = p."thumbnail"
  FROM "Product" p WHERE oi."productId" = p."id";
UPDATE "OrderItem" SET "productName" = 'Unknown product' WHERE "productName" IS NULL;
ALTER TABLE "OrderItem" ALTER COLUMN "productName" SET NOT NULL;
ALTER TABLE "OrderItem" DROP CONSTRAINT "OrderItem_productId_fkey";
ALTER TABLE "OrderItem" ALTER COLUMN "productId" DROP NOT NULL;
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;
```

### Phase 0 — `20261101001000_review_integrity`
```prisma
model Review {
  verifiedPurchase Boolean @default(false)
  @@unique([userId, productId])
}
```
```sql
ALTER TABLE "Review" ADD COLUMN "verifiedPurchase" BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX "Review_userId_productId_key" ON "Review"("userId","productId");
```
Pre-check duplicates; reconcile manually (keep newest) before deploy.

### Phase 0 — `20261101002000_drop_analytics`
```sql
DROP TABLE "Analytics";
```
Remove `User.analytics Analytics[]`. Requires `SELECT COUNT(*) FROM "Analytics" = 0`. If the user prefers to keep analytics, see open decision 4.

### Phase 1 — `20261115000000_refunds_and_events`
```prisma
model Refund {
  id               String   @id @default(cuid())
  orderId          String
  order            Order    @relation(fields: [orderId], references: [id], onDelete: Cascade)
  razorpayRefundId String   @unique
  paymentId        String
  amount           Decimal  @db.Decimal(10, 2)
  reason           String
  status           String
  createdAt        DateTime @default(now())
  @@index([orderId])
}

model OrderEvent {
  id         String       @id @default(cuid())
  orderId    String
  order      Order        @relation(fields: [orderId], references: [id], onDelete: Cascade)
  type       String
  fromStatus OrderStatus?
  toStatus   OrderStatus?
  actorId    String?
  metadata   Json?
  createdAt  DateTime     @default(now())
  @@index([orderId, createdAt])
}
```
Add `refunds Refund[]` and `events OrderEvent[]` to `Order`.

### Phase 1 — `20261115001000_catalog_indexes`
```prisma
model Product  { @@index([availability, createdAt]) @@index([categoryId, price]) }
model Order    { @@index([userId, createdAt]) @@index([status, createdAt]) }
model OrderItem{ @@index([orderId]) @@index([productId]) }
model Review   { @@index([productId, createdAt]) }
```

### Phase 2 — `20261201000000_saved_addresses`
```prisma
model SavedAddress {
  id         String   @id @default(cuid())
  userId     String
  user       User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  label      String?
  firstName  String
  lastName   String   @default("")
  phone      String
  line1      String
  line2      String?
  area       String
  landmark   String?
  state      String
  postalCode String
  country    String
  isDefault  Boolean  @default(false)
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt
  @@index([userId])
}
```
`Address` remains the immutable order snapshot; `Order.addressId @unique` unchanged.

### Phase 4 — `20270101000000_coupons`
```prisma
enum CouponType { PERCENT FIXED }

model Coupon {
  id           String   @id @default(cuid())
  code         String   @unique
  type         CouponType
  value        Decimal  @db.Decimal(10, 2)
  minSubtotal  Decimal  @default(0) @db.Decimal(10, 2)
  maxDiscount  Decimal? @db.Decimal(10, 2)
  startsAt     DateTime
  endsAt       DateTime
  usageLimit   Int?
  usedCount    Int      @default(0)
  isActive     Boolean  @default(true)
  redemptions  CouponRedemption[]
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
}

model CouponRedemption {
  id        String   @id @default(cuid())
  couponId  String
  coupon    Coupon   @relation(fields: [couponId], references: [id], onDelete: Restrict)
  orderId   String   @unique
  order     Order    @relation(fields: [orderId], references: [id], onDelete: Cascade)
  userId    String
  amount    Decimal  @db.Decimal(10, 2)
  createdAt DateTime @default(now())
  @@unique([couponId, userId])
}
```
Add `discountAmount Decimal @default(0)`, `couponCode String?` to `Order`.

### Phase 4 — `20270101001000_wishlist`
```prisma
model WishlistItem {
  id        String   @id @default(cuid())
  userId    String
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  productId String
  product   Product  @relation(fields: [productId], references: [id], onDelete: Cascade)
  createdAt DateTime @default(now())
  @@unique([userId, productId])
}
```

**Future, explicitly not in this plan:** multi-currency charging, marketplace payouts, returns/RMA workflow, tax jurisdiction engine, guest checkout. Keep `Order.user onDelete: Cascade` until user deletion exists; revisit to `Restrict` when account deletion ships.

---

## 11. Test strategy

### Phase 0
| File | Type | Proves |
|---|---|---|
| `tests/action-result.test.ts` | unit | AppError mapping, unknown-error masking, guards |
| `tests/env.test.ts` | unit | required/optional env, paired Google vars, build guard |
| `tests/rate-limit.test.ts` | unit | window, isolation, retry-after, async fallback |
| `tests/rate-limit-redis.test.ts` | unit | INCR/PEXPIRE path, Redis outage fail-open |
| `tests/order-confirmation.test.ts` | unit (mocked Prisma) | confirm once, stock once, amount mismatch refund, replay |
| `tests/webhook-route.test.ts` | unit (mocked) | signature, captured, failed, refunded, unknown, 500 retry |
| `tests/webhook-schema.test.ts` | unit | payload typing, missing entities |
| `tests/admin-schemas.test.ts` | unit | NaN/negative/overflow/price precision, category, image host |
| `tests/order-status.test.ts` | unit | transition map, restore once, rejected jumps |
| `tests/product-schemas.test.ts` | unit | search/query bounds, sort enum |
| `tests/review-schema.test.ts` | unit | int rating, length, verified flag |
| `e2e/payment.spec.ts` (update) | e2e @payment | init→pay→confirm with new contract |
| `e2e/webhook-backstop.spec.ts` | e2e @payment | signed webhook confirms a pending order |

**Production-safe pattern to assert in review:** no exported mutation throws for an expected rejection. Expected failures return `{ ok: false, code, message }`; only `runAction` converts unknown throws to `INTERNAL`. Example test:
```ts
const res = await createRazorpayOrder({ checkoutSession, orderData });
expect(res).toEqual({ ok: false, code: "UNAUTHORIZED", message: expect.any(String) });
expect(razorpayOrdersCreate).not.toHaveBeenCalled();
```

### Phase 1
- `tests/cart-quote.test.ts` — authoritative pricing, missing/out-of-stock issues, paise math.
- `tests/cancel-order.test.ts` — allowed transitions, stock restore once, replay conflict.
- `tests/refund.test.ts` — Razorpay refund called once, `Refund` uniqueness, failure leaves status.
- `tests/order-emails.test.ts` — one email per event, Resend failure non-fatal.
- `tests/integration/order-lifecycle.test.ts` — real Postgres (skip without `TEST_DATABASE_URL`): concurrent `confirmOrder`, unique transaction id, SetNull snapshot.
- e2e: `checkout-drift.spec.ts`, `order-detail.spec.ts`, `cancel-order.spec.ts`, `catalog.spec.ts`.

### Phase 2
- `tests/password-reset.test.ts` — enumeration-safe response, expiry, one-time token.
- `tests/address-schema.test.ts`, `tests/profile-schema.test.ts` — bounds, ownership.
- `tests/integration/address-book.test.ts` — default uniqueness, user scoping.
- e2e: `account.spec.ts`, `invoice.spec.ts`.

### Phase 3
- `tests/logger.test.ts` — redaction, JSON shape.
- `tests/status-route.test.ts` — DB ok/down, Redis optional.
- `tests/cleanup.test.ts` — stale pending only, idempotent.
- `tests/csp.test.ts` — header directives include Razorpay hosts and report URI.
- CI e2e: `npm run e2e -- --grep-invert @payment`.

### Phase 4
- `tests/coupons.test.ts` — percent/fixed, min subtotal, expiry, usage limit, GST ordering.
- `tests/wishlist.test.ts` — idempotent toggle, scoping.
- `tests/analytics-queries.test.ts` — revenue excludes refunded, date range.
- `tests/search-ranking.test.ts` — trigram ordering + fallback.
- `tests/recommendations.test.ts` — co-occurrence, fallback.

**Commands:** `npm test` (all unit), `npx vitest run tests/<file>.test.ts`, `npm run e2e -- --grep-invert @payment`, `TEST_DATABASE_URL=... npx vitest run tests/integration`.

---

## 12. Commit sequence

```text
feat(actions): add ActionResult contract and auth guards
feat(env): validate runtime env with build-safe instrumentation
feat(rate-limit): redis-backed limiter with memory fallback
feat(orders): create durable pending order before payment
feat(db): enforce unique payment ids, order snapshots, review uniqueness
fix(orders): confirm orders idempotently and refund unfulfillable captures
feat(webhook): type Razorpay payloads and handle failed/refunded events
feat(admin): validate and authorize catalog mutations
feat(orders): enforce status transitions and stock restoration
fix(catalog): bound search, product queries, reviews and featured products
test(orders): pin confirmation, refund and webhook behavior
docs(phase0): document migration pre-checks and result contract

feat(cart): add server quote and paise-native cart storage
feat(catalog): paginate, sort and filter products
feat(orders): add customer order detail and timeline
feat(orders): add cancel/refund with refund and event audit
feat(mail): send transactional order emails
feat(admin): show all products and orders to every admin
refactor(ui): surface typed action errors in every mutation
test(e2e): cover price drift, order detail and cancellation

feat(auth): complete password reset flow
feat(account): add saved addresses and checkout selector
feat(account): add profile and password change
feat(reviews): verify purchases and manage own reviews
feat(orders): add printable GST invoice
test(account): cover addresses and reset tokens

feat(observability): add structured logger and Sentry
feat(api): deep health check and remove Hono stub
ci: run e2e, migration drift and dependency audit
feat(security): enforce CSP with report collector
chore(repo): prettier, husky and tracked-file hygiene
perf(db): add operational indexes and pending-order cleanup

feat(coupons): add coupon validation and redemption
feat(wishlist): add saved products
feat(admin): add revenue and top-product analytics
feat(search): add trigram search ranking
feat(recommendations): add customers-also-bought
docs(deploy): add production runbook and smoke checklist
```

---

## 13. Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `transactionId` unique index fails on existing duplicates | M | H | Run pre-check; reconcile manually before deploy; deploy single-instance/maintenance window |
| Enum cast locks `Order` table | M | M | Run in low-traffic window; table is small; monitor lock time |
| Webhook vs client callback double confirmation | M | H | `updateMany` status guard; stock decrement only after claiming transition |
| Captured payment for sold-out item | M | H | Auto-refund in `confirmOrder` failure path; alert on refund API failure |
| Razorpay refund API requires payment id / partial amounts | M | M | Store `paymentId` at confirm; refund full captured amount; `Refund` unique id |
| Next masks thrown server-action errors | H | M | All expected rejections return `ActionResult`; `runAction` masks unknown only |
| CI build lacks Razorpay/Resend keys | H | M | `NEXT_PHASE` guard in instrumentation; placeholders in Docker/CI |
| Redis outage locks users out | M | M | Limiter fails open with log; memory fallback |
| CSP enforcement breaks Razorpay checkout | M | H | Nonce + explicit Razorpay hosts; staged rollout; one-commit rollback to report-only |
| Resend domain unverified | H | M | Use `onboarding@resend.dev` in staging; document domain verification before Phase 1 emails |
| Single-store admin assumption wrong | M | M | Open decision 1; `Product.userId` retained for future scoping |
| Legacy localStorage cart shape | H | L | Normalize `price`→`pricePaise` on read; quote blocks unpriceable items |
| Playwright flakiness in CI | M | M | One worker, retries 1, deterministic seeded DB, no real payment keys |
| `pg_trgm` unavailable on managed Postgres | L | M | `CREATE EXTENSION IF NOT EXISTS` + ILIKE fallback path |
| Coupon/GST ordering mismatch | M | M | Pure function tests with pinned paise examples |

---

## 14. Open decisions for the user (max 5)

1. **Admin model: single-store vs multi-vendor.** Recommendation: **single-store** — every `ADMIN` sees and edits all products; `Product.userId` remains creator audit. This removes the hidden-product bug immediately. Choose multi-vendor only if seller isolation is a real product goal (then add `Product.sellerId` and scope queries + mutations).
2. **Price changed between payment init and capture.** Recommendation: **reprice at confirmation and auto-refund on mismatch** (`PRICE_CHANGED`), preserving the server-authoritative invariant. Alternative: honor the init quote and skip reprice (better UX, weaker invariant).
3. **Auto-refund policy for captured-but-unfulfillable orders.** Recommendation: **auto-refund immediately** (stock sold out, amount mismatch) and show “refund initiated”; keep manual refund for customer cancellations after shipment.
4. **Dead `Analytics` model.** Recommendation: **drop it in Phase 0** (`COUNT(*) = 0` confirmed) and build Phase 4 analytics from `Order` aggregates. Alternative: repurpose it as an event table, which adds write volume without a current consumer.
5. **Email sender/domain.** Recommendation: **verify a Resend domain (e.g. `orders@vendary.in`) before Phase 1 emails**; until then, send only to the admin/test address from `onboarding@resend.dev` and log the rendered payload. This avoids silently dropped customer emails.

---

### Critical Files for Implementation
- `/Users/mahesh/Developer/Vendary/actions/orders/index.ts`
- `/Users/mahesh/Developer/Vendary/prisma/schema.prisma`
- `/Users/mahesh/Developer/Vendary/app/api/razorpay/webhook/route.ts`
- `/Users/mahesh/Developer/Vendary/lib/rate-limit.ts`
- `/Users/mahesh/Developer/Vendary/modules/checkout/components/_checkout-form.tsx`
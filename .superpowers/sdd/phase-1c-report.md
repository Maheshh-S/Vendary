# Phase 1C — implementation report

**Status:** complete for Tasks 1.5–1.8 and the two Phase 1B re-review fixes.

**Branch:** `worktree-phase-1-4` (worktree `/Users/mahesh/Developer/Vendary/.qoder/worktrees/phase-1-4`)

## Commits

| SHA | Subject |
| --- | --- |
| `0e4d176` | `feat(mail): send transactional order emails once per order event` |
| `45e05e2` | `fix(orders): guard automatic refunds and cart write-backs` |
| `a4e32de` | `feat(admin): search and page the multi-admin catalog and orders` |
| `ed337a5` | `fix(ui): surface typed action errors and field errors` |
| `138e9ed` | `test(e2e): cover checkout drift, cancellation and admin search` |

---

## Task 1.5 — transactional order emails

### New modules
- `lib/mail.ts` — `sendOrderEmail(orderId, kind)` for
  `confirmation | shipped | delivered | cancelled | refunded`.
  - Transport/config is resolved at call time: sending requires
    `RESEND_API_KEY` **and** a sender. `EMAIL_FROM` is the sender; `next dev`
    (NODE_ENV=development) falls back to Resend's shared
    `onboarding@resend.dev`, while production/e2e skip when `EMAIL_FROM` is
    blank. This also removes the previous module-load `new Resend(undefined)`
    throw in keyless environments (verification/reset mail now no-ops too).
  - Recipients: the order owner's email plus `ORDER_NOTIFICATION_EMAIL` when
    configured, deduplicated.
  - Idempotency: an `OrderEvent { type: "order_email_sent", toStatus, metadata: { kind } }`
    is written **before** the Resend call; a second send for the same kind is
    skipped. `ORDER_EMAIL_EVENT_TYPE` lives in `lib/orders/events.ts` and is in
    the typed allowlist.
  - Every failure (config, DB, Resend `{error}`, thrown network error) is
    logged as `{"level":"warn","event":"order_email_failed",orderId,kind,error}`
    and returned as `{ status: "failed" }`; it never throws.
- `lib/html.ts` — `escapeHtml` for `& < > " '`.
- `templates/mail/types.ts`, `order-layout.ts`, `order-confirmation.tsx`,
  `order-status.tsx` — dependency-free escaped HTML with order id, item
  names/quantities, paise-derived subtotal/tax/total (via `formatINR`), status
  and the shipping address.
- `tests/order-emails.test.ts` (15 tests) — one email per event, marker written
  before send, independent kinds, escaping, store-inbox copy/dedupe, Resend
  error and rejection non-fatal, no config/key → no DB access or send,
  production without `EMAIL_FROM` skipped, dev fallback sender, no recipients,
  missing order, all status subjects.

### Wiring (post-commit only)
- `PlaceOrder` (client success) and the webhook's `payment.captured` confirm
  branch → `confirmation` (idempotent, so whichever runs second is a no-op).
- `updateOrderStatus` → `shipped` / `delivered` / `cancelled` / `refunded` when
  the transition lands.
- `cancelOrder` (pending and confirmed paths) → `cancelled`.
- `refundOrder` (admin) → `refunded`.
- `refundAndClose` (automatic AMOUNT_MISMATCH / PRICE_CHANGED / OUT_OF_STOCK
  refunds) → `refunded`, only when the order actually closed.
- `refund.processed` webhook transition → `refunded` (covers refunds issued
  outside our actions).
- `order_email_sent` events are filtered from the customer timeline (internal
  delivery marker, not a customer event).

### Env
- `.env.example`: `EMAIL_FROM` (sender; documented `onboarding@resend.dev`
  value until the domain is verified) and `ORDER_NOTIFICATION_EMAIL`.
- `lib/env.ts`: both optional (`optionalString`).

## Task 1.6 — multi-admin surface

- New `lib/admin/search.ts`: `parseAdminSearchQuery` (q ≤ 100 chars, page
  1–10,000, arrays use the first value), `buildAdminProductWhere`
  (name/tag contains), `buildAdminOrderWhere` (id/paymentId/user.email
  contains), `adminHref` (preserves q/page), `adminSkip`, `ADMIN_PAGE_SIZE=50`.
  Neither where builder has a `userId` predicate; tests pin that structurally.
- `app/(admin)/admin/page.tsx`: `searchParams: Promise<{q,page}>`; counts then
  queries (50 rows each); per-table page clamp; product query includes
  `user: { select: { email: true } }`; creator email column added; order rows
  show the short order id so id-search results are legible; pagination uses the
  shared `Pagination` components; `data-testid`s for products/orders tables,
  search summary and creator cells.
- New `modules/admin/components/admin-search-controls.tsx`: plain GET form
  (submitting resets `page`, keeps `q`), Clear link.
- Mutations untouched: every admin action still starts with `requireAdmin`
  plus the `adminMutation` limiter.
- `tests/admin-search.test.ts` (17): sanitizers, no userId in either where,
  search fields, 50-row pagination, link params/encoding.
- `e2e/admin.spec.ts` (2): both tables + creator email render; `q=Jaipur`
  filters products, a no-match term empties both tables.

## Task 1.7 — result-contract UX sweep

Every client call to an action returning `ActionResult` was checked. “Already
ok” means `res.ok` was checked and `res.message` surfaced before this phase.

| Call site | Action | Result |
| --- | --- | --- |
| `modules/checkout/components/_checkout-form.tsx` | `createRazorpayOrder` | **fixed** — maps `fieldErrors` onto the address form, toast prefers the first field message |
| `modules/checkout/components/_checkout-form.tsx` | `PlaceOrder` (react-query mutation) | already ok — `res.ok` + verbatim `res.message` |
| `modules/products/components/reviews/add-review-form.tsx` | `addReview` | **fixed** — maps review/rating/productId errors via `setError`, root error rendered, toast shows the field message (“You already reviewed this product.”) |
| `modules/admin/edit/price.tsx` | `editPrice` | **fixed** — shows `fieldErrors.price[0]` |
| `modules/admin/edit/description-form.tsx` | `editShortDescription`, `editLongDescription` | **fixed** — shows the field-specific message |
| `modules/admin/components/take-offline-switch.tsx` | `takeProductOffline` | already ok — ok check, message toast, optimistic rollback |
| `modules/admin/components/add-image-form.tsx` | `addImagesToProduct` | already ok — ok check + first `fieldErrors` detail |
| `modules/admin/components/create-product-form.tsx` | `createProduct` | already ok — ok check + schema-mapped `fieldErrors` |
| `modules/admin/components/delete-product-button.tsx` | `deleteProduct` | already ok |
| `modules/admin/components/order-status-select.tsx` | `updateOrderStatus` | already ok — controlled value snaps back, message shown |
| `modules/orders/components/cancel-order-button.tsx` | `cancelOrder` | already ok — message + race-status copy |
| `modules/admin/components/refund-order-button.tsx` | `refundOrder` | already ok — message + reconciliation-status copy |
| `modules/shopping/components/shopping-nav/search-input/form.tsx` | `searchProducts` | already ok — `res.ok` checked, `res.message` thrown/rendered |
| `hooks/use-cart-quote.ts` | `getCartQuote` | already ok — error surfaced by cart/checkout banner |
| `app/(shopping)/products/page.tsx` | `GetProducts` | already ok — failure UI |
| `modules/auth/forms/login/form.tsx` | `Login` | legacy `{success}`/throw contract, not `ActionResult`; unchanged |
| `modules/auth/forms/register/form.tsx` | `Register` | legacy contract; unchanged |
| `modules/new-verification/form/new-verification-form.tsx` | `newVerification` | legacy contract; unchanged |
| `modules/auth/components/google-sign-in-button.tsx` | `signInProvider` | legacy `{error}` contract; unchanged |

Non-`ActionResult` server reads (`getBasicProductDetails`, `GetFeaturedProducts`,
`lib/token.ts`) were checked and left as-is. No action contract changed.

## Task 1.8 — E2E

- `e2e/checkout-drift.spec.ts` — login, add a product, open the cart, capture
  the authoritative totals, set `cart-items[0].unitPaise = 1`, reload: the
  drift banner appears and the cart totals are unchanged; proceed to checkout
  and assert the checkout Subtotal/Total equal the cart quote (and no drift
  warning, because the session is built from the quote).
- `e2e/cancel-order.spec.ts` — deterministic `pending`, `paymentId: ""`
  fixture for the demo admin via Prisma (local/CI DB guard), opens
  `/my-orders/[id]`, accepts the confirm dialog, clicks Cancel, asserts the
  cancelled status + timeline, then verifies the persisted status and
  `order_cancelled` event. Fixture order/address deleted in `afterAll`.
- `e2e/admin.spec.ts` — cheap admin smoke: tables, creator email, search.
- `e2e/payment.spec.ts` — unchanged; the real Razorpay test-mode flow still
  passes, so no UI change was needed.
- `e2e/helpers.ts` — the UI login action is rate limited to 5/IP/min, and the
  added specs pushed parallel logins past it (two failures on the first run).
  `login(page)` now signs in through Auth.js's credentials endpoint (real
  provider, no UI action limiter) and proves the session via `/my-orders`;
  `loginThroughForm` keeps the real form path exercised by the smoke test.

## Re-review fixes

1. **Cart lost update** — `CartProvider.addItem` now writes back with
   `setItems(prev => mergeCartItem(prev, normalized))`; the line cap is
   enforced inside `mergeCartItem` (the closure check remains for the immediate
   boolean/toast).
2. **Automatic refund ledger guard** — `recordAutomaticRefund` updates an
   existing row only when `status: "requested"`, so a webhook-first
   `processed` (or `failed`) row is not overwritten; its `refund_processed`
   event now carries `fromStatus: "pending"` / `toStatus: "refunded"`.
3. **Missing tests** — `tests/order-confirmation.test.ts` adds:
   late-capture `refund_failed` (support message, failed ledger, events,
   correct logs), late-capture `already_handled` (CONFLICT, no second refund),
   P2002 insert-race retried as an update, and a processed ledger row left
   untouched.

---

## Verification

| Command | Result |
| --- | --- |
| `npx vitest run` | **23 files, 563 tests passed** |
| `npx tsc --noEmit` | clean |
| `npm run lint` | no warnings or errors |
| `DATABASE_URL=…local… npm run e2e -- --grep-invert @payment` | **18 passed** (27.0s) |
| `DATABASE_URL=…local… npm run e2e -- --grep @payment` | **1 passed** (real Razorpay test keys + network; 22.8s) |
| `next build` with placeholder secrets | exit 0; with the local DB the log is clean (no Prisma/Redis errors) |
| `npx prisma migrate status` | 9 migrations, schema up to date (no migration in 1C) |

First non-payment run: 16 passed / 2 failed, both login timeouts caused by the
5/IP/min `Login` action limit under parallel workers; fixed in the helper as
described above and re-run green. No application rate limit was weakened.

## Self-review

- **Emails are post-commit and non-fatal.** No send happens inside a DB
  transaction; `sendOrderEmail` never throws, so a mail outage cannot roll back
  a confirm/refund/status change. The idempotency marker is written first, so
  retries cannot duplicate a send.
- **No PII/secrets added to logs.** Email logs carry order id + kind + provider
  error only; templates carry only the order's own data (items, totals,
  address, phone) and every interpolated value is escaped.
- **No new dependencies.** Templates are plain HTML strings; Resend is lazy.
- **Single-store admin.** Neither admin where builder references `userId`;
  creator email is display-only. Admin actions still gate on `requireAdmin` +
  rate limit.
- **Contracts untouched.** The UX sweep only reads `res.ok` / `res.message` /
  `res.fieldErrors`; no action signature or error code changed.
- **Money semantics untouched.** Confirm/refund/stock claims and webhook
  transition matrix are unmodified; the refund fix only narrows a ledger
  update and enriches an event.
- **E2E auth helper** bypasses the UI action's rate limiter but not the
  provider; the real form login remains covered by the smoke spec.

## Concerns

1. **Failed email is not retried automatically.** The marker is written before
   the send, so a Resend outage leaves `order_email_sent` behind. Admins must
   re-send manually (or a follow-up could add a `failed` status marker and a
   retry job). This is the documented consequence of “one email per event”.
2. **No unique index on email markers.** Two truly concurrent
   `sendOrderEmail(orderId, sameKind)` calls could both miss the marker and
   send twice. All current callers are sequential request paths; closing this
   needs a migration (e.g. a unique `(orderId, type, kind)` representation).
3. **Store inbox is in `to`, not `bcc`.** `ORDER_NOTIFICATION_EMAIL` receives a
   copy alongside the customer, so a reply-all could reach it. BCC would avoid
   leaking the internal address if that matters.
4. **Record-only status changes still email.** `updateOrderStatus` to
   `refunded` sends the refund email even though that path does not move money
   (Phase 0 record-only override). The Refund button is the money-moving path;
   if record-only transitions should be silent, gate the email on
   `payment proof`/action origin.
5. **Failed automatic refunds keep status.** As before, a Razorpay refund
   failure leaves the order pending/cancelled and records `refund_failed`; the
   new email is only sent on a successful close.
6. **Admin `page` is shared by both tables.** Each table clamps independently
   to its own page count, so on a page beyond a table's range that table shows
   its last page. Separate `ordersPage`/`productsPage` params would be more
   precise if wanted.
7. **`e2e/admin.spec.ts` assumes the seeded “Jaipur” product** (same assumption
   as the existing catalog specs). A custom unseeded DB will fail that search
   assertion rather than skip.
8. **Automatic refunds leave a processed row untouched even if the Razorpay
   refund id differs.** Phase 1 allows one full refund per order, so this is a
   theoretical conflict; a second distinct refund would need partial-refund
   support first.
9. `.qoder/settings.local.json` remains untracked and was not committed.

---

## Fix round 1

Addresses Phase 1C review finding "record-only status changes send a false
refund email" (Concerns #3/#4) plus cheap minors.

### Important — record-only status changes no longer email

`STATUS_EMAIL_KINDS` in `actions/orders/index.ts` now maps only `shipped` and
`delivered`. The admin dropdown's record-only `cancelled`/`refunded`
transitions (which issue no Razorpay refund) send nothing, so the customer is
never told "your refund was processed" when no money moved. The money-moving
paths are untouched and still send their own emails:

- customer cancel → `actions/orders/cancel.ts` (`cancelled`, pending and
  refund paths);
- admin refund → `actions/(admin)/orders/refund.ts` (`refunded`);
- automatic refunds → `lib/orders/refund.ts` (`refunded`);
- refund webhook → `app/api/razorpay/webhook/route.ts` (`refunded`).

Tests added:
- `tests/order-status.test.ts` (now mocks `@/lib/mail`): exactly one `shipped`
  email for `confirmed → shipped`, exactly one `delivered` for
  `shipped → delivered`, **zero** emails for record-only
  `confirmed → cancelled` and `confirmed → refunded`, and zero on a failed
  transition.
- `tests/cancel-order.test.ts`: pending cancel and confirmed refund cancel each
  send exactly one `cancelled` email.
- `tests/refund.test.ts`: admin refund sends exactly one `refunded` email.

### Minors

1. `lib/mail.ts`: `getOrderMailConfig()` now sits inside `sendOrderEmail`'s
   try/catch, so even a transport-construction failure returns
   `{ status: "failed" }` instead of throwing on the checkout/refund response
   path. Covered by a test that makes the Resend constructor throw.
2. `lib/mail.ts`: with both addresses present, the customer is `to:` and
   `ORDER_NOTIFICATION_EMAIL` is `bcc:` (internal address no longer exposed to
   reply-all). A store-only order uses the store address as `to:`; an address
   equal to the customer's is deduplicated. Tests updated/added.
3. `playwright.config.ts`: `webServer.env` forces `EMAIL_FROM: ""` and
   `ORDER_NOTIFICATION_EMAIL: ""`, so e2e never sends real email regardless of
   the developer's `.env`.
4. `modules/orders/components/order-timeline.tsx`: removed the dead
   `confirmation_sent` / `shipped_sent` labels (only `order_email_sent` exists).
5. `e2e/admin.spec.ts`: the vacuous `not.toHaveCount(0)` was replaced with a
   seeded-product assertion ("Jaipur Blue Pottery Vase"), alongside the
   existing creator-email cell assertion.

### Verification

| Command | Result |
| --- | --- |
| `npx vitest run` | **23 files, 570 tests passed** |
| `npx tsc --noEmit` | clean |
| `npm run lint` | no warnings or errors |
| `DATABASE_URL=…local… npm run e2e -- --grep-invert @payment` | **18 passed** (27.6s) |
| `next build` with placeholder secrets | exit 0 |

### Files changed

`actions/orders/index.ts`, `lib/mail.ts`, `playwright.config.ts`,
`modules/orders/components/order-timeline.tsx`, `e2e/admin.spec.ts`,
`tests/order-status.test.ts`, `tests/order-emails.test.ts`,
`tests/cancel-order.test.ts`, `tests/refund.test.ts`,
`.superpowers/sdd/phase-1c-report.md`.

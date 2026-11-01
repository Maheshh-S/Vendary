# Phase 4A report — Coupons + Wishlist

Note: the implementation agent hit its turn limit after completing the work and
before committing the wishlist half or writing this report. The controller
inspected the staged changes, ran the full gate, committed them, and reconstructed
this summary.

## 4.1 Coupons + redemptions
- Schema/migration `20270101000000_coupons`: `CouponType`, `Coupon`,
  `CouponRedemption` (orderId unique, coupon+user unique), and
  `Order.discountAmount`/`couponCode`.
- `lib/coupons.ts`: paise-only percent/fixed discount math, min subtotal,
  window, usage limit, max-discount cap, and GST on the discounted subtotal.
- `getCartQuote(lineItems, couponCode?)` returns discount/coupon error and
  discounted totals; checkout applies/removes a code and blocks payment on an
  invalid one.
- `createRazorpayOrder` revalidates the coupon, charges the discounted total,
  stores the discount/code, and creates the redemption while incrementing
  `usedCount` conditionally (`usedCount < usageLimit`).
- Pending-order cancel and the cleanup cron release the redemption and
  decrement `usedCount`; paid/refunded orders keep it used.
- Admin CRUD (list/create/update/deactivate) with ADMIN + Zod + rate limit and
  a `/admin/coupons` page.
- Tests: `tests/coupons.test.ts` + `e2e/coupons.spec.ts` (valid code applies,
  invalid code blocks payment).

## 4.2 Wishlist
- Schema/migration `20270101001000_wishlist`: `WishlistItem` with
  `@@unique([userId, productId])`.
- `actions/wishlist/index.ts`: user-scoped toggle/list (idempotent toggle,
  product summaries).
- Heart toggles on product cards/detail; `/wishlist` page lists in-stock and
  out-of-stock items; guests are sent to login with a validated internal
  `callbackUrl` (`routes.safeInternalPath`, login schema/action/UI updated).
- Tests: `tests/wishlist.test.ts`, `e2e/wishlist.spec.ts`.

## Verification
- `npx vitest run`: 754 passed, 3 DB-gated skipped.
- `npx tsc --noEmit`: clean.
- `npm run lint`: clean.
- `npm run format:check`: clean.
- `DATABASE_URL=local npm run e2e -- --grep-invert @payment`: 30 passed
  (including coupons and wishlist).
- `npm run build` with local env: exit 0.
- Local migrations applied: coupons + wishlist; Prisma client generated.

## Concerns
- The coupon + GST ordering is pinned by tests; partial refunds remain out of
  scope (full refunds only in Phase 1).
- `usedCount` is conditional but the redemption create/increment relies on the
  transaction; concurrency is covered by the conditional update.
- Wishlist is user-specific and uncached by design.

## Fix round 1

### Abandoned-checkout coupon lockout
- `createRazorpayOrder`'s transaction now looks up the caller's existing
  redemption for the coupon (`couponId_userId`). If its order is `pending`
  with `paymentId: ""`, it is cancelled with a guarded `updateMany`, an
  `order_cancelled` event is written with `metadata.source: "coupon_reuse"`,
  and `releaseCouponForOrder` deletes the redemption and decrements
  `usedCount` (guarded `> 0`). A paid/confirmed order, a recorded payment
  proof, or a lost cancel claim still returns CONFLICT ("You have already used
  this coupon."). Tests cover reuse, paid, payment-proof and lost-race paths.

### Admin coupon update/reactivate
- `/admin/coupons` rows now use `modules/admin/components/coupon-row.tsx`:
  inactive coupons get a Reactivate button (full-row `updateCoupon` call with
  `isActive: true`), active ones keep Deactivate, and Edit opens an inline
  form for window/usage/maxDiscount that also goes through `updateCoupon`.
- `coupon-deactivate-button.tsx` removed (superseded). New test asserts
  `updateCoupon` is FORBIDDEN for non-admins and toggles `isActive` for ADMIN.

### ₹1 Razorpay floor
- `lib/coupons.ts` exports `MIN_PAYABLE_AMOUNT_PAISE` (100) and
  `MIN_PAYABLE_AMOUNT_MESSAGE`; both the quote and the charge path use them.
  `getCartQuote` sets `couponError` when a valid coupon drops the total below
  ₹1, so `shouldBlockCheckout` disables payment and checkout renders the
  message. Unit test + e2e (100% coupon blocks payment) added.

### Cheap minors
- `safeInternalPath` tests: `//evil.example`, `/\evil`, absolute URLs,
  `javascript:`, bare relative paths and encoded `/%2F%2Fevil` (still
  internal-only). New `tests/routes.test.ts`.
- Google sign-in accepts the validated `callbackUrl`
  (`signInProvider("google", callbackUrl)` → `safeInternalPath(...)`) and the
  login form forwards it.
- `toggleWishlist` is rate limited at 60/min/user (`RATE_LIMITS.wishlistToggle`);
  rejection path tested.
- Cleanup cron test: a pending order with a redemption releases it and
  decrements `usedCount`.
- Coupon-code schema deduplicated into
  `schemas/checkout/coupon-code-schema.ts` (trim + uppercase via
  `normalizeCouponCode`), imported by both the quote and order-init paths.
- Dead `isWishlisted` action and its tests removed (pages query Prisma
  directly).

### Verification (fix round 1)
- `npx vitest run`: 771 passed, 3 DB-gated skipped.
- `npx tsc --noEmit`: clean.
- `npm run lint`: clean.
- `npm run format:check`: clean.
- `DATABASE_URL=postgresql://vendary:vendary@localhost:5432/vendary npm run e2e -- --grep-invert @payment`:
  31 passed (includes the new floor-blocking coupon test).
- `npm run build`: exit 0.

### Files changed
- `actions/orders/index.ts`, `actions/cart/quote.ts`, `actions/auth/index.ts`,
  `actions/wishlist/index.ts`, `actions/(admin)/coupons` consumers.
- `lib/coupons.ts`, `lib/rate-limit.ts`, `schemas/cart/quote-schema.ts`,
  `schemas/checkout/coupon-code-schema.ts` (new).
- `modules/admin/components/coupon-row.tsx` (new),
  `modules/admin/components/coupon-deactivate-button.tsx` (deleted),
  `app/(admin)/admin/coupons/page.tsx`,
  `modules/auth/components/google-sign-in-button.tsx`,
  `modules/auth/forms/login/form.tsx`.
- `tests/coupons.test.ts`, `tests/cleanup.test.ts`, `tests/wishlist.test.ts`,
  `tests/routes.test.ts` (new), `e2e/coupons.spec.ts`.


# Vendary ₹-first Order Lifecycle + Locale Selector — Design Spec

Date: 2026-10-11. Status: user-approved. Context: artisan marketplace (Art, Toys,
Pottery, Weaves, Jewelry), Indian customers, Razorpay test mode, prices stored as
plain numbers now defined as **rupees**.

## Locked decisions

- Stored price numbers are INR (₹6, not $6.00). Admin enters INR.
- Razorpay stays in test mode. Charging currency is always INR paise.
- My Orders route: `/my-orders` (login-gated by existing middleware default-deny).
- Admin orders: list + status control (pending → confirmed → shipped → delivered / cancelled).
- Locale selector lives in the footer bottom row, persisted in localStorage.
- USD→INR converter widget on checkout stays untouched.
- `PlaceOrder` product matching: by id (robust), not by name.

## Units

### 1. INR display (default everywhere)
New `formatINR()` helper (`Intl` `en-IN`, INR, 2dp). Applied in: product card
(replaces `$ {price}`), items summary (replaces per-line USD `formatCurrency`),
admin price column (`$ <PriceEdit>`), My Orders + admin totals. No stored-data
migration: numbers already mean rupees by definition.

### 2. Phone IN-first
`PhoneInput defaultCountry` US → IN (`_checkout-form.tsx:206`). Schema `mobile`
tightens from `min(1)` to Indian 10-digit: strip non-digits, allow leading `91`,
require `/^[6-9]\d{9}$/`.

### 3. Post-order flow
Checkout `onSuccess`: call existing-but-unused `clearCart()` then
`router.push('/my-orders')`. Fixes the stuck cart badge. Toasts unchanged.

### 4. My Orders page (`/my-orders`)
Server component: `auth()` (redirect `/` if anonymous, mirroring admin page),
`prisma.order.findMany({ where: { userId }, include: { items, address } })`
newest-first. Each order: items + quantities, ₹ total via `formatINR()`, address
snippet, status badge. Users see only their own rows (query-scoped).

### 5. Profile dropdown
`UserButton` menu gains "My Orders" `DropdownItem` (href `/my-orders`) above
"Log out". Existing `DropdownItem` patterns reused.

### 6. Admin orders + role gate
`/admin` gains an orders section: all orders desc (customer email, items,
₹ total, payment id, status) + status changer calling new ADMIN-guarded
`updateOrderStatus(orderId, status)` server action (status allow-list validated
server-side). Same change adds the missing role gate: non-ADMIN sessions
redirect `/` (today any login views `/admin`).

### 7. Order-creation robustness (`actions/orders/index.ts`)
- Product lookup by id: `line_items` carry the DB product id (checkout session
  builder updated); `findFirst by name` removed.
- Delete the stale hardcoded fallback `userId "cm9gtcj6l00000r2k1pi0inen`;
  throw `Unauthorized` when no session (matches `createProduct` convention).
- Razorpay order `currency: "USD"` → `"INR"` (amounts already smallest-unit).

### 8. Footer locale selector
New `LocaleContext` (`vendary-locale` in localStorage, default India):
country, currency, phone prefix. Footer bottom row: flag + name + currency
dropdown with curated list (India, US, UK, UAE, Singapore). Drives `formatPrice`
(display only; INR native via `formatINR`, others via cached live rate from the
existing exchangerate-api pattern with a static fallback table) and the phone
input default country. Charging stays INR paise regardless of display locale.

## Data flow (order)
Cart (localStorage) → checkout session (ids + paise) → Razorpay test checkout →
`PlaceOrder` (verify signature → address → order → items) → `clearCart()` →
`/my-orders`. Admin: `/admin` orders section → `updateOrderStatus` → revalidate.

## Error handling
Friendly toasts preserved (`place-order` id pattern). `updateOrderStatus`
rejects non-allow-list statuses and non-ADMIN callers with `Unauthorized`.
Empty states: no orders → "No orders yet" (both pages). Cache failures already
fall through to DB (prior batch).

## Verification
`tsc --noEmit`, `npm run lint`, `npm run build` gate. Local walkthrough:
locale switch re-renders prices + phone default; test-mode Razorpay order →
cart badge 0 → lands `/my-orders`; user sees own orders only; admin status
change persists; `/admin` blocked for USER role; dropdown link navigates.

## Out of scope
Resend custom domain (separate decision, needs user DNS). Marketing emails.
Multi-currency settlement (display-only conversion; INR charging only).

# Phase 2 — implementation report

**Status:** complete for Tasks 2.1–2.6.

**Branch:** `worktree-phase-1-4` (worktree `/Users/mahesh/Developer/Vendary/.qoder/worktrees/phase-1-4`)

## Commits

| SHA | Subject |
| --- | --- |
| `a0404c4` | `feat(auth): add enumeration-safe password reset flow` |
| `5715dcf` | `feat(account): add saved address book and checkout prefill` |
| `8f3396a` | `feat(account): add profile and password settings` |
| `c7616a2` | `feat(reviews): show verified purchases and manage own review` |
| `b1d0bcc` | `feat(orders): add printable GST invoice` |
| `95f4404` | `test(e2e): cover account settings, password reset and invoices` |

## Migrations

- `prisma/migrations/20261201000000_saved_addresses/migration.sql` — new
  `SavedAddress` table (`userId` FK cascade, address fields, `isDefault`,
  timestamps) and `SavedAddress_userId_idx`.
- Applied to the local database with
  `DATABASE_URL=postgresql://vendary:vendary@localhost:5432/vendary npx prisma migrate deploy`
  and `npx prisma generate` ran afterwards.
- No existing table was altered; `Order`/`Address` snapshots are untouched and
  no `Order → SavedAddress` relation exists.

---

## Task 2.1 — password reset

### Fixes and additions
- `actions/token/index.ts`: `getPasswordResetTokenByEmail(email)` now queries
  by email with `findFirst` (email alone is not unique); new
  `getPasswordResetTokenByToken(token)` queries by token.
- `lib/token.ts`: `generatePasswordResetToken` clears **all** tokens for the
  email with `deleteMany` before creating the single live token, so older links
  in an inbox stop working.
- `schemas/auth/password-reset-schema.ts`: normalized email (trim/lowercase,
  ≤254), token ≤128, password 8–72 (bcrypt's limit).
- `actions/auth/password-reset.ts`:
  - `requestPasswordReset(email)` parses input first, then counts the IP
    budget (10/hour, `clientKey`) and the per-address budget (3/hour) **before**
    the user lookup, so unknown addresses consume the same budget. It looks up
    `{id,email,password}`; unknown and passwordless (OAuth-only) accounts get
    the same `PASSWORD_RESET_REQUEST_MESSAGE` with no token and no send.
  - `resetPassword(token, password)` validates schema, token and
    `expires > now`, hashes with bcrypt (cost 10), and inside one transaction
    deletes the token as a claim (`deleteMany` count 0 → invalid), updates the
    password, and clears any remaining tokens for the address. Returns
    `{ reset: true }`; expected failures are `VALIDATION` AppErrors.
- `lib/mail.ts`: `sendPasswordResetEmail` now uses `Email-FROM`/dev sender
  semantics, links to `${NEXT_PUBLIC_SITE_URL}/password/reset?token=…`, escapes
  HTML via `escapeHtml`, never throws, and returns
  `sent | skipped(not_configured|rejected)`. Logs contain event/reason/error
  class only (no address, token or provider message).
- `lib/rate-limit.ts`: added `passwordResetEmail` (3/hour) and
  `passwordResetIp` (10/hour).
- Pages: `app/(auth)/forgot-password/page.tsx`,
  `app/(auth)/password/reset/page.tsx` (server page reads `searchParams`, client
  forms under `modules/auth/forms/password-reset/`). `/forgot-password` added
  to `publicRoutes`; login has a “Forgot password?” link. Success copy states
  that other devices stay signed in until their session expires.

### Tests
- `tests/password-reset.test.ts` (15): token lookup by email vs token,
  enumeration-safe message for unknown/passwordless, known-account send,
  unconfigured-mail response, IP-before-email limits and their exact options,
  fourth email request → `RATE_LIMITED`, eleventh IP request → `RATE_LIMITED`,
  expired token, missing/reused token, bcrypt hash + one-time consumption,
  concurrent claim (count 0), schema bounds, deleted account.
- `e2e/password-reset.spec.ts`: dedicated Prisma user/token, resets through
  the page, replay is rejected, new password signs in, unknown-address forgot
  page shows the generic message, cleanup in `afterAll`.

## Task 2.2 — saved addresses + checkout selector

- `SavedAddress` model per plan (label?, first/last name, phone, line1/2,
  area, landmark?, state, postal code, country, isDefault, timestamps).
- `schemas/account/address-schema.ts`: phone normalization/6-digit PIN mirror
  `placeOrderSchema`, finite bounds on every field, `MAX_SAVED_ADDRESSES = 10`,
  update schema with a bounded id.
- `actions/account/addresses.ts` (`runAction` + Zod + `requireUser`):
  `listAddresses`, `createAddress`, `updateAddress`, `setDefaultAddress`,
  `deleteAddress`. Every read/write filters on `session.user.id`; delete uses
  `deleteMany({id,userId})`; the first address becomes default; creating or
  promoting a default clears the previous one inside the transaction; the cap
  is checked in the same transaction as the insert.
- UI: `app/(my-orders)/account/addresses/page.tsx`,
  `modules/account/components/address-form.tsx` (create/edit form plus cards
  with Set default/Edit/Delete and confirmation copy that past orders keep
  their address), account layout with storefront chrome.
- Checkout: `modules/checkout/components/saved-address-selector.tsx` loads the
  book, pre-fills the default once, and `applySavedAddress` maps row fields onto
  the existing `PlaceOrderSchema` form. The order path still snapshots a new
  `Address`; there is no link from `Order` to `SavedAddress`.
- `LocationSelector` gained display-only initial country/state props so the
  prefill is visible, not just present in form state.

### Tests
- `tests/address-schema.test.ts` (17): bounds, phone/PIN rules, optional blanks,
  update id, cap constant.
- `tests/address-actions.test.ts` (11): auth ordering, user-scoped list/update/
  delete, foreign/missing → `NOT_FOUND`, invalid ids, first-default,
  explicit-default clearing, non-default no clearing, cap conflict, promotion.
- `tests/integration/address-book.test.ts` (3, skipped without
  `TEST_DATABASE_URL`): runs `prisma migrate deploy` against the test URL,
  user-scoped reads/writes, exactly one default after a transactional switch,
  and proof that deleting a saved address leaves the order’s `Address` snapshot
  intact. Ran locally with the local DB URL: 3 passed.
- `e2e/account.spec.ts`: dedicated user adds two addresses and moves the default
  (DB asserts one default = “Office”), then cleanup.

## Task 2.3 — profile & password change

- `schemas/account/profile-schema.ts`: names 1–60, avatar optional URL ≤500
  refined through `isAllowedImageUrl` (empty clears), password change with
  current/new 1–72 / 8–72.
- `actions/account/profile.ts`:
  - `updateProfile` writes first/last name, the combined `name` (used by review
    lists), and both avatar columns; revalidates `/account`; audit line contains
    `userId` + changed field names only.
  - `changePassword` rejects passwordless accounts, compares the current
    password with bcrypt, rejects a new password equal to the stored hash,
    hashes and updates in a transaction that also clears reset tokens;
    revalidates; audit line has `userId` only.
  - JWT sessions on other devices are not revocable; documented in the account
    UI and code comments.
- `app/(my-orders)/account/page.tsx` + `modules/account/components/profile-forms.tsx`
  (profile and password forms, server field errors mapped back, session note).
- Header now shows the signed-in name (`data-testid="header-user-name"`) and
  links Account settings/Saved addresses in the user dropdown.

### Tests
- `tests/profile-schema.test.ts` (17): name bounds, allowlisted/unknown avatars,
  empty avatar, password bounds, wrong current password, same-password
  rejection, new hash stored + reset tokens cleared, passwordless account,
  profile write shape, audit line has no PII.
- `e2e/account.spec.ts`: updates first/last name, sees “Renamed Shopper” in the
  header, and verifies the stored DB name.

## Task 2.4 — verified reviews + own-review management

- `addReview` keeps computing `verifiedPurchase` from eligible order statuses.
- `schemas/products/reviews/review-schema.ts`: `UpdateReviewSchema` (id, rating,
  trimmed 10–2000 body) and `ReviewIdSchema`.
- `actions/products/reviews/manage-review/index.ts`: `updateReview` (ownership
  in the `findFirst`, update, revalidate product page) and `deleteReview`
  (ownership `findFirst`, `deleteMany({id,userId})`, typed result). Both
  `runAction`.
- `lib/reviews/summary.ts`: `getRatingSummary` uses `prisma.review.aggregate`
  (`_avg.rating`, `_count._all`) plus `groupBy(rating)` for the distribution.
- Product page loads the newest ten reviews **and** the session user's own
  review (even if older), and passes the aggregate summary.
- `reviews.tsx` renders the aggregate count/average/distribution, a “Verified
  purchase” badge, and edit/delete controls only for `review.userId ===
  session.user.id`; the add form is replaced by a “you reviewed this” note when
  the user already has a review. `review-actions.tsx` edits/deletes through the
  typed actions and refreshes.

### Tests
- `tests/review-management.test.ts` (11): verified true/false, P2002 →
  `CONFLICT`, own update/delete, foreign/missing → `NOT_FOUND`, unauthenticated
  and invalid bodies, aggregate/groupBy query shape and zero-review summary.

## Task 2.5 — printable GST invoice

- `lib/orders/invoice.ts`: paise helpers, subtotal from item snapshots,
  stored tax/total, `balanced` drift flag, `INV-{YYYY}-{orderId.slice(0,8)}`.
- `app/(my-orders)/my-orders/[id]/invoice/page.tsx`: auth redirect, owner-scoped
  `findFirst` (foreign = missing = 404), serializes the order, reads optional
  `SELLER_GSTIN`.
- `modules/orders/components/invoice.tsx`: bill-to snapshot, line items,
  subtotal/GST/total in INR, payment, computer-generated note, and a
  “Print / Save as PDF” button (`window.print()`).
- `invoice/print.css`: A4 `@page`, white background, hides actions/app chrome
  while keeping the invoice’s own header.
- Order detail now has an “Invoice” link.
- `lib/env.ts` and `.env.example` gained optional `SELLER_GSTIN`; the GSTIN row
  is omitted when unset.

### Tests
- `tests/invoice-totals.test.ts` (7): snapshot subtotal, stored tax/total,
  Decimal-like inputs, drift flag, paise rounding, invoice number/year.
- `e2e/invoice.spec.ts`: deterministic confirmed order fixture, opens the
  invoice from order detail, checks `INV-…`, item names, ₹1,433.98/₹114.72/
  ₹1,548.70, print button, and foreign/missing 404.

## Task 2.6 — account tests

- Unit: password reset, address schema/actions, profile schema/actions, review
  management/aggregate, invoice totals.
- Integration: `tests/integration/address-book.test.ts` (skips without
  `TEST_DATABASE_URL`).
- E2E: `e2e/account.spec.ts`, `e2e/password-reset.spec.ts`,
  `e2e/invoice.spec.ts`; `e2e/helpers.ts` gained `loginWith(credentials)` and
  `login()` now delegates to it. All fixtures use separate users/rows, local/CI
  DB guards, and `afterAll` cleanup.

---

## Verification

| Command | Result |
| --- | --- |
| `npx vitest run` | **648 passed**, 3 integration tests skipped (no `TEST_DATABASE_URL`), 29 files passed |
| `TEST_DATABASE_URL=postgresql://vendary:vendary@localhost:5432/vendary npx vitest run tests/integration/address-book.test.ts` | **3 passed** |
| `npx tsc --noEmit` | pass |
| `npm run lint` | pass (no warnings) |
| `DATABASE_URL=postgresql://vendary:vendary@localhost:5432/vendary npm run e2e -- --grep-invert @payment` | **24 passed** |
| Placeholder build (`DATABASE_URL=postgresql://ci:ci@localhost:5432/ci AUTH_SECRET=ci-placeholder-secret npm run build`) | pass; build-time DB auth errors on the placeholder URL are the existing graceful-degradation path |
| `npx prisma migrate deploy` + `npx prisma generate` | applied `20261201000000_saved_addresses`, client regenerated |

## Self-review against acceptance criteria

- [x] Reset works once, expires, generic message for unknown addresses, old
      links invalidated, 3/hour/email + 10/hour/IP.
- [x] Saved addresses user-scoped, default uniqueness transaction, cap 10,
      checkout prefill; integration test proves order snapshots survive delete.
- [x] Profile/password validated (Zod + bcrypt), allowlisted avatar, reject same
      password, revalidated, audit lines without PII; other-device session
      caveat documented.
- [x] Reviews show verified purchase, one per user/product (P2002 → CONFLICT),
      own edit/delete enforced, aggregate average/count over all rows.
- [x] Invoice owner-only 404, deterministic number, snapshot line items,
      stored totals, optional GSTIN, print CSS and Print/Save as PDF.
- [x] No new runtime dependencies; all new actions use `runAction` + Zod with
      `AppError` for expected failures; admin/confirm/refund/stock/webhook and
      status-map code untouched; seeded demo credentials unchanged.

## Concerns / deviations

- **Reset timing:** the response is identical for known/unknown addresses, but
  an existing account performs token generation + a mail attempt, so timing is
  not equalized. This matches the brief (response enumeration only).
- **Rate-limit visibility:** after the budgets are exhausted the action returns
  `RATE_LIMITED` (consistent with the rest of the app). This reveals request
  frequency for the supplied address/IP, not whether an account exists.
- **Unconfigured mail still creates a token** for an existing account (the link
  is just undeliverable). The requester still gets the same message.
- **Address cap race:** the 10-address limit is checked in the create
  transaction but has no DB constraint, so two simultaneous creates at the
  boundary could momentarily exceed it.
- **Ownership read/update race:** update/set-default read ownership then update
  by id; a concurrent delete in between surfaces as `INTERNAL` rather than
  `NOT_FOUND`. Delete itself is a single scoped `deleteMany`.
- **JWT sessions** (including after a password reset or change) remain valid
  until expiry; this is documented in the UI and report rather than adding
  token versioning, per the brief.
- **UI additions beyond the literal task list:** signed-in name in the header
  (needed for the profile e2e), `LocationSelector` display-only prefill props,
  and an “Invoice” link on order detail.
- `getPasswordResetTokenByEmail` is fixed and covered, but generation now uses
  `deleteMany` (all tokens) rather than the helper; the helper is kept as the
  single-token lookup API.

---

## Fix round 1

Two Important review findings plus selected cheap minors.

### Changes

1. **Cleared address fields now persist.** `updateAddress` maps blank
   `label`/`line2`/`landmark` (normalized to `undefined` by the schema) to
   explicit `null`, so editing an address can actually clear them. Covered by
   a unit test asserting the update payload and an e2e test that clears all
   three fields through the edit form and verifies both the card and the DB row.
2. **Invoices are paid-only.** `lib/orders/status.ts` exports
   `INVOICE_ELIGIBLE_STATUSES` (`confirmed`, `shipped`, `delivered`) and
   `isInvoiceEligible`. The order detail only renders the Invoice link for
   those statuses, and the invoice page returns `notFound()` for any other
   status (pending/cancelled/refunded) even via a direct URL. The owner-only
   query is unchanged. Covered by a unit test over all statuses and an e2e test
   that a pending order shows no link and its invoice URL 404s; the existing
   confirmed-order invoice test still renders.
3. **One default address enforced in the database.** New migration
   `20261201001000_saved_address_default_unique` adds the partial unique index
   `CREATE UNIQUE INDEX "SavedAddress_userId_default_key" ON "SavedAddress"("userId") WHERE "isDefault";`.
   `createAddress`, `updateAddress` (when setting default) and
   `setDefaultAddress` catch Prisma `P2002` and return `CONFLICT` ("You already
   have a default address; refresh and try again."). The max-10 behavior is
   unchanged; the schema carries a note because Prisma cannot express partial
   indexes.
4. **Reset-token rotation is transactional.** `generatePasswordResetToken`
   wraps the `deleteMany` (by email) + `create` in one `prisma.$transaction`,
   so a failed insert cannot leave the account with zero valid links. New
   `tests/token-rotation.test.ts` pins the single transaction and call order.
5. **OAuth header name.** The `jwt` callback uses the DB `name` and otherwise
   joins only non-empty `firstName`/`lastName` parts, so a user without either
   no longer shows "null null".
6. **Invoice year is IST.** `invoiceYear` formats with
   `Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", year: "numeric" })`;
   a UTC New Year's Eve order that is already the next day in India gets the
   new year. Unit cases cover both sides of the IST boundary.
7. **Checkout keeps address line 2.** The saved-address prefill joins
   `line1` and `line2` into the single checkout `address` field. The address
   schema comment no longer claims a saved address always passes checkout
   validation unchanged (checkout still requires a landmark, left to the user).

### Commands / results

| Command | Result |
| --- | --- |
| `DATABASE_URL=postgresql://vendary:vendary@localhost:5432/vendary npx prisma migrate deploy` | applied `20261201001000_saved_address_default_unique` (11 migrations) |
| `bunx prisma generate` | Prisma Client v6.6.0 generated |
| `npx vitest run` | 30 passed, 1 skipped (DB-gated integration); 656 tests passed |
| `npx tsc --noEmit` | pass |
| `npm run lint` | no warnings or errors |
| `DATABASE_URL=… npm run e2e -- --grep-invert @payment` | 26 passed (includes the new address-clear and pending-invoice tests) |
| Placeholder build (`DATABASE_URL=postgresql://ci:ci@localhost:5432/ci AUTH_SECRET=ci-placeholder-secret npm run build`) | pass |

### Files changed

- `actions/account/addresses.ts` — null mapping; P2002 → CONFLICT on all
  default-writing paths.
- `lib/orders/status.ts`, `app/(my-orders)/my-orders/[id]/page.tsx`,
  `app/(my-orders)/my-orders/[id]/invoice/page.tsx` — invoice gating.
- `prisma/migrations/20261201001000_saved_address_default_unique/migration.sql`,
  `prisma/schema.prisma` — partial unique index + note.
- `lib/token.ts` — transactional reset-token rotation.
- `auth.ts` — OAuth display-name derivation.
- `lib/orders/invoice.ts` — IST invoice year.
- `modules/checkout/components/_checkout-form.tsx` — prefill joins line 1/2.
- `schemas/account/address-schema.ts` — accurate checkout-validation comment.
- `tests/address-actions.test.ts`, `tests/order-status.test.ts`,
  `tests/invoice-totals.test.ts`, `tests/token-rotation.test.ts` — unit
  coverage for the fixes.
- `e2e/account.spec.ts`, `e2e/invoice.spec.ts` — address-clear and
  pending-invoice 404 coverage; invoice year expectation now IST.


# Vendary UX/UI Hardening Plan (U1–U6)

Executed directly on the `main` branch, one conventional commit per task group,
`main` green after every phase.

Global validation baseline (end of every phase):

```
npx tsc --noEmit && npm test && npm run format:check && npm run lint
DATABASE_URL=postgresql://vendary:vendary@localhost:5432/vendary npm run e2e -- --grep-invert @payment
DATABASE_URL=postgresql://vendary:vendary@localhost:5432/vendary npm run e2e -- --grep @payment
```

Husky + lint-staged (prettier) run on every commit — keep files prettier-clean.

---

## Verified current behavior (per issue)

1. **Validation** — Not missing, but duplicated and under-constrained.
   - `schemas/checkout/place-order-schema.ts`: phone transform + `/^[6-9]\d{9}$/`; PIN `/^\d{6}$/`; landmark required.
   - `schemas/account/address-schema.ts`: same phone transform + PIN regex **copied**, drift risk.
   - Checkout form uses `PhoneInput` (E.164) with visible errors; PIN input has no `inputMode`/`maxLength`. Address form uses plain `Input`, `inputMode` set but no `maxLength`. No emoji/control-char rule anywhere.
2. **No back option** — only order detail and addresses pages have one. Missing on: `my-orders`, `account`, `wishlist`, invoice, `admin/analytics`, `admin/create-product/*`.
3. **Admin hub** — `app/(admin)/admin/page.tsx` renders both tables on one page; header links only Analytics/Coupons; 15 call sites `revalidatePath("/admin")`; `lib/admin/search.ts` `adminHref` hardcodes `/admin`.
4. **Navbar name** — `user-button/index.tsx` shows `session.user.name`; role is available on the session.
5. **Heart above dialogs** — `components/ui/dialog.tsx` backdrop/panel have **no z-index**; `product-card.tsx` heart is `absolute z-10` in the root stacking context, so it paints above the auto-z dialog. Same hazard: mobile sticky bar `z-40`, lightbox `z-50`, mobile menu `z-50`.
6. **Redis noise** — ioredis with `enableOfflineQueue:false`; every command while not `ready` rejects with "Stream isn't writeable…"; the `error` event logs per event and callers log per request. Throttle mirror exists in `lib/rate-limit.ts`. Health check pings with 1s timeout → `degraded` — must keep working.
7. **Admin entry** — no `/admin` item in the avatar dropdown.
8. **Wishlist nav icon** — none; navbar has search + cart only.
9. **Checkout address UX** — `SavedAddressSelector` exists as a bare `<select>` with default prefill; `createRazorpayOrder` creates the order `Address` but never a `SavedAddress`; `createAddress` has the max-10/default rules to reuse.
10. **Order numbers** — cuid exposed in `/my-orders`, order detail, admin tables, invoice `INV-`, email subjects. `Order` has no `orderNumber`. Tests pinned to cuid format in invoice/email specs.
11/12. Covered by U2 and U3+U6.

---

## Phase U1 — P0 UX fixes (z-index, Redis noise, navbar)

**Objective:** dialogs always paint above page content; dev terminal quiet during Redis outages; navbar shows avatar-only with wishlist icon and admin-only Admin dashboard link.

### U1.1 — Dialog stacking fix
- Files: `components/ui/dialog.tsx`; `modules/shopping/components/shopping-nav/search-input/index.tsx`; `e2e/wishlist.spec.ts`.
- Add `z-50` to `DialogBackdrop` and the fixed wrapper div; remove the redundant `className="z-40"` from the search dialog panel. No `pointer-events` changes.
- Done when: as a guest on `/products`, clicking a heart opens the login modal and the heart is underneath (`elementFromPoint` returns a dialog node).

### U1.2 — Redis fail-fast + throttled logging
- Files: `lib/redis.ts`, `lib/product-cache.ts`, `actions/products/product/get-basic-details.ts`, `actions/products/hot-products/index.ts`; tests `tests/status-route.test.ts`, new `tests/redis-guard.test.ts`.
- Export `RedisUnavailableError` + `isRedisUnavailable`; guard every op with `client.status === "ready"` (reject fast with a fixed reason); throttle outage logs to one per 60s; the `error` event handler uses the throttle. Callers swallow `isRedisUnavailable` silently and keep `console.error`/`logger` for anything else. Fail-open DB fallback unchanged; `/api/status` still reports `degraded` via ping.
- Done when: with Redis down, at most one warn/minute; pages render from DB; status still degraded.

### U1.3 — Navbar: avatar-only, wishlist icon, admin link
- Files: `user-button/index.tsx`, `shopping-nav/index.tsx`, `shopping-layout.tsx`; `e2e/account.spec.ts`, `e2e/wishlist.spec.ts`.
- Remove the name span; add `aria-label` "Account menu"; admin-only "Admin dashboard" first menu item. Navbar gains a wishlist `Link` (Heart icon + count badge) between search and cart; `ShoppingLayout` counts wishlist items for the session user.
- Done when: header shows avatar only; wishlist heart with count for signed-in users; admin sees "Admin dashboard", a `USER` does not.

Commit sequence: `fix(ui): render dialogs above page content with a z-50 overlay layer` → `perf(redis): fail fast when not ready and throttle outage logs` → `feat(nav): avatar-only user button, wishlist icon link and admin-only dashboard entry`.

---

## Phase U2 — Validation unification (shared Indian phone/PIN/name rules)

**Objective:** one source of truth for Indian phone, PIN, person names and address lines; both forms enforce client-side constraints and show messages.

### U2.1 — Shared schema module
- Files: create `schemas/shared/indian-contact.ts`; modify `schemas/checkout/place-order-schema.ts`, `schemas/account/address-schema.ts`; tests `tests/indian-contact-schema.test.ts` (new), `tests/checkout-schema.test.ts`, `tests/address-schema.test.ts`.
- Rules:
  - `INDIAN_PHONE_REGEX = /^[6-9]\d{9}$/`, `INDIAN_PIN_REGEX = /^\d{6}$/`.
  - Forbidden chars: control chars, zero-width, `\u2028/\u2029`, `\p{Extended_Pictographic}`.
  - `indianPhoneSchema` (strip non-digits, drop leading 91, validate 10 digits), `indianPinCodeSchema`, `personNameSchema(label, {optional})` (1–60), `addressLineSchema(label, min, max)`.
- `placeOrderSchema` and `SavedAddressInputSchema` consume the shared pieces (top-level field names unchanged so field-error mapping keeps working).
- Done when: a `SavedAddress` value parses through both schemas; `"+91 98765 43210"` passes, `"09876543210"` rejects, emoji name rejects.

### U2.2 — Client-side input constraints
- Files: `modules/account/components/address-form.tsx`, `modules/checkout/components/_checkout-form.tsx`.
- PIN: `inputMode="numeric" autoComplete="postal-code" maxLength={6}`; names `maxLength={60}` + autocomplete; address phone `maxLength={15} autoComplete="tel"`; lines `maxLength={200}`; `aria-invalid` on address-form inputs.
- Done when: PIN blocks a 7th digit; invalid submits show inline messages in both forms.

Commit sequence: `refactor(schemas): unify Indian phone, PIN and name validation in one shared module` → `feat(forms): add input constraints and accessible error states to address forms`.

---

## Phase U3 — Back navigation + admin hub

### U3.1 — Reusable BackButton
- Create `components/global/back-button.tsx` (client): `← label` button; `router.back()` when `history.length > 1`, else `router.push(fallback)`.
- Apply: my-orders list (fallback `/`), order detail (replace the existing link, fallback `/my-orders`), invoice (fallback `/my-orders/{id}`, `print:hidden`), account (fallback `/`), addresses (fallback `/account`), wishlist (fallback `/account`).
- E2E: smoke gains a back-navigation case.

### U3.2 — Admin hub + table sub-pages
- Rewrite `app/(admin)/admin/page.tsx` as a 4-card hub (Products, Orders, Analytics, Coupons) with live previews:
  - Products: total + 3 most recent names.
  - Orders: total + 3 recent (number/status/total).
  - Analytics: orders last 30d + revenue sum (`confirmed|shipped|delivered`).
  - Coupons: active count + latest code.
  All queries in `Promise.all`.
- Move the products table + search + pagination to `/admin/products`; orders table to `/admin/orders`; both start with `BackButton fallback="/admin"`. `adminHref(page, q, base)` gains a base param; header adds Products/Orders links.
- Do not touch the `revalidatePath("/admin")` call sites (hub counts revalidate; sub-pages are dynamic).
- E2E `e2e/admin.spec.ts` updated in the same commit (cards on hub, tables on sub-pages).

Commit sequence: `feat(nav): reusable back button with href fallback across account and order pages` → `feat(admin): hub dashboard with preview cards; split tables into /admin/products and /admin/orders` → `test(e2e): update admin specs for the hub layout`.

---

## Phase U4 — Human-friendly order numbers (`VND-XXXX`)

### U4.1 — Schema + generator + migration/backfill
- `Order.orderNumber String @unique`; `lib/orders/order-number.ts`:
  - Alphabet `23456789ABCDEFGHJKMNPQRSTUVWXYZ` (31 chars, no I/L/O/0/1); 4-char suffix; `VND-XXXX`.
- `createRazorpayOrder`: generate before the transaction, pass into `tx.order.create`; on `P2002` targeting `orderNumber`, retry the whole transaction up to 5 times (address creation is inside the tx, so rollback leaves no orphan).
- Migration (single atomic file): add nullable column → backfill each row with retry-on-unique-violation loop → `SET NOT NULL` → unique index. Pre-checks: row count sanity, backup, staging dry-run.
- Tests: `tests/order-number.test.ts` (alphabet/format/regex; retry path).

### U4.2 — Display sweep
- Render `orderNumber` in `/my-orders`, order detail, admin orders, invoice (`INV-{year}-{orderNumber}`), email subjects/templates; `sendOrderEmail` select includes it; admin orders search matches `orderNumber` contains.
- Do not change `my-orders/[id]` routing (cuid URLs stay).
- Grep gate: `grep -rn "slice(0, 8)" app modules lib` → only `maskPaymentId`.
- Tests updated: invoice totals/emails, e2e invoice/order-detail/admin.

Commit sequence: `feat(orders): add unique human-friendly orderNumber with backfill migration` → `feat(orders): display VND order numbers across orders UI, invoices and emails` → `test: update invoice/email/admin assertions for order numbers`.

---

## Phase U5 — Checkout address experience

### U5.1 — Auto-save first order address
- Inside the init transaction, after the order `Address` snapshot: if `savedAddress.count({userId}) === 0`, create a `SavedAddress` from the submitted values (`isDefault: true`). Order snapshot invariant unchanged; failure rolls back with the transaction.
- E2E: paid flow asserts one default saved address appears for a user with none.

### U5.2 — Saved-address chooser cards
- Replace the `<select>` with a vertical card list: label/name, one-line address, phone; **Use** (selects), **Edit** (inline `AddressForm`), **+ Add new address** (inline blank form). Keep the one-time default prefill and the "changes this order only" footnote; empty state renders nothing.
- Only the chooser UI changes; `applySavedAddress` mapping and the `PlaceOrderSchema` payload are untouched.
- E2E: account/checkout chooser case; paid flow stays green.

Commit sequence: `feat(checkout): auto-save the first order's address as a saved address` → `feat(checkout): saved-address chooser cards with inline use/edit/add-new` → `test(e2e): cover the checkout address chooser`.

---

## Phase U6 — Polish + docs sweep

- Admin tables: denser rows, quick actions, explicit empty states with CTAs.
- Docs: `docs/ux-hardening.md` summarizing the shared validation, order number format, admin hub; README touch-up if needed.
- Full sweep: tsc/vitest/lint/format + full Playwright suite; grep gates for cuid slices and removed testids.

Commit sequence: `chore(admin): denser tables, quick actions and empty states` → `docs: record UX hardening changes (shared validation, order numbers, admin hub)`.

---

## Migration needs

- **Only one schema change in the round:** `Order.orderNumber @unique` (U4) + backfill SQL. Pre-check `SELECT count(*) FROM "Order";`, back up, staging dry-run.
- No `SavedAddress` change for U5. No migrations for U1/U2/U3/U5/U6.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Admin split breaks e2e expectations | Tables move verbatim; tests updated in the same commit |
| `orderNumber` unique vs live traffic | Generation + retry inside the init tx; atomic backfill migration; staging dry-run |
| Checkout regression (paid path) | U5 touches only the chooser UI + one insert; payment spec green after every phase |
| Redis guard changes limiter behavior | Guard only fast-fails; limiter already falls back to memory; `/api/status` contract unchanged |
| Shared schema message drift | Forms render first message; field names unchanged |
| CSP/headers | CSS-only changes; no new origins |

## Acceptance

- Per-phase "Done when" bullets above.
- Global: tsc, vitest, lint, `format:check`, Playwright smoke + payment green after every phase; Phase 0-4 invariants intact.

## Open decisions (resolved)

1. Invoice number keeps `INV-{year}-{orderNumber}`.
2. Wishlist count is a live indexed count per render.
3. Address book keeps a plain phone input (schema enforces the same rules); the E.164 widget stays checkout-only.

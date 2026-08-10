# Auth Polish + Google OAuth — Phase 1 Design

Date: 2026-08-10
Status: Approved (user decisions recorded)
Scope: Phase 1 only — auth system fixes, UI consistency, Google OAuth wiring, small security hardening.
Out of scope: image pipeline (any-URL rendering), admin guard/CRUD, checkout fixes, rate limiting.

## Context

Audits (three parallel deep-dives + source verification) found the auth system functional but with
several user-visible bugs and security warts. The user's words: "login and signup a lil bit mess".

Verified findings driving this phase:

| # | Finding | Location |
|---|---|---|
| 1 | Login failures are invisible: `useMutation` has no `onError`; wrong password / unknown email / 500 all show nothing | `modules/auth/forms/login/form.tsx:25-34` |
| 2 | OAuth completely dead: providers imported, zero env creds, buttons have no `onClick`; `signInProvider` action exists but unused | `auth.config.ts:13-16`, `login/form.tsx:81-89`, `actions/auth/index.ts:24-61` |
| 3 | `session.user.image` never populated (jwt callback never sets picture) → default avatar forever | `auth.ts:31-41` |
| 4 | Non-admin admin-route redirect lands on raw session-JSON debug page (`/home`) | `app/(admin)/layout.tsx:15`, `app/(protected)/home/page.tsx:9` |
| 5 | `'returns'` public route missing leading slash → guests redirected | `routes.ts:43` |
| 6 | Auth error page heading is white-on-white | `app/(auth)/error/page.tsx:25` |
| 7 | Copy-paste `mutationKey: ['register']` in login form | `login/form.tsx:29` |
| 8 | Unverified-login path: email send is fire-and-forget, user gets silent reset, no "check inbox" message | `actions/auth/index.ts:89-95` |
| 9 | Dead authRoutes entries `/onboarding`, `/password/reset/form` → both 404, redirect behavior pointless | `routes.ts:25-26` |
| 10 | Dead `shadow-input` class used but undefined anywhere in CSS | `login/form.tsx:40`, `register/form.tsx:50` |
| 11 | Register message typo `'Confirmation Email Sent!.'` | `actions/auth/index.ts:173` |
| 12 | Account enumeration: distinct messages "User not found." / "Password is not set..." / "Incorrect Username or Password!"; timing oracle (missing user short-circuits before bcrypt) | `actions/auth/index.ts:81-87`, `auth.config.ts:29-39` |
| 13 | Emails not normalized → case-split duplicate accounts, failed logins | `schemas/auth/login-schema.ts:4`, `actions/user/index.ts:16-20` |
| 14 | Nav modal login/signup never closes on success; cross-links inside modals jump to full pages | `sign-in-component.tsx:37-39` |

## Decisions (user-approved)

1. **Email verification stays enforced.** Unverified users cannot log in. We only make the flow visible: "Verification Email Sent — check your inbox."
2. **Google-only OAuth.** Wire Google fully; remove inert Github/Twitter/LinkedIn from `auth.config.ts`. Single full-width "Continue with Google" button on each form.
3. **Design doc committed before implementation** (this file).
4. Image strategy recorded for a later phase: **any URL must render on the frontend; the hostname whitelist only enables optimization, never blocks rendering** (wrapper component: `next/image` when host whitelisted, plain `<img>` otherwise).

## Design

### 1. Login feedback surfaces

- `login/form.tsx`: add `onError` to the mutation → `toast.error(message)` using the action's returned error. Map action returns:
  - `{ error }` variants → toast
  - `{ success: "Verification Email Sent." }` → toast success "Check your inbox" (this is the unverified login path)
  - success-with-`redirectTo` is handled by `signIn` internally (redirect)
- Fix `mutationKey: ['register']` → `['login']`.
- Keep RHF inline validation errors as-is.

Action changes (`actions/auth/index.ts`):
- `await` the `sendVerificationEmail` in the unverified-login branch (currently `void`-fire-and-forget at line ~90). On mail failure → return `{ error }` so the user is not told "check your inbox" falsely.
- Remove dead `return { success: "Email Sent!" }` after `signIn` (unreachable).

### 2. Google OAuth wiring

`auth.config.ts`:
- Providers: keep `Google` only. Remove `Github`, `Twitter`, `LinkedIn` imports + entries.
- Explicit provider config: `Google({ clientId: process.env.AUTH_GOOGLE_ID, clientSecret: process.env.AUTH_GOOGLE_SECRET })` — explicit env reads (NextAuth v5 auto-reads `AUTH_GOOGLE_ID`/`AUTH_GOOGLE_SECRET`, but explicit is verifiable).

`auth.ts` jwt callback:
- Populate `token.picture` from `existingUser.image ?? existingUser.profilePic` → `session.user.image` then renders the real avatar.

Critical prerequisite (discovered during self-review): `@auth/prisma-adapter` v2.8.0 spreads the full OAuth user object (`image` included) into `prisma.user.create` — line 6 `createUser: ({ id, ...data }) => p.user.create(stripUndefined(data))`. The current `User` model has **no `image` column** (only `profilePic`), so the first Google OAuth user creation would crash with "Unknown argument `image`".
- Required schema change: add `image String?` to `model User` + a Prisma migration (`prisma migrate dev --name add_image_to_user`).
- This is the canonical PrismaAdapter column; the existing `profilePic` stays for credentials users.

Schema:
```prisma
model User {
  // ...existing
  profilePic     String?
  image          String?   // added for OAuth (PrismaAdapter requirement)
  password       String?
}
```

Forms (`login/form.tsx`, `register/form.tsx` — shared button area):
- Replace the inert 2-button row with one full-width `outline` "Continue with Google" button (Google icon + label).
- `onClick` → `signInProvider("google")` wrapped in the mutation or direct call; on error → toast.
- Missing-credentials guard lives **server-side** in `signInProvider` (no client env exposure needed): if `!process.env.AUTH_GOOGLE_ID || !process.env.AUTH_GOOGLE_SECRET` → return `{ error: "Google sign-in is not configured." }`; the form toasts it. Never a silent dead button.

`actions/auth/index.ts` `signInProvider` (exists, unused):
- Keep, verify `callbackUrl` handling; wire forms to it. Wrap in try/catch → `{ error }` for toast.
- Restrict its `provider` param type to `'google'` (drop `'github' | 'twitter' | 'linkedin'` branches) — dead providers are gone from `auth.config.ts`. Keep the unauthenticated-provider env guard (section 2).

Env/docs:
- Document in README or `.env.example`: create OAuth app at console.cloud.google.com → Credentials → OAuth client (Web) → Authorized redirect URI `http://localhost:3000/api/auth/callback/google` → set `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET` (no public flag needed — availability is checked server-side).

### 3. Route/layout bug fixes

- `app/(admin)/layout.tsx:15` — non-admin redirect `/home` → `/`.
- `routes.ts:43` — `'returns'` → `'/returns'`.
- `routes.ts:25-26` — remove `/onboarding`, `/password/reset/form` from `authRoutes` (both 404; keeping them means logged-in users get redirected off a 404 route).
- `app/(auth)/error/page.tsx:25` — `text-white` → theme-aware (`text-zinc-900 dark:text-white` matching the rest of the error page).

### 4. Register fixes

- `actions/auth/index.ts:173` — fix `'Confirmation Email Sent!.'` → `'Confirmation Email Sent!'`.
- Await the verification email send in Register; on failure `{ error }` (mail provider down must not claim success).
- Register `onError` already toasts (verified) — keep; route all errors through the same message shape as login.

### 5. Modal/page consistency

- `FormSignIn`/`FormSignUp` gain an optional `onSuccess` prop (default no-op). The modal wrappers (`sign-in-component.tsx`, `sign-up-component.tsx`) pass a close handler → dialog closes on success.
- Cross-links inside modals stay page links (`/login`, `/register`) — acceptable, they're prominent CTAs.
- Remove `shadow-input` from both forms' root divs.

### 6. Security hardening (in scope, small)

- **Email normalization**: `LoginSchema`/`RegisterSchema` — `z.string().email().trim().toLowerCase()`; `GetUserByEmail` lowercases input too (defense in depth).
- **Unified login failure**: one message `"Invalid email or password"` for user-not-found / password-mismatch / passwordless-user paths in the `Login` action; `authorize` in `auth.config.ts` does a dummy-bcrypt compare when user missing (kills timing oracle), and the credentials `authorize` should NOT leak "password not set" — that message becomes a generic failure. Keep the friendly "verify your email first" message only for the `AccessDenied` mapping (verified-unverified distinction) — that's our own UI copy, not an oracle: register already tells users verification is required.

## Non-goals (this phase)

- Image pipeline (any-URL render wrapper) — recorded for Phase 2.
- Rate limiting (login/register) — needs redis-backed limiter; separate cycle.
- Password reset flow (mail links to 404 `/password/reset`) — scaffold exists but absent; separate cycle, not silently half-built here.
- OAuth GitHub/Twitter/LinkedIn.
- 2FA (existing comment in `auth.ts:28`, out of scope).

## Verification plan

1. `npm run lint`
2. `npm run build`
3. Browser (Playwright):
   - `/login` + `/register` render, cross-links work
   - Wrong-password login → error toast appears (previously invisible)
   - Unverified-user login → "check your inbox" toast
   - Google button present, one per form; without creds configured → "not configured" state (no dead click)
   - Error page readable on light background (`/error?error=CredentialsSignin`)
   - `insert-into-db` a fresh user, verify normalization (mixed-case email resolves)
4. `git push` after review.

## Security notes

- No secrets in code; creds only via env.
- Email normalization prevents account splitting, not spam.
- Dummy-bcrypt keeps timing flat for missing vs existing users.
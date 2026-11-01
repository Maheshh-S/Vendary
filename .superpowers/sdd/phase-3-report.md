# Phase 3 — implementation report

**Status:** complete for Tasks 3.1–3.6, with the Sentry, CSP-nonce and
`.DS_Store` deviations documented below.

**Branch:** `worktree-phase-1-4` (worktree `/Users/mahesh/Developer/Vendary/.qoder/worktrees/phase-1-4`)

## Commits

| SHA | Subject |
| --- | --- |
| `765c70c` | `chore(deps): add Sentry and formatting tooling; drop Hono` |
| `0034f84` | `feat(observability): add structured logger and optional Sentry` |
| `0ac87c7` | `feat(health): add deep /api/status probe` |
| `3680074` | `feat(security): enforce CSP and add violation collector` |
| `36e13f0` | `feat(ops): add featured index and stale checkout cleanup` |
| `c7203e9` | `style: format the repository with Prettier` |
| `8ed9dbb` | `ci: run migrations, e2e subset, drift and audit` |
| `11ad761` | `chore(tooling): format and lint staged files before commit` |
| `0900e19` | `chore(docker): keep local artifacts out of the build context` |

The Hono route deletion landed in the dependency commit because `git rm` had
already staged it; the replacement `/api/status` route follows immediately in
`0ac87c7`. The formatting commit (`c7203e9`) is formatting-only and precedes
the commit that enables the pre-commit hook (`11ad761`), so the mechanical
diff is isolated from the hook rollout.

Follow-up after the first report pass: `6c6d448` rejects oversized CSP reports
by declared `content-length` before buffering them (the post-read length check
remains). Full unit/format/type/lint checks were re-run after it.

---

## Task 3.1 — structured logger + optional Sentry

- `lib/logger.ts`: one JSON line per event
  (`{ level, msg, time, action, requestId, orderId?, durationMs?, ...context }`).
  - Level filter from `LOG_LEVEL` (`debug|info|warn|error`, default `info`),
    read per call; invalid values fall back to `info`.
  - Key-based redaction for authorization/cookie/password/secret/token/api-key/
    session, every `razorpay*` field, every `*email*` field, and full-address
    components (`address`, line1/2, landmark, postal/zip code, street variants,
    shipping/billing address). Sensitive keys are replaced with `[redacted]`
    without stringifying the value, including nested objects/arrays.
  - Free-text scrubbing for email addresses and `rzp_(test|live)_…` key
    material. Error objects are reduced to a redacted, 200-character message;
    stacks and `cause` chains are never logged. Circular context is marked,
    depth/array/object sizes are bounded, and serialization failure falls back
    to a minimal line.
- `lib/monitoring.ts`: `initMonitoring()` imports `@sentry/nextjs` lazily only
  when `SENTRY_DSN` is non-blank; `captureException(error, {action, requestId,
  code})` tags the event and is a no-op until initialization succeeds. Sentry is
  configured with `tracesSampleRate: 0`, Sentry v11 `dataCollection` fully
  disabled (user info, cookies, headers, bodies, query params),
  `beforeBreadcrumb: () => null`, and a `beforeSend` that strips request
  headers/cookies/data and the user object. Initialization and capture never
  throw.
- `instrumentation.ts`: for `NEXT_RUNTIME === "nodejs"`, awaits
  `initMonitoring()` before env validation, so a startup failure is reportable.
- `lib/run-action.ts`: logs `action_failed` (action, requestId, durationMs,
  redacted error) and calls `captureException` with `action`/`requestId`/
  `code: "INTERNAL"`. The client still only sees the reference id.
- Env: `SENTRY_DSN` (optional URL), `LOG_LEVEL` (optional enum) and
  `CRON_SECRET` (optional) in `lib/env.ts` and `.env.example`.
- Tests: `tests/logger.test.ts` (13) covers shape, level filtering, key and
  free-text redaction, nested contexts, error masking, circular context, and
  the monitoring no-op without a DSN. `tests/env.test.ts` gained checks for the
  blank/valid/invalid new variables.

## Task 3.2 — deep `/api/status`; Hono removal

- `app/api/status/route.ts` returns
  `{ status: "ok"|"degraded"|"error", checks: { db: "up"|"down", redis:
  "up"|"down"|"disabled" }, version, uptimeS }` with `cache-control: no-store`.
  - DB probe is `SELECT 1` with a 1s bound; DB down returns HTTP 503.
  - Redis `ping` runs only when `REDIS_URL` is configured; a configured-but-down
    Redis reports `degraded` but keeps HTTP 200 (cache fallback semantics).
  - Logs only a fixed `check`/`reason` pair on failure — never the driver error,
    host or connection string.
- `lib/redis.ts` client interface gained `ping()`; the disabled client answers
  `"PONG"`.
- Deleted `app/api/[[...route]]/route.ts`; `hono` removed from dependencies and
  no source imports remain. Docker `HEALTHCHECK` still targets `/api/status`.
- Tests: `tests/status-route.test.ts` (7): DB up/down (200/503), Redis
  disabled/up/down/non-PONG, `GIT_SHA`, no-store header, no leaked hostnames.

## Task 3.3 — CI

`.github/workflows/ci.yml` now has two jobs, both with a `postgres:16` service:

- **quality**: frozen install, Prisma generate, `format:check`, typecheck, unit
  tests, lint, placeholder build, `prisma migrate deploy`, then a migration
  drift check using a freshly created `vendary_shadow` database and
  `prisma migrate diff --from-migrations … --to-schema-datamodel … --exit-code`
  (exit code 2 on drift). `bun audit --audit-level=high` runs with
  `continue-on-error: true` for non-blocking high/critical triage.
- **e2e**: frozen install, Prisma generate, cached Playwright browsers
  (`~/.cache/ms-playwright`, keyed by `bun.lock`), `playwright install
  --with-deps chromium`, migrate + seed, cached `.next/cache`, then
  `npm run e2e -- --grep-invert @payment`. Playwright report/traces upload on
  failure. Job-level placeholders supply a valid `DATABASE_URL`, `AUTH_SECRET`
  and fake Razorpay keys; no real secrets are used and `SKIP_ENV_VALIDATION` is
  not needed.

The payment spec stays local-only (real Razorpay test keys, `@payment` tag).

## Task 3.4 — enforced CSP + report collector

- `lib/csp.ts` is the single policy source used by `next.config.ts` and tests.
  `Content-Security-Policy` replaces `Content-Security-Policy-Report-Only` while
  keeping `checkout.razorpay.com` (script), `api.razorpay.com` +
  `lumberjack.razorpay.com` (connect), `api.razorpay.com` +
  `checkout.razorpay.com` (frame), the existing image hosts, `frame-ancestors
  'none'`, `base-uri 'self'`, `form-action 'self'`, `object-src 'none'` and
  `report-uri /api/csp-report`.
- Nonce/`'strict-dynamic'` is deliberately deferred; the rationale (Next 15
  inline bootstrap/flight scripts and Razorpay's injected inline script, both
  requiring a nonce threaded through every page) is documented in
  `lib/csp.ts`. `'unsafe-inline'`/`'unsafe-eval'` are retained for scripts.
  Rolling back to report-only is a one-line header rename.
- `app/api/csp-report/route.ts` accepts the legacy `application/csp-report`
  envelope, Reporting API arrays and bare JSON. It rate-limits per
  `x-forwarded-for` (`RATE_LIMITS.cspReport`, 30/min), logs a structured
  `csp_violation` warning with the violated directive and origin+path only
  (query/hash stripped; blocked URI sanitized), never logs cookies/headers, and
  always answers 204. Oversized, malformed, unsupported-type and over-budget
  reports are dropped silently.
- Tests: `tests/csp.test.ts` (13) asserts the served header (via
  `next.config.ts`) includes the Razorpay hosts, `report-uri`, `frame-ancestors
  'none'`, `base-uri`/`form-action`, is enforcing (no report-only header), and
  covers legacy/Reporting-API/bare reports, URL sanitization and rate-limit
  dropping.

## Task 3.5 — Prettier/husky/lint-staged + hygiene

- Dev deps `prettier`, `husky`, `lint-staged`; `.prettierrc` (double quotes,
  semicolons, 100 cols, LF), `.prettierignore` (dependencies/build output,
  lockfiles, Prisma migrations, generated Next types, static assets, prose/MDX,
  tooling artifacts) and `format`/`format:check` scripts.
- One formatting-only commit (`c7203e9`, 242 files) ran before the hook was
  enabled. `npm run format:check` passes and is part of CI.
- `lint-staged.config.mjs` runs `prettier --write` + `eslint --fix` on staged
  JS/TS and `prettier --write` on JSON/CSS. Husky's pre-commit hook runs
  `npx lint-staged`; the hook executed successfully during its own commit.
- Hygiene: no `.DS_Store` files were tracked (`git ls-files` empty), and
  `.gitignore` already ignored them. Added `.qoder/` to `.gitignore` and
  excluded local/tooling artifacts (`.qoder`, `.superpowers`, `coverage`,
  Playwright reports) from the Docker build context. No tracked junk needed
  pruning.

## Task 3.6 — indexes + stale pending cleanup

- `prisma/migrations/20261215000000_ops_indexes` adds
  `Product(availability, isFeatured, createdAt)` and the matching
  `@@index` in `schema.prisma`. `OrderItem(productId)`,
  `Order(status, createdAt)` and `Product(availability, createdAt)` already
  existed from `20261115001000_catalog_indexes`, so they were not duplicated.
  Applied locally; drift check reports no difference.
- `app/api/cron/cleanup/route.ts` requires `Authorization: Bearer
  $CRON_SECRET` (501 when unset, 401 when wrong or malformed, constant-time
  comparison). POST and GET share the handler (hosted schedulers often issue
  GET).
  - Selects at most 200 `pending` orders with `paymentId: ""` older than 60
    minutes, claims each with a guarded `updateMany`, and writes an
    `order_cancelled` event (`from pending`, `to cancelled`, `actorId: null`,
    `metadata.source: "cleanup"`). Orders with a captured payment id are never
    touched.
  - Deletes `Address` rows with `order: { is: null }` older than 24h; any order
    reference (including cancelled/refunded history) protects the snapshot.
  - Invalidates the featured cache and logs `cleanup_completed` with counts and
    duration. DB failures return 500 so the scheduler retries; every write is
    guarded, so reruns are idempotent.
- Tests: `tests/cleanup.test.ts` (11): 501/401/missing/wrong scheme, stale-only
  query shape with the 60-minute cutoff, guarded claim and audit event, a lost
  race writes no event, idempotent rerun, 24h address cutoff with
  `order: {is:null}`, cache invalidation, count logging and 500-on-failure.

---

## Verification

| Command | Result |
| --- | --- |
| `npx vitest run` | **704 passed**, 3 integration tests skipped (34 files passed, 1 skipped) |
| `npx tsc --noEmit` | pass |
| `npm run lint` | pass, no warnings or errors |
| `npm run format:check` | pass |
| `DATABASE_URL=… npm run e2e -- --grep-invert @payment --workers=1` | **26 passed** with CSP enforced (CI parity: 1 worker) |
| `DATABASE_URL=… npm run e2e -- --grep @payment --workers=1` | **1 passed** — real Razorpay test order creation, stubbed checkout.js, CSP enforced |
| Placeholder build (`DATABASE_URL=postgresql://ci:ci@localhost:5432/ci AUTH_SECRET=ci-placeholder-secret npm run build`) | pass; `/api/status`, `/api/cron/cleanup`, `/api/csp-report` present, `/api/hello` gone |
| `prisma migrate diff --from-migrations … --exit-code` against a local shadow DB | `No difference detected` |
| `docker build -t vendary-phase3 .` | pass |
| Docker runtime probe | container **healthy**; `/api/status` → 200 `{status:"ok", checks:{db:"up", redis:"up"}}`; enforcing CSP header served |
| `bun audit --audit-level=high` | 67 findings (7 critical, 60 high), non-blocking by design — see Concerns |

## Deviations from the brief / scope

- **Sentry wiring**: per the task scope, `next.config.ts` is not wrapped with
  `withSentryConfig` and no `sentry.*.config.ts` files / auth token / org /
  project variables were added. Exception capture is initialised from
  `instrumentation.ts` on the node runtime. This keeps builds green without
  source-map upload credentials; it also means edge-runtime errors are not
  captured.
- **Sentry v11 API**: `sendDefaultPii` no longer exists in the SDK types; the
  equivalent opt-out is the new `dataCollection` option (all PII channels
  disabled), backed by `beforeSend` stripping.
- **CSP nonce / strict-dynamic** is deferred, with the reasoning documented in
  `lib/csp.ts`; `'unsafe-inline'`/`'unsafe-eval'` remain for scripts.
- **Hono deletion** landed in the dependency commit (already staged from
  `git rm`), with the replacement route in the next commit.
- **No tracked `.DS_Store` files existed**, so no `git rm --cached` was needed;
  `.gitignore` already covered them. `.qoder/` and Docker-context artifacts
  were added as safe hygiene.
- **Cleanup accepts GET** in addition to POST for hosted cron schedulers; both
  paths require the bearer secret and are idempotent.
- **Only the genuinely missing index** was created; the other two planned
  indexes already exist in the schema/migrations.

## Self-review against Phase 3 acceptance criteria

- [x] Sentry receives masked errors with action/request/code tags when
      `SENTRY_DSN` is configured; without a DSN every path is a tested no-op.
      No secrets/PII are logged: key-based redaction, free-text email/Razorpay
      scrubbing, truncated error messages, no stacks.
- [x] `/api/status` checks DB (hard, 503) and Redis (optional, degraded);
      Docker healthcheck still uses the path and the built image reports
      healthy.
- [x] CI runs format, typecheck, unit, lint, build, migrations, e2e subset,
      drift and a non-blocking high/critical audit.
- [x] CSP is enforcing with working Razorpay checkout under `@payment` e2e;
      violations are collected, rate-limited and logged without PII.
- [x] Pre-commit formatting is active; `format:check` passes in CI; no
      `.DS_Store` tracked.
- [x] Stale unpaid pending orders are cancelled with audit events; stale
      unreferenced addresses are deleted; cleanup is authenticated and
      idempotent.
- [x] No money/order/refund/webhook invariant or the status map was changed.
      No new runtime dependency beyond `@sentry/nextjs`.

## Concerns

- **Parallel e2e flakiness**: the non-payment suite passed 26/26 with
  `--workers=1` (the CI setting), but one full local run with 5 workers had two
  transient failures (`account` address-card visibility and
  `checkout-drift` navigation). Both specs pass serially and in isolation;
  likely shared-DB/parallel timing rather than a product regression. Worth
  watching if local worker counts are raised.
- **Audit findings**: `next-auth@5.0.0-beta` carries a critical Auth.js email
  normalization advisory and a high `getToken()` advisory; `picomatch` ReDoS
  arrives through dev/tooling chains (`vitest`, `lint-staged`, Sentry's rollup
  plugin). CI triages them in the log without blocking. Upgrading next-auth to
  a stable v5 and pinning `picomatch` should be a follow-up.
- **CSP strength**: `'unsafe-inline'`/`'unsafe-eval'` mean CSP is not yet a
  strong XSS mitigation; nonce/`strict-dynamic` remains the next security step.
- **Logger free-text addresses**: addresses inside arbitrary error messages are
  truncated but not pattern-redacted (email and Razorpay key patterns are).
  Address fields in structured context are fully redacted by key.
- **Cleanup throughput**: at most 200 suspended orders per invocation; a very
  large backlog drains over several scheduled runs.
- **Monitoring scope**: only node-runtime exceptions from `runAction` are
  captured; edge middleware/server errors and unhandled rejections rely on the
  platform.

---

## Fix round 1 (2026-11-01)

Review findings addressed on `worktree-phase-1-4`.

### Sentry capture now works in the built server

- `lib/monitoring.ts` no longer keeps the SDK in module-local state. The SDK
  namespace and an `__vendarySentryEnabled` flag are published on `globalThis`,
  which every server chunk in the Node process shares. `captureException` reads
  the global flag/SDK on each call, so an action chunk that never ran
  `initMonitoring` still captures. Previously each chunk had its own
  `let sentry = null`, and the action-chunk copies were permanently null.
- The runtime `import("@sentry/nextjs")` moved to `lib/monitoring-init.ts`,
  imported only by `instrumentation.ts`. This is also the bundle fix for minor
  #5: before the split webpack embedded one ~1.6 MB SDK copy per server graph
  (`chunks/1844.js`, `chunks/5131.js`, `chunks/7154.js`); after it the SDK is
  emitted once (`chunks/7154.js`) and referenced only by
  `instrumentation.js.nft.json`.
- No DSN: `initMonitoring` returns false before importing the SDK; capture is a
  no-op; nothing throws and no network call is made. `next build` stays green
  (verified below).
- Regression tests in `tests/monitoring.test.ts` use `vi.resetModules()` +
  dynamic imports: `initMonitoring` runs in one module instance, `lib/monitoring`
  is imported again as a separate instance, `captureException` is called, and
  the mocked `@sentry/nextjs` `captureException` is asserted with the
  action/requestId/code tags. A second test asserts no-DSN performs zero SDK
  imports and zero captures.

Built-artifact proof after `npm run build`:

```
$ grep -rl "@sentry/nextjs" .next/server/chunks .next/server/instrumentation.js
.next/server/chunks/7154.js

$ grep -rl "__vendarySentrySdk" .next/server/chunks .next/server/instrumentation.js
.next/server/chunks/5198.js
.next/server/chunks/879.js
.next/server/instrumentation.js

$ grep -o ".\{40\}__vendarySentryEnabled=.\{40\}" .next/server/instrumentation.js
e=>{let t=tR();t.__vendarySentrySdk=e,t.__vendarySentryEnabled=!!e},tL=e=>({dsn:e,environment:"producti

$ grep -rho ".\{40\}__vendarySentrySdk.captureException.\{50\}" .next/server/chunks
equestId),t.code&&(a.code=t.code);try{r.__vendarySentrySdk.captureException(e,{tags:a})}catch{}},o=e=>{if("object"!=typeof e|
equestId),t.code&&(a.code=t.code);try{a.__vendarySentrySdk.captureException(e,{tags:r})}catch{}},o=e=>{if("object"!=typeof e|
```

The init side lives in `instrumentation.js`; the two action chunks contain the
non-empty global capture call, so the previous empty-function path is gone.

### Sentry PII opt-out

- `buildSentryOptions` sets `dataCollection.stackFrameVariables: false` and
  `dataCollection.databaseQueryData: false` in addition to the existing
  user/cookie/header/body/query opt-outs (Sentry v11 API, SDK 11.10.0).
- `beforeSend` deletes `event.exception.values[].stacktrace.frames[].vars`
  along with `request.headers/cookies/data/query_string` and `event.user`.
  Action locals (addresses, emails, Razorpay objects) therefore cannot ship
  even if a future SDK version collects them.
- Test: a synthetic event carrying frame `vars` (email, street address,
  Razorpay object) plus request/user fields is scrubbed by `beforeSend`.

### CSP proven against the real Razorpay checkout

- New `e2e/csp-razorpay.spec.ts` (tagged `@payment`, skipped without Razorpay
  keys) does NOT stub `checkout.js`: it logs in, adds a product, fills the
  checkout form, clicks "Proceed to Payment", waits for the real Razorpay
  modal iframe, and collects console messages containing "Content Security
  Policy" plus `checkout.razorpay.com`/`api.razorpay.com` responses and failed
  requests. It asserts a successful `checkout.razorpay.com/v1/checkout.js`
  response, a visible iframe and zero CSP violations, then removes the modal
  without paying.
- `lib/csp.ts`: `https://*.razorpay.com` added to `script-src`, `connect-src`
  and `frame-src` alongside the exact hosts; `worker-src 'self' blob:` and
  `child-src 'self' blob:` added; `https://nominatim.openstreetmap.org` added
  to `connect-src` (checkout geolocation autofill). `'unsafe-inline'` /
  `'unsafe-eval'` remain.
- Outcome: the real checkout iframe loaded under the enforcing policy with no
  CSP violations. Only modal loading is validated by this spec — no payment was
  completed, so this is not a claim of full paid-flow validation. The paid path
  remains covered by the stubbed `payment.spec.ts` (both pass, below).

### Cheap minors

1. Cleanup route: the interactive transaction now has an explicit
   `CLEANUP_TRANSACTION_TIMEOUT_MS = 30_000` timeout. The batch stays capped at
   200 and the guarded `updateMany` claim/audit-event logic (and therefore
   idempotency) is unchanged.
2. `playwright.config.ts` now defaults to `workers: 1` locally as well, with an
   `E2E_WORKERS` override for a disposable database. CI retries are unchanged.
3. Logger adoption: every remaining hot-path `console.error`/`console.warn` in
   `lib/redis.ts`, `lib/rate-limit.ts`, `lib/orders/refund.ts`,
   `lib/orders/late-capture.ts` and `actions/orders/index.ts` now goes through
   `lib/logger.ts`. Existing structured `event` fields are preserved; error
   values are reduced to the logger's redacted/truncated message and the rate
   limiter still logs only a fixed `reason`. The orphan Razorpay order in
   `order_persist_failed` is logged as `orderReference` because the logger
   deliberately redacts any `razorpay`-named key; the reference remains usable
   for reconciliation. Tests that parsed the old hand-built JSON were updated
   for the logger line shape.
4. Advisory note below.
5. SDK consolidation: see the Sentry section — one emitted SDK chunk instead of
   three.

### Advisories (dated 2026-11-01)

The audit position is unchanged from the first report: `next-auth@5.0.0-beta`
still carries the Auth.js email-normalisation critical advisory and the
`getToken()` high advisory, and `picomatch` ReDoS arrives through dev/tooling
chains (`vitest`, `lint-staged`, Sentry's rollup plugin). CI continues to
report high/critical findings without blocking. Follow-up remains: upgrade to a
stable next-auth v5 release and pin/patch `picomatch`, then re-run
`bun audit --audit-level=high`. No runtime dependency was added in this round.

### Verification (fix round)

| Command | Result |
| --- | --- |
| `npx vitest run` | **710 passed**, 3 integration tests skipped (35 files passed, 1 skipped) |
| `npx tsc --noEmit` | pass |
| `npm run lint` | pass, no warnings or errors |
| `npm run format:check` | pass |
| `DATABASE_URL=postgresql://vendary:vendary@localhost:5432/vendary npm run e2e -- --grep-invert @payment` | **26 passed** (1 worker, `workers: 1` default) |
| `DATABASE_URL=… npm run e2e -- --grep @payment` | **2 passed** — stubbed paid flow plus the real Razorpay CSP spec (real iframe, no violations) |
| Placeholder build (`DATABASE_URL=postgresql://ci:ci@localhost:5432/ci AUTH_SECRET=ci-placeholder-secret … npm run build`) | pass; chunk grep above shows one SDK chunk and the global capture path |
| `docker build -t vendary-phase3-fix .` | pass (exit 0) |
| Docker runtime probe | container **healthy**; `/api/status` → 200 `{"status":"ok","checks":{"db":"up","redis":"disabled"}}`; enforcing CSP header served with `https://*.razorpay.com`, `worker-src`/`child-src`, and the nominatim connect host |

### Files changed

- `lib/monitoring.ts`, `lib/monitoring-init.ts` (new), `instrumentation.ts`,
  `tests/monitoring.test.ts` (new), `tests/logger.test.ts`
- `lib/csp.ts`, `e2e/csp-razorpay.spec.ts` (new), `tests/csp.test.ts`
- `app/api/cron/cleanup/route.ts`, `playwright.config.ts`
- `lib/redis.ts`, `lib/rate-limit.ts`, `lib/orders/refund.ts`,
  `lib/orders/late-capture.ts`, `actions/orders/index.ts`
- `tests/rate-limit.test.ts`, `tests/rate-limit-redis.test.ts`,
  `tests/order-status.test.ts`, `tests/order-confirmation.test.ts`
- this report

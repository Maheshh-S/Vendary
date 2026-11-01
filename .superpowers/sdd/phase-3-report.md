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

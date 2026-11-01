#!/usr/bin/env bash
#
# Vendary deploy smoke test (Task 4.6).
#
# Read-only checks against a running instance (preview, production or local):
#   scripts/smoke.sh --base-url https://vendary.example.com
#
# The only write-shaped call is an unknown-event webhook with a valid HMAC.
# It is skipped unless RAZORPAY_WEBHOOK_SECRET is exported; the route
# acknowledges unknown events with 200 and performs no side effects. The secret
# is never printed.
#
# Exit status: 0 when every check passed, 1 otherwise.

set -uo pipefail

BASE_URL="http://127.0.0.1:3000"
CURL_MAX_TIME=30

usage() {
  cat <<'EOF'
Usage: scripts/smoke.sh [--base-url URL | URL]

  --base-url URL   Target origin (default: http://127.0.0.1:3000)
  URL              Positional shorthand for --base-url
  -h, --help       Show this help

Environment:
  RAZORPAY_WEBHOOK_SECRET   Optional. When set, sends one signed unknown-event
                            webhook and expects HTTP 200. Skipped otherwise.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --base-url)
      if [ "$#" -lt 2 ]; then
        echo "error: --base-url needs a value" >&2
        exit 1
      fi
      BASE_URL="$2"
      shift 2
      ;;
    --base-url=*)
      BASE_URL="${1#--base-url=}"
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    http://* | https://*)
      BASE_URL="$1"
      shift
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

BASE_URL="${BASE_URL%/}"
case "$BASE_URL" in
  http://* | https://*) ;;
  *)
    echo "error: --base-url must start with http:// or https://" >&2
    exit 1
    ;;
esac

PASS=0
FAIL=0

pass() {
  PASS=$((PASS + 1))
  printf 'PASS  %s\n' "$1"
}

fail() {
  FAIL=$((FAIL + 1))
  printf 'FAIL  %s\n' "$1" >&2
}

skip() {
  printf 'SKIP  %s\n' "$1"
}

# check_page <label> <path> <required-substring>
check_page() {
  local label="$1"
  local path="$2"
  local needle="$3"
  local body_file status

  body_file="$(mktemp)"
  status="$(curl -sS --max-time "$CURL_MAX_TIME" -o "$body_file" -w '%{http_code}' "$BASE_URL$path" 2>/dev/null)" || status="000"

  if [ "$status" != "200" ]; then
    fail "$label (GET $path -> HTTP $status)"
  elif ! grep -q -- "$needle" "$body_file"; then
    fail "$label (GET $path is 200 but does not contain '$needle')"
  else
    pass "$label (GET $path -> 200)"
  fi

  rm -f "$body_file"
}

printf 'Vendary smoke test against %s\n\n' "$BASE_URL"

check_page "Storefront home" "/" "Vendary"
check_page "Catalog" "/products" 'href="/products/'

# Deep health check: DB must be up (HTTP 200 + "db":"up"). Redis may be
# "up", "down" or "disabled"; a configured-but-down Redis is still HTTP 200.
status_file="$(mktemp)"
status="$(curl -sS --max-time "$CURL_MAX_TIME" -o "$status_file" -w '%{http_code}' "$BASE_URL/api/status" 2>/dev/null)" || status="000"
if [ "$status" != "200" ]; then
  fail "Health check (GET /api/status -> HTTP $status)"
elif ! grep -q '"db":"up"' "$status_file"; then
  fail "Health check (GET /api/status is 200 but db is not up)"
else
  pass "Health check (GET /api/status -> 200, db up)"
fi
rm -f "$status_file"

if [ -z "${RAZORPAY_WEBHOOK_SECRET:-}" ]; then
  skip "Signed webhook (RAZORPAY_WEBHOOK_SECRET is not set)"
else
  payload='{"event":"smoke.test","payload":{}}'
  signature="$(printf '%s' "$payload" | openssl dgst -sha256 -hmac "$RAZORPAY_WEBHOOK_SECRET" | awk '{print $NF}')"
  webhook_status="$(
    curl -sS --max-time "$CURL_MAX_TIME" -o /dev/null -w '%{http_code}' \
      -X POST "$BASE_URL/api/razorpay/webhook" \
      -H 'content-type: application/json' \
      -H "x-razorpay-signature: $signature" \
      --data-binary "$payload" 2>/dev/null
  )" || webhook_status="000"

  if [ "$webhook_status" = "200" ]; then
    pass "Signed webhook (unknown event -> 200, no side effects)"
  else
    fail "Signed webhook (expected 200, got HTTP $webhook_status)"
  fi
fi

printf '\nSUMMARY  %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]

/**
 * Structured JSON logger.
 *
 * Every operational line is one JSON object so log shipping can index fields
 * instead of parsing prose. The contract is intentionally small:
 *
 *   { level, msg, time, action?, requestId?, orderId?, durationMs?, ...context }
 *
 * Safety rules (enforced here, not at call sites):
 * - credential/PII-looking keys are replaced with `[redacted]` and never
 *   stringified, even when the value is an object,
 * - raw error values are reduced to a redacted, truncated message — no stack,
 *   no `cause`, no payload,
 * - free-text values have email addresses and Razorpay key material scrubbed.
 *
 * `LOG_LEVEL` (debug|info|warn|error, default info) filters by severity. It is
 * read per call so tests and runtime config can change it without a restart.
 */

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

/** Arbitrary structured fields alongside the reserved fields. */
export type LogContext = Record<string, unknown>;

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const REDACTED = "[redacted]";
const MAX_TEXT_LENGTH = 300;
const MAX_MESSAGE_LENGTH = 200;
const MAX_ERROR_MESSAGE_LENGTH = 200;
const MAX_ARRAY_ITEMS = 20;
const MAX_OBJECT_KEYS = 25;
const MAX_DEPTH = 3;

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const RAZORPAY_KEY_PATTERN = /\brzp_(?:live|test)_[A-Za-z0-9]+/g;

/** Credentials, cookies, sessions, signing material. */
const SENSITIVE_KEY =
  /authorization|cookie|password|passwd|secret|token|api[_-]?key|signature|session/i;
/** Any Razorpay-scoped field (key ids, secrets, webhook payloads). */
const RAZORPAY_KEY = /razorpay/i;
/** Addresses of any kind. */
const EMAIL_KEY = /e-?mail/i;
/** Full-address components; a city alone is not identifying, the envelope is. */
const ADDRESS_KEYS = new Set([
  "address",
  "address1",
  "address2",
  "addressline1",
  "addressline2",
  "billingaddress",
  "fulladdress",
  "landmark",
  "line1",
  "line2",
  "postalcode",
  "postcode",
  "shippingaddress",
  "street",
  "streetaddress",
  "zip",
  "zipcode",
]);

const LEVEL_WRITERS: Record<LogLevel, (line: string) => void> = {
  debug: (line) => console.debug(line),
  info: (line) => console.info(line),
  warn: (line) => console.warn(line),
  error: (line) => console.error(line),
};

const configuredLevel = (): LogLevel => {
  const raw = process.env.LOG_LEVEL?.trim().toLowerCase();
  return (LOG_LEVELS as readonly string[]).includes(raw ?? "") ? (raw as LogLevel) : "info";
};

/** Scrubs secrets/PII from free text and bounds its length. */
export const redactText = (value: string, maxLength = MAX_TEXT_LENGTH): string => {
  const scrubbed = value
    .replace(EMAIL_PATTERN, "[redacted-email]")
    .replace(RAZORPAY_KEY_PATTERN, "[redacted-razorpay-key]");
  return scrubbed.length > maxLength ? `${scrubbed.slice(0, maxLength)}…` : scrubbed;
};

const isSensitiveKey = (key: string): boolean => {
  const normalized = key.toLowerCase().replace(/[-_]/g, "");
  return (
    SENSITIVE_KEY.test(key) ||
    RAZORPAY_KEY.test(key) ||
    EMAIL_KEY.test(key) ||
    ADDRESS_KEYS.has(normalized)
  );
};

/**
 * Error values are masked to a truncated message. Stacks commonly embed query
 * fragments and payloads, and `cause` chains can carry arbitrarily far — neither
 * belongs in a log line.
 */
const describeError = (error: Error): string =>
  redactText(error.message || error.name, MAX_ERROR_MESSAGE_LENGTH);

const sanitizeValue = (
  key: string,
  value: unknown,
  depth: number,
  seen: WeakSet<object>
): unknown => {
  if (isSensitiveKey(key)) {
    return REDACTED;
  }
  if (value instanceof Error) {
    return describeError(value);
  }
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string") {
    return redactText(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "function" || typeof value === "symbol") {
    return REDACTED;
  }
  if (depth >= MAX_DEPTH) {
    return "[truncated]";
  }

  // Objects and arrays: redact by nested key as well, guarding cycles.
  const record = value as object;
  if (seen.has(record)) {
    return "[circular]";
  }
  seen.add(record);
  try {
    if (Array.isArray(record)) {
      return record
        .slice(0, MAX_ARRAY_ITEMS)
        .map((item, index) => sanitizeValue(String(index), item, depth + 1, seen));
    }
    const entries = Object.entries(record as Record<string, unknown>).slice(0, MAX_OBJECT_KEYS);
    return Object.fromEntries(
      entries.map(([nestedKey, nestedValue]) => [
        nestedKey,
        sanitizeValue(nestedKey, nestedValue, depth + 1, seen),
      ])
    );
  } finally {
    seen.delete(record);
  }
};

const emit = (level: LogLevel, msg: string, context?: LogContext): void => {
  if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[configuredLevel()]) {
    return;
  }

  const payload: Record<string, unknown> = {
    level,
    msg: redactText(msg, MAX_MESSAGE_LENGTH),
    time: new Date().toISOString(),
  };

  if (context) {
    const seen = new WeakSet<object>();
    // Mark the root so a direct self-reference is caught at depth 1 instead of
    // being expanded once more.
    seen.add(context);
    try {
      for (const [key, value] of Object.entries(context)) {
        if (key === "level" || key === "msg" || key === "time") {
          continue;
        }
        payload[key] = sanitizeValue(key, value, 0, seen);
      }
    } finally {
      seen.delete(context);
    }
  }

  try {
    LEVEL_WRITERS[level](JSON.stringify(payload));
  } catch {
    // A context with a hostile `toJSON` must not break the caller.
    LEVEL_WRITERS[level](
      JSON.stringify({
        level,
        msg: payload.msg,
        time: payload.time,
        context: "[unserializable]",
      })
    );
  }
};

export const logger = {
  debug: (msg: string, context?: LogContext): void => emit("debug", msg, context),
  info: (msg: string, context?: LogContext): void => emit("info", msg, context),
  warn: (msg: string, context?: LogContext): void => emit("warn", msg, context),
  error: (msg: string, context?: LogContext): void => emit("error", msg, context),
};

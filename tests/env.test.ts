import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { register } from "@/instrumentation";
import { assertRuntimeEnv, getEnvProblems, serverEnvSchema } from "@/lib/env";

/** A complete, syntactically valid production environment. */
const BASE_ENV = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://vendary:db-password@localhost:5432/vendary",
  AUTH_SECRET: "auth-secret-value-that-is-long-enough",
  NEXT_PUBLIC_RAZORPAY_KEY_ID: "rzp_test_key_id",
  RAZORPAY_KEY_SECRET: "razorpay-key-secret-value",
  RAZORPAY_WEBHOOK_SECRET: "razorpay-webhook-secret-value",
} as const;

const MANAGED_KEYS: readonly string[] = [
  "NODE_ENV",
  "DATABASE_URL",
  "AUTH_SECRET",
  "AUTH_GOOGLE_ID",
  "AUTH_GOOGLE_SECRET",
  "NEXT_PUBLIC_RAZORPAY_KEY_ID",
  "RAZORPAY_KEY_SECRET",
  "RAZORPAY_WEBHOOK_SECRET",
  "RESEND_API_KEY",
  "REDIS_URL",
  "NEXT_PUBLIC_SITE_URL",
  "SENTRY_DSN",
  "LOG_LEVEL",
  "CRON_SECRET",
  "NEXT_PHASE",
  "NEXT_RUNTIME",
  "SKIP_ENV_VALIDATION",
] as const;

const originalEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of MANAGED_KEYS) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of MANAGED_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  vi.restoreAllMocks();
});

/** Applies overrides to the real process env (register() reads it). */
const applyProcessEnv = (overrides: Record<string, string | undefined>): void => {
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
};

const captureError = (fn: () => unknown): Error => {
  try {
    fn();
  } catch (error) {
    return error as Error;
  }
  throw new Error("Expected function to throw");
};

describe("serverEnvSchema", () => {
  it("accepts a complete production configuration and applies defaults", () => {
    const parsed = serverEnvSchema.safeParse(BASE_ENV);

    if (!parsed.success) {
      throw new Error(`Expected valid env, got: ${parsed.error.message}`);
    }
    expect(parsed.data.NODE_ENV).toBe("production");
    expect(parsed.data.NEXT_PUBLIC_SITE_URL).toBe("http://localhost:3000");
    expect(parsed.data.AUTH_GOOGLE_ID).toBeUndefined();
  });

  it("accepts Google credentials only when both halves are present", () => {
    const parsed = serverEnvSchema.safeParse({
      ...BASE_ENV,
      AUTH_GOOGLE_ID: "google-client-id",
      AUTH_GOOGLE_SECRET: "google-client-secret",
    });

    expect(parsed.success).toBe(true);
  });

  it("treats blank optional Google credentials as unset", () => {
    const parsed = serverEnvSchema.safeParse({
      ...BASE_ENV,
      AUTH_GOOGLE_ID: "",
      AUTH_GOOGLE_SECRET: "",
      RESEND_API_KEY: "",
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.AUTH_GOOGLE_ID).toBeUndefined();
    expect(parsed.data.AUTH_GOOGLE_SECRET).toBeUndefined();
    expect(parsed.data.RESEND_API_KEY).toBeUndefined();
  });

  it("rejects an unpaired AUTH_GOOGLE_ID", () => {
    const parsed = serverEnvSchema.safeParse({ ...BASE_ENV, AUTH_GOOGLE_ID: "google-client-id" });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(
      parsed.error.issues.some((issue) => issue.message.includes("must be set together"))
    ).toBe(true);
  });

  it("rejects an unpaired AUTH_GOOGLE_SECRET", () => {
    const parsed = serverEnvSchema.safeParse({
      ...BASE_ENV,
      AUTH_GOOGLE_SECRET: "google-client-secret",
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(
      parsed.error.issues.some((issue) => issue.message.includes("must be set together"))
    ).toBe(true);
  });

  it.each([
    ["a non-postgres URL", "mysql://user:pass@localhost:3306/vendary"],
    ["a malformed URL", "not-a-url"],
  ])("rejects DATABASE_URL as %s", (_label, databaseUrl) => {
    const parsed = serverEnvSchema.safeParse({ ...BASE_ENV, DATABASE_URL: databaseUrl });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.some((issue) => issue.path[0] === "DATABASE_URL")).toBe(true);
  });

  it("accepts Redis as absent, empty, or a valid URL", () => {
    expect(serverEnvSchema.safeParse(BASE_ENV).success).toBe(true);

    const empty = serverEnvSchema.safeParse({ ...BASE_ENV, REDIS_URL: "" });
    expect(empty.success).toBe(true);
    if (empty.success) expect(empty.data.REDIS_URL).toBe("");

    const url = serverEnvSchema.safeParse({ ...BASE_ENV, REDIS_URL: "redis://localhost:6379" });
    expect(url.success).toBe(true);
  });

  it("rejects a malformed Redis URL when one is provided", () => {
    const parsed = serverEnvSchema.safeParse({ ...BASE_ENV, REDIS_URL: "not-a-url" });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.some((issue) => issue.path[0] === "REDIS_URL")).toBe(true);
  });

  it("treats blank observability/ops variables as unset", () => {
    const parsed = serverEnvSchema.safeParse({
      ...BASE_ENV,
      SENTRY_DSN: "",
      LOG_LEVEL: "",
      CRON_SECRET: "",
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.SENTRY_DSN).toBeUndefined();
    expect(parsed.data.LOG_LEVEL).toBeUndefined();
    expect(parsed.data.CRON_SECRET).toBeUndefined();
  });

  it("accepts a Sentry DSN, a known log level and a cron secret", () => {
    const parsed = serverEnvSchema.safeParse({
      ...BASE_ENV,
      SENTRY_DSN: "https://key@sentry.example.com/1",
      LOG_LEVEL: "warn",
      CRON_SECRET: "cron-secret",
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.LOG_LEVEL).toBe("warn");
    expect(parsed.data.CRON_SECRET).toBe("cron-secret");
  });

  it.each([
    ["LOG_LEVEL", { LOG_LEVEL: "verbose" }],
    ["SENTRY_DSN", { SENTRY_DSN: "not-a-url" }],
  ])("rejects an invalid %s", (name, override) => {
    const parsed = serverEnvSchema.safeParse({ ...BASE_ENV, ...override });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.some((issue) => issue.path[0] === name)).toBe(true);
  });

  it("rejects an AUTH_SECRET shorter than 32 characters", () => {
    const parsed = serverEnvSchema.safeParse({ ...BASE_ENV, AUTH_SECRET: "too-short-secret" });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.some((issue) => issue.path[0] === "AUTH_SECRET")).toBe(true);
  });
});

describe("assertRuntimeEnv", () => {
  it("returns the parsed environment when valid", () => {
    const env = assertRuntimeEnv(BASE_ENV);

    expect(env.DATABASE_URL).toBe(BASE_ENV.DATABASE_URL);
    expect(env.RAZORPAY_KEY_SECRET).toBe(BASE_ENV.RAZORPAY_KEY_SECRET);
  });

  it("throws a names-only error when a Razorpay secret is missing", () => {
    const error = captureError(() =>
      assertRuntimeEnv({ ...BASE_ENV, RAZORPAY_KEY_SECRET: undefined })
    );

    expect(error.message).toContain("RAZORPAY_KEY_SECRET");
    expect(error.message).not.toContain(BASE_ENV.AUTH_SECRET);
    expect(error.message).not.toContain(BASE_ENV.DATABASE_URL);
    expect(error.message).not.toContain(BASE_ENV.RAZORPAY_WEBHOOK_SECRET);
  });

  it("does not leak an invalid secret value in the error message", () => {
    const weakSecret = "leaky-short-secret";
    const error = captureError(() => assertRuntimeEnv({ ...BASE_ENV, AUTH_SECRET: weakSecret }));

    expect(error.message).toContain("AUTH_SECRET");
    expect(error.message).not.toContain(weakSecret);
  });

  it("names both Google variables when they are unpaired", () => {
    const error = captureError(() =>
      assertRuntimeEnv({ ...BASE_ENV, AUTH_GOOGLE_ID: "google-client-id" })
    );

    expect(error.message).toContain("AUTH_GOOGLE_ID");
    expect(error.message).toContain("AUTH_GOOGLE_SECRET");
  });
});

describe("getEnvProblems", () => {
  it("returns no problems for a valid environment", () => {
    expect(getEnvProblems(BASE_ENV)).toEqual([]);
  });

  it("returns variable names, never values", () => {
    const problems = getEnvProblems({
      ...BASE_ENV,
      DATABASE_URL: "mysql://secret-host/db",
      RAZORPAY_WEBHOOK_SECRET: undefined,
    });

    expect(problems).toContain("DATABASE_URL");
    expect(problems).toContain("RAZORPAY_WEBHOOK_SECRET");
    expect(problems.join(" ")).not.toContain("secret-host");
  });
});

describe("instrumentation register", () => {
  it("exits with code 1 when production validation fails on the node runtime", async () => {
    applyProcessEnv({
      ...BASE_ENV,
      RAZORPAY_KEY_SECRET: undefined,
      NEXT_RUNTIME: "nodejs",
    });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });

    await expect(register()).rejects.toThrow("exit:1");

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(errorLog).toHaveBeenCalledTimes(1);
    const message = String(errorLog.mock.calls[0][0]);
    expect(message).toContain("RAZORPAY_KEY_SECRET");
    expect(message).not.toContain(BASE_ENV.AUTH_SECRET);
    expect(message).not.toContain(BASE_ENV.DATABASE_URL);
    expect(message).not.toContain(BASE_ENV.RAZORPAY_WEBHOOK_SECRET);
  });

  it("does not exit on the edge runtime, where process.exit is unusable", async () => {
    applyProcessEnv({
      ...BASE_ENV,
      DATABASE_URL: "mysql://user:pass@localhost:3306/vendary",
      NEXT_RUNTIME: "edge",
    });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });

    await expect(register()).rejects.toThrow(/DATABASE_URL/);

    expect(exit).not.toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalledTimes(1);
    const message = String(errorLog.mock.calls[0][0]);
    expect(message).toContain("DATABASE_URL");
    expect(message).not.toContain("user:pass");
  });

  it("skips validation during next build (phase-production-build)", async () => {
    applyProcessEnv({ NODE_ENV: "production", NEXT_PHASE: "phase-production-build" });

    await expect(register()).resolves.toBeUndefined();
  });

  it("skips validation when SKIP_ENV_VALIDATION=1", async () => {
    applyProcessEnv({ NODE_ENV: "production", SKIP_ENV_VALIDATION: "1" });

    await expect(register()).resolves.toBeUndefined();
  });

  it("warns about missing keys in development without throwing", async () => {
    applyProcessEnv({ NODE_ENV: "development" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(register()).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0][0]);
    expect(message).toContain("RAZORPAY_KEY_SECRET");
    expect(message).not.toContain(BASE_ENV.AUTH_SECRET);
  });

  it("does not warn in production when the environment is valid", async () => {
    applyProcessEnv(BASE_ENV);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(register()).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });
});

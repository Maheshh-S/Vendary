import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

// The guards call NextAuth's `auth()`; the real module pulls in Prisma and the
// Next runtime, neither of which exists in unit tests. `server-only` is a
// build-time marker that throws outside a React Server Component.
const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }));

vi.mock("@/auth", () => ({ auth: authMock }));
vi.mock("server-only", () => ({}));

import type { ActionErrorCode } from "@/lib/action-result";
import { AppError } from "@/lib/errors";
import { runAction } from "@/lib/run-action";
import { requireAdmin, requireUser } from "@/lib/auth-guards";
import { parseInput } from "@/lib/validation";

const USER_SESSION = {
  user: { id: "user_1", role: "USER", email: "user@example.com" },
};
const ADMIN_SESSION = {
  user: { id: "admin_1", role: "ADMIN", email: "admin@example.com" },
};

/** Asserts a promise rejects with a specific AppError, and returns it. */
const expectAppError = async (
  promise: Promise<unknown>,
  code: ActionErrorCode,
  message: string
): Promise<AppError> => {
  const error = await promise.then(
    () => {
      throw new Error("Expected the promise to reject");
    },
    (reason: unknown) => reason
  );
  expect(error).toBeInstanceOf(AppError);
  expect(error).toBeInstanceOf(Error);
  expect((error as AppError).code).toBe(code);
  expect((error as AppError).userMessage).toBe(message);
  return error as AppError;
};

describe("AppError", () => {
  it("preserves the code, user message, field errors, and cause", () => {
    const cause = new Error("database unavailable");
    const fieldErrors = { email: ["Enter a valid email"] };
    const error = new AppError(
      "VALIDATION",
      "Please check the highlighted fields.",
      fieldErrors,
      cause
    );

    expect(error.name).toBe("AppError");
    expect(error.message).toBe("Please check the highlighted fields.");
    expect(error.userMessage).toBe("Please check the highlighted fields.");
    expect(error.code).toBe("VALIDATION");
    expect(error.fieldErrors).toEqual(fieldErrors);
    expect(error.cause).toBe(cause);
  });
});

describe("runAction", () => {
  it("returns the data of a successful action", async () => {
    await expect(runAction("test.ok", async () => ({ id: 1 }))).resolves.toEqual({
      ok: true,
      data: { id: 1 },
    });
  });

  it("maps an AppError to its code, message, and field errors", async () => {
    const fieldErrors = { email: ["Enter a valid email"] };
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await runAction("test.app-error", async () => {
        throw new AppError("VALIDATION", "Please check the highlighted fields.", fieldErrors);
      });

      expect(result).toEqual({
        ok: false,
        code: "VALIDATION",
        message: "Please check the highlighted fields.",
        fieldErrors,
      });
      // Expected rejections are user-facing, not operational failures.
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it("masks unknown errors and logs a reference id without the payload", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await runAction("orders.place", async () => {
        throw new Error("database unavailable");
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.code).toBe("INTERNAL");
      const match = /^Something went wrong\. Reference: ([0-9a-f-]{36})$/.exec(result.message);
      expect(match).not.toBeNull();

      expect(log).toHaveBeenCalledTimes(1);
      const entry = JSON.parse(String(log.mock.calls[0][0]));
      expect(entry).toMatchObject({
        level: "error",
        action: "orders.place",
        requestId: match?.[1],
        error: "database unavailable",
      });
      expect(result).not.toHaveProperty("fieldErrors");
    } finally {
      log.mockRestore();
    }
  });

  it("masks thrown non-Error values too", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await runAction("test.throw-string", async () => {
        throw "boom";
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("INTERNAL");
      expect(JSON.parse(String(log.mock.calls[0][0])).error).toBe("boom");
    } finally {
      log.mockRestore();
    }
  });

  it("rethrows a Next redirect error untouched", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const redirectError = Object.assign(new Error("NEXT_REDIRECT"), {
        digest: "NEXT_REDIRECT;replace;/my-orders;307;",
      });

      await expect(
        runAction("orders.place", async () => {
          throw redirectError;
        })
      ).rejects.toBe(redirectError);
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it("rethrows a Next not-found error untouched", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const notFoundError = Object.assign(new Error("NEXT_NOT_FOUND"), {
        digest: "NEXT_NOT_FOUND",
      });

      await expect(
        runAction("orders.get", async () => {
          throw notFoundError;
        })
      ).rejects.toBe(notFoundError);
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it.each([
    { label: "an unrelated digest", digest: "abc123" },
    { label: "a non-string digest", digest: 42 },
  ])("still masks an error with $label as INTERNAL", async ({ digest }) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await runAction("test.odd-digest", async () => {
        throw Object.assign(new Error("unexpected"), { digest });
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("INTERNAL");
      expect(log).toHaveBeenCalledTimes(1);
    } finally {
      log.mockRestore();
    }
  });
});

describe("requireUser", () => {
  beforeEach(() => {
    authMock.mockReset();
  });

  it("rejects unauthenticated callers with UNAUTHORIZED", async () => {
    authMock.mockResolvedValue(null);
    await expectAppError(requireUser(), "UNAUTHORIZED", "Please sign in to continue.");
  });

  it("rejects sessions without a user id", async () => {
    authMock.mockResolvedValue({ user: { role: "USER" } });
    await expectAppError(requireUser(), "UNAUTHORIZED", "Please sign in to continue.");
  });

  it("returns the session for an authenticated caller", async () => {
    authMock.mockResolvedValue(USER_SESSION);
    await expect(requireUser()).resolves.toBe(USER_SESSION);
  });
});

describe("requireAdmin", () => {
  beforeEach(() => {
    authMock.mockReset();
  });

  it("rejects unauthenticated callers (via requireUser)", async () => {
    authMock.mockResolvedValue(null);
    await expectAppError(requireAdmin(), "UNAUTHORIZED", "Please sign in to continue.");
  });

  it("rejects authenticated non-admin callers with FORBIDDEN", async () => {
    authMock.mockResolvedValue(USER_SESSION);
    await expectAppError(requireAdmin(), "FORBIDDEN", "You do not have permission to do that.");
  });

  it("returns the session for an ADMIN caller", async () => {
    authMock.mockResolvedValue(ADMIN_SESSION);
    await expect(requireAdmin()).resolves.toBe(ADMIN_SESSION);
  });
});

describe("parseInput", () => {
  const schema = z.object({
    email: z.string().email("Enter a valid email"),
    name: z.string().optional(),
  });

  it("returns parsed (transformed) data", () => {
    const parsed = parseInput(z.object({ email: z.string().trim().toLowerCase() }), {
      email: "  User@Example.com ",
    });

    expect(parsed).toEqual({ email: "user@example.com" });
  });

  it("throws a VALIDATION AppError with flattened field errors", () => {
    let caught: unknown;
    try {
      parseInput(schema, { email: "not-an-email" });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AppError);
    const error = caught as AppError;
    expect(error.code).toBe("VALIDATION");
    expect(error.message).toBe("Please check the highlighted fields.");
    expect(error.fieldErrors?.email).toContain("Enter a valid email");
    expect(error.fieldErrors).not.toHaveProperty("_errors");
    expect(error.fieldErrors).not.toHaveProperty("_form");
  });

  it("surfaces root-level refine errors under the _form key", () => {
    const passwordSchema = z
      .object({ password: z.string(), confirm: z.string() })
      .refine((value) => value.password === value.confirm, {
        message: "Passwords do not match",
      });

    let caught: unknown;
    try {
      parseInput(passwordSchema, { password: "secret", confirm: "other" });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AppError);
    const error = caught as AppError;
    expect(error.code).toBe("VALIDATION");
    expect(error.message).toBe("Please check the highlighted fields.");
    expect(error.fieldErrors?._form).toContain("Passwords do not match");
  });
});

describe("lib/action-result.ts", () => {
  it("is client-safe: it has no runtime imports", () => {
    const source = readFileSync(path.join(process.cwd(), "lib", "action-result.ts"), "utf8");
    expect(source).not.toMatch(/^\s*import\b/m);
  });
});

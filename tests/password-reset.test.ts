import bcrypt from "bcryptjs";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Password reset (Task 2.1).
 *
 * The real action, schemas, validation and token lookup run; Prisma, the mail
 * transport, token generation, the rate limiter and request keys are mocked.
 * The in-memory token store lets the one-time delete be exercised for real.
 */

const { prismaMock, txMock, mailMock, generateMock, rateLimitMock, clientKeyMock } = vi.hoisted(
  () => {
    const txMock = {
      passwordResetToken: { deleteMany: vi.fn() },
      user: { update: vi.fn() },
    };
    const prismaMock = {
      user: { findUnique: vi.fn() },
      passwordResetToken: { findUnique: vi.fn(), findFirst: vi.fn() },
      $transaction: vi.fn(),
    };
    return {
      prismaMock,
      txMock,
      mailMock: vi.fn(),
      generateMock: vi.fn(),
      rateLimitMock: vi.fn(),
      clientKeyMock: vi.fn(),
    };
  }
);

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/lib/mail", () => ({ sendPasswordResetEmail: mailMock }));
vi.mock("@/lib/token", () => ({ generatePasswordResetToken: generateMock }));
vi.mock("@/lib/rate-limit", () => ({
  enforceRateLimit: rateLimitMock,
  RATE_LIMITS: {
    passwordResetEmail: { limit: 3, windowMs: 3_600_000 },
    passwordResetIp: { limit: 10, windowMs: 3_600_000 },
  },
}));
vi.mock("@/lib/request-key", () => ({ clientKey: clientKeyMock }));

import { requestPasswordReset, resetPassword } from "@/actions/auth/password-reset";
import { getPasswordResetTokenByEmail, getPasswordResetTokenByToken } from "@/actions/token";
import type { ActionErrorCode, ActionResult } from "@/lib/action-result";
import { PASSWORD_RESET_REQUEST_MESSAGE } from "@/schemas/auth/password-reset-schema";

type TokenRow = {
  id: string;
  email: string;
  token: string;
  expires: Date;
};

let tokenRows: TokenRow[];

const expectFailure = (
  result: ActionResult<unknown>,
  code: ActionErrorCode,
  message?: string | RegExp
): void => {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.code).toBe(code);
  if (typeof message === "string") expect(result.message).toBe(message);
  if (message instanceof RegExp) expect(result.message).toMatch(message);
};

const expectSuccess = <T>(result: ActionResult<T>): T => {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(`Expected success, got ${result.code}: ${result.message}`);
  }
  return result.data;
};

const TOKEN: TokenRow = {
  id: "reset_1",
  email: "buyer@example.com",
  token: "token-abc",
  expires: new Date(Date.now() + 60 * 60_000),
};

beforeEach(() => {
  vi.clearAllMocks();
  tokenRows = [{ ...TOKEN }];

  clientKeyMock.mockResolvedValue("203.0.113.7");
  generateMock.mockResolvedValue({
    id: "reset_2",
    email: TOKEN.email,
    token: "new-token",
    expires: new Date(Date.now() + 60 * 60_000),
  });
  mailMock.mockResolvedValue({ status: "sent" });

  prismaMock.user.findUnique.mockResolvedValue({
    id: "user_1",
    email: TOKEN.email,
    password: "$2a$10$existinghash",
  });
  prismaMock.passwordResetToken.findUnique.mockImplementation(
    async (args: { where: { token: string } }) =>
      tokenRows.find((row) => row.token === args.where.token) ?? null
  );
  prismaMock.passwordResetToken.findFirst.mockImplementation(
    async (args: { where: { email: string } }) =>
      tokenRows.find((row) => row.email === args.where.email) ?? null
  );
  prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof txMock) => unknown) =>
    callback(txMock)
  );
  txMock.user.update.mockResolvedValue({ id: "user_1" });
  txMock.passwordResetToken.deleteMany.mockImplementation(
    async (args: { where: { id?: string; email?: string } }) => {
      const before = tokenRows.length;
      tokenRows = tokenRows.filter((row) => {
        if (args.where.id !== undefined) return row.id !== args.where.id;
        if (args.where.email !== undefined) return row.email !== args.where.email;
        return true;
      });
      return { count: before - tokenRows.length };
    }
  );

  // Mirrors the real fixed-window limiter: every hit counts, over-limit throws
  // the same AppError the production helper throws.
  const counts = new Map<string, number>();
  rateLimitMock.mockImplementation(
    async (options: { bucket: string; subject: string; limit: number }) => {
      const key = `${options.bucket}:${options.subject}`;
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      if (count > options.limit) {
        const { AppError } = await import("@/lib/errors");
        throw new AppError("RATE_LIMITED", "Too many attempts. Please try again later.");
      }
    }
  );
});

describe("password reset token lookup", () => {
  it("looks a reset token up by email, not by token value", async () => {
    const found = await getPasswordResetTokenByEmail(TOKEN.email);

    expect(found).toMatchObject({ id: TOKEN.id });
    expect(prismaMock.passwordResetToken.findFirst).toHaveBeenCalledWith({
      where: { email: TOKEN.email },
    });
  });

  it("looks a reset token up by its token value", async () => {
    const found = await getPasswordResetTokenByToken(TOKEN.token);

    expect(found).toMatchObject({ id: TOKEN.id });
    expect(prismaMock.passwordResetToken.findUnique).toHaveBeenCalledWith({
      where: { token: TOKEN.token },
    });
  });
});

describe("requestPasswordReset", () => {
  it("returns the same generic message for an unknown email and sends nothing", async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);

    const result = await requestPasswordReset("  Nobody@Example.com ");

    expect(expectSuccess(result)).toEqual({ message: PASSWORD_RESET_REQUEST_MESSAGE });
    expect(prismaMock.user.findUnique).toHaveBeenCalledWith({
      where: { email: "nobody@example.com" },
      select: { id: true, email: true, password: true },
    });
    expect(generateMock).not.toHaveBeenCalled();
    expect(mailMock).not.toHaveBeenCalled();
  });

  it("returns the same generic message for a passwordless (OAuth-only) account", async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      id: "user_1",
      email: TOKEN.email,
      password: null,
    });

    expect(expectSuccess(await requestPasswordReset(TOKEN.email))).toEqual({
      message: PASSWORD_RESET_REQUEST_MESSAGE,
    });
    expect(generateMock).not.toHaveBeenCalled();
    expect(mailMock).not.toHaveBeenCalled();
  });

  it("generates one token and sends the link for a known account", async () => {
    const result = await requestPasswordReset(TOKEN.email);

    expect(expectSuccess(result)).toEqual({ message: PASSWORD_RESET_REQUEST_MESSAGE });
    expect(generateMock).toHaveBeenCalledTimes(1);
    expect(generateMock).toHaveBeenCalledWith(TOKEN.email);
    expect(mailMock).toHaveBeenCalledWith(TOKEN.email, "new-token");
  });

  it("still returns the generic message when mail is unconfigured", async () => {
    mailMock.mockResolvedValue({ status: "skipped", reason: "not_configured" });

    expect(expectSuccess(await requestPasswordReset(TOKEN.email))).toEqual({
      message: PASSWORD_RESET_REQUEST_MESSAGE,
    });
  });

  it("counts the IP budget before per-address and rejects invalid emails first", async () => {
    expectFailure(await requestPasswordReset("not-an-email"), "VALIDATION");
    expect(rateLimitMock).not.toHaveBeenCalled();

    await requestPasswordReset(TOKEN.email);
    expect(rateLimitMock).toHaveBeenNthCalledWith(1, {
      bucket: "passwordResetIp",
      subject: "203.0.113.7",
      limit: 10,
      windowMs: 3_600_000,
    });
    expect(rateLimitMock).toHaveBeenNthCalledWith(2, {
      bucket: "passwordResetEmail",
      subject: TOKEN.email,
      limit: 3,
      windowMs: 3_600_000,
    });
  });

  it("allows three requests per address per hour and rejects the fourth", async () => {
    for (let i = 0; i < 3; i += 1) {
      expectSuccess(await requestPasswordReset(TOKEN.email));
    }

    expectFailure(await requestPasswordReset(TOKEN.email), "RATE_LIMITED");
    expect(generateMock).toHaveBeenCalledTimes(3);
    expect(mailMock).toHaveBeenCalledTimes(3);
  });

  it("rejects the eleventh address from one IP within the hour", async () => {
    for (let i = 0; i < 10; i += 1) {
      expectSuccess(await requestPasswordReset(`person${i}@example.com`));
    }

    expectFailure(await requestPasswordReset("person10@example.com"), "RATE_LIMITED");
    expect(generateMock).toHaveBeenCalledTimes(10);
  });
});

describe("resetPassword", () => {
  it("rejects an expired token without changing the password", async () => {
    tokenRows[0] = { ...TOKEN, expires: new Date(Date.now() - 1000) };

    expectFailure(
      await resetPassword(TOKEN.token, "new-password-1"),
      "VALIDATION",
      /invalid or has expired/i
    );
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(txMock.user.update).not.toHaveBeenCalled();
  });

  it("rejects an unknown or already used token", async () => {
    expectFailure(
      await resetPassword("missing-token", "new-password-1"),
      "VALIDATION",
      /invalid or has expired/i
    );
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("updates the bcrypt hash and consumes the token exactly once", async () => {
    const first = await resetPassword(TOKEN.token, "new-password-1");
    expect(expectSuccess(first)).toEqual({ reset: true });

    const updateArgs = txMock.user.update.mock.calls[0][0] as {
      where: { id: string };
      data: { password: string };
    };
    expect(updateArgs.where).toEqual({ id: "user_1" });
    expect(updateArgs.data.password).not.toBe("new-password-1");
    expect(await bcrypt.compare("new-password-1", updateArgs.data.password)).toBe(true);
    expect(tokenRows).toHaveLength(0);

    // The same link cannot be replayed.
    expectFailure(
      await resetPassword(TOKEN.token, "another-password-2"),
      "VALIDATION",
      /invalid or has expired/i
    );
    expect(txMock.user.update).toHaveBeenCalledTimes(1);
  });

  it("lets only one of two concurrent submissions claim the token", async () => {
    txMock.passwordResetToken.deleteMany.mockResolvedValueOnce({ count: 0 });

    expectFailure(
      await resetPassword(TOKEN.token, "new-password-1"),
      "VALIDATION",
      /invalid or has expired/i
    );
    expect(txMock.user.update).not.toHaveBeenCalled();
  });

  it("validates the new password before touching the token store", async () => {
    expectFailure(await resetPassword(TOKEN.token, "short"), "VALIDATION");
    expectFailure(await resetPassword(TOKEN.token, "x".repeat(73)), "VALIDATION");
    expect(prismaMock.passwordResetToken.findUnique).not.toHaveBeenCalled();
  });

  it("rejects a valid token whose account no longer exists", async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);

    expectFailure(
      await resetPassword(TOKEN.token, "new-password-1"),
      "VALIDATION",
      /invalid or has expired/i
    );
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });
});

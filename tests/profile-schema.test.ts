import bcrypt from "bcryptjs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Profile and password change (Task 2.3). Schemas run for real; auth, Prisma,
 * revalidation and `server-only` are mocked, while bcrypt hashes for real so a
 * wrong current password is rejected by the actual comparison.
 */

const { authMock, prismaMock, revalidateMock } = vi.hoisted(() => {
  const prismaMock = {
    user: { findUnique: vi.fn(), update: vi.fn() },
    passwordResetToken: { deleteMany: vi.fn() },
    $transaction: vi.fn(),
  };
  return { authMock: vi.fn(), prismaMock, revalidateMock: vi.fn() };
});

vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: authMock }));
vi.mock("@/lib/db/prisma", () => ({ prisma: prismaMock }));
vi.mock("next/cache", () => ({ revalidatePath: revalidateMock }));

import { changePassword, updateProfile } from "@/actions/account/profile";
import type { ActionErrorCode, ActionResult } from "@/lib/action-result";
import { ChangePasswordSchema, ProfileSchema } from "@/schemas/account/profile-schema";

const USER_ID = "user_1";
const OLD_PASSWORD = "OldPassword1";

let oldHash = "";

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

const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => {});

beforeAll(async () => {
  oldHash = await bcrypt.hash(OLD_PASSWORD, 10);
});

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: USER_ID, role: "USER" } });
  revalidateMock.mockReturnValue(undefined);
  prismaMock.user.findUnique.mockResolvedValue({
    id: USER_ID,
    email: "buyer@example.com",
    password: oldHash,
  });
  prismaMock.user.update.mockResolvedValue({
    id: USER_ID,
    firstName: "Asha",
    lastName: "Rao",
    profilePic: null,
  });
  prismaMock.passwordResetToken.deleteMany.mockResolvedValue({ count: 1 });
  prismaMock.$transaction.mockResolvedValue([]);
});

afterAll(() => {
  consoleInfo.mockRestore();
});

describe("ProfileSchema", () => {
  const VALID = {
    firstName: "Asha",
    lastName: "Rao",
    avatarUrl: "https://images.unsplash.com/photo-123",
  };

  it("trims names and accepts an allowlisted avatar", () => {
    const parsed = ProfileSchema.parse({
      ...VALID,
      firstName: "  Asha ",
      lastName: " Rao  ",
    });
    expect(parsed.firstName).toBe("Asha");
    expect(parsed.lastName).toBe("Rao");
    expect(parsed.avatarUrl).toBe(VALID.avatarUrl);
  });

  it("enforces 1–60 characters on both names", () => {
    expect(ProfileSchema.safeParse({ ...VALID, firstName: "" }).success).toBe(false);
    expect(ProfileSchema.safeParse({ ...VALID, firstName: "a".repeat(60) }).success).toBe(true);
    expect(ProfileSchema.safeParse({ ...VALID, firstName: "a".repeat(61) }).success).toBe(false);
    expect(ProfileSchema.safeParse({ ...VALID, lastName: "" }).success).toBe(false);
    expect(ProfileSchema.safeParse({ ...VALID, lastName: "a".repeat(61) }).success).toBe(false);
  });

  it("allows clearing the avatar with a blank string", () => {
    expect(ProfileSchema.parse({ ...VALID, avatarUrl: "   " }).avatarUrl).toBeUndefined();
    expect(ProfileSchema.parse({ firstName: "A", lastName: "B" }).avatarUrl).toBeUndefined();
  });

  it.each([
    ["unknown host", "https://evil.example.com/a.png"],
    ["http remote", "http://images.unsplash.com/a.png"],
    ["javascript URL", "javascript:alert(1)"],
    ["not a URL", "not-a-url"],
  ])("rejects a %s avatar", (_label, avatarUrl) => {
    expect(ProfileSchema.safeParse({ ...VALID, avatarUrl }).success).toBe(false);
  });
});

describe("ChangePasswordSchema", () => {
  it("accepts passwords on both length boundaries", () => {
    expect(
      ChangePasswordSchema.safeParse({ currentPassword: "x", newPassword: "a".repeat(8) }).success
    ).toBe(true);
    expect(
      ChangePasswordSchema.safeParse({ currentPassword: "x", newPassword: "a".repeat(72) }).success
    ).toBe(true);
  });

  it("rejects short, oversized and missing passwords", () => {
    expect(
      ChangePasswordSchema.safeParse({ currentPassword: "x", newPassword: "a".repeat(7) }).success
    ).toBe(false);
    expect(
      ChangePasswordSchema.safeParse({ currentPassword: "x", newPassword: "a".repeat(73) }).success
    ).toBe(false);
    expect(
      ChangePasswordSchema.safeParse({ currentPassword: "", newPassword: "abcdefgh" }).success
    ).toBe(false);
  });
});

describe("changePassword", () => {
  it("rejects unauthenticated callers before querying", async () => {
    authMock.mockResolvedValue(null);

    expectFailure(
      await changePassword({ currentPassword: OLD_PASSWORD, newPassword: "NewPassword2" }),
      "UNAUTHORIZED"
    );
    expect(prismaMock.user.findUnique).not.toHaveBeenCalled();
  });

  it("rejects a wrong current password without updating anything", async () => {
    const result = await changePassword({
      currentPassword: "WrongPassword1",
      newPassword: "NewPassword2",
    });

    expectFailure(result, "VALIDATION", "Current password is incorrect.");
    if (!result.ok) {
      expect(result.fieldErrors?.currentPassword).toEqual(["Current password is incorrect."]);
    }
    expect(prismaMock.user.update).not.toHaveBeenCalled();
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("rejects reusing the current password", async () => {
    const result = await changePassword({
      currentPassword: OLD_PASSWORD,
      newPassword: OLD_PASSWORD,
    });

    expectFailure(result, "VALIDATION", /must be different/i);
    if (!result.ok) {
      expect(result.fieldErrors?.newPassword?.[0]).toMatch(/must be different/i);
    }
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  it("stores a bcrypt hash of the new password and clears reset tokens", async () => {
    const result = await changePassword({
      currentPassword: OLD_PASSWORD,
      newPassword: "NewPassword2",
    });

    expect(result).toEqual({ ok: true, data: { changed: true } });
    const updateArgs = prismaMock.user.update.mock.calls[0][0] as {
      where: { id: string };
      data: { password: string };
    };
    expect(updateArgs.where).toEqual({ id: USER_ID });
    expect(updateArgs.data.password).not.toBe("NewPassword2");
    expect(await bcrypt.compare("NewPassword2", updateArgs.data.password)).toBe(true);
    expect(prismaMock.passwordResetToken.deleteMany).toHaveBeenCalledWith({
      where: { email: "buyer@example.com" },
    });
    expect(revalidateMock).toHaveBeenCalledWith("/account");

    const log = consoleInfo.mock.calls.map((call) => String(call[0])).join("\n");
    expect(log).toContain("account_password_changed");
    expect(log).not.toContain("buyer@example.com");
    expect(log).not.toContain(OLD_PASSWORD);
  });

  it("refuses password change for a passwordless account", async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      id: USER_ID,
      email: "buyer@example.com",
      password: null,
    });

    expectFailure(
      await changePassword({ currentPassword: "anything", newPassword: "NewPassword2" }),
      "VALIDATION",
      /not enabled/i
    );
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });
});

describe("updateProfile", () => {
  it("writes first/last name, combined name and avatar fields", async () => {
    const result = await updateProfile({
      firstName: "  Asha ",
      lastName: "Rao",
      avatarUrl: "https://images.unsplash.com/photo-123",
    });

    expect(result.ok).toBe(true);
    expect(prismaMock.user.update).toHaveBeenCalledWith({
      where: { id: USER_ID },
      data: {
        firstName: "Asha",
        lastName: "Rao",
        name: "Asha Rao",
        profilePic: "https://images.unsplash.com/photo-123",
        image: "https://images.unsplash.com/photo-123",
      },
      select: { id: true, firstName: true, lastName: true, profilePic: true },
    });
    expect(revalidateMock).toHaveBeenCalledWith("/account");

    // The audit line identifies the user but never the address or the values.
    const log = consoleInfo.mock.calls.map((call) => String(call[0])).join("\n");
    expect(log).toContain("account_profile_updated");
    expect(log).toContain(USER_ID);
    expect(log).not.toContain("Asha");
  });

  it("clears the avatar when the URL is blank", async () => {
    await updateProfile({ firstName: "Asha", lastName: "Rao", avatarUrl: "" });

    const updateArgs = prismaMock.user.update.mock.calls[0][0] as {
      data: { profilePic: string | null; image: string | null };
    };
    expect(updateArgs.data.profilePic).toBeNull();
    expect(updateArgs.data.image).toBeNull();
  });

  it("rejects a non-allowlisted avatar before writing", async () => {
    expectFailure(
      await updateProfile({
        firstName: "Asha",
        lastName: "Rao",
        avatarUrl: "https://evil.example.com/a.png",
      }),
      "VALIDATION"
    );
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });
});

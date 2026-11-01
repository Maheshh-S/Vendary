import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Password-reset token rotation (fix round 1). The real generator runs; only
 * Prisma is mocked, so the test pins that the delete and the insert happen in
 * one `$transaction` and by email (not by token value).
 */

const { prismaMock, txMock } = vi.hoisted(() => {
  const txMock = {
    passwordResetToken: { deleteMany: vi.fn(), create: vi.fn() },
  };
  const prismaMock = { $transaction: vi.fn() };
  return { prismaMock, txMock };
});

vi.mock("@/lib/db/prisma", () => ({ prisma: prismaMock }));

import { generatePasswordResetToken } from "@/lib/token";

const EMAIL = "buyer@example.com";

beforeEach(() => {
  vi.clearAllMocks();
  txMock.passwordResetToken.deleteMany.mockResolvedValue({ count: 2 });
  txMock.passwordResetToken.create.mockImplementation(
    async (args: { data: Record<string, unknown> }) => ({ id: "reset_new", ...args.data })
  );
  prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof txMock) => unknown) =>
    callback(txMock)
  );
});

describe("generatePasswordResetToken", () => {
  it("rotates the email's tokens inside a single transaction", async () => {
    const created = await generatePasswordResetToken(EMAIL);

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(txMock.passwordResetToken.deleteMany).toHaveBeenCalledTimes(1);
    expect(txMock.passwordResetToken.deleteMany).toHaveBeenCalledWith({
      where: { email: EMAIL },
    });
    expect(txMock.passwordResetToken.create).toHaveBeenCalledTimes(1);
    expect(txMock.passwordResetToken.create).toHaveBeenCalledWith({
      data: {
        email: EMAIL,
        token: expect.any(String),
        expires: expect.any(Date),
      },
    });

    // The delete must be ordered before the insert within the transaction.
    expect(txMock.passwordResetToken.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(
      txMock.passwordResetToken.create.mock.invocationCallOrder[0]
    );
    expect(created).toMatchObject({ email: EMAIL, id: "reset_new" });
  });

  it("propagates a failed insert so the transaction rolls back the delete", async () => {
    txMock.passwordResetToken.create.mockRejectedValue(new Error("insert failed"));

    await expect(generatePasswordResetToken(EMAIL)).rejects.toThrow("insert failed");
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
  });
});

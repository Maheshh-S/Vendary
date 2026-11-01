import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Address-book ownership and default handling (Task 2.2). Auth, Prisma and
 * revalidation are mocked; the schemas, `runAction` and `parseInput` run for
 * real so the exact user-scoped predicates and transaction calls are pinned.
 */

const { authMock, prismaMock, txMock, revalidateMock } = vi.hoisted(() => {
  const txMock = {
    savedAddress: {
      count: vi.fn(),
      findFirst: vi.fn(),
      updateMany: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
    },
  };
  const prismaMock = {
    savedAddress: { findMany: vi.fn(), deleteMany: vi.fn() },
    $transaction: vi.fn(),
  };
  return { authMock: vi.fn(), prismaMock, txMock, revalidateMock: vi.fn() };
});

vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: authMock }));
vi.mock("@/lib/db/prisma", () => ({ prisma: prismaMock }));
vi.mock("next/cache", () => ({ revalidatePath: revalidateMock }));

import {
  createAddress,
  deleteAddress,
  listAddresses,
  setDefaultAddress,
  updateAddress,
} from "@/actions/account/addresses";
import type { ActionErrorCode, ActionResult } from "@/lib/action-result";

const USER_ID = "user_1";
const ADDRESS_ID = "addr_1";

const INPUT = {
  label: "Home",
  firstName: "Asha",
  lastName: "Rao",
  phone: "9876543210",
  line1: "12 MG Road, Apartment 4B",
  area: "Indiranagar",
  state: "Karnataka",
  postalCode: "560038",
  country: "India",
  isDefault: false,
};

const ROW = {
  id: ADDRESS_ID,
  userId: USER_ID,
  ...INPUT,
  line2: null,
  landmark: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

const expectSuccess = <T>(result: ActionResult<T>): T => {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`Expected success, got ${result.code}: ${result.message}`);
  return result.data;
};

const expectFailure = (result: ActionResult<unknown>, code: ActionErrorCode): void => {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.code).toBe(code);
};

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: USER_ID, role: "USER" } });
  revalidateMock.mockReturnValue(undefined);
  prismaMock.$transaction.mockImplementation(
    async (callback: (tx: typeof txMock) => unknown) => callback(txMock)
  );
  prismaMock.savedAddress.findMany.mockResolvedValue([ROW]);
  prismaMock.savedAddress.deleteMany.mockResolvedValue({ count: 1 });
  txMock.savedAddress.count.mockResolvedValue(0);
  txMock.savedAddress.findFirst.mockResolvedValue({ id: ADDRESS_ID });
  txMock.savedAddress.updateMany.mockResolvedValue({ count: 1 });
  txMock.savedAddress.update.mockResolvedValue(ROW);
  txMock.savedAddress.create.mockResolvedValue(ROW);
});

describe("address ownership", () => {
  it("rejects unauthenticated callers before any query", async () => {
    authMock.mockResolvedValue(null);

    expectFailure(await listAddresses(), "UNAUTHORIZED");
    expectFailure(await createAddress(INPUT), "UNAUTHORIZED");
    expectFailure(await deleteAddress(ADDRESS_ID), "UNAUTHORIZED");
    expect(prismaMock.savedAddress.findMany).not.toHaveBeenCalled();
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("lists only the session user's addresses with defaults first", async () => {
    expectSuccess(await listAddresses());

    expect(prismaMock.savedAddress.findMany).toHaveBeenCalledWith({
      where: { userId: USER_ID },
      orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }],
    });
  });

  it("scopes updates and deletes to the session user", async () => {
    expectSuccess(await updateAddress({ ...INPUT, id: ADDRESS_ID }));
    expect(txMock.savedAddress.findFirst).toHaveBeenCalledWith({
      where: { id: ADDRESS_ID, userId: USER_ID },
      select: { id: true },
    });

    expectSuccess(await deleteAddress(ADDRESS_ID));
    expect(prismaMock.savedAddress.deleteMany).toHaveBeenCalledWith({
      where: { id: ADDRESS_ID, userId: USER_ID },
    });
  });

  it("returns NOT_FOUND for a foreign or missing address", async () => {
    txMock.savedAddress.findFirst.mockResolvedValue(null);
    expectFailure(await updateAddress({ ...INPUT, id: ADDRESS_ID }), "NOT_FOUND");
    expect(txMock.savedAddress.update).not.toHaveBeenCalled();

    expectFailure(await setDefaultAddress(ADDRESS_ID), "NOT_FOUND");
    expect(txMock.savedAddress.updateMany).not.toHaveBeenCalled();

    prismaMock.savedAddress.deleteMany.mockResolvedValue({ count: 0 });
    expectFailure(await deleteAddress(ADDRESS_ID), "NOT_FOUND");
  });

  it("rejects invalid ids before querying", async () => {
    expectFailure(await deleteAddress(""), "VALIDATION");
    expectFailure(await deleteAddress("a".repeat(65)), "VALIDATION");
    expect(prismaMock.savedAddress.deleteMany).not.toHaveBeenCalled();
  });
});

describe("default address handling", () => {
  it("makes the first address the default automatically", async () => {
    expectSuccess(await createAddress(INPUT));

    expect(txMock.savedAddress.updateMany).toHaveBeenCalledWith({
      where: { userId: USER_ID, isDefault: true },
      data: { isDefault: false },
    });
    expect(txMock.savedAddress.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: USER_ID, isDefault: true, phone: "9876543210" }),
    });
  });

  it("clears the previous default when creating a new default", async () => {
    txMock.savedAddress.count.mockResolvedValue(2);

    expectSuccess(await createAddress({ ...INPUT, isDefault: true }));

    expect(txMock.savedAddress.updateMany).toHaveBeenCalled();
    expect(txMock.savedAddress.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ isDefault: true }),
    });
  });

  it("does not clear defaults for a non-default address", async () => {
    txMock.savedAddress.count.mockResolvedValue(2);

    expectSuccess(await createAddress(INPUT));

    expect(txMock.savedAddress.updateMany).not.toHaveBeenCalled();
    expect(txMock.savedAddress.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ isDefault: false }),
    });
  });

  it("enforces the ten-address cap inside the transaction", async () => {
    txMock.savedAddress.count.mockResolvedValue(10);

    expectFailure(await createAddress(INPUT), "CONFLICT");
    expect(txMock.savedAddress.create).not.toHaveBeenCalled();
  });

  it("clears the other defaults and promotes the requested address", async () => {
    expectSuccess(await setDefaultAddress(ADDRESS_ID));

    expect(txMock.savedAddress.updateMany).toHaveBeenCalledWith({
      where: { userId: USER_ID, isDefault: true, id: { not: ADDRESS_ID } },
      data: { isDefault: false },
    });
    expect(txMock.savedAddress.update).toHaveBeenCalledWith({
      where: { id: ADDRESS_ID },
      data: { isDefault: true },
    });
    expect(revalidateMock).toHaveBeenCalledWith("/account/addresses");
  });

  it("clears other defaults when an update sets isDefault", async () => {
    expectSuccess(await updateAddress({ ...INPUT, id: ADDRESS_ID, isDefault: true }));

    expect(txMock.savedAddress.updateMany).toHaveBeenCalledWith({
      where: { userId: USER_ID, isDefault: true, id: { not: ADDRESS_ID } },
      data: { isDefault: false },
    });
  });
});

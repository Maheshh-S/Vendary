import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Address-book integration (Task 2.6). Runs only with an explicit
 * `TEST_DATABASE_URL`; otherwise the whole suite skips so `npx vitest run`
 * never needs a database. Every row is created with a unique suffix and
 * removed in `afterAll`.
 *
 * Run:
 *   TEST_DATABASE_URL=postgresql://… npx vitest run tests/integration/address-book.test.ts
 */

const testUrl = process.env.TEST_DATABASE_URL?.trim() ?? "";
const hasTestDatabase = testUrl.length > 0;

const prisma = new PrismaClient({
  datasources: {
    db: {
      url: testUrl || "postgresql://invalid:invalid@localhost:5432/invalid",
    },
  },
});

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

let ownerId = "";
let otherId = "";

const addressData = (overrides: Record<string, unknown> = {}) => ({
  firstName: "Asha",
  lastName: "Rao",
  phone: "9876543210",
  line1: "12 MG Road, Apartment 4B",
  line2: null,
  area: "Indiranagar",
  landmark: "Opposite the library",
  state: "Karnataka",
  postalCode: "560038",
  country: "India",
  isDefault: false,
  ...overrides,
});

describe.skipIf(!hasTestDatabase)("saved address book (integration)", () => {
  beforeAll(async () => {
    // Keep the test database schema current; harmless when already applied.
    execFileSync("npx", ["prisma", "migrate", "deploy"], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: testUrl },
      stdio: "ignore",
    });

    const owner = await prisma.user.create({
      data: {
        email: `address-owner-${suffix}@vendary.test`,
        name: "Address Owner",
        role: "USER",
      },
    });
    const other = await prisma.user.create({
      data: {
        email: `address-other-${suffix}@vendary.test`,
        name: "Address Other",
        role: "USER",
      },
    });
    ownerId = owner.id;
    otherId = other.id;
  }, 120_000);

  afterAll(async () => {
    if (!hasTestDatabase) return;

    await prisma.order.deleteMany({
      where: { userId: { in: [ownerId, otherId] } },
    });
    await prisma.savedAddress.deleteMany({
      where: { userId: { in: [ownerId, otherId] } },
    });
    await prisma.address.deleteMany({
      where: { firstName: `IT-${suffix}` },
    });
    await prisma.user.deleteMany({
      where: { id: { in: [ownerId, otherId] } },
    });
    await prisma.$disconnect();
  });

  it("scopes reads and writes to the owning user", async () => {
    const mine = await prisma.savedAddress.create({
      data: { ...addressData(), userId: ownerId },
    });
    const theirs = await prisma.savedAddress.create({
      data: { ...addressData({ firstName: "Other" }), userId: otherId },
    });

    const myBook = await prisma.savedAddress.findMany({
      where: { userId: ownerId },
    });
    expect(myBook.map((row) => row.id)).toEqual([mine.id]);

    // The ownership-scoped lookup the actions use cannot see a foreign row.
    const foreign = await prisma.savedAddress.findFirst({
      where: { id: theirs.id, userId: ownerId },
    });
    expect(foreign).toBeNull();

    // Deleting with both predicates is a no-op for the foreign row.
    const deleted = await prisma.savedAddress.deleteMany({
      where: { id: theirs.id, userId: ownerId },
    });
    expect(deleted.count).toBe(0);
    expect(await prisma.savedAddress.count({ where: { id: theirs.id } })).toBe(1);
  });

  it("keeps exactly one default per user inside a transaction", async () => {
    await prisma.savedAddress.deleteMany({
      where: { userId: ownerId },
    });

    const first = await prisma.savedAddress.create({
      data: { ...addressData({ isDefault: true }), userId: ownerId },
    });
    const second = await prisma.savedAddress.create({
      data: { ...addressData({ label: "Office" }), userId: ownerId },
    });

    await prisma.$transaction(async (tx) => {
      await tx.savedAddress.updateMany({
        where: { userId: ownerId, isDefault: true, id: { not: second.id } },
        data: { isDefault: false },
      });
      await tx.savedAddress.update({
        where: { id: second.id },
        data: { isDefault: true },
      });
    });

    const defaults = await prisma.savedAddress.findMany({
      where: { userId: ownerId, isDefault: true },
    });
    expect(defaults.map((row) => row.id)).toEqual([second.id]);
    expect(first.id).not.toBe(second.id);
  });

  it("never rewrites an order's address snapshot when a saved address is deleted", async () => {
    await prisma.savedAddress.deleteMany({ where: { userId: ownerId } });

    const saved = await prisma.savedAddress.create({
      data: { ...addressData({ isDefault: true }), userId: ownerId },
    });

    const snapshot = await prisma.address.create({
      data: {
        firstName: `IT-${suffix}`,
        lastName: "Owner",
        phone: "9876543210",
        address: "1 Snapshot Street",
        area: "Snapshotville",
        landmark: "Near the snapshot tree",
        postalCode: "560001",
        state: "Karnataka",
        country: "India",
      },
    });
    const order = await prisma.order.create({
      data: {
        userId: ownerId,
        status: "confirmed",
        total: "100.00",
        taxAmount: "8.00",
        addressId: snapshot.id,
        paymentMethod: "RAZORPAY",
        paymentId: "",
        transactionId: `it_address_${suffix}`,
      },
    });

    await prisma.savedAddress.delete({ where: { id: saved.id } });

    const stored = await prisma.order.findUnique({
      where: { id: order.id },
      include: { address: true },
    });
    expect(stored?.address?.address).toBe("1 Snapshot Street");
    expect(await prisma.savedAddress.findUnique({ where: { id: saved.id } })).toBeNull();
  });
});

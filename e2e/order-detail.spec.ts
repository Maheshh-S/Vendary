import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

import { DEMO_ADMIN, login } from "./helpers";
import { isLocalOrCiDatabase, serverEnv } from "./env";

/**
 * Task 1.3 — customer order detail. Fixtures are written directly through
 * Prisma (the same database the app server uses) so the test is deterministic
 * and independent of the Razorpay payment flow. Everything is deleted in
 * afterAll.
 */

const connectionString = serverEnv("DATABASE_URL");
// Fixtures write to the same database the app uses: never touch anything that
// is not a disposable local/CI database.
const fixtureDbSafe = isLocalOrCiDatabase(connectionString);
const prisma = new PrismaClient({
  datasources: {
    db: {
      url: connectionString || "postgresql://invalid:invalid@localhost:5432/invalid",
    },
  },
});

let adminUserId = "";
let foreignUserId = "";
let ownOrderId = "";
let foreignOrderId = "";
const addressIds: string[] = [];

test.describe("customer order detail", () => {
  test.beforeAll(async () => {
    test.skip(
      !connectionString || !fixtureDbSafe,
      "Prisma fixtures only run against a local or CI database"
    );

    const admin = await prisma.user.findUnique({ where: { email: DEMO_ADMIN.email } });
    test.skip(!admin, "Seeded demo admin is missing (run `bunx prisma db seed`)");
    if (!admin) return;
    adminUserId = admin.id;

    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const foreign = await prisma.user.create({
      data: {
        email: `e2e-foreign-${suffix}@vendary.test`,
        name: "E2E Foreign User",
        role: "USER",
      },
    });
    foreignUserId = foreign.id;

    const ownAddress = await prisma.address.create({
      data: {
        firstName: "E2E",
        lastName: "Owner",
        phone: "9876543210",
        address: "1 Test Street",
        area: "Testville",
        landmark: "Near the test tree",
        postalCode: "560001",
        state: "Karnataka",
        country: "India",
      },
    });
    const otherAddress = await prisma.address.create({
      data: {
        firstName: "E2E",
        lastName: "Foreign",
        phone: "9876543211",
        address: "2 Other Street",
        area: "Otherville",
        landmark: "Near the other tree",
        postalCode: "560002",
        state: "Karnataka",
        country: "India",
      },
    });
    addressIds.push(ownAddress.id, otherAddress.id);

    const ownOrder = await prisma.order.create({
      data: {
        userId: adminUserId,
        status: "pending",
        // 1234.00 + 8% GST = 1332.72
        total: "1332.72",
        taxAmount: "98.72",
        addressId: ownAddress.id,
        paymentMethod: "RAZORPAY",
        paymentId: "pay_e2e_secret_1234567890",
        transactionId: `e2e_detail_${suffix}`,
        items: {
          create: [
            {
              // Deleted-product snapshot: must still render from OrderItem.
              productId: null,
              productName: "E2E Snapshot Item",
              productImage: null,
              quantity: 1,
              price: "1234.00",
            },
          ],
        },
      },
    });
    ownOrderId = ownOrder.id;

    const foreignOrder = await prisma.order.create({
      data: {
        userId: foreignUserId,
        status: "confirmed",
        total: "100.00",
        taxAmount: "8.00",
        addressId: otherAddress.id,
        paymentMethod: "RAZORPAY",
        paymentId: "",
        transactionId: `e2e_foreign_${suffix}`,
        items: {
          create: [
            {
              productId: null,
              productName: "Foreign Snapshot Item",
              productImage: null,
              quantity: 1,
              price: "92.59",
            },
          ],
        },
      },
    });
    foreignOrderId = foreignOrder.id;
  });

  test.afterAll(async () => {
    if (!connectionString || !fixtureDbSafe) return;

    await prisma.order.deleteMany({
      where: { id: { in: [ownOrderId, foreignOrderId].filter(Boolean) } },
    });
    await prisma.address.deleteMany({
      where: { id: { in: addressIds } },
    });
    if (foreignUserId) {
      await prisma.user.deleteMany({ where: { id: foreignUserId } });
    }
    await prisma.$disconnect();
  });

  test("shows snapshot items, totals, masked payment id and the timeline", async ({ page }) => {
    await login(page);
    await page.goto(`/my-orders/${ownOrderId}`);

    await expect(page.getByRole("heading", { name: /Order #/ })).toBeVisible();
    await expect(page.getByText("E2E Snapshot Item")).toBeVisible();
    await expect(page.getByText(/1,332\.72/).first()).toBeVisible();
    await expect(page.getByText("Payment pay_e…7890")).toBeVisible();
    // No OrderEvent rows yet: the timeline falls back to "Order placed".
    await expect(page.getByText("Order placed")).toBeVisible();
    await expect(page.getByText("E2E", { exact: false }).first()).toBeVisible();
  });

  test("foreign and missing order ids both 404", async ({ page }) => {
    await login(page);

    const foreignResponse = await page.goto(`/my-orders/${foreignOrderId}`);
    expect(foreignResponse?.status()).toBe(404);
    await expect(page.getByText("Page not found")).toBeVisible();

    const missingResponse = await page.goto(`/my-orders/does-not-exist-${Date.now()}`);
    expect(missingResponse?.status()).toBe(404);
  });
});

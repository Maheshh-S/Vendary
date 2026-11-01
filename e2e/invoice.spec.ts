import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

import { DEMO_ADMIN, login } from "./helpers";
import { isLocalOrCiDatabase, serverEnv } from "./env";

/**
 * Task 2.5 — printable invoice. A confirmed order with deterministic snapshot
 * totals is written through Prisma (local/CI database only); deletion happens
 * in afterAll. Foreign and missing ids must both 404.
 */

const connectionString = serverEnv("DATABASE_URL");
const fixtureDbSafe = isLocalOrCiDatabase(connectionString);
const prisma = new PrismaClient({
  datasources: {
    db: {
      url: connectionString || "postgresql://invalid:invalid@localhost:5432/invalid",
    },
  },
});

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const addressIds: string[] = [];
let foreignUserId = "";
let ownerOrderId = "";
let foreignOrderId = "";
let ownerOrderCreatedAt = new Date();

test.describe("printable invoice", () => {
  test.beforeAll(async () => {
    test.skip(
      !connectionString || !fixtureDbSafe,
      "Prisma fixtures only run against a local or CI database"
    );

    const admin = await prisma.user.findUnique({ where: { email: DEMO_ADMIN.email } });
    test.skip(!admin, "Seeded demo admin is missing (run `bunx prisma db seed`)");
    if (!admin) return;

    const foreign = await prisma.user.create({
      data: {
        email: `e2e-invoice-foreign-${suffix}@vendary.test`,
        name: "Invoice Foreign",
        role: "USER",
      },
    });
    foreignUserId = foreign.id;

    const ownerAddress = await prisma.address.create({
      data: {
        firstName: "Invoice",
        lastName: "Owner",
        phone: "9876543210",
        address: "12 MG Road, Apartment 4B",
        area: "Indiranagar",
        landmark: "Opposite the library",
        postalCode: "560038",
        state: "Karnataka",
        country: "India",
      },
    });
    const foreignAddress = await prisma.address.create({
      data: {
        firstName: "Invoice",
        lastName: "Foreign",
        phone: "9876543211",
        address: "1 Foreign Street",
        area: "Foreignville",
        landmark: "Near the border",
        postalCode: "560001",
        state: "Karnataka",
        country: "India",
      },
    });
    addressIds.push(ownerAddress.id, foreignAddress.id);

    const ownerOrder = await prisma.order.create({
      data: {
        userId: admin.id,
        status: "confirmed",
        // 1234.00 + 99.99 × 2 = 1433.98 subtotal; + 114.72 GST = 1548.70.
        total: "1548.70",
        taxAmount: "114.72",
        addressId: ownerAddress.id,
        paymentMethod: "RAZORPAY",
        paymentId: "pay_e2e_invoice_1234567890",
        transactionId: `e2e_invoice_${suffix}`,
        items: {
          create: [
            {
              productId: null,
              productName: "Invoice Snapshot Item",
              productImage: null,
              quantity: 1,
              price: "1234.00",
            },
            {
              productId: null,
              productName: "Invoice Second Item",
              productImage: null,
              quantity: 2,
              price: "99.99",
            },
          ],
        },
      },
    });
    ownerOrderId = ownerOrder.id;
    ownerOrderCreatedAt = ownerOrder.createdAt;

    const foreignOrder = await prisma.order.create({
      data: {
        userId: foreignUserId,
        status: "confirmed",
        total: "100.00",
        taxAmount: "8.00",
        addressId: foreignAddress.id,
        paymentMethod: "RAZORPAY",
        paymentId: "",
        transactionId: `e2e_invoice_foreign_${suffix}`,
        items: {
          create: [
            {
              productId: null,
              productName: "Foreign Invoice Item",
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
      where: { id: { in: [ownerOrderId, foreignOrderId].filter(Boolean) } },
    });
    await prisma.address.deleteMany({ where: { id: { in: addressIds } } });
    if (foreignUserId) {
      await prisma.user.deleteMany({ where: { id: foreignUserId } });
    }
    await prisma.$disconnect();
  });

  test("renders the owner's invoice with snapshot totals and a print button", async ({ page }) => {
    await login(page);
    await page.goto(`/my-orders/${ownerOrderId}`);

    // The invoice is reachable from the order detail page.
    await page.getByRole("link", { name: "Invoice" }).click();
    await expect(page).toHaveURL(new RegExp(`/my-orders/${ownerOrderId}/invoice$`));

    const expectedNumber = `INV-${new Date(ownerOrderCreatedAt).getFullYear()}-${ownerOrderId.slice(0, 8)}`;
    await expect(page.getByTestId("invoice-number")).toHaveText(expectedNumber);
    await expect(page.getByText("Invoice Snapshot Item")).toBeVisible();
    await expect(page.getByText("Invoice Second Item")).toBeVisible();
    await expect(page.getByTestId("invoice-subtotal")).toContainText("1,433.98");
    await expect(page.getByTestId("invoice-tax")).toContainText("114.72");
    await expect(page.getByTestId("invoice-total")).toContainText("1,548.70");
    await expect(page.getByTestId("print-invoice")).toBeVisible();
    await expect(page.getByText("Invoice Owner")).toBeVisible();
  });

  test("foreign and missing invoice ids both 404", async ({ page }) => {
    await login(page);

    const foreignResponse = await page.goto(`/my-orders/${foreignOrderId}/invoice`);
    expect(foreignResponse?.status()).toBe(404);

    const missingResponse = await page.goto(`/my-orders/missing-${suffix}/invoice`);
    expect(missingResponse?.status()).toBe(404);
  });
});

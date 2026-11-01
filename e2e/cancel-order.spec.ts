import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

import { DEMO_ADMIN, login } from "./helpers";
import { isLocalOrCiDatabase, serverEnv } from "./env";

/**
 * Task 1.8 — customer cancel on a deterministic `pending` order.
 *
 * The order is written directly through Prisma (no Razorpay) so the test only
 * exercises the cancel action, the status transition and the timeline. The
 * local-database guard from `e2e/env.ts` applies; everything is deleted in
 * afterAll.
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

let adminUserId = "";
let orderId = "";
let addressId = "";

test.describe("cancel a pending order", () => {
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
    const address = await prisma.address.create({
      data: {
        firstName: "E2E",
        lastName: "Canceller",
        phone: "9876543210",
        address: "1 Cancel Street",
        area: "Testville",
        landmark: "Near the cancel tree",
        postalCode: "560001",
        state: "Karnataka",
        country: "India",
      },
    });
    addressId = address.id;

    const order = await prisma.order.create({
      data: {
        userId: adminUserId,
        status: "pending",
        // 100.00 + 8% GST = 108.00
        total: "108.00",
        taxAmount: "8.00",
        addressId: address.id,
        paymentMethod: "RAZORPAY",
        // A pending order with no capture: cancelling needs no refund call.
        paymentId: "",
        transactionId: `e2e_cancel_${suffix}`,
        items: {
          create: [
            {
              productId: null,
              productName: "E2E Cancellable Item",
              productImage: null,
              quantity: 1,
              price: "100.00",
            },
          ],
        },
        events: {
          create: [
            {
              type: "order_placed",
              toStatus: "pending",
              actorId: adminUserId,
            },
          ],
        },
      },
    });
    orderId = order.id;
  });

  test.afterAll(async () => {
    if (!connectionString || !fixtureDbSafe) return;

    await prisma.order.deleteMany({ where: { id: orderId } });
    await prisma.address.deleteMany({ where: { id: addressId } });
    await prisma.$disconnect();
  });

  test("cancels the order, shows the new status and the timeline event", async ({ page }) => {
    await login(page);
    await page.goto(`/my-orders/${orderId}`);

    await expect(page.getByRole("heading", { name: /Order #/ })).toBeVisible();
    await expect(page.getByText("E2E Cancellable Item")).toBeVisible();
    // The window.confirm guard asks before the action runs.
    page.on("dialog", (dialog) => void dialog.accept());
    await page.getByRole("button", { name: "Cancel order" }).click();

    await expect(page.getByText("Order cancelled", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("cancelled", { exact: true }).first()).toBeVisible();

    // Persisted: the status moved and the audit event was written.
    const stored = await prisma.order.findUnique({
      where: { id: orderId },
      select: {
        status: true,
        paymentId: true,
        events: { select: { type: true, fromStatus: true, toStatus: true } },
      },
    });
    expect(stored?.status).toBe("cancelled");
    expect(stored?.paymentId).toBe("");
    expect(stored?.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "order_cancelled",
          fromStatus: "pending",
          toStatus: "cancelled",
        }),
      ])
    );
  });
});

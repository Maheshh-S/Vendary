import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";

import { addFirstProductToCart, login } from "./helpers";
import { isLocalOrCiDatabase, serverEnv } from "./env";

/**
 * Phase 4A — coupons at checkout. The fixture is written straight to Prisma
 * (guarded: localhost/CI databases only) because the seeded catalog has no
 * coupon and this spec must not depend on the admin UI. No payment is made, so
 * the discount assertion is purely the server quote rendered in the summary.
 */

const databaseUrl = serverEnv("DATABASE_URL");
const canSeed = isLocalOrCiDatabase(databaseUrl);
const prisma = new PrismaClient({
  datasources: {
    db: { url: databaseUrl || "postgresql://invalid:invalid@localhost:5432/invalid" },
  },
});

const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  .toUpperCase()
  .replace(/[^A-Z0-9]/g, "");
const COUPON_CODE = `E2E${suffix}`;

/** Rupee display text (possibly an en dash plus ₹) to integer paise. */
const paiseFrom = (text: string): number => Math.round(Number(text.replace(/[^\d.]/g, "")) * 100);

const openCheckout = async (page: Page): Promise<void> => {
  await addFirstProductToCart(page);
  await page.goto("/cart");
  await page.getByRole("button", { name: "Proceed to Checkout" }).click();
  await page.getByRole("link", { name: "Checkout" }).click();
  await expect(page).toHaveURL(/\/checkout/);
  await expect(page.getByTestId("summary-total")).toBeVisible();
};

test.describe("coupons at checkout", () => {
  test.skip(!canSeed, "Needs a disposable local/CI database to seed the coupon fixture");

  test.beforeAll(async () => {
    if (!canSeed) return;
    await prisma.coupon.create({
      data: {
        code: COUPON_CODE,
        type: "PERCENT",
        value: "10.00",
        minSubtotal: "0.00",
        startsAt: new Date(Date.now() - 60 * 60 * 1000),
        endsAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        usageLimit: null,
        isActive: true,
      },
    });
  });

  test.afterAll(async () => {
    if (canSeed) {
      await prisma.coupon.deleteMany({ where: { code: COUPON_CODE } });
    }
    await prisma.$disconnect();
  });

  test("applies a valid coupon and shows GST on the discounted subtotal", async ({ page }) => {
    await login(page);
    await openCheckout(page);

    const subtotalPaise = paiseFrom(await page.getByTestId("summary-subtotal").innerText());
    expect(subtotalPaise).toBeGreaterThan(0);

    await page.getByLabel("Coupon code").fill(COUPON_CODE);
    await page.getByRole("button", { name: "Apply" }).click();

    await expect(page.getByText(`${COUPON_CODE} applied`, { exact: false })).toBeVisible();
    await expect(page.getByTestId("summary-discount")).toBeVisible();

    const discountPaise = paiseFrom(await page.getByTestId("summary-discount").innerText());
    const totalPaise = paiseFrom(await page.getByTestId("summary-total").innerText());

    expect(discountPaise).toBe(Math.round(subtotalPaise * 0.1));
    const taxablePaise = subtotalPaise - discountPaise;
    expect(totalPaise).toBe(taxablePaise + Math.round(taxablePaise * 0.08));
  });

  test("an invalid coupon is surfaced and blocks payment until removed", async ({ page }) => {
    await login(page);
    await openCheckout(page);

    const originalTotal = await page.getByTestId("summary-total").innerText();

    await page.getByLabel("Coupon code").fill("DEFINITELY-NOT-A-COUPON");
    await page.getByRole("button", { name: "Apply" }).click();

    await expect(page.getByText("Invalid coupon code.", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Proceed to Payment" })).toBeDisabled();
    await expect(page.getByText(/Remove or correct the coupon to continue/)).toBeVisible();

    await page.getByRole("button", { name: "Remove" }).click();

    await expect(page.getByText("Invalid coupon code.", { exact: true })).toHaveCount(0);
    await expect(page.getByTestId("summary-total")).toHaveText(originalTotal);
  });
});

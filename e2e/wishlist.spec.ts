import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";

import { DEMO_ADMIN, login } from "./helpers";
import { isLocalOrCiDatabase, serverEnv } from "./env";

/**
 * Phase 4A — wishlist. The seed admin is the only account, so the fixture
 * cleanup is scoped to that user; guarded to local/CI databases.
 */

const databaseUrl = serverEnv("DATABASE_URL");
const canSeed = isLocalOrCiDatabase(databaseUrl);
const prisma = new PrismaClient({
  datasources: {
    db: { url: databaseUrl || "postgresql://invalid:invalid@localhost:5432/invalid" },
  },
});

const clearWishlist = async (): Promise<void> => {
  const user = await prisma.user.findUnique({
    where: { email: DEMO_ADMIN.email },
    select: { id: true },
  });
  if (user) {
    await prisma.wishlistItem.deleteMany({ where: { userId: user.id } });
  }
};

const openFirstProduct = async (page: Page): Promise<string> => {
  await page.goto("/products");
  await page.locator('a[href^="/products/"]').first().click();
  await expect(page).toHaveURL(/\/products\//);
  const heading = page.getByRole("heading", { level: 1 });
  await expect(heading).toBeVisible();
  return (await heading.innerText()).trim();
};

test.describe("wishlist", () => {
  test.skip(!canSeed, "Needs a disposable local/CI database for fixture cleanup");

  test.beforeEach(async () => {
    if (!canSeed) return;
    await clearWishlist();
  });

  test.afterAll(async () => {
    if (canSeed) {
      await clearWishlist();
    }
    await prisma.$disconnect();
  });

  test("login → add → wishlist page → remove", async ({ page }) => {
    await login(page);
    const productName = await openFirstProduct(page);

    await page.getByRole("button", { name: "Add to wishlist" }).click();
    await expect(page.getByText("Saved to wishlist", { exact: false })).toBeVisible();

    await page.goto("/wishlist");
    await expect(page.getByRole("heading", { name: "My wishlist" })).toBeVisible();
    await expect(page.getByRole("link", { name: productName })).toBeVisible();

    await page.getByRole("button", { name: "Remove from wishlist" }).click();
    await expect(page.getByText("Your wishlist is empty", { exact: false })).toBeVisible();
  });

  test("a guest is sent to login with a callbackUrl back to the product", async ({ page }) => {
    await openFirstProduct(page);
    const currentPath = new URL(page.url()).pathname;
    expect(currentPath.startsWith("/products/")).toBe(true);

    await page.getByRole("button", { name: "Add to wishlist" }).click();
    await expect(page).toHaveURL(/\/login\?callbackUrl=/);

    const url = new URL(page.url());
    expect(url.pathname).toBe("/login");
    expect(url.searchParams.get("callbackUrl")).toBe(currentPath);
  });
});

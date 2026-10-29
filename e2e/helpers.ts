import { test, expect, Page } from "@playwright/test";

/**
 * Demo credentials come from prisma/seed.ts (run `bunx prisma db seed` first).
 */
export const DEMO_ADMIN = {
  email: "admin@vendary.test",
  password: "Admin@1234",
};

export async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email Address").fill(DEMO_ADMIN.email);
  await page.getByLabel("Password").fill(DEMO_ADMIN.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  // Credentials sign-in resolves via a server redirect to the home page.
  await page.waitForURL("/", { timeout: 20_000 });
}

export async function addFirstProductToCart(page: Page) {
  await page.goto("/products");
  const productLink = page.locator('a[href^="/products/"]').first();
  await productLink.click();
  await expect(page).toHaveURL(/\/products\//);

  const addToCart = page.getByRole("button", { name: "Add to Cart" });
  await expect(addToCart).toBeVisible();
  await addToCart.click();
  await expect(page.getByText("Added to cart", { exact: false }).first()).toBeVisible();
}

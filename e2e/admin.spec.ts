import { test, expect } from "@playwright/test";

import { login } from "./helpers";

/**
 * Task 1.6 — admin surface smoke: both tables render for a single-store admin,
 * the creator email column is visible, and `q` filters both tables.
 */

test.describe("admin dashboard", () => {
  test("renders products with creator emails and the order table", async ({ page }) => {
    await login(page);
    await page.goto("/admin");

    const products = page.getByTestId("admin-products-table");
    const orders = page.getByTestId("admin-orders-table");
    await expect(products).toBeVisible();
    await expect(orders).toBeVisible();

    // At least one product row and a creator email cell.
    await expect(products.locator("tbody tr")).not.toHaveCount(0);
    await expect(page.getByTestId("product-creator").first()).toContainText("@");
    await expect(page.getByTestId("admin-search-input")).toBeVisible();
  });

  test("search filters products and orders from the same control", async ({ page }) => {
    await login(page);
    await page.goto("/admin");

    await page.getByTestId("admin-search-input").fill("Jaipur");
    await page.getByRole("button", { name: "Search" }).click();

    await expect(page).toHaveURL(/\/admin\?q=Jaipur/);
    await expect(page.getByTestId("admin-search-summary")).toContainText("matching");
    await expect(page.getByTestId("admin-products-table")).toContainText("Jaipur");
    await expect(page.getByTestId("admin-products-table")).not.toContainText("Khurja");

    // A no-match order search keeps the orders table usable.
    await page.getByTestId("admin-search-input").fill(`no-such-order-${Date.now()}`);
    await page.getByRole("button", { name: "Search" }).click();
    await expect(page.getByTestId("admin-orders-table")).toContainText("No orders yet");
    await expect(page.getByTestId("admin-products-table")).toContainText("No products found");
  });
});

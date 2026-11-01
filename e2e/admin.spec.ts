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

    // A seeded product row and its creator's email are both rendered.
    await expect(products).toContainText("Jaipur Blue Pottery Vase");
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

  test("analytics renders KPIs, charts and the analytics tables", async ({ page }) => {
    await login(page);
    await page.goto("/admin/analytics");

    await expect(page.getByRole("heading", { name: "Analytics" })).toBeVisible();
    await expect(page.getByRole("term").filter({ hasText: "Revenue" })).toBeVisible();
    await expect(page.getByText("Average order value")).toBeVisible();
    await expect(page.getByTestId("revenue-chart")).toBeVisible();
    await expect(page.getByTestId("top-products-revenue")).toBeVisible();
    await expect(page.getByTestId("top-products-quantity")).toBeVisible();
    await expect(page.getByTestId("low-stock-table")).toBeVisible();
    await expect(page.getByText(/30 days shown/)).toBeVisible();
  });

  test("analytics rejects an invalid range and falls back to the default", async ({ page }) => {
    await login(page);
    await page.goto("/admin/analytics?from=2026-02-31&to=2026-03-01");

    await expect(
      page.getByRole("alert").filter({ hasText: "start date must be a valid" })
    ).toBeVisible();
    await expect(page.getByText(/Showing the last 30 days instead/)).toBeVisible();
  });
});

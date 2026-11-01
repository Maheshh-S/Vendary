import { test, expect, type Locator } from "@playwright/test";

/**
 * Task 1.2 — catalog pagination/sort/filter. The seeded catalog is 15 products
 * across 5 categories; the page renders 12 per page, so page 2 holds 3.
 *
 * These tests assume a clean seed (`bunx prisma db seed`) and never mutate
 * catalog data, so they are safe to run in parallel.
 */

const priceFrom = async (locator: Locator): Promise<number> => {
  const text = (await locator.textContent()) ?? "";
  const match = text.match(/₹[\d,]+(?:\.\d{2})?/);
  if (!match) throw new Error(`No ₹ amount in "${text}"`);
  return Number(match[0].replace(/[₹,]/g, ""));
};

const pricesInGrid = async (grid: Locator): Promise<number[]> => {
  const texts = await grid.locator("p").allTextContents();
  return texts
    .map((text) => text.match(/₹[\d,]+(?:\.\d{2})?/)?.[0])
    .filter((value): value is string => Boolean(value))
    .map((value) => Number(value.replace(/[₹,]/g, "")));
};

test.describe("catalog", () => {
  test("page 2 is reachable and shows the remaining products", async ({ page }) => {
    await page.goto("/products");

    const grid = page.getByTestId("product-grid");
    await expect(grid.locator('a[href^="/products/"]')).toHaveCount(12);
    await expect(page.getByText("Showing 1–12 of 15")).toBeVisible();

    await page.getByRole("link", { name: "Next page" }).click();

    await expect(page).toHaveURL(/\/products\?page=2$/);
    await expect(grid.locator('a[href^="/products/"]')).toHaveCount(3);
    await expect(page.getByText("Showing 13–15 of 15")).toBeVisible();
  });

  test("sort select reorders results and is reflected in the URL", async ({ page }) => {
    await page.goto("/products?sort=price_asc");
    const grid = page.getByTestId("product-grid");

    const ascending = await pricesInGrid(grid);
    expect(ascending).toHaveLength(12);
    expect([...ascending].sort((a, b) => a - b)).toEqual(ascending);

    await page.getByLabel("Sort products").selectOption("price_desc");
    await expect(page).toHaveURL(/sort=price_desc/);

    // Wait until the re-rendered grid is actually descending.
    await expect
      .poll(async () => {
        const descending = await pricesInGrid(grid);
        return (
          descending.length === 12 &&
          descending.every((value, index) => index === 0 || descending[index - 1] >= value)
        );
      })
      .toBe(true);
  });

  test("category filter narrows the catalog and keeps the heading", async ({ page }) => {
    await page.goto("/products?category=Pottery");

    await expect(page.getByRole("heading", { name: "Pottery", exact: true })).toBeVisible();
    const grid = page.getByTestId("product-grid");
    await expect(grid.locator('a[href^="/products/"]')).toHaveCount(3);
  });

  test("price filter applies from the controls and hides out-of-range products", async ({
    page,
  }) => {
    await page.goto("/products");

    await page.getByLabel("Min (₹)").fill("2000");
    await page.getByLabel("Max (₹)").fill("3000");
    await page.getByRole("button", { name: "Apply" }).click();

    await expect(page).toHaveURL(/min=2000/);
    await expect(page).toHaveURL(/max=3000/);

    const grid = page.getByTestId("product-grid");
    await expect(grid.locator('a[href^="/products/"]')).toHaveCount(3);

    const prices = await pricesInGrid(grid);
    expect(prices).toHaveLength(3);
    for (const price of prices) {
      expect(price).toBeGreaterThanOrEqual(2000);
      expect(price).toBeLessThanOrEqual(3000);
    }

    // The first price cell is a real ₹ amount (guards the parser above).
    expect(await priceFrom(grid.locator("p").first())).toBeGreaterThan(0);
  });

  test("product detail falls back to in-stock recommendations", async ({ page }) => {
    await page.goto("/products");
    await page.locator('a[href^="/products/"]').first().click();
    await expect(page).toHaveURL(/\/products\//);

    // A seeded catalog without co-purchases still renders the featured/in-stock
    // fallback (Task 4.5), capped at four cards.
    const strip = page.getByTestId("also-bought");
    await expect(strip.getByRole("heading", { name: "Customers also bought" })).toBeVisible();
    await expect(strip.locator('a[href^="/products/"]')).toHaveCount(4);
  });
});

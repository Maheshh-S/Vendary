import { test, expect } from "@playwright/test";
import { addFirstProductToCart } from "./helpers";

/**
 * Task 1.1 — the cart total is the server quote's total. Tampering with the
 * localStorage price must surface a warning and never change what is displayed
 * as the amount due.
 */

const subtotalText = async (page: import("@playwright/test").Page): Promise<string> => {
  const value = await page
    .getByText("Subtotal", { exact: true })
    .locator("xpath=following-sibling::*[1]")
    .textContent();
  return value?.trim() ?? "";
};

test.describe("cart quote truth", () => {
  test("a tampered local price shows the drift warning and the server total", async ({ page }) => {
    await addFirstProductToCart(page);
    await page.goto("/cart");
    await expect(page.getByRole("heading", { name: "Order Summary" })).toBeVisible();

    const authoritativeSubtotal = await subtotalText(page);
    expect(authoritativeSubtotal).toMatch(/₹[\d,]+/);

    // Simulate a price change/drift: the local cart now believes ₹0.01.
    await page.evaluate(() => {
      const items = JSON.parse(window.localStorage.getItem("cart-items") || "[]");
      items[0].unitPaise = 1;
      window.localStorage.setItem("cart-items", JSON.stringify(items));
    });
    await page.reload();

    await expect(page.getByText(/Prices have changed since you added these items/)).toBeVisible();
    // The summary keeps showing the authoritative server price.
    expect(await subtotalText(page)).toBe(authoritativeSubtotal);
  });

  test("a legacy rupee cart is migrated to paise on read", async ({ page }) => {
    await addFirstProductToCart(page);
    await page.goto("/cart");
    await expect(page.getByRole("heading", { name: "Order Summary" })).toBeVisible();

    const legacyItem = await page.evaluate(() => {
      const items = JSON.parse(window.localStorage.getItem("cart-items") || "[]");
      const item = items[0];
      return {
        id: item.id,
        name: item.name,
        // Pre-Phase-1 shape: rupees, no unitPaise.
        price: 1234,
        quantity: 1,
        images: item.images,
      };
    });
    await page.evaluate(
      (item) => window.localStorage.setItem("cart-items", JSON.stringify([item])),
      legacyItem
    );
    await page.reload();
    await expect(page.getByRole("heading", { name: "Order Summary" })).toBeVisible();

    await expect
      .poll(() =>
        page.evaluate(() => {
          const items = JSON.parse(window.localStorage.getItem("cart-items") || "[]");
          return items[0]?.unitPaise;
        })
      )
      .toBe(123400);

    const migrated = await page.evaluate(() => {
      const items = JSON.parse(window.localStorage.getItem("cart-items") || "[]");
      return items[0];
    });
    expect(migrated).not.toHaveProperty("price");
  });
});

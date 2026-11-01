import { test, expect, type Page } from "@playwright/test";

import { addFirstProductToCart, login } from "./helpers";

/**
 * Task 1.8 — checkout drift. Tampering with the localStorage price must show
 * the drift banner on the cart, and the checkout page must carry the server
 * quote's totals (the cart builds the checkout session from the quote).
 */

const amountAfter = async (page: Page, label: string): Promise<string> => {
  const value = await page
    .getByText(label, { exact: true })
    .locator("xpath=following-sibling::*[1]")
    .textContent();
  return value?.trim() ?? "";
};

test.describe("checkout price drift", () => {
  test("a tampered cart price warns and checkout keeps the server quote total", async ({
    page,
  }) => {
    await login(page);
    await addFirstProductToCart(page);

    await page.goto("/cart");
    await expect(page.getByRole("heading", { name: "Order Summary" })).toBeVisible();

    const authoritativeSubtotal = await amountAfter(page, "Subtotal");
    const authoritativeTotal = await amountAfter(page, "Total");
    expect(authoritativeSubtotal).toMatch(/₹[\d,]+/);
    expect(authoritativeTotal).toMatch(/₹[\d,]+/);

    // The local cart now believes the item costs ₹0.01. The server quote is
    // untouched; only the warning should change.
    await page.evaluate(() => {
      const items = JSON.parse(window.localStorage.getItem("cart-items") || "[]");
      items[0].unitPaise = 1;
      window.localStorage.setItem("cart-items", JSON.stringify(items));
    });
    await page.reload();

    await expect(
      page.getByText(/Prices have changed since you added these items/)
    ).toBeVisible();
    expect(await amountAfter(page, "Subtotal")).toBe(authoritativeSubtotal);
    expect(await amountAfter(page, "Total")).toBe(authoritativeTotal);

    // The checkout session is built from the quote, so checkout shows the same
    // authoritative total and no drift warning of its own.
    await page.getByRole("button", { name: "Proceed to Checkout" }).click();
    await page.getByRole("link", { name: "Checkout" }).click();
    await expect(page).toHaveURL(/\/checkout/);
    await expect(page.getByRole("heading", { name: "Order Summary" })).toBeVisible();

    await expect(page.getByText(/Prices have changed since you added these items/)).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Order Summary" })).toBeVisible();
    expect(await amountAfter(page, "Subtotal")).toBe(authoritativeSubtotal);
    expect(await amountAfter(page, "Total")).toBe(authoritativeTotal);
  });
});

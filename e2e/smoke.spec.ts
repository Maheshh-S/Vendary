import { test, expect } from "@playwright/test";
import { login, addFirstProductToCart } from "./helpers";

test.describe("storefront smoke", () => {
  test("home shows the seeded catalog", async ({ page }) => {
    await page.goto("/");
    // Hero renders, and seeded products appear as cards linking to product pages.
    await expect(page.locator('a[href^="/products/"]').first()).toBeVisible();
  });

  test("catalog lists seeded products with INR prices", async ({ page }) => {
    await page.goto("/products");
    await expect(page.locator('a[href^="/products/"]').first()).toBeVisible();
    // INR formatting everywhere (₹ with en-IN grouping).
    await expect(page.getByText(/₹/).first()).toBeVisible();
  });

  test("guest hitting /checkout is redirected away (login required before payment)", async ({ page }) => {
    await page.goto("/checkout");
    await expect(page).not.toHaveURL(/\/checkout/);
  });

  test("cart totals show subtotal, GST and a consistent grand total", async ({ page }) => {
    await addFirstProductToCart(page);
    await page.goto("/cart");

    await expect(page.getByRole("heading", { name: "Order Summary" })).toBeVisible();
    // Each summary row is <term>Amount</term> — read the sibling value cell.
    const rowAmount = async (label: string) => {
      const value = await page
        .getByText(label, { exact: true })
        .locator("xpath=following-sibling::*[1]")
        .textContent();
      const m = value?.match(/₹[\d,]+(?:\.\d{2})?/);
      if (!m) throw new Error(`No ₹ amount next to "${label}": ${value}`);
      return Number(m[0].replace(/[₹,]/g, ""));
    };

    const subtotal = await rowAmount("Subtotal");
    const tax = await rowAmount("Tax (8%)");
    const total = await rowAmount("Total");

    // GST is computed in exact paise (Math.round on paise, displayed at 2dp),
    // so compare with a 2-decimal tolerance rather than whole rupees.
    expect(tax).toBeCloseTo(subtotal * 0.08, 2);
    expect(total).toBeCloseTo(subtotal * 1.08, 2);
  });

  test("login with the seeded demo admin reaches the storefront", async ({ page }) => {
    await login(page);
    // The session survives navigation: a protected page renders for us.
    await page.goto("/my-orders");
    await expect(page.getByRole("heading", { name: "My Orders" })).toBeVisible();
  });

  test("my-orders loads for a signed-in user", async ({ page }) => {
    await login(page);
    await page.goto("/my-orders");
    await expect(page.getByText("My Orders", { exact: true }).first()).toBeVisible();
  });
});

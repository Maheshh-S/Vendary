import { test, expect } from "@playwright/test";
import { login, addFirstProductToCart } from "./helpers";
import { serverEnv } from "./env";

/**
 * Full paid checkout, tagged @payment so CI (without Razorpay keys) can run
 * `--grep-invert @payment`. Two seams are mocked; everything between them is
 * the real app:
 *
 *  1. checkout.razorpay.com/v1/checkout.js is replaced by a stub that calls
 *     the app's success handler with a signature computed from the SAME
 *     RAZORPAY_KEY_SECRET the server runs with — so PlaceOrder's HMAC
 *     verification passes honestly.
 *  2. The Razorpay REST API (order creation) is NOT mocked: it needs real
 *     test-mode keys, hence the skip when they're absent.
 */
const keySecret = serverEnv("RAZORPAY_KEY_SECRET");
const hasRazorpayKeys = !!keySecret && !!serverEnv("NEXT_PUBLIC_RAZORPAY_KEY_ID");

test.describe("paid checkout @payment", () => {
  test.skip(!hasRazorpayKeys, "Razorpay test keys required (RAZORPAY_KEY_SECRET / NEXT_PUBLIC_RAZORPAY_KEY_ID)");

  test("places a paid order and lands on my-orders with a confirmed order", async ({ page }) => {

    await page.route("**/checkout.razorpay.com/v1/checkout.js", (route) =>
      route.fulfill({
        contentType: "text/javascript",
        body: `
        class RazorpayStub {
          constructor(options) { this.options = options; }
          open() {
            const paymentId = "pay_e2e_test";
            const message = this.options.order_id + "|" + paymentId;
            const enc = new TextEncoder();
            crypto.subtle
              .importKey("raw", enc.encode(${JSON.stringify(keySecret)}), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
              .then((key) => crypto.subtle.sign("HMAC", key, enc.encode(message)))
              .then((sig) => {
                const hex = Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
                this.options.handler({
                  razorpay_payment_id: paymentId,
                  razorpay_order_id: this.options.order_id,
                  razorpay_signature: hex,
                });
              });
          }
        }
        window.Razorpay = RazorpayStub;
      `,
      })
    );

    await login(page);
    await addFirstProductToCart(page);
    await page.goto("/cart");
    await page.getByRole("button", { name: "Proceed to Checkout" }).click();
    await page.getByRole("link", { name: "Checkout" }).click();
    await expect(page).toHaveURL(/\/checkout/);

    await page.getByLabel("First name").fill("E2E");
    await page.getByLabel("Last name").fill("Tester");
    await page.getByLabel("Phone number").click();
    await page.getByLabel("Phone number").fill("9876543210");
    await page.getByLabel("Address", { exact: true }).fill("1 Test Street");
    await page.getByLabel("Area/Neighborhood").fill("Testville");
    await page.getByLabel("Postal Code").fill("560001");
    await page.getByLabel("Landmark").fill("Near the test tree");

    // Country/state dropdowns (Headless UI renders items as menuitem)
    await page.getByRole("button", { name: "Select Country" }).click();
    await page.getByPlaceholder("Search country...").fill("India");
    // "British Indian Ocean Territory" also matches /India/ — pin the flag.
    await page.getByRole("menuitem", { name: /🇮🇳 India/ }).click();
    await page.getByRole("button", { name: "Select State..." }).click();
    await page.getByPlaceholder("Search state...").fill("Karnataka");
    await page.getByRole("menuitem", { name: /Karnataka/ }).click();

    await page.getByRole("button", { name: "Proceed to Payment" }).click();

    // Payment initializes (server calls the real Razorpay test API), the
    // stub "pays", and PlaceOrder verifies + persists the order.
    await page.waitForURL("**/my-orders", { timeout: 45_000 });
    await expect(page.getByRole("heading", { name: "My Orders" })).toBeVisible();
    await expect(page.getByText("confirmed", { exact: false }).first()).toBeVisible();
  });
});

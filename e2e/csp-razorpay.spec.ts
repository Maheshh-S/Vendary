import { test, expect } from "@playwright/test";
import { login, addFirstProductToCart } from "./helpers";
import { serverEnv } from "./env";

/**
 * Proves the ENFORCING CSP against the REAL Razorpay checkout.
 *
 * `payment.spec.ts` stubs `checkout.razorpay.com/v1/checkout.js`, so the real
 * script, its injected subresources and the checkout iframe are never
 * exercised under the policy. This spec loads the production script (only the
 * Razorpay REST order creation is a genuine test-mode call, as in the stubbed
 * spec), waits for the real modal iframe, and fails on any CSP violation in
 * our document.
 *
 * It opens the modal but deliberately does NOT complete a payment — paid-flow
 * correctness stays covered by `payment.spec.ts`. Skipped when Razorpay test
 * keys are absent (CI), exactly like the stubbed spec.
 */
const keySecret = serverEnv("RAZORPAY_KEY_SECRET");
const hasRazorpayKeys = !!keySecret && !!serverEnv("NEXT_PUBLIC_RAZORPAY_KEY_ID");

type CspViolation = { text: string; location: string };
type RazorpayResponse = { url: string; status: number };
type RazorpayFailure = { url: string; error: string };

test.describe("real Razorpay checkout under CSP @payment", () => {
  test.skip(
    !hasRazorpayKeys,
    "Razorpay test keys required (RAZORPAY_KEY_SECRET / NEXT_PUBLIC_RAZORPAY_KEY_ID)"
  );

  test("loads the real checkout iframe without CSP violations", async ({ page }) => {
    const cspViolations: CspViolation[] = [];
    const razorpayResponses: RazorpayResponse[] = [];
    const razorpayFailures: RazorpayFailure[] = [];

    page.on("console", (message) => {
      const text = message.text();
      if (!text.includes("Content Security Policy")) {
        return;
      }
      const location = message.location().url ?? "";
      // The checkout iframe is a separate document with Razorpay's own policy;
      // only violations in OUR document are ours to fix.
      if (location.includes("razorpay.com")) {
        return;
      }
      cspViolations.push({ text, location });
    });

    page.on("response", (response) => {
      const url = response.url();
      if (url.includes("checkout.razorpay.com") || url.includes("api.razorpay.com")) {
        razorpayResponses.push({ url, status: response.status() });
      }
    });

    // A CSP-blocked request surfaces here as net::ERR_BLOCKED_BY_CSP.
    page.on("requestfailed", (request) => {
      const url = request.url();
      if (!url.includes("razorpay.com")) {
        return;
      }
      razorpayFailures.push({ url, error: request.failure()?.errorText ?? "unknown" });
    });

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

    await page.getByRole("button", { name: "Select Country" }).click();
    await page.getByPlaceholder("Search country...").fill("India");
    // "British Indian Ocean Territory" also matches /India/ — pin the flag.
    await page.getByRole("menuitem", { name: /🇮🇳 India/ }).click();
    await page.getByRole("button", { name: "Select State..." }).click();
    await page.getByPlaceholder("Search state...").fill("Karnataka");
    await page.getByRole("menuitem", { name: /Karnataka/ }).click();

    // The button stays disabled until the REAL checkout.js has loaded, so this
    // wait also proves the script itself passed CSP.
    const payButton = page.getByRole("button", { name: "Proceed to Payment" });
    await expect(payButton).toBeEnabled({ timeout: 45_000 });
    await payButton.click();

    // Real checkout modal: Razorpay injects a cross-origin iframe in our page.
    const checkoutFrame = page
      .locator(
        '.razorpay-container iframe, iframe.razorpay-checkout-frame, iframe[src*="razorpay.com"]'
      )
      .first();
    await expect(checkoutFrame).toBeVisible({ timeout: 45_000 });

    const scriptLoaded = razorpayResponses.some(
      (response) =>
        response.url.includes("checkout.razorpay.com/v1/checkout.js") && response.status < 400
    );
    expect(scriptLoaded, `Razorpay responses: ${JSON.stringify(razorpayResponses)}`).toBe(true);

    expect(
      cspViolations,
      `CSP violations: ${JSON.stringify(cspViolations)}\nFailed requests: ${JSON.stringify(
        razorpayFailures
      )}`
    ).toEqual([]);
    expect(
      razorpayFailures,
      `Razorpay request failures (possible CSP blocks): ${JSON.stringify(razorpayFailures)}`
    ).toEqual([]);

    // Close without paying. The close control lives inside the cross-origin
    // iframe, so teardown removes the modal container directly.
    await page.keyboard.press("Escape").catch(() => undefined);
    await page.evaluate(() => {
      document
        .querySelectorAll(".razorpay-container, .razorpay-backdrop, iframe[src*='razorpay.com']")
        .forEach((node) => node.remove());
    });
    await expect(checkoutFrame).toHaveCount(0);
  });
});

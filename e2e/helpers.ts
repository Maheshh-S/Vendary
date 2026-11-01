import { test, expect, Page } from "@playwright/test";

/**
 * Demo credentials come from prisma/seed.ts (run `bunx prisma db seed` first).
 */
export const DEMO_ADMIN = {
  email: "admin@vendary.test",
  password: "Admin@1234",
};

/**
 * Signs the context in through Auth.js's credentials endpoint.
 *
 * The UI form drives the `Login` server action, which is rate limited to five
 * attempts per IP per minute — with every spec in parallel that ceiling turns
 * into cross-test flakiness, so only the dedicated smoke test exercises the
 * form. This helper still uses the real provider (authorize + JWT session),
 * just without the UI round trip.
 */
export async function loginWith(
  page: Page,
  credentials: { email: string; password: string }
) {
  const csrfResponse = await page.request.get("/api/auth/csrf");
  if (!csrfResponse.ok()) {
    throw new Error(`Login failed: csrf endpoint returned ${csrfResponse.status()}`);
  }
  const { csrfToken } = (await csrfResponse.json()) as { csrfToken: string };

  const response = await page.request.post("/api/auth/callback/credentials", {
    form: {
      csrfToken,
      email: credentials.email,
      password: credentials.password,
      callbackUrl: "/",
    },
    maxRedirects: 0,
  });
  const location = response.headers()["location"] ?? "";
  if (response.status() !== 302 || location.includes("error=")) {
    throw new Error(`Login failed: credentials callback returned ${response.status()} ${location}`);
  }

  // Prove the app accepts the cookie before the test starts asserting.
  await page.goto("/my-orders");
  if (!/\/my-orders(?:\/|$)/.test(new URL(page.url()).pathname)) {
    throw new Error("Login succeeded but the session cookie was not accepted");
  }
}

export async function login(page: Page) {
  await loginWith(page, DEMO_ADMIN);
}

/** The real credentials form (rate limited); covered by the smoke test. */
export async function loginThroughForm(page: Page) {
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

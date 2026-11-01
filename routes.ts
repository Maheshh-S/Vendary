/**
 * The Default Redirect path after logging in
 * @type {string}
 */
export const DEFAULT_LOGIN_REDIRECT = "/";

/**
 * The prefix for api authentication routes
 * The routes that starts with this prefix are used for api authentication purposes
 * @type {string}
 */
export const apiAuthPrefix = "/api/auth"; //TODO: Change back to /api/auth

/**
 * Thes routes are used for authentication purposes
 * The route will authenticate the users to /dashboard
 * @type {string}
 */
export const authRoutes = ["/login", "/register", "/error"];

/**
 * Thes routes dont require authentication
 * The routes are accessible to public
 * NOTE: /checkout is deliberately NOT public — guests must sign in before
 * payment (PlaceOrder requires a session; paying first would dead-end).
 */
export const publicRoutes = [
  "/",
  "/new-verification",
  "/forgot-password",
  "/password/reset",
  "/changelog",
  "/products",
  "/products/(.*)",
  "/licence",
  "/privacy",
  "/returns",
  "/terms-of-service",
  "/success",
  "/cart",
];

// Every route not listed above is protected by the middleware, including
// `/wishlist`, `/account`, `/my-orders` and `/checkout`.

/**
 * Accepts only same-origin absolute paths for post-login redirects. A
 * protocol-relative `//evil.example` or a backslash-smuggled path is rejected,
 * so `callbackUrl` can never become an open redirect.
 */
export const safeInternalPath = (value: string | null | undefined): string | undefined => {
  if (!value || !value.startsWith("/")) return undefined;
  if (value.startsWith("//") || value.startsWith("/\\")) return undefined;
  return value;
};

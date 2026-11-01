import { defineConfig } from "@playwright/test";
import { serverEnv } from "./e2e/env";

/**
 * E2E for the shopping loop. The full checkout test is tagged @payment and
 * skips automatically when Razorpay test keys are absent (e.g. CI), so CI
 * always exercises browse/cart/auth while local runs cover the paid flow.
 *
 * Run:  npm run e2e            (all, local)
 *       npm run e2e -- --grep-invert @payment   (CI subset)
 */
const PORT = Number(process.env.E2E_PORT ?? 3100);
const baseURL = `http://127.0.0.1:${PORT}`;
/**
 * Serial by default, locally and in CI: every spec shares one seeded admin
 * account and database, so parallel workers turn auth/session/latency timing
 * into flakes. `E2E_WORKERS` is the explicit opt-in for a disposable DB.
 */
const WORKERS = Number(process.env.E2E_WORKERS ?? 1);
const workers = Number.isInteger(WORKERS) && WORKERS > 0 ? WORKERS : 1;

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  workers,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npx next build && npx next start -p " + PORT,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
    env: {
      AUTH_SECRET: serverEnv("AUTH_SECRET") || "e2e-auth-secret",
      // The server runs on 127.0.0.1:<port> — Auth.js v5 only auto-trusts
      // localhost:3000, so e2e must opt into host trust explicitly.
      AUTH_TRUST_HOST: "true",
      DATABASE_URL: serverEnv("DATABASE_URL"),
      RAZORPAY_KEY_SECRET: serverEnv("RAZORPAY_KEY_SECRET"),
      NEXT_PUBLIC_RAZORPAY_KEY_ID: serverEnv("NEXT_PUBLIC_RAZORPAY_KEY_ID"),
      RAZORPAY_WEBHOOK_SECRET: serverEnv("RAZORPAY_WEBHOOK_SECRET"),
      RESEND_API_KEY: serverEnv("RESEND_API_KEY"),
      // Force-disabled for e2e: a developer's .env must never let a test send
      // real customer/store email. Blank sender = sends are skipped.
      EMAIL_FROM: "",
      ORDER_NOTIFICATION_EMAIL: "",
      // Cache disabled for e2e: deterministic DB reads, no local Redis needed.
      REDIS_URL: "",
      AUTH_GOOGLE_ID: "",
      AUTH_GOOGLE_SECRET: "",
    },
  },
});

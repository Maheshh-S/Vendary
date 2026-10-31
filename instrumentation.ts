import { assertRuntimeEnv, getEnvProblems } from "@/lib/env";

/**
 * Next.js instrumentation hook. Runs once when a server instance starts.
 *
 * Production fails fast on missing or invalid configuration, except while
 * `next build` is running (CI/Docker only pass placeholders) and when
 * `SKIP_ENV_VALIDATION=1` is set as an explicit escape hatch. Development only
 * warns so the app stays browsable without Razorpay/Google credentials.
 *
 * `lib/env.ts` only defines a schema — it never parses at import time — so
 * importing it here is safe for build workers.
 */
export async function register(): Promise<void> {
  if (process.env.SKIP_ENV_VALIDATION === "1") {
    return;
  }

  if (process.env.NODE_ENV === "production") {
    // Build workers import instrumentation before real runtime env exists.
    if (process.env.NEXT_PHASE === "phase-production-build") {
      return;
    }
    assertRuntimeEnv();
    return;
  }

  const problems = getEnvProblems();
  if (problems.length > 0) {
    console.warn(
      `[env] Missing or invalid (names only): ${problems.join(", ")}. ` +
        "Dependent features stay disabled until they are set. See .env.example."
    );
  }
}

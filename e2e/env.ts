import { readFileSync } from "fs";
import path from "path";

/**
 * Playwright processes do not load .env. Both the config (webServer env) and
 * specs (Razorpay secret for the payment stub) read secrets through here.
 * Real process.env wins, then .env.
 */
const dotEnv: Record<string, string> = (() => {
  const values: Record<string, string> = {};
  try {
    for (const line of readFileSync(path.join(__dirname, "..", ".env"), "utf8").split("\n")) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (match) values[match[1]] = match[2].replace(/^["']|["']$/g, "").trim();
    }
  } catch {
    // No .env (fresh CI checkout) — tests needing secrets skip themselves.
  }
  return values;
})();

export const serverEnv = (key: string): string => process.env[key] ?? dotEnv[key] ?? "";

/**
 * Guards specs that write Prisma fixtures: only a disposable local or CI
 * database may be mutated. Production/staging URLs are skipped even when they
 * happen to be reachable from the test runner.
 */
export const isLocalOrCiDatabase = (url: string): boolean => {
  if (!url) return false;
  if (process.env.CI) return true;

  try {
    const host = new URL(url).hostname.toLowerCase();
    return [
      "localhost",
      "127.0.0.1",
      "0.0.0.0",
      "::1",
      "[::1]",
      "host.docker.internal",
    ].includes(host);
  } catch {
    return false;
  }
};

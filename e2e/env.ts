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

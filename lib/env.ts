import { z } from "zod";

/**
 * Optional credentials: a blank value (as shipped in `.env.example`) means
 * "not configured", the same as an absent variable. Non-blank values still
 * have to satisfy `min(1)`.
 */
const optionalString = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(1).optional()
);

/**
 * Server environment contract. Kept as a pure schema plus helpers — nothing is
 * parsed at module import time, so `next build` and Docker builds that only
 * provide placeholder values keep working. The production assertion is
 * triggered from `instrumentation.ts` when the server starts.
 */
export const serverEnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    DATABASE_URL: z.string().url().startsWith("postgres"),
    AUTH_SECRET: z.string().min(32),
    AUTH_GOOGLE_ID: optionalString,
    AUTH_GOOGLE_SECRET: optionalString,
    NEXT_PUBLIC_RAZORPAY_KEY_ID: z.string().min(1),
    RAZORPAY_KEY_SECRET: z.string().min(1),
    RAZORPAY_WEBHOOK_SECRET: z.string().min(1),
    RESEND_API_KEY: optionalString,
    /** Sender for transactional order email; required to enable sending. */
    EMAIL_FROM: optionalString,
    /** Optional store inbox that receives a copy of every order email. */
    ORDER_NOTIFICATION_EMAIL: optionalString,
    REDIS_URL: z.string().url().optional().or(z.literal("")),
    NEXT_PUBLIC_SITE_URL: z.string().url().default("http://localhost:3000"),
  })
  .refine((e) => Boolean(e.AUTH_GOOGLE_ID) === Boolean(e.AUTH_GOOGLE_SECRET), {
    message: "AUTH_GOOGLE_ID and AUTH_GOOGLE_SECRET must be set together",
  });

export type ServerEnv = z.infer<typeof serverEnvSchema>;

/**
 * Maps validation issues to variable names only. Root-level `.refine()`
 * messages are authored locally and name variables, so they are safe to show;
 * values are never included.
 */
const issueNames = (issues: readonly z.ZodIssue[]): string[] => {
  const names = new Set<string>();
  for (const issue of issues) {
    if (issue.path.length > 0) {
      names.add(issue.path.join("."));
    } else {
      names.add(issue.message);
    }
  }
  return [...names];
};

/** Variable names that are missing or invalid. Empty when the env is valid. */
export const getEnvProblems = (source: NodeJS.ProcessEnv = process.env): string[] => {
  const result = serverEnvSchema.safeParse(source);
  return result.success ? [] : issueNames(result.error.issues);
};

/**
 * Fail-fast assertion for production server start. Throws an error that lists
 * only the offending variable names (never their values).
 */
export const assertRuntimeEnv = (source: NodeJS.ProcessEnv = process.env): ServerEnv => {
  const result = serverEnvSchema.safeParse(source);
  if (!result.success) {
    throw new Error(
      `Invalid runtime environment: ${issueNames(result.error.issues).join(", ")}. ` +
        "Set the named variables (see .env.example)."
    );
  }
  return result.data;
};

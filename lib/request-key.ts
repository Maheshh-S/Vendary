import { headers } from "next/headers";

/**
 * Derives the bare rate-limit subject for the current request.
 *
 * - signed in: `user:<id>` (preferred — survives IP churn)
 * - anonymous: the first `x-forwarded-for` hop, or `unknown`
 *
 * The bucket is deliberately not embedded: the limiter composes the key as
 * `rl:{bucket}:{subject}:{window}`, so prefixing here would produce a
 * double-prefixed key such as `rl:login:login:1.2.3.4:...`.
 */
export const clientKey = async (bucket: string, userId?: string): Promise<string> => {
  if (userId) {
    return `user:${userId}`;
  }

  const headerList = await headers();
  const ip = headerList.get("x-forwarded-for")?.split(",")[0]?.trim();
  return ip || "unknown";
};

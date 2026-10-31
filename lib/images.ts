/**
 * Single source of truth for remote image hosts.
 *
 * Client-safe by design: no `server-only`, no path aliases, no Node built-ins.
 * The admin UI, server actions, unit tests and `next.config.ts` (relative
 * import) all share this list, so a URL accepted by a server action can always
 * be rendered by `next/image`.
 */

export const ALLOWED_IMAGE_HOSTS = [
  "images.unsplash.com",
  "images.pexels.com",
  "m.media-amazon.com",
  "pixabay.com",
  "tailwindcss.com",
  "lh3.googleusercontent.com",
] as const;

const ALLOWED_IMAGE_HOST_SET: ReadonlySet<string> = new Set(ALLOWED_IMAGE_HOSTS);

const DEV_IMAGE_ORIGIN = {
  protocol: "http:",
  hostname: "localhost",
  port: "3000",
} as const;

/**
 * Accepts an absolute `https` URL on an allowlisted host. The local Next dev
 * server (`http://localhost:3000`) is also accepted outside production so
 * locally seeded products keep rendering, mirroring `next.config.ts`.
 */
export const isAllowedImageUrl = (value: string): boolean => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }

  if (parsed.protocol === "https:") {
    return ALLOWED_IMAGE_HOST_SET.has(parsed.hostname);
  }

  return (
    process.env.NODE_ENV !== "production" &&
    parsed.protocol === DEV_IMAGE_ORIGIN.protocol &&
    parsed.hostname === DEV_IMAGE_ORIGIN.hostname &&
    parsed.port === DEV_IMAGE_ORIGIN.port
  );
};

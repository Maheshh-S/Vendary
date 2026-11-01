import nextMDX from "@next/mdx";

import { SECURITY_HEADERS } from "./lib/csp";
import { ALLOWED_IMAGE_HOSTS } from "./lib/images";
import { recmaPlugins } from "./mdx/recma.mjs";
import { rehypePlugins } from "./mdx/rehype.mjs";
import { remarkPlugins } from "./mdx/remark.mjs";

const withMDX = nextMDX({
  extension: /\.mdx?$/,
  options: {
    remarkPlugins,
    rehypePlugins,
    recmaPlugins,
  },
});

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Self-contained server bundle for the hardened Docker runner.
  output: "standalone" as const,
  experimental: {
    serverActions: {
      // Next 15 default, pinned so a framework bump cannot silently raise it.
      bodySizeLimit: "1mb" as const,
    },
  },
  pageExtensions: ["js", "jsx", "ts", "tsx", "mdx"],
  images: {
    // Same allowlist the admin actions validate against (lib/images.ts), so a
    // URL accepted at the server boundary is always renderable by next/image.
    remotePatterns: [
      ...ALLOWED_IMAGE_HOSTS.map((hostname) => ({
        protocol: "https" as const,
        hostname,
      })),
      {
        protocol: "http" as const,
        hostname: "localhost",
        port: "3000",
      },
    ],
  },
  async headers() {
    return [
      {
        // Enforcing CSP plus the baseline headers; see lib/csp.ts for the
        // policy, allowlist rationale and the deferred nonce/strict-dynamic
        // hardening.
        source: "/(.*)",
        headers: [...SECURITY_HEADERS],
      },
    ];
  },
};

export default withMDX(nextConfig);

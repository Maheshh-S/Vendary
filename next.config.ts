import nextMDX from '@next/mdx'

import { recmaPlugins } from './mdx/recma.mjs'
import { rehypePlugins } from './mdx/rehype.mjs'
import { remarkPlugins } from './mdx/remark.mjs'

const withMDX = nextMDX({
  extension: /\.mdx?$/,
  options: {
    remarkPlugins,
    rehypePlugins,
    recmaPlugins,
  },
})

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Self-contained server bundle for the hardened Docker runner.
  output: 'standalone' as const,
  pageExtensions: ['js', 'jsx', 'ts', 'tsx', 'mdx'],
  images: {
    remotePatterns: [
      {
        protocol: "https" as const,
        hostname: "tailwindcss.com",
      },
      {
        protocol: "https" as const,
        hostname: "m.media-amazon.com"
      },
      {
        protocol: "https" as const,
        hostname: "lh3.googleusercontent.com"
      },
      {
        protocol: "https" as const,
        hostname: "images.pexels.com"
      },
      {
        protocol: "https" as const,
        hostname: "images.unsplash.com"
      },
      {
        protocol: "https" as const,
        hostname: "pixabay.com"
      },
      {
        protocol: "http" as const,
        hostname: "localhost",
        port: "3000",
      }
    ]
  },
  async headers() {
    return [
      {
        // Pragmatic baseline — deliberately no enforcing CSP yet (Razorpay
        // checkout needs careful frame/script allowances; separate task).
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            // geolocation=self: the checkout autofill flow uses it.
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(self)",
          },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains",
          },
          {
            // Report-Only so nothing can break checkout while the policy is
            // validated against real traffic (Razorpay checkout posts to
            // lumberjack.razorpay.com; the FX widget calls exchangerate-api).
            key: "Content-Security-Policy-Report-Only",
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://checkout.razorpay.com",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: blob: https://images.unsplash.com https://images.pexels.com https://m.media-amazon.com https://lh3.googleusercontent.com https://pixabay.com https://tailwindcss.com https://*.razorpay.com",
              "font-src 'self' data:",
              "connect-src 'self' https://api.razorpay.com https://lumberjack.razorpay.com https://api.exchangerate-api.com https://exchangerate-api.com",
              "frame-src https://api.razorpay.com https://checkout.razorpay.com",
              "frame-ancestors 'none'",
              "base-uri 'self'",
              "form-action 'self'",
            ].join("; "),
          },
        ],
      },
    ]
  },
}

export default withMDX(nextConfig)

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
  }
} 

export default withMDX(nextConfig)

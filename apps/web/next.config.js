/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Standalone output bundles a self-contained server.js + minimal node_modules
  // into .next/standalone, which the Electron desktop wrapper packages into
  // the .exe. Harmless for non-desktop deployments — Vercel ignores it.
  output: 'standalone',
  outputFileTracingRoot: require('path').join(__dirname, '..', '..'),
  transpilePackages: ['@subterra/shared'],
  experimental: {
    typedRoutes: false,
  },
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'basemap.nationalmap.gov' },
      { protocol: 'https', hostname: 'gis.blm.gov' },
    ],
  },
};

module.exports = nextConfig;

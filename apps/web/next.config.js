/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Standalone output bundles a self-contained server.js + minimal node_modules
  // into .next/standalone, which the Electron desktop wrapper packages into
  // the .exe. Harmless for non-desktop deployments — Vercel ignores it.
  output: 'standalone',
  transpilePackages: ['@subterra/shared'],
  experimental: {
    typedRoutes: false,
    // Tell Next.js the monorepo root so the standalone tracer follows
    // workspace symlinks for @subterra/shared. Under Next 14.2.x this lives
    // under `experimental`; promoted to top-level in 15.x.
    outputFileTracingRoot: require('path').join(__dirname, '..', '..'),
  },
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'basemap.nationalmap.gov' },
      { protocol: 'https', hostname: 'gis.blm.gov' },
    ],
  },
};

module.exports = nextConfig;

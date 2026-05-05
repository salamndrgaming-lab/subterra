/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
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

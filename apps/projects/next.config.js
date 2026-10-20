/** @type {import('next').NextConfig} */
const nextConfig = {
  // Every workspace package ships TypeScript source; Next compiles them.
  transpilePackages: [
    '@meritbooks/merit-ui',
    '@meritbooks/industry-packs',
    '@meritbooks/shared',
    '@meritbooks/core-ai',
  ],
  typescript: { ignoreBuildErrors: false },
  eslint: { ignoreDuringBuilds: true },
  images: { remotePatterns: [{ protocol: 'https', hostname: '*.supabase.co' }] },
};
module.exports = nextConfig;

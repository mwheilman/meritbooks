/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@meritbooks/shared', '@meritbooks/core-ai'],
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
  images: { remotePatterns: [{ protocol: 'https', hostname: '*.supabase.co' }] },
};
module.exports = nextConfig;

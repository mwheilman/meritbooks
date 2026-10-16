/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@meritbooks/shared'],
  experimental: {
    // exceljs (server-side .xlsx reading for TB / budget / AR-AP imports) must load
    // from node_modules at runtime, not be bundled by webpack (Next 14 option name).
    serverComponentsExternalPackages: ['exceljs'],
  },
  typescript: {
    ignoreBuildErrors: false,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '*.supabase.co' },
    ],
  },
};

module.exports = nextConfig;

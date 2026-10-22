/** @type {import('next').NextConfig} */
const nextConfig = {
  // Workspace packages ship TypeScript source; Next compiles them. merit-ui is the
  // Merit Suite design system (Style Guide v2.3) — it also runs next/font from
  // inside the package, which needs it listed here.
  transpilePackages: ['@meritbooks/merit-ui', '@meritbooks/shared'],
  experimental: {
    // exceljs (server-side .xlsx reading for TB / budget / AR-AP imports) must load
    // from node_modules at runtime, not be bundled by webpack (Next 14 option name).
    // @react-pdf/renderer (invoice/statement/report-pack PDFs) loads its standard
    // fonts by module path at runtime; bundling it broke font resolution in the
    // serverless function (/api/cron/tick crash, 2026-10-21). Load it from
    // node_modules instead.
    serverComponentsExternalPackages: ['exceljs', '@react-pdf/renderer'],
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

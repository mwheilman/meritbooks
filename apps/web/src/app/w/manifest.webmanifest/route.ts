export const dynamic = 'force-static';

/** GET /w/manifest.webmanifest — the Merit Workforce PWA manifest (installable, scoped to /w). */
export function GET() {
  return new Response(
    JSON.stringify({
      name: 'Merit Workforce',
      short_name: 'Workforce',
      description: 'Your receipts, time and pay from your company — in one place.',
      start_url: '/w',
      scope: '/w',
      display: 'standalone',
      orientation: 'portrait',
      background_color: '#FDFCFA',
      theme_color: '#0A1628',
      icons: [{ src: '/brand/lockups/merit-icon-full-color.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
    }),
    { headers: { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'public, max-age=3600' } },
  );
}

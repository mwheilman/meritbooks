import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

/**
 * MERIT WORKFORCE (FPB-workforce-app) — the employee app, phone-first, outside the desk
 * shell. Wave 2B ships its Receipts part; the Home / Pay / Time shell, passkeys and push
 * arrive with Wave 5B. PWA-ready: manifest + theme colour; "Add to Home Screen" opens /w.
 */
export const metadata: Metadata = {
  title: { absolute: 'Merit Workforce' },
  applicationName: 'Merit Workforce',
  manifest: '/w/manifest.webmanifest',
  appleWebApp: { capable: true, title: 'Workforce', statusBarStyle: 'black-translucent' },
  robots: { index: false, follow: false },
  // The magic link carries its credential in the path: never leak it in a Referer header.
  referrer: 'no-referrer',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#0A1628',
};

export default function WorkforceLayout({ children }: { children: ReactNode }) {
  return children;
}

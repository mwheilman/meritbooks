import type { Metadata, Viewport } from 'next';
import type { CSSProperties } from 'react';
import { Syne, DM_Sans, JetBrains_Mono } from 'next/font/google';
import { ClerkProvider } from '@clerk/nextjs';
import { brandCssVars, getTenantBrand } from '@/lib/brand/tenant-brand';
import '@/styles/globals.css';

// Brand type (Merit Feb 2026 guide). Bound to CSS variables so Tailwind's
// `font-display` / `font-sans` / `font-mono` and raw CSS resolve to them; a
// white-label tenant swaps families here, nowhere else.
const display = Syne({
  subsets: ['latin'],
  weight: ['600', '700'],
  variable: '--font-display',
  display: 'swap',
});
const sans = DM_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-sans',
  display: 'swap',
});
const mono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-mono',
  display: 'swap',
});

const brand = getTenantBrand();

export const metadata: Metadata = {
  title: {
    default: brand.productName,
    template: `%s | ${brand.productName}`,
  },
  description: 'AI-native accounting platform for multi-entity finance teams.',
};

export const viewport: Viewport = {
  themeColor: brand.colors.navy,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ClerkProvider
      appearance={{
        variables: {
          colorPrimary: brand.colors.accent,
          colorText: brand.colors.navy,
          colorTextSecondary: brand.colors.body,
          colorBackground: '#ffffff',
          borderRadius: '0.625rem',
          fontFamily: 'var(--font-sans), system-ui, sans-serif',
        },
      }}
    >
      <html
        lang="en"
        className={`${display.variable} ${sans.variable} ${mono.variable}`}
        style={brandCssVars(brand) as CSSProperties}
      >
        <body className="min-h-screen font-sans">
          {children}
        </body>
      </html>
    </ClerkProvider>
  );
}

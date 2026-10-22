import type { Metadata } from 'next';
import { ClerkProvider } from '@clerk/nextjs';
import { fontVariables } from '@meritbooks/merit-ui/fonts';
import { IconSprite, titleTemplate } from '@meritbooks/merit-ui';
import { LegacyScope } from '@/components/layout/legacy-scope';
import { clerkAppearance } from '@/lib/clerk-appearance';
import { RootProviders } from './providers';
// Cascade (packages/merit-ui README §3): preflight → kit system.css → marks →
// next-adapter → components → utilities. Then Books' own kit-token styles, then the
// TEMPORARY legacy bridge for pages not yet rebuilt on the kit (loaded last).
import '@/styles/globals.css';
import '@/styles/books.css';
import '@/styles/legacy-bridge.css';

export const metadata: Metadata = {
  title: {
    default: 'Merit Books',
    template: titleTemplate('books'),
  },
  description: 'Merit Books: the book of record for every client — bank feed, bills, invoices, close and reports.',
  icons: { icon: '/brand/lockups/merit-icon-full-color.svg' },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ClerkProvider appearance={clerkAppearance}>
      {/* fonts on <html>: the kit tokens live on :root. No `dark` class — the suite is light. */}
      <html lang="en" className={fontVariables}>
        <body>
          <IconSprite />
          <RootProviders>
            <LegacyScope>{children}</LegacyScope>
          </RootProviders>
        </body>
      </html>
    </ClerkProvider>
  );
}

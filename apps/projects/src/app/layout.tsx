import type { Metadata } from 'next';
import { ClerkProvider } from '@clerk/nextjs';
import { fontVariables } from '@meritbooks/merit-ui/fonts';
import { IconSprite, titleTemplate } from '@meritbooks/merit-ui';
import { clerkAppearance } from '@/lib/clerk-appearance';
import { Providers } from './providers';
import './globals.css';
import './projects.css';

export const metadata: Metadata = {
  title: { template: titleTemplate('projects'), default: 'Merit Projects' },
  description: 'Merit Projects: jobs, budgets, schedules and change orders, tied to Merit Books.',
  icons: { icon: '/brand/lockups/merit-icon-full-color.svg' },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider appearance={clerkAppearance}>
      {/* fonts on <html>: the kit tokens live on :root */}
      <html lang="en" className={fontVariables}>
        <body>
          <IconSprite />
          <Providers>{children}</Providers>
        </body>
      </html>
    </ClerkProvider>
  );
}

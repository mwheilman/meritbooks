'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, type ReactNode } from 'react';
import { MeritProvider } from '@meritbooks/merit-ui';

/**
 * Root client providers: merit-ui's MeritProvider owns the ONE hotkey registry and
 * gives kit components the app's Link and router (rail go-to chords, crumbs, figure
 * links navigate client-side). Mounted once in the root layout.
 */
export function RootProviders({ children }: { children: ReactNode }) {
  const router = useRouter();
  const navigate = useCallback((href: string) => router.push(href), [router]);
  return (
    <MeritProvider link={Link} navigate={navigate}>
      {children}
    </MeritProvider>
  );
}

'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback } from 'react';
import { MeritProvider, ToastRegion } from '@meritbooks/merit-ui';

export function Providers({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const navigate = useCallback((href: string) => router.push(href), [router]);
  return (
    <MeritProvider link={Link} navigate={navigate}>
      {children}
      <ToastRegion />
    </MeritProvider>
  );
}

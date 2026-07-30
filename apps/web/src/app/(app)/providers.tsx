'use client';

import type { ReactNode } from 'react';
import { MeProvider } from '@/lib/hooks/use-me';
import { PlaneProvider } from '@/lib/hooks/use-plane';

/**
 * Client providers for the authenticated app shell. MeProvider resolves the
 * viewer's identity/role from /api/me; PlaneProvider (which reads it) tracks the
 * active plane for the context switcher. Nested so usePlane() can see useMe().
 */
export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <MeProvider>
      <PlaneProvider>{children}</PlaneProvider>
    </MeProvider>
  );
}

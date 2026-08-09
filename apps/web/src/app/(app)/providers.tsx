'use client';

import type { ReactNode } from 'react';
import { MeProvider } from '@/lib/hooks/use-me';
import { PlaneProvider } from '@/lib/hooks/use-plane';
import { ActiveCompanyProvider } from '@/lib/hooks/use-active-company';

/**
 * Client providers for the authenticated app shell. MeProvider resolves the
 * viewer's identity/role from /api/me; PlaneProvider (which reads it) tracks the
 * active plane for the context switcher; ActiveCompanyProvider (which reads the
 * viewer's assigned locations) tracks the single company all processing work is
 * scoped to. Nested so usePlane()/useActiveCompany() can see useMe().
 */
export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <MeProvider>
      <PlaneProvider>
        <ActiveCompanyProvider>{children}</ActiveCompanyProvider>
      </PlaneProvider>
    </MeProvider>
  );
}

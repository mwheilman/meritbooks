'use client';

import type { ReactNode } from 'react';
import { MeProvider } from '@/lib/hooks/use-me';
import { PlaneProvider } from '@/lib/hooks/use-plane';
import { ActiveCompanyProvider, type InitialActiveCompany } from '@/lib/hooks/use-active-company';

/**
 * Client providers for the authenticated app shell. MeProvider resolves the
 * viewer's identity/role from /api/me; PlaneProvider (which reads it) tracks the
 * active plane for the context switcher; ActiveCompanyProvider (which reads the
 * viewer's assigned locations) tracks the single company all processing work is
 * scoped to. Nested so usePlane()/useActiveCompany() can see useMe().
 */
export function AppProviders({
  children,
  initialCompany,
}: {
  children: ReactNode;
  /** Active company read from the cookie on the server (hydration-safe seed). */
  initialCompany?: InitialActiveCompany | null;
}) {
  return (
    <MeProvider>
      <PlaneProvider>
        <ActiveCompanyProvider initialCompany={initialCompany}>{children}</ActiveCompanyProvider>
      </PlaneProvider>
    </MeProvider>
  );
}

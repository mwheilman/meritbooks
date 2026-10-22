'use client';

import type { ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { LEGACY_SCOPE_CLASS, isPortedPath } from '@/lib/design/legacy-bridge';

/**
 * LEGACY BRIDGE scope (TEMPORARY) — mounted once in the root layout.
 *
 * Routes not yet rebuilt on merit-ui render inside `.legacy-page`, which turns on
 * the Merit remap of the old utility vocabulary (src/styles/legacy-bridge.css).
 * Ported routes (lib/design/legacy-bridge PORTED_ROUTES) render without it.
 *
 * Always the SAME element (a display:contents div) — only its class changes — so
 * navigating between a ported and a bridged page never remounts the app shell.
 */
export function LegacyScope({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const bridged = !isPortedPath(pathname);
  return (
    <div className={bridged ? LEGACY_SCOPE_CLASS : undefined} data-legacy-bridge={bridged ? '' : undefined} style={{ display: 'contents' }}>
      {children}
    </div>
  );
}

/**
 * Always-bridged island for shared overlays that are still legacy-styled (the
 * CPA Desk command bar, the search palette) so they read as Merit on ported
 * pages too.
 */
export function LegacyIsland({ children }: { children: ReactNode }) {
  return (
    <div className={LEGACY_SCOPE_CLASS} style={{ display: 'contents' }}>
      {children}
    </div>
  );
}

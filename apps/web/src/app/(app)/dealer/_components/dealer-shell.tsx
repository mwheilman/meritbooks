'use client';

/**
 * Dealer Pack (D2) shell: one-client guard, the in-pack sub-navigation (the
 * sidebar "Dealer" group is reserved spine — until the lead adds it these tabs
 * are how people move around), and a calm banner when the pack is off for the
 * active client. Exposes the client's settings + readiness via useDealerPack().
 */

import { createContext, useContext, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Settings2 } from 'lucide-react';
import { CompanyScopeGuard } from '@/components/company-scope-guard';
import type { DealerSettings } from '@/lib/dealer/types';
import type { Readiness } from '@/lib/dealer/service/settings';
import { useDealerClient, useDealerQuery, type DealerApiError } from '../_lib/use-dealer';
import { Notice } from './ui';

export const DEALER_TABS: Array<{ href: string; label: string; match?: (p: string) => boolean }> = [
  { href: '/dealer', label: 'Home', match: (p) => p === '/dealer' },
  { href: '/dealer/units', label: 'Units' },
  { href: '/dealer/floor-plan', label: 'Floor plan' },
  { href: '/dealer/lender-statements', label: 'Lender statements' },
  { href: '/dealer/warranty', label: 'Warranty' },
  { href: '/dealer/incentives', label: 'Incentives' },
  { href: '/dealer/deals', label: 'Deals & trade-ins' },
  { href: '/dealer/imports', label: 'Imports' },
  { href: '/dealer/reports', label: 'Reports' },
  { href: '/dealer/settings', label: 'Settings' },
];

interface PackState {
  settings: DealerSettings | null;
  readiness: Readiness | null;
  enabled: boolean;
  isLoading: boolean;
  error: DealerApiError | null;
  refetch: () => Promise<void>;
  locationId: string | null;
  clientName: string | null;
}

const PackContext = createContext<PackState>({
  settings: null,
  readiness: null,
  enabled: false,
  isLoading: true,
  error: null,
  refetch: async () => undefined,
  locationId: null,
  clientName: null,
});

export function useDealerPack(): PackState {
  return useContext(PackContext);
}

function PackProvider({ children }: { children: ReactNode }) {
  const { clientName } = useDealerClient();
  const q = useDealerQuery<{ settings: DealerSettings; readiness: Readiness }>('/api/dealer/settings');
  const value: PackState = {
    settings: q.data?.settings ?? null,
    readiness: q.data?.readiness ?? null,
    enabled: q.data?.settings.enabled === true,
    isLoading: q.isLoading,
    error: q.error,
    refetch: q.refetch,
    locationId: q.locationId,
    clientName,
  };
  return <PackContext.Provider value={value}>{children}</PackContext.Provider>;
}

function SubNav() {
  const path = usePathname() ?? '';
  return (
    // Kit link-tabs (.tabs / .tab): the selected tab carries aria-current="page" and the
    // Electric underline (books.css `.tabs a.tab[aria-current=page]`).
    <nav aria-label="Dealer pack" className="tabs mb-section-tabs">
      {DEALER_TABS.map((t) => {
        const active = t.match ? t.match(path) : path === t.href || path.startsWith(`${t.href}/`);
        return (
          <Link key={t.href} href={t.href} className="tab" aria-current={active ? 'page' : undefined}>
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}

function PackBanner() {
  const path = usePathname() ?? '';
  const { enabled, isLoading, error, readiness, clientName } = useDealerPack();
  if (isLoading || error || enabled || path.startsWith('/dealer/settings')) return null;
  const missing = readiness?.missing.length ?? 0;
  return (
    <Notice
      tone="warning"
      action={
        <Link href="/dealer/settings" className="btn-secondary btn-sm inline-flex items-center gap-1.5">
          <Settings2 size={13} /> Finish setup
        </Link>
      }
    >
      <span className="font-medium">The dealer pack is off for {clientName ?? 'this client'}.</span>{' '}
      You can set up lenders, programs and run imports now; money events (flooring, sales, payoffs, claims) post once it’s switched on.
      {missing > 0 && <span className="text-amber-200/80"> {missing} setup item{missing === 1 ? '' : 's'} still open.</span>}
    </Notice>
  );
}

export function DealerShell({ children }: { children: ReactNode }) {
  return (
    <CompanyScopeGuard
      title="Choose a dealer client"
      description="The dealer pack works on one client at a time so floor plan, units and claims never land on the wrong books."
    >
      <PackProvider>
        <div>
          <SubNav />
          <PackBanner />
          {children}
        </div>
      </PackProvider>
    </CompanyScopeGuard>
  );
}

'use client';

import { Suspense } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';

/**
 * Payables → Vendor compliance section tabs (kit underline tabs, link-based so each tab is
 * deep-linkable). Every tab lives on `?tab=` of /vendor-compliance — including 1099
 * readiness, so the rail keeps Vendor compliance lit (the old /compliance-1099 route
 * redirects here).
 */
const TABS = [
  { href: '/vendor-compliance', tab: 'compliance', label: 'Compliance' },
  { href: '/vendor-compliance?tab=review', tab: 'review', label: 'Review queue' },
  { href: '/vendor-compliance?tab=requirements', tab: 'requirements', label: 'Requirements' },
  { href: '/vendor-compliance?tab=bank', tab: 'bank', label: 'Bank changes' },
  { href: '/vendor-compliance?tab=1099', tab: '1099', label: '1099 readiness' },
] as const;

/** Wrapped in Suspense: useSearchParams needs a boundary when a page prerenders. */
export function VendorComplianceTabs() {
  return (
    <Suspense fallback={<nav className="tabs mb-section-tabs" aria-label="Vendor compliance" />}>
      <TabsInner />
    </Suspense>
  );
}

function TabsInner() {
  const pathname = usePathname();
  const params = useSearchParams();
  const current = params.get('tab') ?? 'compliance';
  return (
    <nav className="tabs mb-section-tabs" aria-label="Vendor compliance">
      {TABS.map((t) => {
        const active = pathname === '/vendor-compliance' && current === t.tab;
        return (
          <Link key={t.href} href={t.href} className="tab" aria-current={active ? 'page' : undefined}>
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}

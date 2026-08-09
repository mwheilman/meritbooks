'use client';

/**
 * Link-based hub tabs for consolidated parent sections whose children remain their
 * own live routes (Assets & Schedules, Tax). Unlike the in-page `SectionTabs`
 * (state + `?tab=` for merged single-page screens), these tabs are <Link>s that
 * navigate between sibling routes, and the active tab is derived from the pathname.
 *
 * Rendering the same strip on the hub landing AND on each child page turns a set of
 * standalone registers into one coherent tabbed shell without moving any route or
 * touching navigation.ts. Reuses the consolidation/reconciliation pill look.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { clsx } from 'clsx';
import {
  Package, FileText, Receipt, ShieldCheck, Sparkles, Calculator,
  Scale, Landmark, MapPin, FileCheck, LayoutGrid,
} from 'lucide-react';

interface HubTabDef {
  href: string;
  label: string;
  icon: typeof Package;
  /** Extra pathnames that should light this tab (e.g. redirected standalones). */
  aliases?: string[];
}

const SECTIONS: Record<'assets' | 'tax', { hub: string; tabs: HubTabDef[] }> = {
  assets: {
    hub: '/assets',
    tabs: [
      { href: '/assets', label: 'Overview', icon: LayoutGrid },
      { href: '/fixed-assets', label: 'Fixed Assets', icon: Package },
      { href: '/leases', label: 'Leases', icon: FileText },
      { href: '/prepaids', label: 'Prepaids', icon: Receipt },
      { href: '/insurance', label: 'Insurance', icon: ShieldCheck },
      { href: '/intangibles', label: 'Intangibles', icon: Sparkles },
      { href: '/tax-depreciation', label: 'Tax Depreciation', icon: Calculator },
    ],
  },
  tax: {
    hub: '/tax',
    tabs: [
      { href: '/tax', label: 'Overview', icon: LayoutGrid },
      { href: '/book-to-tax', label: 'Book-to-Tax M-1', icon: Scale },
      { href: '/tax-provision', label: 'Tax Provision', icon: Landmark },
      {
        href: '/tax/sales-tax',
        label: 'Sales Tax',
        icon: MapPin,
        aliases: ['/sales-tax-return', '/sales-tax-calendar'],
      },
      { href: '/tax-package', label: 'Tax Return Package', icon: FileCheck },
    ],
  },
};

export function HubTabs({ section }: { section: 'assets' | 'tax' }) {
  const pathname = usePathname() ?? '';
  const { tabs } = SECTIONS[section];

  const isActive = (t: HubTabDef): boolean => {
    if (pathname === t.href) return true;
    if (t.aliases?.some((a) => pathname === a || pathname.startsWith(`${a}/`))) return true;
    // Prefix match for nested routes (e.g. /tax/sales-tax/…) but never let the hub
    // Overview tab (which is a prefix of everything) swallow its children.
    if (t.href !== SECTIONS[section].hub && pathname.startsWith(`${t.href}/`)) return true;
    return false;
  };

  return (
    <div className="mb-6 -mt-1 flex flex-wrap items-center gap-1 rounded-lg border border-slate-800 bg-surface-900 p-1">
      {tabs.map((t) => {
        const active = isActive(t);
        const Icon = t.icon;
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? 'page' : undefined}
            className={clsx(
              'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
              active ? 'bg-brand-500 text-white' : 'text-slate-400 hover:text-slate-200',
            )}
          >
            <Icon size={14} />
            {t.label}
          </Link>
        );
      })}
    </div>
  );
}

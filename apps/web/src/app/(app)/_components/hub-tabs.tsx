'use client';

/**
 * Link-based hub tabs for consolidated parent sections whose children remain their
 * own live routes (Assets & Schedules, Tax). Unlike the in-page `SectionTabs`
 * (state + `?tab=` for merged single-page screens), these tabs are <Link>s that
 * navigate between sibling routes, and the active tab is derived from the pathname.
 *
 * Rendering the same strip on the hub landing AND on each child page turns a set of
 * standalone registers into one coherent tabbed shell without moving any route or
 * touching navigation.ts. Drawn as the kit's 40px underline tabs (merit-ui `.tabs`).
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';

interface HubTabDef {
  href: string;
  label: string;
  /** Extra pathnames that should light this tab (e.g. redirected standalones). */
  aliases?: string[];
}

const SECTIONS: Record<'assets' | 'tax', { hub: string; tabs: HubTabDef[] }> = {
  assets: {
    hub: '/assets',
    tabs: [
      { href: '/assets', label: 'Overview' },
      { href: '/fixed-assets', label: 'Fixed assets' },
      { href: '/leases', label: 'Leases' },
      { href: '/prepaids', label: 'Prepaids' },
      { href: '/insurance', label: 'Insurance' },
      { href: '/intangibles', label: 'Intangibles' },
      { href: '/tax-depreciation', label: 'Tax depreciation' },
    ],
  },
  tax: {
    hub: '/tax',
    tabs: [
      { href: '/tax', label: 'Overview' },
      { href: '/book-to-tax', label: 'Book-to-Tax M-1' },
      { href: '/tax-provision', label: 'Tax provision' },
      {
        href: '/tax/sales-tax',
        label: 'Sales tax',
        aliases: ['/sales-tax-return', '/sales-tax-calendar'],
      },
      { href: '/tax-package', label: 'Tax return package' },
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
    <nav className="tabs mb-hub-tabs" aria-label="Sections">
      {tabs.map((t) => {
        const active = isActive(t);
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? 'page' : undefined}
            // Link tabs: books.css gives [aria-current=page] the kit's selected treatment.
            className="tab"
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}

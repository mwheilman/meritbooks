'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * Payables → Bills section tabs (kit underline tabs). Link-based (not state-based) so
 * every child route stays a real, deep-linkable page with its own RBAC guard. Also
 * rendered by /retainage (still on the legacy bridge) — kit classes render there too.
 */
interface Tab {
  href: string;
  label: string;
}

const TABS: Tab[] = [
  { href: '/bills', label: 'All bills' },
  { href: '/bills/intake-queue', label: 'Intake' },
  { href: '/retainage', label: 'Retainage' },
  { href: '/bills/policy', label: 'AP policy' },
];

export function BillsTabs() {
  const pathname = usePathname();

  return (
    <nav className="tabs mb-section-tabs" aria-label="Bills">
      {TABS.map((t) => {
        const active = pathname === t.href;
        return (
          <Link key={t.href} href={t.href} className="tab" aria-current={active ? 'page' : undefined}>
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}

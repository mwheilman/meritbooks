'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * Payables → Expenses & Cards section tabs (kit underline tabs). Link-based so each
 * child route stays a real, deep-linkable page with its own RBAC guard. Also rendered
 * by /expenses/policy (still on the legacy bridge) — kit classes render there too.
 */
interface Tab {
  href: string;
  label: string;
}

const TABS: Tab[] = [
  { href: '/expenses', label: 'Expenses & cards' },
  { href: '/expenses/policy', label: 'Expense policy' },
];

export function ExpensesTabs() {
  const pathname = usePathname();

  return (
    <nav className="tabs mb-section-tabs" aria-label="Expenses">
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

'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { clsx } from 'clsx';
import { Receipt, Sparkles, PiggyBank, ScrollText, type LucideIcon } from 'lucide-react';

/**
 * Payables → Bills section tabs. Link-based (not state-based) so every child route
 * stays a real, deep-linkable page with its own RBAC guard. Visual matches the
 * reconciliation pill pattern for consistency.
 */
interface Tab {
  href: string;
  label: string;
  icon: LucideIcon;
}

const TABS: Tab[] = [
  { href: '/bills', label: 'All Bills', icon: Receipt },
  { href: '/bills/intake-queue', label: 'Intake', icon: Sparkles },
  { href: '/retainage', label: 'Retainage', icon: PiggyBank },
  { href: '/bills/policy', label: 'AP Policy', icon: ScrollText },
];

export function BillsTabs() {
  const pathname = usePathname();

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {TABS.map((t) => {
        const active = pathname === t.href;
        const Icon = t.icon;
        return (
          <Link
            key={t.href}
            href={t.href}
            className={clsx(
              'inline-flex items-center gap-1.5 rounded-lg border px-3.5 py-2 text-sm font-medium transition-colors',
              active
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                : 'border-slate-800 bg-slate-800/30 text-slate-400 hover:text-slate-200',
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            {t.label}
          </Link>
        );
      })}
    </div>
  );
}

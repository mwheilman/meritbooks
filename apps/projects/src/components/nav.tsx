'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LayoutDashboard, Users, FileText, Hammer, CalendarDays, Receipt, Coins, PackageCheck, Wallet } from 'lucide-react';
import clsx from 'clsx';

// Sections light up as their gates ship. Live: Dashboard, Jobs, Schedule, Costs,
// Procurement, Billing (G4/G5/G6/G7). Soon: Leads (G2), Estimates (G3).
const ITEMS = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard, ready: true },
  { href: '/jobs', label: 'Jobs', icon: Hammer, ready: true },
  { href: '/schedule', label: 'Schedule', icon: CalendarDays, ready: true },
  { href: '/procurement', label: 'Procurement', icon: PackageCheck, ready: true },
  { href: '/costs', label: 'Costs', icon: Coins, ready: true },
  { href: '/billing', label: 'Billing', icon: Receipt, ready: true },
  { href: '/allowances', label: 'Allowances', icon: Wallet, ready: true },
  { href: '/leads', label: 'Leads', icon: Users, ready: false },
  { href: '/estimates', label: 'Estimates', icon: FileText, ready: false },
];

export function Nav() {
  const pathname = usePathname();
  return (
    <nav className="w-60 shrink-0 border-r border-surface-800 bg-surface-900 p-4 flex flex-col gap-1">
      <div className="px-2 py-3 mb-2">
        <div className="text-heading font-semibold text-white">MeritProjects</div>
        <div className="text-2xs uppercase tracking-wider text-slate-500">Merit Enterprise Suite</div>
      </div>
      {ITEMS.map(({ href, label, icon: Icon, ready }) => {
        const active = pathname === href;
        return (
          <Link
            key={href}
            href={ready ? href : '#'}
            aria-disabled={!ready}
            className={clsx(
              'flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors',
              active ? 'bg-brand-500/10 text-brand-300' : 'text-slate-300 hover:bg-surface-800',
              !ready && 'opacity-40 pointer-events-none',
            )}
          >
            <Icon className="h-4 w-4" />
            <span>{label}</span>
            {!ready && <span className="ml-auto text-2xs text-slate-500">soon</span>}
          </Link>
        );
      })}
    </nav>
  );
}

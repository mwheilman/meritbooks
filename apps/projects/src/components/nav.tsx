'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LayoutDashboard, Users, FileText, Hammer, CalendarDays, Receipt } from 'lucide-react';
import clsx from 'clsx';

// G0' shell. Sections are placeholders that light up as their gates ship
// (G2 Leads, G3 Estimates, G4 Jobs, G6 Schedule, G7 Billing).
const ITEMS = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard, ready: true },
  { href: '/leads', label: 'Leads', icon: Users, ready: false },
  { href: '/estimates', label: 'Estimates', icon: FileText, ready: false },
  { href: '/jobs', label: 'Jobs', icon: Hammer, ready: false },
  { href: '/schedule', label: 'Schedule', icon: CalendarDays, ready: false },
  { href: '/billing', label: 'Billing', icon: Receipt, ready: false },
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

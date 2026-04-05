'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronLeft, Sparkles } from 'lucide-react';
import { clsx } from 'clsx';
import { navigation } from '@/lib/navigation';

export function Sidebar() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);

  return (
    <aside
      className={clsx(
        'flex flex-col border-r border-slate-800 bg-surface-950 transition-all duration-200',
        collapsed ? 'w-16' : 'w-[var(--sidebar-width)]'
      )}
    >
      {/* Logo */}
      <div className="flex h-[var(--header-height)] items-center justify-between px-4 border-b border-slate-800">
        {!collapsed && (
          <Link href="/dashboard" className="flex items-center gap-2">
            <div className="h-7 w-7 rounded-lg bg-brand-500 flex items-center justify-center">
              <span className="text-xs font-bold text-white">M</span>
            </div>
            <span className="text-sm font-semibold text-white tracking-tight">
              Merit<span className="text-brand-400">Books</span>
            </span>
          </Link>
        )}
        {collapsed && (
          <div className="mx-auto h-7 w-7 rounded-lg bg-brand-500 flex items-center justify-center">
            <span className="text-xs font-bold text-white">M</span>
          </div>
        )}
        <button
          onClick={() => setCollapsed(!collapsed)}
          className={clsx(
            'text-slate-500 hover:text-slate-300 transition-colors',
            collapsed && 'mx-auto mt-2'
          )}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <ChevronLeft
            size={16}
            className={clsx('transition-transform', collapsed && 'rotate-180')}
          />
        </button>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto py-3 px-2">
        {navigation.map((group) => (
          <div key={group.label} className="mb-4">
            {!collapsed && (
              <p className="px-3 mb-1 text-2xs font-semibold uppercase tracking-wider text-slate-500">
                {group.label}
              </p>
            )}
            <ul className="space-y-0.5">
              {group.items.map((item) => {
                const isActive = pathname === item.href || pathname.startsWith(item.href + '/');
                const Icon = item.icon;
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className={clsx(
                        'flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors',
                        isActive
                          ? 'bg-brand-500/10 text-brand-400 font-medium'
                          : 'text-slate-400 hover:text-slate-200 hover:bg-white/[0.03]',
                        collapsed && 'justify-center px-0'
                      )}
                      title={collapsed ? item.label : undefined}
                    >
                      <Icon size={18} className="shrink-0" />
                      {!collapsed && <span>{item.label}</span>}
                      {!collapsed && item.badge && (
                        <span className="ml-auto badge-warning">{item.badge}</span>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      {/* CPA Desk trigger */}
      {!collapsed && (
        <div className="p-3 border-t border-slate-800">
          <button className="w-full flex items-center gap-2 rounded-lg px-3 py-2.5 text-sm text-slate-400 hover:text-brand-400 hover:bg-brand-500/5 transition-colors">
            <Sparkles size={16} className="text-brand-500" />
            <span>CPA Desk</span>
            <kbd className="ml-auto text-2xs text-slate-600 bg-slate-800 px-1.5 py-0.5 rounded">⌘K</kbd>
          </button>
        </div>
      )}
    </aside>
  );
}

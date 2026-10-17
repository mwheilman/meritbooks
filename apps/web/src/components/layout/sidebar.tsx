'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronLeft, Sparkles } from 'lucide-react';
import { clsx } from 'clsx';
import { navigation } from '@/lib/navigation';
import { usePlane } from '@/lib/hooks/use-plane';
import { PLANES } from '@/lib/planes';
import { useActiveCompany } from '@/lib/hooks/use-active-company';
import { useMe } from '@/lib/hooks/use-me';
import { filterNavByPermissions } from '@/components/layout/nav-permissions';
import { BrandLockup, BrandMonogram } from '@/components/brand/brand-mark';
import { getTenantBrand } from '@/lib/brand/tenant-brand';

export function Sidebar() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const { plane } = usePlane();
  const { isAll } = useActiveCompany();
  const { permissions, can } = useMe();
  // Control: in the Book-of-Record plane the processing nav stays hidden until a
  // specific company is selected, so a bookkeeper can never start working (or land
  // on a page) without first choosing the account. Only Home (the consolidated
  // dashboard) shows; general account settings live in the header user menu. Admin
  // planes (practice/platform) are cross-company by design and are not gated.
  const mustSelectCompany = plane === 'books' && isAll;
  const activeGroups = PLANES[plane].groups;
  // Do we have USABLE per-feature grants for this user? /api/me populates
  // featurePermissions with the full FEATURE_CATALOG for the 9 system roles (so a real
  // role always has keys); it is EMPTY while loading, on error, or for a custom role
  // whose grants aren't enumerated client-side. In those cases we fall back to showing
  // everything (fail-safe) — the server-side page/route guards still fail closed, so nav
  // is a usability lens, never the security boundary. See nav-permissions.ts.
  const hasPermissionData =
    permissions !== null &&
    Object.keys(permissions.featurePermissions).length > 0;
  // 1) plane filter (which hat)  2) company-selection gate  3) role permission filter.
  const visibleNav = filterNavByPermissions(
    navigation
      .filter((g) => activeGroups.includes(g.label))
      .filter((g) => !mustSelectCompany || g.label === 'Home'),
    { hasPermissionData, canView: (featureId) => can(featureId, 'view') },
  );
  const PlaneIcon = PLANES[plane].icon;
  const brand = getTenantBrand();

  return (
    <aside
      className={clsx(
        // Navy shell (Merit 25% navy). Colors come from `shell-*` tokens so a
        // white-label tenant re-skins via CSS variables only.
        'flex flex-col border-r border-shell-line bg-shell text-shell-mid transition-all duration-200',
        collapsed ? 'w-16' : 'w-[var(--sidebar-width)]'
      )}
    >
      {/* Logo */}
      <div className="flex h-[var(--header-height)] items-center justify-between px-4 border-b border-shell-line">
        {!collapsed && (
          <Link
            href="/dashboard"
            className="flex items-center rounded-brand focus:outline-none focus-visible:ring-2 focus-visible:ring-shell-accent"
            aria-label={brand.productName}
          >
            {/* On dark: white wordmark + blue monogram (brand guide). */}
            <BrandLockup tone="onDark" size={26} />
          </Link>
        )}
        {collapsed && <BrandMonogram size={24} keyline className="mx-auto" />}
        <button
          onClick={() => setCollapsed(!collapsed)}
          className={clsx(
            'rounded p-0.5 text-shell-dim hover:text-shell-fg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-shell-accent',
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

      {/* Active plane indicator — which hat you're wearing */}
      {!collapsed && (
        <div className="mx-2 mt-3 mb-1 flex items-center gap-2 rounded-brand bg-shell-raised border border-shell-line px-3 py-2">
          <PlaneIcon size={15} className="text-shell-accent shrink-0" />
          <div className="min-w-0">
            <p className="text-xs font-semibold text-shell-fg leading-tight truncate">{PLANES[plane].label}</p>
            <p className="text-2xs text-shell-dim leading-tight truncate">{PLANES[plane].tagline}</p>
          </div>
        </div>
      )}

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto py-3 px-2">
        {visibleNav.map((group) => (
          <div key={group.label} className="mb-4">
            {!collapsed && (
              <p className="px-3 mb-1.5 font-mono text-2xs font-medium uppercase tracking-eyebrow text-shell-dim">
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
                        'relative flex items-center gap-3 rounded-brand px-3 py-2 text-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-shell-accent',
                        isActive
                          ? // Active: white label on a blue-tinted fill + Electric Blue rail.
                            'bg-accent-bright/[0.16] text-shell-fg font-medium before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-[3px] before:rounded-full before:bg-accent'
                          : 'text-shell-mid hover:text-shell-fg hover:bg-white/[0.06]',
                        collapsed && 'justify-center px-0'
                      )}
                      title={collapsed ? item.label : undefined}
                    >
                      <Icon size={18} className={clsx('shrink-0', isActive && 'text-shell-accent')} />
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
        {mustSelectCompany && !collapsed && (
          <div className="mx-2 mt-2 rounded-brand border border-shell-line bg-shell-raised px-3 py-3">
            <p className="text-xs font-semibold text-shell-fg">Select a company</p>
            <p className="mt-1 text-2xs leading-snug text-shell-mid">
              Choose a company in the top bar to open its workspace. Processing is
              scoped to one company at a time so nothing posts to the wrong account.
            </p>
          </div>
        )}
      </nav>

      {/* CPA Desk trigger */}
      {!collapsed && (
        <div className="p-3 border-t border-shell-line">
          <button className="w-full flex items-center gap-2 rounded-brand px-3 py-2.5 text-sm text-shell-mid hover:text-shell-fg hover:bg-white/[0.06] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-shell-accent">
            <Sparkles size={16} className="text-shell-accent" />
            <span>CPA Desk</span>
            <kbd className="ml-auto font-mono text-2xs text-shell-dim bg-white/[0.06] border border-shell-line px-1.5 py-0.5 rounded">⌘K</kbd>
          </button>
        </div>
      )}
    </aside>
  );
}

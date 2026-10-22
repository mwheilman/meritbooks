import { describe, it, expect } from 'vitest';
import type { NavGroup, NavItem } from '@/lib/navigation';
import {
  NAV_HREF_FEATURE,
  ALWAYS_VISIBLE_GROUPS,
  featureForHref,
  isNavItemVisible,
  filterNavByPermissions,
} from '@/components/layout/nav-permissions';

// Minimal fixtures — the icon (a merit-ui sprite name) is irrelevant to the pure visibility logic.
const groups: NavGroup[] = [
  {
    label: 'Home',
    items: [
      { label: 'Dashboard', href: '/dashboard', icon: 'home' },
      { label: 'Inbox', href: '/inbox', icon: 'home' },
    ],
  },
  {
    label: 'Payables',
    items: [
      { label: 'Bills', href: '/bills', icon: 'home' }, // → bills
      { label: 'Receipts', href: '/receipts', icon: 'home' }, // → receipts
      { label: 'Widget', href: '/some-unmapped-route', icon: 'home' }, // unmapped
    ],
  },
  {
    label: 'Reporting & Analytics',
    items: [
      { label: 'Reports', href: '/reports', icon: 'home' }, // → reports
    ],
  },
];

describe('NAV_HREF_FEATURE / featureForHref', () => {
  it('maps known hrefs to their FEATURE_CATALOG feature id', () => {
    expect(featureForHref('/bills')).toBe('bills');
    expect(featureForHref('/reports')).toBe('reports');
    expect(featureForHref('/settings/roles')).toBe('user_permissions');
    expect(NAV_HREF_FEATURE['/bank-feed']).toBe('bank_feed');
  });

  it('returns null for an unmapped href (treated as not-gated → shown)', () => {
    expect(featureForHref('/some-unmapped-route')).toBeNull();
    // Home hrefs are intentionally unmapped — Home is always-visible instead.
    expect(featureForHref('/dashboard')).toBeNull();
  });
});

describe('isNavItemVisible — fail-safe rules', () => {
  const item: NavItem = { label: 'Bills', href: '/bills', icon: 'home' };

  it('shows a gated item when the role has view', () => {
    expect(
      isNavItemVisible(item, { hasPermissionData: true, canView: () => true }),
    ).toBe(true);
  });

  it('hides a gated item when the role lacks view AND data is usable', () => {
    expect(
      isNavItemVisible(item, { hasPermissionData: true, canView: () => false }),
    ).toBe(false);
  });

  it('fail-safe: shows a gated item when permission data is unusable', () => {
    expect(
      isNavItemVisible(item, { hasPermissionData: false, canView: () => false }),
    ).toBe(true);
  });

  it('fail-safe: shows an unmapped item even with usable data denying everything', () => {
    const unmapped: NavItem = { label: 'Widget', href: '/some-unmapped-route', icon: 'home' };
    expect(
      isNavItemVisible(unmapped, { hasPermissionData: true, canView: () => false }),
    ).toBe(true);
  });
});

describe('filterNavByPermissions — group visibility', () => {
  it('keeps only granted items and drops fully-hidden non-Home groups', () => {
    // A role that can view bills/receipts but NOT reports.
    const canView = (f: string) => f === 'bills' || f === 'receipts';
    const result = filterNavByPermissions(groups, { hasPermissionData: true, canView });

    const labels = result.map((g) => g.label);
    expect(labels).toContain('Home');
    expect(labels).toContain('Payables');
    // Reporting group's only item (reports) is denied → whole group dropped.
    expect(labels).not.toContain('Reporting & Analytics');

    const payables = result.find((g) => g.label === 'Payables')!;
    // Bills + Receipts granted, plus the unmapped Widget (always shown) = 3.
    expect(payables.items.map((i) => i.href)).toEqual([
      '/bills',
      '/receipts',
      '/some-unmapped-route',
    ]);
  });

  it('never filters the Home group and never drops it, even when everything is denied', () => {
    const result = filterNavByPermissions(groups, {
      hasPermissionData: true,
      canView: () => false,
    });
    const home = result.find((g) => g.label === 'Home');
    expect(home).toBeDefined();
    expect(home!.items).toHaveLength(2); // Dashboard + Inbox untouched
    // Only Home survives (Payables' unmapped Widget still shows, so Payables also
    // survives; Reporting is dropped). Assert Home is always present regardless.
    expect(ALWAYS_VISIBLE_GROUPS).toContain('Home');
  });

  it('still permission-filters a MAPPED item placed in Home (Close → close_mgmt), never dropping the group', () => {
    const withClose: NavGroup[] = [
      {
        label: 'Home',
        items: [
          { label: 'Home', href: '/dashboard', icon: 'home' },
          { label: 'Close', href: '/close', icon: 'check' }, // → close_mgmt
        ],
      },
    ];
    const denied = filterNavByPermissions(withClose, { hasPermissionData: true, canView: () => false });
    expect(denied.map((g) => g.label)).toEqual(['Home']);
    expect(denied[0].items.map((i) => i.href)).toEqual(['/dashboard']);
    const granted = filterNavByPermissions(withClose, { hasPermissionData: true, canView: (f) => f === 'close_mgmt' });
    expect(granted[0].items.map((i) => i.href)).toEqual(['/dashboard', '/close']);
  });

  it('fail-safe: shows all groups/items when permission data is unusable (loading/error/custom role)', () => {
    const result = filterNavByPermissions(groups, {
      hasPermissionData: false,
      canView: () => false,
    });
    expect(result.map((g) => g.label)).toEqual([
      'Home',
      'Payables',
      'Reporting & Analytics',
    ]);
    expect(result[1].items).toHaveLength(3); // Payables untouched
  });
});

/**
 * ROLE-BASED SIDEBAR VISIBILITY (audit #346/#406; canon GATE 10 "RBAC nav enforcement").
 *
 * A pure, deterministic layer that filters the sidebar to only the nav items whose
 * feature the signed-in user has `view` on. It sits ON TOP of the existing plane
 * filter (lib/planes.ts) — plane decides "which hat", this decides "what this role may
 * actually see."
 *
 * ── Source of truth ──────────────────────────────────────────────────────────────
 * The permission decision reuses the SAME (feature, action) grants the server guards
 * consult. On the client those grants are already loaded via useMe() →
 * `permissions.featurePermissions` (Record<featureId, Record<action, boolean>>), which
 * /api/me builds from the RBAC spine for the caller's role. We never invent a second
 * source; the sidebar just asks "does this role have view on the feature this href maps
 * to?" through the caller-supplied `canView` probe.
 *
 * ── Route → feature map ──────────────────────────────────────────────────────────
 * There is no single canonical href→feature table in the spine (the legacy
 * permissions.ts `SIDEBAR_ITEMS` predates the session-47 IA and uses different hrefs),
 * so we keep a small deterministic map here keyed by the exact nav href, covering the
 * hrefs that have a clear FEATURE_CATALOG feature. Any href NOT in the map is treated as
 * "not gated" and always shown — see FAIL-SAFE below.
 *
 * ── FAIL SAFE, not fail open ─────────────────────────────────────────────────────
 * The sidebar is NOT the security boundary — `requirePagePermission` (page-guard) and
 * `requirePermission` (route-guard) both fail CLOSED on the server, so a user who should
 * not reach a page is redirected/403'd there regardless of what the nav shows. Given
 * that, the nav optimizes for USABILITY: it must never hide a page a legitimate user can
 * actually open just because a permission payload was slow, errored, or is expressed in a
 * vocabulary the client can't read. Concretely we SHOW an item when:
 *   1. permission data is absent/unusable (still loading, fetch failed, OR a CUSTOM role
 *      whose per-feature grants aren't enumerated in the client payload — detected as an
 *      empty featurePermissions map). Hiding on a hiccup would strand a real user.
 *   2. the item's href has no feature mapping (not a gated area).
 * We only HIDE when we have usable permission data AND a mapped feature AND the role
 * lacks `view` on it. Overrides that further RESTRICT are still enforced server-side; the
 * worst a stale/base-layer client grant can do here is show one extra link the server
 * then refuses — never hide a reachable one.
 */

import type { NavGroup, NavItem } from '@/lib/navigation';

/**
 * Exact nav href → RBAC feature id (from FEATURE_CATALOG in lib/rbac/permissions.ts).
 * Only hrefs with a confident feature mapping are listed. Unmapped hrefs are always
 * shown (fail-safe). Keep keys in sync with lib/navigation.ts hrefs.
 */
export const NAV_HREF_FEATURE: Record<string, string> = {
  // Home — intentionally omitted; the Home group is always visible (see ALWAYS_VISIBLE_GROUPS).

  // Payables
  '/bills': 'bills',
  '/receipts': 'receipts',
  '/purchase-orders': 'bills',
  '/checks': 'checks',
  '/payroll': 'payroll',
  '/vendors': 'vendors',
  '/vendor-compliance': 'compliance',

  // Receivables
  '/invoices': 'invoices',
  '/estimates': 'invoices',
  '/customer-deposits': 'invoices',
  '/borrowing-base': 'reports',
  '/collections': 'invoices',
  '/customers': 'customers',
  '/rev-rec': 'invoices',

  // Banking & Cash
  '/bank-feed': 'bank_feed',
  '/reconciliation': 'reconciliation',
  '/cash': 'cash_position',

  // Accounting
  '/journal-entries': 'journal_entries',
  '/chart-of-accounts': 'chart_of_accounts',
  '/assets': 'fixed_assets',
  '/periods': 'close_mgmt',
  '/close': 'close_mgmt',

  // Reporting & Analytics
  '/reports': 'reports',
  '/fpna': 'reports',
  '/budgets': 'reports',
  '/profitability': 'reports',
  '/consolidation': 'reports',
  '/board-package': 'reports',

  // Firm & Governance
  '/jobs': 'jobs',
  '/jobs/wip': 'jobs',
  '/internal-invoices': 'intercompany',
  '/compliance': 'compliance',
  '/audit': 'audit_trail',
  '/team': 'team',

  // Settings & Admin
  '/settings/billing': 'settings_system',
  '/settings/payments': 'settings_system',
  '/settings/approvals': 'settings_system',
  '/settings/roles': 'user_permissions',
  '/settings/autonomy': 'settings_system',
  '/integrations/erp': 'settings_system',
  '/import': 'import',
  '/onboarding/conversion': 'import',
  '/operations': 'settings_system',
  '/settings': 'settings_acct',
};

/**
 * Groups that are ALWAYS shown in full, regardless of permissions. Home (Dashboard +
 * Inbox) is visible to every internal role and is the safe landing spot the page-guard
 * redirects to, so it must never be filtered out (also guarantees the sidebar is never
 * empty). Platform is not listed here — it is already gated to platform staff by the
 * plane filter (lib/planes.ts) upstream of this helper.
 */
export const ALWAYS_VISIBLE_GROUPS: readonly string[] = ['Home'];

/** The exact FEATURE_CATALOG feature id a nav href maps to, or null if unmapped. */
export function featureForHref(href: string): string | null {
  return NAV_HREF_FEATURE[href] ?? null;
}

/** Probe supplied by the caller (from useMe().can) — does the role have `view` on feature? */
export type ViewProbe = (featureId: string) => boolean;

export interface NavVisibilityOpts {
  /**
   * True only when the client actually has usable per-feature grants for this user.
   * False while loading, on fetch error, or for a custom role whose grants aren't
   * enumerated client-side → everything shows (fail-safe).
   */
  hasPermissionData: boolean;
  /** Returns true iff the user has `view` on the given feature id. */
  canView: ViewProbe;
}

/** Is a single nav item visible? Fail-safe: unusable data OR unmapped href → visible. */
export function isNavItemVisible(item: NavItem, opts: NavVisibilityOpts): boolean {
  if (!opts.hasPermissionData) return true; // fail-safe: no usable data → show
  const feature = featureForHref(item.href);
  if (!feature) return true; // not a gated area → show
  return opts.canView(feature);
}

/**
 * Filter a list of nav groups by the user's effective view permissions.
 *  - Items in an ALWAYS_VISIBLE group pass through untouched.
 *  - Other groups keep only their visible items.
 *  - A group with zero visible items is dropped — UNLESS it is always-visible.
 * Pure and order-preserving.
 */
export function filterNavByPermissions(
  groups: NavGroup[],
  opts: NavVisibilityOpts,
): NavGroup[] {
  return groups
    .map((group) => {
      if (ALWAYS_VISIBLE_GROUPS.includes(group.label)) return group;
      const items = group.items.filter((item) => isNavItemVisible(item, opts));
      return { ...group, items };
    })
    .filter(
      (group) =>
        ALWAYS_VISIBLE_GROUPS.includes(group.label) || group.items.length > 0,
    );
}

/**
 * LEGACY BRIDGE — the page registry and the shrinking ratchet (TEMPORARY).
 *
 * Books is moving page by page from the old dark/emerald theme onto the Merit
 * Suite design system (packages/merit-ui, Style Guide v2.3). Until a page is
 * rebuilt it is rendered inside `.legacy-page` (see <LegacyScope>), where
 * src/styles/legacy-bridge.css + tailwind.legacy.config.ts re-point its old
 * utilities (bg-surface-900, text-slate-400, emerald-*, rounded-xl …) at Merit
 * tokens, so it already reads as Merit: light surfaces, Midnight ink, Electric
 * accents, square geometry.
 *
 * ── How a page leaves the bridge ─────────────────────────────────────────────
 *   1. Rebuild it on merit-ui (kit classes / components; strict-preset utilities
 *      only; no lucide, no font-mono, no emerald, no rounded-*).
 *   2. Move its route pattern from LEGACY_ROUTES to PORTED_ROUTES.
 *   3. Lower LEGACY_BASELINE by the same amount.
 * src/test/legacy-bridge.test.ts enforces all three: every page file under
 * src/app is listed in exactly one list, ported pages contain no legacy
 * vocabulary, and the legacy count can only go down.
 *
 * ── Rules ─────────────────────────────────────────────────────────────────────
 *   - Unknown routes default to the bridge (safe: they get the Merit remap).
 *   - Shared shell/kit components must NOT rely on Tailwind spacing/colour
 *     utilities: inside a bridged page those carry their legacy meaning. Use kit
 *     classes and src/styles/books.css instead.
 *   - Content portalled to <body> leaves the scope; legacy content that portals
 *     (hover peek) wraps itself in `.legacy-page`.
 *
 * Route patterns are the app-router page paths with route groups removed:
 * `[id]` = one segment, `[...x]` = one or more, `[[...x]]` = zero or more.
 */

/** Pages fully rebuilt on merit-ui — rendered WITHOUT the bridge. */
export const PORTED_ROUTES: readonly string[] = [
  '/dashboard',
  '/inbox',
  '/invoices/design',
  '/pay/[token]',
  '/settings/payments',
  '/settings/payments/refresh',
  '/settings/payments/return',
  '/sign-in/[[...sign-in]]',
  // Wave 1D — request engine + notifications (built on the kit)
  '/requests',
  '/r/[token]',
  '/r/[token]/unsubscribe',
];

/**
 * Pages still on the bridge. Sorted. The test fails if a page file exists that is
 * in neither list (a new page must be built on the kit, or consciously listed here).
 */
export const LEGACY_ROUTES: readonly string[] = [
  '/',
  '/agents',
  '/ai-decisions',
  '/assets',
  '/audit',
  '/bank-feed',
  '/bills',
  '/bills/intake-queue',
  '/bills/policy',
  '/board-package',
  '/book-to-tax',
  '/borrowing-base',
  '/budgets',
  '/budgets/drivers',
  '/budgets/reforecast',
  '/cash',
  '/cash-application',
  '/categorize',
  '/chart-of-accounts',
  '/checks',
  '/close',
  '/close-status',
  '/collections',
  '/compliance',
  '/compliance-1099',
  '/consolidation',
  '/controls',
  '/covenants',
  '/credit-cards',
  '/customer-deposits',
  '/customers',
  '/dealer',
  '/dealer/deals',
  '/dealer/deals/[saleId]',
  '/dealer/floor-plan',
  '/dealer/floor-plan/notes/[id]',
  '/dealer/imports',
  '/dealer/imports/[id]',
  '/dealer/incentives',
  '/dealer/lender-statements',
  '/dealer/lender-statements/[id]',
  '/dealer/oem-statements',
  '/dealer/oem-statements/[id]',
  '/dealer/reports',
  '/dealer/settings',
  '/dealer/units',
  '/dealer/units/[id]',
  '/dealer/warranty',
  '/debt',
  '/departments',
  '/documents',
  '/estimates',
  '/exceptions',
  '/expenses',
  '/expenses/policy',
  '/fixed-assets',
  '/flagged',
  '/forecast',
  '/fpna',
  '/import',
  '/insurance',
  '/intangibles',
  '/integrations/erp',
  '/intercompany',
  '/internal-invoices',
  '/inventory',
  '/inventory/[id]',
  '/inventory/valuation',
  '/invoices',
  '/invoices/collections',
  '/jobs',
  '/jobs/[id]',
  '/jobs/wip',
  '/journal-entries',
  '/leases',
  '/no-access',
  '/obligations',
  '/onboarding',
  '/onboarding/conversion',
  '/onboarding/portfolio',
  '/onboarding/reconciliation',
  '/onboarding/sections/[section]',
  '/onboarding/sections/equity',
  '/onboarding/tour',
  '/operations',
  '/payroll',
  '/pbc',
  '/periods',
  '/platform',
  '/portal/customer/[token]',
  '/portal/vendor/[token]',
  '/portfolio',
  '/portfolio/[locationId]',
  '/prepaids',
  '/profitability',
  '/purchase-orders',
  '/receipts',
  '/reconciliation',
  '/recurring',
  '/recurring-journal-entries',
  '/reports',
  '/reports/basis-adjustments',
  '/retainage',
  '/rev-rec',
  '/sales-tax-calendar',
  '/sales-tax-return',
  '/sandbox',
  '/search',
  '/settings',
  '/settings/access/log',
  '/settings/access/requests',
  '/settings/access/reviews',
  '/settings/approvals',
  '/settings/autonomy',
  '/settings/billing',
  '/settings/new-entity',
  '/settings/permissions',
  '/settings/roles',
  '/setup',
  '/sign-up/[[...sign-up]]',
  '/subscriptions',
  '/tax',
  '/tax-depreciation',
  '/tax-package',
  '/tax-provision',
  '/tax/sales-tax',
  '/team',
  '/vendor-compliance',
  '/vendors',
  '/year-end-close',
];

/**
 * The ratchet. LEGACY_ROUTES.length may never exceed this, and the test asks you
 * to lower it whenever a page is ported. It only ever goes DOWN.
 */
export const LEGACY_BASELINE = 130;

/** Compile a route pattern to a pathname matcher. */
export function routePatternToRegExp(pattern: string): RegExp {
  if (pattern === '/') return /^\/?$/;
  const body = pattern
    .split('/')
    .filter(Boolean)
    .map((seg) => {
      if (/^\[\[\.\.\.[^\]]+\]\]$/.test(seg)) return '(?:/.*)?';
      if (/^\[\.\.\.[^\]]+\]$/.test(seg)) return '/.+';
      if (/^\[[^\]]+\]$/.test(seg)) return '/[^/]+';
      return `/${seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`;
    })
    .join('');
  return new RegExp(`^${body}/?$`);
}

const PORTED_MATCHERS = PORTED_ROUTES.map(routePatternToRegExp);

/** True when the pathname belongs to a page fully rebuilt on merit-ui (no bridge). */
export function isPortedPath(pathname: string | null | undefined): boolean {
  const path = (pathname ?? '/').split(/[?#]/)[0] || '/';
  return PORTED_MATCHERS.some((re) => re.test(path));
}

/** The class that turns the bridge on for a subtree. */
export const LEGACY_SCOPE_CLASS = 'legacy-page';

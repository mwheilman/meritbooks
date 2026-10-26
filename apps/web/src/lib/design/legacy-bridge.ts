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
  '/settings/brand', // Brand from logo (FPB-branding)
  '/settings/automation', // Wave 2E
  '/reports/layouts', // Wave 3
  '/reports/chart-kit', // Wave 3
  '/reporting-calendar', // Wave 3
  '/settings/inbound-email', // Wave 2D
  '/settings/payments/refresh',
  '/settings/payments/return',
  '/sign-in/[[...sign-in]]',
  // Wave 1D — request engine + notifications (built on the kit)
  '/requests',
  '/r/[token]',
  '/r/[token]/unsubscribe',
  // Wave 2B — receipt capture & chase + Merit Workforce (receipts), built on the kit
  '/receipts',
  '/w',
  '/w/s/[token]',
  // Wave 2A — vendor W-9 / COI closed loop, built on the kit
  '/vendor-compliance',
  '/portal/vendor/[token]',
  // Document intelligence — the Documents center, rebuilt on the kit (FPB-document-intelligence)
  '/documents',
  // Wave 4C — cash workspace (position, 13-week forecast, scenarios, accuracy, settings), built on the kit
  '/cash',
  // Port batch 1 (Wave 4) — the most-used work screens, rebuilt on the kit
  '/bank-feed',
  '/bills',
  '/bills/intake-queue',
  '/cash-application',
  '/chart-of-accounts',
  '/collections',
  '/credit-cards',
  '/customers',
  '/expenses',
  '/invoices',
  '/invoices/collections',
  '/journal-entries',
  '/payroll',
  '/recurring-journal-entries',
  '/vendors',
  // Wave 4A — FP&A workspace on the metric registry + chart kit
  '/fpna',
  // Onboarding v2 part 1 — Migration Control Tower, client migration, team guide, mapping rules
  '/onboarding/migrations',
  '/onboarding/migrations/[projectId]',
  '/onboarding/migrations/[projectId]/team',
  '/onboarding/migrations/rules',
  // Projects seam part 2 — duplicate review queues + the Projects link page
  '/customers/duplicates',
  '/vendors/duplicates',
  '/jobs/projects-seam',
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
  '/bills/policy',
  '/board-package',
  '/book-to-tax',
  '/borrowing-base',
  '/budgets',
  '/budgets/drivers',
  '/budgets/reforecast',
  '/categorize',
  '/checks',
  '/close',
  '/close-status',
  '/compliance',
  '/compliance-1099',
  '/consolidation',
  '/controls',
  '/covenants',
  '/customer-deposits',
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
  '/estimates',
  '/exceptions',
  '/expenses/policy',
  '/fixed-assets',
  '/flagged',
  '/forecast',
  '/import',
  '/insurance',
  '/intangibles',
  '/integrations/erp',
  '/intercompany',
  '/internal-invoices',
  '/inventory',
  '/inventory/[id]',
  '/inventory/valuation',
  '/jobs',
  '/jobs/[id]',
  '/jobs/wip',
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
  '/pbc',
  '/periods',
  '/platform',
  '/portal/customer/[token]',
  '/portfolio',
  '/portfolio/[locationId]',
  '/prepaids',
  '/profitability',
  '/purchase-orders',
  '/reconciliation',
  '/recurring',
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
  '/year-end-close',
];

/**
 * The ratchet. LEGACY_ROUTES.length may never exceed this, and the test asks you
 * to lower it whenever a page is ported. It only ever goes DOWN.
 */
export const LEGACY_BASELINE = 109;

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

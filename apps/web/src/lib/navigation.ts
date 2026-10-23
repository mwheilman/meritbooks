import type { IconName } from '@meritbooks/merit-ui';

/**
 * One rail entry. `href` is the live route (route moves are a later slice — every
 * href here is unchanged from the session-47 IA). `icon` is a merit-ui sprite name,
 * used only by the collapsed (mini) rail; the full rail is text-only (§6 shell).
 */
export interface NavItem {
  label: string;
  href: string;
  icon: IconName;
  /** Open-work count/word shown on the rail (filled in by the shell, never static). */
  badge?: string;
  /** Go-to chord printed on hover and bound in the merit-ui hotkey registry ("g h"). */
  keys?: string;
  /** IA-SPEC §3.6.2: 'M' items sit behind the group's "More" fold until they hold work. */
  disclosure?: 'C' | 'M';
}

export interface NavGroup {
  label: string;
  items: NavItem[];
  /**
   * Industry pack gate: the group shows only when this pack is switched on for the
   * active client (e.g. 'dealer' → dealer_pack_settings.enabled). The pages still
   * guard themselves server-side; this only keeps the nav honest.
   */
  requiresPack?: 'dealer';
}

/** The nav group label for the Dealer Pack (industry module). */
export const DEALER_NAV_GROUP = 'Dealer';

/**
 * The rail, grouped and ordered toward IA-SPEC v2 §3.4–3.6 (Redesign R1).
 *
 * Group names and order follow the client-books tree (§3.6.1: Home · Banking ·
 * Payables · Receivables · Revenue & jobs · Cash & debt · Accounting · Planning &
 * reports · Controls), the tenant-workspace tree (§3.5: Clients · Team ·
 * Integrations · Settings) and the platform console (§3.4). Labels are sentence
 * case and use the glossary (§1.1: "client", never "entities"/"portfolio").
 *
 * HREFS ARE UNCHANGED — only grouping, order and labels moved. Many former entries
 * remain tabs inside a parent page (their routes stay live):
 *   - Inbox absorbs Needs Attention (/exceptions) + Flagged (/flagged).
 *   - Bills hosts Intake, Retainage, AP policy. Vendor compliance hosts 1099.
 *   - Bank feed hosts Credit cards + Apply deposits; Reconciliation the AR/GL tie-out.
 *   - Cash position hosts the 13-week forecast; Debt hosts Covenants.
 *   - Journal entries hosts Recurring; Close merges Status + Year-end.
 *   - Assets & schedules and Tax are hubs; Consolidation hosts Intercompany.
 *
 * Which plane (books / practice / platform) shows which group is lib/planes.ts.
 */
export const navigation: NavGroup[] = [
  // ── Client books (Books plane) ────────────────────────────────────────────────
  {
    label: 'Home',
    items: [
      { label: 'Home', href: '/dashboard', icon: 'home', keys: 'g h' },
      { label: 'Inbox', href: '/inbox', icon: 'flag', keys: 'g i' },
      { label: 'Close', href: '/close', icon: 'check', keys: 'g c' },
      { label: 'Requests', href: '/requests', icon: 'clock' },
    ],
  },
  {
    label: 'Banking',
    items: [
      { label: 'Bank feed', href: '/bank-feed', icon: 'dollar', keys: 'g b' },
      { label: 'Reconciliation', href: '/reconciliation', icon: 'check', keys: 'g r' },
    ],
  },
  {
    label: 'Payables',
    items: [
      { label: 'Bills', href: '/bills', icon: 'bill' },
      { label: 'Purchase orders', href: '/purchase-orders', icon: 'clipboard' },
      { label: 'Checks & payments', href: '/checks', icon: 'dollar' },
      { label: 'Expenses', href: '/expenses', icon: 'receipt' },
      { label: 'Receipts', href: '/receipts', icon: 'camera' },
      { label: 'Payroll', href: '/payroll', icon: 'users' },
      { label: 'Vendors', href: '/vendors', icon: 'building' },
      { label: 'Vendor compliance', href: '/vendor-compliance', icon: 'lock' },
    ],
  },
  {
    label: 'Receivables',
    items: [
      { label: 'Invoices', href: '/invoices', icon: 'file-text' },
      { label: 'Invoice design', href: '/invoices/design', icon: 'sliders' },
      { label: 'Estimates', href: '/estimates', icon: 'file-text' },
      { label: 'Customer deposits', href: '/customer-deposits', icon: 'dollar' },
      { label: 'Collections', href: '/collections', icon: 'clock' },
      { label: 'Customers', href: '/customers', icon: 'users' },
    ],
  },
  {
    label: 'Revenue & jobs',
    items: [
      { label: 'Revenue recognition', href: '/rev-rec', icon: 'calendar' },
      { label: 'Jobs', href: '/jobs', icon: 'hammer' },
      { label: 'WIP schedule', href: '/jobs/wip', icon: 'clipboard' },
      { label: 'Inventory', href: '/inventory', icon: 'box' },
    ],
  },
  {
    label: 'Cash & debt',
    items: [
      { label: 'Cash position', href: '/cash', icon: 'dollar' },
      { label: 'Renewals & obligations', href: '/obligations', icon: 'calendar' },
      { label: 'Debt & loans', href: '/debt', icon: 'building' },
      { label: 'Borrowing base', href: '/borrowing-base', icon: 'layers' },
      { label: 'Subscriptions', href: '/subscriptions', icon: 'history', disclosure: 'M' },
    ],
  },
  {
    label: 'Accounting',
    items: [
      { label: 'Journal entries', href: '/journal-entries', icon: 'book', keys: 'g j' },
      { label: 'Chart of accounts', href: '/chart-of-accounts', icon: 'grid' },
      { label: 'Assets & schedules', href: '/assets', icon: 'box' },
      { label: 'Internal invoices', href: '/internal-invoices', icon: 'file-text' },
      { label: 'Tax', href: '/tax', icon: 'file-text' },
      { label: 'Documents', href: '/documents', icon: 'file-text' },
      { label: 'Fiscal periods', href: '/periods', icon: 'calendar' },
      { label: 'Departments', href: '/departments', icon: 'users', disclosure: 'M' },
    ],
  },
  {
    label: DEALER_NAV_GROUP,
    requiresPack: 'dealer',
    items: [
      { label: 'Dealer home', href: '/dealer', icon: 'truck' },
      { label: 'Floor plan', href: '/dealer/floor-plan', icon: 'building' },
      { label: 'Units', href: '/dealer/units', icon: 'box' },
      { label: 'Deals & trade-ins', href: '/dealer/deals', icon: 'dollar' },
      { label: 'Lender statements', href: '/dealer/lender-statements', icon: 'file-text' },
      { label: 'Warranty claims', href: '/dealer/warranty', icon: 'wrench' },
      { label: 'Manufacturer incentives', href: '/dealer/incentives', icon: 'dollar', disclosure: 'M' },
      { label: 'Manufacturer statements', href: '/dealer/oem-statements', icon: 'file-text', disclosure: 'M' },
      { label: 'Dealer imports', href: '/dealer/imports', icon: 'upload', disclosure: 'M' },
      { label: 'Dealer reports', href: '/dealer/reports', icon: 'file-text' },
      { label: 'Dealer settings', href: '/dealer/settings', icon: 'sliders', disclosure: 'M' },
    ],
  },
  {
    label: 'Planning & reports',
    items: [
      { label: 'Reports', href: '/reports', icon: 'file-text' },
      { label: 'Board package', href: '/board-package', icon: 'file-text' },
      { label: 'Budgets', href: '/budgets', icon: 'sliders' },
      { label: 'FP&A', href: '/fpna', icon: 'sliders' },
      { label: 'Consolidation', href: '/consolidation', icon: 'layers' },
      { label: 'Profitability', href: '/profitability', icon: 'up', disclosure: 'M' },
      { label: 'Basis adjustments', href: '/reports/basis-adjustments', icon: 'sliders', disclosure: 'M' },
      { label: 'Search', href: '/search', icon: 'search', disclosure: 'M' },
    ],
  },
  {
    label: 'Controls',
    items: [
      { label: 'AI decision log', href: '/ai-decisions', icon: 'history' },
      { label: 'AI categorizer', href: '/categorize', icon: 'ask' },
      // Supervisors work in the Books plane day to day; the team's performance must be
      // reachable from there too, not only from Team & settings (live check 1G-4). Shown
      // only to roles with team:view (rail-model filters query-string hrefs by path).
      { label: 'Team performance', href: '/team?tab=performance', icon: 'up' },
      { label: 'Agents', href: '/agents', icon: 'ask', disclosure: 'M' },
    ],
  },

  // ── Tenant workspace (Practice plane) — oversight & settings only. No operational
  //    accounting: to see a client's jobs/WIP a supervisor switches into its books.
  {
    label: 'Clients',
    items: [
      { label: 'Clients', href: '/portfolio', icon: 'building' },
      { label: 'Add clients', href: '/onboarding/portfolio', icon: 'plus' },
      { label: 'Get started', href: '/onboarding', icon: 'plus' },
    ],
  },
  {
    label: 'Team',
    items: [
      { label: 'Team & access', href: '/team', icon: 'users' },
      { label: 'Roles & permissions', href: '/settings/roles', icon: 'lock' },
      { label: 'Access requests', href: '/settings/access/requests', icon: 'lock' },
      { label: 'Access reviews', href: '/settings/access/reviews', icon: 'eye' },
      { label: 'Access log', href: '/settings/access/log', icon: 'history' },
    ],
  },
  {
    label: 'Oversight',
    items: [
      { label: 'Compliance & controls', href: '/compliance', icon: 'check' },
      { label: 'Audit trail', href: '/audit', icon: 'history' },
      { label: 'Audit requests (PBC)', href: '/pbc', icon: 'clipboard' },
    ],
  },
  {
    label: 'Integrations',
    items: [
      { label: 'Integrations', href: '/integrations/erp', icon: 'plug' },
      { label: 'Import data', href: '/import', icon: 'upload' },
      { label: 'Historical conversion', href: '/onboarding/conversion', icon: 'upload' },
    ],
  },
  {
    label: 'Settings',
    items: [
      { label: 'Settings', href: '/settings', icon: 'sliders' },
      { label: 'Plan & billing', href: '/settings/billing', icon: 'dollar' },
      { label: 'Payments', href: '/settings/payments', icon: 'dollar' },
      { label: 'Approval workflows', href: '/settings/approvals', icon: 'check' },
      { label: 'AI autonomy', href: '/settings/autonomy', icon: 'sliders' },
      { label: 'Automation', href: '/settings/automation', icon: 'clock' },
      { label: 'Email inboxes', href: '/settings/inbound-email', icon: 'upload' },
      { label: 'Operations', href: '/operations', icon: 'wrench' },
    ],
  },

  // ── Platform console (platform staff only).
  {
    label: 'Platform',
    items: [{ label: 'Operator console', href: '/platform', icon: 'grid' }],
  },
];

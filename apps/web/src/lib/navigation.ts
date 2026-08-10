import {
  LayoutDashboard,
  Landmark,
  CreditCard,
  Receipt,
  FileText,
  BookOpen,
  Calculator,
  DollarSign,
  TrendingUp,
  BarChart3,
  Users,
  Contact,
  Building2,
  Network,
  ArrowLeftRight,
  Combine,
  Briefcase,
  ClipboardCheck,
  FileCheck,
  Settings,
  Shield,
  Wallet,
  Upload,
  CalendarDays,
  Percent,
  Sparkles,
  Wand2,
  History,
  Inbox,
  Activity,
  Banknote,
  Search,
  SlidersHorizontal,
  Scale,
  ShieldCheck,
  ClipboardList,
  Bot,
  LayoutGrid,
  Package,
  PiggyBank,
  type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  badge?: string;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

/**
 * Consolidated information architecture (session 47 redesign).
 *
 * The sidebar was reorganized from ~85 scattered entries across 7 loosely-named
 * groups into a smaller set of workflow-oriented groups that follow how an
 * accountant works a book of record: capture -> payables/receivables -> banking
 * -> ledger/close -> report -> govern -> set up.
 *
 * Many former top-level entries are now TABS inside a parent page or REDIRECT
 * into one, so they intentionally no longer appear here (their routes stay live):
 *   - Inbox absorbs Needs Attention (/exceptions) + Flagged (/flagged).
 *   - Bills hosts Intake, Retainage, AP Policy as tabs.
 *   - Vendor Compliance hosts 1099 Readiness. Expenses hosts Expense Policy.
 *   - Bank Feed hosts Credit Cards + Apply Deposits (cash application);
 *     Reconciliation hosts the AR/GL tie-out.
 *   - Cash Position hosts the 13-Week Forecast; Debt hosts Covenants.
 *   - Journal Entries hosts Recurring; Close merges Status + Year-End.
 *   - Assets & Schedules (/assets) hosts Fixed Assets/Leases/Prepaids/Insurance/
 *     Intangibles/Tax Depreciation. Tax (/tax) hosts Book-to-Tax/Provision/
 *     Sales Tax (return+calendar)/Tax Package. Consolidation hosts Intercompany.
 *   - Budgets hosts Driver Builder + Reforecast. Compliance hosts Controls/SOX.
 */
export const navigation: NavGroup[] = [
  {
    label: 'Home',
    items: [
      { label: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
      { label: 'Inbox', href: '/inbox', icon: Inbox },
    ],
  },
  {
    label: 'Payables',
    items: [
      { label: 'Bills', href: '/bills', icon: FileText },
      { label: 'Expenses', href: '/expenses', icon: Wallet },
      { label: 'Receipts', href: '/receipts', icon: Receipt },
      { label: 'Purchase Orders', href: '/purchase-orders', icon: ClipboardList },
      { label: 'Pay Runs', href: '/checks', icon: Banknote },
      { label: 'Payroll', href: '/payroll', icon: Users },
      { label: 'Vendors', href: '/vendors', icon: Building2 },
      { label: 'Vendor Compliance', href: '/vendor-compliance', icon: Shield },
    ],
  },
  {
    label: 'Receivables',
    items: [
      { label: 'Invoices', href: '/invoices', icon: DollarSign },
      { label: 'Estimates & Quotes', href: '/estimates', icon: FileText },
      { label: 'Collections', href: '/collections', icon: Contact },
      { label: 'Customers', href: '/customers', icon: Contact },
      { label: 'Customer Deposits', href: '/customer-deposits', icon: PiggyBank },
      { label: 'Revenue Recognition', href: '/rev-rec', icon: Percent },
    ],
  },
  {
    label: 'Banking & Cash',
    items: [
      { label: 'Bank Feed', href: '/bank-feed', icon: Landmark },
      { label: 'Reconciliation', href: '/reconciliation', icon: FileCheck },
      { label: 'Cash Position', href: '/cash', icon: Wallet },
      { label: 'Debt & Loans', href: '/debt', icon: Landmark },
      { label: 'Borrowing Base', href: '/borrowing-base', icon: Scale },
      { label: 'Renewals & Obligations', href: '/obligations', icon: CalendarDays },
      { label: 'Subscriptions', href: '/subscriptions', icon: CreditCard },
    ],
  },
  {
    label: 'Accounting',
    items: [
      { label: 'Journal Entries', href: '/journal-entries', icon: BookOpen },
      { label: 'Chart of Accounts', href: '/chart-of-accounts', icon: Calculator },
      { label: 'Assets & Schedules', href: '/assets', icon: Building2 },
      { label: 'Fiscal Periods', href: '/periods', icon: CalendarDays },
      { label: 'Close', href: '/close', icon: ClipboardCheck },
    ],
  },
  {
    label: 'Reporting & Analytics',
    items: [
      { label: 'Reports', href: '/reports', icon: BarChart3 },
      { label: 'Basis Adjustments', href: '/reports/basis-adjustments', icon: Scale },
      { label: 'FP&A Dashboard', href: '/fpna', icon: BarChart3 },
      { label: 'Budgets', href: '/budgets', icon: TrendingUp },
      { label: 'Profitability', href: '/profitability', icon: TrendingUp },
      { label: 'Consolidation', href: '/consolidation', icon: Combine },
      { label: 'Board Package', href: '/board-package', icon: FileText },
      { label: 'Search', href: '/search', icon: Search },
      { label: 'AI Decision Log', href: '/ai-decisions', icon: Sparkles },
      { label: 'AI Categorizer', href: '/categorize', icon: Wand2 },
      { label: 'Agents', href: '/agents', icon: Bot },
    ],
  },
  {
    label: 'Firm & Governance',
    items: [
      { label: 'Entities', href: '/portfolio', icon: LayoutGrid },
      { label: 'Jobs & Projects', href: '/jobs', icon: Briefcase },
      { label: 'Job WIP Schedule', href: '/jobs/wip', icon: ClipboardCheck },
      { label: 'Inventory', href: '/inventory', icon: Package },
      { label: 'Internal Invoices', href: '/internal-invoices', icon: ArrowLeftRight },
      { label: 'Departments', href: '/departments', icon: Network },
      { label: 'Tax', href: '/tax', icon: Scale },
      { label: 'Compliance & Controls', href: '/compliance', icon: ShieldCheck },
      { label: 'Audit Trail', href: '/audit', icon: History },
      { label: 'Audit Requests (PBC)', href: '/pbc', icon: ClipboardList },
      { label: 'Documents', href: '/documents', icon: FileText },
      { label: 'Team & Access', href: '/team', icon: Users },
    ],
  },
  {
    label: 'Settings & Admin',
    items: [
      { label: 'Get Started', href: '/onboarding', icon: Sparkles },
      { label: 'Plan & Billing', href: '/settings/billing', icon: CreditCard },
      { label: 'Payments', href: '/settings/payments', icon: CreditCard },
      { label: 'Approval Workflows', href: '/settings/approvals', icon: ClipboardCheck },
      { label: 'Roles & Permissions', href: '/settings/roles', icon: ShieldCheck },
      { label: 'AI Autonomy', href: '/settings/autonomy', icon: SlidersHorizontal },
      { label: 'Integrations', href: '/integrations/erp', icon: Network },
      { label: 'Import Data', href: '/import', icon: Upload },
      { label: 'Historical Conversion', href: '/onboarding/conversion', icon: Upload },
      { label: 'Operations', href: '/operations', icon: Activity },
      { label: 'Settings', href: '/settings', icon: Settings },
    ],
  },
  {
    label: 'Platform',
    items: [
      { label: 'Operator Console', href: '/platform', icon: Building2 },
    ],
  },
];

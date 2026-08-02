import {
  LayoutDashboard,
  Landmark,
  CreditCard,
  Receipt,
  FileText,
  AlertTriangle,
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
  PiggyBank,
  Lock,
  Sparkles,
  Wand2,
  FlaskConical,
  History,
  Inbox,
  Activity,
  Banknote,
  Search,
  SlidersHorizontal,
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

export const navigation: NavGroup[] = [
  {
    label: 'Overview',
    items: [
      { label: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
    ],
  },
  {
    label: 'Process',
    items: [
      { label: 'Needs Attention', href: '/exceptions', icon: Inbox },
      { label: 'Bank Feed', href: '/bank-feed', icon: Landmark },
      { label: 'Credit Cards', href: '/credit-cards', icon: CreditCard },
      { label: 'Receipts', href: '/receipts', icon: Receipt },
      { label: 'Bills', href: '/bills', icon: FileText },
      { label: 'Check Run', href: '/checks', icon: Banknote },
      { label: 'Flagged Items', href: '/flagged', icon: AlertTriangle },
    ],
  },
  {
    label: 'Financial',
    items: [
      { label: 'Journal Entries', href: '/journal-entries', icon: BookOpen },
      { label: 'Chart of Accounts', href: '/chart-of-accounts', icon: Calculator },
      { label: 'Reconciliation', href: '/reconciliation', icon: FileCheck },
      { label: 'Fiscal Periods', href: '/periods', icon: CalendarDays },
      { label: 'Revenue Recognition', href: '/rev-rec', icon: Percent },
      { label: 'Invoices', href: '/invoices', icon: DollarSign },
      { label: 'Payments', href: '/settings/payments', icon: CreditCard },
      { label: 'Payroll', href: '/payroll', icon: Wallet },
      { label: 'Budgets', href: '/budgets', icon: BarChart3 },
    ],
  },
  {
    label: 'Intelligence',
    items: [
      { label: 'Search', href: '/search', icon: Search },
      { label: 'Cash Position', href: '/cash', icon: Wallet },
      { label: '13-Week Forecast', href: '/forecast', icon: TrendingUp },
      { label: 'Reports', href: '/reports', icon: BarChart3 },
      { label: 'Profitability', href: '/profitability', icon: TrendingUp },
      { label: 'AI Decision Log', href: '/ai-decisions', icon: Sparkles },
      { label: 'AI Categorizer', href: '/categorize', icon: Wand2 },
    ],
  },
  {
    label: 'Operations',
    items: [
      { label: 'Departments', href: '/departments', icon: Network },
      { label: 'Internal Invoices', href: '/internal-invoices', icon: ArrowLeftRight },
      { label: 'Intercompany', href: '/intercompany', icon: Combine },
      { label: 'Consolidation', href: '/consolidation', icon: Building2 },
      { label: 'Jobs & Projects', href: '/jobs', icon: Briefcase },
      { label: 'Vendors', href: '/vendors', icon: Building2 },
      { label: 'Customers', href: '/customers', icon: Contact },
      { label: 'Retainage', href: '/retainage', icon: PiggyBank },
      { label: 'Vendor Compliance', href: '/vendor-compliance', icon: Shield },
      { label: '1099 Readiness', href: '/compliance-1099', icon: FileCheck },
      { label: 'Close Management', href: '/close', icon: ClipboardCheck },
      { label: 'Close Command Center', href: '/close-status', icon: Activity },
      { label: 'Year-End Close', href: '/year-end-close', icon: Lock },
    ],
  },
  {
    label: 'Practice',
    items: [
      { label: 'Team & Access', href: '/team', icon: Users },
      { label: 'Audit Trail', href: '/audit', icon: History },
      { label: 'Operations', href: '/operations', icon: Activity },
      { label: 'Companies', href: '/settings', icon: Building2 },
      { label: 'Compliance', href: '/compliance', icon: Shield },
      { label: 'Import Data', href: '/import', icon: Upload },
      { label: 'Sandbox', href: '/sandbox', icon: FlaskConical },
      { label: 'AI Autonomy', href: '/settings/autonomy', icon: SlidersHorizontal },
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

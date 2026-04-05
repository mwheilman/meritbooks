import {
  LayoutDashboard,
  Landmark,
  CreditCard,
  Receipt,
  FileText,
  AlertTriangle,
  BookOpen,
  Calculator,
  Clock,
  DollarSign,
  TrendingUp,
  BarChart3,
  Users,
  Building2,
  Briefcase,
  ClipboardCheck,
  FileCheck,
  Settings,
  Shield,
  Wallet,
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
      { label: 'Bank Feed', href: '/bank-feed', icon: Landmark },
      { label: 'Credit Cards', href: '/credit-cards', icon: CreditCard },
      { label: 'Receipts', href: '/receipts', icon: Receipt },
      { label: 'Bills', href: '/bills', icon: FileText },
      { label: 'Flagged Items', href: '/flagged', icon: AlertTriangle },
    ],
  },
  {
    label: 'Financial',
    items: [
      { label: 'Journal Entries', href: '/journal-entries', icon: BookOpen },
      { label: 'Chart of Accounts', href: '/chart-of-accounts', icon: Calculator },
      { label: 'Reconciliation', href: '/reconciliation', icon: FileCheck },
      { label: 'Invoices', href: '/invoices', icon: DollarSign },
    ],
  },
  {
    label: 'Intelligence',
    items: [
      { label: 'Cash Position', href: '/cash', icon: Wallet },
      { label: '13-Week Forecast', href: '/forecast', icon: TrendingUp },
      { label: 'Reports', href: '/reports', icon: BarChart3 },
    ],
  },
  {
    label: 'Operations',
    items: [
      { label: 'Jobs & Projects', href: '/jobs', icon: Briefcase },
      { label: 'Chargebacks', href: '/chargebacks', icon: Clock },
      { label: 'Vendors', href: '/vendors', icon: Building2 },
      { label: 'Close Management', href: '/close', icon: ClipboardCheck },
    ],
  },
  {
    label: 'Admin',
    items: [
      { label: 'Team', href: '/team', icon: Users },
      { label: 'Compliance', href: '/compliance', icon: Shield },
      { label: 'Settings', href: '/settings', icon: Settings },
    ],
  },
];

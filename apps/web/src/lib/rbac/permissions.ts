/**
 * MeritBooks RBAC Permissions System
 * 
 * 9 roles confirmed by Mike (Session 11):
 * 
 * Tier 1 — Full Visibility (All companies + Merit Mgmt):
 *   company_admin:       Full owner, manages users/permissions, ungrouped payroll
 *   cfo:                 Financial oversight, can edit accounting settings, ungrouped payroll
 *   merit_controller:    Holding company accounting, chargebacks, intercompany, ungrouped payroll
 * 
 * Tier 2 — Portcos + 3rd Party (No Merit Mgmt):
 *   assistant_cfo:       All portcos + 3rd party, ungrouped payroll at visible cos
 *   accounting_manager:  Same as asst CFO + assigns specialist company access, ungrouped payroll
 * 
 * Tier 3 — Assigned Companies Only:
 *   accounting_specialist: Assigned companies, grouped payroll
 * 
 * Tier 4 — Narrow Function:
 *   check_processor:     Checks only, separation of duties
 *   general_admin:       Data entry defaults, supervisor-customizable, grouped payroll
 * 
 * Tier 5 — External:
 *   business_user:       Own company only, simplified business view, ungrouped own-team payroll
 * 
 * Architecture:
 *   Layer 1 — Role Defaults: System ships with defaults per role (this file)
 *   Layer 2 — Tier Customization: Admin edits defaults for entire tier (stored in DB)
 *   Layer 3 — Individual Overrides: Supervisor adds/removes per-person (stored in DB)
 *   Resolution: tier default → tier edits → individual overrides
 */

export type UserRole =
  | 'company_admin'
  | 'cfo'
  | 'merit_controller'
  | 'assistant_cfo'
  | 'accounting_manager'
  | 'accounting_specialist'
  | 'check_processor'
  | 'general_admin'
  | 'business_user';

export const ALL_ROLES: UserRole[] = [
  'company_admin',
  'cfo',
  'merit_controller',
  'assistant_cfo',
  'accounting_manager',
  'accounting_specialist',
  'check_processor',
  'general_admin',
  'business_user',
];

export type PayrollVisibility = 'ungrouped' | 'grouped' | 'none';

export type CompanyScope =
  | 'all'
  | 'portcos_and_3rdparty'
  | 'assigned'
  | 'own_company';

export type FeatureAction = 'view' | 'create' | 'edit' | 'approve' | 'delete' |
  'export' | 'request' | 'post' | 'resolve' | 'reconcile' | 'manage' |
  'generate' | 'run' | 'assign';

export interface FeaturePermission {
  [action: string]: boolean;
}

export interface RoleDefinition {
  key: UserRole;
  label: string;
  description: string;
  companyScope: CompanyScope;
  payrollVisibility: PayrollVisibility;
  mfaRequired: boolean;
  canManageUsers: boolean;
  canEditAccountingSettings: boolean;
  canEditSystemSettings: boolean;
  assignableBy: UserRole[];
  features: Record<string, FeaturePermission>;
}

export interface FeatureDefinition {
  id: string;
  name: string;
  category: string;
  actions: FeatureAction[];
  businessViewOnly?: boolean;
  internalOnly?: boolean;
}

export const FEATURE_CATALOG: FeatureDefinition[] = [
  { id: 'dashboard', name: 'Dashboard', category: 'Overview', actions: ['view'] },
  { id: 'bank_feed', name: 'Bank feed', category: 'Transaction processing', actions: ['view', 'edit', 'approve'], internalOnly: true },
  { id: 'credit_cards', name: 'Credit cards', category: 'Transaction processing', actions: ['view', 'edit', 'approve'], internalOnly: true },
  { id: 'receipts', name: 'Receipts', category: 'Transaction processing', actions: ['view', 'edit', 'approve'], internalOnly: true },
  { id: 'bills', name: 'Bills / AP', category: 'Transaction processing', actions: ['view', 'create', 'approve'], internalOnly: true },
  { id: 'journal_entries', name: 'Journal entries', category: 'Transaction processing', actions: ['view', 'create', 'post'], internalOnly: true },
  { id: 'flagged', name: 'Flagged items', category: 'Transaction processing', actions: ['view', 'resolve'], internalOnly: true },
  { id: 'vendors', name: 'Vendors', category: 'Relationships', actions: ['view', 'create', 'edit'], internalOnly: true },
  { id: 'customers', name: 'Customers', category: 'Relationships', actions: ['view', 'create', 'edit'], internalOnly: true },
  { id: 'invoices', name: 'Invoices / AR', category: 'Relationships', actions: ['view', 'create', 'approve'], internalOnly: true },
  { id: 'jobs', name: 'Jobs & projects', category: 'Relationships', actions: ['view', 'create', 'edit'], internalOnly: true },
  { id: 'reports', name: 'Financial reports', category: 'Finance & reporting', actions: ['view', 'export'], internalOnly: true },
  { id: 'chart_of_accounts', name: 'Chart of accounts', category: 'Finance & reporting', actions: ['view', 'request', 'approve'], internalOnly: true },
  { id: 'reconciliation', name: 'Bank reconciliation', category: 'Finance & reporting', actions: ['view', 'reconcile'], internalOnly: true },
  { id: 'close_mgmt', name: 'Close management', category: 'Finance & reporting', actions: ['view', 'manage'], internalOnly: true },
  { id: 'chargebacks', name: 'Chargebacks', category: 'Finance & reporting', actions: ['view', 'generate'], internalOnly: true },
  { id: 'payroll', name: 'Payroll journal entries', category: 'Finance & reporting', actions: ['view', 'create', 'approve'], internalOnly: true },
  { id: 'intercompany', name: 'Intercompany', category: 'Finance & reporting', actions: ['view', 'create'], internalOnly: true },
  { id: 'cash_position', name: 'Cash position', category: 'Cash intelligence', actions: ['view'], internalOnly: true },
  { id: 'forecast', name: '13-week forecast', category: 'Cash intelligence', actions: ['view', 'edit'], internalOnly: true },
  { id: 'team', name: 'Team management', category: 'Administration', actions: ['view', 'manage'], internalOnly: true },
  { id: 'user_permissions', name: 'User permissions / roles', category: 'Administration', actions: ['view', 'assign'], internalOnly: true },
  { id: 'compliance', name: 'Compliance', category: 'Administration', actions: ['view', 'manage'], internalOnly: true },
  { id: 'fixed_assets', name: 'Fixed assets', category: 'Administration', actions: ['view', 'create'], internalOnly: true },
  { id: 'recurring', name: 'Recurring entries', category: 'Administration', actions: ['view', 'create'], internalOnly: true },
  { id: 'settings_acct', name: 'Settings — accounting', category: 'Administration', actions: ['view', 'edit'], internalOnly: true },
  { id: 'settings_system', name: 'Settings — system / integrations', category: 'Administration', actions: ['view', 'edit'], internalOnly: true },
  { id: 'import', name: 'Data import', category: 'Administration', actions: ['view', 'run'], internalOnly: true },
  { id: 'audit_trail', name: 'Audit trail', category: 'Administration', actions: ['view'], internalOnly: true },
  { id: 'checks', name: 'Check management', category: 'Administration', actions: ['view', 'create', 'approve'], internalOnly: true },
  { id: 'biz_dashboard', name: 'Business dashboard', category: 'Business view', actions: ['view'], businessViewOnly: true },
  { id: 'biz_reports', name: 'Business reports (P&L, BS, CF)', category: 'Business view', actions: ['view', 'export'], businessViewOnly: true },
  { id: 'biz_invoices', name: 'My invoices / billing', category: 'Business view', actions: ['view'], businessViewOnly: true },
  { id: 'biz_payroll', name: 'My team payroll', category: 'Business view', actions: ['view'], businessViewOnly: true },
  { id: 'biz_jobs', name: 'My jobs / projects', category: 'Business view', actions: ['view'], businessViewOnly: true },
  { id: 'biz_cash', name: 'My cash position', category: 'Business view', actions: ['view'], businessViewOnly: true },
];

function allOn(actions: FeatureAction[]): FeaturePermission {
  return Object.fromEntries(actions.map(a => [a, true]));
}

function allOff(actions: FeatureAction[]): FeaturePermission {
  return Object.fromEntries(actions.map(a => [a, false]));
}

function viewOnly(actions: FeatureAction[]): FeaturePermission {
  return Object.fromEntries(actions.map(a => [a, a === 'view']));
}

type PermShorthand = FeaturePermission | 'all' | 'view' | 'off';

function buildFeatureMap(overrides: Record<string, PermShorthand>): Record<string, FeaturePermission> {
  const result: Record<string, FeaturePermission> = {};
  for (const feat of FEATURE_CATALOG) {
    const override = overrides[feat.id];
    if (override === 'all') {
      result[feat.id] = allOn(feat.actions);
    } else if (override === 'view') {
      result[feat.id] = viewOnly(feat.actions);
    } else if (override === 'off' || !override) {
      result[feat.id] = allOff(feat.actions);
    } else {
      const base = allOff(feat.actions);
      result[feat.id] = { ...base, ...override };
    }
  }
  return result;
}

export const ROLE_DEFINITIONS: Record<UserRole, RoleDefinition> = {
  company_admin: {
    key: 'company_admin',
    label: 'Company Admin',
    description: 'Full platform owner. Sees all companies including Merit Management. Creates and manages all user permissions.',
    companyScope: 'all',
    payrollVisibility: 'ungrouped',
    mfaRequired: true,
    canManageUsers: true,
    canEditAccountingSettings: true,
    canEditSystemSettings: true,
    assignableBy: ['company_admin'],
    features: buildFeatureMap(
      Object.fromEntries(FEATURE_CATALOG.map(f => [f.id, 'all' as const]))
    ),
  },

  cfo: {
    key: 'cfo',
    label: 'CFO',
    description: 'Financial oversight across all entities. Can change accounting settings (COA, GL rules, fiscal periods, close gates). Cannot manage users or system settings.',
    companyScope: 'all',
    payrollVisibility: 'ungrouped',
    mfaRequired: true,
    canManageUsers: false,
    canEditAccountingSettings: true,
    canEditSystemSettings: false,
    assignableBy: ['company_admin'],
    features: buildFeatureMap({
      dashboard: 'view',
      bank_feed: 'view',
      credit_cards: 'view',
      receipts: 'view',
      bills: 'view',
      journal_entries: 'view',
      flagged: 'view',
      vendors: 'view',
      customers: 'view',
      invoices: 'view',
      jobs: 'view',
      reports: 'all',
      chart_of_accounts: 'all',
      reconciliation: 'view',
      close_mgmt: 'all',
      chargebacks: 'view',
      payroll: 'view',
      intercompany: 'view',
      cash_position: 'view',
      forecast: 'all',
      team: 'view',
      user_permissions: 'view',
      compliance: 'all',
      fixed_assets: 'view',
      recurring: 'view',
      settings_acct: 'all',
      settings_system: 'view',
      import: 'view',
      audit_trail: 'view',
      checks: 'view',
    }),
  },

  merit_controller: {
    key: 'merit_controller',
    label: 'Merit Controller',
    description: 'Runs holding company accounting — chargebacks, intercompany, consolidations, Merit Management books. Sees all portfolio company books.',
    companyScope: 'all',
    payrollVisibility: 'ungrouped',
    mfaRequired: false,
    canManageUsers: false,
    canEditAccountingSettings: false,
    canEditSystemSettings: false,
    assignableBy: ['company_admin', 'cfo'],
    features: buildFeatureMap({
      dashboard: 'view',
      bank_feed: 'all',
      credit_cards: 'all',
      receipts: 'all',
      bills: 'all',
      journal_entries: 'all',
      flagged: 'all',
      vendors: 'all',
      customers: 'all',
      invoices: 'all',
      jobs: 'all',
      reports: 'all',
      chart_of_accounts: { view: true, request: true, approve: false },
      reconciliation: 'all',
      close_mgmt: 'all',
      chargebacks: 'all',
      payroll: 'all',
      intercompany: 'all',
      cash_position: 'view',
      forecast: 'all',
      team: 'view',
      compliance: 'all',
      fixed_assets: 'all',
      recurring: 'all',
      import: 'all',
      audit_trail: 'view',
      checks: 'all',
    }),
  },

  assistant_cfo: {
    key: 'assistant_cfo',
    label: 'Assistant CFO',
    description: 'All portfolio companies + third-party customers. Cannot see Merit Management books. Can see chargeback invoices on the portco side.',
    companyScope: 'portcos_and_3rdparty',
    payrollVisibility: 'ungrouped',
    mfaRequired: false,
    canManageUsers: false,
    canEditAccountingSettings: false,
    canEditSystemSettings: false,
    assignableBy: ['company_admin', 'cfo'],
    features: buildFeatureMap({
      dashboard: 'view',
      bank_feed: 'all',
      credit_cards: 'all',
      receipts: 'all',
      bills: 'all',
      journal_entries: 'all',
      flagged: 'all',
      vendors: 'all',
      customers: 'all',
      invoices: 'all',
      jobs: 'all',
      reports: 'all',
      chart_of_accounts: { view: true, request: true, approve: false },
      reconciliation: 'all',
      close_mgmt: 'view',
      chargebacks: 'view',
      payroll: { view: true, create: true, approve: false },
      cash_position: 'view',
      forecast: 'all',
      team: 'view',
      compliance: 'view',
      fixed_assets: 'all',
      recurring: 'all',
      import: 'all',
      audit_trail: 'view',
      checks: 'all',
    }),
  },

  accounting_manager: {
    key: 'accounting_manager',
    label: 'Accounting Manager',
    description: 'Same visibility as Asst CFO. Key power: assigns company access for specialists. Approves COA, overrides payment holds, manages close gates.',
    companyScope: 'portcos_and_3rdparty',
    payrollVisibility: 'ungrouped',
    mfaRequired: false,
    canManageUsers: false,
    canEditAccountingSettings: true,
    canEditSystemSettings: false,
    assignableBy: ['company_admin', 'cfo'],
    features: buildFeatureMap({
      dashboard: 'view',
      bank_feed: 'all',
      credit_cards: 'all',
      receipts: 'all',
      bills: 'all',
      journal_entries: 'all',
      flagged: 'all',
      vendors: 'all',
      customers: 'all',
      invoices: 'all',
      jobs: 'all',
      reports: 'all',
      chart_of_accounts: 'all',
      reconciliation: 'all',
      close_mgmt: 'all',
      chargebacks: 'view',
      payroll: 'all',
      cash_position: 'view',
      forecast: 'all',
      team: 'all',
      user_permissions: { view: true, assign: true },
      compliance: 'all',
      fixed_assets: 'all',
      recurring: 'all',
      settings_acct: 'all',
      import: 'all',
      audit_trail: 'view',
      checks: 'all',
    }),
  },

  accounting_specialist: {
    key: 'accounting_specialist',
    label: 'Accounting Specialist',
    description: 'Day-to-day processing for assigned companies only. Accounting Manager controls which companies.',
    companyScope: 'assigned',
    payrollVisibility: 'grouped',
    mfaRequired: false,
    canManageUsers: false,
    canEditAccountingSettings: false,
    canEditSystemSettings: false,
    assignableBy: ['company_admin', 'cfo', 'accounting_manager'],
    features: buildFeatureMap({
      dashboard: 'view',
      bank_feed: 'all',
      credit_cards: 'all',
      receipts: 'all',
      bills: { view: true, create: true, approve: false },
      journal_entries: { view: true, create: true, post: false },
      flagged: 'all',
      vendors: 'all',
      customers: 'all',
      invoices: { view: true, create: true, approve: false },
      jobs: 'all',
      reports: 'all',
      chart_of_accounts: { view: true, request: true, approve: false },
      reconciliation: 'all',
      close_mgmt: 'view',
      payroll: { view: true, create: false, approve: false },
      cash_position: 'view',
      forecast: 'view',
      compliance: 'view',
      fixed_assets: 'view',
      recurring: 'view',
      audit_trail: 'view',
    }),
  },

  check_processor: {
    key: 'check_processor',
    label: 'Check Processor',
    description: 'Check Management screen only. Typically receptionist/admin staff. Deliberate separation of duties.',
    companyScope: 'assigned',
    payrollVisibility: 'none',
    mfaRequired: false,
    canManageUsers: false,
    canEditAccountingSettings: false,
    canEditSystemSettings: false,
    assignableBy: ['company_admin', 'cfo', 'accounting_manager'],
    features: buildFeatureMap({
      dashboard: 'view',
      checks: 'all',
    }),
  },

  general_admin: {
    key: 'general_admin',
    label: 'General Admin / Data Entry',
    description: 'Default screens for data entry. Supervisor designates which segments and screens this person can access.',
    companyScope: 'assigned',
    payrollVisibility: 'grouped',
    mfaRequired: false,
    canManageUsers: false,
    canEditAccountingSettings: false,
    canEditSystemSettings: false,
    assignableBy: ['company_admin', 'cfo', 'accounting_manager'],
    features: buildFeatureMap({
      dashboard: 'view',
      receipts: { view: true, edit: true, approve: false },
      bills: { view: true, create: true, approve: false },
      vendors: { view: true, create: true, edit: true },
      customers: { view: true, create: true, edit: true },
    }),
  },

  business_user: {
    key: 'business_user',
    label: 'Business User (3rd Party)',
    description: 'External business owner. Simplified business view of their own company only. Sees their own team payroll.',
    companyScope: 'own_company',
    payrollVisibility: 'ungrouped',
    mfaRequired: false,
    canManageUsers: false,
    canEditAccountingSettings: false,
    canEditSystemSettings: false,
    assignableBy: ['company_admin', 'cfo', 'accounting_manager'],
    features: buildFeatureMap({
      biz_dashboard: 'view',
      biz_reports: 'all',
      biz_invoices: 'view',
      biz_payroll: 'view',
      biz_jobs: 'view',
      biz_cash: 'view',
    }),
  },
};

// ── Access Checks ───────────────────────────────────────────────────────────────

export function hasPermission(role: UserRole, featureId: string, action: FeatureAction): boolean {
  const roleDef = ROLE_DEFINITIONS[role];
  if (!roleDef) return false;
  const feat = roleDef.features[featureId];
  if (!feat) return false;
  return feat[action] === true;
}

export function canView(role: UserRole, featureId: string): boolean {
  return hasPermission(role, featureId, 'view');
}

export function getVisibleFeatures(role: UserRole): string[] {
  const roleDef = ROLE_DEFINITIONS[role];
  if (!roleDef) return [];
  return Object.entries(roleDef.features)
    .filter(([, perms]) => perms.view === true)
    .map(([id]) => id);
}

export function canSeeMeritManagement(role: UserRole): boolean {
  const roleDef = ROLE_DEFINITIONS[role];
  if (!roleDef) return false;
  return roleDef.companyScope === 'all';
}

export function getPayrollVisibility(role: UserRole): PayrollVisibility {
  return ROLE_DEFINITIONS[role]?.payrollVisibility ?? 'none';
}

// ── Sidebar ─────────────────────────────────────────────────────────────────────

export interface SidebarItem {
  featureId: string;
  label: string;
  href: string;
  icon: string;
  category: string;
}

export const SIDEBAR_ITEMS: SidebarItem[] = [
  { featureId: 'dashboard', label: 'Dashboard', href: '/dashboard', icon: 'LayoutDashboard', category: 'Overview' },
  { featureId: 'bank_feed', label: 'Bank Feed', href: '/bank-feed', icon: 'Building2', category: 'Processing' },
  { featureId: 'credit_cards', label: 'Credit Cards', href: '/credit-cards', icon: 'CreditCard', category: 'Processing' },
  { featureId: 'receipts', label: 'Receipts', href: '/receipts', icon: 'Receipt', category: 'Processing' },
  { featureId: 'bills', label: 'Bills', href: '/bills', icon: 'FileText', category: 'Processing' },
  { featureId: 'journal_entries', label: 'Journal Entries', href: '/journal-entries', icon: 'BookOpen', category: 'Processing' },
  { featureId: 'flagged', label: 'Flagged Items', href: '/flagged', icon: 'Flag', category: 'Processing' },
  { featureId: 'vendors', label: 'Vendors', href: '/vendors', icon: 'Truck', category: 'Relationships' },
  { featureId: 'customers', label: 'Customers', href: '/customers', icon: 'Users', category: 'Relationships' },
  { featureId: 'invoices', label: 'Invoices & AR', href: '/invoices', icon: 'FileCheck', category: 'Relationships' },
  { featureId: 'jobs', label: 'Jobs & Projects', href: '/jobs', icon: 'Hammer', category: 'Relationships' },
  { featureId: 'reports', label: 'Reports', href: '/reports', icon: 'BarChart3', category: 'Finance' },
  { featureId: 'chart_of_accounts', label: 'Chart of Accounts', href: '/chart-of-accounts', icon: 'ListTree', category: 'Finance' },
  { featureId: 'reconciliation', label: 'Reconciliation', href: '/reconciliation', icon: 'GitCompare', category: 'Finance' },
  { featureId: 'close_mgmt', label: 'Close Management', href: '/close', icon: 'CalendarCheck', category: 'Finance' },
  { featureId: 'chargebacks', label: 'Chargebacks', href: '/chargebacks', icon: 'ArrowLeftRight', category: 'Finance' },
  { featureId: 'payroll', label: 'Payroll', href: '/payroll', icon: 'DollarSign', category: 'Finance' },
  { featureId: 'intercompany', label: 'Intercompany', href: '/intercompany', icon: 'Building', category: 'Finance' },
  { featureId: 'checks', label: 'Checks', href: '/checks', icon: 'FileOutput', category: 'Finance' },
  { featureId: 'cash_position', label: 'Cash Position', href: '/cash', icon: 'Wallet', category: 'Cash Intelligence' },
  { featureId: 'forecast', label: '13-Week Forecast', href: '/forecast', icon: 'TrendingUp', category: 'Cash Intelligence' },
  { featureId: 'team', label: 'Team', href: '/team', icon: 'Users2', category: 'Administration' },
  { featureId: 'user_permissions', label: 'Roles & Permissions', href: '/settings/permissions', icon: 'ShieldCheck', category: 'Administration' },
  { featureId: 'compliance', label: 'Compliance', href: '/compliance', icon: 'Shield', category: 'Administration' },
  { featureId: 'fixed_assets', label: 'Fixed Assets', href: '/fixed-assets', icon: 'Package', category: 'Administration' },
  { featureId: 'recurring', label: 'Recurring', href: '/recurring', icon: 'RefreshCw', category: 'Administration' },
  { featureId: 'settings_acct', label: 'Accounting Settings', href: '/settings', icon: 'Settings', category: 'Administration' },
  { featureId: 'settings_system', label: 'System Settings', href: '/settings/system', icon: 'Wrench', category: 'Administration' },
  { featureId: 'import', label: 'Data Import', href: '/import', icon: 'Upload', category: 'Administration' },
  { featureId: 'audit_trail', label: 'Audit Trail', href: '/audit', icon: 'History', category: 'Administration' },
  { featureId: 'biz_dashboard', label: 'Dashboard', href: '/business', icon: 'LayoutDashboard', category: 'Business' },
  { featureId: 'biz_reports', label: 'Reports', href: '/business/reports', icon: 'BarChart3', category: 'Business' },
  { featureId: 'biz_invoices', label: 'Invoices', href: '/business/invoices', icon: 'FileCheck', category: 'Business' },
  { featureId: 'biz_payroll', label: 'Payroll', href: '/business/payroll', icon: 'DollarSign', category: 'Business' },
  { featureId: 'biz_jobs', label: 'Projects', href: '/business/jobs', icon: 'Hammer', category: 'Business' },
  { featureId: 'biz_cash', label: 'Cash Position', href: '/business/cash', icon: 'Wallet', category: 'Business' },
];

export function getSidebarForRole(role: UserRole): SidebarItem[] {
  const roleDef = ROLE_DEFINITIONS[role];
  if (!roleDef) return [];
  return SIDEBAR_ITEMS.filter((item) => {
    const feat = roleDef.features[item.featureId];
    return feat?.view === true;
  });
}

export function getSidebarGrouped(role: UserRole): Record<string, SidebarItem[]> {
  const items = getSidebarForRole(role);
  const groups: Record<string, SidebarItem[]> = {};
  for (const item of items) {
    if (!groups[item.category]) groups[item.category] = [];
    groups[item.category].push(item);
  }
  return groups;
}

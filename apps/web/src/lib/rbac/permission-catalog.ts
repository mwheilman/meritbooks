/**
 * PERMISSION CATALOG — the human-readable + machine-readable representation of the
 * SYSTEM DEFAULT permission matrix.
 *
 * This module is READ-ONLY against the reserved RBAC spine (`permissions.ts`): it
 * imports the frozen `FEATURE_CATALOG`, `ROLE_DEFINITIONS`, `ALL_ROLES` and the
 * `hasPermission` decision, and layers plain-English descriptions on top so the admin
 * UI can EXPLAIN, in words, exactly what each shipped role grants — feature by feature,
 * action by action. It never mutates the spine.
 *
 * Everything here is pure (no I/O), so it is safe to import in both server and client
 * components and is trivially unit-testable.
 */

import {
  FEATURE_CATALOG,
  ROLE_DEFINITIONS,
  ALL_ROLES,
  hasPermission,
  type FeatureAction,
  type UserRole,
} from '@/lib/rbac/permissions';

// ── Plain-English action glossary ───────────────────────────────────────────────
// Generic meaning of each action verb, shown in tooltips/legends so a non-technical
// admin understands what a toggle actually grants. Kept deliberately blunt about the
// control-sensitive verbs (approve/post/run/assign/delete).
export const ACTION_DESCRIPTIONS: Record<FeatureAction, string> = {
  view: 'See this area and its data (read-only).',
  create: 'Create new records in this area.',
  edit: 'Change existing records in this area.',
  approve: 'Approve items so they take effect — a financial control action.',
  delete: 'Permanently delete records (destructive).',
  export: 'Download or export this data (CSV / PDF).',
  request: 'Request a change for someone with authority to approve.',
  post: 'Post to the general ledger — an irreversible book-of-record write.',
  resolve: 'Resolve or clear flagged items.',
  reconcile: 'Reconcile accounts against bank / statement data.',
  manage: 'Manage and configure this area.',
  generate: 'Generate documents or outputs from this area.',
  run: 'Run this operation (e.g. move money, run an import).',
  assign: "Assign roles, permissions, or access to other people.",
};

// ── Plain-English action LABELS (short, for column headers / chips) ──────────────
export const ACTION_LABELS: Record<FeatureAction, string> = {
  view: 'View',
  create: 'Create',
  edit: 'Edit',
  approve: 'Approve',
  delete: 'Delete',
  export: 'Export',
  request: 'Request',
  post: 'Post to GL',
  resolve: 'Resolve',
  reconcile: 'Reconcile',
  manage: 'Manage',
  generate: 'Generate',
  run: 'Run',
  assign: 'Assign',
};

// ── Plain-English feature descriptions ──────────────────────────────────────────
// One sentence per feature explaining what the screen/area is, so the matrix reads as
// prose to an owner deciding who should have it. Keyed by FEATURE_CATALOG id.
export const FEATURE_DESCRIPTIONS: Record<string, string> = {
  dashboard: 'The home overview: high-level KPIs and the work board.',
  bank_feed: 'Incoming bank transactions, AI-categorized for review and approval.',
  credit_cards: 'Credit-card transactions to review, categorize, and approve.',
  receipts: 'Uploaded receipts matched to expenses and card charges.',
  bills: 'Accounts payable — vendor bills entered, approved, and scheduled to pay.',
  journal_entries: 'Manual journal entries and posting them to the general ledger.',
  flagged: 'Items the system flagged for a human to resolve.',
  vendors: 'The vendor master list and vendor detail records.',
  customers: 'The customer master list and customer detail records.',
  invoices: 'Accounts receivable — customer invoices created, approved, and sent.',
  jobs: 'Jobs / projects and their costing.',
  reports: 'Financial reports (P&L, balance sheet, cash flow, trial balance).',
  chart_of_accounts: 'The chart of accounts — requesting and approving new accounts.',
  reconciliation: 'Bank reconciliation — tying the books to bank statements.',
  close_mgmt: 'Period close — opening, soft-closing, and hard-closing fiscal periods.',
  payroll: 'Payroll journal entries and their approval.',
  intercompany: 'Inter-company / inter-department internal invoicing and eliminations.',
  payments: 'Money movement — running payments and disbursements.',
  payments_execute: 'Record a customer payment (applies cash to AR and posts to the GL).',
  check_run: 'Run the check run — queue approvals for due bills (front of the pay chain; does not release money).',
  ap_disbursement_release: 'Release an approved AP batch — posts the payment and clears the payable (money out).',
  payroll_release: 'Release an approved payroll run to the provider (debits the bank; pays employees/agencies).',
  cash_position: 'The current cash position across accounts.',
  forecast: 'The 13-week cash forecast.',
  team: 'Team management — the people in this organization.',
  user_permissions: 'Roles & permissions — this very screen; who can do what.',
  compliance: 'Vendor / entity compliance tracking (W-9, COI, etc.).',
  fixed_assets: 'Fixed assets and depreciation.',
  recurring: 'Recurring entries and standard accruals.',
  settings_acct: 'Accounting settings — COA rules, GL rules, fiscal calendar, close gates.',
  settings_system: 'System settings and integrations (a high-trust configuration area).',
  import: 'Bulk data import.',
  audit_trail: 'The audit trail of who did what.',
  checks: 'Check management — printing and managing checks (separation of duties).',
  biz_dashboard: 'Simplified business-owner dashboard (external view).',
  biz_reports: 'Business-owner reports: P&L, balance sheet, cash flow (external view).',
  biz_invoices: "The business owner's own invoices / billing (external view).",
  biz_jobs: "The business owner's own jobs / projects (external view).",
  biz_payroll: "The business owner's own team payroll (external view).",
  biz_cash: "The business owner's own cash position (external view).",
};

export function describeFeature(featureId: string): string {
  return FEATURE_DESCRIPTIONS[featureId] ?? 'This area of the product.';
}

export function describeAction(action: FeatureAction): string {
  return ACTION_DESCRIPTIONS[action] ?? action;
}

// ── Machine-readable DEFAULT matrix ─────────────────────────────────────────────

/** One (feature, action) grant with its plain-English gloss. */
export interface DefaultCell {
  action: FeatureAction;
  actionLabel: string;
  allowed: boolean;
  description: string;
}

/** A feature's default grants for one role. */
export interface DefaultFeatureGrant {
  featureId: string;
  featureName: string;
  category: string;
  featureDescription: string;
  cells: DefaultCell[];
}

/** The complete shipped default profile for one system role. */
export interface DefaultRoleProfile {
  key: UserRole;
  label: string;
  description: string;
  companyScope: string;
  payrollVisibility: string;
  mfaRequired: boolean;
  canManageUsers: boolean;
  canEditAccountingSettings: boolean;
  canEditSystemSettings: boolean;
  features: DefaultFeatureGrant[];
}

/**
 * Build the shipped default profile for a SYSTEM role, straight from the frozen spine.
 * Every (feature, action) pair in FEATURE_CATALOG is enumerated with its default
 * boolean (via hasPermission) and its plain-English description.
 */
export function buildDefaultRoleProfile(role: UserRole): DefaultRoleProfile {
  const def = ROLE_DEFINITIONS[role];
  return {
    key: role,
    label: def?.label ?? role,
    description: def?.description ?? '',
    companyScope: def?.companyScope ?? 'assigned',
    payrollVisibility: def?.payrollVisibility ?? 'none',
    mfaRequired: def?.mfaRequired ?? false,
    canManageUsers: def?.canManageUsers ?? false,
    canEditAccountingSettings: def?.canEditAccountingSettings ?? false,
    canEditSystemSettings: def?.canEditSystemSettings ?? false,
    features: FEATURE_CATALOG.map((feat) => ({
      featureId: feat.id,
      featureName: feat.name,
      category: feat.category,
      featureDescription: describeFeature(feat.id),
      cells: feat.actions.map((action) => ({
        action,
        actionLabel: ACTION_LABELS[action] ?? action,
        allowed: hasPermission(role, feat.id, action),
        description: describeAction(action),
      })),
    })),
  };
}

/** The full machine-readable default matrix for all 9 system roles. */
export function buildDefaultMatrix(): DefaultRoleProfile[] {
  return ALL_ROLES.map(buildDefaultRoleProfile);
}

/** Lightweight catalog payload for the UI (features + their valid actions + prose). */
export interface CatalogPayload {
  features: Array<{
    id: string;
    name: string;
    category: string;
    description: string;
    actions: Array<{ action: FeatureAction; label: string; description: string }>;
    businessViewOnly: boolean;
    internalOnly: boolean;
  }>;
  actionGlossary: Array<{ action: FeatureAction; label: string; description: string }>;
}

export function buildCatalogPayload(): CatalogPayload {
  return {
    features: FEATURE_CATALOG.map((f) => ({
      id: f.id,
      name: f.name,
      category: f.category,
      description: describeFeature(f.id),
      actions: f.actions.map((a) => ({
        action: a,
        label: ACTION_LABELS[a] ?? a,
        description: describeAction(a),
      })),
      businessViewOnly: f.businessViewOnly === true,
      internalOnly: f.internalOnly === true,
    })),
    actionGlossary: (Object.keys(ACTION_LABELS) as FeatureAction[]).map((a) => ({
      action: a,
      label: ACTION_LABELS[a],
      description: ACTION_DESCRIPTIONS[a],
    })),
  };
}

/**
 * Is this (feature, action) a VALID cell in the catalog? Used to fail closed on any
 * override that references a non-existent feature/action (never applied).
 */
export function isValidCell(featureId: string, action: string): action is FeatureAction {
  const feat = FEATURE_CATALOG.find((f) => f.id === featureId);
  if (!feat) return false;
  return (feat.actions as string[]).includes(action);
}

/** Every (feature, action) cell that exists in the catalog (for iteration/validation). */
export function allCatalogCells(): Array<{ featureId: string; action: FeatureAction }> {
  const out: Array<{ featureId: string; action: FeatureAction }> = [];
  for (const feat of FEATURE_CATALOG) {
    for (const action of feat.actions) out.push({ featureId: feat.id, action });
  }
  return out;
}

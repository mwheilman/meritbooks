/**
 * LEGACY MAP — today's `permissions.ts` vocabulary (feature × action, role flags) → the
 * capability vocabulary (05-RBAC-SPEC §2.3). This is the shim 05 §5.7 R-14 names
 * `lib/rbac/legacy-map.ts`: used by the R-2/R-4 backfill (mirrored to SQL by migration
 * 158's generated block) and by the dual-run comparator (effective-access.ts).
 *
 * READ-ONLY against the reserved spine: imports ROLE_DEFINITIONS / FEATURE_CATALOG,
 * never edits them.
 *
 * Every legacy cell has exactly one PRIMARY capability — the capability a route gated on
 * that cell will check after the enforcement flip (wave 2). The comparator compares the
 * legacy decision for the cell with the new decision for its primary. Secondary grants
 * carry the "borrowed" pages that 05 §2.3 splits out with equivalent grants.
 *
 * PURE: no I/O.
 */

import { ROLE_DEFINITIONS, FEATURE_CATALOG, ALL_ROLES, type UserRole } from '@/lib/rbac/permissions';
import { ACTIONS, CAPABILITY_BY_KEY, type Action } from '@/lib/rbac/capabilities';

/** A legacy cell key: `feature::action`, or a role-flag pseudo cell `flag::<name>`. */
export type LegacyCell = string;

export function legacyCell(feature: string, action: string): LegacyCell {
  return `${feature}::${action}`;
}

export interface LegacyRule {
  /** The legacy cell this rule fires on. */
  cell: LegacyCell;
  /** Capability grants produced when the rule fires. */
  grants: ReadonlyArray<readonly [capability: string, actions: readonly Action[]]>;
  /** All of these cells must ALSO be allowed for the rule to fire. */
  requiresAll?: readonly LegacyCell[];
  /** At least one of these cells must ALSO be allowed (empty / absent = no condition). */
  requiresAny?: readonly LegacyCell[];
}

/** The money-approval cells today's canApprove() accepts (lib/money/approvals.ts). */
export const MONEY_APPROVE_CELLS: readonly LegacyCell[] = [
  'bills::approve',
  'checks::approve',
  'payroll::approve',
];

const V: Action[] = ['view'];

/** 05 §2.3, row by row. */
export const LEGACY_RULES: readonly LegacyRule[] = [
  // dashboard
  { cell: 'dashboard::view', grants: [['home.workspace', V], ['home.client', V], ['ai.assist', V]] },
  // bank feed
  { cell: 'bank_feed::view', grants: [['bank.transactions', V]] },
  { cell: 'bank_feed::edit', grants: [['bank.transactions', ['edit']], ['bank.rules', ['view', 'create', 'edit', 'delete']]] },
  { cell: 'bank_feed::approve', grants: [['bank.transactions', ['approve']]] },
  // credit cards
  { cell: 'credit_cards::view', grants: [['cards.transactions', V]] },
  { cell: 'credit_cards::edit', grants: [['cards.transactions', ['edit']]] },
  { cell: 'credit_cards::approve', grants: [['cards.transactions', ['approve']]] },
  // receipts
  { cell: 'receipts::view', grants: [['exp.receipts', V]] },
  { cell: 'receipts::edit', grants: [['exp.receipts', ['edit', 'create']]] },
  { cell: 'receipts::approve', grants: [['exp.receipts', ['approve']]] },
  // bills (POs + vendor credits borrowed it — split with the same grants)
  { cell: 'bills::view', grants: [['ap.bills', V], ['ap.purchase_orders', V], ['ap.vendor_credits', V]] },
  { cell: 'bills::create', grants: [['ap.bills', ['create', 'edit', 'delete']], ['ap.purchase_orders', ['create', 'edit', 'delete']], ['ap.vendor_credits', ['create']]] },
  { cell: 'bills::approve', grants: [['ap.bills', ['approve']], ['ap.purchase_orders', ['approve']], ['ap.vendor_credits', ['approve']]] },
  // journal entries
  { cell: 'journal_entries::view', grants: [['gl.journal_entries', V]] },
  { cell: 'journal_entries::create', grants: [['gl.journal_entries', ['create', 'edit', 'delete']]] },
  { cell: 'journal_entries::post', grants: [['gl.journal_entries', ['post']]] },
  // flagged
  { cell: 'flagged::view', grants: [['ctl.exceptions', V]] },
  { cell: 'flagged::resolve', grants: [['ctl.exceptions', ['edit']]] },
  // vendors — TIGHTEN: bank-detail edit only with a money-approve key
  { cell: 'vendors::view', grants: [['mdm.vendors', V], ['pay.vendor_bank_details', V]] },
  { cell: 'vendors::create', grants: [['mdm.vendors', ['create']]] },
  { cell: 'vendors::edit', grants: [['mdm.vendors', ['edit']]] },
  { cell: 'vendors::edit', grants: [['pay.vendor_bank_details', ['edit']]], requiresAny: MONEY_APPROVE_CELLS },
  // customers
  { cell: 'customers::view', grants: [['mdm.customers', V]] },
  { cell: 'customers::create', grants: [['mdm.customers', ['create']]] },
  { cell: 'customers::edit', grants: [['mdm.customers', ['edit']]] },
  // invoices (estimates, deposits, collections, statements, recurring, credit memos,
  // write-offs and rev rec all borrowed `invoices` — split with equivalent grants)
  {
    cell: 'invoices::view',
    grants: [
      ['ar.invoices', V], ['ar.estimates', V], ['ar.deposits', V], ['ar.collections', V],
      ['ar.statements', V], ['ar.recurring', V], ['ar.credit_memos', V], ['ar.write_offs', V],
      ['revrec.methods', V], ['revrec.runs', V], ['revrec.schedules', V],
    ],
  },
  {
    cell: 'invoices::create',
    grants: [
      ['ar.invoices', ['create', 'edit', 'post', 'release']],
      ['ar.estimates', ['create', 'edit', 'delete', 'release']],
      ['ar.deposits', ['create', 'post']],
      ['ar.collections', ['edit', 'release']],
      ['ar.statements', ['release']],
      ['ar.recurring', ['create', 'edit', 'delete']],
      ['ar.credit_memos', ['create']],
      ['ar.write_offs', ['create']],
      ['revrec.methods', ['edit']],
      ['revrec.runs', ['create', 'post']],
    ],
  },
  {
    cell: 'invoices::approve',
    grants: [['ar.invoices', ['approve']], ['ar.credit_memos', ['approve', 'post']], ['ar.write_offs', ['approve', 'post']]],
  },
  // jobs (WIP + change orders borrowed it)
  { cell: 'jobs::view', grants: [['jobs.jobs', V], ['jobs.change_orders', V], ['jobs.wip', V]] },
  { cell: 'jobs::create', grants: [['jobs.jobs', ['create']], ['jobs.change_orders', ['create']]] },
  { cell: 'jobs::edit', grants: [['jobs.jobs', ['edit']], ['jobs.wip', ['edit']]] },
  // reports (FP&A, board package, borrowing base borrowed it) + the previously UNMAPPED
  // pages (debt, tax, expenses, inventory, documents, agents, AI decisions, obligations,
  // departments, search): view granted to every role that had reports:view, which is
  // equivalence-preserving because those pages were ungated. TIGHTEN: consol.statements
  // is NOT granted here — it needs a group grant (or an all-clients assignment, IA Q4).
  {
    cell: 'reports::view',
    grants: [
      ['reports.financial', V], ['reports.saved_views', ['view', 'create', 'edit', 'delete']],
      ['reports.packs', V], ['reports.board_package', V],
      ['fpa.budgets', V], ['fpa.scenarios', V], ['fpa.profitability', V],
      ['debt.borrowing_base', V], ['debt.loans', V], ['debt.covenants', V], ['debt.certificates', V],
      ['tax.sales_tax', V], ['tax.filings', V], ['tax.1099', V], ['tax.provision', V],
      ['exp.reports', V], ['exp.reimbursements', V],
      ['inv.items', V], ['inv.movements', V], ['inv.valuation', V],
      ['docs.documents', V], ['ai.agents', V], ['ctl.ai_decisions', V],
      ['cash.obligations', V], ['gl.dimensions', V], ['ai.assist', V],
    ],
  },
  { cell: 'reports::export', grants: [['reports.financial', ['export']], ['fpa.budgets', ['export']], ['fpa.profitability', ['export']]] },
  // chart of accounts
  { cell: 'chart_of_accounts::view', grants: [['gl.accounts', V]] },
  { cell: 'chart_of_accounts::request', grants: [['gl.accounts', ['create']]] },
  { cell: 'chart_of_accounts::approve', grants: [['gl.accounts', ['approve']]] },
  // reconciliation — reviewer sign-off granted to roles that pass today's canApprove
  { cell: 'reconciliation::view', grants: [['bank.reconciliations', V]] },
  { cell: 'reconciliation::reconcile', grants: [['bank.reconciliations', ['create', 'edit']], ['bank.statements', ['create']]] },
  { cell: 'reconciliation::reconcile', grants: [['bank.reconciliations', ['approve']]], requiresAny: MONEY_APPROVE_CELLS },
  // close management (hard close A held exactly by the roles with close_mgmt:manage)
  { cell: 'close_mgmt::view', grants: [['close.checklist', V], ['gl.periods', V]] },
  { cell: 'close_mgmt::manage', grants: [['close.checklist', ['edit', 'approve']], ['gl.periods', ['edit', 'approve']]] },
  // payroll
  { cell: 'payroll::view', grants: [['payroll.register', V], ['payroll.runs', V], ['payroll.employees', V]] },
  { cell: 'payroll::create', grants: [['payroll.register', ['create', 'post']], ['payroll.runs', ['create', 'edit']], ['payroll.employees', ['edit']]] },
  { cell: 'payroll::approve', grants: [['payroll.runs', ['approve']]] },
  // intercompany
  { cell: 'intercompany::view', grants: [['gl.intercompany', V], ['gl.internal_invoices', V]] },
  { cell: 'intercompany::create', grants: [['gl.intercompany', ['create', 'edit', 'post']], ['gl.internal_invoices', ['create', 'edit', 'release']]] },
  // `payments` view/run is the retired coarse superset — no rules (its holders hold the
  // granular keys below in every shipped role).
  { cell: 'payments_execute::view', grants: [['pay.customer_payments', V]] },
  { cell: 'payments_execute::run', grants: [['pay.customer_payments', ['create', 'edit', 'post']]] },
  { cell: 'check_run::view', grants: [['pay.batches', V]] },
  { cell: 'check_run::run', grants: [['pay.batches', ['create', 'edit']]] },
  { cell: 'ap_disbursement_release::view', grants: [['pay.batches', V]] },
  { cell: 'ap_disbursement_release::run', grants: [['pay.batches', ['release']]] },
  { cell: 'payroll_release::view', grants: [['payroll.runs', V]] },
  { cell: 'payroll_release::run', grants: [['payroll.runs', ['release']]] },
  // cash
  { cell: 'cash_position::view', grants: [['cash.position', V]] },
  { cell: 'forecast::view', grants: [['cash.forecast', V], ['cash.obligations', V]] },
  { cell: 'forecast::edit', grants: [['cash.forecast', ['create', 'edit']], ['cash.obligations', ['create', 'edit']]] },
  // team / user permissions
  { cell: 'team::view', grants: [['core.access.members', V], ['ws.assignments', V]] },
  { cell: 'team::manage', grants: [['core.access.members', ['create', 'edit', 'delete']], ['ws.assignments', ['create', 'edit', 'delete']]] },
  { cell: 'user_permissions::view', grants: [['core.access.roles', V], ['core.access.assignments', V]] },
  { cell: 'user_permissions::assign', grants: [['core.access.roles', ['create', 'edit', 'delete', 'configure']], ['core.access.assignments', ['create', 'edit', 'delete']]] },
  // compliance (+ PBC borrowed it)
  { cell: 'compliance::view', grants: [['ctl.vendor_compliance', V], ['ctl.compliance', V], ['ctl.pbc', V]] },
  { cell: 'compliance::manage', grants: [['ctl.vendor_compliance', ['edit', 'approve']], ['ctl.compliance', ['edit', 'approve']], ['ctl.pbc', ['create', 'edit', 'approve']]] },
  // fixed assets
  { cell: 'fixed_assets::view', grants: [['fa.assets', V], ['fa.leases', V], ['fa.prepaids', V]] },
  { cell: 'fixed_assets::create', grants: [['fa.assets', ['create', 'edit', 'post']], ['fa.leases', ['create', 'edit', 'post']], ['fa.prepaids', ['create', 'edit', 'post']]] },
  // recurring (+ post where the role posts JEs)
  { cell: 'recurring::view', grants: [['gl.recurring_entries', V]] },
  { cell: 'recurring::create', grants: [['gl.recurring_entries', ['create', 'edit']]] },
  { cell: 'recurring::create', grants: [['gl.recurring_entries', ['post']]], requiresAll: ['journal_entries::post'] },
  // settings
  { cell: 'settings_acct::view', grants: [['core.tenant.accounting_settings', V]] },
  { cell: 'settings_acct::edit', grants: [['core.tenant.accounting_settings', ['configure']]] },
  {
    cell: 'settings_system::view',
    grants: [
      ['core.tenant.settings', V], ['core.tenant.billing', V], ['pay.provider_connections', V],
      ['ctl.approval_workflows', V], ['ai.autonomy', V], ['int.connections', V], ['ws.client_health', V],
    ],
  },
  {
    cell: 'settings_system::edit',
    grants: [
      ['core.tenant.settings', ['configure']], ['core.tenant.billing', ['configure']],
      ['pay.provider_connections', ['configure']], ['ctl.approval_workflows', ['configure']],
      ['ai.autonomy', ['configure']], ['int.connections', ['create', 'delete', 'configure']],
    ],
  },
  // import
  { cell: 'import::view', grants: [['onb.imports', V], ['onb.conversion', V]] },
  { cell: 'import::run', grants: [['onb.imports', ['create']], ['onb.conversion', ['approve', 'post']]] },
  { cell: 'import::run', grants: [['onb.imports', ['post']]], requiresAll: ['journal_entries::post'] },
  // audit trail
  { cell: 'audit_trail::view', grants: [['ctl.audit_trail', V], ['ctl.ai_decisions', V]] },
  // checks
  { cell: 'checks::view', grants: [['pay.checks', V]] },
  { cell: 'checks::create', grants: [['pay.checks', ['create', 'edit']]] },
  { cell: 'checks::approve', grants: [['pay.batches', ['approve']]] },
  // business view (retired → Owner on assigned scope)
  { cell: 'biz_dashboard::view', grants: [['home.client', V]] },
  { cell: 'biz_reports::view', grants: [['reports.financial', V]] },
  { cell: 'biz_reports::export', grants: [['reports.financial', ['export']]] },
  { cell: 'biz_invoices::view', grants: [['ar.invoices', V]] },
  { cell: 'biz_payroll::view', grants: [['payroll.register', V]] },
  { cell: 'biz_jobs::view', grants: [['jobs.jobs', V]] },
  { cell: 'biz_cash::view', grants: [['cash.position', V]] },
  // role flags
  {
    cell: 'flag::canManageUsers',
    grants: [
      ['core.access.members', ['view', 'create', 'edit', 'delete']],
      ['core.access.roles', ['view', 'create', 'edit', 'delete', 'configure']],
      ['core.access.assignments', ['view', 'create', 'edit', 'delete']],
      ['core.access.reviews', ['view', 'create', 'approve', 'export']],
      ['core.access.simulate', V],
      ['core.access.sod_policy', ['view', 'configure']],
    ],
  },
  { cell: 'flag::canEditAccountingSettings', grants: [['core.tenant.accounting_settings', ['view', 'configure']]] },
  { cell: 'flag::canEditSystemSettings', grants: [['core.tenant.settings', ['view', 'configure']]] },
];

/**
 * The capability a route gated on each legacy cell will check after the flip. Cells
 * absent here (`payments::*`) are retired and not compared.
 */
export const LEGACY_PRIMARY: Readonly<Record<LegacyCell, string>> = {
  'dashboard::view': 'home.workspace:view',
  'bank_feed::view': 'bank.transactions:view',
  'bank_feed::edit': 'bank.transactions:edit',
  'bank_feed::approve': 'bank.transactions:approve',
  'credit_cards::view': 'cards.transactions:view',
  'credit_cards::edit': 'cards.transactions:edit',
  'credit_cards::approve': 'cards.transactions:approve',
  'receipts::view': 'exp.receipts:view',
  'receipts::edit': 'exp.receipts:edit',
  'receipts::approve': 'exp.receipts:approve',
  'bills::view': 'ap.bills:view',
  'bills::create': 'ap.bills:create',
  'bills::approve': 'ap.bills:approve',
  'journal_entries::view': 'gl.journal_entries:view',
  'journal_entries::create': 'gl.journal_entries:create',
  'journal_entries::post': 'gl.journal_entries:post',
  'flagged::view': 'ctl.exceptions:view',
  'flagged::resolve': 'ctl.exceptions:edit',
  'vendors::view': 'mdm.vendors:view',
  'vendors::create': 'mdm.vendors:create',
  'vendors::edit': 'mdm.vendors:edit',
  'customers::view': 'mdm.customers:view',
  'customers::create': 'mdm.customers:create',
  'customers::edit': 'mdm.customers:edit',
  'invoices::view': 'ar.invoices:view',
  'invoices::create': 'ar.invoices:create',
  'invoices::approve': 'ar.invoices:approve',
  'jobs::view': 'jobs.jobs:view',
  'jobs::create': 'jobs.jobs:create',
  'jobs::edit': 'jobs.jobs:edit',
  'reports::view': 'reports.financial:view',
  'reports::export': 'reports.financial:export',
  'chart_of_accounts::view': 'gl.accounts:view',
  'chart_of_accounts::request': 'gl.accounts:create',
  'chart_of_accounts::approve': 'gl.accounts:approve',
  'reconciliation::view': 'bank.reconciliations:view',
  'reconciliation::reconcile': 'bank.reconciliations:edit',
  'close_mgmt::view': 'close.checklist:view',
  'close_mgmt::manage': 'close.checklist:edit',
  'payroll::view': 'payroll.register:view',
  'payroll::create': 'payroll.register:create',
  'payroll::approve': 'payroll.runs:approve',
  'intercompany::view': 'gl.intercompany:view',
  'intercompany::create': 'gl.intercompany:create',
  'payments_execute::view': 'pay.customer_payments:view',
  'payments_execute::run': 'pay.customer_payments:create',
  'check_run::view': 'pay.batches:view',
  'check_run::run': 'pay.batches:create',
  'ap_disbursement_release::view': 'pay.batches:view',
  'ap_disbursement_release::run': 'pay.batches:release',
  'payroll_release::view': 'payroll.runs:view',
  'payroll_release::run': 'payroll.runs:release',
  'cash_position::view': 'cash.position:view',
  'forecast::view': 'cash.forecast:view',
  'forecast::edit': 'cash.forecast:edit',
  'team::view': 'core.access.members:view',
  'team::manage': 'core.access.members:edit',
  'user_permissions::view': 'core.access.roles:view',
  'user_permissions::assign': 'core.access.assignments:create',
  'compliance::view': 'ctl.compliance:view',
  'compliance::manage': 'ctl.compliance:edit',
  'fixed_assets::view': 'fa.assets:view',
  'fixed_assets::create': 'fa.assets:create',
  'recurring::view': 'gl.recurring_entries:view',
  'recurring::create': 'gl.recurring_entries:create',
  'settings_acct::view': 'core.tenant.accounting_settings:view',
  'settings_acct::edit': 'core.tenant.accounting_settings:configure',
  'settings_system::view': 'core.tenant.settings:view',
  'settings_system::edit': 'core.tenant.settings:configure',
  'import::view': 'onb.imports:view',
  'import::run': 'onb.imports:create',
  'audit_trail::view': 'ctl.audit_trail:view',
  'checks::view': 'pay.checks:view',
  'checks::create': 'pay.checks:create',
  'checks::approve': 'pay.batches:approve',
  'biz_dashboard::view': 'home.client:view',
  'biz_reports::view': 'reports.financial:view',
  'biz_reports::export': 'reports.financial:export',
  'biz_invoices::view': 'ar.invoices:view',
  'biz_payroll::view': 'payroll.register:view',
  'biz_jobs::view': 'jobs.jobs:view',
  'biz_cash::view': 'cash.position:view',
};

/** Legacy key → IA §2.5 standard role key. */
export const LEGACY_ROLE_TO_TEMPLATE: Readonly<Record<UserRole, string>> = {
  company_admin: 'tenant_admin',
  cfo: 'cfo',
  merit_controller: 'controller',
  assistant_cfo: 'finance_director',
  accounting_manager: 'accounting_manager',
  accounting_specialist: 'bookkeeper',
  check_processor: 'payments_clerk',
  general_admin: 'data_entry',
  business_user: 'owner',
};

/** How each legacy companyScope backfills (05 §2.3, R-4). */
export type LegacyScopeKind = 'all_clients' | 'all_except_own_books' | 'assigned';
export function legacyScopeKind(role: UserRole): LegacyScopeKind {
  const s = ROLE_DEFINITIONS[role].companyScope;
  if (s === 'all') return 'all_clients';
  if (s === 'portcos_and_3rdparty') return 'all_except_own_books';
  return 'assigned';
}

/**
 * How the legacy role's expanded grants split between the tenant ROLE and a "Legacy …"
 * PERMISSION SET (05 §7 backfill mapping):
 *  - company_admin → Tenant admin (the standard template's grants) + "Legacy full books"
 *    set = everything else the legacy role held;
 *  - merit_controller → Controller (legacy grants minus money release) + "Legacy controller
 *    release" set = the money-release actions;
 *  - every other legacy role → a tenant role holding exactly its legacy grants.
 */
export type LegacySplit = 'template_plus_legacy_set' | 'money_release_set' | 'none';
export const LEGACY_SPLIT: Readonly<Record<UserRole, LegacySplit>> = {
  company_admin: 'template_plus_legacy_set',
  cfo: 'none',
  merit_controller: 'money_release_set',
  assistant_cfo: 'none',
  accounting_manager: 'none',
  accounting_specialist: 'none',
  check_processor: 'none',
  general_admin: 'none',
  business_user: 'none',
};
export const LEGACY_SET_KEY: Readonly<Partial<Record<UserRole, string>>> = {
  company_admin: 'legacy_full_books',
  merit_controller: 'legacy_controller_release',
};

/** Field policy derived from payrollVisibility (05 §3.6). business_user → comp `grouped` (05 §2.3 tighten). */
export function legacyFieldPolicy(role: UserRole): Record<string, string> {
  const pv = ROLE_DEFINITIONS[role].payrollVisibility;
  const comp = role === 'business_user' ? 'grouped' : pv === 'ungrouped' ? 'visible' : pv === 'grouped' ? 'grouped' : 'hidden';
  return { comp, tin: 'masked', bank: 'masked', personal: 'hidden' };
}

export function legacyAssignableBand(role: UserRole): 'tenant_admin_only' | 'managers' | 'any_grantor' {
  const by = ROLE_DEFINITIONS[role].assignableBy;
  if (by.length === 1 && by[0] === 'company_admin') return 'tenant_admin_only';
  return 'managers';
}

/** Every allowed legacy cell of a system role (incl. flag pseudo-cells). */
export function legacyRoleCells(role: UserRole): Set<LegacyCell> {
  const def = ROLE_DEFINITIONS[role];
  const cells = new Set<LegacyCell>();
  for (const feat of FEATURE_CATALOG) {
    const perms = def.features[feat.id];
    if (!perms) continue;
    for (const a of feat.actions) if (perms[a] === true) cells.add(legacyCell(feat.id, a));
  }
  if (def.canManageUsers) cells.add('flag::canManageUsers');
  if (def.canEditAccountingSettings) cells.add('flag::canEditAccountingSettings');
  if (def.canEditSystemSettings) cells.add('flag::canEditSystemSettings');
  return cells;
}

/** Apply mig-130 cell overrides ({ 'feature::action': boolean }) on top of a cell set. */
export function applyCellOverrides(base: ReadonlySet<LegacyCell>, overrides: Readonly<Record<string, boolean>>): Set<LegacyCell> {
  const out = new Set(base);
  for (const [cell, allowed] of Object.entries(overrides)) {
    if (cell.startsWith('flag::')) continue; // overrides never touch role flags
    if (allowed) out.add(cell);
    else out.delete(cell);
  }
  return out;
}

export type GrantMap = Map<string, Set<Action>>;

/** Expand a set of allowed legacy cells into capability grants (05 §2.3). */
export function expandLegacyCells(cells: ReadonlySet<LegacyCell>): GrantMap {
  const out: GrantMap = new Map();
  for (const rule of LEGACY_RULES) {
    if (!cells.has(rule.cell)) continue;
    if (rule.requiresAll && !rule.requiresAll.every((c) => cells.has(c))) continue;
    if (rule.requiresAny && rule.requiresAny.length > 0 && !rule.requiresAny.some((c) => cells.has(c))) continue;
    for (const [capKey, actions] of rule.grants) {
      if (!out.has(capKey)) out.set(capKey, new Set());
      const set = out.get(capKey)!;
      for (const a of actions) set.add(a);
    }
  }
  return out;
}

/** Normalize a GrantMap to a sorted, comparable array. */
export function grantMapToRows(map: GrantMap): Array<{ capability: string; actions: Action[] }> {
  return [...map.entries()]
    .filter(([, s]) => s.size > 0)
    .map(([capability, s]) => ({ capability, actions: ACTIONS.filter((a) => s.has(a)) }))
    .sort((a, b) => a.capability.localeCompare(b.capability));
}

/** Set difference a − b on grant maps (per capability, per action). */
export function subtractGrants(a: GrantMap, b: GrantMap): GrantMap {
  const out: GrantMap = new Map();
  for (const [k, acts] of a) {
    const minus = b.get(k);
    const rest = new Set([...acts].filter((x) => !minus?.has(x)));
    if (rest.size > 0) out.set(k, rest);
  }
  return out;
}

/** Only the money-release actions (release on a money-tagged capability). */
export function moneyReleaseGrants(a: GrantMap): GrantMap {
  const out: GrantMap = new Map();
  for (const [k, acts] of a) {
    const def = CAPABILITY_BY_KEY.get(k);
    if (def?.tags.includes('money') && acts.has('release')) out.set(k, new Set<Action>(['release']));
  }
  return out;
}

/** Flattened rule rows, the exact shape mirrored to core.legacy_cell_rules. */
export interface LegacyRuleRow {
  ruleNo: number;
  cell: LegacyCell;
  capability: string;
  actions: Action[];
  requiresAll: LegacyCell[];
  requiresAny: LegacyCell[];
}
export function legacyRuleRows(): LegacyRuleRow[] {
  const rows: LegacyRuleRow[] = [];
  LEGACY_RULES.forEach((r, i) => {
    for (const [capability, actions] of r.grants) {
      rows.push({
        ruleNo: i + 1,
        cell: r.cell,
        capability,
        actions: ACTIONS.filter((a) => actions.includes(a)),
        requiresAll: [...(r.requiresAll ?? [])],
        requiresAny: [...(r.requiresAny ?? [])],
      });
    }
  });
  return rows;
}

export const LEGACY_SYSTEM_ROLES: readonly UserRole[] = ALL_ROLES;

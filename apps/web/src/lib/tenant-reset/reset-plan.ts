/**
 * Tenant reset plan — the SINGLE SOURCE OF TRUTH for "reset this tenant to a
 * clean slate before go-live."
 *
 * This module is PURE (no I/O, unit-testable). It enumerates, table by table,
 * exactly what a reset WOULD clear for one org, split into three scopes:
 *
 *   - 'transactional'      → always cleared (ledger + sub-ledgers + banking +
 *                             AI/automation logs + close/controls + tax working
 *                             data + budgets + intercompany + inventory). This is
 *                             the demo/seed + posted activity a real go-live sheds.
 *   - 'master_data'        → OPTIONAL (default OFF). Customers, vendors, items,
 *                             jobs, employees, and the entity/location structure.
 *                             Clearing this is more destructive, so it is opt-in.
 *   - 'chart_of_accounts'  → OPTIONAL (default OFF = PRESERVE the COA). The chart
 *                             of accounts + fiscal-period structure. Most go-lives
 *                             keep the COA, so preservation is the default choice.
 *
 * NEVER in any scope (the PRESERVED shell — see RESET_PRESERVED): the org row
 * itself, the identity spine (core.users / core.memberships /
 * core.membership_locations / core.platform_admin_sessions), and configuration/
 * reference data (policies, AI tier config, transaction types, fee schedules).
 * A reset must NEVER hard-delete identity or the org.
 *
 * IMPORTANT (reserved-migration boundary): the ACTUAL deletion is performed by a
 * reserved server-side RPC (`public.reset_tenant_data`) that the lead installs —
 * NOT by this app. This registry is (a) what the preview counts, and (b) the
 * authoritative spec the RPC's delete-set must match. The RPC and this list must
 * be kept in lock-step; the RPC — not this file — is the guarantor of what is
 * actually removed, and it runs inside one transaction after snapshotting.
 *
 * proj.* (the separate PM module) is intentionally OUT OF SCOPE here.
 */

export type ResetScope = 'transactional' | 'master_data' | 'chart_of_accounts';

export interface ResetTable {
  /** Postgres schema — 'public' or 'core'. */
  schema: 'public' | 'core';
  /** Table name. */
  table: string;
  /** Human label for the preview UI. */
  label: string;
  /** Display grouping within a scope. */
  group: string;
  /** Which reset scope this table belongs to. */
  scope: ResetScope;
}

/**
 * The reset registry. Ordering within `transactional` is child-before-parent so a
 * naive sequential delete respects FKs, but the reserved RPC should not rely on
 * this order (it clears inside one transaction, and most child rows also cascade).
 */
export const RESET_TABLES: readonly ResetTable[] = [
  // ── Ledger ────────────────────────────────────────────────────────────────
  { schema: 'public', table: 'gl_entry_lines', label: 'GL entry lines', group: 'General ledger', scope: 'transactional' },
  { schema: 'public', table: 'gl_entries', label: 'GL entries / journal entries', group: 'General ledger', scope: 'transactional' },
  { schema: 'public', table: 'posting_schedule_runs', label: 'Posting schedule runs', group: 'General ledger', scope: 'transactional' },
  { schema: 'public', table: 'posting_schedules', label: 'Posting schedules', group: 'General ledger', scope: 'transactional' },
  { schema: 'public', table: 'recurring_je_runs', label: 'Recurring JE runs', group: 'General ledger', scope: 'transactional' },
  { schema: 'public', table: 'recurring_je_templates', label: 'Recurring JE templates', group: 'General ledger', scope: 'transactional' },
  { schema: 'public', table: 'recurring_templates', label: 'Recurring templates', group: 'General ledger', scope: 'transactional' },

  // ── Banking ───────────────────────────────────────────────────────────────
  { schema: 'public', table: 'bank_reconciliations', label: 'Bank reconciliations', group: 'Banking', scope: 'transactional' },
  { schema: 'public', table: 'bank_transactions', label: 'Bank transactions (feed)', group: 'Banking', scope: 'transactional' },
  { schema: 'public', table: 'ach_authorizations', label: 'ACH authorizations', group: 'Banking', scope: 'transactional' },
  { schema: 'public', table: 'plaid_pending_accounts', label: 'Plaid pending accounts', group: 'Banking', scope: 'transactional' },
  { schema: 'public', table: 'plaid_items', label: 'Plaid connections', group: 'Banking', scope: 'transactional' },
  { schema: 'public', table: 'bank_accounts', label: 'Bank accounts', group: 'Banking', scope: 'transactional' },

  // ── Accounts payable ──────────────────────────────────────────────────────
  { schema: 'public', table: 'bill_po_links', label: 'Bill ↔ PO links', group: 'Accounts payable', scope: 'transactional' },
  { schema: 'public', table: 'bill_payments', label: 'Bill payments', group: 'Accounts payable', scope: 'transactional' },
  { schema: 'public', table: 'bill_lines', label: 'Bill lines', group: 'Accounts payable', scope: 'transactional' },
  { schema: 'public', table: 'bills', label: 'Bills', group: 'Accounts payable', scope: 'transactional' },
  { schema: 'public', table: 'vendor_payment_holds', label: 'Vendor payment holds', group: 'Accounts payable', scope: 'transactional' },
  { schema: 'public', table: 'disbursement_batch_items', label: 'Disbursement batch items', group: 'Accounts payable', scope: 'transactional' },
  { schema: 'public', table: 'disbursement_batches', label: 'Disbursement batches', group: 'Accounts payable', scope: 'transactional' },
  { schema: 'public', table: 'goods_receipt_lines', label: 'Goods-receipt lines', group: 'Accounts payable', scope: 'transactional' },
  { schema: 'public', table: 'goods_receipts', label: 'Goods receipts', group: 'Accounts payable', scope: 'transactional' },
  { schema: 'public', table: 'purchase_order_lines', label: 'Purchase-order lines', group: 'Accounts payable', scope: 'transactional' },
  { schema: 'public', table: 'purchase_orders', label: 'Purchase orders', group: 'Accounts payable', scope: 'transactional' },
  { schema: 'public', table: 'expense_report_lines', label: 'Expense-report lines', group: 'Accounts payable', scope: 'transactional' },
  { schema: 'public', table: 'expense_reports', label: 'Expense reports', group: 'Accounts payable', scope: 'transactional' },
  { schema: 'public', table: 'receipts', label: 'Receipts', group: 'Accounts payable', scope: 'transactional' },

  // ── Accounts receivable ───────────────────────────────────────────────────
  { schema: 'public', table: 'payment_applications', label: 'Payment applications', group: 'Accounts receivable', scope: 'transactional' },
  { schema: 'public', table: 'customer_payments', label: 'Customer payments', group: 'Accounts receivable', scope: 'transactional' },
  { schema: 'public', table: 'credit_memo_lines', label: 'Credit-memo lines', group: 'Accounts receivable', scope: 'transactional' },
  { schema: 'public', table: 'credit_memos', label: 'Credit memos', group: 'Accounts receivable', scope: 'transactional' },
  { schema: 'public', table: 'invoice_events', label: 'Invoice events', group: 'Accounts receivable', scope: 'transactional' },
  { schema: 'public', table: 'invoice_lines', label: 'Invoice lines', group: 'Accounts receivable', scope: 'transactional' },
  { schema: 'public', table: 'invoices', label: 'Invoices', group: 'Accounts receivable', scope: 'transactional' },
  { schema: 'public', table: 'recurring_invoice_templates', label: 'Recurring invoice templates', group: 'Accounts receivable', scope: 'transactional' },
  { schema: 'public', table: 'revenue_recognition_runs', label: 'Revenue-recognition runs', group: 'Accounts receivable', scope: 'transactional' },

  // ── Intercompany ──────────────────────────────────────────────────────────
  { schema: 'public', table: 'internal_invoice_lines', label: 'Internal-invoice lines', group: 'Intercompany', scope: 'transactional' },
  { schema: 'public', table: 'internal_invoices', label: 'Internal invoices', group: 'Intercompany', scope: 'transactional' },
  { schema: 'public', table: 'intercompany_transactions', label: 'Intercompany transactions', group: 'Intercompany', scope: 'transactional' },
  { schema: 'public', table: 'intercompany_balances', label: 'Intercompany balances', group: 'Intercompany', scope: 'transactional' },
  { schema: 'public', table: 'intercompany_loans', label: 'Intercompany loans', group: 'Intercompany', scope: 'transactional' },

  // ── Payroll (posted runs; provider config preserved) ──────────────────────
  { schema: 'public', table: 'payroll_run_employees', label: 'Payroll-run employees', group: 'Payroll', scope: 'transactional' },
  { schema: 'public', table: 'payroll_runs', label: 'Payroll runs', group: 'Payroll', scope: 'transactional' },

  // ── Assets, debt, leases, insurance ───────────────────────────────────────
  { schema: 'public', table: 'depreciation_runs', label: 'Depreciation runs', group: 'Assets & debt', scope: 'transactional' },
  { schema: 'public', table: 'tax_depreciation_runs', label: 'Tax-depreciation runs', group: 'Assets & debt', scope: 'transactional' },
  { schema: 'public', table: 'fixed_assets', label: 'Fixed assets', group: 'Assets & debt', scope: 'transactional' },
  { schema: 'public', table: 'lease_schedule_lines', label: 'Lease schedule lines', group: 'Assets & debt', scope: 'transactional' },
  { schema: 'public', table: 'leases', label: 'Leases', group: 'Assets & debt', scope: 'transactional' },
  { schema: 'public', table: 'debt_schedule_lines', label: 'Debt schedule lines', group: 'Assets & debt', scope: 'transactional' },
  { schema: 'public', table: 'debt_instruments', label: 'Debt instruments', group: 'Assets & debt', scope: 'transactional' },
  { schema: 'public', table: 'covenant_measurements', label: 'Covenant measurements', group: 'Assets & debt', scope: 'transactional' },
  { schema: 'public', table: 'loan_covenants', label: 'Loan covenants', group: 'Assets & debt', scope: 'transactional' },
  { schema: 'public', table: 'insurance_policies', label: 'Insurance policies', group: 'Assets & debt', scope: 'transactional' },
  { schema: 'public', table: 'subscriptions', label: 'Subscriptions', group: 'Assets & debt', scope: 'transactional' },

  // ── Inventory ─────────────────────────────────────────────────────────────
  { schema: 'public', table: 'inventory_movements', label: 'Inventory movements', group: 'Inventory', scope: 'transactional' },
  { schema: 'public', table: 'inventory_items', label: 'Inventory items', group: 'Inventory', scope: 'transactional' },

  // ── Tax working data ──────────────────────────────────────────────────────
  { schema: 'public', table: 'book_tax_line_overrides', label: 'Book-tax line overrides', group: 'Tax working data', scope: 'transactional' },
  { schema: 'public', table: 'book_tax_m_lines', label: 'Book-tax M-lines', group: 'Tax working data', scope: 'transactional' },
  { schema: 'public', table: 'deferred_tax_items', label: 'Deferred-tax items', group: 'Tax working data', scope: 'transactional' },
  { schema: 'public', table: 'tax_provision', label: 'Tax provision', group: 'Tax working data', scope: 'transactional' },
  { schema: 'public', table: 'sales_tax_filings', label: 'Sales-tax filings', group: 'Tax working data', scope: 'transactional' },
  { schema: 'public', table: 'compliance_filings', label: 'Compliance filings (1099 etc.)', group: 'Tax working data', scope: 'transactional' },

  // ── Close, controls & compliance ──────────────────────────────────────────
  { schema: 'public', table: 'approval_request_actions', label: 'Approval-request actions', group: 'Close & controls', scope: 'transactional' },
  { schema: 'public', table: 'approval_requests', label: 'Approval requests', group: 'Close & controls', scope: 'transactional' },
  { schema: 'public', table: 'approval_steps', label: 'Approval steps', group: 'Close & controls', scope: 'transactional' },
  { schema: 'public', table: 'approvals', label: 'Approvals', group: 'Close & controls', scope: 'transactional' },
  { schema: 'public', table: 'close_checklists', label: 'Close checklists', group: 'Close & controls', scope: 'transactional' },
  { schema: 'public', table: 'working_papers', label: 'Working papers', group: 'Close & controls', scope: 'transactional' },
  { schema: 'public', table: 'year_end_closes', label: 'Year-end closes', group: 'Close & controls', scope: 'transactional' },
  { schema: 'public', table: 'compliance_obligations', label: 'Compliance obligations', group: 'Close & controls', scope: 'transactional' },
  { schema: 'public', table: 'vendor_compliance_events', label: 'Vendor-compliance events', group: 'Close & controls', scope: 'transactional' },
  { schema: 'public', table: 'vendor_compliance_docs', label: 'Vendor-compliance docs', group: 'Close & controls', scope: 'transactional' },
  { schema: 'public', table: 'documents', label: 'Uploaded documents (metadata)', group: 'Close & controls', scope: 'transactional' },

  // ── Budgets & planning ────────────────────────────────────────────────────
  { schema: 'public', table: 'budget_versions', label: 'Budget versions', group: 'Budgets & planning', scope: 'transactional' },
  { schema: 'public', table: 'budgets', label: 'Budgets', group: 'Budgets & planning', scope: 'transactional' },

  // ── AI & automation activity ──────────────────────────────────────────────
  { schema: 'public', table: 'agent_run_steps', label: 'Agent-run steps', group: 'AI & automation', scope: 'transactional' },
  { schema: 'public', table: 'agent_runs', label: 'Agent runs', group: 'AI & automation', scope: 'transactional' },
  { schema: 'public', table: 'ai_decisions', label: 'AI decisions', group: 'AI & automation', scope: 'transactional' },
  { schema: 'public', table: 'ai_audit_log', label: 'AI audit log', group: 'AI & automation', scope: 'transactional' },
  { schema: 'public', table: 'vendor_patterns', label: 'Learned vendor patterns', group: 'AI & automation', scope: 'transactional' },
  { schema: 'public', table: 'learned_preferences', label: 'Learned preferences', group: 'AI & automation', scope: 'transactional' },
  { schema: 'core', table: 'action_log', label: 'Action log (activity trail)', group: 'AI & automation', scope: 'transactional' },

  // ── Master data (OPTIONAL — default preserve) ─────────────────────────────
  { schema: 'public', table: 'employee_locations', label: 'Employee ↔ location links', group: 'Master data', scope: 'master_data' },
  { schema: 'core', table: 'employees', label: 'Employees', group: 'Master data', scope: 'master_data' },
  { schema: 'core', table: 'customers', label: 'Customers', group: 'Master data', scope: 'master_data' },
  { schema: 'core', table: 'vendors', label: 'Vendors', group: 'Master data', scope: 'master_data' },
  { schema: 'core', table: 'items', label: 'Items / products', group: 'Master data', scope: 'master_data' },
  { schema: 'core', table: 'jobs', label: 'Jobs', group: 'Master data', scope: 'master_data' },
  { schema: 'public', table: 'job_phases', label: 'Job phases', group: 'Master data', scope: 'master_data' },
  { schema: 'public', table: 'entity_ownership', label: 'Entity ownership', group: 'Master data', scope: 'master_data' },
  { schema: 'public', table: 'location_departments', label: 'Location ↔ department links', group: 'Master data', scope: 'master_data' },
  { schema: 'public', table: 'location_classes', label: 'Location ↔ class links', group: 'Master data', scope: 'master_data' },
  { schema: 'core', table: 'departments', label: 'Departments', group: 'Master data', scope: 'master_data' },
  { schema: 'public', table: 'classes', label: 'Classes', group: 'Master data', scope: 'master_data' },
  { schema: 'core', table: 'locations', label: 'Locations / companies', group: 'Master data', scope: 'master_data' },

  // ── Chart of accounts & period structure (OPTIONAL — default preserve) ─────
  { schema: 'public', table: 'fiscal_periods', label: 'Fiscal periods', group: 'Chart of accounts', scope: 'chart_of_accounts' },
  { schema: 'public', table: 'accounts', label: 'Accounts', group: 'Chart of accounts', scope: 'chart_of_accounts' },
  { schema: 'public', table: 'account_groups', label: 'Account groups', group: 'Chart of accounts', scope: 'chart_of_accounts' },
  { schema: 'public', table: 'account_sub_types', label: 'Account sub-types', group: 'Chart of accounts', scope: 'chart_of_accounts' },
  { schema: 'public', table: 'account_types', label: 'Account types', group: 'Chart of accounts', scope: 'chart_of_accounts' },
];

/**
 * The PRESERVED shell — enumerated for documentation and to make the promise
 * explicit in the UI. A reset NEVER touches these; identity and the org are
 * never hard-deleted.
 */
export const RESET_PRESERVED: readonly { label: string; detail: string }[] = [
  { label: 'The organization', detail: 'core.organizations — the tenant shell, name, and settings' },
  { label: 'Users & memberships', detail: 'core.users, core.memberships, core.membership_locations' },
  { label: 'Platform audit', detail: 'core.platform_admin_sessions' },
  { label: 'Policies & configuration', detail: 'expense/AP/company policies, autonomy & performance config' },
  { label: 'Reference data', detail: 'fee schedules, transaction types, AI tier config, account-role keys' },
];

/** Options that widen a reset beyond the always-cleared transactional scope. */
export interface ResetOptions {
  clearMasterData: boolean;
  clearChartOfAccounts: boolean;
}

export const DEFAULT_RESET_OPTIONS: ResetOptions = {
  clearMasterData: false,
  clearChartOfAccounts: false,
};

/** Which scopes are in play for a given set of options. */
export function scopesForOptions(opts: ResetOptions): ResetScope[] {
  const scopes: ResetScope[] = ['transactional'];
  if (opts.clearMasterData) scopes.push('master_data');
  if (opts.clearChartOfAccounts) scopes.push('chart_of_accounts');
  return scopes;
}

/** The tables that WOULD be cleared given the options (respecting scope gates). */
export function tablesForOptions(opts: ResetOptions): ResetTable[] {
  const scopes = new Set(scopesForOptions(opts));
  return RESET_TABLES.filter((t) => scopes.has(t.scope));
}

/** A stable, fully-qualified key for a table. */
export function tableKey(t: Pick<ResetTable, 'schema' | 'table'>): string {
  return `${t.schema}.${t.table}`;
}

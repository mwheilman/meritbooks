/**
 * CAPABILITY REGISTRY — the code source of truth for the RBAC vocabulary
 * (docs/ia/05-RBAC-SPEC.md §2, IA-SPEC §2.6 amendment A-3; migration R-1).
 *
 * A capability is `resource × action`. Resources are namespaced `<domain>.<resource>`
 * (the `books.` module prefix is implied for books resources, exactly as 05 §2.2 writes
 * them: `ap.bills`, `gl.journal_entries`). Core- and platform-owned resources keep their
 * prefix (`core.access.roles`, `platform.tenants`) and carry `module: 'core' | 'platform'`.
 *
 * This file is MIRRORED to `core.capabilities` by migration 157 (generated block — see
 * scripts/rbac/generate-access-seed.ts). A guard test (src/test/access-foundations.test.ts)
 * replays the migrations and fails the build if the DB mirror and this registry differ.
 *
 * PURE: no I/O. Safe to import from server or client code.
 */

export const ACTIONS = [
  'view',
  'create',
  'edit',
  'delete',
  'approve',
  'post',
  'release',
  'export',
  'configure',
] as const;
export type Action = (typeof ACTIONS)[number];

/** [M] money effect · [S] sensitive fields · [L] locked (step-up + MFA, never external) · [G] group-scoped. */
export type CapabilityTag = 'money' | 'sensitive' | 'locked' | 'group';
export type FieldClass = 'comp' | 'tin' | 'bank' | 'personal' | 'secrets';
export type ConstraintKind =
  | 'amount_limit'
  | 'dimension_restriction'
  | 'doc_types'
  | 'ownership'
  | 'period'
  | 'delivered_to_me'
  | 'assigned_to_me';
export type CapabilityModule = 'books' | 'core' | 'platform';
export type RiskTier = 'standard' | 'elevated' | 'high' | 'critical';

export interface CapabilityDef {
  /** Resource key, e.g. `ap.bills`. The capability is `${key}:${action}`. */
  key: string;
  module: CapabilityModule;
  /** Builder left-rail area (05 §6.2). */
  domain: string;
  actions: readonly Action[];
  label: string;
  description: string;
  tags: readonly CapabilityTag[];
  fieldClasses: readonly FieldClass[];
  supportsConstraints: readonly ConstraintKind[];
  introducedIn: string;
  status: 'active' | 'deprecated';
  aliasOf: string | null;
}

const ACTION_CODES: Record<string, Action> = {
  V: 'view',
  C: 'create',
  E: 'edit',
  D: 'delete',
  A: 'approve',
  P: 'post',
  R: 'release',
  X: 'export',
  K: 'configure',
};

/** Parse 05 §2.2's compact action letters ("V C E D A P X") into canonical order. */
export function parseActionLetters(letters: string): Action[] {
  const set = new Set<Action>();
  for (const ch of letters.replace(/\s+/g, '')) {
    const a = ACTION_CODES[ch];
    if (!a) throw new Error(`unknown action letter '${ch}'`);
    set.add(a);
  }
  return ACTIONS.filter((a) => set.has(a));
}

interface Opts {
  tags?: CapabilityTag[];
  fields?: FieldClass[];
  constraints?: ConstraintKind[];
  module?: CapabilityModule;
  introducedIn?: string;
}

const MONEY_LIMIT: ConstraintKind[] = ['amount_limit'];

function cap(
  domain: string,
  key: string,
  letters: string,
  label: string,
  description: string,
  opts: Opts = {},
): CapabilityDef {
  const module: CapabilityModule =
    opts.module ?? (key.startsWith('core.') ? 'core' : key.startsWith('platform.') ? 'platform' : 'books');
  return {
    key,
    module,
    domain,
    actions: parseActionLetters(letters),
    label,
    description,
    tags: opts.tags ?? [],
    fieldClasses: opts.fields ?? [],
    supportsConstraints: opts.constraints ?? [],
    introducedIn: opts.introducedIn ?? 'wave1',
    status: 'active',
    aliasOf: null,
  };
}

/** The full catalog (05 §2.2 + IA A-3). Order is the builder order. */
export const CAPABILITIES: readonly CapabilityDef[] = [
  // ── GL ──────────────────────────────────────────────────────────────────────
  cap('GL', 'gl.accounts', 'V C E D A X K', 'Chart of accounts', 'Accounts, account requests (create) and the COA approval workflow (approve); configure = COA rules and groups.'),
  cap('GL', 'gl.journal_entries', 'V C E D A P X', 'Journal entries', 'Manual journal entries: prepare, reviewer approval, post to the ledger.', { constraints: ['amount_limit', 'dimension_restriction', 'doc_types', 'period'] }),
  cap('GL', 'gl.recurring_entries', 'V C E D A P', 'Recurring entries', 'Recurring journal entries: propose, approve, post.', { constraints: ['amount_limit'] }),
  cap('GL', 'gl.periods', 'V E A K', 'Periods', 'Open / soft-close a period (edit), hard close (approve), fiscal calendar (configure).'),
  cap('GL', 'gl.period_override', 'P', 'Post into a soft-closed period', 'Privileged posting into a soft-closed period. Hard-closed periods can never be posted to.', { tags: ['locked'] }),
  cap('GL', 'gl.reporting_basis', 'V C E P', 'Reporting basis adjustments', 'Accrual / cash / tax overlay adjustments.'),
  cap('GL', 'gl.dimensions', 'V C E D K', 'Departments, classes & items', 'Dimension masters.'),
  cap('GL', 'gl.year_end', 'V P', 'Year-end close', 'Close the year to retained earnings.'),
  cap('GL', 'gl.intercompany', 'V C E A P', 'Intercompany', 'Intercompany matching and pair balances.'),
  cap('GL', 'gl.internal_invoices', 'V C E A P R', 'Internal invoices', 'Inter-department / inter-client invoices; release = issue to the counterparty.'),
  cap('GL', 'gl.posted_edit', 'E', 'Edit posted records', 'Privileged override: reverse and re-post a posted record with a typed reason.', { tags: ['locked'] }),
  // ── Close ───────────────────────────────────────────────────────────────────
  cap('Close', 'close.checklist', 'V E A K', 'Close checklist', 'Complete close tasks (edit), reviewer sign-off (approve), checklist templates (configure).'),
  cap('Close', 'close.package', 'V X R', 'Close package', 'The client close packet; release = deliver it.'),
  // ── Bank ────────────────────────────────────────────────────────────────────
  cap('Bank', 'bank.connections', 'V C D K', 'Bank connections', 'Plaid links and account mapping.', { tags: ['sensitive'], fields: ['bank'] }),
  cap('Bank', 'bank.transactions', 'V E A X', 'Bank transactions', 'Code bank transactions (edit); approve coding, which posts through the engine.', { constraints: ['amount_limit'] }),
  cap('Bank', 'bank.rules', 'V C E D', 'Bank rules', 'Deterministic coding rules.'),
  cap('Bank', 'bank.statements', 'V C', 'Bank statements', 'Statement import.'),
  cap('Bank', 'bank.reconciliations', 'V C E A X', 'Reconciliations', 'Prepare a reconciliation (edit) and reviewer sign-off (approve).'),
  cap('Bank', 'bank.transfers', 'V C A R', 'Transfers', 'Transfers between accounts and clients.', { tags: ['money'], constraints: MONEY_LIMIT }),
  // ── Cards ───────────────────────────────────────────────────────────────────
  cap('Cards', 'cards.transactions', 'V E A X', 'Card transactions', 'Card feed (incl. Ramp): code and approve.', { constraints: ['ownership'] }),
  cap('Cards', 'cards.ramp_sync', 'V K', 'Ramp sync', 'Push COA, dimensions and vendors to Ramp.'),
  cap('Cards', 'cards.cardholders', 'V E K', 'Cardholders', 'Map cards to employees (IA M-11).'),
  // ── AP ──────────────────────────────────────────────────────────────────────
  cap('AP', 'ap.bills', 'V C E D A P X', 'Bills', 'Vendor bills incl. intake queue and OCR drafts.', { constraints: ['amount_limit', 'dimension_restriction', 'doc_types'] }),
  cap('AP', 'ap.vendor_credits', 'V C A P', 'Vendor credits', 'Vendor credits.', { constraints: ['amount_limit'] }),
  cap('AP', 'ap.purchase_orders', 'V C E D A', 'Purchase orders', 'Purchase orders, goods receipts and 3-way match.', { constraints: ['amount_limit', 'dimension_restriction'] }),
  cap('AP', 'ap.policy', 'V K', 'AP policy', 'AP policy engine (natural-language rules).'),
  // ── Payments ────────────────────────────────────────────────────────────────
  cap('Payments', 'pay.batches', 'V C E A R X', 'Pay runs', 'Pay runs and check runs: build/queue, approve, release; export = positive-pay / NACHA file.', { tags: ['money'], constraints: MONEY_LIMIT }),
  cap('Payments', 'pay.checks', 'V C E P', 'Checks', 'Assign check numbers, print, remittance PDF; post = void (posts a reversal).'),
  cap('Payments', 'pay.customer_payments', 'V C E P', 'Customer payments', 'Record payments and cash application.'),
  cap('Payments', 'pay.refunds', 'V C A R', 'Refunds', 'Customer refunds.', { tags: ['money'], constraints: MONEY_LIMIT }),
  cap('Payments', 'pay.vendor_bank_details', 'V E', 'Vendor bank details', 'Bank account and routing on vendor payment profiles (most common payment-fraud vector).', { tags: ['sensitive', 'locked'], fields: ['bank'] }),
  cap('Payments', 'pay.provider_connections', 'V K', 'Payment providers', 'Stripe / ACH / bank origination setup.', { tags: ['locked'], fields: ['secrets'] }),
  // ── Expenses ────────────────────────────────────────────────────────────────
  cap('Expenses', 'exp.receipts', 'V C E D A', 'Receipts', 'Receipts; supports the ownership constraint (own / team / all).', { constraints: ['ownership', 'amount_limit', 'dimension_restriction'] }),
  cap('Expenses', 'exp.reports', 'V C E A', 'Expense reports', 'Expense reports and the approver queue.', { constraints: ['ownership', 'amount_limit', 'dimension_restriction', 'doc_types'] }),
  cap('Expenses', 'exp.reimbursements', 'V C A R', 'Reimbursements', 'Reimbursement batches.', { tags: ['money'], constraints: MONEY_LIMIT }),
  cap('Expenses', 'exp.policy', 'V K', 'Expense policy', 'Mileage, per-diem and out-of-policy rules.'),
  cap('Expenses', 'exp.chase_policy', 'V K', 'Receipt chase policy', 'Receipt policy and chase cadence (IA M-11).'),
  // ── AR ──────────────────────────────────────────────────────────────────────
  cap('AR', 'ar.invoices', 'V C E D A P R X', 'Invoices', 'Customer invoices; release = send to customer; post = post / void.', { constraints: ['amount_limit'] }),
  cap('AR', 'ar.credit_memos', 'V C A P', 'Credit memos', 'Credit memos.', { constraints: ['amount_limit'] }),
  cap('AR', 'ar.write_offs', 'V C A P', 'Write-offs', 'Bad-debt write-offs.', { constraints: ['amount_limit'] }),
  cap('AR', 'ar.estimates', 'V C E D R', 'Estimates', 'Estimates; release = send.'),
  cap('AR', 'ar.deposits', 'V C P', 'Deposits & retainers', 'Customer deposits and retainers.'),
  cap('AR', 'ar.recurring', 'V C E D', 'Recurring invoices', 'Recurring invoice templates.'),
  cap('AR', 'ar.collections', 'V E R', 'Collections', 'Worklist and promise-to-pay (edit); send dunning (release).'),
  cap('AR', 'ar.statements', 'V R', 'Customer statements', 'Customer statements; release = send.'),
  cap('AR', 'ar.payment_links', 'V K', 'Payment links', 'Stripe Pay Now per client.'),
  // ── Rev rec ─────────────────────────────────────────────────────────────────
  cap('Rev rec', 'revrec.methods', 'V E K', 'Recognition methods', 'Per-job method assignment (9 methods).'),
  cap('Rev rec', 'revrec.runs', 'V C P', 'Recognition runs', 'Recognition runs (2410 / 1180 entries).'),
  cap('Rev rec', 'revrec.schedules', 'V X', 'Recognition schedules', 'Roll-forward and waterfall.'),
  // ── Jobs ────────────────────────────────────────────────────────────────────
  cap('Jobs', 'jobs.jobs', 'V C E D', 'Jobs', 'Jobs, cost codes, job P&L.', { constraints: ['dimension_restriction'] }),
  cap('Jobs', 'jobs.change_orders', 'V C A', 'Change orders', 'Change orders.', { constraints: ['amount_limit'] }),
  cap('Jobs', 'jobs.wip', 'V E P X', 'WIP', 'WIP schedule, EAC, over/under-billing adjustments.'),
  // ── Inventory ───────────────────────────────────────────────────────────────
  cap('Inventory', 'inv.items', 'V C E D', 'Inventory items', 'Inventory items.'),
  cap('Inventory', 'inv.movements', 'V C A P', 'Inventory movements', 'Movements and movement approval.'),
  cap('Inventory', 'inv.valuation', 'V P K', 'Inventory valuation', 'FIFO / standard costing and GL tie-out.'),
  // ── Assets ──────────────────────────────────────────────────────────────────
  cap('Assets', 'fa.assets', 'V C E D P', 'Fixed assets', 'Fixed assets incl. depreciation runs (post), tax book, disposals.'),
  cap('Assets', 'fa.leases', 'V C E P', 'Leases', 'ASC 842 commence, modify, terminate.'),
  cap('Assets', 'fa.prepaids', 'V C E P', 'Prepaids', 'Prepaids, insurance amortization, intangibles.'),
  // ── Debt ────────────────────────────────────────────────────────────────────
  cap('Debt', 'debt.loans', 'V C E P', 'Loans', 'Origination, P&I, payoff, refinance.'),
  cap('Debt', 'debt.covenants', 'V E K', 'Covenants', 'Covenant monitor and compute.'),
  cap('Debt', 'debt.certificates', 'V C A R', 'Compliance certificates', 'Compliance certificates; release = send to lender.', { constraints: ['delivered_to_me'] }),
  cap('Debt', 'debt.borrowing_base', 'V C A R', 'Borrowing base', 'Borrowing base certificates.', { constraints: ['delivered_to_me'] }),
  cap('Debt', 'debt.lender_obligations', 'V C E K', 'Lender obligations', 'Lender reporting calendar and deliveries (IA M-14).'),
  // ── Cash ────────────────────────────────────────────────────────────────────
  cap('Cash', 'cash.position', 'V', 'Cash position', 'Cash position.'),
  cap('Cash', 'cash.forecast', 'V C E', 'Cash forecast', '13-week and direct forecast.'),
  cap('Cash', 'cash.obligations', 'V C E', 'Obligations', 'Renewals and subscriptions calendar.'),
  // ── Payroll ─────────────────────────────────────────────────────────────────
  cap('Payroll', 'payroll.runs', 'V C E A R', 'Payroll runs', 'Payroll runs; release = release to the provider.', { tags: ['money'], fields: ['comp'], constraints: MONEY_LIMIT }),
  cap('Payroll', 'payroll.register', 'V C P', 'Payroll register', 'Register import to journal entry.', { fields: ['comp'] }),
  cap('Payroll', 'payroll.employees', 'V C E', 'Payroll employees', 'HR record; pay rate and bank fields fall under the comp and bank field classes.', { tags: ['sensitive'], fields: ['comp', 'bank', 'tin', 'personal'] }),
  cap('Payroll', 'payroll.remittances', 'V C R', 'Payroll remittances', 'Tax and benefit remittances.', { tags: ['money'], constraints: MONEY_LIMIT }),
  cap('Payroll', 'payroll.settings', 'V K', 'Payroll settings', 'Pay schedules, register mappings, provider.'),
  // ── Tax ─────────────────────────────────────────────────────────────────────
  cap('Tax', 'tax.sales_tax', 'V E P K', 'Sales tax', 'Rates, worksheet, filing calendar, nexus.'),
  cap('Tax', 'tax.filings', 'V C A R', 'Tax filings', 'Sales-tax returns and FIRE 1099 transmission; release = file.'),
  cap('Tax', 'tax.1099', 'V C E X', '1099s', 'W-9 gaps and Copy B.', { tags: ['sensitive'], fields: ['tin'] }),
  cap('Tax', 'tax.provision', 'V C E P', 'Tax provision', 'ASC 740, book-to-tax M-1/M-3, return package.'),
  // ── FP&A ────────────────────────────────────────────────────────────────────
  cap('FP&A', 'fpa.budgets', 'V C E A X', 'Budgets', 'Budgets; approve = lock a budget version.', { constraints: ['dimension_restriction'] }),
  cap('FP&A', 'fpa.scenarios', 'V C E', 'Scenarios', 'Drivers, reforecast, what-if.'),
  cap('FP&A', 'fpa.profitability', 'V X', 'Profitability', 'Per-entity profitability.'),
  // ── Reports ─────────────────────────────────────────────────────────────────
  cap('Reports', 'reports.financial', 'V X', 'Financial reports', 'P&L, balance sheet, cash flow, trial balance, GL detail, aging.', { constraints: ['dimension_restriction'] }),
  cap('Reports', 'reports.saved_views', 'V C E D', 'Saved views', 'Saved report views.', { constraints: ['ownership'] }),
  cap('Reports', 'reports.packs', 'V C E R', 'Report packs', 'Report packs; release = scheduled delivery to others.', { constraints: ['delivered_to_me'] }),
  cap('Reports', 'reports.board_package', 'V C A R', 'Board package', 'Board package generator.', { constraints: ['delivered_to_me'] }),
  // ── Consolidation ───────────────────────────────────────────────────────────
  cap('Consolidation', 'consol.groups', 'V C E D K', 'Consolidation groups', 'Group membership, method, FX.', { tags: ['group'] }),
  cap('Consolidation', 'consol.statements', 'V X', 'Consolidated statements', 'Consolidated statements; requires view on every member.', { tags: ['group'] }),
  cap('Consolidation', 'consol.eliminations', 'V C P', 'Eliminations', 'Group-level top-side adjustments.', { tags: ['group'] }),
  // ── Controls ────────────────────────────────────────────────────────────────
  cap('Controls', 'ctl.exceptions', 'V E A', 'Exceptions', 'Exceptions: resolve (edit), accept risk (approve).'),
  cap('Controls', 'ctl.approval_workflows', 'V K', 'Approval workflows', 'Approval chains and the simulator.'),
  cap('Controls', 'ctl.compliance', 'V E A', 'Compliance', 'SOX command center.'),
  cap('Controls', 'ctl.vendor_compliance', 'V E A', 'Vendor compliance', 'W-9 / COI.'),
  cap('Controls', 'ctl.pbc', 'V C E A', 'PBC requests', 'Auditor request list.'),
  cap('Controls', 'ctl.audit_trail', 'V X', 'Audit trail', 'Audit trail.'),
  cap('Controls', 'ctl.ai_decisions', 'V X', 'AI decision log', 'AI decision log.'),
  // ── Masters ─────────────────────────────────────────────────────────────────
  cap('Masters', 'mdm.vendors', 'V C E D', 'Vendors', 'Vendor master incl. merge/dedupe (edit). Bank details are NOT included.'),
  cap('Masters', 'mdm.customers', 'V C E D', 'Customers', 'Customer master, merge, risk dossier.'),
  cap('Masters', 'mdm.items', 'V C E D', 'Items', 'Product / service items.'),
  // ── Requests & portals ──────────────────────────────────────────────────────
  cap('Requests & portals', 'docs.documents', 'V C D X', 'Documents', 'Document center.', { constraints: ['ownership'] }),
  cap('Requests & portals', 'req.client_requests', 'V C E R', 'Client requests', 'Draft and answer requests; release = send / remind (external).', { constraints: ['assigned_to_me'] }),
  cap('Requests & portals', 'portal.customer', 'V K R', 'Customer portal', 'Customer portal; release = issue a magic link.'),
  cap('Requests & portals', 'portal.vendor', 'V K R', 'Vendor portal', 'Vendor portal; release = issue a magic link.'),
  cap('Requests & portals', 'portal.client', 'V K', 'Client portal', 'Firm-client portal (planned).'),
  // ── Onboarding ──────────────────────────────────────────────────────────────
  cap('Onboarding', 'onb.clients', 'V C E D', 'Clients', 'Add / archive clients (delete = archive).'),
  cap('Onboarding', 'onb.wizard', 'V E', 'Onboarding wizard', 'Run the onboarding wizard (replaces admin_scope PREPARER).'),
  cap('Onboarding', 'onb.imports', 'V C P', 'Data imports', 'TB / AR / AP / WIP / equity imports; post = post opening balances.'),
  cap('Onboarding', 'onb.conversion', 'V A P', 'Conversion', 'Conversion; approve = pass the tie-out gate.'),
  // ── Integrations ────────────────────────────────────────────────────────────
  cap('Integrations', 'int.connections', 'V C D K', 'Connections', 'QBO / Xero / Sage / ERP / Ramp connectors.', { tags: ['locked'], fields: ['secrets'] }),
  cap('Integrations', 'int.api_keys', 'V C D', 'API keys', 'API keys.', { tags: ['locked'], fields: ['secrets'] }),
  cap('Integrations', 'int.sync_runs', 'V E', 'Sync runs', 'Retry and resolve sync errors.'),
  cap('Integrations', 'int.mappings', 'V E', 'Connector mappings', 'Connector mapping queue (07).'),
  // ── AI ──────────────────────────────────────────────────────────────────────
  cap('AI', 'ai.assist', 'V', 'AI assist', 'Command bar / NL query / JE composer drafts (saving still needs the underlying capability).'),
  cap('AI', 'ai.agents', 'V C K', 'Agents', 'Run an agent recipe (create); recipe settings (configure).'),
  cap('AI', 'ai.autonomy', 'V K', 'AI autonomy', 'Autonomy dial and kill switch.', { tags: ['locked'] }),
  // ── Workspace ───────────────────────────────────────────────────────────────
  cap('Workspace', 'home.workspace', 'V', 'Workspace home', 'Tenant workspace surfaces.'),
  cap('Workspace', 'home.client', 'V', 'Client home', 'Client home.'),
  cap('Workspace', 'home.platform', 'V', 'Platform home', 'Platform console home.', { module: 'platform' }),
  cap('Workspace', 'home.portal', 'V', 'Portal home', 'Portal home for external audiences.'),
  cap('Workspace', 'ws.client_health', 'V', 'Client health', 'Operations / client health, capacity.'),
  cap('Workspace', 'ws.assignments', 'V C E D', 'Capacity assignments', 'Preparer / reviewer / approver capacity assignments (IA M-5).'),
  cap('Workspace', 'alerts.watch_rules', 'V C E D', 'Watch rules', 'Alert watch rules (IA M-13).'),
  // ── Access (core) ───────────────────────────────────────────────────────────
  cap('Access', 'core.access.members', 'V C E D', 'Members', 'Invite, deactivate, edit profile.'),
  cap('Access', 'core.access.roles', 'V C E D K', 'Roles & permission sets', 'Author roles and permission sets; configure = publish.', { tags: ['locked'] }),
  cap('Access', 'core.access.assignments', 'V C E D', 'Access assignments', 'Grant and revoke access (delegation ceiling).', { tags: ['locked'] }),
  cap('Access', 'core.access.reviews', 'V C A X', 'Access reviews', 'Run and attest access reviews.'),
  cap('Access', 'core.access.simulate', 'V', 'View as', 'Read-only view-as simulation.'),
  cap('Access', 'core.access.sod_policy', 'V K', 'Conflict rules', 'Tighten SoD, approve exceptions.', { tags: ['locked'] }),
  // ── Tenant (core) ───────────────────────────────────────────────────────────
  cap('Settings', 'core.tenant.settings', 'V K', 'Tenant settings', 'System, security (MFA / IP / session), branding.', { tags: ['locked'] }),
  cap('Settings', 'core.tenant.accounting_settings', 'V K', 'Accounting settings', 'GL rules and close gates.'),
  cap('Settings', 'core.tenant.billing', 'V K', 'Billing', 'Plan and payment method; configure limited to the billing owner.'),
  cap('Settings', 'core.tenant.dashboard_layouts', 'V K', 'Dashboard layouts', 'Publish role layouts (IA M-8).'),
  cap('Settings', 'core.tenant.support_access', 'V A', 'Support access', 'Approve platform support grants (IA M-9).'),
  cap('Settings', 'core.tenant.export', 'X', 'Full tenant export', 'Full tenant export.', { tags: ['locked'] }),
  cap('Settings', 'core.tenant.reset', 'D', 'Tenant reset', 'Sandbox / tenant reset (two-person rule).', { tags: ['locked'] }),
  // ── Platform ────────────────────────────────────────────────────────────────
  cap('Platform', 'platform.tenants', 'V C E', 'Tenants', 'Provision, suspend, lifecycle.'),
  cap('Platform', 'platform.entitlements', 'V K', 'Entitlements', 'Module entitlements.'),
  cap('Platform', 'platform.templates', 'V C E K', 'Templates', 'Role, permission-set and envelope templates, SoD rules, dashboard defaults.'),
  cap('Platform', 'platform.support', 'V C', 'Support', 'Request support access, run sessions.'),
  cap('Platform', 'platform.billing', 'V K', 'Platform billing', 'Platform billing.'),
  cap('Platform', 'platform.health', 'V', 'Platform health', 'Ops, AI gateway, integrations.'),
  cap('Platform', 'platform.break_glass', 'C', 'Break-glass', 'Incident access (IA Q6).', { tags: ['locked'] }),
];

export const CAPABILITY_BY_KEY: ReadonlyMap<string, CapabilityDef> = new Map(
  CAPABILITIES.map((c) => [c.key, c]),
);

/** Resource-level risk tier, derived from tags (mirrored to core.capabilities.risk_tier). */
export function riskTier(c: Pick<CapabilityDef, 'tags'>): RiskTier {
  if (c.tags.includes('locked')) return 'critical';
  if (c.tags.includes('money')) return 'high';
  if (c.tags.includes('sensitive')) return 'elevated';
  return 'standard';
}

/** Platform-only capabilities (H5): never grantable in tenant or client roles. */
export function isPlatformOnly(c: Pick<CapabilityDef, 'module'>): boolean {
  return c.module === 'platform';
}

export function isCapabilityKey(key: string): boolean {
  return CAPABILITY_BY_KEY.has(key);
}

export function capabilitySupports(key: string, action: string): action is Action {
  const c = CAPABILITY_BY_KEY.get(key);
  return !!c && (c.actions as readonly string[]).includes(action);
}

/** `ap.bills:approve` → { key, action }, or null when malformed / not in the registry. */
export function parseCapabilityRef(ref: string): { key: string; action: Action } | null {
  const i = ref.lastIndexOf(':');
  if (i <= 0) return null;
  const key = ref.slice(0, i);
  const action = ref.slice(i + 1);
  return capabilitySupports(key, action) ? { key, action } : null;
}

/**
 * The ~20 module keys IA 04 G22 found missing from permissions.ts' FEATURE_CATALOG,
 * each mapped to the capability prefix that now covers it. A guard test asserts every
 * one resolves to at least one registered capability.
 */
export const G22_MODULE_COVERAGE: Readonly<Record<string, string>> = {
  rev_rec: 'revrec.',
  jobs_wip: 'jobs.wip',
  budgets: 'fpa.budgets',
  fpna: 'fpa.',
  debt: 'debt.loans',
  covenants: 'debt.covenants',
  borrowing_base: 'debt.borrowing_base',
  tax: 'tax.',
  consolidation: 'consol.',
  expenses: 'exp.',
  purchase_orders: 'ap.purchase_orders',
  inventory: 'inv.',
  assets: 'fa.',
  obligations: 'cash.obligations',
  documents: 'docs.documents',
  exceptions: 'ctl.exceptions',
  agents: 'ai.agents',
  internal_invoices: 'gl.internal_invoices',
  vendor_compliance: 'ctl.vendor_compliance',
  client_requests: 'req.client_requests',
  alerts: 'alerts.watch_rules',
};

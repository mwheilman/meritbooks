/**
 * PLATFORM TEMPLATES — the standard role templates (05-RBAC-SPEC §7.1–7.3 + IA-SPEC §2.2
 * amendment A-1: `employee`, `lender_viewer`) and the platform permission sets (05 R-3).
 *
 * 05 §7 states grants per DOMAIN with codes (V view · X export · P prepare = create+edit+
 * delete · A approve · O post · R release · K configure). `domainGrants()` expands a code
 * over the domain's resources, intersected with the actions each resource supports; a few
 * rows are then refined per resource where §7 is more specific (footnotes, "soft close",
 * "+ send", "register P"). Every non-view code implies view (05 §2.1).
 *
 * Mirrored to the DB by migrations 158 (role templates) and 159 (permission sets) via the
 * generated blocks — the guard test compares them.
 *
 * PURE: no I/O.
 */

import {
  ACTIONS,
  CAPABILITIES,
  CAPABILITY_BY_KEY,
  type Action,
  type CapabilityDef,
} from '@/lib/rbac/capabilities';
import {
  LEGACY_ROLE_TO_TEMPLATE,
  expandLegacyCells,
  legacyRoleCells,
  subtractGrants,
  moneyReleaseGrants,
  type GrantMap,
} from '@/lib/rbac/legacy-map';

// ── Constraint schema (05 §3) ─────────────────────────────────────────────────────

export interface AmountLimit {
  max_per_item_cents: number;
  max_per_day_cents?: number;
  /** Actions the limit applies to (default approve / post / release). */
  applies_to?: Action[];
}
export interface DimensionRestriction {
  dimension: 'department' | 'class' | 'job';
  values: string[] | 'my_departments';
  mode: 'view_and_edit' | 'edit_only';
  include_unassigned?: boolean;
}
export interface GrantConstraints {
  amount_limit?: AmountLimit;
  dimension_restriction?: DimensionRestriction;
  doc_types?: { allowed: string[] };
  ownership?: 'own' | 'team' | 'all';
  period?: 'open_only' | 'allow_soft_closed';
  delivered_to_me?: boolean;
  assigned_to_me?: boolean;
}
export const CONSTRAINT_KEYS = [
  'amount_limit',
  'dimension_restriction',
  'doc_types',
  'ownership',
  'period',
  'delivered_to_me',
  'assigned_to_me',
] as const;

export interface TemplateGrant {
  capability: string;
  actions: Action[];
  constraints: GrantConstraints;
}

export type Audience = 'internal_staff' | 'client_staff' | 'external' | 'platform';
export type DefaultScope = 'all_clients' | 'assigned';
export type AssignableBand = 'tenant_admin_only' | 'managers' | 'any_grantor';

export interface FieldPolicy {
  comp: 'hidden' | 'grouped' | 'visible';
  tin: 'hidden' | 'masked' | 'reveal_logged' | 'visible';
  bank: 'hidden' | 'masked' | 'reveal_logged' | 'visible';
  personal: 'hidden' | 'visible';
}
export interface AuthPolicy {
  mfa_required: boolean;
  step_up_minutes?: number;
  session_max_hours?: number;
  idle_timeout_minutes?: number;
}

export interface RoleTemplate {
  key: string;
  name: string;
  description: string;
  audience: Audience;
  defaultScope: DefaultScope;
  fieldPolicy: FieldPolicy;
  authPolicy: AuthPolicy;
  maxAssignmentDays: number | null;
  assignableBand: AssignableBand;
  /** Cloned into every tenant as a standard tenant role (platform roles are not). */
  cloneToTenants: boolean;
  grants: TemplateGrant[];
}

export interface PermissionSetTemplate {
  key: string;
  name: string;
  description: string;
  audience: Audience;
  isEnvelope: boolean;
  isSealed: boolean;
  fieldPolicy: Partial<FieldPolicy>;
  maxAssignmentDays: number | null;
  grants: TemplateGrant[];
}

// ── Domains (05 §6.2 left rail; §7 table columns) ─────────────────────────────────

export const DOMAINS: Readonly<Record<string, readonly string[]>> = {
  GL: ['gl.accounts', 'gl.journal_entries', 'gl.recurring_entries', 'gl.reporting_basis', 'gl.dimensions', 'gl.intercompany', 'gl.internal_invoices', 'gl.year_end'],
  CLOSE: ['close.checklist', 'close.package', 'gl.periods'],
  BANK: ['bank.transactions', 'bank.rules', 'bank.statements', 'bank.reconciliations', 'bank.connections'],
  CARDS: ['cards.transactions', 'cards.ramp_sync', 'cards.cardholders'],
  AP: ['ap.bills', 'ap.purchase_orders', 'ap.vendor_credits', 'ap.policy'],
  PAY: ['pay.batches', 'pay.checks', 'pay.customer_payments', 'pay.refunds', 'bank.transfers'],
  EXP: ['exp.receipts', 'exp.reports', 'exp.reimbursements', 'exp.policy', 'exp.chase_policy'],
  AR: ['ar.invoices', 'ar.credit_memos', 'ar.write_offs', 'ar.estimates', 'ar.deposits', 'ar.recurring', 'ar.collections', 'ar.statements', 'ar.payment_links'],
  REVREC: ['revrec.methods', 'revrec.runs', 'revrec.schedules'],
  JOBS: ['jobs.jobs', 'jobs.change_orders', 'jobs.wip'],
  INV: ['inv.items', 'inv.movements', 'inv.valuation'],
  FA: ['fa.assets', 'fa.leases', 'fa.prepaids'],
  DEBT: ['debt.loans', 'debt.covenants', 'debt.certificates', 'debt.borrowing_base', 'debt.lender_obligations'],
  CASH: ['cash.position', 'cash.forecast', 'cash.obligations'],
  PAYROLL: ['payroll.runs', 'payroll.register', 'payroll.employees', 'payroll.remittances', 'payroll.settings'],
  TAX: ['tax.sales_tax', 'tax.filings', 'tax.1099', 'tax.provision'],
  FPA: ['fpa.budgets', 'fpa.scenarios', 'fpa.profitability'],
  REPORTS: ['reports.financial', 'reports.saved_views', 'reports.packs', 'reports.board_package'],
  CONSOL: ['consol.groups', 'consol.statements', 'consol.eliminations'],
  CONTROLS: ['ctl.exceptions', 'ctl.compliance', 'ctl.vendor_compliance', 'ctl.pbc', 'ctl.audit_trail', 'ctl.ai_decisions', 'ctl.approval_workflows'],
  MASTERS: ['mdm.vendors', 'mdm.customers', 'mdm.items'],
  BANKDETAILS: ['pay.vendor_bank_details'],
  REQUESTS: ['req.client_requests', 'docs.documents', 'portal.customer', 'portal.vendor', 'portal.client'],
  ONB: ['onb.clients', 'onb.wizard', 'onb.imports', 'onb.conversion'],
  INT: ['int.connections', 'int.api_keys', 'int.sync_runs', 'int.mappings'],
  AI: ['ai.assist', 'ai.agents', 'ai.autonomy'],
  ACCESS: ['core.access.members', 'core.access.roles', 'core.access.assignments', 'core.access.reviews', 'core.access.simulate', 'core.access.sod_policy'],
  TENANT: ['core.tenant.settings', 'core.tenant.accounting_settings', 'core.tenant.billing', 'core.tenant.dashboard_layouts', 'core.tenant.support_access', 'core.tenant.export'],
  WORKSPACE: ['home.workspace', 'home.client', 'ws.client_health', 'ws.assignments', 'alerts.watch_rules'],
};

const PROCESSING = ['GL', 'CLOSE', 'BANK', 'CARDS', 'AP', 'PAY', 'EXP', 'AR', 'REVREC', 'JOBS', 'INV', 'FA'] as const;

const CODE_ACTIONS: Record<string, Action[]> = {
  V: ['view'],
  X: ['view', 'export'],
  P: ['view', 'create', 'edit', 'delete'],
  A: ['view', 'approve'],
  O: ['view', 'post'],
  R: ['view', 'release'],
  K: ['view', 'configure'],
};

function codeActions(code: string): Set<Action> {
  const s = new Set<Action>();
  for (const ch of code) {
    const acts = CODE_ACTIONS[ch];
    if (!acts) throw new Error(`unknown template code '${ch}'`);
    acts.forEach((a) => s.add(a));
  }
  return s;
}

function capDef(key: string): CapabilityDef {
  const d = CAPABILITY_BY_KEY.get(key);
  if (!d) throw new Error(`template references unknown capability ${key}`);
  return d;
}

/** Builder that accumulates grants; later calls union actions and merge constraints. */
class GrantBuilder {
  private readonly map = new Map<string, { actions: Set<Action>; constraints: GrantConstraints }>();

  /** Grant `code` on one resource (intersected with the resource's actions). */
  res(key: string, code: string, constraints: GrantConstraints = {}): this {
    const def = capDef(key);
    const want = codeActions(code);
    const acts = def.actions.filter((a) => want.has(a));
    if (acts.length === 0) return this;
    const cur = this.map.get(key) ?? { actions: new Set<Action>(), constraints: {} };
    acts.forEach((a) => cur.actions.add(a));
    cur.constraints = { ...cur.constraints, ...constraints };
    this.map.set(key, cur);
    return this;
  }

  /** Grant `code` on every resource of a domain. */
  dom(domain: string, code: string, constraints: GrantConstraints = {}): this {
    const keys = DOMAINS[domain];
    if (!keys) throw new Error(`unknown domain ${domain}`);
    keys.forEach((k) => this.res(k, code, constraints));
    return this;
  }

  /** Remove actions from one resource. */
  without(key: string, actions: Action[]): this {
    const cur = this.map.get(key);
    if (!cur) return this;
    actions.forEach((a) => cur.actions.delete(a));
    if (cur.actions.size === 0) this.map.delete(key);
    return this;
  }

  /** Attach constraints to an existing grant. */
  constrain(key: string, constraints: GrantConstraints): this {
    const cur = this.map.get(key);
    if (cur) cur.constraints = { ...cur.constraints, ...constraints };
    return this;
  }

  build(): TemplateGrant[] {
    return [...this.map.entries()]
      .map(([capability, v]) => ({
        capability,
        actions: ACTIONS.filter((a) => v.actions.has(a)),
        constraints: v.constraints,
      }))
      .sort((a, b) => a.capability.localeCompare(b.capability));
  }
}

const g = () => new GrantBuilder();
const usd = (dollars: number) => dollars * 100;
const limit = (dollars: number, applies_to?: Action[]): GrantConstraints => ({
  amount_limit: { max_per_item_cents: usd(dollars), ...(applies_to ? { applies_to } : {}) },
});

/** Resources that take an approve dollar limit in the templates (money approvals). */
const APPROVAL_LIMITED = [
  'ap.bills', 'ap.purchase_orders', 'ap.vendor_credits', 'pay.batches', 'pay.refunds',
  'exp.reports', 'exp.reimbursements', 'payroll.runs', 'ar.credit_memos', 'ar.write_offs',
  'bank.transfers', 'jobs.change_orders',
];
function withApprovalLimit(b: GrantBuilder, dollars: number): GrantBuilder {
  APPROVAL_LIMITED.forEach((k) => b.constrain(k, limit(dollars)));
  return b;
}

const FP = (comp: FieldPolicy['comp'], tin: FieldPolicy['tin'], bank: FieldPolicy['bank'], personal: FieldPolicy['personal'] = 'hidden'): FieldPolicy => ({ comp, tin, bank, personal });
const MFA: AuthPolicy = { mfa_required: true, step_up_minutes: 10 };
const MFA_MONEY: AuthPolicy = { mfa_required: true, step_up_minutes: 10, session_max_hours: 12, idle_timeout_minutes: 60 };
const NO_MFA: AuthPolicy = { mfa_required: false };

function home(b: GrantBuilder): GrantBuilder {
  return b.res('home.workspace', 'V').res('home.client', 'V').res('ai.assist', 'V');
}

// ── Templates ─────────────────────────────────────────────────────────────────────

function tenantAdmin(): TemplateGrant[] {
  const b = g();
  PROCESSING.forEach((d) => b.dom(d, 'V'));
  b.dom('DEBT', 'V').dom('CASH', 'V').dom('PAYROLL', 'V').dom('TAX', 'V').dom('FPA', 'V')
    .dom('REPORTS', 'X').dom('CONSOL', 'V').dom('CONTROLS', 'V').res('ctl.approval_workflows', 'K')
    .dom('MASTERS', 'V').dom('BANKDETAILS', 'V')
    .res('portal.customer', 'K').res('portal.vendor', 'K').res('portal.client', 'K')
    .res('req.client_requests', 'V').res('docs.documents', 'V')
    .res('onb.clients', 'P').res('onb.wizard', 'V').res('onb.imports', 'V').res('onb.conversion', 'V')
    .dom('INT', 'K').res('int.connections', 'P').res('int.api_keys', 'P')
    .dom('AI', 'K')
    .res('core.access.members', 'P').res('core.access.roles', 'PK').res('core.access.assignments', 'P')
    .res('core.access.reviews', 'XA').res('core.access.reviews', 'P').res('core.access.simulate', 'V').res('core.access.sod_policy', 'K')
    .dom('TENANT', 'K').res('core.tenant.support_access', 'A').res('core.tenant.export', 'X')
    .dom('WORKSPACE', 'V').res('ws.assignments', 'P').res('alerts.watch_rules', 'P');
  return home(b).build();
}

function owner(): TemplateGrant[] {
  const b = g();
  b.dom('GL', 'X').dom('CLOSE', 'V').dom('BANK', 'V').dom('CARDS', 'V').dom('AP', 'A')
    .res('pay.batches', 'AR').res('pay.refunds', 'AR').res('pay.checks', 'V').res('pay.customer_payments', 'V')
    .dom('EXP', 'A').dom('AR', 'X').dom('REVREC', 'V').dom('JOBS', 'V').dom('INV', 'V').dom('FA', 'V')
    .dom('DEBT', 'A').res('debt.certificates', 'R')
    .dom('CASH', 'V').res('payroll.runs', 'AR').res('payroll.register', 'V').res('payroll.employees', 'V')
    .dom('TAX', 'A').dom('FPA', 'A').dom('REPORTS', 'X').res('reports.packs', 'R')
    .dom('CONTROLS', 'V').dom('MASTERS', 'V').dom('BANKDETAILS', 'V')
    .res('req.client_requests', 'VR').res('req.client_requests', 'P').res('docs.documents', 'V')
    .dom('ONB', 'V').dom('INT', 'V').res('ai.assist', 'V').res('ai.agents', 'V').res('ai.autonomy', 'V')
    .dom('ACCESS', 'V').res('core.tenant.settings', 'V').res('core.tenant.accounting_settings', 'V').res('core.tenant.billing', 'V')
    .dom('WORKSPACE', 'V');
  return home(b).build();
}

function cfo(): TemplateGrant[] {
  const b = g();
  b.dom('GL', 'XA').dom('CLOSE', 'A').dom('BANK', 'A').dom('CARDS', 'A').dom('AP', 'A')
    .dom('PAY', 'AR').dom('EXP', 'A').dom('AR', 'XA').dom('REVREC', 'X').dom('JOBS', 'X').dom('INV', 'V').dom('FA', 'X')
    .dom('DEBT', 'PARK').dom('CASH', 'PK').res('payroll.runs', 'AR').res('payroll.register', 'V').res('payroll.employees', 'V').res('payroll.remittances', 'R')
    .dom('TAX', 'AR').dom('FPA', 'PAK').dom('REPORTS', 'X').res('reports.packs', 'R').res('reports.board_package', 'R')
    .dom('CONSOL', 'X').dom('CONTROLS', 'AK').dom('MASTERS', 'V').dom('BANKDETAILS', 'V')
    .dom('REQUESTS', 'V').dom('ONB', 'V').dom('INT', 'V').res('ai.assist', 'V').res('ai.agents', 'V').res('ai.autonomy', 'K')
    .dom('ACCESS', 'V').res('core.tenant.accounting_settings', 'K').res('core.tenant.settings', 'V')
    .dom('WORKSPACE', 'V');
  return home(b).build();
}

function controller(): TemplateGrant[] {
  const b = g();
  b.dom('GL', 'PAOK').dom('CLOSE', 'PAK').dom('BANK', 'PA').dom('CARDS', 'PA').dom('AP', 'PAO')
    .dom('PAY', 'PA').dom('EXP', 'PA').dom('AR', 'PAO').dom('REVREC', 'POK').dom('JOBS', 'PO').dom('INV', 'PAO').dom('FA', 'PO')
    .dom('DEBT', 'PO').dom('CASH', 'P').res('payroll.runs', 'A').res('payroll.register', 'V').res('payroll.employees', 'V').res('payroll.remittances', 'V')
    .dom('TAX', 'PO').dom('FPA', 'P').dom('REPORTS', 'X').res('reports.packs', 'R')
    .dom('CONSOL', 'POK').dom('CONTROLS', 'PAK').dom('MASTERS', 'P').res('pay.vendor_bank_details', 'P')
    .dom('REQUESTS', 'P').res('req.client_requests', 'R').res('portal.customer', 'R').res('portal.vendor', 'R')
    .dom('ONB', 'PO').res('onb.conversion', 'A').dom('INT', 'V').res('ai.assist', 'V').res('ai.agents', 'V').res('ai.autonomy', 'K')
    .dom('ACCESS', 'V').res('core.tenant.accounting_settings', 'K').dom('WORKSPACE', 'V');
  return withApprovalLimit(home(b), 250_000).build();
}

function financeDirector(): TemplateGrant[] {
  const b = g();
  b.dom('GL', 'A').dom('CLOSE', 'V').dom('BANK', 'V').dom('CARDS', 'V').dom('AP', 'A')
    .dom('PAY', 'AR').dom('EXP', 'A').dom('AR', 'A').dom('REVREC', 'V').dom('JOBS', 'V').dom('INV', 'V').dom('FA', 'V')
    .dom('DEBT', 'A').dom('CASH', 'P').res('payroll.runs', 'A').res('payroll.register', 'V').res('payroll.employees', 'V')
    .dom('TAX', 'V').dom('FPA', 'PA').dom('REPORTS', 'X').dom('CONSOL', 'V').dom('CONTROLS', 'A')
    .dom('MASTERS', 'V').dom('BANKDETAILS', 'V').dom('REQUESTS', 'V').dom('ONB', 'V').res('ai.assist', 'V').res('ai.agents', 'V')
    .dom('ACCESS', 'V').dom('WORKSPACE', 'V');
  withApprovalLimit(b, 100_000);
  b.constrain('pay.batches', limit(100_000)).constrain('pay.refunds', limit(100_000));
  return home(b).build();
}

function accountingManager(): TemplateGrant[] {
  const b = g();
  b.dom('GL', 'PAO').res('close.checklist', 'PA').res('close.package', 'V').res('gl.periods', 'V').res('gl.periods', 'P')
    .dom('BANK', 'PA').dom('CARDS', 'PA').dom('AP', 'PAO').dom('PAY', 'PA').dom('EXP', 'PA').dom('AR', 'PAO')
    .dom('REVREC', 'PO').dom('JOBS', 'PO').dom('INV', 'PA').dom('FA', 'PO')
    .dom('DEBT', 'P').dom('CASH', 'P').res('payroll.runs', 'PA').res('payroll.register', 'P').res('payroll.employees', 'P').res('payroll.remittances', 'P')
    .dom('TAX', 'P').dom('FPA', 'V').dom('REPORTS', 'X').res('reports.packs', 'R')
    .dom('CONTROLS', 'PA').dom('MASTERS', 'P').dom('BANKDETAILS', 'V')
    .dom('REQUESTS', 'P').res('req.client_requests', 'R').res('portal.customer', 'R').res('portal.vendor', 'R')
    .dom('ONB', 'PO').dom('INT', 'V').res('bank.connections', 'P').res('ai.assist', 'V').res('ai.agents', 'V')
    .res('core.access.members', 'V').res('core.access.members', 'P').without('core.access.members', ['delete'])
    .res('core.access.assignments', 'P').res('core.access.roles', 'V').res('core.access.simulate', 'V')
    .dom('TENANT', 'V').without('core.tenant.export', ['export'])
    .dom('WORKSPACE', 'V').res('ws.assignments', 'P');
  b.constrain('gl.journal_entries', {}); // JE post: any amount (05 §7.1)
  withApprovalLimit(b, 25_000);
  return home(b).build();
}

function bookkeeper(): TemplateGrant[] {
  const b = g();
  b.dom('GL', 'P').res('close.checklist', 'V').res('close.checklist', 'P').res('gl.periods', 'V').res('close.package', 'V')
    .dom('BANK', 'P').res('bank.transactions', 'A').without('bank.connections', ['create', 'delete'])
    .dom('CARDS', 'P').res('cards.transactions', 'A')
    .dom('AP', 'P').dom('PAY', 'V').dom('EXP', 'P').dom('AR', 'P')
    .res('ar.invoices', 'R').res('ar.estimates', 'R').res('ar.statements', 'R').res('ar.collections', 'R')
    .dom('REVREC', 'V').dom('JOBS', 'P').dom('INV', 'P').dom('FA', 'V')
    .dom('DEBT', 'V').dom('CASH', 'V').res('payroll.register', 'P')
    .res('tax.sales_tax', 'P').res('tax.1099', 'P').res('tax.filings', 'V').res('tax.provision', 'V')
    .dom('REPORTS', 'X').dom('CONTROLS', 'V').res('ctl.exceptions', 'P')
    .dom('MASTERS', 'P').dom('REQUESTS', 'P').res('req.client_requests', 'R')
    .dom('ONB', 'P').dom('INT', 'V').res('ai.assist', 'V').res('ai.agents', 'V')
    .dom('WORKSPACE', 'V');
  return home(b).build();
}

function apClerk(): TemplateGrant[] {
  return home(
    g().dom('CARDS', 'V').dom('AP', 'P').res('pay.batches', 'P').res('pay.checks', 'P').dom('EXP', 'P')
      .res('tax.1099', 'V').res('reports.financial', 'V').dom('CONTROLS', 'V').res('mdm.vendors', 'P')
      .res('req.client_requests', 'P').res('docs.documents', 'P').res('jobs.jobs', 'V'),
  ).build();
}

function arClerk(): TemplateGrant[] {
  return home(
    g().res('bank.transactions', 'V').res('pay.customer_payments', 'PO').dom('AR', 'P')
      .res('ar.invoices', 'R').res('ar.estimates', 'R').res('ar.statements', 'R').res('ar.collections', 'R')
      .dom('REVREC', 'V').dom('JOBS', 'V').res('reports.financial', 'V').dom('CONTROLS', 'V')
      .res('mdm.customers', 'P').res('req.client_requests', 'PR').res('docs.documents', 'P').res('portal.customer', 'R'),
  ).build();
}

function paymentsClerk(): TemplateGrant[] {
  return home(
    g().res('ap.bills', 'V').res('pay.batches', 'PX').res('pay.checks', 'P').res('reports.financial', 'V').dom('MASTERS', 'V'),
  ).build();
}

function dataEntry(): TemplateGrant[] {
  return home(
    g().res('ap.bills', 'V').res('ap.bills', 'P').without('ap.bills', ['edit', 'delete']).dom('EXP', 'P').dom('JOBS', 'V')
      .res('inv.items', 'P').dom('MASTERS', 'P').res('req.client_requests', 'P').res('docs.documents', 'P'),
  ).build();
}

function hrPayroll(): TemplateGrant[] {
  return home(
    g().dom('EXP', 'V').dom('CASH', 'V')
      .res('payroll.runs', 'P').res('payroll.register', 'PO').res('payroll.employees', 'P').res('payroll.remittances', 'PR').res('payroll.settings', 'K')
      .res('tax.filings', 'V').dom('FPA', 'V').res('reports.financial', 'V').dom('CONTROLS', 'V').dom('INT', 'V').res('ai.agents', 'V'),
  ).build();
}

const MY_DEPTS: GrantConstraints = {
  dimension_restriction: { dimension: 'department', values: 'my_departments', mode: 'edit_only', include_unassigned: false },
};

function departmentHead(): TemplateGrant[] {
  const b = g()
    .res('ap.bills', 'A').res('ap.purchase_orders', 'PA').res('exp.receipts', 'A').res('exp.reports', 'A')
    .dom('JOBS', 'V').res('payroll.register', 'V').res('fpa.budgets', 'P').res('reports.financial', 'V')
    .dom('MASTERS', 'V').res('req.client_requests', 'V').res('req.client_requests', 'P').without('req.client_requests', ['create', 'delete']);
  for (const k of ['ap.bills', 'ap.purchase_orders', 'exp.receipts', 'exp.reports']) {
    b.constrain(k, { ...MY_DEPTS, ...limit(5_000) });
  }
  b.constrain('fpa.budgets', MY_DEPTS).constrain('reports.financial', { dimension_restriction: { dimension: 'department', values: 'my_departments', mode: 'view_and_edit' } });
  return b.res('home.client', 'V').res('ai.assist', 'V').build();
}

function externalAuditor(): TemplateGrant[] {
  const b = g();
  PROCESSING.forEach((d) => b.dom(d, 'X'));
  b.dom('DEBT', 'X').dom('CASH', 'X').dom('PAYROLL', 'X').dom('TAX', 'X').dom('FPA', 'X').dom('REPORTS', 'X').dom('CONSOL', 'X')
    .dom('CONTROLS', 'X').res('ctl.pbc', 'P').res('ctl.pbc', 'A').without('ctl.pbc', ['delete'])
    .dom('MASTERS', 'X').res('ctl.ai_decisions', 'V').res('home.client', 'V');
  // Bank details stay masked through the field policy; pay.vendor_bank_details is a
  // locked [L] resource, which H3 forbids for any external audience.
  // H4: read + export + PBC only. Strip anything else the domain codes produced.
  return b.build().map((gr) => ({
    ...gr,
    actions: gr.capability === 'ctl.pbc'
      ? gr.actions.filter((a) => ['view', 'export', 'create', 'edit', 'approve'].includes(a))
      : gr.actions.filter((a) => a === 'view' || a === 'export'),
  })).filter((gr) => gr.actions.length > 0);
}

function viewOnly(): TemplateGrant[] {
  const b = g();
  PROCESSING.forEach((d) => b.dom(d, 'V'));
  b.dom('DEBT', 'V').dom('CASH', 'V').dom('TAX', 'V').dom('FPA', 'V').dom('REPORTS', 'V').dom('CONTROLS', 'V').dom('MASTERS', 'V');
  return b.res('home.client', 'V').res('home.workspace', 'V').build();
}

function clientAdmin(): TemplateGrant[] {
  return g()
    .res('bank.transactions', 'V').res('cards.transactions', 'V').dom('AP', 'PA').without('ap.policy', ['configure'])
    .dom('EXP', 'PA').res('exp.policy', 'V').res('exp.chase_policy', 'V')
    .res('ar.invoices', 'P').res('ar.invoices', 'R').res('ar.estimates', 'P').res('ar.estimates', 'R')
    .dom('JOBS', 'V').res('debt.loans', 'V').res('debt.covenants', 'V').dom('CASH', 'V').dom('FPA', 'V').dom('REPORTS', 'X')
    .res('mdm.vendors', 'P').res('mdm.customers', 'P').res('req.client_requests', 'P').res('docs.documents', 'P')
    .res('core.access.members', 'P').res('core.access.assignments', 'P').res('core.access.roles', 'PK')
    .res('home.client', 'V').res('ai.assist', 'V')
    .build();
}

function clientContact(): TemplateGrant[] {
  return g()
    .res('req.client_requests', 'V').res('req.client_requests', 'P').without('req.client_requests', ['create', 'delete'])
    .constrain('req.client_requests', { assigned_to_me: true })
    .res('docs.documents', 'V').res('docs.documents', 'P').without('docs.documents', ['delete'])
    .constrain('docs.documents', { ownership: 'own' })
    .res('home.portal', 'V')
    .build();
}

function employee(): TemplateGrant[] {
  return g()
    .res('exp.receipts', 'P').constrain('exp.receipts', { ownership: 'own' })
    .res('exp.reports', 'P').constrain('exp.reports', { ownership: 'own' })
    .res('cards.transactions', 'V').constrain('cards.transactions', { ownership: 'own' })
    .res('req.client_requests', 'V').res('req.client_requests', 'P').without('req.client_requests', ['create', 'delete'])
    .constrain('req.client_requests', { assigned_to_me: true })
    .res('docs.documents', 'V').res('docs.documents', 'P').without('docs.documents', ['delete', 'edit'])
    .constrain('docs.documents', { ownership: 'own' })
    .res('home.client', 'V')
    .build();
}

function lenderViewer(): TemplateGrant[] {
  const d: GrantConstraints = { delivered_to_me: true };
  return g()
    .res('reports.packs', 'X', d).res('debt.certificates', 'X', d).res('debt.borrowing_base', 'X', d).res('reports.board_package', 'X', d)
    .res('req.client_requests', 'V').res('req.client_requests', 'P').without('req.client_requests', ['create', 'delete'])
    .constrain('req.client_requests', { assigned_to_me: true })
    .res('home.portal', 'V')
    .build();
}

function platformAdmin(): TemplateGrant[] {
  const b = g();
  CAPABILITIES.filter((c) => c.module === 'platform').forEach((c) => b.res(c.key, 'VPKXAOR'));
  return b.build();
}

function platformSupport(): TemplateGrant[] {
  return g().res('platform.health', 'V').res('platform.support', 'V').res('platform.support', 'P').res('platform.tenants', 'V').res('home.platform', 'V').build();
}

export const ROLE_TEMPLATES: readonly RoleTemplate[] = [
  { key: 'platform_admin', name: 'Platform admin', description: 'Operates MeritBooks. Tenant data only through a support grant.', audience: 'platform', defaultScope: 'all_clients', fieldPolicy: FP('hidden', 'hidden', 'hidden'), authPolicy: MFA, maxAssignmentDays: null, assignableBand: 'tenant_admin_only', cloneToTenants: false, grants: platformAdmin() },
  { key: 'platform_support', name: 'Platform support', description: 'Read-only inside an approved support session.', audience: 'platform', defaultScope: 'all_clients', fieldPolicy: FP('hidden', 'masked', 'masked'), authPolicy: MFA, maxAssignmentDays: null, assignableBand: 'tenant_admin_only', cloneToTenants: false, grants: platformSupport() },
  { key: 'tenant_admin', name: 'Tenant admin', description: 'Administers the workspace: people, access, settings and billing. Books view only.', audience: 'internal_staff', defaultScope: 'all_clients', fieldPolicy: FP('grouped', 'masked', 'masked'), authPolicy: MFA, maxAssignmentDays: null, assignableBand: 'tenant_admin_only', cloneToTenants: true, grants: tenantAdmin() },
  { key: 'owner', name: 'Owner', description: 'Makes the decisions: approves and releases, reads the numbers.', audience: 'internal_staff', defaultScope: 'all_clients', fieldPolicy: FP('visible', 'reveal_logged', 'masked'), authPolicy: MFA_MONEY, maxAssignmentDays: null, assignableBand: 'tenant_admin_only', cloneToTenants: true, grants: owner() },
  { key: 'cfo', name: 'CFO', description: 'Final release and hard close; financial oversight across clients.', audience: 'internal_staff', defaultScope: 'all_clients', fieldPolicy: FP('visible', 'reveal_logged', 'reveal_logged'), authPolicy: MFA_MONEY, maxAssignmentDays: null, assignableBand: 'tenant_admin_only', cloneToTenants: true, grants: cfo() },
  { key: 'controller', name: 'Controller', description: 'Runs the books and the close; approves up to $250,000. Release off by default.', audience: 'internal_staff', defaultScope: 'all_clients', fieldPolicy: FP('visible', 'masked', 'reveal_logged'), authPolicy: MFA_MONEY, maxAssignmentDays: null, assignableBand: 'managers', cloneToTenants: true, grants: controller() },
  { key: 'finance_director', name: 'Finance director', description: 'CFO-like within assigned clients; approves and releases up to $100,000.', audience: 'internal_staff', defaultScope: 'assigned', fieldPolicy: FP('visible', 'masked', 'masked'), authPolicy: MFA_MONEY, maxAssignmentDays: null, assignableBand: 'managers', cloneToTenants: true, grants: financeDirector() },
  { key: 'accounting_manager', name: 'Accounting manager', description: 'Reviews and posts; approves up to $25,000; staffs bookkeepers within their own access.', audience: 'internal_staff', defaultScope: 'assigned', fieldPolicy: FP('grouped', 'masked', 'masked'), authPolicy: MFA_MONEY, maxAssignmentDays: null, assignableBand: 'managers', cloneToTenants: true, grants: accountingManager() },
  { key: 'bookkeeper', name: 'Bookkeeper', description: 'Keeps the books on assigned clients. No money approval or release.', audience: 'internal_staff', defaultScope: 'assigned', fieldPolicy: FP('grouped', 'masked', 'masked'), authPolicy: MFA, maxAssignmentDays: null, assignableBand: 'managers', cloneToTenants: true, grants: bookkeeper() },
  { key: 'ap_clerk', name: 'AP clerk', description: 'Bills in, pay runs prepared.', audience: 'internal_staff', defaultScope: 'assigned', fieldPolicy: FP('hidden', 'masked', 'masked'), authPolicy: NO_MFA, maxAssignmentDays: null, assignableBand: 'managers', cloneToTenants: true, grants: apClerk() },
  { key: 'ar_clerk', name: 'AR clerk', description: 'Invoices out, cash in.', audience: 'internal_staff', defaultScope: 'assigned', fieldPolicy: FP('hidden', 'masked', 'masked'), authPolicy: NO_MFA, maxAssignmentDays: null, assignableBand: 'managers', cloneToTenants: true, grants: arClerk() },
  { key: 'payments_clerk', name: 'Check processor', description: 'Queues, prints and files payments. Never approves or releases.', audience: 'internal_staff', defaultScope: 'assigned', fieldPolicy: FP('hidden', 'masked', 'masked'), authPolicy: MFA, maxAssignmentDays: null, assignableBand: 'managers', cloneToTenants: true, grants: paymentsClerk() },
  { key: 'data_entry', name: 'Data entry', description: 'Receipts, bills and master records.', audience: 'internal_staff', defaultScope: 'assigned', fieldPolicy: FP('hidden', 'masked', 'masked'), authPolicy: NO_MFA, maxAssignmentDays: null, assignableBand: 'managers', cloneToTenants: true, grants: dataEntry() },
  { key: 'hr_payroll', name: 'HR / payroll', description: 'Prepares payroll and maintains employees. Release only through a permission set.', audience: 'internal_staff', defaultScope: 'assigned', fieldPolicy: FP('visible', 'reveal_logged', 'reveal_logged', 'visible'), authPolicy: MFA, maxAssignmentDays: null, assignableBand: 'managers', cloneToTenants: true, grants: hrPayroll() },
  { key: 'department_head', name: 'Department head', description: "Approves their own department's spend up to $5,000.", audience: 'internal_staff', defaultScope: 'assigned', fieldPolicy: FP('grouped', 'hidden', 'hidden'), authPolicy: MFA, maxAssignmentDays: null, assignableBand: 'managers', cloneToTenants: true, grants: departmentHead() },
  { key: 'employee', name: 'Employee / cardholder', description: 'Own card charges, receipts and expense reports only.', audience: 'internal_staff', defaultScope: 'assigned', fieldPolicy: FP('hidden', 'hidden', 'hidden'), authPolicy: NO_MFA, maxAssignmentDays: null, assignableBand: 'any_grantor', cloneToTenants: true, grants: employee() },
  { key: 'external_auditor', name: 'External auditor', description: 'Read, export and PBC on assigned clients for a fixed period.', audience: 'external', defaultScope: 'assigned', fieldPolicy: FP('grouped', 'masked', 'masked'), authPolicy: MFA, maxAssignmentDays: 120, assignableBand: 'managers', cloneToTenants: true, grants: externalAuditor() },
  { key: 'lender_viewer', name: 'Lender viewer', description: 'Sees only certificates and packs delivered to them.', audience: 'external', defaultScope: 'assigned', fieldPolicy: FP('hidden', 'masked', 'masked'), authPolicy: MFA, maxAssignmentDays: 365, assignableBand: 'managers', cloneToTenants: true, grants: lenderViewer() },
  { key: 'view_only', name: 'View-only', description: 'Read-only books, no export.', audience: 'internal_staff', defaultScope: 'assigned', fieldPolicy: FP('hidden', 'masked', 'masked'), authPolicy: NO_MFA, maxAssignmentDays: null, assignableBand: 'managers', cloneToTenants: true, grants: viewOnly() },
  { key: 'client_admin', name: 'Client admin', description: "Manages the client's own staff and roles inside the client envelope.", audience: 'client_staff', defaultScope: 'assigned', fieldPolicy: FP('hidden', 'masked', 'masked'), authPolicy: MFA, maxAssignmentDays: null, assignableBand: 'managers', cloneToTenants: true, grants: clientAdmin() },
  { key: 'client_contact', name: 'Client contact', description: 'Answers requests and uploads documents. Never the ledger.', audience: 'external', defaultScope: 'assigned', fieldPolicy: FP('hidden', 'hidden', 'hidden'), authPolicy: NO_MFA, maxAssignmentDays: null, assignableBand: 'any_grantor', cloneToTenants: true, grants: clientContact() },
];

export const ROLE_TEMPLATE_BY_KEY: ReadonlyMap<string, RoleTemplate> = new Map(ROLE_TEMPLATES.map((t) => [t.key, t]));

// ── Permission sets (05 R-3) ──────────────────────────────────────────────────────

export function templateGrantMap(grants: readonly TemplateGrant[]): GrantMap {
  const m: GrantMap = new Map();
  for (const gr of grants) m.set(gr.capability, new Set(gr.actions));
  return m;
}

function fromGrantMap(m: GrantMap): TemplateGrant[] {
  return [...m.entries()]
    .map(([capability, s]) => ({ capability, actions: ACTIONS.filter((a) => s.has(a)), constraints: {} }))
    .filter((gr) => gr.actions.length > 0)
    .sort((a, b) => a.capability.localeCompare(b.capability));
}

/** Default "Legacy full books": legacy company_admin grants minus the Tenant admin template. */
export function legacyFullBooksGrants(legacyGrants?: GrantMap): TemplateGrant[] {
  const legacy = legacyGrants ?? expandLegacyCells(legacyRoleCells('company_admin'));
  return fromGrantMap(subtractGrants(legacy, templateGrantMap(ROLE_TEMPLATE_BY_KEY.get(LEGACY_ROLE_TO_TEMPLATE.company_admin)!.grants)));
}

/** Default "Legacy controller release": the money-release actions legacy merit_controller held. */
export function legacyControllerReleaseGrants(legacyGrants?: GrantMap): TemplateGrant[] {
  return fromGrantMap(moneyReleaseGrants(legacyGrants ?? expandLegacyCells(legacyRoleCells('merit_controller'))));
}

function clientStaffEnvelope(): TemplateGrant[] {
  return g()
    .res('ap.bills', 'PA').res('exp.receipts', 'PA').res('exp.reports', 'PA')
    .res('req.client_requests', 'PR').res('docs.documents', 'P').res('docs.documents', 'X')
    .dom('REPORTS', 'X').without('reports.packs', ['release', 'create', 'edit']).without('reports.board_package', ['release', 'create', 'approve'])
    .res('cash.position', 'V').res('mdm.vendors', 'P').res('mdm.customers', 'P')
    .res('ar.invoices', 'P').res('ar.invoices', 'R').res('ar.estimates', 'P').res('ar.estimates', 'R')
    .res('bank.transactions', 'V').res('cards.transactions', 'V').dom('JOBS', 'V').res('fpa.budgets', 'V')
    .res('debt.loans', 'V').res('debt.covenants', 'V').res('exp.policy', 'V').res('exp.chase_policy', 'V')
    .res('home.client', 'V').res('home.portal', 'V').res('ai.assist', 'V')
    .build();
}

/** Company tenants: everything books-side except locked capabilities, tenant settings, access admin and platform. */
function companyStaffEnvelope(): TemplateGrant[] {
  const b = g();
  for (const c of CAPABILITIES) {
    if (c.module !== 'books') continue;
    if (c.tags.includes('locked')) continue;
    b.res(c.key, 'VPAORXK');
  }
  return b.build();
}

export const PERMISSION_SET_TEMPLATES: readonly PermissionSetTemplate[] = [
  { key: 'client_staff_envelope', name: 'Client staff envelope', description: 'The most a client-defined role may contain in a firm tenant.', audience: 'client_staff', isEnvelope: true, isSealed: false, fieldPolicy: { comp: 'hidden', tin: 'masked', bank: 'masked' }, maxAssignmentDays: null, grants: clientStaffEnvelope() },
  { key: 'company_staff_envelope', name: 'Company staff envelope', description: 'The most a client-defined role may contain in a company tenant.', audience: 'client_staff', isEnvelope: true, isSealed: false, fieldPolicy: { comp: 'grouped', tin: 'masked', bank: 'masked' }, maxAssignmentDays: null, grants: companyStaffEnvelope() },
  { key: 'legacy_full_books', name: 'Legacy full books (company_admin)', description: 'Everything the old company admin role could do in the books, beyond Tenant admin. Flagged for the first access review.', audience: 'internal_staff', isEnvelope: false, isSealed: false, fieldPolicy: { comp: 'visible' }, maxAssignmentDays: null, grants: legacyFullBooksGrants() },
  { key: 'legacy_controller_release', name: 'Legacy controller release', description: 'Money release the old controller role held. Flagged for the first access review.', audience: 'internal_staff', isEnvelope: false, isSealed: false, fieldPolicy: {}, maxAssignmentDays: null, grants: legacyControllerReleaseGrants() },
  { key: 'payroll_comp_visibility', name: 'Payroll comp visibility', description: 'See individual pay.', audience: 'internal_staff', isEnvelope: false, isSealed: false, fieldPolicy: { comp: 'visible' }, maxAssignmentDays: null, grants: g().res('payroll.register', 'V').res('payroll.employees', 'V').res('payroll.runs', 'V').build() },
  { key: 'consolidation_manage', name: 'Consolidation manage', description: 'Manage consolidation groups, eliminations and statements.', audience: 'internal_staff', isEnvelope: false, isSealed: false, fieldPolicy: {}, maxAssignmentDays: null, grants: g().dom('CONSOL', 'PKXO').build() },
  { key: 'emergency_finance_access', name: 'Emergency finance access (template)', description: 'Sealed: activated by a named person plus a second person; expires after 4 hours.', audience: 'internal_staff', isEnvelope: false, isSealed: true, fieldPolicy: {}, maxAssignmentDays: 1, grants: g().res('pay.batches', 'AR').res('payroll.runs', 'AR').res('ap.bills', 'A').build() },
];

export const PERMISSION_SET_TEMPLATE_BY_KEY: ReadonlyMap<string, PermissionSetTemplate> = new Map(
  PERMISSION_SET_TEMPLATES.map((t) => [t.key, t]),
);

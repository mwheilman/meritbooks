/**
 * Budget service — shared context, row mappers and loaders (Wave 4B). Reads go through the
 * caller's RLS client (`reader`); writes through `writer` (the service role, handed out by the
 * route only after its permission + client-scope check — the 171/189 pattern). No PostgREST
 * embeds (core can't be embedded from public; the PGlite test client doesn't embed either).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAll, fetchAllIn } from '@/lib/supabase/fetch-all';
import { BudgetError, budgetErrorFromDb } from '../lifecycle';
import type {
  AccountLite,
  BridgeDriver,
  BudgetAccessSummary,
  BudgetVersion,
  DepartmentLite,
  DepartmentPlan,
  DriverMethod,
  LineSource,
  PlanStatus,
  VersionBasis,
  VersionKind,
  VersionStatus,
} from '../types';

export interface BudgetCtx {
  orgId: string;
  userId: string;
  userName?: string | null;
  reader: SupabaseClient;
  writer: SupabaseClient;
  access: BudgetAccessSummary;
}

type Row = Record<string, unknown>;
const N = (v: unknown): number => (v === null || v === undefined || v === '' ? 0 : Number(v));
const S = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const NN = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));

/** Throw a BudgetError for a Supabase error (a 189 trigger / CHECK message maps to LOCKED / SOD). */
export function must<T>(res: { data: T | null; error: { message: string } | null }, what: string): T {
  if (res.error) {
    throw budgetErrorFromDb(res.error.message) ?? new Error(`${what}: ${res.error.message}`);
  }
  return (res.data ?? ([] as unknown)) as T;
}

export function toVersion(r: Row): BudgetVersion {
  return {
    id: String(r.id),
    locationId: String(r.location_id),
    fiscalYear: N(r.fiscal_year),
    kind: String(r.kind) as VersionKind,
    versionNumber: N(r.version_number),
    label: String(r.label),
    status: String(r.status) as VersionStatus,
    isCurrent: r.is_current === true,
    parentVersionId: S(r.parent_version_id),
    basis: String(r.basis ?? 'BLANK') as VersionBasis,
    growthBps: NN(r.growth_bps),
    dueDate: S(r.due_date),
    materialityCents: N(r.materiality_cents),
    materialityBps: N(r.materiality_bps),
    notes: S(r.notes),
    createdBy: S(r.created_by),
    submittedBy: S(r.submitted_by),
    submittedAt: S(r.submitted_at),
    submitNote: S(r.submit_note),
    returnedNote: S(r.returned_note),
    approvedBy: S(r.approved_by),
    approvedAt: S(r.approved_at),
    lockedBy: S(r.locked_by),
    lockedAt: S(r.locked_at),
    createdAt: String(r.created_at ?? ''),
    updatedAt: String(r.updated_at ?? ''),
  };
}

export function toPlan(r: Row, deptName = ''): DepartmentPlan {
  return {
    id: String(r.id),
    versionId: String(r.version_id),
    departmentId: String(r.department_id),
    departmentName: deptName,
    ownerUserId: S(r.owner_user_id),
    ownerName: S(r.owner_name),
    templateKey: S(r.template_key),
    templateVersion: NN(r.template_version),
    status: String(r.status) as PlanStatus,
    dueDate: S(r.due_date),
    targetRevenueCents: NN(r.target_revenue_cents),
    targetExpenseCents: NN(r.target_expense_cents),
    gapNote: S(r.gap_note),
    submittedBy: S(r.submitted_by),
    submittedAt: S(r.submitted_at),
    submitNote: S(r.submit_note),
    reviewedBy: S(r.reviewed_by),
    reviewedAt: S(r.reviewed_at),
    reviewNote: S(r.review_note),
    approvedBy: S(r.approved_by),
    approvedAt: S(r.approved_at),
  };
}

export async function loadVersion(db: SupabaseClient, id: string): Promise<BudgetVersion> {
  const res = await db.from('budget_plan_versions').select('*').eq('id', id).maybeSingle();
  const row = must(res as { data: Row | null; error: { message: string } | null }, 'budget version');
  if (!row || Array.isArray(row) || !(row as Row).id) throw new BudgetError('NOT_FOUND', 'That budget version was not found.');
  return toVersion(row as Row);
}

export async function listVersions(db: SupabaseClient, locationId: string, fiscalYear: number): Promise<BudgetVersion[]> {
  const rows = must(
    await db.from('budget_plan_versions').select('*').eq('location_id', locationId).eq('fiscal_year', fiscalYear),
    'budget versions',
  ) as Row[];
  return rows.map(toVersion).sort((a, b) => (a.kind === b.kind ? b.versionNumber - a.versionNumber : a.kind === 'BUDGET' ? -1 : 1));
}

export interface AccountsIndex {
  list: AccountLite[];
  byId: Map<string, AccountLite>;
}

const PNL = ['REVENUE', 'COGS', 'OPEX', 'OTHER'];

/** Active P&L accounts with their group names (per tenant COA; RLS-scoped, and org-pinned when given). */
export async function loadAccounts(db: SupabaseClient, orgId?: string): Promise<AccountsIndex> {
  const accts = must(
    await fetchAll<Row>(() => {
      const q = db.from('accounts').select('id, account_number, name, account_type, account_sub_type, account_group_id, is_active').in('account_type', PNL);
      return orgId ? q.eq('org_id', orgId) : q;
    }, { label: 'budget accounts', orderBy: 'id' }),
    'accounts',
  ) as Row[];
  const groupIds = Array.from(new Set(accts.map((a) => S(a.account_group_id)).filter((x): x is string => !!x)));
  const groups = new Map<string, string>();
  if (groupIds.length) {
    const gs = must(await fetchAllIn<Row>(groupIds, (chunk) => db.from('account_groups').select('id, name').in('id', chunk), { label: 'account groups' }), 'account groups') as Row[];
    for (const g of gs) groups.set(String(g.id), String(g.name));
  }
  const list: AccountLite[] = accts
    .filter((a) => a.is_active !== false)
    .map((a) => ({
      id: String(a.id),
      number: String(a.account_number ?? ''),
      name: String(a.name ?? ''),
      type: String(a.account_type),
      subType: String(a.account_sub_type ?? ''),
      groupName: a.account_group_id ? groups.get(String(a.account_group_id)) ?? null : null,
    }))
    .sort((x, y) => x.number.localeCompare(y.number, undefined, { numeric: true }));
  // Inactive accounts still need labels when old lines reference them.
  const byId = new Map<string, AccountLite>();
  for (const a of accts) {
    byId.set(String(a.id), {
      id: String(a.id), number: String(a.account_number ?? ''), name: String(a.name ?? ''), type: String(a.account_type),
      subType: String(a.account_sub_type ?? ''), groupName: a.account_group_id ? groups.get(String(a.account_group_id)) ?? null : null,
    });
  }
  return { list, byId };
}

/** Departments of a company (company-specific + org-wide), active. RLS-scoped, and org-pinned when given. */
export async function loadDepartments(db: SupabaseClient, locationId: string, orgId?: string): Promise<DepartmentLite[]> {
  const base = db.schema('core').from('departments').select('id, name, code, location_id, is_active');
  const rows = must(await (orgId ? base.eq('org_id', orgId) : base), 'departments') as Row[];
  return rows
    .filter((d) => d.is_active !== false && (d.location_id === null || d.location_id === undefined || String(d.location_id) === locationId))
    .map((d) => ({ id: String(d.id), name: String(d.name), code: String(d.code ?? ''), locationId: S(d.location_id) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface LineRow {
  id: string;
  accountId: string;
  departmentId: string | null;
  periodNumber: number;
  amountCents: number;
  source: LineSource;
  notes: string | null;
}

export async function loadLines(db: SupabaseClient, versionId: string, departmentId?: string | null): Promise<LineRow[]> {
  const rows = must(
    await fetchAll<Row>(() => {
      let q = db.from('budget_version_lines').select('id, account_id, department_id, period_number, amount_cents, source, notes').eq('version_id', versionId);
      if (departmentId === null) q = q.is('department_id', null);
      else if (departmentId) q = q.eq('department_id', departmentId);
      return q;
    }, { label: 'budget lines', orderBy: 'id' }),
    'budget lines',
  ) as Row[];
  return rows.map((r) => ({
    id: String(r.id),
    accountId: String(r.account_id),
    departmentId: S(r.department_id),
    periodNumber: N(r.period_number),
    amountCents: N(r.amount_cents),
    source: String(r.source) as LineSource,
    notes: S(r.notes),
  }));
}

export interface DriverRow {
  accountId: string;
  departmentId: string | null;
  method: DriverMethod;
  params: Record<string, number>;
  bridgeDriver: BridgeDriver;
  note: string | null;
  annualCents: number;
}

export async function loadDrivers(db: SupabaseClient, versionId: string): Promise<DriverRow[]> {
  const rows = must(await db.from('budget_line_drivers').select('*').eq('version_id', versionId), 'budget drivers') as Row[];
  return rows.map((r) => ({
    accountId: String(r.account_id),
    departmentId: S(r.department_id),
    method: String(r.method) as DriverMethod,
    params: (r.params && typeof r.params === 'object' ? r.params : {}) as Record<string, number>,
    bridgeDriver: String(r.bridge_driver ?? 'AUTO') as BridgeDriver,
    note: S(r.note),
    annualCents: N(r.annual_cents),
  }));
}

export async function loadPlans(db: SupabaseClient, versionId: string, deptNames: ReadonlyMap<string, string> = new Map()): Promise<DepartmentPlan[]> {
  const rows = must(await db.from('budget_department_plans').select('*').eq('version_id', versionId), 'department plans') as Row[];
  return rows.map((r) => toPlan(r, deptNames.get(String(r.department_id)) ?? ''));
}

export interface OwnerRow {
  departmentId: string;
  ownerUserId: string;
  ownerName: string | null;
}

/**
 * Standing department owners the caller may see (RLS: the 189 department-scope policy). The
 * owner's email is NOT selectable by members (column grants) — use loadOwnerEmails.
 */
export async function loadOwners(db: SupabaseClient, orgId?: string): Promise<OwnerRow[]> {
  const base = db.from('budget_department_owners').select('department_id, owner_user_id, owner_name');
  const rows = must(await (orgId ? base.eq('org_id', orgId) : base), 'department owners') as Row[];
  return rows.map((r) => ({ departmentId: String(r.department_id), ownerUserId: String(r.owner_user_id), ownerName: S(r.owner_name) }));
}

/**
 * Owner emails (department → email) through the SERVICE ROLE, org-pinned. Callers return these
 * only to a budget admin (approve / close_mgmt:manage) — never to a department head.
 */
export async function loadOwnerEmails(ctx: Pick<BudgetCtx, 'orgId' | 'writer' | 'access'>, departmentIds: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!(ctx.access.scope === 'ALL' && ctx.access.canApprove) || departmentIds.length === 0) return out;
  const rows = must(
    await ctx.writer.from('budget_department_owners').select('department_id, owner_email').eq('org_id', ctx.orgId).in('department_id', [...departmentIds]),
    'owner emails',
  ) as Row[];
  for (const r of rows) if (r.owner_email) out.set(String(r.department_id), String(r.owner_email));
  return out;
}

/** Append one audit event (best effort is NOT acceptable: an unlogged transition is a defect). */
export async function logEvent(
  ctx: BudgetCtx,
  e: { locationId: string; versionId?: string | null; planId?: string | null; kind: string; from?: string | null; to?: string | null; note?: string | null; meta?: Record<string, unknown> },
): Promise<void> {
  must(
    await ctx.writer.from('budget_events').insert({
      org_id: ctx.orgId,
      location_id: e.locationId,
      version_id: e.versionId ?? null,
      department_plan_id: e.planId ?? null,
      event_kind: e.kind,
      from_status: e.from ?? null,
      to_status: e.to ?? null,
      actor_user_id: ctx.userId,
      note: e.note ? e.note.slice(0, 1000) : null,
      meta: e.meta ?? {},
    }),
    'budget event',
  );
}

export const num = N;
export const str = S;

/**
 * Budget lines — the grid (Wave 4B, AC-B20 / AC-B13 / AC-B18). Loading a department's grid with
 * last year's actuals beside each row, saving cell edits, applying a driver to a row, and the
 * shared `writeCells` primitive the generators, templates and import use.
 *
 * Every write first passes the app-side lock (lib/budgets/lifecycle.ts lockReason) and the
 * department scope (lib/budgets/scope.ts); migration 189's trigger is the guarantor behind both.
 */
import { generate, specFrom, paramsOf, MONTHS } from '../generators';
import { BudgetError, lockReason } from '../lifecycle';
import { canEditDepartment, canSeeDepartment } from '../scope';
import type {
  AccountLite,
  BridgeDriver,
  BudgetVersion,
  CellEdit,
  DriverMethod,
  DriverSpec,
  GridResponse,
  GridRow,
  LineSource,
  PlanStatus,
} from '../types';
import { loadActualCells, naturalOf } from './actuals';
import { loadAccounts, loadDrivers, loadLines, loadVersion, logEvent, must, type BudgetCtx, type LineRow } from './data';
import { assertBudgetRefs } from './refs';

const zeros = () => Array.from({ length: MONTHS }, () => 0);

export function rowKey(accountId: string, departmentId: string | null): string {
  return `${accountId}|${departmentId ?? ''}`;
}

/** Plan status of a department inside a version (null = company level / no plan). */
export async function planStatusOf(ctx: BudgetCtx, versionId: string, departmentId: string | null): Promise<PlanStatus | null> {
  if (!departmentId) return null;
  const rows = must(
    await ctx.reader.from('budget_department_plans').select('status').eq('version_id', versionId).eq('department_id', departmentId),
    'department plan',
  ) as Array<{ status: PlanStatus }>;
  return rows[0]?.status ?? null;
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Months (1..12) of a company-year whose fiscal period is SOFT_CLOSE or HARD_CLOSE (RLS read).
 * Period 13 (adjustments) has no fiscal period and is never closed. The 189 line trigger is the
 * guarantor (BUDGET_PERIOD_CLOSED); this lets the service refuse first and the UI say which.
 */
export async function closedPeriods(ctx: Pick<BudgetCtx, 'reader'>, locationId: string, fiscalYear: number): Promise<number[]> {
  const rows = must(
    await ctx.reader.from('fiscal_periods').select('period_month, status').eq('location_id', locationId).eq('period_year', fiscalYear),
    'fiscal periods',
  ) as Array<{ period_month: number; status: string }>;
  return Array.from(new Set(rows.filter((r) => r.status === 'SOFT_CLOSE' || r.status === 'HARD_CLOSE').map((r) => Number(r.period_month))))
    .filter((m) => m >= 1 && m <= 12)
    .sort((a, b) => a - b);
}

export function closedMonthsMessage(fiscalYear: number, months: readonly number[]): string {
  const names = months.map((m) => MONTH_ABBR[m - 1] ?? String(m)).join(', ');
  return `${names} ${fiscalYear} ${months.length === 1 ? 'is' : 'are'} closed — budgets for a closed month can’t change.`;
}

/** Throws unless the caller may change this department's lines in this version right now. */
export async function assertEditable(ctx: BudgetCtx, version: BudgetVersion, departmentId: string | null): Promise<void> {
  if (!canSeeDepartment(ctx.access, departmentId)) throw new BudgetError('SCOPE', 'That department’s budget isn’t yours to see.');
  const reason = lockReason(version.status, await planStatusOf(ctx, version.id, departmentId), canEditDepartment(ctx.access, departmentId));
  if (reason) throw new BudgetError(reason.startsWith('You can view') ? 'SCOPE' : 'LOCKED', reason);
}

/** Natural-sign prior-year actuals per account for one department (null = company level). */
export async function pyActualsByAccount(
  ctx: BudgetCtx,
  locationId: string,
  fiscalYear: number,
  departmentId: string | null | undefined,
  accounts: ReadonlyMap<string, AccountLite>,
): Promise<Map<string, number[]>> {
  const py = fiscalYear - 1;
  const cells = await loadActualCells(ctx.reader, {
    locationId,
    from: `${py}-01-01`,
    to: `${py}-12-31`,
    departmentIds: departmentId === undefined ? undefined : departmentId === null ? null : [departmentId],
  });
  const out = new Map<string, number[]>();
  for (const c of cells) {
    const a = accounts.get(c.accountId);
    const v = naturalOf(a, c.netDebitCents);
    if (!a || v === 0) continue;
    const m = Number(c.month.slice(5, 7));
    const arr = out.get(c.accountId) ?? zeros();
    arr[m - 1] += v;
    out.set(c.accountId, arr);
  }
  return out;
}

export async function getGrid(ctx: BudgetCtx, versionId: string, departmentId: string | null): Promise<GridResponse> {
  const version = await loadVersion(ctx.reader, versionId);
  if (!canSeeDepartment(ctx.access, departmentId)) throw new BudgetError('SCOPE', 'That department’s budget isn’t yours to see.');
  const [{ list, byId }, lines, drivers, planStatus, commentRows, closed] = await Promise.all([
    loadAccounts(ctx.reader, ctx.orgId),
    loadLines(ctx.reader, versionId, departmentId),
    loadDrivers(ctx.reader, versionId),
    planStatusOf(ctx, versionId, departmentId),
    ctx.reader.from('budget_comments').select('account_id, status').eq('version_id', versionId)
      .then((r) => (r.data ?? []) as Array<{ account_id: string | null; status: string }>),
    closedPeriods(ctx, version.locationId, version.fiscalYear),
  ]);
  const py = await pyActualsByAccount(ctx, version.locationId, version.fiscalYear, departmentId, byId);
  const rows = new Map<string, GridRow>();
  const ensure = (accountId: string): GridRow | null => {
    const a = byId.get(accountId);
    if (!a) return null;
    const k = rowKey(accountId, departmentId);
    let r = rows.get(k);
    if (!r) {
      const pyMonths = py.get(accountId) ?? zeros();
      r = {
        key: k, accountId, accountNumber: a.number, accountName: a.name, accountType: a.type, groupName: a.groupName,
        departmentId, months: zeros(), adjustmentsCents: 0, totalCents: 0,
        pyActualCents: pyMonths.reduce((t, v) => t + v, 0), pyMonths, driver: null, sources: [], comments: 0,
      };
      rows.set(k, r);
    }
    return r;
  };
  for (const l of lines) {
    const r = ensure(l.accountId);
    if (!r) continue;
    if (l.periodNumber === 13) r.adjustmentsCents += l.amountCents;
    else r.months[l.periodNumber - 1] += l.amountCents;
    if (!r.sources.includes(l.source)) r.sources.push(l.source);
  }
  for (const d of drivers) {
    if ((d.departmentId ?? null) !== departmentId) continue;
    const r = ensure(d.accountId);
    if (r) r.driver = { method: d.method, params: d.params, bridgeDriver: d.bridgeDriver, note: d.note };
  }
  for (const accountId of py.keys()) ensure(accountId);
  for (const c of commentRows) if (c.account_id && c.status === 'OPEN') {
    const r = rows.get(rowKey(c.account_id, departmentId));
    if (r) r.comments++;
  }
  const out = [...rows.values()];
  for (const r of out) r.totalCents = r.months.reduce((t, v) => t + v, 0) + r.adjustmentsCents;
  out.sort((x, y) => x.accountNumber.localeCompare(y.accountNumber, undefined, { numeric: true }));
  const income = (r: GridRow) => r.accountType === 'REVENUE' || (r.accountType === 'OTHER' && byId.get(r.accountId)?.subType === 'OTHER_INCOME');
  const totals = { revenueCents: 0, expenseCents: 0, pyRevenueCents: 0, pyExpenseCents: 0 };
  for (const r of out) {
    if (income(r)) { totals.revenueCents += r.totalCents; totals.pyRevenueCents += r.pyActualCents; }
    else { totals.expenseCents += r.totalCents; totals.pyExpenseCents += r.pyActualCents; }
  }
  const reason = lockReason(version.status, planStatus, canEditDepartment(ctx.access, departmentId));
  return { version, departmentId, planStatus, editable: reason === null, lockReason: reason, closedPeriods: closed, rows: out, accounts: list, totals };
}

export interface CellWrite {
  accountId: string;
  periodNumber: number;
  amountCents: number;
}

export interface WriteCellsOptions {
  /**
   * A changed cell in a closed month: 'refuse' (default — explicit edits, imports) throws
   * PERIOD_CLOSED naming the months; 'skip' (generators: drivers, templates, last year + x%) keeps
   * the closed months as they are and reports them in `skippedClosed`.
   */
  closedMonths?: 'refuse' | 'skip';
}

export interface WriteCellsResult {
  changed: number;
  /** Closed months (1..12) whose changes were skipped (closedMonths: 'skip'). */
  skippedClosed: number[];
}

/**
 * Write cells for one department of a version (insert / update / delete-on-zero). The caller has
 * already asserted editability. Every referenced id is pinned to the org and the version's
 * company first (service/refs.ts), and changes to a closed month are refused (or skipped).
 */
export async function writeCellsDetailed(
  ctx: BudgetCtx,
  version: BudgetVersion,
  departmentId: string | null,
  cells: readonly CellWrite[],
  source: LineSource,
  opts: WriteCellsOptions = {},
): Promise<WriteCellsResult> {
  for (const c of cells) {
    if (!Number.isInteger(c.amountCents)) throw new BudgetError('VALIDATION', 'Budget amounts must be whole cents.');
    if (!Number.isInteger(c.periodNumber) || c.periodNumber < 1 || c.periodNumber > 13) throw new BudgetError('VALIDATION', 'Period must be 1–13.');
    if (Math.abs(c.amountCents) > 1e15) throw new BudgetError('VALIDATION', 'That amount is too large.');
  }
  await assertBudgetRefs(ctx, {
    locationId: version.locationId,
    versionIds: [version.id],
    accountIds: cells.map((c) => c.accountId),
    departmentIds: [departmentId],
  });
  // Last write wins within one request.
  const want = new Map<string, CellWrite>();
  for (const c of cells) want.set(`${c.accountId}|${c.periodNumber}`, c);
  const existing: LineRow[] = await loadLines(ctx.reader, version.id, departmentId);
  const have = new Map(existing.map((l) => [`${l.accountId}|${l.periodNumber}`, l]));
  const isChange = (c: CellWrite) => {
    const cur = have.get(`${c.accountId}|${c.periodNumber}`);
    return cur ? cur.amountCents !== c.amountCents : c.amountCents !== 0;
  };
  const closed = new Set(await closedPeriods(ctx, version.locationId, version.fiscalYear));
  const skipped = new Set<number>();
  if (closed.size > 0) {
    const hits = Array.from(new Set([...want.values()].filter((c) => closed.has(c.periodNumber) && isChange(c)).map((c) => c.periodNumber))).sort((a, b) => a - b);
    if (hits.length > 0) {
      if ((opts.closedMonths ?? 'refuse') === 'refuse') throw new BudgetError('PERIOD_CLOSED', closedMonthsMessage(version.fiscalYear, hits));
      for (const [k, c] of want) if (closed.has(c.periodNumber)) want.delete(k);
      hits.forEach((m) => skipped.add(m));
    }
  }
  const inserts: Array<Record<string, unknown>> = [];
  let changed = 0;
  for (const [k, c] of want) {
    const cur = have.get(k);
    if (cur) {
      if (cur.amountCents === c.amountCents) continue;
      if (c.amountCents === 0) {
        must(await ctx.writer.from('budget_version_lines').delete().eq('id', cur.id).eq('org_id', ctx.orgId), 'delete budget cell');
      } else {
        must(await ctx.writer.from('budget_version_lines').update({ amount_cents: c.amountCents, source, updated_by: ctx.userId }).eq('id', cur.id).eq('org_id', ctx.orgId), 'update budget cell');
      }
      changed++;
    } else if (c.amountCents !== 0) {
      inserts.push({
        org_id: ctx.orgId, version_id: version.id, location_id: version.locationId, fiscal_year: version.fiscalYear,
        account_id: c.accountId, department_id: departmentId, period_number: c.periodNumber, amount_cents: c.amountCents,
        source, updated_by: ctx.userId,
      });
    }
  }
  for (let i = 0; i < inserts.length; i += 500) {
    must(await ctx.writer.from('budget_version_lines').insert(inserts.slice(i, i + 500)), 'insert budget cells');
  }
  changed += inserts.length;
  if (departmentId) await touchPlan(ctx, version, departmentId);
  return { changed, skippedClosed: [...skipped].sort((a, b) => a - b) };
}

/** `writeCellsDetailed`, returning the number of cells changed. */
export async function writeCells(
  ctx: BudgetCtx,
  version: BudgetVersion,
  departmentId: string | null,
  cells: readonly CellWrite[],
  source: LineSource,
  opts: WriteCellsOptions = {},
): Promise<number> {
  return (await writeCellsDetailed(ctx, version, departmentId, cells, source, opts)).changed;
}

/** A first save moves a NOT_STARTED / RETURNED department to DRAFT. */
async function touchPlan(ctx: BudgetCtx, version: BudgetVersion, departmentId: string): Promise<void> {
  const rows = must(
    await ctx.reader.from('budget_department_plans').select('id, status').eq('version_id', version.id).eq('department_id', departmentId),
    'department plan',
  ) as Array<{ id: string; status: PlanStatus }>;
  if (rows.length === 0) {
    must(await ctx.writer.from('budget_department_plans').insert({ org_id: ctx.orgId, version_id: version.id, location_id: version.locationId, department_id: departmentId, status: 'DRAFT' }), 'department plan');
  } else if (rows[0].status === 'NOT_STARTED' || rows[0].status === 'RETURNED') {
    must(await ctx.writer.from('budget_department_plans').update({ status: 'DRAFT' }).eq('id', rows[0].id), 'department plan');
  }
}

export async function saveCells(
  ctx: BudgetCtx,
  versionId: string,
  departmentId: string | null,
  edits: readonly CellEdit[],
  source: Extract<LineSource, 'MANUAL' | 'PASTE'>,
): Promise<{ changed: number }> {
  const version = await loadVersion(ctx.reader, versionId);
  await assertEditable(ctx, version, departmentId);
  const { byId } = await loadAccounts(ctx.reader, ctx.orgId);
  for (const e of edits) if (!byId.has(e.accountId)) throw new BudgetError('VALIDATION', 'One of those accounts is not a P&L account in this chart.');
  const changed = await writeCells(ctx, version, departmentId, edits, source);
  if (changed > 0) await logEvent(ctx, { locationId: version.locationId, versionId, kind: 'LINES_SAVED', meta: { department_id: departmentId, cells: changed, source } });
  return { changed };
}

/** Months of the department's budgeted revenue in this version (for % of revenue drivers). */
export async function revenueMonths(ctx: BudgetCtx, versionId: string, departmentId: string | null, accounts: ReadonlyMap<string, AccountLite>): Promise<number[]> {
  const lines = await loadLines(ctx.reader, versionId, departmentId);
  const out = zeros();
  for (const l of lines) {
    const a = accounts.get(l.accountId);
    if (!a || l.periodNumber > 12) continue;
    if (a.type === 'REVENUE' || (a.type === 'OTHER' && a.subType === 'OTHER_INCOME')) out[l.periodNumber - 1] += l.amountCents;
  }
  return out;
}

/** Last year's budget (the FY−1 current version) for one row. */
async function priorBudgetMonths(ctx: BudgetCtx, version: BudgetVersion, accountId: string, departmentId: string | null): Promise<number[]> {
  const rows = must(
    await ctx.reader.from('budgets').select('period_number, amount_cents, department_id').eq('location_id', version.locationId)
      .eq('fiscal_year', version.fiscalYear - 1).eq('account_id', accountId),
    'prior budget',
  ) as Array<{ period_number: number; amount_cents: number; department_id: string | null }>;
  const out = zeros();
  for (const r of rows) if ((r.department_id ?? null) === departmentId && r.period_number <= 12) out[r.period_number - 1] += Number(r.amount_cents);
  return out;
}

export interface ApplyDriverInput {
  versionId: string;
  departmentId: string | null;
  accountId: string;
  method: DriverMethod;
  params: Record<string, number>;
  bridgeDriver?: BridgeDriver;
  note?: string | null;
  /** Preview only: compute, write nothing. */
  dryRun?: boolean;
}

/** Expand a driver into the row's 12 months and remember the driver (AC-B13). */
export async function applyDriver(ctx: BudgetCtx, i: ApplyDriverInput): Promise<{ months: number[]; annualCents: number; explain: string; fellBackToEven: boolean }> {
  const version = await loadVersion(ctx.reader, i.versionId);
  if (!i.dryRun) await assertEditable(ctx, version, i.departmentId);
  else if (!canSeeDepartment(ctx.access, i.departmentId)) throw new BudgetError('SCOPE', 'That department’s budget isn’t yours to see.');
  const { byId } = await loadAccounts(ctx.reader, ctx.orgId);
  if (!byId.has(i.accountId)) throw new BudgetError('VALIDATION', 'That account is not a P&L account in this chart.');
  const spec: DriverSpec = specFrom(i.method, i.params);
  const ctxMonths = {
    pyMonths: (await pyActualsByAccount(ctx, version.locationId, version.fiscalYear, i.departmentId, byId)).get(i.accountId),
    priorBudgetMonths: spec.method === 'PRIOR_BUDGET_GROWTH' ? await priorBudgetMonths(ctx, version, i.accountId, i.departmentId) : undefined,
    revenueMonths: spec.method === 'PCT_OF_REVENUE' ? await revenueMonths(ctx, i.versionId, i.departmentId, byId) : undefined,
  };
  let g;
  try {
    g = generate(spec, ctxMonths);
  } catch (e) {
    throw new BudgetError('VALIDATION', e instanceof Error ? e.message : 'That driver could not be applied.');
  }
  if (i.dryRun) return g;
  if (spec.method !== 'MANUAL') {
    await writeCells(ctx, version, i.departmentId, g.months.map((v, k) => ({ accountId: i.accountId, periodNumber: k + 1, amountCents: v })), 'DRIVER', { closedMonths: 'skip' });
  }
  await upsertDriver(ctx, version, i.departmentId, i.accountId, spec, g.annualCents, i.bridgeDriver ?? 'AUTO', i.note ?? null);
  await logEvent(ctx, { locationId: version.locationId, versionId: version.id, kind: 'LINES_GENERATED', meta: { department_id: i.departmentId, account_id: i.accountId, method: spec.method, annual_cents: g.annualCents } });
  return g;
}

export async function upsertDriver(
  ctx: BudgetCtx,
  version: BudgetVersion,
  departmentId: string | null,
  accountId: string,
  spec: DriverSpec,
  annualCents: number,
  bridgeDriver: BridgeDriver,
  note: string | null,
): Promise<void> {
  await assertBudgetRefs(ctx, { locationId: version.locationId, versionIds: [version.id], accountIds: [accountId], departmentIds: [departmentId] });
  let q = ctx.reader.from('budget_line_drivers').select('id').eq('version_id', version.id).eq('account_id', accountId);
  q = departmentId ? q.eq('department_id', departmentId) : q.is('department_id', null);
  const found = must(await q, 'driver') as Array<{ id: string }>;
  const row = { method: spec.method, params: paramsOf(spec), annual_cents: annualCents, bridge_driver: bridgeDriver, note: note ? note.slice(0, 1000) : null, updated_by: ctx.userId };
  if (found[0]) must(await ctx.writer.from('budget_line_drivers').update(row).eq('id', found[0].id).eq('org_id', ctx.orgId), 'driver');
  else must(await ctx.writer.from('budget_line_drivers').insert({ ...row, org_id: ctx.orgId, version_id: version.id, location_id: version.locationId, account_id: accountId, department_id: departmentId }), 'driver');
}

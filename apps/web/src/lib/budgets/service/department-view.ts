/**
 * Department view (Wave 4B, AC-B15 / AC-B16): the department P&L — actual vs budget vs prior year
 * for a month / QTD / YTD / TTM window, the material variances with their explanations, the GL
 * drill, and the three bridges (last year → budget, budget → actual, budget → latest forecast).
 */
import type { MonthKey } from '@/lib/analytics';
import { isPayrollAccount, groupBridge, pyToBudgetBridge, type PyBudgetRow } from '../bridges';
import { cellKey, departmentBva, monthKey, priorYearMonths, windowLabel, windowMonths } from '../bva';
import { latestEstimate } from '../generators';
import { BudgetError } from '../lifecycle';
import { canSeeDepartment } from '../scope';
import type { AccountLite, BudgetVersion, BvaWindow, DepartmentViewResponse, GlDrillLine, VarianceNote } from '../types';
import { drillLines, loadActualCells, naturalOf } from './actuals';
import { listVersions, loadAccounts, loadDepartments, loadDrivers, loadLines, loadVersion, must, type BudgetCtx } from './data';

export interface DepartmentViewQuery {
  locationId: string;
  fiscalYear: number;
  month: number;
  window: BvaWindow;
  /** null = company-level lines (finance only). */
  departmentId: string | null;
  versionId?: string | null;
}

const MONTHS12 = Array.from({ length: 12 }, (_, i) => i + 1);
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const isoStart = (k: MonthKey) => `${k}-01`;
const isoEnd = (k: MonthKey) => `${k}-${String(lastDay(Number(k.slice(0, 4)), Number(k.slice(5, 7)))).padStart(2, '0')}`;

/** Closed periods (SOFT / HARD close), contiguous from period 1, for one company-year. */
export async function closedThrough(ctx: BudgetCtx, locationId: string, fiscalYear: number): Promise<number> {
  const rows = must(
    await ctx.reader.from('fiscal_periods').select('period_month, status').eq('location_id', locationId).eq('period_year', fiscalYear),
    'fiscal periods',
  ) as Array<{ period_month: number; status: string }>;
  const closed = new Set(rows.filter((r) => r.status === 'SOFT_CLOSE' || r.status === 'HARD_CLOSE').map((r) => Number(r.period_month)));
  let k = 0;
  while (k < 12 && closed.has(k + 1)) k++;
  return k;
}

async function pickVersion(ctx: BudgetCtx, q: DepartmentViewQuery): Promise<{ budget: BudgetVersion | null; forecast: BudgetVersion | null }> {
  const versions = await listVersions(ctx.reader, q.locationId, q.fiscalYear);
  const budget = q.versionId ? await loadVersion(ctx.reader, q.versionId) : versions.find((v) => v.isCurrent) ?? null;
  if (budget && budget.locationId !== q.locationId) throw new BudgetError('VALIDATION', 'That version belongs to another company.');
  const rf = versions.filter((v) => v.kind === 'REFORECAST' && v.status !== 'SUPERSEDED');
  const forecast =
    rf.filter((v) => v.status === 'APPROVED' || v.status === 'LOCKED').sort((a, b) => b.versionNumber - a.versionNumber)[0] ??
    rf.sort((a, b) => b.versionNumber - a.versionNumber)[0] ??
    null;
  return { budget, forecast };
}

/** Budget cents by account × month for the department: the version's own year + the published prior year. */
async function budgetMap(ctx: BudgetCtx, version: BudgetVersion | null, q: DepartmentViewQuery, months: readonly MonthKey[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (version) {
    for (const l of await loadLines(ctx.reader, version.id, q.departmentId)) {
      if (l.periodNumber > 12) continue;
      const k = cellKey(l.accountId, monthKey(version.fiscalYear, l.periodNumber));
      out.set(k, (out.get(k) ?? 0) + l.amountCents);
    }
  }
  const years = new Set(months.map((m) => Number(m.slice(0, 4))).filter((y) => y !== version?.fiscalYear));
  for (const y of years) {
    let bq = ctx.reader.from('budgets').select('account_id, period_number, amount_cents, department_id').eq('location_id', q.locationId).eq('fiscal_year', y);
    bq = q.departmentId ? bq.eq('department_id', q.departmentId) : bq.is('department_id', null);
    const rows = must(await bq, 'published budget') as Array<{ account_id: string; period_number: number; amount_cents: number }>;
    for (const r of rows) {
      if (r.period_number > 12) continue;
      const k = cellKey(r.account_id, monthKey(y, r.period_number));
      out.set(k, (out.get(k) ?? 0) + Number(r.amount_cents));
    }
  }
  return out;
}

async function actualMap(ctx: BudgetCtx, q: DepartmentViewQuery, from: MonthKey, to: MonthKey, accounts: ReadonlyMap<string, AccountLite>): Promise<Map<string, number>> {
  const cells = await loadActualCells(ctx.reader, {
    locationId: q.locationId,
    from: isoStart(from),
    to: isoEnd(to),
    departmentIds: q.departmentId ? [q.departmentId] : null,
  });
  const out = new Map<string, number>();
  for (const c of cells) {
    const v = naturalOf(accounts.get(c.accountId), c.netDebitCents);
    if (v === 0) continue;
    const k = cellKey(c.accountId, c.month);
    out.set(k, (out.get(k) ?? 0) + v);
  }
  return out;
}

async function explanations(ctx: BudgetCtx, q: DepartmentViewQuery): Promise<Map<string, VarianceNote>> {
  let cq = ctx.reader.from('budget_comments').select('*').eq('location_id', q.locationId).eq('kind', 'VARIANCE_EXPLANATION')
    .eq('period_key', monthKey(q.fiscalYear, q.month)).eq('variance_window', q.window);
  cq = q.departmentId ? cq.eq('department_id', q.departmentId) : cq.is('department_id', null);
  const rows = must(await cq, 'variance explanations') as Array<Record<string, unknown>>;
  const out = new Map<string, VarianceNote>();
  rows.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  for (const r of rows) {
    if (!r.account_id || r.parent_id) continue;
    out.set(String(r.account_id), {
      id: String(r.id), body: String(r.body), status: String(r.status) as VarianceNote['status'],
      authorUserId: String(r.author_user_id), authorName: (r.author_name as string | null) ?? null,
      reviewedBy: (r.reviewed_by as string | null) ?? null, reviewNote: (r.review_note as string | null) ?? null, createdAt: String(r.created_at),
    });
  }
  return out;
}

export async function getDepartmentView(ctx: BudgetCtx, q: DepartmentViewQuery): Promise<DepartmentViewResponse> {
  if (!canSeeDepartment(ctx.access, q.departmentId)) throw new BudgetError('SCOPE', 'That department’s budget isn’t yours to see.');
  const months = windowMonths(q.fiscalYear, q.month, q.window);
  const pyMonths = priorYearMonths(months);
  const fyMonths = MONTHS12.map((m) => monthKey(q.fiscalYear, m));
  const pyFyMonths = priorYearMonths(fyMonths);
  const [{ budget, forecast }, { byId }, depts, closed] = await Promise.all([
    pickVersion(ctx, q),
    loadAccounts(ctx.reader, ctx.orgId),
    loadDepartments(ctx.reader, q.locationId, ctx.orgId),
    closedThrough(ctx, q.locationId, q.fiscalYear),
  ]);
  const department = q.departmentId ? depts.find((d) => d.id === q.departmentId) ?? { id: q.departmentId, name: 'Department', code: '', locationId: null } : null;
  const earliest = [pyMonths[0], pyFyMonths[0]].sort()[0];
  const latest = [months[months.length - 1], fyMonths[11]].sort().reverse()[0];
  const [actual, bud, notes] = await Promise.all([
    actualMap(ctx, q, earliest, latest, byId),
    budgetMap(ctx, budget, q, [...months, ...fyMonths]),
    explanations(ctx, q),
  ]);
  const bva = departmentBva({
    accounts: byId,
    actual,
    budget: bud,
    months,
    pyMonths,
    materialityCents: budget?.materialityCents ?? 500_000,
    materialityBps: budget?.materialityBps ?? 1000,
    explanations: notes,
  });

  // (a) last year → budget, full fiscal year, by driver.
  const drivers = budget ? (await loadDrivers(ctx.reader, budget.id)).filter((d) => (d.departmentId ?? null) === q.departmentId) : [];
  const driverOf = new Map(drivers.map((d) => [d.accountId, d]));
  const sumMonths = (map: Map<string, number>, id: string, ms: readonly MonthKey[]) => ms.reduce((t, m) => t + (map.get(cellKey(id, m)) ?? 0), 0);
  const ids = new Set<string>();
  for (const k of [...actual.keys(), ...bud.keys()]) ids.add(k.slice(0, k.indexOf('|')));
  const pyRows: PyBudgetRow[] = [];
  for (const id of ids) {
    const a = byId.get(id);
    if (!a) continue;
    const nature = a.type === 'REVENUE' || (a.type === 'OTHER' && a.subType === 'OTHER_INCOME') ? 'income' : ['COGS', 'OPEX', 'OTHER'].includes(a.type) ? 'expense' : null;
    if (!nature) continue;
    const pyCents = sumMonths(actual, id, pyFyMonths);
    const budgetCents = sumMonths(bud, id, fyMonths);
    if (pyCents === 0 && budgetCents === 0) continue;
    const d = driverOf.get(id);
    pyRows.push({ accountId: id, label: `${a.number} ${a.name}`, nature, pyCents, budgetCents, method: d?.method ?? null, bridgeDriver: d?.bridgeDriver ?? 'AUTO', isPayroll: isPayrollAccount(a.name, a.groupName) });
  }
  const pyToBudget = pyToBudgetBridge(pyRows, bva.totals.measure);

  // (b) budget → actual for the window, by account group.
  const budgetToActual = groupBridge(
    `Budget → actual · ${windowLabel(q.fiscalYear, q.month, q.window)}`,
    { start: 'Budget', end: 'Actual' },
    bva.lines.map((l) => ({ accountId: l.accountId, label: `${l.accountNumber} ${l.accountName}`, groupName: l.groupName, accountType: l.accountType, nature: l.nature, baseCents: l.budgetCents, compareCents: l.actualCents })),
    { measure: bva.totals.measure },
  );

  // (c) budget → latest forecast, full fiscal year.
  let forecastLabel: string;
  let fc = new Map<string, number>();
  if (forecast) {
    forecastLabel = `${forecast.label}${forecast.status === 'APPROVED' || forecast.status === 'LOCKED' ? '' : ' (draft)'}`;
    for (const l of await loadLines(ctx.reader, forecast.id, q.departmentId)) {
      if (l.periodNumber > 12) continue;
      const k = cellKey(l.accountId, monthKey(q.fiscalYear, l.periodNumber));
      fc.set(k, (fc.get(k) ?? 0) + l.amountCents);
    }
  } else {
    forecastLabel = closed > 0 ? `Latest estimate (actuals through ${shortMonth(q.fiscalYear, closed)}, budget after)` : 'Latest estimate (no closed months yet — equals the budget)';
    fc = new Map();
    for (const id of ids) {
      const b = fyMonths.map((m) => bud.get(cellKey(id, m)) ?? 0);
      const a = fyMonths.map((m) => actual.get(cellKey(id, m)) ?? 0);
      latestEstimate(b, a, closed).forEach((v, i) => v !== 0 && fc.set(cellKey(id, fyMonths[i]), v));
    }
  }
  const fcRows = [...ids].flatMap((id) => {
    const a = byId.get(id);
    if (!a) return [];
    const nature: 'income' | 'expense' | null = a.type === 'REVENUE' || (a.type === 'OTHER' && a.subType === 'OTHER_INCOME') ? 'income' : ['COGS', 'OPEX', 'OTHER'].includes(a.type) ? 'expense' : null;
    if (!nature) return [];
    return [{ accountId: id, label: `${a.number} ${a.name}`, groupName: a.groupName, accountType: a.type, nature, baseCents: sumMonths(bud, id, fyMonths), compareCents: sumMonths(fc, id, fyMonths) }];
  });
  for (const k of fc.keys()) {
    const id = k.slice(0, k.indexOf('|'));
    if (!ids.has(id) && byId.has(id)) {
      const a = byId.get(id)!;
      const nature: 'income' | 'expense' = a.type === 'REVENUE' || (a.type === 'OTHER' && a.subType === 'OTHER_INCOME') ? 'income' : 'expense';
      fcRows.push({ accountId: id, label: `${a.number} ${a.name}`, groupName: a.groupName, accountType: a.type, nature, baseCents: 0, compareCents: sumMonths(fc, id, fyMonths) });
      ids.add(id);
    }
  }
  const budgetToForecast = groupBridge(`Budget → ${forecast ? 'forecast' : 'latest estimate'} · FY${q.fiscalYear}`, { start: 'Budget', end: forecast ? 'Forecast' : 'Latest estimate' }, fcRows, { measure: bva.totals.measure });

  return {
    version: budget,
    department,
    window: q.window,
    period: {
      fiscalYear: q.fiscalYear,
      month: q.month,
      label: windowLabel(q.fiscalYear, q.month, q.window),
      from: isoStart(months[0]),
      to: isoEnd(months[months.length - 1]),
      pyFrom: isoStart(pyMonths[0]),
      pyTo: isoEnd(pyMonths[pyMonths.length - 1]),
    },
    lines: bva.lines,
    sections: bva.sections,
    totals: bva.totals,
    materialCount: bva.materialCount,
    bridges: { pyToBudget, budgetToActual, budgetToForecast },
    forecastLabel,
    closedThrough: closed > 0 ? shortMonth(q.fiscalYear, closed) : null,
    access: ctx.access,
  };
}

function shortMonth(y: number, m: number): string {
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export async function getDrill(
  ctx: BudgetCtx,
  q: DepartmentViewQuery & { accountId: string; which: 'actual' | 'py' },
): Promise<{ lines: GlDrillLine[]; totalCents: number; from: string; to: string }> {
  if (!canSeeDepartment(ctx.access, q.departmentId)) throw new BudgetError('SCOPE', 'That department’s budget isn’t yours to see.');
  const months = windowMonths(q.fiscalYear, q.month, q.window);
  const ms = q.which === 'py' ? priorYearMonths(months) : months;
  const { byId } = await loadAccounts(ctx.reader, ctx.orgId);
  const from = isoStart(ms[0]);
  const to = isoEnd(ms[ms.length - 1]);
  const lines = await drillLines(ctx.reader, { locationId: q.locationId, from, to, departmentIds: q.departmentId ? [q.departmentId] : null, accountId: q.accountId }, byId.get(q.accountId));
  return { lines, totalCents: lines.reduce((t, l) => t + l.naturalCents, 0), from, to };
}

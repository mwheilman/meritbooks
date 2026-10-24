/**
 * Budget versions (Wave 4B, AC-B9 / AC-B10 / AC-B11 / AC-B12). Create (blank, copy, last year's
 * actuals + x%, last year's budget + x%, reforecast = actuals through the closed month + budget for
 * the rest), move through the lifecycle (submit → return / approve → lock; delete a draft), and
 * compare two versions.
 *
 * Approval runs in ONE database call (public.budget_approve_version) so superseding the old
 * current version and publishing the new one can't be half-done.
 */
import { growSeries, latestEstimate, MONTHS } from '../generators';
import { BudgetError, checkVersionAction, defaultLabel, nextVersionNumber, type VersionAction } from '../lifecycle';
import { canSeeDepartment } from '../scope';
import type { BudgetVersion, CompareResponse, CompareRow, VersionBasis, VersionKind } from '../types';
import { loadActualCells, naturalOf } from './actuals';
import { closedPeriods } from './lines';
import { listVersions, loadAccounts, loadDepartments, loadDrivers, loadLines, loadOwners, loadPlans, loadVersion, logEvent, must, toVersion, type BudgetCtx } from './data';

export type CreateStart = 'BLANK' | 'COPY' | 'PRIOR_YEAR_ACTUALS' | 'PRIOR_BUDGET' | 'REFORECAST';

export interface CreateVersionInput {
  locationId: string;
  fiscalYear: number;
  kind: VersionKind;
  start: CreateStart;
  label?: string | null;
  sourceVersionId?: string | null;
  growthBps?: number | null;
  dueDate?: string | null;
  /** Reforecast: closed periods (0..12) whose actuals replace the budget. */
  closedThrough?: number | null;
  notes?: string | null;
}

function requireFinance(ctx: BudgetCtx): void {
  if (ctx.access.scope !== 'ALL' || !ctx.access.canEdit) {
    throw new BudgetError('SCOPE', 'Only finance can create or move budget versions.');
  }
}

type Cell = { accountId: string; departmentId: string | null; periodNumber: number; amountCents: number };

export async function createVersion(ctx: BudgetCtx, i: CreateVersionInput): Promise<BudgetVersion> {
  requireFinance(ctx);
  if (!Number.isInteger(i.fiscalYear) || i.fiscalYear < 2000 || i.fiscalYear > 2100) throw new BudgetError('VALIDATION', 'Pick a fiscal year.');
  const existing = await listVersions(ctx.reader, i.locationId, i.fiscalYear);
  const current = existing.find((v) => v.isCurrent) ?? null;
  if (i.kind === 'BUDGET' && current?.status === 'LOCKED') {
    throw new BudgetError('LOCKED', `The FY${i.fiscalYear} budget is locked — start a reforecast instead.`);
  }
  if (i.start === 'REFORECAST' && i.kind !== 'REFORECAST') throw new BudgetError('VALIDATION', 'A reforecast start makes a reforecast version.');
  const growth = Math.round(i.growthBps ?? 0);
  const n = nextVersionNumber(existing, i.kind);
  const basis: VersionBasis = ({ BLANK: 'BLANK', COPY: 'COPY', PRIOR_YEAR_ACTUALS: 'PRIOR_YEAR_ACTUALS', PRIOR_BUDGET: 'PRIOR_BUDGET', REFORECAST: 'REFORECAST' } as const)[i.start];

  // Seed cells first (fail before writing anything).
  let cells: Cell[] = [];
  let source: 'COPY' | 'PRIOR_YEAR' | 'REFORECAST' = 'COPY';
  let parent: string | null = null;
  const { byId } = await loadAccounts(ctx.reader, ctx.orgId);
  if (i.start === 'COPY') {
    const src = i.sourceVersionId ? await loadVersion(ctx.reader, i.sourceVersionId) : current;
    if (!src) throw new BudgetError('VALIDATION', 'There is no version to copy.');
    if (src.locationId !== i.locationId) throw new BudgetError('VALIDATION', 'Copy a version of the same company.');
    parent = src.id;
    const lines = await loadLines(ctx.reader, src.id);
    cells = lines.map((l) => ({ accountId: l.accountId, departmentId: l.departmentId, periodNumber: l.periodNumber, amountCents: l.amountCents }));
    if (growth) cells = growCells(cells, growth);
  } else if (i.start === 'PRIOR_YEAR_ACTUALS') {
    const py = i.fiscalYear - 1;
    const actual = await loadActualCells(ctx.reader, { locationId: i.locationId, from: `${py}-01-01`, to: `${py}-12-31` });
    cells = actual
      .map((c) => ({ accountId: c.accountId, departmentId: c.departmentId, periodNumber: Number(c.month.slice(5, 7)), amountCents: naturalOf(byId.get(c.accountId), c.netDebitCents) }))
      .filter((c) => c.amountCents !== 0 && byId.has(c.accountId));
    cells = growCells(cells, growth);
    source = 'PRIOR_YEAR';
  } else if (i.start === 'PRIOR_BUDGET') {
    const prior = (await listVersions(ctx.reader, i.locationId, i.fiscalYear - 1)).find((v) => v.isCurrent);
    if (!prior) throw new BudgetError('VALIDATION', `There is no FY${i.fiscalYear - 1} budget to start from.`);
    parent = prior.id;
    const lines = await loadLines(ctx.reader, prior.id);
    cells = growCells(lines.map((l) => ({ accountId: l.accountId, departmentId: l.departmentId, periodNumber: l.periodNumber, amountCents: l.amountCents })), growth);
  } else if (i.start === 'REFORECAST') {
    if (!current) throw new BudgetError('VALIDATION', `There is no FY${i.fiscalYear} budget to reforecast.`);
    parent = current.id;
    const k = Math.max(0, Math.min(12, Math.round(i.closedThrough ?? 0)));
    const lines = await loadLines(ctx.reader, current.id);
    const actual = k > 0
      ? await loadActualCells(ctx.reader, { locationId: i.locationId, from: `${i.fiscalYear}-01-01`, to: `${i.fiscalYear}-${String(k).padStart(2, '0')}-${String(new Date(Date.UTC(i.fiscalYear, k, 0)).getUTCDate()).padStart(2, '0')}` })
      : [];
    const rows = new Map<string, { accountId: string; departmentId: string | null; budget: number[]; actual: number[] }>();
    const get = (accountId: string, departmentId: string | null) => {
      const key = `${accountId}|${departmentId ?? ''}`;
      let r = rows.get(key);
      if (!r) rows.set(key, (r = { accountId, departmentId, budget: Array(MONTHS).fill(0), actual: Array(MONTHS).fill(0) }));
      return r;
    };
    for (const l of lines) if (l.periodNumber <= 12) get(l.accountId, l.departmentId).budget[l.periodNumber - 1] += l.amountCents;
    for (const c of actual) {
      if (!byId.has(c.accountId)) continue;
      get(c.accountId, c.departmentId).actual[Number(c.month.slice(5, 7)) - 1] += naturalOf(byId.get(c.accountId), c.netDebitCents);
    }
    for (const r of rows.values()) {
      latestEstimate(r.budget, r.actual, k).forEach((v, m) => {
        if (v !== 0) cells.push({ accountId: r.accountId, departmentId: r.departmentId, periodNumber: m + 1, amountCents: v });
      });
    }
    source = 'REFORECAST';
  }

  // Closed months are history: a new BUDGET version carries the PUBLISHED budget for them (so
  // approving it never moves BvA for a closed month), whatever its start generated. A reforecast
  // keeps its actuals there (it is never published). The 189 line trigger is the guarantor.
  if (i.kind === 'BUDGET' && current) {
    const closed = new Set(await closedPeriods(ctx, i.locationId, i.fiscalYear));
    if (closed.size > 0) {
      const published = (await loadLines(ctx.reader, current.id)).filter((l) => closed.has(l.periodNumber));
      cells = [
        ...cells.filter((c) => !closed.has(c.periodNumber)),
        ...published.map((l) => ({ accountId: l.accountId, departmentId: l.departmentId, periodNumber: l.periodNumber, amountCents: l.amountCents })),
      ];
    }
  }

  const label = (i.label ?? '').trim() || defaultLabel(i.fiscalYear, i.kind, n);
  const ins = must(
    await ctx.writer.from('budget_plan_versions').insert({
      org_id: ctx.orgId,
      location_id: i.locationId,
      fiscal_year: i.fiscalYear,
      kind: i.kind,
      version_number: n,
      label: label.slice(0, 120),
      status: 'DRAFT',
      // A new version is NEVER published: only approval (public.budget_approve_version) makes a
      // version current, so every published budget passed maker → checker (mig 189 CHECK).
      is_current: false,
      parent_version_id: parent,
      basis,
      growth_bps: growth || null,
      due_date: i.dueDate ?? null,
      notes: i.notes ?? null,
      created_by: ctx.userId,
    }).select('*'),
    'create version',
  ) as Array<Record<string, unknown>>;
  const version = toVersion(ins[0]);

  // Lines
  const rows = cells.map((c) => ({
    org_id: ctx.orgId, version_id: version.id, location_id: version.locationId, fiscal_year: version.fiscalYear,
    account_id: c.accountId, department_id: c.departmentId, period_number: c.periodNumber, amount_cents: c.amountCents,
    source, updated_by: ctx.userId,
  }));
  const merged = mergeCells(rows);
  for (let k = 0; k < merged.length; k += 500) must(await ctx.writer.from('budget_version_lines').insert(merged.slice(k, k + 500)), 'seed lines');

  // Drivers carry over on a copy.
  if (i.start === 'COPY' && parent) {
    const drivers = await loadDrivers(ctx.reader, parent);
    if (drivers.length) {
      must(await ctx.writer.from('budget_line_drivers').insert(drivers.map((d) => ({
        org_id: ctx.orgId, version_id: version.id, location_id: version.locationId, account_id: d.accountId, department_id: d.departmentId,
        method: d.method, params: d.params, annual_cents: d.annualCents, bridge_driver: d.bridgeDriver, note: d.note, updated_by: ctx.userId,
      }))), 'copy drivers');
    }
  }

  // Department plans: every active department of the company, owners carried, templates carried on a copy.
  const [depts, owners, srcPlans] = await Promise.all([
    loadDepartments(ctx.reader, i.locationId, ctx.orgId),
    loadOwners(ctx.reader, ctx.orgId),
    parent && i.start === 'COPY' ? loadPlans(ctx.reader, parent) : Promise.resolve([]),
  ]);
  const ownerOf = new Map(owners.map((o) => [o.departmentId, o]));
  const srcOf = new Map(srcPlans.map((p) => [p.departmentId, p]));
  const withLines = new Set(merged.map((r) => r.department_id).filter((x): x is string => !!x));
  const planRows = depts.map((d) => {
    const o = ownerOf.get(d.id);
    const s = srcOf.get(d.id);
    return {
      org_id: ctx.orgId, version_id: version.id, location_id: version.locationId, department_id: d.id,
      owner_user_id: o?.ownerUserId ?? s?.ownerUserId ?? null, owner_name: o?.ownerName ?? s?.ownerName ?? null,
      template_key: s?.templateKey ?? null, template_version: s?.templateVersion ?? null,
      status: withLines.has(d.id) ? 'DRAFT' : 'NOT_STARTED',
      due_date: i.dueDate ?? s?.dueDate ?? null,
      target_revenue_cents: s?.targetRevenueCents ?? null, target_expense_cents: s?.targetExpenseCents ?? null,
    };
  });
  // Lines may carry departments that are inactive now — they still need a plan row.
  for (const deptId of withLines) {
    if (!planRows.some((p) => p.department_id === deptId)) {
      planRows.push({ org_id: ctx.orgId, version_id: version.id, location_id: version.locationId, department_id: deptId, owner_user_id: ownerOf.get(deptId)?.ownerUserId ?? null, owner_name: ownerOf.get(deptId)?.ownerName ?? null, template_key: null, template_version: null, status: 'DRAFT', due_date: i.dueDate ?? null, target_revenue_cents: null, target_expense_cents: null });
    }
  }
  if (planRows.length) must(await ctx.writer.from('budget_department_plans').insert(planRows), 'department plans');

  await logEvent(ctx, { locationId: version.locationId, versionId: version.id, kind: 'VERSION_CREATED', to: 'DRAFT', meta: { start: i.start, growth_bps: growth, lines: merged.length, parent_version_id: parent } });
  return version;
}

function growCells(cells: Cell[], growthBps: number): Cell[] {
  if (!growthBps) return cells;
  const rows = new Map<string, Cell[]>();
  for (const c of cells) {
    const k = `${c.accountId}|${c.departmentId ?? ''}`;
    rows.set(k, [...(rows.get(k) ?? []), c]);
  }
  const out: Cell[] = [];
  for (const rs of rows.values()) {
    const months = Array(MONTHS).fill(0);
    let adj = 0;
    for (const c of rs) {
      if (c.periodNumber === 13) adj += c.amountCents;
      else months[c.periodNumber - 1] += c.amountCents;
    }
    growSeries(months, growthBps).forEach((v, m) => v !== 0 && out.push({ accountId: rs[0].accountId, departmentId: rs[0].departmentId, periodNumber: m + 1, amountCents: v }));
    if (adj) out.push({ accountId: rs[0].accountId, departmentId: rs[0].departmentId, periodNumber: 13, amountCents: adj });
  }
  return out;
}

function mergeCells<T extends { account_id: string; department_id: string | null; period_number: number; amount_cents: number }>(rows: T[]): T[] {
  const m = new Map<string, T>();
  for (const r of rows) {
    const k = `${r.account_id}|${r.department_id ?? ''}|${r.period_number}`;
    const cur = m.get(k);
    if (cur) cur.amount_cents += r.amount_cents;
    else m.set(k, { ...r });
  }
  return [...m.values()].filter((r) => r.amount_cents !== 0);
}

export async function transitionVersion(
  ctx: BudgetCtx,
  versionId: string,
  action: VersionAction,
  opts: { note?: string | null; actorCoreUserId?: string | null } = {},
): Promise<BudgetVersion | null> {
  const v = await loadVersion(ctx.reader, versionId);
  if (action === 'approve' || action === 'lock') {
    // Approving publishes the budget of record; locking freezes it — both are the approver's.
    if (!ctx.access.canApprove || ctx.access.scope !== 'ALL') throw new BudgetError('SCOPE', action === 'lock' ? 'You can’t lock budgets.' : 'You can’t approve budgets.');
  } else if (action === 'return') {
    if (!(ctx.access.canApprove || (ctx.access.scope === 'ALL' && ctx.access.canEdit))) throw new BudgetError('SCOPE', 'You can’t return this version.');
  } else {
    requireFinance(ctx);
  }
  const plans = await loadPlans(ctx.reader, v.id);
  const versions = await listVersions(ctx.reader, v.locationId, v.fiscalYear);
  const current = versions.find((x) => x.isCurrent && x.id !== v.id) ?? null;
  if (action === 'delete' && v.isCurrent) {
    throw new BudgetError('LOCKED', 'This is the published budget for the year — approve another version before deleting it.');
  }
  const to = checkVersionAction({
    action,
    status: v.status,
    kind: v.kind,
    actor: ctx.userId,
    submittedBy: v.submittedBy,
    createdBy: v.createdBy,
    openPlans: plans.filter((p) => p.status !== 'APPROVED').length,
    currentIsLockedOther: current?.status === 'LOCKED',
    isCurrent: v.isCurrent,
    note: opts.note ?? null,
  });
  const now = new Date().toISOString();
  if (action === 'approve') {
    must(await ctx.writer.rpc('budget_approve_version', { p_version: v.id, p_actor: ctx.userId, p_actor_user_id: opts.actorCoreUserId ?? null }), 'approve version');
  } else if (action === 'submit') {
    must(await ctx.writer.from('budget_plan_versions').update({ status: 'IN_REVIEW', submitted_by: ctx.userId, submitted_at: now, submit_note: opts.note ?? null }).eq('id', v.id), 'submit version');
  } else if (action === 'return') {
    must(await ctx.writer.from('budget_plan_versions').update({ status: 'DRAFT', returned_note: (opts.note ?? '').slice(0, 1000) }).eq('id', v.id), 'return version');
  } else if (action === 'lock') {
    must(await ctx.writer.from('budget_plan_versions').update({ status: 'LOCKED', locked_by: ctx.userId, locked_at: now }).eq('id', v.id), 'lock version');
  } else if (action === 'delete') {
    must(await ctx.writer.from('budget_plan_versions').delete().eq('id', v.id), 'delete version');
  }
  const kind = { submit: 'VERSION_SUBMITTED', return: 'VERSION_RETURNED', approve: 'VERSION_APPROVED', lock: 'VERSION_LOCKED', delete: 'VERSION_DELETED' }[action];
  await logEvent(ctx, { locationId: v.locationId, versionId: action === 'delete' ? null : v.id, kind, from: v.status, to: to ?? 'DELETED', note: opts.note ?? null, meta: action === 'delete' ? { deleted_version_id: v.id, label: v.label } : {} });
  if (action === 'approve' && current && v.kind === 'BUDGET') {
    await logEvent(ctx, { locationId: v.locationId, versionId: current.id, kind: 'VERSION_SUPERSEDED', from: current.status, to: 'SUPERSEDED', meta: { by_version_id: v.id } });
  }
  return action === 'delete' ? null : loadVersion(ctx.reader, v.id);
}

export async function updateVersionSettings(
  ctx: BudgetCtx,
  versionId: string,
  patch: { label?: string; dueDate?: string | null; materialityCents?: number; materialityBps?: number; notes?: string | null },
): Promise<BudgetVersion> {
  requireFinance(ctx);
  const v = await loadVersion(ctx.reader, versionId);
  if (v.status !== 'DRAFT') throw new BudgetError('LOCKED', 'Only a draft version’s settings can change.');
  const row: Record<string, unknown> = {};
  if (patch.label !== undefined) row.label = patch.label.trim().slice(0, 120) || v.label;
  if (patch.dueDate !== undefined) row.due_date = patch.dueDate;
  if (patch.materialityCents !== undefined) row.materiality_cents = Math.max(0, Math.round(patch.materialityCents));
  if (patch.materialityBps !== undefined) row.materiality_bps = Math.max(0, Math.round(patch.materialityBps));
  if (patch.notes !== undefined) row.notes = patch.notes;
  must(await ctx.writer.from('budget_plan_versions').update(row).eq('id', v.id), 'update version');
  return loadVersion(ctx.reader, v.id);
}

/** Annual totals of two versions by account × department, scoped to what the caller may see. */
export async function compareVersions(ctx: BudgetCtx, aId: string, bId: string): Promise<CompareResponse> {
  const [a, b] = await Promise.all([loadVersion(ctx.reader, aId), loadVersion(ctx.reader, bId)]);
  if (a.locationId !== b.locationId) throw new BudgetError('VALIDATION', 'Compare versions of the same company.');
  const [la, lb, { byId }, depts] = await Promise.all([loadLines(ctx.reader, a.id), loadLines(ctx.reader, b.id), loadAccounts(ctx.reader, ctx.orgId), loadDepartments(ctx.reader, a.locationId, ctx.orgId)]);
  const deptName = new Map(depts.map((d) => [d.id, d.name]));
  const rows = new Map<string, CompareRow>();
  const add = (accountId: string, departmentId: string | null, which: 'a' | 'b', cents: number) => {
    if (!canSeeDepartment(ctx.access, departmentId)) return;
    const acct = byId.get(accountId);
    if (!acct) return;
    const k = `${accountId}|${departmentId ?? ''}`;
    let r = rows.get(k);
    if (!r) {
      r = { accountId, accountNumber: acct.number, accountName: acct.name, accountType: acct.type, departmentId, departmentName: departmentId ? deptName.get(departmentId) ?? 'Department' : null, aCents: 0, bCents: 0, changeCents: 0, changePct: null };
      rows.set(k, r);
    }
    if (which === 'a') r.aCents += cents;
    else r.bCents += cents;
  };
  for (const l of la) add(l.accountId, l.departmentId, 'a', l.amountCents);
  for (const l of lb) add(l.accountId, l.departmentId, 'b', l.amountCents);
  const out = [...rows.values()].map((r) => ({ ...r, changeCents: r.bCents - r.aCents, changePct: r.aCents === 0 ? null : (r.bCents - r.aCents) / Math.abs(r.aCents) }));
  out.sort((x, y) => Math.abs(y.changeCents) - Math.abs(x.changeCents) || x.accountNumber.localeCompare(y.accountNumber));
  const income = (r: CompareRow) => r.accountType === 'REVENUE' || (r.accountType === 'OTHER' && byId.get(r.accountId)?.subType === 'OTHER_INCOME');
  const totals = { aRevenueCents: 0, bRevenueCents: 0, aExpenseCents: 0, bExpenseCents: 0 };
  for (const r of out) {
    if (income(r)) { totals.aRevenueCents += r.aCents; totals.bRevenueCents += r.bCents; }
    else { totals.aExpenseCents += r.aCents; totals.bExpenseCents += r.bCents; }
  }
  return { a, b, rows: out, totals };
}

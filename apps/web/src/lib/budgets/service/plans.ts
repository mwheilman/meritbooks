/**
 * Department plans, owners and the submission board (Wave 4B, AC-B17 / AC-B19 / AC-B11).
 *
 * Board: every department of the company in the version — owner, status, due date (overdue
 * flagged), plan revenue / expense, last-year actuals and the change, open comments, gap to target.
 * Transitions: the owner submits; finance returns (with a note) or approves (never the submitter;
 * a non-zero gap to target needs a gap note); an approved / submitted department can be reopened.
 */
import { checkPlanAction, BudgetError, type PlanAction } from '../lifecycle';
import { canEditDepartment, canSeeDepartment } from '../scope';
import type { BoardResponse, BoardRow, DepartmentPlan, PlanStatus } from '../types';
import { loadActualCells, naturalOf } from './actuals';
import { loadAccounts, loadDepartments, loadLines, loadOwners, loadPlans, loadVersion, logEvent, must, toPlan, type BudgetCtx } from './data';
import { assertBudgetRefs } from './refs';

const isIncome = (type: string, subType: string) => type === 'REVENUE' || (type === 'OTHER' && subType === 'OTHER_INCOME');

export async function getBoard(ctx: BudgetCtx, versionId: string, today = new Date()): Promise<BoardResponse> {
  const version = await loadVersion(ctx.reader, versionId);
  const [depts, { byId }, lines, owners, commentRows] = await Promise.all([
    loadDepartments(ctx.reader, version.locationId, ctx.orgId),
    loadAccounts(ctx.reader, ctx.orgId),
    loadLines(ctx.reader, version.id),
    loadOwners(ctx.reader, ctx.orgId),
    ctx.reader.from('budget_comments').select('department_id, status').eq('version_id', version.id)
      .then((r) => (r.data ?? []) as Array<{ department_id: string | null; status: string }>),
  ]);
  const deptName = new Map(depts.map((d) => [d.id, d.name]));
  const plans = await loadPlans(ctx.reader, version.id, deptName);
  const planOf = new Map(plans.map((p) => [p.departmentId, p]));
  const ownerOf = new Map(owners.map((o) => [o.departmentId, o]));
  const py = version.fiscalYear - 1;
  const actual = await loadActualCells(ctx.reader, { locationId: version.locationId, from: `${py}-01-01`, to: `${py}-12-31` });

  type Tot = { rev: number; exp: number; pyRev: number; pyExp: number };
  const tot = new Map<string, Tot>();
  const t = (d: string | null) => {
    const k = d ?? '';
    let x = tot.get(k);
    if (!x) tot.set(k, (x = { rev: 0, exp: 0, pyRev: 0, pyExp: 0 }));
    return x;
  };
  for (const l of lines) {
    const a = byId.get(l.accountId);
    if (!a) continue;
    if (isIncome(a.type, a.subType)) t(l.departmentId).rev += l.amountCents;
    else t(l.departmentId).exp += l.amountCents;
  }
  for (const c of actual) {
    const a = byId.get(c.accountId);
    const v = naturalOf(a, c.netDebitCents);
    if (!a || v === 0) continue;
    if (isIncome(a.type, a.subType)) t(c.departmentId).pyRev += v;
    else t(c.departmentId).pyExp += v;
  }
  const openComments = new Map<string, number>();
  for (const c of commentRows) if (c.status === 'OPEN' && c.department_id) openComments.set(c.department_id, (openComments.get(c.department_id) ?? 0) + 1);

  const ids = new Set<string>([...depts.map((d) => d.id), ...plans.map((p) => p.departmentId)]);
  const todayIso = today.toISOString().slice(0, 10);
  const rows: BoardRow[] = [];
  for (const id of ids) {
    if (!canSeeDepartment(ctx.access, id)) continue;
    const p = planOf.get(id) ?? null;
    const o = ownerOf.get(id);
    const x = tot.get(id) ?? { rev: 0, exp: 0, pyRev: 0, pyExp: 0 };
    const status: PlanStatus = p?.status ?? 'NOT_STARTED';
    const due = p?.dueDate ?? version.dueDate;
    rows.push({
      departmentId: id,
      departmentName: deptName.get(id) ?? p?.departmentName ?? 'Department',
      plan: p,
      ownerUserId: p?.ownerUserId ?? o?.ownerUserId ?? null,
      ownerName: p?.ownerName ?? o?.ownerName ?? null,
      status,
      dueDate: due,
      overdue: !!due && due < todayIso && status !== 'SUBMITTED' && status !== 'APPROVED',
      revenueCents: x.rev,
      expenseCents: x.exp,
      pyRevenueCents: x.pyRev,
      pyExpenseCents: x.pyExp,
      expenseChangePct: x.pyExp === 0 ? null : (x.exp - x.pyExp) / Math.abs(x.pyExp),
      openComments: openComments.get(id) ?? 0,
      expenseGapCents: p?.targetExpenseCents == null ? null : x.exp - p.targetExpenseCents,
      canEdit: canEditDepartment(ctx.access, id),
    });
  }
  rows.sort((a, b) => a.departmentName.localeCompare(b.departmentName));
  const company = tot.get('');
  return {
    version,
    rows,
    companyLevel: ctx.access.scope === 'ALL' && company ? { revenueCents: company.rev, expenseCents: company.exp } : ctx.access.scope === 'ALL' ? { revenueCents: 0, expenseCents: 0 } : null,
    progress: {
      total: rows.length,
      approved: rows.filter((r) => r.status === 'APPROVED').length,
      submitted: rows.filter((r) => r.status === 'SUBMITTED').length,
      overdue: rows.filter((r) => r.overdue).length,
    },
    access: ctx.access,
  };
}

async function planRow(ctx: BudgetCtx, versionId: string, departmentId: string): Promise<DepartmentPlan | null> {
  const rows = must(await ctx.reader.from('budget_department_plans').select('*').eq('version_id', versionId).eq('department_id', departmentId), 'department plan') as Array<Record<string, unknown>>;
  return rows[0] ? toPlan(rows[0]) : null;
}

async function ensurePlan(ctx: BudgetCtx, versionId: string, locationId: string, departmentId: string): Promise<DepartmentPlan> {
  const p = await planRow(ctx, versionId, departmentId);
  if (p) return p;
  const owners = await loadOwners(ctx.reader, ctx.orgId);
  const o = owners.find((x) => x.departmentId === departmentId);
  must(await ctx.writer.from('budget_department_plans').insert({ org_id: ctx.orgId, version_id: versionId, location_id: locationId, department_id: departmentId, owner_user_id: o?.ownerUserId ?? null, owner_name: o?.ownerName ?? null }), 'department plan');
  return (await planRow(ctx, versionId, departmentId))!;
}

export async function transitionPlan(
  ctx: BudgetCtx,
  versionId: string,
  departmentId: string,
  action: PlanAction,
  opts: { note?: string | null; gapNote?: string | null } = {},
): Promise<DepartmentPlan> {
  const version = await loadVersion(ctx.reader, versionId);
  if (!canSeeDepartment(ctx.access, departmentId)) throw new BudgetError('SCOPE', 'That department’s budget isn’t yours to see.');
  if (action === 'submit' && !canEditDepartment(ctx.access, departmentId)) throw new BudgetError('SCOPE', 'You can’t submit this department’s budget.');
  if ((action === 'approve' || action === 'return' || action === 'reopen') && !ctx.access.canApprove && !(ctx.access.scope === 'ALL' && ctx.access.canEdit)) {
    throw new BudgetError('SCOPE', 'Only finance can review department budgets.');
  }
  // Approval needs the approve right itself (fpa.budgets:approve / close_mgmt:manage) — finance
  // edit rights alone review (return / reopen) but never approve.
  if (action === 'approve' && !(ctx.access.canApprove && ctx.access.scope === 'ALL')) throw new BudgetError('SCOPE', 'You can’t approve department budgets.');
  const plan = await ensurePlan(ctx, versionId, version.locationId, departmentId);
  let gap: number | null = null;
  if (action === 'approve' && plan.targetExpenseCents != null) {
    const { byId } = await loadAccounts(ctx.reader, ctx.orgId);
    const exp = (await loadLines(ctx.reader, versionId, departmentId))
      .filter((l) => { const a = byId.get(l.accountId); return a && !isIncome(a.type, a.subType); })
      .reduce((s, l) => s + l.amountCents, 0);
    gap = exp - plan.targetExpenseCents;
  }
  const gapNote = opts.gapNote ?? plan.gapNote;
  const to = checkPlanAction({ action, status: plan.status, versionStatus: version.status, actor: ctx.userId, submittedBy: plan.submittedBy, note: opts.note ?? null, expenseGapCents: gap, gapNote });
  const now = new Date().toISOString();
  const patch: Record<string, unknown> = { status: to };
  if (action === 'submit') Object.assign(patch, { submitted_by: ctx.userId, submitted_at: now, submit_note: opts.note ?? null, approved_by: null, approved_at: null });
  if (action === 'return') Object.assign(patch, { reviewed_by: ctx.userId, reviewed_at: now, review_note: (opts.note ?? '').slice(0, 1000) });
  if (action === 'approve') Object.assign(patch, { approved_by: ctx.userId, approved_at: now, reviewed_by: ctx.userId, reviewed_at: now, gap_note: gapNote ? gapNote.slice(0, 1000) : null, review_note: opts.note ?? plan.reviewNote });
  if (action === 'reopen') Object.assign(patch, { approved_by: null, approved_at: null, review_note: opts.note ?? plan.reviewNote });
  must(await ctx.writer.from('budget_department_plans').update(patch).eq('id', plan.id), 'department plan');
  const kind = { submit: 'PLAN_SUBMITTED', return: 'PLAN_RETURNED', approve: 'PLAN_APPROVED', reopen: 'PLAN_REOPENED' }[action];
  await logEvent(ctx, { locationId: version.locationId, versionId, planId: plan.id, kind, from: plan.status, to, note: opts.note ?? null, meta: { department_id: departmentId, gap_cents: gap } });
  return (await planRow(ctx, versionId, departmentId))!;
}

export async function updatePlan(
  ctx: BudgetCtx,
  versionId: string,
  departmentId: string,
  patch: { dueDate?: string | null; targetRevenueCents?: number | null; targetExpenseCents?: number | null; gapNote?: string | null; templateKey?: string | null; templateVersion?: number | null },
): Promise<DepartmentPlan> {
  const version = await loadVersion(ctx.reader, versionId);
  const finance = ctx.access.scope === 'ALL' && ctx.access.canEdit;
  const ownerEdit = canEditDepartment(ctx.access, departmentId);
  if (!finance && !ownerEdit) throw new BudgetError('SCOPE', 'You can’t change this department’s budget.');
  if (version.status !== 'DRAFT') throw new BudgetError('LOCKED', 'Department budgets can’t change once the version is out of draft.');
  // Targets and due dates are set by finance (top-down); owners choose the template and explain gaps.
  if (!finance && (patch.dueDate !== undefined || patch.targetRevenueCents !== undefined || patch.targetExpenseCents !== undefined)) {
    throw new BudgetError('SCOPE', 'Targets and due dates are set by finance.');
  }
  const plan = await ensurePlan(ctx, versionId, version.locationId, departmentId);
  const row: Record<string, unknown> = {};
  if (patch.dueDate !== undefined) row.due_date = patch.dueDate;
  if (patch.targetRevenueCents !== undefined) row.target_revenue_cents = patch.targetRevenueCents;
  if (patch.targetExpenseCents !== undefined) row.target_expense_cents = patch.targetExpenseCents;
  if (patch.gapNote !== undefined) row.gap_note = patch.gapNote ? patch.gapNote.slice(0, 1000) : null;
  if (patch.templateKey !== undefined) row.template_key = patch.templateKey;
  if (patch.templateVersion !== undefined) row.template_version = patch.templateVersion;
  if (Object.keys(row).length) must(await ctx.writer.from('budget_department_plans').update(row).eq('id', plan.id), 'department plan');
  return (await planRow(ctx, versionId, departmentId))!;
}

/** May the caller assign department owners (and see their emails)? */
export function canAssignOwners(ctx: Pick<BudgetCtx, 'access'>): boolean {
  return ctx.access.scope === 'ALL' && ctx.access.canApprove;
}

/** Assign (or clear) the standing owner of a department; open draft versions pick it up. */
export async function setOwner(
  ctx: BudgetCtx,
  departmentId: string,
  locationId: string,
  owner: { userId: string; name?: string | null; email?: string | null } | null,
): Promise<void> {
  // Owners widen budget visibility (a department owner sees that department), so assigning one is
  // a budget-admin act: fpa.budgets:approve or the legacy close_mgmt:manage cell (canApprove).
  if (!canAssignOwners(ctx)) throw new BudgetError('SCOPE', 'Only a budget admin can assign department owners.');
  await assertBudgetRefs(ctx, { locationId, departmentIds: [departmentId] });
  if (owner) {
    // The owner must be an active member of this org (service read, org-pinned).
    const emp = must(
      await ctx.writer.schema('core').from('employees').select('clerk_user_id, is_active').eq('org_id', ctx.orgId).eq('clerk_user_id', owner.userId).limit(1),
      'owner member',
    ) as Array<{ clerk_user_id: string; is_active: boolean | null }>;
    if (!emp[0] || emp[0].is_active === false) throw new BudgetError('VALIDATION', 'That person is not an active member of this organization.');
  }
  const existing = must(await ctx.writer.from('budget_department_owners').select('id').eq('org_id', ctx.orgId).eq('department_id', departmentId), 'owner') as Array<{ id: string }>;
  if (!owner) {
    if (existing[0]) must(await ctx.writer.from('budget_department_owners').delete().eq('id', existing[0].id), 'owner');
  } else if (existing[0]) {
    must(await ctx.writer.from('budget_department_owners').update({ owner_user_id: owner.userId, owner_name: owner.name ?? null, owner_email: owner.email ?? null, assigned_by: ctx.userId }).eq('id', existing[0].id), 'owner');
  } else {
    must(await ctx.writer.from('budget_department_owners').insert({ org_id: ctx.orgId, location_id: locationId, department_id: departmentId, owner_user_id: owner.userId, owner_name: owner.name ?? null, owner_email: owner.email ?? null, assigned_by: ctx.userId }), 'owner');
  }
  // Carry into every DRAFT version's plan for that department.
  const plans = must(await ctx.reader.from('budget_department_plans').select('id, version_id').eq('department_id', departmentId), 'plans') as Array<{ id: string; version_id: string }>;
  for (const p of plans) {
    const v = await loadVersion(ctx.reader, p.version_id);
    if (v.status !== 'DRAFT') continue;
    must(await ctx.writer.from('budget_department_plans').update({ owner_user_id: owner?.userId ?? null, owner_name: owner?.name ?? null }).eq('id', p.id), 'plan owner');
  }
  await logEvent(ctx, { locationId, kind: 'OWNER_ASSIGNED', meta: { department_id: departmentId, owner_user_id: owner?.userId ?? null, owner_name: owner?.name ?? null } });
}

/** People who can own a department: active members of the org (Clerk id + name). */
export async function ownerCandidates(ctx: BudgetCtx): Promise<Array<{ userId: string; name: string; email: string | null; role: string | null }>> {
  if (!canAssignOwners(ctx)) return []; // the member directory (with emails) is for budget admins only
  const rows = must(
    await ctx.reader.schema('core').from('employees').select('clerk_user_id, first_name, last_name, email, role, is_active').eq('org_id', ctx.orgId),
    'employees',
  ) as Array<Record<string, unknown>>;
  return rows
    .filter((r) => r.is_active !== false && r.clerk_user_id)
    .map((r) => ({
      userId: String(r.clerk_user_id),
      name: [r.first_name, r.last_name].filter(Boolean).join(' ') || String(r.email ?? r.clerk_user_id),
      email: (r.email as string | null) ?? null,
      role: (r.role as string | null) ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

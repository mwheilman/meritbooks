/**
 * Route plumbing for the budget API (Wave 4B): the per-request BudgetCtx (RLS reader, service
 * writer handed out only after the org pin + client-scope assert, the caller's budget access) and
 * one error → response mapping. Every /api/budgets/* route uses these.
 */
import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { assertWriteScope, isWriteScopeError, serviceWriter } from '@/lib/db/scoped-writer';
import { resolveBudgetAccess } from './access';
import { decideReadDepartments } from './scope';
import { BudgetError, budgetErrorFromDb, isBudgetError } from './lifecycle';
import { listVersions, loadVersion, type BudgetCtx } from './service/data';
import { createVersion } from './service/versions';
import type { BudgetAccessSummary, BudgetVersion } from './types';

export interface RouteCtx {
  userId: string;
  orgId: string | null;
  supabase: SupabaseClient;
}

export function noOrg(): NextResponse {
  return NextResponse.json({ error: 'No organization on session', code: 'NO_ORG' }, { status: 403 });
}

async function displayName(orgId: string, userId: string): Promise<string | null> {
  try {
    const { data } = await serviceWriter().schema('core').from('employees').select('first_name, last_name, email')
      .eq('org_id', orgId).eq('clerk_user_id', userId).limit(1);
    const r = ((data ?? [])[0] ?? null) as { first_name?: string; last_name?: string; email?: string } | null;
    if (!r) return null;
    return [r.first_name, r.last_name].filter(Boolean).join(' ') || r.email || null;
  } catch {
    return null;
  }
}

/**
 * Build the budget context for a company. Fails closed: no org → 403; a company outside the org or
 * the caller's client scope → 403; no budget access at all → 403.
 */
export async function budgetCtx(ctx: RouteCtx, locationId: string, opts: { requireView?: boolean } = {}): Promise<BudgetCtx | NextResponse> {
  if (!ctx.orgId) return noOrg();
  try {
    await assertWriteScope(ctx.supabase, ctx.orgId, [locationId]);
  } catch (e) {
    return budgetError(e, 'budget scope');
  }
  const access = await resolveBudgetAccess({ userId: ctx.userId, orgId: ctx.orgId, supabase: ctx.supabase }, locationId);
  if ((opts.requireView ?? true) && !access.canView) {
    return NextResponse.json({ error: 'You don’t have access to budgets for this company.', code: 'FORBIDDEN' }, { status: 403 });
  }
  return {
    orgId: ctx.orgId,
    userId: ctx.userId,
    userName: await displayName(ctx.orgId, ctx.userId),
    reader: ctx.supabase,
    writer: serviceWriter(),
    access,
  };
}

/** The company a version belongs to (RLS read), for routes addressed by version id. */
export async function locationOfVersion(supabase: SupabaseClient, versionId: string): Promise<string | NextResponse> {
  try {
    return (await loadVersion(supabase, versionId)).locationId;
  } catch (e) {
    return budgetError(e, 'version');
  }
}

export function budgetError(e: unknown, where: string): NextResponse {
  if (isBudgetError(e)) return NextResponse.json({ error: e.message, code: `BUDGET_${e.code}` }, { status: e.status });
  if (isWriteScopeError(e)) return NextResponse.json({ error: e.message, code: 'FORBIDDEN' }, { status: 403 });
  const mapped = budgetErrorFromDb(e instanceof Error ? e.message : String(e));
  if (mapped) return NextResponse.json({ error: mapped.message, code: `BUDGET_${mapped.code}` }, { status: mapped.status });
  console.error(`[budgets] ${where}:`, e);
  return NextResponse.json({ error: e instanceof Error ? e.message : 'Internal server error', code: 'INTERNAL_ERROR' }, { status: 500 });
}

/** The company-year's newest DRAFT BUDGET version, or null (never creates one). */
export async function findDraftTarget(ctx: Pick<BudgetCtx, 'reader'>, locationId: string, fiscalYear: number): Promise<BudgetVersion | null> {
  // listVersions orders BUDGET first, newest version number first.
  return (await listVersions(ctx.reader, locationId, fiscalYear)).find((x) => x.kind === 'BUDGET' && x.status === 'DRAFT') ?? null;
}

/**
 * The draft version a legacy write (the classic entry grid, the driver builder, an import without a
 * version) lands in: the given version (must be a DRAFT of that company-year), else the
 * company-year's newest BUDGET draft, else a NEW draft — a copy of the published budget when there
 * is one (so approving it never drops the rows the write didn't touch), else blank. A draft is
 * never the published budget: it publishes only when approved (mig 189). A non-draft target is
 * refused with "create a new version" (AC-B18).
 */
export async function ensureDraftTarget(ctx: BudgetCtx, locationId: string, fiscalYear: number, versionId?: string | null): Promise<BudgetVersion> {
  let v: BudgetVersion | null = null;
  if (versionId) {
    v = await loadVersion(ctx.reader, versionId);
    if (v.locationId !== locationId || v.fiscalYear !== fiscalYear) throw new BudgetError('VALIDATION', 'That version is for a different company or year.');
  } else {
    v = await findDraftTarget(ctx, locationId, fiscalYear);
    if (!v) {
      const current = (await listVersions(ctx.reader, locationId, fiscalYear)).find((x) => x.isCurrent) ?? null;
      v = await createVersion(ctx, { locationId, fiscalYear, kind: 'BUDGET', start: current ? 'COPY' : 'BLANK', sourceVersionId: current?.id ?? null });
    }
  }
  if (v.status !== 'DRAFT') {
    throw new BudgetError('LOCKED', `${v.label} is ${v.status === 'IN_REVIEW' ? 'in review' : v.status.toLowerCase()} — create a new version (Budgets → Plan → New version) to change it.`);
  }
  return v;
}

/**
 * What a budget READ may return (security review H6) — the legacy report-style routes
 * (/api/budgets, vs-actual, reforecast, scenarios, drivers) over public.budgets / GL / the decision
 * log, which carry no department-scope RLS of their own.
 *
 *   locationIds   the companies asked for (each passed budgetCtx: org pin + client scope + budget
 *                 view), or [] = every company the caller's RLS shows (consolidated), authorized
 *                 at the org level.
 *   departmentIds null = every department and the company-level lines (finance / approvers);
 *                 else only these (a department owner) — company-level lines are hidden.
 */
export interface BudgetReadScope {
  orgId: string;
  locationIds: string[];
  departmentIds: string[] | null;
  access: BudgetAccessSummary[];
}

export async function budgetReadScope(
  ctx: RouteCtx,
  locationIds: readonly string[],
  departmentId: string | null,
): Promise<BudgetReadScope | NextResponse> {
  if (!ctx.orgId) return noOrg();
  const ids = Array.from(new Set(locationIds.filter(Boolean)));
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (ids.some((x) => !uuid.test(x)) || (departmentId !== null && !uuid.test(departmentId))) {
    return NextResponse.json({ error: 'Invalid company or department id.', code: 'VALIDATION_ERROR' }, { status: 422 });
  }
  const access: BudgetAccessSummary[] = [];
  if (ids.length === 0) {
    const a = await resolveBudgetAccess({ userId: ctx.userId, orgId: ctx.orgId, supabase: ctx.supabase }, null);
    if (!a.canView) return forbidden();
    access.push(a);
  } else {
    for (const id of ids) {
      const b = await budgetCtx(ctx, id);
      if (b instanceof NextResponse) return b;
      access.push(b.access);
    }
  }
  const d = decideReadDepartments(access, departmentId);
  if (d === 'FORBIDDEN') return forbidden();
  if (d === 'SCOPE') return NextResponse.json({ error: 'That department’s budget isn’t yours to see.', code: 'BUDGET_SCOPE' }, { status: 403 });
  return { orgId: ctx.orgId, locationIds: ids, departmentIds: d.departmentIds, access };
}

function forbidden(): NextResponse {
  return NextResponse.json({ error: 'You don’t have access to budgets.', code: 'FORBIDDEN' }, { status: 403 });
}

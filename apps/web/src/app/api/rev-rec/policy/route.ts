export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiHandler, apiQueryHandler, type ApiContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { assertWriteScope, isWriteScopeError, scopedWriter } from '@/lib/db/scoped-writer';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { hasModule } from '@/lib/services/entitlements';
import { resolveRevRecMethod, type RevRecMethod } from '@/lib/services/rev-rec';
import {
  METHOD_COPY,
  POSTING_MODES,
  RETAINAGE_PRESENTATIONS,
  REV_REC_METHODS,
  RUN_CADENCES,
  resolveJobPolicy,
  sourceLabel,
  type SwitchOverride,
} from '@/lib/rev-rec/policy';
import { loadCompanyPolicy, WIP_JOB_STATUSES } from '@/lib/rev-rec/wip-run-service';

/**
 * /api/rev-rec/policy — the company's revenue-recognition election (FPB-rev-rec-wip §3).
 *
 *   GET  ?location_id   the policy card: methods (plain English), the company policy, job-type
 *                       rules and every WIP job with its resolved switches + where each came from.
 *   POST                one of: the company policy (+ default method), a job-type rule, a job
 *                       override. settings_acct:edit — it is an accounting policy that drives
 *                       what the month-end run books.
 *
 * Reads are RLS-scoped. Writes go to SELECT-only tables (migration 179 / 172) through the
 * service role after the permission check, org pinned, the company asserted in the caller's
 * client scope. core.locations / core.jobs columns are service-role-write (M4, 167).
 */

const METHODS = REV_REC_METHODS as unknown as [RevRecMethod, ...RevRecMethod[]];

const getSchema = z.object({ location_id: z.string().uuid() });

export const GET = apiQueryHandler(getSchema, async (q, ctx: ApiContext) => {
  if (!ctx.orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });
  const guard = await requirePermission(ctx.userId, 'journal_entries', 'view');
  if (!guard.ok) return guard.response;
  const db = ctx.supabase;
  const orgId = ctx.orgId;

  const [{ policy, exists }, locRes, mapRes, revTypeRes, jobsRes, overridesRes, projectsEntitled] = await Promise.all([
    loadCompanyPolicy(db, orgId, q.location_id),
    db.schema('core').from('locations').select('id, name, short_code, rev_rec_method').eq('id', q.location_id).maybeSingle(),
    db.from('rev_rec_method_map').select('id, job_type, method, accrue_underbillings, defer_overbillings').eq('org_id', orgId).eq('location_id', q.location_id).order('job_type'),
    db.from('revenue_type_methods').select('revenue_account_id, method').eq('org_id', orgId).eq('location_id', q.location_id),
    db.schema('core').from('jobs')
      .select('id, job_number, name, job_type, archetype, status, rev_rec_method_override, revenue_account_id, contract_amount_cents')
      .eq('org_id', orgId).eq('location_id', q.location_id).in('status', [...WIP_JOB_STATUSES]).order('job_number').limit(500),
    db.from('rev_rec_job_overrides').select('job_id, accrue_underbillings, defer_overbillings, exclude_from_wip, note').eq('org_id', orgId).eq('location_id', q.location_id),
    hasModule(db, orgId, 'projects'),
  ]);
  const loc = locRes.data as { id: string; name: string; short_code: string; rev_rec_method: RevRecMethod | null } | null;
  if (!loc) return NextResponse.json({ error: 'Company not found' }, { status: 404 });
  const companyDefault: RevRecMethod = loc.rev_rec_method ?? 'PCT_COSTS_INCURRED';

  type MapRow = { id: string; job_type: string; method: RevRecMethod; accrue_underbillings: boolean | null; defer_overbillings: boolean | null };
  const maps = (mapRes.data ?? []) as MapRow[];
  const typeMethod = new Map(maps.map((m) => [m.job_type, m.method]));
  const typeSwitch = new Map<string, SwitchOverride>(maps.map((m) => [m.job_type, { accrueUnderbillings: m.accrue_underbillings, deferOverbillings: m.defer_overbillings }]));
  const revType = new Map(((revTypeRes.data ?? []) as { revenue_account_id: string; method: RevRecMethod }[]).map((r) => [r.revenue_account_id, r.method]));
  type OvRow = { job_id: string; accrue_underbillings: boolean | null; defer_overbillings: boolean | null; exclude_from_wip: boolean; note: string | null };
  const overrides = new Map(((overridesRes.data ?? []) as OvRow[]).map((o) => [o.job_id, o]));

  type JobRow = {
    id: string; job_number: string | null; name: string | null; job_type: string | null; archetype: string | null;
    status: string | null; rev_rec_method_override: RevRecMethod | null; revenue_account_id: string | null; contract_amount_cents: number | null;
  };
  const jobs = ((jobsRes.data ?? []) as JobRow[]).map((j) => {
    const o = overrides.get(j.id) ?? null;
    const typeKey = j.job_type ?? j.archetype ?? null;
    const resolved = resolveJobPolicy({
      company: policy,
      companyRowExists: exists,
      jobType: typeKey ? typeSwitch.get(typeKey) ?? null : null,
      job: o ? { accrueUnderbillings: o.accrue_underbillings, deferOverbillings: o.defer_overbillings, excludeFromWip: o.exclude_from_wip } : null,
    });
    const method = resolveRevRecMethod(j, typeMethod, companyDefault, revType);
    const methodSource = j.rev_rec_method_override ? 'JOB'
      : j.revenue_account_id && revType.has(j.revenue_account_id) ? 'REVENUE_TYPE'
      : typeKey && typeMethod.has(typeKey) ? 'JOB_TYPE' : 'COMPANY';
    return {
      id: j.id,
      jobNumber: j.job_number,
      name: j.name,
      jobType: typeKey,
      status: j.status,
      contractCents: Number(j.contract_amount_cents ?? 0),
      method,
      methodOverride: j.rev_rec_method_override,
      methodSource,
      override: o ? { accrueUnderbillings: o.accrue_underbillings, deferOverbillings: o.defer_overbillings, excludeFromWip: o.exclude_from_wip, note: o.note } : null,
      resolved: {
        accrueUnderbillings: resolved.accrueUnderbillings,
        deferOverbillings: resolved.deferOverbillings,
        excluded: resolved.excluded,
        accrueSource: sourceLabel(resolved.source.accrueUnderbillings),
        deferSource: sourceLabel(resolved.source.deferOverbillings),
      },
    };
  });

  return NextResponse.json({
    methods: REV_REC_METHODS.map((m) => ({ value: m, ...METHOD_COPY[m] })),
    company: { locationId: loc.id, name: loc.name, shortCode: loc.short_code, defaultMethod: companyDefault },
    policy,
    policyRowExists: exists,
    projectsEntitled,
    jobTypes: maps.map((m) => ({ id: m.id, jobType: m.job_type, method: m.method, accrueUnderbillings: m.accrue_underbillings, deferOverbillings: m.defer_overbillings })),
    jobs,
  });
});

const policySchema = z.object({
  kind: z.literal('policy'),
  location_id: z.string().uuid(),
  default_method: z.enum(METHODS).optional(),
  accrue_underbillings: z.boolean(),
  defer_overbillings: z.boolean(),
  loss_provision: z.boolean(),
  run_cadence: z.enum(RUN_CADENCES as unknown as [string, ...string[]]),
  posting_mode: z.enum(POSTING_MODES as unknown as [string, ...string[]]),
  materiality_cents: z.number().int().min(0).max(10_000_000_000),
  retainage_presentation: z.enum(RETAINAGE_PRESENTATIONS as unknown as [string, ...string[]]),
});
const jobTypeSchema = z.object({
  kind: z.literal('job_type'),
  location_id: z.string().uuid(),
  job_type: z.string().trim().min(1).max(100),
  method: z.enum(METHODS),
  accrue_underbillings: z.boolean().nullable(),
  defer_overbillings: z.boolean().nullable(),
});
const jobSchema = z.object({
  kind: z.literal('job'),
  location_id: z.string().uuid(),
  job_id: z.string().uuid(),
  method_override: z.enum(METHODS).nullable(),
  accrue_underbillings: z.boolean().nullable(),
  defer_overbillings: z.boolean().nullable(),
  exclude_from_wip: z.boolean(),
  note: z.string().trim().max(500).nullable().optional(),
});
const postSchema = z.discriminatedUnion('kind', [policySchema, jobTypeSchema, jobSchema]);
type PostBody = z.infer<typeof postSchema>;

export const POST = apiHandler(postSchema, async (body: PostBody, ctx: ApiContext) => {
  if (!ctx.orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });
  const guard = await requirePermission(ctx.userId, 'settings_acct', 'edit');
  if (!guard.ok) return guard.response;
  const orgId = ctx.orgId;
  const now = new Date().toISOString();

  try {
    await assertWriteScope(ctx.supabase, orgId, [body.location_id]);
  } catch (e) {
    if (isWriteScopeError(e)) return NextResponse.json({ error: e.message }, { status: 403 });
    throw e;
  }
  const writer = await scopedWriter(ctx.supabase, orgId, [body.location_id]);

  if (body.kind === 'policy') {
    if (body.default_method) {
      const { data, error } = await createAdminSupabase()
        .schema('core').from('locations')
        .update({ rev_rec_method: body.default_method })
        .eq('id', body.location_id)
        .eq('org_id', orgId)
        .select('id');
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      if (!data || data.length === 0) return NextResponse.json({ error: 'Company not found' }, { status: 404 });
    }
    const { error } = await writer.from('rev_rec_policies').upsert({
      org_id: orgId,
      location_id: body.location_id,
      accrue_underbillings: body.accrue_underbillings,
      defer_overbillings: body.defer_overbillings,
      loss_provision: body.loss_provision,
      run_cadence: body.run_cadence,
      posting_mode: body.posting_mode,
      materiality_cents: body.materiality_cents,
      retainage_presentation: body.retainage_presentation,
      updated_by: ctx.userId,
      updated_at: now,
    }, { onConflict: 'org_id,location_id' });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  if (body.kind === 'job_type') {
    const { error } = await writer.from('rev_rec_method_map').upsert({
      org_id: orgId,
      location_id: body.location_id,
      job_type: body.job_type,
      method: body.method,
      accrue_underbillings: body.accrue_underbillings,
      defer_overbillings: body.defer_overbillings,
      updated_at: now,
    }, { onConflict: 'org_id,location_id,job_type' });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  // kind === 'job' — the job must belong to this org and company.
  const { data: job } = await ctx.supabase.schema('core').from('jobs').select('id, location_id').eq('org_id', orgId).eq('id', body.job_id).maybeSingle();
  if (!job || (job as { location_id: string }).location_id !== body.location_id) {
    return NextResponse.json({ error: 'Job not found in this company' }, { status: 404 });
  }
  const { error: jobErr } = await createAdminSupabase()
    .schema('core').from('jobs')
    .update({ rev_rec_method_override: body.method_override, updated_at: now })
    .eq('id', body.job_id)
    .eq('org_id', orgId);
  if (jobErr) return NextResponse.json({ error: jobErr.message }, { status: 500 });

  const inherits = body.accrue_underbillings == null && body.defer_overbillings == null && !body.exclude_from_wip && !body.note;
  if (inherits) {
    const { error } = await writer.from('rev_rec_job_overrides').delete().eq('org_id', orgId).eq('job_id', body.job_id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  } else {
    const { error } = await writer.from('rev_rec_job_overrides').upsert({
      org_id: orgId,
      location_id: body.location_id,
      job_id: body.job_id,
      accrue_underbillings: body.accrue_underbillings,
      defer_overbillings: body.defer_overbillings,
      exclude_from_wip: body.exclude_from_wip,
      note: body.note ?? null,
      updated_by: ctx.userId,
      updated_at: now,
    }, { onConflict: 'org_id,job_id' });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
});

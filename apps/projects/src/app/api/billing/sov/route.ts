import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiHandler, apiQueryHandler } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';

// /api/billing/sov
//   GET  ?jobId=  -> every SOV version for the job (from proj.v_sov_status) plus
//                    each version's lines. No guard: RLS scopes the read to the org.
//   POST          -> create a DRAFT proj.sov_versions + its proj.sov_lines. Money
//                    path (scheduled values), so it is guarded ('proj_billing',
//                    'create'). Version number is auto-assigned max(version)+1.
//
// All writes go through the RLS-scoped ctx.supabase (never the service client).
// org_id has NO column default on sov_versions/sov_lines, so we source it from the
// job row itself — that row is only visible to the caller's org (jobs RLS is
// org_id = get_org_id()), so job.org_id IS the caller's org and satisfies the
// with-check on every insert.

// ---- GET ---------------------------------------------------------------------

const querySchema = z.object({
  jobId: z.string().uuid('A valid jobId is required'),
});

export const GET = apiQueryHandler(querySchema, async (params, ctx) => {
  const { data: versions, error: versErr } = await ctx.supabase
    .schema('proj')
    .from('v_sov_status')
    .select(
      'sov_version_id,org_id,job_id,contract_id,version,status,line_count,scheduled_total_cents,earned_to_date_cents,remaining_cents,pct_complete_weighted',
    )
    .eq('job_id', params.jobId)
    .order('version', { ascending: false });

  if (versErr) {
    return NextResponse.json(
      { error: versErr.message, code: 'SOV_LOOKUP_FAILED' },
      { status: 400 },
    );
  }

  const versionIds = (versions ?? []).map((v) => v.sov_version_id as string);

  const { data: lines, error: linesErr } = versionIds.length
    ? await ctx.supabase
        .schema('proj')
        .from('sov_lines')
        .select(
          'id,sov_version_id,line_no,cost_code_id,description,scheduled_value_cents,pct_complete,retainage_pct,sort_order',
        )
        .in('sov_version_id', versionIds)
        .order('sort_order', { ascending: true })
        .order('line_no', { ascending: true })
    : { data: [], error: null };

  if (linesErr) {
    return NextResponse.json(
      { error: linesErr.message, code: 'SOV_LINES_LOOKUP_FAILED' },
      { status: 400 },
    );
  }

  return NextResponse.json({ versions: versions ?? [], lines: lines ?? [] });
});

// ---- POST --------------------------------------------------------------------

const lineSchema = z.object({
  lineNo: z.number().int('Line number must be an integer').positive('Line number must be > 0'),
  description: z.string().trim().min(1, 'Description is required').max(500),
  scheduledValueCents: z
    .number({ invalid_type_error: 'Scheduled value must be a number' })
    .int('Scheduled value must be an integer number of cents')
    .min(0, 'Scheduled value cannot be negative')
    .max(1_000_000_000_000, 'Scheduled value is too large'),
  // 0..1 fraction at the API boundary; the UI converts from percent.
  pctComplete: z.number().min(0, 'Percent complete cannot be negative').max(1, 'Percent complete cannot exceed 100%').optional(),
  costCodeId: z.string().uuid().optional(),
  // per-line retainage override, 0..1 fraction; null/undefined = fall back to the contract rate.
  retainagePct: z.number().min(0).max(1).optional(),
  sortOrder: z.number().int().min(0).optional(),
});

const bodySchema = z.object({
  jobId: z.string().uuid('A job must be selected'),
  memo: z.string().trim().max(1000).optional(),
  lines: z.array(lineSchema).min(1, 'At least one line is required').max(500),
});

export const POST = apiHandler(bodySchema, async (body, ctx) => {
  const guard = await requirePermission(ctx, 'proj_billing', 'create');
  if (!guard.ok) return guard.response;

  // Reject duplicate line numbers before hitting the unique(sov_version_id,line_no)
  // constraint so the operator gets a readable message, not a raw PG error.
  const lineNos = body.lines.map((l) => l.lineNo);
  if (new Set(lineNos).size !== lineNos.length) {
    return NextResponse.json(
      { error: 'Line numbers must be unique', code: 'SOV_DUPLICATE_LINE_NO' },
      { status: 422 },
    );
  }

  // Source org_id (and confirm the job is in the caller's org) from the job row.
  const { data: job, error: jobErr } = await ctx.supabase
    .schema('core')
    .from('jobs')
    .select('id,org_id')
    .eq('id', body.jobId)
    .maybeSingle();

  if (jobErr) {
    return NextResponse.json({ error: jobErr.message, code: 'JOB_LOOKUP_FAILED' }, { status: 400 });
  }
  if (!job || typeof job.org_id !== 'string') {
    return NextResponse.json(
      { error: 'Job not found', code: 'JOB_NOT_FOUND' },
      { status: 404 },
    );
  }
  const orgId = job.org_id;

  // Optionally link the version to the job's contract (nullable if none exists yet).
  const { data: contract } = await ctx.supabase
    .schema('proj')
    .from('contracts')
    .select('id')
    .eq('job_id', body.jobId)
    .maybeSingle();

  // Auto-assign the next version number for this job.
  const { data: latest, error: latestErr } = await ctx.supabase
    .schema('proj')
    .from('sov_versions')
    .select('version')
    .eq('job_id', body.jobId)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (latestErr) {
    return NextResponse.json({ error: latestErr.message, code: 'SOV_VERSION_LOOKUP_FAILED' }, { status: 400 });
  }
  const nextVersion = latest ? Number(latest.version) + 1 : 1;

  const { data: version, error: versErr } = await ctx.supabase
    .schema('proj')
    .from('sov_versions')
    .insert({
      org_id: orgId,
      job_id: body.jobId,
      contract_id: contract?.id ?? null,
      version: nextVersion,
      status: 'DRAFT',
      memo: body.memo ?? null,
      created_by: ctx.userId,
    })
    .select('id,version')
    .single();

  if (versErr || !version) {
    return NextResponse.json(
      { error: versErr?.message ?? 'Failed to create SOV version', code: 'SOV_CREATE_FAILED' },
      { status: 400 },
    );
  }

  const lineRows = body.lines.map((line, index) => ({
    org_id: orgId,
    sov_version_id: version.id,
    line_no: line.lineNo,
    cost_code_id: line.costCodeId ?? null,
    description: line.description,
    scheduled_value_cents: line.scheduledValueCents,
    pct_complete: line.pctComplete ?? 0,
    retainage_pct: line.retainagePct ?? null,
    sort_order: line.sortOrder ?? index,
  }));

  const { error: linesErr } = await ctx.supabase
    .schema('proj')
    .from('sov_lines')
    .insert(lineRows);

  if (linesErr) {
    // Cascade-delete the orphaned version (sov_lines FK is ON DELETE CASCADE).
    await ctx.supabase.schema('proj').from('sov_versions').delete().eq('id', version.id);
    return NextResponse.json(
      { error: linesErr.message, code: 'SOV_LINES_FAILED' },
      { status: 400 },
    );
  }

  return NextResponse.json(
    { ok: true, id: version.id, version: version.version, status: 'DRAFT' },
    { status: 201 },
  );
});

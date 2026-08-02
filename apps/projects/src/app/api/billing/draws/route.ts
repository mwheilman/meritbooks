import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiHandler } from '@/lib/api-handler';

// POST /api/billing/draws — create a DRAFT billing request (draw) + its lines.
//
// MONEY PATH. This route only ever creates a DRAFT; it NEVER emits a ledger
// event (that is the /approve route, behind an explicit two-step confirm). All
// writes go through the RLS-scoped ctx.supabase (never the service client), so
// tenant isolation is enforced at the database. Dollar amounts are converted to
// integer cents server-side — the client's number is advisory, the server is the
// authoritative money boundary.

// A single line: a human description and a POSITIVE dollar amount. We accept
// dollars (not cents) at the wire so the conversion to integer cents happens in
// exactly one place — here — and never as float math downstream.
const lineSchema = z.object({
  description: z.string().trim().min(1, 'Description is required').max(500),
  // dollars; finite, strictly positive, capped well under bigint/JS-safe range.
  amount: z
    .number({ invalid_type_error: 'Amount must be a number' })
    .finite('Amount must be a number')
    .positive('Amount must be greater than 0')
    .max(100_000_000, 'Amount is too large'),
});

const bodySchema = z.object({
  job_id: z.string().uuid('A job must be selected'),
  billing_type: z.enum(['MILESTONE', 'PROGRESS', 'TIME_MATERIALS', 'DRAW']),
  // ISO calendar date; optional — defaults to today (UTC) when omitted.
  occurred_on: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD')
    .optional(),
  memo: z.string().trim().max(1000).optional(),
  lines: z.array(lineSchema).min(1, 'At least one line is required').max(200),
});

// dollars -> integer cents, defensively rounded (never trust float precision).
function dollarsToCents(dollars: number): number {
  return Math.round(dollars * 100);
}

export const POST = apiHandler(bodySchema, async (body, ctx) => {
  // 1. Resolve the job's location_id. billing_requests.location_id is NOT NULL,
  //    and RLS scopes this read to the caller's org — a job outside the org (or
  //    a bad id) resolves to null and is rejected here, before any write.
  const { data: job, error: jobErr } = await ctx.supabase
    .schema('core')
    .from('jobs')
    .select('location_id')
    .eq('id', body.job_id)
    .maybeSingle();

  if (jobErr) {
    return NextResponse.json(
      { error: jobErr.message, code: 'JOB_LOOKUP_FAILED' },
      { status: 400 },
    );
  }
  if (!job || typeof job.location_id !== 'string') {
    return NextResponse.json(
      { error: 'Job not found or missing a location', code: 'JOB_NOT_FOUND' },
      { status: 404 },
    );
  }

  const occurredOn = body.occurred_on ?? new Date().toISOString().slice(0, 10);

  // 2. Insert the DRAFT request. org_id defaults to get_org_id() in the DB.
  const { data: draft, error: reqErr } = await ctx.supabase
    .schema('proj')
    .from('billing_requests')
    .insert({
      job_id: body.job_id,
      location_id: job.location_id,
      billing_type: body.billing_type,
      status: 'DRAFT',
      occurred_on: occurredOn,
      memo: body.memo ?? null,
      created_by: ctx.userId,
    })
    .select('id')
    .single();

  if (reqErr || !draft) {
    return NextResponse.json(
      { error: reqErr?.message ?? 'Failed to create draw', code: 'DRAW_CREATE_FAILED' },
      { status: 400 },
    );
  }

  // 3. Insert the lines (org_id defaults in the DB). Convert dollars -> cents here.
  const lineRows = body.lines.map((line, index) => ({
    billing_request_id: draft.id,
    description: line.description,
    amount_cents: dollarsToCents(line.amount),
    sort_order: index,
  }));

  const { error: linesErr } = await ctx.supabase
    .schema('proj')
    .from('billing_request_lines')
    .insert(lineRows);

  if (linesErr) {
    // Compensate: a DRAFT with no lines cannot be issued (the RPC rejects it),
    // but leaving an empty orphan is untidy — best-effort delete, then report.
    await ctx.supabase.schema('proj').from('billing_requests').delete().eq('id', draft.id);
    return NextResponse.json(
      { error: linesErr.message, code: 'DRAW_LINES_FAILED' },
      { status: 400 },
    );
  }

  const totalCents = lineRows.reduce((sum, l) => sum + l.amount_cents, 0);

  return NextResponse.json(
    { ok: true, id: draft.id, status: 'DRAFT', totalCents },
    { status: 201 },
  );
});

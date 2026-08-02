import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiHandler } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';

// POST /api/billing/sov/generate — turn the job's ACTIVE schedule of values into
// a DRAFT progress billing (billing_type='SOV') via the SECURITY DEFINER RPC
// proj.generate_sov_billing. MONEY PATH but NOT the emit — it only creates a
// DRAFT billing_request (one positive line per SOV line for the incremental
// earned amount + a negative retainage-withheld line), which the operator later
// issues from /billing. Guarded ('proj_billing','create').
//
// The RPC raises PRECONDITION_NO_ACTIVE_SOV / PRECONDITION_NOTHING_TO_BILL; we
// surface those VERBATIM as 422s (mirroring draws/[id]/approve) so the operator
// sees the exact reason. After a successful generate we read back the created
// draft's lines + retainage so the client can show the net/retainage immediately.

const bodySchema = z.object({
  jobId: z.string().uuid('A job must be selected'),
  occurredOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD')
    .optional(),
});

// Pull a PRECONDITION_* code out of a raised message, if present, for the UI.
function preconditionCode(message: string): string | null {
  const match = message.match(/PRECONDITION_[A-Z_]+/);
  return match ? match[0] : null;
}

export const POST = apiHandler(bodySchema, async (body, ctx) => {
  const guard = await requirePermission(ctx, 'proj_billing', 'create');
  if (!guard.ok) return guard.response;

  const occurredOn = body.occurredOn ?? new Date().toISOString().slice(0, 10);

  const { data, error } = await ctx.supabase
    .schema('proj')
    .rpc('generate_sov_billing', {
      p_job_id: body.jobId,
      p_occurred_on: occurredOn,
      p_created_by: ctx.userId,
    });

  if (error) {
    const message = error.message ?? 'Progress billing failed';
    const code = preconditionCode(message);

    if (/not found/i.test(message)) {
      return NextResponse.json({ error: message, code: 'JOB_NOT_FOUND' }, { status: 404 });
    }
    // PRECONDITION_NO_ACTIVE_SOV / PRECONDITION_NOTHING_TO_BILL and any other
    // business-state failure -> 422 with the raw message.
    return NextResponse.json(
      { error: message, code: code ?? 'PRECONDITION_FAILED' },
      { status: 422 },
    );
  }

  // The RPC returns the new billing_request id (uuid).
  const billingRequestId = typeof data === 'string' ? data : null;
  if (!billingRequestId) {
    return NextResponse.json(
      { error: 'Progress billing did not return a draft', code: 'SOV_BILLING_NO_RESULT' },
      { status: 500 },
    );
  }

  // Read back the created draft so the client can show the authoritative numbers.
  const [{ data: req }, { data: lines }] = await Promise.all([
    ctx.supabase
      .schema('proj')
      .from('billing_requests')
      .select('id,retainage_cents,occurred_on')
      .eq('id', billingRequestId)
      .maybeSingle(),
    ctx.supabase
      .schema('proj')
      .from('billing_request_lines')
      .select('amount_cents')
      .eq('billing_request_id', billingRequestId),
  ]);

  const lineAmounts = (lines ?? []).map((l) => Number(l.amount_cents));
  const netCents = lineAmounts.reduce((sum, c) => sum + c, 0);
  const grossCents = lineAmounts.filter((c) => c > 0).reduce((sum, c) => sum + c, 0);
  const retainageCents = req ? Number((req as { retainage_cents: number }).retainage_cents) : grossCents - netCents;

  return NextResponse.json(
    {
      ok: true,
      billingRequestId,
      occurredOn,
      grossCents,
      retainageCents,
      netCents,
    },
    { status: 201 },
  );
});

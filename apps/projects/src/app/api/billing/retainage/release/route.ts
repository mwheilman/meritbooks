import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiHandler } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';

// POST /api/billing/retainage/release — bill accumulated retainage back at
// closeout. Wraps proj.release_retainage(), which mints a DRAFT
// billing_request (billing_type='RETAINAGE_RELEASE') and posts a RELEASED row
// to proj.retainage_ledger. Nothing is emitted here — the operator issues the
// resulting draft from /billing (the irreversible money step).
//
// MONEY PATH. The RPC is SECURITY DEFINER and enforces every precondition
// (outstanding retainage exists, amount > 0, amount <= outstanding) raising
// PRECONDITION_* which we surface VERBATIM as 422 so the operator sees exactly
// why. Called through the RLS-scoped ctx.supabase so org context governs the
// read inside the RPC (get_org_id()).

const bodySchema = z.object({
  jobId: z.string().uuid(),
  // omit = release the FULL outstanding retainage.
  amountCents: z.number().int().positive().optional(),
  // ISO date (yyyy-mm-dd); defaults to current_date in the RPC.
  occurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

// Pull a PRECONDITION_* code out of a raised message, if present, for the UI.
function preconditionCode(message: string): string | null {
  const match = message.match(/PRECONDITION_[A-Z_]+/);
  return match ? match[0] : null;
}

export async function POST(request: Request): Promise<NextResponse> {
  return apiHandler(bodySchema, async (body, ctx) => {
    const guard = await requirePermission(ctx, 'proj_billing', 'approve');
    if (!guard.ok) return guard.response;

    const { data, error } = await ctx.supabase
      .schema('proj')
      .rpc('release_retainage', {
        p_job_id: body.jobId,
        p_amount_cents: body.amountCents ?? null,
        p_occurred_on: body.occurredOn ?? new Date().toISOString().slice(0, 10),
        p_created_by: ctx.userId,
      });

    if (error) {
      const message = error.message ?? 'Retainage release failed';
      const code = preconditionCode(message);

      // Job not visible / cross-org → 404.
      if (/not found/i.test(message)) {
        return NextResponse.json({ error: message, code: 'JOB_NOT_FOUND' }, { status: 404 });
      }

      // Every precondition failure is a 422 with the raw message so the operator
      // sees the exact reason (e.g. PRECONDITION_OVER_RELEASE).
      return NextResponse.json(
        { error: message, code: code ?? 'PRECONDITION_FAILED' },
        { status: 422 },
      );
    }

    // uuid = the DRAFT billing_request just created (issue it from /billing).
    const billingRequestId = typeof data === 'string' ? data : null;
    return NextResponse.json({ ok: true, billingRequestId });
  })(request);
}

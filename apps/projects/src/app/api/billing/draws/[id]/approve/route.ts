import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiHandler } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';

// POST /api/billing/draws/[id]/approve — approve a DRAFT draw and emit its
// JOB_BILLING event via the pre-built seam.
//
// MONEY PATH. This is the irreversible action: a successful call emits a real
// ledger event (status -> EMITTED) or, when Books is absent, terminally marks the
// draw UNISSUED. The DB function proj.approve_and_emit_billing is SECURITY DEFINER
// and enforces every precondition (customer present, non-empty lines, positive
// total, external-gate / lien-waiver) and the DRAFT/REJECTED-only state guard,
// raising PRECONDITION_* / state errors we surface VERBATIM so the operator sees
// exactly why. We call it through the RLS-scoped ctx.supabase (never the service
// client) so the caller's org context governs the read-for-update inside the RPC.

const idSchema = z.string().uuid();

// Pull a PRECONDITION_* code out of a raised message, if present, for the UI.
function preconditionCode(message: string): string | null {
  const match = message.match(/PRECONDITION_[A-Z_]+/);
  return match ? match[0] : null;
}

export async function POST(
  request: Request,
  context: { params: { id: string } },
): Promise<NextResponse> {
  // Validate the path id BEFORE auth-scoped work — a malformed id is a 422, not
  // a DB round-trip.
  const parsedId = idSchema.safeParse(context.params.id);
  if (!parsedId.success) {
    return NextResponse.json(
      { error: 'Invalid draw id', code: 'VALIDATION_ERROR' },
      { status: 422 },
    );
  }
  const requestId = parsedId.data;

  // apiHandler gives us auth + the RLS-scoped client. No request body: the id is
  // the only input and it comes from the path.
  return apiHandler(null, async (_body, ctx) => {
    const guard = await requirePermission(ctx, 'proj_billing', 'approve');
    if (!guard.ok) return guard.response;

    const { data, error } = await ctx.supabase
      .schema('proj')
      .rpc('approve_and_emit_billing', {
        p_request_id: requestId,
        p_approver: ctx.userId,
      });

    if (error) {
      const message = error.message ?? 'Approval failed';
      const code = preconditionCode(message);

      // Not-found (incl. cross-org rows the RLS read-for-update can't see) -> 404.
      if (/not found/i.test(message)) {
        return NextResponse.json({ error: message, code: 'DRAW_NOT_FOUND' }, { status: 404 });
      }

      // Every precondition / business-state failure is a 422 with the raw message
      // so the operator sees the exact reason (e.g. PRECONDITION_NO_CUSTOMER).
      return NextResponse.json(
        { error: message, code: code ?? 'PRECONDITION_FAILED' },
        { status: 422 },
      );
    }

    // uuid -> event emitted (EMITTED). null -> standalone, no consumer (UNISSUED).
    const eventId = typeof data === 'string' ? data : null;
    return NextResponse.json({
      ok: true,
      eventId,
      status: eventId ? 'EMITTED' : 'UNISSUED',
    });
  })(request);
}

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiHandler } from '@/lib/api-handler';

// POST /api/gates/[id]/transition — advance an external gate through its state
// machine via the security-definer RPC. The RPC is the single source of truth
// for legal transitions and raises GATE_TRANSITION_INVALID on an illegal move;
// the UI only offers legal next statuses, this surfaces the error if one slips.
const bodySchema = z.object({
  new_status: z.enum([
    'PENDING',
    'SUBMITTED',
    'APPROVED',
    'CLEARED',
    'REJECTED',
    'EXPIRED',
    'WAIVED',
  ]),
});

export function POST(request: Request, { params }: { params: { id: string } }) {
  return apiHandler(bodySchema, async (body, ctx) => {
    const { data, error } = await ctx.supabase.schema('proj').rpc('advance_external_gate', {
      p_gate_id: params.id,
      p_new_status: body.new_status,
      p_actor: ctx.userId,
    });

    if (error) {
      const invalid = error.message.includes('GATE_TRANSITION_INVALID');
      return NextResponse.json(
        {
          error: invalid ? 'That transition is not allowed from the gate’s current status.' : error.message,
          code: invalid ? 'GATE_TRANSITION_INVALID' : 'DB_ERROR',
        },
        { status: invalid ? 409 : 400 },
      );
    }

    return NextResponse.json({ gate: data });
  })(request);
}

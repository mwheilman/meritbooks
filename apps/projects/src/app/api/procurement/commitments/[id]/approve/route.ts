import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiHandler } from '@/lib/api-handler';

// POST /api/procurement/commitments/[id]/approve — DRAFT → APPROVED, minting the
// PO#/SUB# on first approval. All the work is in the security-definer RPC
// proj.approve_commitment(p_commitment_id, p_approver); we pass the Clerk userId
// as the approver. apiHandler gives us auth + the RLS-scoped client; the path id
// is validated here and closed over (apiHandler's inner handler takes no request).

const ParamsSchema = z.object({ id: z.string().uuid() });

export async function POST(
  request: Request,
  { params }: { params: { id: string } },
) {
  const parsed = ParamsSchema.safeParse(params);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid commitment id', code: 'VALIDATION_ERROR' },
      { status: 422 },
    );
  }

  return apiHandler(null, async (_body, { supabase, userId }) => {
    const { error } = await supabase
      .schema('proj')
      .rpc('approve_commitment', {
        p_commitment_id: parsed.data.id,
        p_approver: userId,
      });

    if (error) {
      return NextResponse.json(
        { error: error.message, code: 'APPROVE_FAILED' },
        { status: 400 },
      );
    }

    return NextResponse.json({ ok: true });
  })(request);
}

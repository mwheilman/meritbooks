import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiHandler } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';

// POST /api/billing/sov/[versionId]/activate — flip one SOV version ACTIVE and
// supersede any other active version on the same job, via the SECURITY DEFINER
// RPC proj.activate_sov_version. Guarded ('proj_billing','edit'). Called through
// the RLS-scoped ctx.supabase so the caller's org governs the row lock inside the
// RPC (the RPC's own `org_id = get_org_id()` filter is the second gate).

const idSchema = z.string().uuid();

export async function POST(
  _request: Request,
  context: { params: { versionId: string } },
): Promise<NextResponse> {
  const parsedId = idSchema.safeParse(context.params.versionId);
  if (!parsedId.success) {
    return NextResponse.json(
      { error: 'Invalid version id', code: 'VALIDATION_ERROR' },
      { status: 422 },
    );
  }
  const versionId = parsedId.data;

  return apiHandler(null, async (_body, ctx) => {
    const guard = await requirePermission(ctx, 'proj_billing', 'edit');
    if (!guard.ok) return guard.response;

    const { data, error } = await ctx.supabase
      .schema('proj')
      .rpc('activate_sov_version', {
        p_version_id: versionId,
        p_actor: ctx.userId,
      });

    if (error) {
      const message = error.message ?? 'Activation failed';
      if (/not found/i.test(message)) {
        return NextResponse.json({ error: message, code: 'SOV_NOT_FOUND' }, { status: 404 });
      }
      return NextResponse.json({ error: message, code: 'SOV_ACTIVATE_FAILED' }, { status: 422 });
    }

    // The RPC returns the activated sov_versions row.
    const row = (Array.isArray(data) ? data[0] : data) as { id?: string; status?: string } | null;
    return NextResponse.json({
      ok: true,
      id: row?.id ?? versionId,
      status: row?.status ?? 'ACTIVE',
    });
  })(_request);
}

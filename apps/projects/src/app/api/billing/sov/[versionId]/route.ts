import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiHandler } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';

// PATCH /api/billing/sov/[versionId] — update a DRAFT SOV version's memo and/or
// fully replace its lines. DRAFT ONLY: an ACTIVE/SUPERSEDED version is immutable
// (revise by creating a new version and activating it). Guarded ('proj_billing',
// 'edit'). All writes go through the RLS-scoped ctx.supabase.

const idSchema = z.string().uuid();

const lineSchema = z.object({
  lineNo: z.number().int('Line number must be an integer').positive('Line number must be > 0'),
  description: z.string().trim().min(1, 'Description is required').max(500),
  scheduledValueCents: z
    .number({ invalid_type_error: 'Scheduled value must be a number' })
    .int('Scheduled value must be an integer number of cents')
    .min(0, 'Scheduled value cannot be negative')
    .max(1_000_000_000_000, 'Scheduled value is too large'),
  pctComplete: z.number().min(0, 'Percent complete cannot be negative').max(1, 'Percent complete cannot exceed 100%').optional(),
  costCodeId: z.string().uuid().optional(),
  retainagePct: z.number().min(0).max(1).optional(),
  sortOrder: z.number().int().min(0).optional(),
});

// At least one of memo / lines must be present — an empty PATCH is a no-op.
const bodySchema = z
  .object({
    memo: z.string().trim().max(1000).nullable().optional(),
    lines: z.array(lineSchema).min(1, 'At least one line is required').max(500).optional(),
  })
  .refine((b) => b.memo !== undefined || b.lines !== undefined, {
    message: 'Nothing to update',
  });

export async function PATCH(
  request: Request,
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

  return apiHandler(bodySchema, async (body, ctx) => {
    const guard = await requirePermission(ctx, 'proj_billing', 'edit');
    if (!guard.ok) return guard.response;

    // Load the version to enforce the DRAFT-only guard and to source org_id for
    // the line inserts (sov_lines.org_id has no default).
    const { data: version, error: verErr } = await ctx.supabase
      .schema('proj')
      .from('sov_versions')
      .select('id,org_id,status')
      .eq('id', versionId)
      .maybeSingle();

    if (verErr) {
      return NextResponse.json({ error: verErr.message, code: 'SOV_LOOKUP_FAILED' }, { status: 400 });
    }
    if (!version) {
      return NextResponse.json({ error: 'SOV version not found', code: 'SOV_NOT_FOUND' }, { status: 404 });
    }
    if (version.status !== 'DRAFT') {
      return NextResponse.json(
        {
          error: 'Only a DRAFT schedule of values can be edited. Create a new version to revise an active schedule.',
          code: 'SOV_NOT_DRAFT',
        },
        { status: 409 },
      );
    }

    // Update memo when provided (null clears it).
    if (body.memo !== undefined) {
      const { error: memoErr } = await ctx.supabase
        .schema('proj')
        .from('sov_versions')
        .update({ memo: body.memo, updated_at: new Date().toISOString() })
        .eq('id', versionId);
      if (memoErr) {
        return NextResponse.json({ error: memoErr.message, code: 'SOV_MEMO_UPDATE_FAILED' }, { status: 400 });
      }
    }

    // Replace lines wholesale when provided.
    if (body.lines !== undefined) {
      const lineNos = body.lines.map((l) => l.lineNo);
      if (new Set(lineNos).size !== lineNos.length) {
        return NextResponse.json(
          { error: 'Line numbers must be unique', code: 'SOV_DUPLICATE_LINE_NO' },
          { status: 422 },
        );
      }

      const { error: delErr } = await ctx.supabase
        .schema('proj')
        .from('sov_lines')
        .delete()
        .eq('sov_version_id', versionId);
      if (delErr) {
        return NextResponse.json({ error: delErr.message, code: 'SOV_LINES_CLEAR_FAILED' }, { status: 400 });
      }

      const lineRows = body.lines.map((line, index) => ({
        org_id: version.org_id as string,
        sov_version_id: versionId,
        line_no: line.lineNo,
        cost_code_id: line.costCodeId ?? null,
        description: line.description,
        scheduled_value_cents: line.scheduledValueCents,
        pct_complete: line.pctComplete ?? 0,
        retainage_pct: line.retainagePct ?? null,
        sort_order: line.sortOrder ?? index,
      }));

      const { error: insErr } = await ctx.supabase
        .schema('proj')
        .from('sov_lines')
        .insert(lineRows);
      if (insErr) {
        return NextResponse.json({ error: insErr.message, code: 'SOV_LINES_FAILED' }, { status: 400 });
      }
    }

    return NextResponse.json({ ok: true, id: versionId, status: 'DRAFT' });
  })(request);
}

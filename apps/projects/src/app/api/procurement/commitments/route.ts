import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiHandler } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';

// POST /api/procurement/commitments — create a DRAFT PO / subcontract.
// Two writes on the RLS-scoped client: the `commitments` header (org_id defaults
// to get_org_id(); original == revised == Σ lines), then its `commitment_lines`.
// If the line insert fails we best-effort delete the orphan header so a failed
// create never leaves a headerless commitment behind. The number is minted later
// by approve_commitment — a DRAFT carries no number.

const LineSchema = z.object({
  description: z.string().trim().min(1, 'Description required').max(500),
  amount_cents: z.number().int().positive('Amount must be greater than zero'),
  cost_code_id: z.string().uuid().nullable().optional(),
});

const CreateCommitmentSchema = z.object({
  job_id: z.string().uuid(),
  commitment_type: z.enum(['PURCHASE_ORDER', 'SUBCONTRACT']),
  vendor_id: z.string().uuid().nullable().optional(),
  lines: z.array(LineSchema).min(1, 'At least one line is required').max(200),
});

export const POST = apiHandler(CreateCommitmentSchema, async (body, { supabase, userId }) => {
  const guard = await requirePermission({ userId, supabase }, 'proj_commitments', 'create');
  if (!guard.ok) return guard.response;

  const originalAmountCents = body.lines.reduce((sum, l) => sum + l.amount_cents, 0);

  const { data: header, error: headerError } = await supabase
    .schema('proj')
    .from('commitments')
    .insert({
      job_id: body.job_id,
      vendor_id: body.vendor_id ?? null,
      commitment_type: body.commitment_type,
      original_amount_cents: originalAmountCents,
      revised_amount_cents: originalAmountCents,
    })
    .select('id, job_id, commitment_type, status, original_amount_cents, revised_amount_cents')
    .single();

  if (headerError || !header) {
    return NextResponse.json(
      { error: headerError?.message ?? 'Failed to create commitment', code: 'INSERT_FAILED' },
      { status: 400 },
    );
  }

  const lineRows = body.lines.map((l) => ({
    commitment_id: header.id as string,
    job_id: body.job_id,
    description: l.description,
    amount_cents: l.amount_cents,
    cost_code_id: l.cost_code_id ?? null,
  }));

  const { data: lines, error: linesError } = await supabase
    .schema('proj')
    .from('commitment_lines')
    .insert(lineRows)
    .select('id, commitment_id, description, amount_cents, cost_code_id');

  if (linesError) {
    // Best-effort cleanup: drop the orphan header (RLS + FK cascade cover the rest).
    await supabase.schema('proj').from('commitments').delete().eq('id', header.id);
    return NextResponse.json(
      { error: linesError.message, code: 'LINE_INSERT_FAILED' },
      { status: 400 },
    );
  }

  return NextResponse.json({ commitment: header, lines: lines ?? [] }, { status: 201 });
});

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { resolvePbcCapabilities, hasTier, forbidden } from '@/lib/audit-access/access';
import { updatePbcSchema } from '@/lib/audit-access/validation';
import {
  canTransition,
  requiredTierForUpdate,
  isPbcStatus,
  type PbcStatus,
  type PbcUpdateIntent,
} from '@/lib/audit-access/pbc';

const PBC_COLS =
  'id, org_id, location_id, title, description, category, period_label, status, ' +
  'requested_by, assigned_to, due_date, document_id, fulfilled_at, notes, created_at, updated_at';

/**
 * PATCH /api/pbc/[id] — advance the workflow, assign, attach the fulfillment document, or
 * edit the request text. The REQUIRED tier is derived from which fields changed:
 *   - status→IN_PROGRESS/PROVIDED, assign, attach/detach doc → FULFILLER (compliance.manage)
 *   - status→ACCEPTED/WAIVED/REQUESTED, edit text            → REQUESTER (compliance.view)
 * A status change is additionally validated against the allowed transition whitelist.
 */
export async function PATCH(request: Request, { params }: { params: { id: string } }): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  const caps = await resolvePbcCapabilities(supabase, orgId, userId);
  if (!caps.canView) return forbidden();

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'PARSE_ERROR' }, { status: 400 });
  }
  const parsed = updatePbcSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', code: 'VALIDATION_ERROR', details: parsed.error.flatten().fieldErrors },
      { status: 422 },
    );
  }
  const b = parsed.data;

  // Load the current row (RLS-scoped) to validate the transition and its ownership.
  const { data: current, error: readErr } = await supabase
    .from('pbc_requests')
    .select(PBC_COLS)
    .eq('id', params.id)
    .maybeSingle();
  if (readErr) {
    return NextResponse.json({ error: 'Lookup failed', code: 'INTERNAL_ERROR' }, { status: 500 });
  }
  if (!current) return NextResponse.json({ error: 'Not found', code: 'NOT_FOUND' }, { status: 404 });
  const currentStatus = (current as unknown as { status: string }).status as PbcStatus;

  // Determine which tier this update requires and authorize.
  const intent: PbcUpdateIntent = {
    status: b.status,
    documentIdChange: b.documentId !== undefined,
    assignedToChange: b.assignedTo !== undefined,
    metadataChange:
      b.title !== undefined ||
      b.description !== undefined ||
      b.category !== undefined ||
      b.periodLabel !== undefined ||
      b.dueDate !== undefined ||
      b.notes !== undefined,
  };
  const tier = requiredTierForUpdate(intent);
  if (tier && !hasTier(caps, tier)) return forbidden();

  // Validate a status change against the allowed transitions.
  if (b.status && isPbcStatus(b.status) && !canTransition(currentStatus, b.status)) {
    return NextResponse.json(
      { error: `Cannot move a request from ${currentStatus} to ${b.status}.`, code: 'INVALID_TRANSITION' },
      { status: 409 },
    );
  }

  // Build the update payload (map camelCase → columns; null clears).
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (b.status !== undefined) update.status = b.status;
  if (b.title !== undefined) update.title = b.title;
  if (b.description !== undefined) update.description = b.description;
  if (b.category !== undefined) update.category = b.category;
  if (b.periodLabel !== undefined) update.period_label = b.periodLabel;
  if (b.dueDate !== undefined) update.due_date = b.dueDate;
  if (b.assignedTo !== undefined) update.assigned_to = b.assignedTo;
  if (b.documentId !== undefined) update.document_id = b.documentId;
  if (b.notes !== undefined) update.notes = b.notes;
  // Stamp fulfilled_at when the client marks the item PROVIDED; clear it if reopened.
  if (b.status === 'PROVIDED') update.fulfilled_at = new Date().toISOString();
  else if (b.status === 'REQUESTED' || b.status === 'IN_PROGRESS') update.fulfilled_at = null;

  const { data, error } = await supabase
    .from('pbc_requests')
    .update(update)
    .eq('id', params.id)
    .select(PBC_COLS)
    .single();
  if (error || !data) {
    console.error('[pbc] update failed:', error);
    return NextResponse.json({ error: error?.message ?? 'Failed to update request', code: 'UPDATE_ERROR' }, { status: 500 });
  }
  return NextResponse.json({ data });
}

/**
 * DELETE /api/pbc/[id] — remove a request. Fulfiller tier (compliance.manage) only, so the
 * read-only auditor can never delete.
 */
export async function DELETE(_request: Request, { params }: { params: { id: string } }): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  const caps = await resolvePbcCapabilities(supabase, orgId, userId);
  if (!caps.canManage) return forbidden();

  const { error } = await supabase.from('pbc_requests').delete().eq('id', params.id);
  if (error) {
    console.error('[pbc] delete failed:', error);
    return NextResponse.json({ error: error.message, code: 'DELETE_ERROR' }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}

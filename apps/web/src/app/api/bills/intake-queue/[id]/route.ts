export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { getDocIntakeDraft, disposeDocIntakeDraft } from '@/lib/ap/doc-intelligence';

/** GET /api/bills/intake-queue/[id] — one extracted draft for the review panel. */
export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  const guard = await requirePermission(userId, 'bills', 'view');
  if (!guard.ok) return guard.response;

  try {
    const draft = await getDocIntakeDraft(supabase, orgId, params.id);
    if (!draft) return NextResponse.json({ error: 'Draft not found', code: 'NOT_FOUND' }, { status: 404 });
    return NextResponse.json({ draft });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to load draft', code: 'LOAD_FAILED' },
      { status: 500 },
    );
  }
}

/**
 * PATCH /api/bills/intake-queue/[id] — disposition a PROPOSED draft.
 *
 * The review UI first creates the bill via the EXISTING gated /api/bills/create
 * (validation + vendor-compliance holds + approver routing + GL-on-approval), then
 * calls this to mark the draft APPROVED and link the created bill:
 *   { "action": "approve", "bill_id": "<uuid>" }
 * Rejecting closes the draft without a bill:
 *   { "action": "reject", "note": "duplicate" }
 *
 * This route never creates a bill or posts to the GL itself.
 */
export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  // Dispositioning an AP draft is a create-grade action (it commits a payable path).
  const guard = await requirePermission(userId, 'bills', 'create');
  if (!guard.ok) return guard.response;

  let body: { action?: string; bill_id?: string; note?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'BAD_BODY' }, { status: 400 });
  }

  if (body.action === 'approve') {
    const billId = String(body.bill_id ?? '').trim();
    if (!billId) {
      return NextResponse.json(
        { error: 'bill_id is required to approve a draft', code: 'NO_BILL_ID' },
        { status: 400 },
      );
    }
    const result = await disposeDocIntakeDraft(supabase, orgId, params.id, {
      action: 'approve',
      billId,
      userId,
    });
    if (!result.ok) return NextResponse.json({ error: result.error, code: 'DISPOSE_FAILED' }, { status: 409 });
    return NextResponse.json({ status: result.status });
  }

  if (body.action === 'reject') {
    const result = await disposeDocIntakeDraft(supabase, orgId, params.id, {
      action: 'reject',
      note: body.note ?? null,
      userId,
    });
    if (!result.ok) return NextResponse.json({ error: result.error, code: 'DISPOSE_FAILED' }, { status: 409 });
    return NextResponse.json({ status: result.status });
  }

  return NextResponse.json({ error: 'Unknown action', code: 'BAD_ACTION' }, { status: 400 });
}

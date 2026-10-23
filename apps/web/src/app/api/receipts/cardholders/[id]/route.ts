export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { assertWriteScope, isWriteScopeError, serviceWriter } from '@/lib/db/scoped-writer';
import { requirePermission } from '@/lib/rbac/require-permission';
import { CardholderError, clearOptOut, decideOptOut, endCardholder, requestOptOut, updateCardholder } from '@/lib/receipts/cardholders';
import { syncReceiptChase } from '@/lib/receipts/chase';
import { cardholderActionBody } from '@/lib/validations/receipts';

/**
 * PATCH /api/receipts/cardholders/[id] — update · end · request / approve / reject /
 * clear an opt-out.
 *
 * receipts:edit for everything except approving or rejecting an opt-out, which needs
 * receipts:approve AND a different person than the requester (separation of duties,
 * enforced in lib/receipts/cardholders.ts). The assignment is read through the caller's
 * RLS client first (org + client scope) before the service role writes.
 */
export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { orgId, userId, supabase } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = cardholderActionBody.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Validation failed' }, { status: 422 });
  const b = parsed.data;

  const needsApprove = b.action === 'approve_opt_out' || b.action === 'reject_opt_out';
  const guard = await requirePermission(userId, 'receipts', needsApprove ? 'approve' : 'edit', { route: '/api/receipts/cardholders/[id]' });
  if (!guard.ok) return guard.response;

  const { data: visible } = await supabase.from('card_assignments').select('id, location_id').eq('org_id', orgId).eq('id', params.id).maybeSingle();
  if (!visible) return NextResponse.json({ error: 'That cardholder was not found.' }, { status: 404 });
  const locationId = (visible as { location_id: string }).location_id;
  try {
    await assertWriteScope(supabase, orgId, [locationId]);
  } catch (e) {
    if (isWriteScopeError(e)) return NextResponse.json({ error: e.message }, { status: 403 });
    throw e;
  }

  const db = serviceWriter();
  const now = new Date();
  try {
    switch (b.action) {
      case 'update': {
        const d = b.data;
        const row = await updateCardholder(
          db,
          orgId,
          params.id,
          {
            locationId: d.location_id,
            bankAccountId: d.bank_account_id ?? null,
            cardLast4: d.card_last4 ?? null,
            cardLabel: d.card_label ?? null,
            holderType: d.holder_type,
            membershipId: d.membership_id ?? null,
            employeeId: d.employee_id ?? null,
            holderName: d.holder_name,
            holderEmail: d.holder_email || null,
            holderPhone: d.holder_phone || null,
            holderTimezone: d.holder_timezone ?? null,
            managerMembershipId: d.manager_membership_id ?? null,
            startsOn: d.starts_on ?? null,
            endsOn: d.ends_on ?? null,
          },
          userId,
        );
        await syncReceiptChase({ db, now: () => now }, orgId).catch(() => null);
        return NextResponse.json({ row, message: 'Saved.' });
      }
      case 'end':
        await endCardholder(db, orgId, params.id, userId, now);
        await syncReceiptChase({ db, now: () => now }, orgId).catch(() => null);
        return NextResponse.json({ message: 'Assignment ended. Their open charges now show “No cardholder”.' });
      case 'request_opt_out': {
        const row = await requestOptOut(db, orgId, params.id, userId, b.reason, now);
        return NextResponse.json({ row, message: 'Opt-out requested. Someone with approval rights has to confirm it.' });
      }
      case 'approve_opt_out': {
        const { assignment, paused } = await decideOptOut(db, orgId, params.id, userId, true, now);
        return NextResponse.json({ row: assignment, message: `Opted out. ${paused} open reminder${paused === 1 ? '' : 's'} stopped.` });
      }
      case 'reject_opt_out': {
        const { assignment } = await decideOptOut(db, orgId, params.id, userId, false, now);
        return NextResponse.json({ row: assignment, message: 'Opt-out rejected. Reminders continue.' });
      }
      case 'clear_opt_out': {
        const row = await clearOptOut(db, orgId, params.id, userId, now);
        await syncReceiptChase({ db, now: () => now }, orgId).catch(() => null);
        return NextResponse.json({ row, message: 'Receipt chase is back on for this cardholder.' });
      }
    }
  } catch (e) {
    if (e instanceof CardholderError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

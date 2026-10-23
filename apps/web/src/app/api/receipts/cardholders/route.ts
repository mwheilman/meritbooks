export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiHandler, apiQueryHandler } from '@/lib/api-handler';
import { assertWriteScope, isWriteScopeError, serviceWriter } from '@/lib/db/scoped-writer';
import { requirePermission } from '@/lib/rbac/require-permission';
import { CardholderError, createCardholder } from '@/lib/receipts/cardholders';
import { ASSIGNMENT_COLUMNS, syncReceiptChase } from '@/lib/receipts/chase';
import type { CardAssignmentRow } from '@/lib/receipts/types';
import { cardholderBody } from '@/lib/validations/receipts';

const listQuery = z.object({ location_id: z.string().uuid().optional(), include_ended: z.enum(['0', '1']).optional() });

/**
 * GET /api/receipts/cardholders — card assignments (receipts:view) with each one's open
 * receipt count. POST — add a cardholder (receipts:edit); the company is checked against
 * the caller's client scope, every referenced id against the org, then the service role
 * writes and the chase re-syncs so their charges are picked up right away.
 */
export const GET = apiQueryHandler(listQuery, async (q, { userId, orgId, supabase }) => {
  const guard = await requirePermission(userId, 'receipts', 'view', { route: '/api/receipts/cardholders' });
  if (!guard.ok) return guard.response;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });
  let query = supabase.from('card_assignments').select(ASSIGNMENT_COLUMNS).eq('org_id', orgId).order('holder_name', { ascending: true }).limit(500);
  if (q.location_id) query = query.eq('location_id', q.location_id);
  if (q.include_ended !== '1') query = query.eq('active', true);
  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const rows = (data ?? []) as CardAssignmentRow[];
  const counts = new Map<string, { open: number; cents: number }>();
  if (rows.length) {
    const { data: st } = await supabase
      .from('receipt_charge_states')
      .select('card_assignment_id, amount_cents')
      .eq('org_id', orgId)
      .in('card_assignment_id', rows.map((r) => r.id))
      .in('status', ['needed', 'requested']);
    for (const s of (st ?? []) as Array<{ card_assignment_id: string; amount_cents: number }>) {
      const c = counts.get(s.card_assignment_id) ?? { open: 0, cents: 0 };
      c.open++;
      c.cents += Number(s.amount_cents);
      counts.set(s.card_assignment_id, c);
    }
  }
  return NextResponse.json({ rows: rows.map((r) => ({ ...r, open_count: counts.get(r.id)?.open ?? 0, open_cents: counts.get(r.id)?.cents ?? 0 })) });
});

export const POST = apiHandler(cardholderBody, async (b, { userId, orgId, supabase }) => {
  const guard = await requirePermission(userId, 'receipts', 'edit', { route: '/api/receipts/cardholders' });
  if (!guard.ok) return guard.response;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });
  try {
    await assertWriteScope(supabase, orgId, [b.location_id]);
  } catch (e) {
    if (isWriteScopeError(e)) return NextResponse.json({ error: e.message }, { status: 403 });
    throw e;
  }
  const db = serviceWriter();
  try {
    const row = await createCardholder(
      db,
      orgId,
      {
        locationId: b.location_id,
        bankAccountId: b.bank_account_id ?? null,
        cardLast4: b.card_last4 ?? null,
        cardLabel: b.card_label ?? null,
        holderType: b.holder_type,
        membershipId: b.membership_id ?? null,
        employeeId: b.employee_id ?? null,
        holderName: b.holder_name,
        holderEmail: b.holder_email || null,
        holderPhone: b.holder_phone || null,
        holderTimezone: b.holder_timezone ?? null,
        managerMembershipId: b.manager_membership_id ?? null,
        startsOn: b.starts_on ?? null,
        endsOn: b.ends_on ?? null,
      },
      userId,
    );
    const sync = await syncReceiptChase({ db, now: () => new Date() }, orgId).catch(() => null);
    return NextResponse.json({ row, asked: sync?.created ?? 0 }, { status: 201 });
  } catch (e) {
    if (e instanceof CardholderError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
});

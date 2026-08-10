export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth, requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { createAdminSupabase } from '@/lib/supabase/server';
import { resolveOrgId } from '@/lib/posting/lifecycle';
import { PostingError } from '@/lib/posting/account-roles';
import {
  takeDeposit,
  listDeposits,
  remainingCents,
  type DepositRow,
} from '@/lib/customer-deposits/service';

/**
 * GET  /api/customer-deposits  — list deposits (+ per-customer outstanding roll-up)
 * POST /api/customer-deposits  — take a deposit (posts DR cash / CR 2420)
 *
 * Reads run under the RLS-scoped user client (tenant isolation at the DB). The
 * write resolves the tenant from the verified claim and posts through the shared
 * posting service — no parallel ledger path.
 *
 * Authorization: taking a deposit originates customer cash into AR, so it reuses
 * the AR-origination permission `invoices:create` (the closest existing gate;
 * no new permission invented).
 */

// ─── GET ────────────────────────────────────────────────────────────────────
export async function GET(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ data: [], customerRollup: [] });

  const { searchParams } = new URL(request.url);
  const locationId = searchParams.get('location_id') ?? undefined;
  const customerId = searchParams.get('customer_id') ?? undefined;
  const status = (searchParams.get('status') ?? undefined) as DepositRow['status'] | undefined;

  try {
    const deposits = await listDeposits(supabase, orgId, {
      locationId: locationId || undefined,
      customerId: customerId || undefined,
      status: status || undefined,
    });

    // Stitch customer / location / job names (cross-schema; no PostgREST embed).
    const customerIds = [...new Set(deposits.map((d) => d.customer_id))];
    const locationIds = [...new Set(deposits.map((d) => d.location_id))];
    const jobIds = [...new Set(deposits.map((d) => d.job_id).filter(Boolean))] as string[];

    const [custRes, locRes, jobRes] = await Promise.all([
      customerIds.length
        ? supabase.schema('core').from('customers').select('id, name').in('id', customerIds)
        : Promise.resolve({ data: [] as Record<string, unknown>[] }),
      locationIds.length
        ? supabase.schema('core').from('locations').select('id, name, short_code').in('id', locationIds)
        : Promise.resolve({ data: [] as Record<string, unknown>[] }),
      jobIds.length
        ? supabase.schema('core').from('jobs').select('id, job_number, name').in('id', jobIds)
        : Promise.resolve({ data: [] as Record<string, unknown>[] }),
    ]);

    const customerById = new Map((custRes.data ?? []).map((c) => [c.id as string, c]));
    const locationById = new Map((locRes.data ?? []).map((l) => [l.id as string, l]));
    const jobById = new Map((jobRes.data ?? []).map((j) => [j.id as string, j]));

    const rows = deposits.map((d) => {
      const c = customerById.get(d.customer_id);
      const l = locationById.get(d.location_id);
      const j = d.job_id ? jobById.get(d.job_id) : null;
      return {
        ...d,
        remainingCents: remainingCents(d),
        customerName: (c?.name as string) ?? 'Unknown customer',
        locationName: (l?.name as string) ?? null,
        locationCode: (l?.short_code as string) ?? null,
        jobLabel: j ? `${j.job_number ?? ''} ${j.name ?? ''}`.trim() : null,
      };
    });

    // Per-customer outstanding deposit-liability roll-up (open deposits only).
    const rollupMap = new Map<string, { customerId: string; customerName: string; outstandingCents: number; depositCount: number }>();
    for (const d of deposits) {
      if (d.status === 'APPLIED' || d.status === 'REFUNDED') continue;
      const name = (customerById.get(d.customer_id)?.name as string) ?? 'Unknown customer';
      const cur = rollupMap.get(d.customer_id) ?? { customerId: d.customer_id, customerName: name, outstandingCents: 0, depositCount: 0 };
      cur.outstandingCents += remainingCents(d);
      cur.depositCount += 1;
      rollupMap.set(d.customer_id, cur);
    }
    const customerRollup = [...rollupMap.values()].sort((a, b) => b.outstandingCents - a.outstandingCents);

    const totalOutstanding = customerRollup.reduce((s, r) => s + r.outstandingCents, 0);

    return NextResponse.json({ data: rows, customerRollup, totalOutstandingCents: totalOutstanding });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Failed to load deposits';
    return NextResponse.json({ error: msg, code: 'QUERY_ERROR' }, { status: 500 });
  }
}

// ─── POST ─────────────────────────────────────────────────────────────────
const takeSchema = z.object({
  location_id: z.string().uuid(),
  customer_id: z.string().uuid(),
  job_id: z.string().uuid().nullable().optional(),
  deposit_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amount_cents: z.number().int().positive(),
  memo: z.string().max(1000).nullable().optional(),
  currency: z.string().length(3).optional(),
  rail: z.enum(['cash', 'check', 'ach', 'wire', 'credit_card', 'debit_card']).optional(),
  undeposited: z.boolean().optional(),
});

export async function POST(request: Request): Promise<NextResponse> {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { userId, orgId: claimOrgId } = authResult;

  const guard = await requirePermission(userId, 'invoices', 'create');
  if (!guard.ok) return guard.response;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'PARSE_ERROR' }, { status: 400 });
  }
  const parsed = takeSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', code: 'VALIDATION_ERROR', details: parsed.error.flatten().fieldErrors },
      { status: 422 },
    );
  }

  try {
    const supabase = createAdminSupabase();
    const orgId = await resolveOrgId(supabase, claimOrgId);
    const b = parsed.data;
    const deposit = await takeDeposit(supabase, {
      orgId,
      actor: userId,
      locationId: b.location_id,
      customerId: b.customer_id,
      jobId: b.job_id ?? null,
      depositDate: b.deposit_date,
      amountCents: b.amount_cents,
      memo: b.memo ?? null,
      currency: b.currency,
      rail: b.rail,
      undeposited: b.undeposited,
    });
    return NextResponse.json({ data: deposit }, { status: 201 });
  } catch (e) {
    if (e instanceof PostingError) {
      return NextResponse.json({ error: e.message, code: 'POST_ERROR' }, { status: 422 });
    }
    console.error('[customer-deposits POST]', e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Internal server error', code: 'INTERNAL_ERROR' },
      { status: 500 },
    );
  }
}

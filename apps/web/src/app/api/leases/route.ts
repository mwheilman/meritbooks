export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext, apiHandler, type ApiContext } from '@/lib/api-handler';
import { createLeaseSchema, type CreateLeaseInput } from '@/lib/leases/schema';
import { persistLeaseWithSchedule } from '@/lib/leases/lease-posting';
import { PostingError } from '@/lib/posting/account-roles';
import { LeaseInputError } from '@/lib/leases/schedule';
import { linkSourceDocument } from '@/lib/documents/store-source';

/**
 * /api/leases
 *
 * GET  — list every lease with its posting progress (RLS-scoped, degrade-safe).
 * POST — on human CONFIRM, create the lease + its ASC 842 schedule. The schedule is
 *        computed server-side (source of truth); nothing posts to the GL yet — the
 *        monthly `record-period` action does that. apiHandler enforces auth + Zod;
 *        RLS enforces org isolation.
 */

const SELECT =
  'id, location_id, lessor, description, classification, commencement_date, end_date, ' +
  'payment_cents, payment_frequency, payment_timing, term_months, discount_rate, ' +
  'rou_asset_cents, liability_cents, status, periods_posted, notes, created_at, updated_at';

export async function GET(): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;

  const { data, error } = await ctx.supabase
    .from('leases')
    .select(SELECT)
    .order('created_at', { ascending: false });
  if (error) {
    console.error('[leases] list failed:', error.message);
    return NextResponse.json({ error: 'Failed to load leases', code: 'INTERNAL_ERROR' }, { status: 500 });
  }

  const rows = (data ?? []) as unknown as { term_months: number; periods_posted: number; status: string }[];
  const summary = {
    total: rows.length,
    active: rows.filter((r) => r.status === 'ACTIVE').length,
    ended: rows.filter((r) => r.status !== 'ACTIVE').length,
  };
  return NextResponse.json({ data: data ?? [], summary });
}

export const POST = apiHandler(
  createLeaseSchema,
  async (body: CreateLeaseInput, ctx: ApiContext): Promise<NextResponse> => {
    if (!ctx.orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

    try {
      const { leaseId, schedule } = await persistLeaseWithSchedule(ctx.supabase, ctx.orgId, ctx.userId, {
        lessor: body.lessor,
        description: body.description ?? null,
        locationId: body.location_id,
        classification: body.classification ?? 'OPERATING',
        commencementDate: body.commencement_date,
        endDate: body.end_date,
        paymentCents: body.payment_cents,
        frequency: body.payment_frequency ?? 'MONTHLY',
        paymentTiming: body.payment_timing ?? 'ARREARS',
        termMonths: body.term_months,
        discountRate: body.discount_rate,
        aiDecisionId: body.ai_decision_id ?? null,
        notes: body.notes ?? null,
      });

      // Link the retained drop-and-parse source lease doc (if any) so it surfaces on
      // the lease record's Documents panel. Best-effort — never fails the create.
      if (body.source_document_id) {
        await linkSourceDocument(ctx.supabase, body.source_document_id, 'lease', leaseId);
      }

      return NextResponse.json(
        {
          id: leaseId,
          liability_cents: schedule.liabilityCents,
          rou_asset_cents: schedule.rouAssetCents,
          periods: schedule.periods,
        },
        { status: 201 },
      );
    } catch (e) {
      if (e instanceof LeaseInputError) {
        return NextResponse.json({ error: e.message, code: 'INVALID_TERMS' }, { status: 400 });
      }
      if (e instanceof PostingError) {
        return NextResponse.json({ error: e.message, code: 'CREATE_FAILED' }, { status: 422 });
      }
      console.error('[leases] create failed:', e instanceof Error ? e.message : e);
      return NextResponse.json({ error: 'Failed to create lease', code: 'INTERNAL_ERROR' }, { status: 500 });
    }
  },
);

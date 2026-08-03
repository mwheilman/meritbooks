export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext, apiHandler, type ApiContext } from '@/lib/api-handler';
import { createPolicySchema, type CreatePolicyInput } from '@/lib/insurance/schema';
import { dueRenewals, type RenewablePolicy } from '@/lib/insurance/renewals';

/**
 * /api/insurance — the tenant's OWN insurance policy register.
 *
 * GET  — list every policy (RLS-scoped), plus a renewals summary (how many expire
 *        within the requested window). Read-only; degrade-safe (no policies → empty).
 * POST — define a policy. apiHandler enforces auth + Zod; RLS enforces org.
 *
 * Distinct from vendor COI compliance (`vendor_compliance_docs`) — this is the
 * company's own coverage. The AI drop-and-parse path only proposes; a row is written
 * solely through this gated create path.
 */

const SELECT =
  'id, location_id, carrier, policy_number, coverage_type, coverage_limit_cents, deductible_cents, ' +
  'premium_cents, premium_frequency, effective_date, expiration_date, status, broker, notes, ' +
  'created_at, updated_at';

const DEFAULT_WINDOW_DAYS = 60;

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function GET(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase } = ctx;

  const url = new URL(request.url);
  const windowParam = Number(url.searchParams.get('window_days'));
  const windowDays = Number.isFinite(windowParam) && windowParam > 0 ? Math.trunc(windowParam) : DEFAULT_WINDOW_DAYS;
  const asOf = url.searchParams.get('as_of') ?? todayIso();

  const { data, error } = await supabase
    .from('insurance_policies')
    .select(SELECT)
    .order('expiration_date', { ascending: true, nullsFirst: false });
  if (error) {
    console.error('[insurance] list failed:', error.message);
    return NextResponse.json({ error: 'Failed to load policies', code: 'INTERNAL_ERROR' }, { status: 500 });
  }

  const rows = (data ?? []) as unknown as (RenewablePolicy & Record<string, unknown>)[];
  const renewals = dueRenewals(rows, asOf, windowDays);

  const totalAnnualPremiumCents = rows.reduce((sum, p) => {
    if (p.status !== 'ACTIVE' || typeof p.premium_cents !== 'number') return sum;
    const factor: Record<string, number> = {
      ANNUAL: 1,
      SEMIANNUAL: 2,
      QUARTERLY: 4,
      MONTHLY: 12,
      ONE_TIME: 0,
    };
    return sum + p.premium_cents * (factor[p.premium_frequency] ?? 0);
  }, 0);

  const summary = {
    total: rows.length,
    active: rows.filter((p) => p.status === 'ACTIVE').length,
    renewalsDue: renewals.length,
    overdue: renewals.filter((r) => r.overdue).length,
    windowDays,
    asOf,
    totalAnnualPremiumCents,
  };

  return NextResponse.json({ data: rows, renewals, summary });
}

export const POST = apiHandler(
  createPolicySchema,
  async (body: CreatePolicyInput, ctx: ApiContext): Promise<NextResponse> => {
    if (!ctx.orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

    const { data, error } = await ctx.supabase
      .from('insurance_policies')
      .insert({
        org_id: ctx.orgId,
        location_id: body.location_id ?? null,
        carrier: body.carrier ?? null,
        policy_number: body.policy_number ?? null,
        coverage_type: body.coverage_type ?? 'OTHER',
        coverage_limit_cents: body.coverage_limit_cents ?? null,
        deductible_cents: body.deductible_cents ?? null,
        premium_cents: body.premium_cents ?? null,
        premium_frequency: body.premium_frequency ?? 'ANNUAL',
        effective_date: body.effective_date ?? null,
        expiration_date: body.expiration_date ?? null,
        status: body.status ?? 'ACTIVE',
        broker: body.broker ?? null,
        notes: body.notes ?? null,
        created_by_user: ctx.userId,
      })
      .select('id')
      .single();

    if (error) {
      console.error('[insurance] create failed:', error.message);
      return NextResponse.json({ error: error.message, code: 'CREATE_FAILED' }, { status: 500 });
    }
    return NextResponse.json({ id: (data as { id: string }).id }, { status: 201 });
  },
);

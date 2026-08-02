export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext, apiHandler, type ApiContext } from '@/lib/api-handler';
import { createSubscriptionSchema, type CreateSubscriptionInput } from '@/lib/subscriptions/schema';
import { summarizeCreep, subscriptionDedupKey, type CreepFlag, type BillingCadence } from '@/lib/subscriptions/detect';
import { dueRenewals, type RenewableSubscription } from '@/lib/subscriptions/renewals';

/**
 * /api/subscriptions — the tenant's OWN recurring subscription register + creep guard.
 *
 * GET  — list every subscription (RLS-scoped), plus a notice-period-aware renewals list
 *        and the creep summary (monthly/annual run-rate, new / price-hike / duplicate /
 *        stale counts). Read-only; degrade-safe (no subscriptions → empty).
 * POST — register a subscription MANUALLY (or confirm a parsed one). apiHandler enforces
 *        auth + Zod; RLS enforces org. Never posts to the GL; never cancels anything.
 */

const SELECT =
  'id, location_id, vendor_id, vendor_name, product, category, amount_cents, prior_amount_cents, ' +
  'billing_cadence, first_seen_date, last_charged_date, next_renewal_date, status, auto_renews, ' +
  'notice_period_days, cancellation_terms, cancellation_method, notes, source, creep_flags, ' +
  'charge_count, cancellation_draft, reviewed_at, created_at, updated_at';

const DEFAULT_WINDOW_DAYS = 60;

interface SubscriptionRow extends RenewableSubscription {
  creep_flags: CreepFlag[] | null;
  billing_cadence: BillingCadence;
  amount_cents: number | null;
}

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
    .from('subscriptions')
    .select(SELECT)
    .order('next_renewal_date', { ascending: true, nullsFirst: false });
  if (error) {
    console.error('[subscriptions] list failed:', error.message);
    return NextResponse.json({ error: 'Failed to load subscriptions', code: 'INTERNAL_ERROR' }, { status: 500 });
  }

  const rows = (data ?? []) as SubscriptionRow[];
  const renewals = dueRenewals(rows, asOf, windowDays);

  const summary = {
    ...summarizeCreep(
      rows.map((r) => ({
        billingCadence: r.billing_cadence,
        amountCents: r.amount_cents ?? 0,
        creepFlags: r.creep_flags ?? [],
        status: r.status,
      })),
    ),
    renewalsDue: renewals.length,
    noticePassed: renewals.filter((r) => r.noticeWindowPassed).length,
    windowDays,
    asOf,
  };

  return NextResponse.json({ data: rows, renewals, summary });
}

export const POST = apiHandler(
  createSubscriptionSchema,
  async (body: CreateSubscriptionInput, ctx: ApiContext): Promise<NextResponse> => {
    if (!ctx.orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

    const { data, error } = await ctx.supabase
      .from('subscriptions')
      .insert({
        org_id: ctx.orgId,
        location_id: body.location_id ?? null,
        vendor_id: body.vendor_id ?? null,
        vendor_name: body.vendor_name,
        product: body.product ?? null,
        category: body.category ?? null,
        amount_cents: body.amount_cents,
        billing_cadence: body.billing_cadence,
        first_seen_date: body.first_seen_date ?? null,
        last_charged_date: body.last_charged_date ?? null,
        next_renewal_date: body.next_renewal_date ?? null,
        status: body.status,
        auto_renews: body.auto_renews,
        notice_period_days: body.notice_period_days ?? null,
        cancellation_terms: body.cancellation_terms ?? null,
        cancellation_method: body.cancellation_method ?? null,
        notes: body.notes ?? null,
        source: body.source,
        // A manual entry keeps its own idempotency lane keyed on vendor+cadence.
        dedup_key: body.source === 'MANUAL' ? subscriptionDedupKey(body.vendor_name, body.billing_cadence) : null,
        created_by_user: ctx.userId,
      })
      .select('id')
      .single();

    if (error) {
      console.error('[subscriptions] create failed:', error.message);
      return NextResponse.json({ error: error.message, code: 'CREATE_FAILED' }, { status: 500 });
    }
    return NextResponse.json({ id: (data as { id: string }).id }, { status: 201 });
  },
);

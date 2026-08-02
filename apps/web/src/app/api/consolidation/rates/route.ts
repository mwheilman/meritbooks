export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiHandler, requireAuthedContext } from '@/lib/api-handler';

/**
 * FX-rate editor API (GATE 11a — multi-currency, migration 089).
 *
 *   GET    → the tenant's FX rate rows + the group reporting (home) currency + the
 *            set of functional currencies in use (best-effort; degrades safe).
 *   POST   → upsert one rate (currency pair + date + type + rate).
 *   DELETE → remove a rate row (?id=…).
 *
 * All routes are RLS-scoped (public.fx_rates org_isolation via get_org_id()). The
 * consolidation engine degrades safe — with no rows every entity is treated as
 * already in the reporting currency, so this table is purely additive configuration.
 */

const upsertSchema = z.object({
  id: z.string().uuid().optional(),
  from_currency: z.string().regex(/^[A-Za-z]{3}$/),
  to_currency: z.string().regex(/^[A-Za-z]{3}$/),
  rate_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  rate: z.number().positive(),
  rate_type: z.enum(['SPOT', 'AVERAGE', 'CLOSING']),
  notes: z.string().max(500).optional(),
});
type UpsertBody = z.infer<typeof upsertSchema>;

export async function GET() {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) {
    return NextResponse.json({ error: 'No organization in session', code: 'NO_ORG' }, { status: 400 });
  }

  // Reporting (home) currency.
  const { data: orgRows } = await supabase
    .schema('core')
    .from('organizations')
    .select('home_currency')
    .eq('id', orgId)
    .limit(1);
  const reportingCurrency =
    (orgRows?.[0] as { home_currency?: string } | undefined)?.home_currency || 'USD';

  // Functional currencies in use (best-effort; column may not exist yet).
  const functionalCurrencies = new Set<string>();
  let functionalCurrencyColumnAvailable = false;
  {
    const { data, error } = await supabase
      .schema('core')
      .from('locations')
      .select('functional_currency')
      .eq('org_id', orgId)
      .eq('is_active', true);
    if (!error && data) {
      functionalCurrencyColumnAvailable = true;
      for (const l of data as Array<{ functional_currency: string | null }>) {
        if (l.functional_currency) functionalCurrencies.add(l.functional_currency);
      }
    }
  }

  // Rate rows.
  let fxRatesAvailable = true;
  const { data: rows, error } = await supabase
    .from('fx_rates')
    .select('id, from_currency, to_currency, rate_date, rate, rate_type, notes')
    .eq('org_id', orgId)
    .order('rate_date', { ascending: false });
  if (error) fxRatesAvailable = false;

  return NextResponse.json({
    reportingCurrency,
    functionalCurrencies: Array.from(functionalCurrencies).sort(),
    functionalCurrencyColumnAvailable,
    fxRatesAvailable,
    rates: rows ?? [],
  });
}

export const POST = apiHandler(upsertSchema, async (body: UpsertBody, ctx) => {
  if (!ctx.orgId) {
    return NextResponse.json({ error: 'No organization in session', code: 'NO_ORG' }, { status: 400 });
  }
  const from = body.from_currency.toUpperCase();
  const to = body.to_currency.toUpperCase();
  if (from === to) {
    return NextResponse.json(
      { error: 'From and to currency must differ.', code: 'INVALID_PAIR' },
      { status: 422 },
    );
  }
  const row = {
    org_id: ctx.orgId,
    from_currency: from,
    to_currency: to,
    rate_date: body.rate_date ?? new Date().toISOString().slice(0, 10),
    rate: body.rate,
    rate_type: body.rate_type,
    notes: body.notes ?? null,
    created_by: null,
  };

  const query = body.id
    ? ctx.supabase.from('fx_rates').update(row).eq('id', body.id).eq('org_id', ctx.orgId).select('id').single()
    : ctx.supabase
        .from('fx_rates')
        .upsert(row, { onConflict: 'org_id,from_currency,to_currency,rate_date,rate_type' })
        .select('id')
        .single();

  const { data, error } = await query;
  if (error) {
    const code = /relation .* does not exist/i.test(error.message) ? 'MIGRATION_PENDING' : 'DB_ERROR';
    const status = code === 'MIGRATION_PENDING' ? 503 : 500;
    return NextResponse.json({ error: error.message, code }, { status });
  }
  return NextResponse.json({ id: data?.id, ok: true });
});

export async function DELETE(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) {
    return NextResponse.json({ error: 'No organization in session', code: 'NO_ORG' }, { status: 400 });
  }
  const id = new URL(request.url).searchParams.get('id');
  if (!id) {
    return NextResponse.json({ error: 'id is required', code: 'MISSING_ID' }, { status: 400 });
  }
  const { error } = await supabase.from('fx_rates').delete().eq('id', id).eq('org_id', orgId);
  if (error) {
    return NextResponse.json({ error: error.message, code: 'DB_ERROR' }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}

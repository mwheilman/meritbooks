export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiHandler, apiQueryHandler } from '@/lib/api-handler';
import { scopeQuery, settingsSchema } from '@/lib/validations/cash-forecast';
import { cashError, cashRouteCtx, cashWriter, logEvent } from '@/lib/cash/forecast/route-support';
import { companyInputs, loadBankAccounts, loadLiquidity, loadSettings } from '@/lib/cash/forecast/load';
import { availableLines } from '@/lib/cash/forecast/liquidity';

/**
 * /api/cash/settings — per-company cash assumptions (migration 192 cash_settings) and the
 * liquidity lines that make up headroom.
 *   GET ?location_id   every company in scope: effective settings (row or defaults, minimum falling
 *                      back to core.locations.minimum_cash_cents), configured lines, derived lines
 *   PUT {location_id, minimum_cash_cents, alerts_enabled, employer_tax_bps, estimated_tax_quarterly_cents,
 *        runrate_basis, include_unapproved_bills}   upsert one company's row
 * View = cash.forecast:view; write = cash.forecast:edit (service role after the client-scope assert).
 */
export const GET = apiQueryHandler(scopeQuery, async (q, ctx) => {
  const c = await cashRouteCtx(ctx, q.location_id, 'view');
  if (c instanceof NextResponse) return c;
  try {
    const ids = c.companies.map((x) => x.id);
    const [settings, banks] = await Promise.all([loadSettings(c.supabase, ids), loadBankAccounts(c.supabase, ids)]);
    const companies = companyInputs(c.companies, settings);
    const liq = await loadLiquidity(c.supabase, ids, banks);
    const { data: cfg } = await c.supabase
      .from('cash_liquidity_lines')
      .select('id, location_id, instrument_id, name, commitment_cents, borrowing_base_cents, drawn_cents, as_of_date, note, updated_at')
      .in('location_id', ids)
      .eq('is_active', true)
      .order('name');
    const { data: instruments } = await c.supabase.from('debt_instruments').select('id, name, location_id, instrument_type, status').eq('status', 'ACTIVE').in('location_id', ids);
    return NextResponse.json({
      companies: companies.map((x) => ({
        id: x.id,
        name: x.name,
        settings: x.settings,
        locationMinimumCents: c.companies.find((r) => r.id === x.id)?.minimumCashCents ?? 0,
      })),
      lines: availableLines(liq.rows, liq.banks, liq.instruments),
      configuredLines: cfg ?? [],
      instruments: instruments ?? [],
    });
  } catch (e) {
    return cashError(e, 'settings read');
  }
});

export const PUT = apiHandler(settingsSchema, async (body, ctx) => {
  const c = await cashRouteCtx(ctx, body.location_id, 'edit');
  if (c instanceof NextResponse) return c;
  try {
    const w = await cashWriter(c, [body.location_id]);
    const row = {
      org_id: c.orgId,
      location_id: body.location_id,
      minimum_cash_cents: body.minimum_cash_cents ?? null,
      alerts_enabled: body.alerts_enabled,
      employer_tax_bps: body.employer_tax_bps ?? null,
      estimated_tax_quarterly_cents: body.estimated_tax_quarterly_cents ?? null,
      runrate_basis: body.runrate_basis,
      include_unapproved_bills: body.include_unapproved_bills,
      updated_by: c.userId,
    };
    const { error } = await w.from('cash_settings').upsert(row, { onConflict: 'org_id,location_id' });
    if (error) throw new Error(error.message);
    await logEvent(w, c, 'SETTINGS_SAVED', body.location_id, null, { ...row, org_id: undefined });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return cashError(e, 'settings save');
  }
});

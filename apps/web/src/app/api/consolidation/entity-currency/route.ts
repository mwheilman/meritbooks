export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiHandler, requireAuthedContext } from '@/lib/api-handler';

/**
 * Entity functional-currency editor API (GATE 11a — multi-currency, migration 133).
 *
 *   GET  → each entity (core.locations) + its functional currency + the group
 *          reporting (home) currency. Degrades safe if the column is not present.
 *   POST → set (or clear) ONE entity's functional currency. NULL / empty = "same as
 *          the reporting currency" (single-currency default). Setting a code that
 *          differs from the reporting currency activates ASC 830 translation for
 *          that entity on the consolidated statements.
 *
 * RLS-scoped (core.locations org isolation). This is purely additive configuration:
 * absent any assignment the consolidation is byte-for-byte the prior single-currency
 * behavior. Never hardcodes a currency — the tenant defines its own set.
 */

const upsertSchema = z.object({
  entity_id: z.string().uuid(),
  // 3-letter code, or null / '' to clear back to the reporting currency.
  functional_currency: z
    .union([z.string().regex(/^[A-Za-z]{3}$/), z.literal(''), z.null()])
    .optional(),
});
type UpsertBody = z.infer<typeof upsertSchema>;

export async function GET() {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) {
    return NextResponse.json({ error: 'No organization in session', code: 'NO_ORG' }, { status: 400 });
  }

  // Reporting (home) currency = the group's default; entities with a NULL functional
  // currency are treated as already booked in it.
  const { data: orgRows } = await supabase
    .schema('core')
    .from('organizations')
    .select('home_currency')
    .eq('id', orgId)
    .limit(1);
  const reportingCurrency =
    (orgRows?.[0] as { home_currency?: string } | undefined)?.home_currency || 'USD';

  // Entities + functional currency. If the column is missing (migration 133 pending)
  // the select errors — degrade to name-only and flag it, so the UI can explain.
  let functionalCurrencyColumnAvailable = true;
  let entities: Array<{ id: string; name: string; shortCode: string | null; functionalCurrency: string | null }> = [];
  const withCol = await supabase
    .schema('core')
    .from('locations')
    .select('id, name, short_code, functional_currency')
    .eq('org_id', orgId)
    .eq('is_active', true)
    .order('name');
  if (withCol.error) {
    functionalCurrencyColumnAvailable = false;
    const { data } = await supabase
      .schema('core')
      .from('locations')
      .select('id, name, short_code')
      .eq('org_id', orgId)
      .eq('is_active', true)
      .order('name');
    entities = (data ?? []).map((l: Record<string, unknown>) => ({
      id: l.id as string,
      name: l.name as string,
      shortCode: (l.short_code as string) ?? null,
      functionalCurrency: null,
    }));
  } else {
    entities = (withCol.data ?? []).map((l: Record<string, unknown>) => ({
      id: l.id as string,
      name: l.name as string,
      shortCode: (l.short_code as string) ?? null,
      functionalCurrency: (l.functional_currency as string) ?? null,
    }));
  }

  return NextResponse.json({
    reportingCurrency,
    functionalCurrencyColumnAvailable,
    entities,
  });
}

export const POST = apiHandler(upsertSchema, async (body: UpsertBody, ctx) => {
  if (!ctx.orgId) {
    return NextResponse.json({ error: 'No organization in session', code: 'NO_ORG' }, { status: 400 });
  }
  const raw = body.functional_currency;
  const value = raw && raw.length === 3 ? raw.toUpperCase() : null; // '' / null / absent → clear

  const { error } = await ctx.supabase
    .schema('core')
    .from('locations')
    .update({ functional_currency: value })
    .eq('id', body.entity_id)
    .eq('org_id', ctx.orgId);

  if (error) {
    const code = /column .*functional_currency.* does not exist/i.test(error.message)
      ? 'MIGRATION_PENDING'
      : 'DB_ERROR';
    const status = code === 'MIGRATION_PENDING' ? 503 : 500;
    return NextResponse.json({ error: error.message, code }, { status });
  }
  return NextResponse.json({ ok: true, functionalCurrency: value });
});

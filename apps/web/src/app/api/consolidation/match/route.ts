export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireAuthedContext } from '@/lib/api-handler';
import { resolveRole, PostingError } from '@/lib/posting/account-roles';
import {
  proposeArApMatches,
  proposeRevExpMatches,
  type IcPosition,
} from '@/lib/consolidation/intercompany-match';

/**
 * Intercompany auto-match (GATE 11a) — read-only. Loads the tenant's intercompany
 * receivable/payable positions and eliminating interdept revenue/cost per entity &
 * period, then PROPOSES reciprocal pairs (AR↔AP, revenue↔cost) for a human to
 * confirm. It NEVER posts — the consolidation engine already eliminates by
 * role/flag; this is the reconciliation surface that shows which sides tie and
 * surfaces the unmatched residual an accountant must chase.
 *
 * RLS-scoped (the caller's user-scoped client). Degrades safe: unseeded roles or a
 * missing table simply yields fewer positions and empty proposals.
 */

const n = (v: number | string | null | undefined): number => Number(v) || 0;

function periodKeyOf(iso: string): string {
  return (iso || '').slice(0, 7);
}

interface LineRow {
  gl_entry_id: string;
  account_id: string;
  debit_cents: number | string;
  credit_cents: number | string;
  location_id: string;
}

async function fetchLines(
  supabase: SupabaseClient,
  accountIds: string[],
  entryIds: string[],
): Promise<LineRow[]> {
  const out: LineRow[] = [];
  if (accountIds.length === 0 || entryIds.length === 0) return out;
  for (let i = 0; i < entryIds.length; i += 500) {
    const slice = entryIds.slice(i, i + 500);
    const { data, error } = await supabase
      .from('gl_entry_lines')
      .select('gl_entry_id, account_id, debit_cents, credit_cents, location_id')
      .in('gl_entry_id', slice)
      .in('account_id', accountIds);
    if (error) continue;
    for (const row of (data ?? []) as LineRow[]) out.push(row);
  }
  return out;
}

export async function GET(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) {
    return NextResponse.json({ error: 'No organization in session', code: 'NO_ORG' }, { status: 400 });
  }
  const sinceDate = new URL(request.url).searchParams.get('since') || undefined;

  // Company names.
  const companyName = new Map<string, string>();
  {
    const { data: locs } = await supabase.schema('core').from('locations').select('id, name').eq('org_id', orgId);
    for (const l of (locs ?? []) as Array<{ id: string; name: string }>) companyName.set(l.id, l.name);
  }

  // Posted entries → id → {periodKey, locationId}.
  let entryQuery = supabase
    .from('gl_entries')
    .select('id, location_id, entry_date')
    .eq('org_id', orgId)
    .eq('status', 'POSTED');
  if (sinceDate) entryQuery = entryQuery.gte('entry_date', sinceDate);
  const { data: entriesRaw } = await entryQuery.limit(20000);
  const entries = (entriesRaw ?? []) as Array<{ id: string; location_id: string; entry_date: string }>;
  const entryMeta = new Map<string, { periodKey: string; locationId: string }>();
  for (const e of entries) entryMeta.set(e.id, { periodKey: periodKeyOf(e.entry_date), locationId: e.location_id });
  const entryIds = entries.map((e) => e.id);

  // Intercompany AR / AP roles.
  let icAr: string | null = null;
  let icAp: string | null = null;
  let intercompanyRolesResolved = false;
  try {
    icAr = (await resolveRole(supabase, orgId, 'INTERCOMPANY_AR')).id;
    icAp = (await resolveRole(supabase, orgId, 'INTERCOMPANY_AP')).id;
    intercompanyRolesResolved = true;
  } catch (e) {
    if (!(e instanceof PostingError)) {
      // non-role errors are swallowed; degrade to no interco positions
    }
  }

  const positions: IcPosition[] = [];

  // AR (due-from) / AP (due-to) positions per (entity, period).
  if (icAr && icAp) {
    const arAgg = new Map<string, number>(); // `${loc}:${pk}` → net due-from cents
    const apAgg = new Map<string, number>();
    const icLines = await fetchLines(supabase, [icAr, icAp], entryIds);
    for (const l of icLines) {
      const meta = entryMeta.get(l.gl_entry_id);
      if (!meta) continue;
      const key = `${l.location_id}:${meta.periodKey}`;
      if (l.account_id === icAr) {
        arAgg.set(key, (arAgg.get(key) ?? 0) + (n(l.debit_cents) - n(l.credit_cents)));
      } else {
        apAgg.set(key, (apAgg.get(key) ?? 0) + (n(l.credit_cents) - n(l.debit_cents)));
      }
    }
    for (const [key, cents] of arAgg) {
      if (cents <= 0) continue;
      const [locationId, periodKey] = key.split(':');
      positions.push({
        entityId: locationId,
        entityName: companyName.get(locationId) ?? 'Unknown',
        periodKey,
        side: 'AR',
        amountCents: cents,
      });
    }
    for (const [key, cents] of apAgg) {
      if (cents <= 0) continue;
      const [locationId, periodKey] = key.split(':');
      positions.push({
        entityId: locationId,
        entityName: companyName.get(locationId) ?? 'Unknown',
        periodKey,
        side: 'AP',
        amountCents: cents,
      });
    }
  }

  // Eliminating interdept REVENUE / COST positions per (entity, period).
  {
    const elimTypeById = new Map<string, string>();
    const { data: elimAccts } = await supabase
      .from('accounts')
      .select('id, account_type')
      .eq('org_id', orgId)
      .eq('is_eliminating', true);
    for (const a of (elimAccts ?? []) as Array<{ id: string; account_type: string }>) {
      elimTypeById.set(a.id, a.account_type);
    }
    if (elimTypeById.size > 0) {
      const revAgg = new Map<string, number>();
      const expAgg = new Map<string, number>();
      const elimLines = await fetchLines(supabase, Array.from(elimTypeById.keys()), entryIds);
      for (const l of elimLines) {
        const meta = entryMeta.get(l.gl_entry_id);
        if (!meta) continue;
        const key = `${l.location_id}:${meta.periodKey}`;
        const type = elimTypeById.get(l.account_id);
        if (type === 'REVENUE') {
          revAgg.set(key, (revAgg.get(key) ?? 0) + (n(l.credit_cents) - n(l.debit_cents)));
        } else {
          expAgg.set(key, (expAgg.get(key) ?? 0) + (n(l.debit_cents) - n(l.credit_cents)));
        }
      }
      for (const [key, cents] of revAgg) {
        if (cents <= 0) continue;
        const [locationId, periodKey] = key.split(':');
        positions.push({
          entityId: locationId,
          entityName: companyName.get(locationId) ?? 'Unknown',
          periodKey,
          side: 'REV',
          amountCents: cents,
        });
      }
      for (const [key, cents] of expAgg) {
        if (cents <= 0) continue;
        const [locationId, periodKey] = key.split(':');
        positions.push({
          entityId: locationId,
          entityName: companyName.get(locationId) ?? 'Unknown',
          periodKey,
          side: 'EXP',
          amountCents: cents,
        });
      }
    }
  }

  const arap = proposeArApMatches(positions);
  const revexp = proposeRevExpMatches(positions);

  return NextResponse.json({
    intercompanyRolesResolved,
    scanned: { entries: entries.length, positions: positions.length },
    arap,
    revexp,
  });
}

export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireAuthedContext } from '@/lib/api-handler';
import { resolveRole, PostingError } from '@/lib/posting/account-roles';
import {
  buildUnbilledAging,
  type UnbilledContribution,
  type UnbilledAgingResult,
} from '@/lib/reports/unbilled-aging';

/** Empty unbilled section — returned when 1180 is unmapped or carries no balance. */
const EMPTY_UNBILLED: UnbilledAgingResult = {
  rows: [],
  buckets: { CURRENT: 0, '1-30': 0, '31-60': 0, '61-90': 0, '90+': 0 },
  totalCents: 0,
  hasAttribution: false,
};

interface GlLineRow {
  debit_cents: number | null;
  credit_cents: number | null;
  job_id: string | null;
  gl_entries: { entry_date: string } | { entry_date: string }[] | null;
}

/**
 * Compute the unbilled-receivable (contract asset, acct 1180) aging directly from
 * POSTED gl_entry_lines — the SAME ledger the balance sheet reads, so it ties out.
 * DISTINCT from billed trade AR (which comes from the v_ar_aging invoice view and
 * is never touched here). Aged by the accrual's entry_date; attributed to the
 * job/customer the JE recorded, where present.
 */
async function computeUnbilled(
  db: SupabaseClient,
  orgId: string,
  asOf: string,
  locFilter: string[],
): Promise<UnbilledAgingResult> {
  // Resolve the contract-asset account BY ROLE (UNBILLED_RECEIVABLE → 1180). A
  // tenant that never mapped/seeded it simply has no unbilled receivable — an
  // empty section, not an error.
  let unbilledAccountId: string;
  try {
    const acct = await resolveRole(db, orgId, 'UNBILLED_RECEIVABLE');
    unbilledAccountId = acct.id;
  } catch (e) {
    if (e instanceof PostingError) return EMPTY_UNBILLED;
    throw e;
  }

  // Net debit balance on 1180, line by line, POSTED and dated on/before as-of.
  let q = db
    .from('gl_entry_lines')
    .select('debit_cents, credit_cents, job_id, gl_entries!inner(entry_date, status)')
    .eq('org_id', orgId)
    .eq('account_id', unbilledAccountId)
    .eq('gl_entries.status', 'POSTED')
    .lte('gl_entries.entry_date', asOf);
  if (locFilter.length === 1) q = q.eq('location_id', locFilter[0]);
  else if (locFilter.length > 1) q = q.in('location_id', locFilter);

  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const lines = (data ?? []) as GlLineRow[];
  if (lines.length === 0) return EMPTY_UNBILLED;

  // Attribution: resolve the job → (label, customer) for every job the lines hit.
  const jobIds = Array.from(new Set(lines.map((l) => l.job_id).filter((v): v is string => !!v)));
  const jobMap = new Map<string, { label: string; customerName: string | null }>();
  if (jobIds.length > 0) {
    const { data: jobs } = await db
      .schema('core')
      .from('jobs')
      .select('id, job_number, name, customer_id')
      .eq('org_id', orgId)
      .in('id', jobIds);
    const jobRows = (jobs ?? []) as { id: string; job_number: string | null; name: string | null; customer_id: string | null }[];
    const custIds = Array.from(new Set(jobRows.map((j) => j.customer_id).filter((v): v is string => !!v)));
    const custMap = new Map<string, string>();
    if (custIds.length > 0) {
      const { data: custs } = await db
        .schema('core')
        .from('customers')
        .select('id, name')
        .eq('org_id', orgId)
        .in('id', custIds);
      for (const c of (custs ?? []) as { id: string; name: string | null }[]) {
        custMap.set(c.id, c.name ?? 'Unnamed customer');
      }
    }
    for (const j of jobRows) {
      const label = [j.job_number, j.name].filter(Boolean).join(' · ') || 'Job';
      jobMap.set(j.id, { label, customerName: j.customer_id ? custMap.get(j.customer_id) ?? null : null });
    }
  }

  const contributions: UnbilledContribution[] = lines.map((l) => {
    const ge = Array.isArray(l.gl_entries) ? l.gl_entries[0] : l.gl_entries;
    const attribution = l.job_id ? jobMap.get(l.job_id) : undefined;
    return {
      customerName: attribution?.customerName ?? null,
      jobId: l.job_id,
      jobLabel: attribution?.label ?? null,
      entryDate: ge?.entry_date ?? asOf,
      netCents: Number(l.debit_cents ?? 0) - Number(l.credit_cents ?? 0),
    };
  });

  return buildUnbilledAging(contributions, asOf);
}

export async function GET(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  const { searchParams } = new URL(request.url);
  const locationIds = searchParams.get('location_ids');
  const locationId = searchParams.get('location_id');
  const locFilter = locationIds ? locationIds.split(',').filter(Boolean) : (locationId && locationId !== 'all' ? [locationId] : []);
  // The unbilled section ages by accrual month relative to an as-of date; default
  // to today (the billed view ages off CURRENT_DATE), overridable via end_date.
  const asOf = searchParams.get('end_date') || searchParams.get('as_of_date') || new Date().toISOString().slice(0, 10);

  // Defensive: exclude WRITTEN_OFF (and any settled) rows. A written-off invoice
  // has balance_cents = 0 (paid advanced to total), so `> 0` drops it from the
  // aging even before the v_ar_aging view is re-created to exclude WRITTEN_OFF.
  let query = supabase.from('v_ar_aging').select('*').gt('balance_cents', 0);
  if (locFilter.length === 1) query = query.eq('location_id', locFilter[0]);
  else if (locFilter.length > 1) query = query.in('location_id', locFilter);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const buckets: Record<string, { count: number; totalCents: number }> = {
    CURRENT: { count: 0, totalCents: 0 }, '1-30': { count: 0, totalCents: 0 },
    '31-60': { count: 0, totalCents: 0 }, '61-90': { count: 0, totalCents: 0 },
    '90+': { count: 0, totalCents: 0 },
  };
  for (const row of data ?? []) {
    const b = row.aging_bucket as string;
    if (buckets[b]) { buckets[b].count++; buckets[b].totalCents += Number(row.balance_cents ?? 0); }
  }

  // Unbilled receivable (contract asset) — a DISTINCT section, sourced from the GL
  // (not the invoice subledger). Best-effort: never let it break billed AR.
  let unbilled: UnbilledAgingResult = EMPTY_UNBILLED;
  if (orgId) {
    try {
      unbilled = await computeUnbilled(supabase as unknown as SupabaseClient, orgId, asOf, locFilter);
    } catch {
      unbilled = EMPTY_UNBILLED;
    }
  }

  const billedTotal = Object.values(buckets).reduce((s, b) => s + b.totalCents, 0);

  return NextResponse.json({
    data: (data ?? []).map((r) => ({
      customerName: r.customer_name, invoiceNumber: r.invoice_number,
      invoiceDate: r.invoice_date, dueDate: r.due_date,
      totalCents: Number(r.total_cents ?? 0), paidCents: Number(r.amount_paid_cents ?? 0),
      balanceCents: Number(r.balance_cents ?? 0), agingBucket: r.aging_bucket,
      locationName: r.location_name,
    })),
    buckets,
    totalOutstanding: billedTotal,
    // Distinct unbilled contract-asset section. Billed numbers above are unchanged.
    unbilled: {
      rows: unbilled.rows,
      buckets: unbilled.buckets,
      totalCents: unbilled.totalCents,
      hasAttribution: unbilled.hasAttribution,
    },
    asOf,
    totalReceivablesCents: billedTotal + unbilled.totalCents,
  });
}

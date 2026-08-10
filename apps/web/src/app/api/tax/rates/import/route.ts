export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { parseRateCsv, labelForRow } from '@/lib/tax/rate-provider/csv-import';

/**
 * Bulk sales-tax rate IMPORT (GATE 11d / live-adapter). Accepts raw CSV text
 * (state,county,city,postal,rate,effective_date [,category,end_date]); the server is
 * authoritative — it re-parses and validates with the SAME pure parser the UI previews
 * with, then inserts the valid rows into public.sales_tax_rates with source='IMPORT'.
 * RLS + settings_acct:edit. Returns per-row error lines so nothing is silently dropped.
 */

const schema = z.object({
  csv: z.string().min(1).max(2_000_000),
});

export async function POST(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, userId, orgId } = ctx;
  const guard = await requirePermission(userId, 'settings_acct', 'edit');
  if (!guard.ok) return guard.response;

  const raw = await request.json().catch(() => null);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 422 });
  }

  const { rows, errors, headers } = parseRateCsv(parsed.data.csv);
  if (rows.length === 0) {
    return NextResponse.json({ inserted: 0, skipped: errors.length, errors, headers }, { status: 422 });
  }

  const inserts = rows.map((r) => ({
    org_id: orgId ?? '',
    country: 'US',
    state: r.state,
    county: r.county,
    city: r.city,
    postal_code: r.postal_code,
    category: r.category,
    jurisdiction_label: labelForRow(r),
    combined_rate_pct: r.combined_rate_pct,
    effective_date: r.effective_date,
    end_date: r.end_date,
    is_active: true,
    source: 'IMPORT' as const,
    created_by: userId,
  }));

  const { error } = await supabase.from('sales_tax_rates').insert(inserts);
  if (error) return NextResponse.json({ error: error.message, headers }, { status: 500 });

  return NextResponse.json({ inserted: inserts.length, skipped: errors.length, errors, headers }, { status: 201 });
}

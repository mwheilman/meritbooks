export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { normalizeState } from '@/lib/tax/sales-tax-calc';

/**
 * Sales-tax rate admin (GATE 11d). RLS-scoped list/add of the tenant's effective-dated
 * combined-rate rows that drive tax-at-invoice-creation. Reads require settings_acct:view,
 * writes settings_acct:edit (defense-in-depth on top of RLS org isolation).
 */

interface RateRow {
  id: string;
  country: string | null;
  state: string | null;
  county: string | null;
  city: string | null;
  postal_code: string | null;
  category: string | null;
  jurisdiction_label: string | null;
  combined_rate_pct: number | string | null;
  effective_date: string | null;
  end_date: string | null;
  is_active: boolean | null;
  source: string | null;
  notes: string | null;
  created_at: string | null;
}

export async function GET() {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, userId, orgId } = ctx;
  const guard = await requirePermission(userId, 'settings_acct', 'view');
  if (!guard.ok) return guard.response;

  const { data, error } = await supabase
    .from('sales_tax_rates')
    .select('id, country, state, county, city, postal_code, category, jurisdiction_label, combined_rate_pct, effective_date, end_date, is_active, source, notes, created_at')
    .eq('org_id', orgId ?? '')
    .order('state', { ascending: true })
    .order('effective_date', { ascending: false })
    .limit(2000);

  // Degrade-safe: the table is a RESERVED-migration addition; until applied, return
  // an empty list rather than a 500 so the settings screen still renders.
  if (error) return NextResponse.json({ data: [], unavailable: true, error: error.message });

  const rows = (data ?? []) as RateRow[];
  return NextResponse.json({
    data: rows.map((r) => ({
      id: r.id,
      country: r.country ?? 'US',
      state: r.state,
      county: r.county,
      city: r.city,
      postalCode: r.postal_code,
      category: r.category,
      jurisdictionLabel: r.jurisdiction_label,
      combinedRatePct: Number(r.combined_rate_pct) || 0,
      effectiveDate: r.effective_date,
      endDate: r.end_date,
      isActive: r.is_active !== false,
      source: r.source ?? 'MANUAL',
      notes: r.notes,
      createdAt: r.created_at,
    })),
  });
}

const createSchema = z.object({
  state: z.string().min(2).max(40),
  county: z.string().max(80).optional().nullable(),
  city: z.string().max(80).optional().nullable(),
  postal_code: z.string().max(12).optional().nullable(),
  category: z.string().max(60).optional().nullable(),
  jurisdiction_label: z.string().max(120).optional().nullable(),
  combined_rate_pct: z.number().min(0).max(30),
  effective_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  notes: z.string().max(500).optional().nullable(),
});

export async function POST(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, userId, orgId } = ctx;
  const guard = await requirePermission(userId, 'settings_acct', 'edit');
  if (!guard.ok) return guard.response;

  const raw = await request.json().catch(() => null);
  const parsed = createSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 422 });
  }
  const b = parsed.data;
  const state = normalizeState(b.state);
  if (!state) return NextResponse.json({ error: `"${b.state}" is not a recognized US state.` }, { status: 422 });

  const city = b.city?.trim() || null;
  const county = b.county?.trim() || null;
  const postalCode = b.postal_code?.trim() || null;
  const category = b.category?.trim() || null;
  const label =
    b.jurisdiction_label?.trim() ||
    [postalCode, city, county ? `${county} County` : null, state].filter(Boolean).join(', ');

  const { data, error } = await supabase
    .from('sales_tax_rates')
    .insert({
      org_id: orgId ?? '',
      country: 'US',
      state,
      county,
      city,
      postal_code: postalCode,
      category,
      jurisdiction_label: label,
      combined_rate_pct: b.combined_rate_pct,
      effective_date: b.effective_date,
      end_date: b.end_date ?? null,
      is_active: true,
      source: 'MANUAL',
      notes: b.notes?.trim() || null,
      created_by: userId,
    })
    .select('id')
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ id: data.id }, { status: 201 });
}

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { normalizeState } from '@/lib/tax/sales-tax-return';

/**
 * Mark a sales-tax period FILED / REMITTED (records only — never posts a remittance
 * JE or moves money). One record per org+jurisdiction+period; a repeat upsert updates
 * the remitted amount / status. RLS org isolation + settings_acct:edit defense-in-depth.
 *
 * Degrades SAFE: if the public.sales_tax_filings table has not been applied yet, the
 * write fails and this returns a clear 503 so the calendar still renders (read side is
 * unaffected — it simply shows every period as unfiled).
 */

const upsertSchema = z.object({
  jurisdiction: z.string().min(2).max(40),
  period_key: z.string().min(4).max(16), // 'YYYY-MM' | 'YYYY-Qn' | 'YYYY'
  frequency: z.enum(['monthly', 'quarterly', 'annual']),
  period_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  period_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  status: z.enum(['FILED', 'REMITTED']).optional(),
  remitted_cents: z.number().int().min(0).optional(),
  collected_cents: z.number().int().min(0).optional().nullable(),
  filed_at: z.string().optional().nullable(),
  confirmation_number: z.string().max(120).optional().nullable(),
  notes: z.string().max(500).optional().nullable(),
});

export async function POST(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, userId, orgId } = ctx;
  const guard = await requirePermission(userId, 'settings_acct', 'edit');
  if (!guard.ok) return guard.response;

  const raw = await request.json().catch(() => null);
  const parsed = upsertSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 422 });
  }
  const b = parsed.data;
  const state = normalizeState(b.jurisdiction);
  if (!state) return NextResponse.json({ error: `"${b.jurisdiction}" is not a recognized US state.` }, { status: 422 });

  const status = b.status ?? 'FILED';
  const row = {
    org_id: orgId ?? '',
    jurisdiction: state,
    period_key: b.period_key,
    frequency: b.frequency,
    period_start: b.period_start,
    period_end: b.period_end,
    due_date: b.due_date,
    status,
    remitted_cents: b.remitted_cents ?? 0,
    collected_cents: b.collected_cents ?? null,
    filed_at: b.filed_at ?? new Date().toISOString(),
    confirmation_number: b.confirmation_number?.trim() || null,
    notes: b.notes?.trim() || null,
    created_by: userId,
    updated_at: new Date().toISOString(),
  };

  // Upsert on the natural key (org, jurisdiction, period) so re-marking updates.
  const { data, error } = await supabase
    .from('sales_tax_filings')
    .upsert(row, { onConflict: 'org_id,jurisdiction,period_key' })
    .select('id')
    .single();

  if (error) {
    // Table not applied yet (RESERVED migration) → degrade with a clear signal.
    const undefinedTable = /relation .*sales_tax_filings.* does not exist/i.test(error.message);
    return NextResponse.json(
      {
        error: undefinedTable
          ? 'Filing records are not enabled yet (sales_tax_filings migration pending). The calendar still computes due dates and amounts owed.'
          : error.message,
        code: undefinedTable ? 'FILINGS_UNAVAILABLE' : 'FILING_UPSERT_FAILED',
      },
      { status: undefinedTable ? 503 : 500 },
    );
  }
  return NextResponse.json({ id: data.id }, { status: 201 });
}

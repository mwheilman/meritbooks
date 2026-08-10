export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { toDebitPositive, type NormalBalance } from '@/lib/reports/basis/apply-adjustments';

/**
 * Reporting-basis adjustment CRUD (list + create).
 *
 * These rows (public.reporting_basis_adjustments, migration 147) are report-presentation
 * deltas layered on the GAAP trial balance to present a TAX / CASH / CUSTOM basis. They are
 * NOT journal entries and NEVER post to the GL — the accrual ledger stays the single book of
 * record (CANON GATE 2). Reads run under RLS (org isolation by the DB). Writes are gated on
 * `journal_entries:create` — the same guard the book-to-tax tagging surface uses; a tag /
 * presentation adjustment is a reporting dimension, not money movement.
 *
 * GET  /api/basis-adjustments?basis=TAX&period_year=2026[&period_month=6][&location_ids=…]
 * POST /api/basis-adjustments   { basis, period_year, period_month?, account_id, amount_cents, … }
 */

const BASES = ['TAX', 'CASH', 'CUSTOM'] as const;
const ADJ_TYPES = ['TIMING', 'PERMANENT', 'RECLASS'] as const;

const listSchema = z.object({
  basis: z.enum(BASES).optional(),
  period_year: z.coerce.number().int().min(1900).max(2200).optional(),
  period_month: z.coerce.number().int().min(1).max(12).optional(),
  location_ids: z.string().optional(),
});

const createSchema = z.object({
  basis: z.enum(BASES),
  custom_label: z.string().max(120).optional().nullable(),
  period_year: z.number().int().min(1900).max(2200),
  period_month: z.number().int().min(1).max(12).nullable().optional(),
  location_id: z.string().uuid().nullable().optional(),
  account_id: z.string().uuid(),
  description: z.string().max(500).optional().nullable(),
  amount_cents: z.number().int(),
  adjustment_type: z.enum(ADJ_TYPES).nullable().optional(),
});

interface AdjRow {
  id: string;
  basis: string;
  custom_label: string | null;
  period_year: number;
  period_month: number | null;
  location_id: string | null;
  account_id: string;
  description: string | null;
  amount_cents: number;
  adjustment_type: string | null;
  source: string;
  created_at: string;
}

interface AccountMetaRow {
  id: string;
  account_number: string;
  name: string;
  account_type: string;
  normalBalance: NormalBalance;
}

/** Fetch account number / name / normal-balance for a set of account ids (RLS-scoped). */
async function loadAccountMeta(
  supabase: SupabaseClient,
  accountIds: string[],
): Promise<Map<string, AccountMetaRow>> {
  const map = new Map<string, AccountMetaRow>();
  if (accountIds.length === 0) return map;
  const { data } = await supabase
    .from('accounts')
    .select(`
      id,
      account_number,
      name,
      account_type,
      account_groups!inner(
        account_sub_types!inner(
          account_types!inner( normal_balance )
        )
      )
    `)
    .in('id', accountIds);
  for (const a of (data ?? []) as unknown as Array<Record<string, unknown>>) {
    const groups = a.account_groups as Record<string, unknown>;
    const subTypes = groups?.account_sub_types as Record<string, unknown>;
    const types = subTypes?.account_types as Record<string, unknown>;
    const nb = (types?.normal_balance as string) === 'CREDIT' ? 'CREDIT' : 'DEBIT';
    map.set(a.id as string, {
      id: a.id as string,
      account_number: (a.account_number as string) ?? '',
      name: (a.name as string) ?? '',
      account_type: (a.account_type as string) ?? '',
      normalBalance: nb,
    });
  }
  return map;
}

export async function GET(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization found', code: 'NO_ORG' }, { status: 400 });

  const { searchParams } = new URL(request.url);
  const parsed = listSchema.safeParse(Object.fromEntries(searchParams.entries()));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid query parameters', code: 'VALIDATION_ERROR', details: parsed.error.flatten() }, { status: 422 });
  }
  const { basis, period_year, period_month, location_ids } = parsed.data;

  let query = supabase
    .from('reporting_basis_adjustments')
    .select('id, basis, custom_label, period_year, period_month, location_id, account_id, description, amount_cents, adjustment_type, source, created_at');
  if (basis) query = query.eq('basis', basis);
  if (period_year != null) query = query.eq('period_year', period_year);
  // month filter: when a month is given, include month-specific rows for it PLUS whole-year
  // (period_month IS NULL) rows; when omitted, return all months + whole-year for the year.
  if (period_month != null) {
    query = query.or(`period_month.eq.${period_month},period_month.is.null`);
  }
  const locFilter = (location_ids ?? '').split(',').filter(Boolean);
  if (locFilter.length === 1) query = query.eq('location_id', locFilter[0]);
  else if (locFilter.length > 1) query = query.in('location_id', locFilter);

  const { data, error } = await query.order('created_at', { ascending: false });
  if (error) return NextResponse.json({ error: error.message, code: 'QUERY_ERROR' }, { status: 500 });

  const rows = (data ?? []) as AdjRow[];
  const meta = await loadAccountMeta(supabase, [...new Set(rows.map((r) => r.account_id))]);

  let netDebitPositiveCents = 0;
  const enriched = rows.map((r) => {
    const m = meta.get(r.account_id);
    const nb: NormalBalance = m?.normalBalance ?? 'DEBIT';
    netDebitPositiveCents += toDebitPositive(Number(r.amount_cents), nb);
    return {
      id: r.id,
      basis: r.basis,
      customLabel: r.custom_label,
      periodYear: r.period_year,
      periodMonth: r.period_month,
      locationId: r.location_id,
      accountId: r.account_id,
      accountNumber: m?.account_number ?? '',
      accountName: m?.name ?? '(unknown account)',
      accountType: m?.account_type ?? '',
      normalBalance: nb,
      description: r.description,
      amountCents: Number(r.amount_cents),
      adjustmentType: r.adjustment_type,
      source: r.source,
      createdAt: r.created_at,
    };
  });

  return NextResponse.json({
    data: {
      adjustments: enriched,
      summary: {
        count: enriched.length,
        netDebitPositiveCents,
        balances: netDebitPositiveCents === 0,
      },
    },
  });
}

export async function POST(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization found', code: 'NO_ORG' }, { status: 400 });

  const guard = await requirePermission(userId, 'journal_entries', 'create');
  if (!guard.ok) return guard.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'PARSE_ERROR' }, { status: 400 });
  }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: parsed.error.flatten() }, { status: 422 });
  }
  const p = parsed.data;
  if (p.amount_cents === 0) {
    return NextResponse.json({ error: 'A zero adjustment has no effect.', code: 'ZERO_AMOUNT' }, { status: 422 });
  }

  const { data, error } = await supabase
    .from('reporting_basis_adjustments')
    .insert({
      org_id: orgId,
      basis: p.basis,
      custom_label: p.basis === 'CUSTOM' ? (p.custom_label ?? null) : null,
      period_year: p.period_year,
      period_month: p.period_month ?? null,
      location_id: p.location_id ?? null,
      account_id: p.account_id,
      description: p.description ?? null,
      amount_cents: p.amount_cents,
      adjustment_type: p.adjustment_type ?? null,
      source: 'MANUAL',
      created_by: userId,
    })
    .select('id')
    .single();
  if (error) return NextResponse.json({ error: error.message, code: 'INSERT_ERROR' }, { status: 500 });

  return NextResponse.json({ data: { id: data?.id, ok: true } });
}

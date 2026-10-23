export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiQueryHandler } from '@/lib/api-handler';
import { getOrgToday } from '@/lib/dates/org-today';
import { monthBoundsIso } from '@/lib/dates/org-date';
import { fetchAll } from '@/lib/supabase/fetch-all';
import {
  buildPnlByDimension,
  type DimensionLine,
  type DimensionValue,
  type PnlAccountType,
} from '@/lib/reports/pnl-by-dimension';

/**
 * GET /api/reports/pnl-by-dimension?dimension=department|class
 *
 * The P&L split into one column per department (or class), plus "Unassigned" and a
 * Total that equals the plain P&L (/api/reports/income-statement) for the same
 * period and clients. Reads POSTED gl_entry_lines through the caller's RLS client,
 * paged (fetchAll) so nothing truncates; the split math is pure
 * (lib/reports/pnl-by-dimension). Accrual basis (the cash presentation overlay is
 * not applied to split columns yet — the screen says so).
 */

const querySchema = z.object({
  dimension: z.enum(['department', 'class']),
  location_id: z.string().optional(),
  location_ids: z.string().optional(),
  start_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  end_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

const ACCOUNT_TYPES: readonly PnlAccountType[] = ['REVENUE', 'COGS', 'OPEX', 'OTHER'];

type Row = Record<string, unknown>;
const rec = (v: unknown): Row => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Row) : {});

export const GET = apiQueryHandler(querySchema, async (params, ctx) => {
  const month = monthBoundsIso(await getOrgToday(ctx.supabase, ctx.orgId));
  const startDate = params.start_date ?? month.start;
  const endDate = params.end_date ?? month.end;
  const dimCol = params.dimension === 'department' ? 'department_id' : 'class_id';

  const locationIds: string[] = [];
  if (params.location_ids) locationIds.push(...params.location_ids.split(',').filter(Boolean));
  else if (params.location_id && params.location_id !== 'all') locationIds.push(params.location_id);

  const buildQuery = () => {
    let q = ctx.supabase
      .from('gl_entry_lines')
      .select(
        `
        account_id,
        debit_cents,
        credit_cents,
        location_id,
        department_id,
        class_id,
        accounts!inner(
          account_number,
          name,
          account_type,
          account_groups!inner(
            name,
            display_order,
            account_sub_types!inner(
              account_types!inner(
                normal_balance
              )
            )
          )
        ),
        gl_entries!inner(
          entry_date,
          status
        )
      `,
      )
      .eq('gl_entries.status', 'POSTED')
      .gte('gl_entries.entry_date', startDate)
      .lte('gl_entries.entry_date', endDate)
      .in('accounts.account_type', [...ACCOUNT_TYPES]);
    if (locationIds.length === 1) q = q.eq('location_id', locationIds[0]);
    else if (locationIds.length > 1) q = q.in('location_id', locationIds);
    return q;
  };

  const { data, error } = await fetchAll<Row>(buildQuery, { label: 'pnl-by-dimension gl_entry_lines' });
  if (error) {
    console.error('[pnl-by-dimension] query error:', error.message);
    return NextResponse.json({ error: error.message, code: 'QUERY_ERROR' }, { status: 500 });
  }

  const lines: DimensionLine[] = [];
  for (const r of data ?? []) {
    const acct = rec(r.accounts);
    const group = rec(acct.account_groups);
    const acctType = rec(rec(group.account_sub_types).account_types);
    const type = String(acct.account_type ?? '') as PnlAccountType;
    if (!ACCOUNT_TYPES.includes(type)) continue;
    const dim = r[dimCol];
    lines.push({
      accountId: String(r.account_id ?? ''),
      accountNumber: String(acct.account_number ?? ''),
      accountName: String(acct.name ?? ''),
      accountType: type,
      groupName: String(group.name ?? ''),
      groupOrder: Number(group.display_order ?? 0),
      normalBalance: acctType.normal_balance === 'CREDIT' ? 'CREDIT' : 'DEBIT',
      dimensionId: typeof dim === 'string' && dim ? dim : null,
      debitCents: Number(r.debit_cents ?? 0),
      creditCents: Number(r.credit_cents ?? 0),
    });
  }

  // Active dimension values (so a department with no activity still shows a column).
  // departments live in core; classes in public.
  const valuesRes =
    params.dimension === 'department'
      ? await ctx.supabase.schema('core').from('departments').select('id, name').eq('is_active', true)
      : await ctx.supabase.from('classes').select('id, name').eq('is_active', true);
  const activeValues = ((valuesRes.data ?? []) as Array<{ id: string; name: string | null }>).map<DimensionValue>((v) => ({
    id: v.id,
    name: v.name ?? 'Unnamed',
  }));
  // Names for inactive values still carried on lines.
  const known = new Set(activeValues.map((v) => v.id));
  const missing = Array.from(new Set(lines.map((l) => l.dimensionId).filter((x): x is string => !!x && !known.has(x))));
  let values = activeValues;
  if (missing.length > 0) {
    const extra =
      params.dimension === 'department'
        ? await ctx.supabase.schema('core').from('departments').select('id, name').in('id', missing)
        : await ctx.supabase.from('classes').select('id, name').in('id', missing);
    values = [
      ...activeValues,
      ...((extra.data ?? []) as Array<{ id: string; name: string | null }>).map((v) => ({ id: v.id, name: `${v.name ?? 'Unnamed'} (inactive)` })),
    ];
  }
  // A department list can be long; only keep columns with activity, plus Unassigned.
  const used = new Set(lines.map((l) => l.dimensionId).filter((x): x is string => !!x));
  const report = buildPnlByDimension(
    params.dimension,
    lines,
    values.filter((v) => used.has(v.id)),
  );

  return NextResponse.json({
    ...report,
    filters: { startDate, endDate, locationIds: locationIds.length > 0 ? locationIds : ['all'], basis: 'accrual' },
    activeValueCount: activeValues.length,
  });
});

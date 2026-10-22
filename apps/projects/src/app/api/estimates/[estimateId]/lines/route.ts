export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { route } from '@/lib/api';
import { one, pm } from '@/lib/pm/db';
import { estimateLineValues } from '@/lib/pm/money/estimate-lines';
import { ESTIMATE_LINE_COLS } from '@/lib/pm/money/queries';
import { wrote } from '@/lib/pm/money/rpc';
import { Cents, PosCents, Qty, Text200, Uuid } from '@/lib/pm/money/schemas';
import type { EstimateLineRow } from '@/lib/pm/money/types';

const Markup = z.number().min(-0.99).max(10);
const Fields = {
  costCodeId: Uuid.nullish(),
  description: Text200.optional(),
  qty: Qty.nullish(),
  uom: z.string().trim().max(16).nullish(),
  unitCostCents: PosCents.nullish(),
  unitPriceCents: PosCents.nullish(),
  markupPct: Markup.nullish(),
  costCents: PosCents.nullish(),
  amountCents: Cents.nullish(),
  isAllowance: z.boolean().optional(),
};

const Body = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add_line'), ...Fields }),
  // 1108: hours on a labor rate card; the trigger prices it (unit cost = estimating rate,
  // cost = hours × cost rate, so the budget never carries overhead)
  z.object({
    op: z.literal('add_labor_line'),
    rateCardId: Uuid,
    hours: Qty,
    costCodeId: Uuid.nullish(),
    description: Text200.optional(),
    unitPriceCents: PosCents.nullish(),
    isAllowance: z.boolean().optional(),
  }),
  z.object({ op: z.literal('update_line'), lineId: Uuid, ...Fields }),
  z.object({ op: z.literal('remove_line'), lineId: Uuid }),
]);

/**
 * Draft estimate lines (member-writable while DRAFT; the line-guard trigger locks the rest).
 * Cost and amount are extended here with the trigger's rounding so the editor's totals are the
 * database's totals.
 */
export const POST = route({ access: { cap: 'projects.estimates', action: 'edit' }, mask: 'estimate', body: Body }, async ({ db, params, body }) => {
  const est = one<{ id: string; status: string }>(await pm(db).from('estimates').select('id, status').eq('id', params.estimateId!).maybeSingle(), 'estimate');
  if (!est) throw new HttpError(404, 'That estimate was not found in this workspace.', 'NOT_FOUND');
  if (est.status !== 'DRAFT') throw new HttpError(422, 'Lines can change only while the estimate is a draft. Revise it to make changes.', 'PM_ESTIMATE_LOCKED');

  if (body.op === 'remove_line') {
    wrote(await pm(db).from('estimate_lines').delete().eq('id', body.lineId).eq('estimate_id', est.id).select('id'), 'estimate');
    return { ok: true };
  }

  if (body.op === 'add_labor_line') {
    const last = one<{ sort: number; line_no: number }>(
      await pm(db).from('estimate_lines').select('sort, line_no').eq('estimate_id', est.id).order('sort', { ascending: false }).limit(1).maybeSingle(),
      'last line',
    );
    const inserted = wrote<{ id: string }>(
      await pm(db).from('estimate_lines').insert({
        estimate_id: est.id, sort: (last?.sort ?? -1) + 1, line_no: (last?.line_no ?? 0) + 1,
        labor_rate_card_id: body.rateCardId, labor_hours: body.hours, cost_code_id: body.costCodeId ?? null,
        description: body.description ?? '', unit_price_cents: body.unitPriceCents ?? null, is_allowance: body.isAllowance ?? false,
      }).select('id').single(),
      'estimate',
    );
    // Cost columns are masked by role (migration 1110): read them back through the masked view.
    const line = one<{ id: string; cost_cents: number | null; amount_cents: number; unit_cost_cents: number | null }>(
      await pm(db).from('v_estimate_lines_masked').select('id, cost_cents, amount_cents, unit_cost_cents').eq('id', inserted.id).maybeSingle(),
      'estimate line',
    ) ?? { id: inserted.id, cost_cents: null, amount_cents: 0, unit_cost_cents: null };
    return { lineId: line.id, cost_cents: line.cost_cents, amount_cents: line.amount_cents, unit_cost_cents: line.unit_cost_cents };
  }

  const prev = body.op === 'update_line'
    ? one<EstimateLineRow>(await pm(db).from('v_estimate_lines_masked').select(ESTIMATE_LINE_COLS).eq('id', body.lineId).eq('estimate_id', est.id).maybeSingle(), 'line')
    : null;
  if (body.op === 'update_line' && !prev) throw new HttpError(404, 'That line was not found on this estimate.', 'NOT_FOUND');

  // A labor line is priced by its rate card: hours, price per hour, cost code, words only.
  if (body.op === 'update_line' && prev?.labor_rate_card_id) {
    const patch: Record<string, unknown> = {};
    if (body.qty !== undefined) {
      if (body.qty == null) throw new HttpError(422, 'A labor line needs its hours.', 'VALIDATION');
      patch.labor_hours = body.qty;
    }
    if (body.unitPriceCents !== undefined) patch.unit_price_cents = body.unitPriceCents ?? null;
    if (body.costCodeId !== undefined) patch.cost_code_id = body.costCodeId ?? null;
    if (body.description !== undefined) patch.description = body.description || '';
    if (body.isAllowance !== undefined) patch.is_allowance = body.isAllowance;
    if (!Object.keys(patch).length) throw new HttpError(422, 'A labor line’s cost comes from its rate card. Change the hours or the price per hour.', 'VALIDATION');
    wrote(await pm(db).from('estimate_lines').update(patch).eq('id', prev.id).select('id'), 'estimate');
    return { lineId: prev.id };
  }

  const pick = <K extends keyof typeof body>(k: K, fallback: unknown) => (body[k] !== undefined ? body[k] : fallback);
  const qty = pick('qty', prev?.qty != null ? String(prev.qty) : null) as string | null;
  const prevMarkup = typeof prev?.ext?.markup_pct === 'number' ? (prev.ext.markup_pct as number) : null;
  // a pricing input changed → derive price and amount again; otherwise keep what is stored
  const repriced = body.qty !== undefined || body.unitCostCents !== undefined || body.costCents !== undefined || body.markupPct !== undefined;
  const v = estimateLineValues({
    qty,
    unitCostCents: pick('unitCostCents', prev?.unit_cost_cents ?? null) as number | null,
    unitPriceCents: body.unitPriceCents !== undefined ? body.unitPriceCents ?? null : repriced ? null : prev?.unit_price_cents ?? null,
    markupPct: pick('markupPct', prevMarkup) as number | null,
    costCents: qty ? null : (pick('costCents', prev?.cost_cents ?? null) as number | null),
    amountCents: body.amountCents !== undefined ? body.amountCents ?? null : repriced || !prev ? null : prev.amount_cents,
  });
  const row = {
    cost_code_id: pick('costCodeId', prev?.cost_code_id ?? null),
    description: (pick('description', prev?.description ?? '') as string) || '',
    qty: v.qty,
    uom: pick('uom', prev?.uom ?? null),
    unit_cost_cents: v.unit_cost_cents,
    unit_price_cents: v.unit_price_cents,
    cost_cents: v.cost_cents,
    amount_cents: v.amount_cents,
    is_allowance: pick('isAllowance', prev?.is_allowance ?? false),
    ext: { ...(prev?.ext ?? {}), markup_pct: v.markup },
  };

  if (body.op === 'update_line') {
    wrote(await pm(db).from('estimate_lines').update(row).eq('id', prev!.id).select('id'), 'estimate');
    return { lineId: prev!.id, ...v };
  }
  const last = one<{ sort: number; line_no: number }>(
    await pm(db).from('estimate_lines').select('sort, line_no').eq('estimate_id', est.id).order('sort', { ascending: false }).limit(1).maybeSingle(),
    'last line',
  );
  const line = wrote<{ id: string }>(
    await pm(db).from('estimate_lines').insert({ ...row, estimate_id: est.id, sort: (last?.sort ?? -1) + 1, line_no: (last?.line_no ?? 0) + 1 }).select('id').single(),
    'estimate',
  );
  return { lineId: line.id, ...v };
});

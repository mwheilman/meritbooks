export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { xcall, xone, xrows } from '@/lib/dealer/rpc';

export interface PriceFileLineOut {
  id: string;
  line_no: number;
  part_number: string;
  description: string | null;
  category: string | null;
  list_price_cents: number | null;
  cost_cents: number | null;
  supersedes_to: string | null;
  action: 'NEW' | 'CHANGED' | 'UNCHANGED' | 'SUPERSEDED' | 'INVALID';
  old_list_cents: number | null;
  old_cost_cents: number | null;
  old_price_cents: number | null;
  new_price_cents: number | null;
  margin_pct: number | null;
  below_floor: boolean;
  error: string | null;
  applied: boolean;
}

const Q = z.object({ action: z.enum(['NEW', 'CHANGED', 'UNCHANGED', 'SUPERSEDED', 'INVALID', 'BELOW_FLOOR']).optional(), page: z.coerce.number().int().min(0).max(1000).default(0) });

/** A staged file's lines: what changes, by how much, what supersedes, what falls under the margin floor. */
export const GET = route({ access: { cap: 'projects.store', action: 'view' }, mask: 'part', query: Q }, async ({ db, params, query }) => {
  const pm = db.schema('pm');
  const file = await xone<{ id: string; location_id: string; manufacturer: string; file_name: string; status: string; summary: Record<string, number>; effective_on: string; row_count: number }>(
    pm.from('dlr_price_files').select('id, location_id, manufacturer, file_name, status, summary, effective_on, row_count').eq('id', params.fileId!).maybeSingle(), 'price file', 'That price file was not found.');
  // dlr_price_file_lines carries masked cost columns: read the masked view (1110 masks).
  let q = pm.from('v_dlr_price_file_lines_masked').select('id, line_no, part_number, description, category, list_price_cents, cost_cents, supersedes_to, action, old_list_cents, old_cost_cents, old_price_cents, new_price_cents, margin_pct, below_floor, error, applied')
    .eq('file_id', file.id).order('line_no').range(query.page * 200, query.page * 200 + 199);
  if (query.action === 'BELOW_FLOOR') q = q.eq('below_floor', true); else if (query.action) q = q.eq('action', query.action);
  const lines = await xrows<PriceFileLineOut>(q, 'price file lines');
  return { file, lines: lines.map((l) => ({ ...l, margin_pct: l.margin_pct == null ? null : Number(l.margin_pct) })), page: query.page };
});

const Op = z.discriminatedUnion('op', [z.object({ op: z.literal('apply') }), z.object({ op: z.literal('discard') })]);

/** Apply (store approve or financials edit; the database checks) or discard a staged file. */
export const POST = route({ access: { cap: 'projects.store', action: 'edit' }, mask: 'part', body: Op }, async ({ db, params, body }) => {
  if (body.op === 'apply') return xcall(db, 'dlr_apply_price_file', { p_file: params.fileId! });
  return { id: await xcall<string>(db, 'dlr_discard_price_file', { p_file: params.fileId! }) };
});

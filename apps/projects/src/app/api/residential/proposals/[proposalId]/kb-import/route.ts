export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { HttpError } from '@/lib/api-errors';
import { pm } from '@/lib/pm/db';
import { KB_SOURCES, parseKbFile } from '@/lib/residential/kb-import';
import { resRpc, resWrote } from '@/lib/residential/rpc';
import { Text, Uuid } from '@/lib/residential/schemas';

export interface KbImportRow { id: string; source: string; file_name: string | null; room: string | null; status: string; line_count: number; matched_count: number; applied_lines: number; created_at: string }
export interface KbLineRow { id: string; import_id: string; line_no: number; sku: string; description: string; qty: number; uom: string; finish: string | null; room: string | null;
  list_price_cents: number | null; unit_cost_cents: number | null; catalog_item_id: string | null; match_kind: string }

/** Cabinet-list imports on a proposal (RES-23), each with its lines (cost through the masked view). */
export const GET = route({ access: { cap: 'projects.estimates', action: 'view' }, mask: ['estimate'] }, async ({ db, params }) => {
  const imports = resWrote<KbImportRow[]>(await pm(db).from('res_kb_imports').select('id, source, file_name, room, status, line_count, matched_count, applied_lines, created_at')
    .eq('proposal_id', params.proposalId!).order('created_at', { ascending: false }).limit(20));
  const ids = imports.map((i) => i.id);
  const lines = ids.length ? resWrote<KbLineRow[]>(await pm(db).from('v_res_kb_import_lines_masked')
    .select('id, import_id, line_no, sku, description, qty, uom, finish, room, list_price_cents, unit_cost_cents, catalog_item_id, match_kind').in('import_id', ids).order('line_no')) : [];
  return { imports, lines };
});

const Body = z.discriminatedUnion('op', [
  z.object({ op: z.literal('stage'), fileName: Text(255).min(1), text: z.string().min(1).max(5_000_000), source: z.enum(KB_SOURCES).nullish(), room: Text(80).nullish() }),
  z.object({ op: z.literal('map'), lineId: Uuid, catalogItemId: Uuid.nullable(), remember: z.boolean().default(true) }),
  z.object({ op: z.literal('apply'), importId: Uuid, optionId: Uuid.nullish(), markupPct: z.number().min(0).max(10).nullish(), costCodeId: Uuid.nullish() }),
  z.object({ op: z.literal('discard'), importId: Uuid }),
]);

/** stage parses the 2020 / Cabinet Vision / ProKitchen file here and maps SKUs in the database; map / apply / discard follow. */
export const POST = route({ access: { cap: 'projects.estimates', action: 'edit' }, mask: ['estimate'], body: Body }, async ({ db, params, body }) => {
  switch (body.op) {
    case 'stage': {
      const parsed = parseKbFile(body.fileName, body.text, body.source ?? null);
      if (parsed.lines.length === 0) throw new HttpError(422, parsed.issues[0]?.message ?? 'No cabinet lines were found in that file.', 'PM_INVALID');
      const r = await resRpc<{ import_id: string; lines: number; matched: number; unmatched: number }>(db, 'res_stage_kb_import',
        { p_proposal: params.proposalId!, p_source: parsed.source, p_file_name: body.fileName, p_lines: parsed.lines, p_room: body.room ?? null });
      return { ...r, issues: parsed.issues, source: parsed.source };
    }
    case 'map': return resRpc(db, 'res_map_kb_line', { p_line: body.lineId, p_catalog_item: body.catalogItemId, p_remember: body.remember });
    case 'apply': return resRpc(db, 'res_apply_kb_import', { p_import: body.importId, p_option: body.optionId ?? null, p_markup: body.markupPct ?? null, p_cost_code: body.costCodeId ?? null });
    case 'discard': return { importId: await resRpc<string>(db, 'res_discard_kb_import', { p_import: body.importId }) };
  }
});

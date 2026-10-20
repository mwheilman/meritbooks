export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { apiQueryHandler } from '@/lib/api-handler';
import { dealerAction } from '@/lib/dealer/route';
import { DEALER_PERMS } from '@/lib/dealer/service/context';
import { DealerError, dbFail } from '@/lib/dealer/service/errors';
import { loadSettings } from '@/lib/dealer/service/settings';
import type { StatementMatchStatus } from '@/lib/dealer/types';

/**
 * GET /api/dealer/statement-detail?locationId=&id= — read-only (slice D2-B).
 * One lender statement / floor check for the reconciliation workspace: the header,
 * its line, per-lane totals (count, lender $, Books $, |variance| $), how many
 * variances are over the client's tolerance (DL-8), and the open "record the sale"
 * tasks (lender coded sold-and-unpaid; Books still shows the note OPEN). The lines
 * themselves page through GET /api/dealer/lender-statements/lines.
 * RLS client only; org + client pinned explicitly.
 */
const query = z.object({ locationId: z.string().uuid(), id: z.string().uuid() });

const STATUSES: StatementMatchStatus[] = ['UNMATCHED', 'MATCHED', 'VARIANCE', 'LENDER_ONLY', 'BOOKS_ONLY', 'RESOLVED'];
const PAGE = 1000;
const MAX_LINES = 20_000;

interface AggLine {
  id: string;
  match_status: StatementMatchStatus;
  current_cents: number | string | null;
  variance_cents: number | string;
  sau_flag: boolean;
  matched_note_id: string | null;
}

export const GET = apiQueryHandler(
  query,
  dealerAction<z.infer<typeof query>>(DEALER_PERMS.view, async (b, d) => {
    const st = await d.db.from('lender_statements').select('*').eq('org_id', d.orgId).eq('location_id', d.locationId).eq('id', b.id).maybeSingle();
    if (st.error) dbFail('Statement lookup failed', st.error);
    if (!st.data) throw new DealerError('NOT_FOUND', 'Lender statement not found for this client');
    const statement = st.data as Record<string, unknown> & { line_id: string };

    const [lineRes, settings] = await Promise.all([
      d.db.from('floor_plan_lines').select('id, name, lender_vendor_id, sau_codes, status').eq('org_id', d.orgId).eq('location_id', d.locationId).eq('id', statement.line_id).maybeSingle(),
      loadSettings(d),
    ]);
    if (lineRes.error) dbFail('Line lookup failed', lineRes.error);

    const lines: AggLine[] = [];
    for (let from = 0; from < MAX_LINES; from += PAGE) {
      const r = await d.db
        .from('lender_statement_lines')
        .select('id, match_status, current_cents, variance_cents, sau_flag, matched_note_id')
        .eq('org_id', d.orgId)
        .eq('location_id', d.locationId)
        .eq('statement_id', b.id)
        .order('id')
        .range(from, from + PAGE - 1);
      if (r.error) dbFail('Statement lines lookup failed', r.error);
      const chunk = (r.data ?? []) as AggLine[];
      lines.push(...chunk);
      if (chunk.length < PAGE) break;
    }

    const tol = settings.statement_tolerance_cents;
    const lanes = Object.fromEntries(STATUSES.map((s) => [s, { count: 0, lenderCents: 0, booksCents: 0, absVarianceCents: 0 }])) as Record<
      StatementMatchStatus,
      { count: number; lenderCents: number; booksCents: number; absVarianceCents: number }
    >;
    let overToleranceCount = 0;
    for (const l of lines) {
      const lane = lanes[l.match_status];
      if (!lane) continue;
      const current = l.current_cents === null ? 0 : Number(l.current_cents);
      const variance = Number(l.variance_cents);
      lane.count += 1;
      lane.lenderCents += current;
      lane.booksCents += l.match_status === 'BOOKS_ONLY' ? variance : l.matched_note_id ? current - variance : 0;
      lane.absVarianceCents += Math.abs(variance);
      if (l.match_status === 'VARIANCE' && Math.abs(variance) > tol) overToleranceCount += 1;
    }

    const sauLines = lines.filter((l) => l.sau_flag && l.matched_note_id);
    let sauOpenNoteIds: Array<{ lineId: string; noteId: string }> = [];
    if (sauLines.length) {
      const noteIds = [...new Set(sauLines.map((l) => l.matched_note_id as string))].slice(0, 500);
      const n = await d.db.from('floor_plan_notes').select('id, status').eq('org_id', d.orgId).eq('location_id', d.locationId).in('id', noteIds);
      if (n.error) dbFail('Note lookup failed', n.error);
      const open = new Set(((n.data ?? []) as { id: string; status: string }[]).filter((x) => x.status === 'OPEN').map((x) => x.id));
      sauOpenNoteIds = sauLines.filter((l) => open.has(l.matched_note_id as string)).map((l) => ({ lineId: l.id, noteId: l.matched_note_id as string }));
    }

    const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
    return {
      statement: {
        ...statement,
        footer_principal_cents: num(statement.footer_principal_cents),
        footer_interest_cents: num(statement.footer_interest_cents),
        footer_fees_cents: num(statement.footer_fees_cents),
      },
      line: lineRes.data ?? null,
      lanes,
      overToleranceCount,
      sauOpenNoteIds,
      toleranceCents: tol,
    };
  }),
);

export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { apiQueryHandler } from '@/lib/api-handler';
import { dealerAction } from '@/lib/dealer/route';
import { DEALER_PERMS } from '@/lib/dealer/service/context';
import { dbFail } from '@/lib/dealer/service/errors';
import { cleanIds } from '@/lib/dealer/lookups';

/**
 * GET /api/dealer/note-refs?locationId=&ids=a,b — read-only (slice D2-B).
 * Resolves floor-plan note ids to the few fields a queue row needs (lender invoice #,
 * line, status, balance, payoff due) plus the unit's serial/model, so curtailment,
 * payoff, accrual and statement rows can show what they are about. RLS client only
 * (tenant + client scope enforced by the database); org + client pinned explicitly.
 * → { data: { items: NoteRef[] } }
 */
const query = z.object({
  locationId: z.string().uuid(),
  ids: z.string().max(8000),
});

interface NoteRefRow {
  id: string;
  line_id: string;
  program_id: string | null;
  unit_id: string | null;
  lender_invoice_number: string;
  status: string;
  floored_date: string;
  original_principal_cents: number | string;
  principal_balance_cents: number | string;
  sold_date: string | null;
  payoff_due_date: string | null;
}

export const GET = apiQueryHandler(
  query,
  dealerAction<z.infer<typeof query>>(DEALER_PERMS.view, async (b, d) => {
    const ids = cleanIds(b.ids).slice(0, 100);
    if (ids.length === 0) return { items: [] };
    const notes = await d.db
      .from('floor_plan_notes')
      .select('id, line_id, program_id, unit_id, lender_invoice_number, status, floored_date, original_principal_cents, principal_balance_cents, sold_date, payoff_due_date')
      .eq('org_id', d.orgId)
      .eq('location_id', d.locationId)
      .in('id', ids);
    if (notes.error) dbFail('Note lookup failed', notes.error);
    const rows = (notes.data ?? []) as NoteRefRow[];
    const unitIds = [...new Set(rows.map((r) => r.unit_id).filter((x): x is string => !!x))];
    const units = unitIds.length
      ? await d.db.from('dealer_units').select('id, serial_number, model').eq('org_id', d.orgId).eq('location_id', d.locationId).in('id', unitIds)
      : { data: [], error: null };
    if (units.error) dbFail('Unit lookup failed', units.error);
    const unitById = new Map(((units.data ?? []) as { id: string; serial_number: string; model: string | null }[]).map((u) => [u.id, u]));
    return {
      items: rows.map((r) => ({
        ...r,
        original_principal_cents: Number(r.original_principal_cents),
        principal_balance_cents: Number(r.principal_balance_cents),
        serial_number: r.unit_id ? unitById.get(r.unit_id)?.serial_number ?? null : null,
        model: r.unit_id ? unitById.get(r.unit_id)?.model ?? null : null,
      })),
    };
  }),
);

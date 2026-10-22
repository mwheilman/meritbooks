export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { route } from '@/lib/api';
import { rows } from '@/lib/pm/db';
import { call, own, write } from '@/lib/pm/ops/rpc';
import { loadSelectionDetail } from '@/lib/pm/ops/selection-queries';
import { Cents, Day, MethodZ, Need, Qty, Text, Uuid } from '@/lib/pm/ops/schemas';

const OptionFields = z.object({
  label: Need(120, 'Name the option'),
  description: Text(2000).nullish(),
  vendorSku: Text(80).nullish(),
  qty: Qty.default(1),
  uom: Text(12).nullish(),
  unitCostCents: Cents.nullish(),
  markupPct: z.number().min(0).max(100).nullish(),
  unitPriceCents: Cents.nullish(),
  freightCents: Cents.default(0),
  leadTimeDays: z.number().int().min(0).max(3650).nullish(),
  isRecommended: z.boolean().default(false),
});

const Op = z.discriminatedUnion('op', [
  z.object({ op: z.literal('update'), category: Need(80, 'Pick a category').optional(), title: Need(200, 'Name the decision').optional(), description: Text(2000).nullish(), allowanceCents: Cents.nullish(), dueOn: Day.nullish() }),
  OptionFields.extend({ op: z.literal('add_option') }),
  z.object({ op: z.literal('remove_option'), optionId: Uuid }),
  z.object({ op: z.literal('propose') }),
  z.object({ op: z.literal('approve'), optionId: Uuid.nullish(), approverName: Need(200, 'Who approved it?'), method: MethodZ.default('IN_PERSON'), approverEmail: z.string().trim().email().max(200).nullish().or(z.literal('')), comment: Text(2000).nullish() }),
  z.object({ op: z.literal('reject'), approverName: Need(200, 'Who declined it?'), method: MethodZ.default('IN_PERSON'), comment: Text(2000).nullish() }),
  z.object({ op: z.literal('void'), reason: Need(300, 'Say why it is void') }),
  z.object({ op: z.literal('procure'), vendorId: Uuid.nullish() }),
  z.object({ op: z.literal('delete') }),
]);

export const GET = route({ access: { cap: 'projects.selections', action: 'view' }, mask: 'selection' }, async ({ db, params }) => {
  const d = await loadSelectionDetail(db, params.selectionId!);
  if (!d) throw new HttpError(404, 'That selection was not found.', 'NOT_FOUND');
  return d;
});

export const POST = route({ access: { cap: 'projects.selections', action: 'edit' }, ops: { approve: { cap: 'projects.selections', action: 'approve' }, reject: { cap: 'projects.selections', action: 'approve' } }, mask: 'selection', body: Op }, async ({ db, params, body }) => {
  const s = await own<{ id: string; status: string }>(db, 'selections', 'id, status', { id: params.selectionId! }, 'That selection was not found.');
  const pm = db.schema('pm');
  switch (body.op) {
    case 'update': {
      const patch: Record<string, unknown> = {};
      if (body.category !== undefined) patch.category = body.category;
      if (body.title !== undefined) patch.title = body.title;
      if (body.description !== undefined) patch.description = body.description || null;
      if (body.allowanceCents !== undefined) patch.allowance_cents = body.allowanceCents;
      if (body.dueOn !== undefined) patch.due_on = body.dueOn;
      if (!Object.keys(patch).length) throw new HttpError(422, 'Nothing to change.', 'VALIDATION');
      await write(pm.from('selections').update(patch).eq('id', s.id).select('id'), 'update selection');
      return { ok: true };
    }
    case 'add_option': {
      const last = rows<{ sort: number }>(await pm.from('selection_options').select('sort').eq('selection_id', s.id).order('sort', { ascending: false }).limit(1), 'last option');
      if (body.unitPriceCents == null && (body.unitCostCents == null || body.markupPct == null)) {
        throw new HttpError(422, 'Give the sell price, or the cost and a markup.', 'VALIDATION');
      }
      await write(
        pm.from('selection_options').insert({
          selection_id: s.id, sort: (last[0]?.sort ?? -1) + 1, label: body.label, description: body.description || null, vendor_sku: body.vendorSku || null,
          qty: body.qty, uom: body.uom || 'EA', unit_cost_cents: body.unitCostCents ?? null, markup_pct: body.markupPct ?? null,
          unit_price_cents: body.unitPriceCents ?? null, freight_cents: body.freightCents, lead_time_days: body.leadTimeDays ?? null, is_recommended: body.isRecommended,
        }).select('id'),
        'add option',
      );
      return { ok: true };
    }
    case 'remove_option':
      await write(pm.from('selection_options').delete().eq('id', body.optionId).eq('selection_id', s.id).select('id'), 'remove option');
      return { ok: true };
    case 'propose':
      await call(db, 'propose_selection', { p_selection: s.id });
      return { ok: true };
    case 'approve': {
      const id = await call<string>(db, 'approve_selection', {
        p_selection: s.id, p_option: body.optionId ?? null, p_approver_name: body.approverName, p_method: body.method,
        p_approver_email: body.approverEmail || null, p_comment: body.comment || null, p_signature_document: null, p_approver_customer: null,
      });
      return { ok: true, clientApprovalId: id };
    }
    case 'reject':
      await call(db, 'reject_selection', { p_selection: s.id, p_approver_name: body.approverName, p_comment: body.comment || null, p_method: body.method });
      return { ok: true };
    case 'void':
      await call(db, 'void_selection', { p_selection: s.id, p_reason: body.reason });
      return { ok: true };
    case 'procure': {
      const id = await call<string>(db, 'create_procurement_from_selection', { p_selection: s.id, p_vendor: body.vendorId ?? null });
      return { ok: true, itemId: id };
    }
    case 'delete':
      if (s.status !== 'OPEN') throw new HttpError(422, 'Only an open selection can be deleted. Void it instead.', 'VALIDATION');
      await write(pm.from('selections').delete().eq('id', s.id).select('id'), 'delete selection');
      return { ok: true };
  }
});

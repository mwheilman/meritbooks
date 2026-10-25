export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { HttpError } from '@/lib/api-errors';
import { dwrite } from '@/lib/pm/dealer/rpc';
import { inList, xcall, xrows } from '@/lib/dealer/rpc';
import { sendCustomerMessage } from '@/lib/notify/emit';
import { IsoDate, Pct, PosCents, Qty, Req, Text, Uuid, UuidList } from '@/lib/dealer/schemas';

export const COMPONENT_KINDS = ['ITEM', 'FRAME', 'COM_FABRIC', 'WORKROOM', 'FINISH', 'HARDWARE', 'FREIGHT', 'OTHER'] as const;

/**
 * A design project in one read: items by room (client price masked to contract value), their
 * components with vendor, sidemark and the 8 procurement dates, proposals and decisions, deposits
 * per item, and the fee agreement with what has been billed.
 */
export const GET = route({ access: { cap: 'projects.selections', action: 'view' }, mask: ['estimate', 'billing', 'commitment'] }, async ({ db, params }) => {
  const job = params.jobId!;
  const pm = db.schema('pm');
  const items = await xrows<{ id: string } & Record<string, unknown>>(pm.from('v_dsn_items_masked').select('id, wbs_id, room, doc_code, name, category, description, image_url, vendor_url, qty, is_placeholder, budget_cents, client_unit_price_cents, client_total_cents, deposit_pct, client_visible, show_cost_to_client, status, decided_by_name, decided_at, client_comment, internal_notes, sort').eq('job_id', job).order('room').order('sort'), 'items');
  const [components, proposals, deposits, moves, agreement, ledger] = await Promise.all([
    xrows<Record<string, unknown>>(pm.from('v_procurement_items_masked').select('id, dsn_item_id, component_kind, description, vendor_id, vendor_sku, sidemark, qty, uom, unit_cost_cents, markup_pct, status, po_number, commitment_id, ordered_on, shipped_on, expected_on, install_on, client_deposit_on, vendor_deposit_on, client_balance_on, vendor_balance_on, dates_done, tracking_ref, received_condition, freight_claim_open').in('dsn_item_id', inList(items.map((i) => i.id))).order('created_at'), 'components'),
    xrows<{ id: string } & Record<string, unknown>>(pm.from('dsn_proposals').select('id, number, version, title, status, sent_at, closed_at').eq('job_id', job).order('sent_at', { ascending: false }), 'proposals'),
    xrows<Record<string, unknown>>(pm.from('v_dsn_item_deposits').select('item_id, name, room, deposit_request_id, request_status, invoice_number, required_cents, allocated_cents, held_cents').eq('job_id', job), 'deposits'),
    xrows<Record<string, unknown>>(pm.from('dsn_deposit_moves').select('id, from_item_id, to_item_id, cents, reason, books_state, created_at').eq('job_id', job).order('created_at', { ascending: false }), 'deposit moves'),
    pm.from('dsn_fee_agreements').select('fee_model, hourly_rate_cents, rate_groups, phases, pct_of_budget, budget_cents, procurement_fee_pct, reimbursable_markup_pct, retainer_cents, retainer_evergreen').eq('job_id', job).maybeSingle().then((r) => r.data),
    xrows<Record<string, unknown>>(pm.from('dsn_fee_ledger').select('id, billing_request_id, kind, key, cents, created_at').eq('job_id', job).order('created_at', { ascending: false }), 'fee ledger'),
  ]);
  const proposalItems = proposals.length
    ? await xrows<Record<string, unknown>>(pm.from('v_dsn_proposal_items_masked').select('id, proposal_id, item_id, client_price_cents, deposit_cents, decision, comment, decided_by_name, decided_method, decided_at').in('proposal_id', proposals.map((p) => p.id)), 'proposal items')
    : [];
  return { items, components, proposals, proposalItems, deposits, moves, agreement, ledger };
});

const Item = z.object({ room: Req(120, 'The room'), name: Req(200, 'The item name'), docCode: Text(30).nullish(), category: Text(60).nullish(), description: Text(2000).nullish(), qty: z.number().positive().max(1e6).default(1), isPlaceholder: z.boolean().default(false), budgetCents: PosCents.nullish(), clientUnitPriceCents: PosCents.nullish(), depositPct: Pct.default(0.5), imageUrl: z.string().url().startsWith('https://').nullish(), vendorUrl: z.string().url().startsWith('https://').nullish(), clientVisible: z.boolean().default(true) });

const Op = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add_item'), item: Item }),
  z.object({ op: z.literal('update_item'), itemId: Uuid, item: Item.partial() }),
  z.object({ op: z.literal('add_component'), itemId: Uuid, kind: z.enum(COMPONENT_KINDS), vendorId: Uuid, description: Req(300, 'The description'), qty: z.number().positive().max(1e6), uom: Req(12, 'The unit'), unitCostCents: PosCents, markupPct: z.number().min(0).max(10).nullish(), vendorSku: Text(60).nullish(), sidemark: Text(120).nullish(), vendorDepositPct: Pct.nullish(), installOn: IsoDate.nullish() }),
  z.object({ op: z.literal('send_proposal'), itemIds: UuidList.min(1), title: Text(200).nullish(), notifyContactId: Uuid.nullish() }),
  z.object({ op: z.literal('decide'), proposalItemId: Uuid, decision: z.enum(['APPROVED', 'REJECTED', 'COMMENTED']), name: Req(120, 'Who decided'), comment: Text(2000).nullish(), method: z.enum(['IN_PERSON', 'PORTAL', 'EMAIL', 'PHONE', 'E_SIGNATURE']).default('IN_PERSON'), requestDeposit: z.boolean().default(true) }),
  z.object({ op: z.literal('request_deposits'), itemIds: UuidList.min(1) }),
  z.object({ op: z.literal('reallocate'), fromItemId: Uuid, toItemId: Uuid, cents: z.number().int().positive().max(1e12), reason: Req(500, 'A reason') }),
  z.object({ op: z.literal('create_pos'), componentIds: UuidList.nullish() }),
  z.object({ op: z.literal('fee_agreement'), agreement: z.object({ fee_model: z.enum(['HOURLY', 'FLAT_PHASE', 'PCT_BUDGET', 'COST_PLUS', 'PROCUREMENT_FEE', 'HYBRID']), hourly_rate_cents: PosCents.nullish(), rate_groups: z.record(z.string().max(40), PosCents).default({}), phases: z.array(z.object({ key: Req(40, 'The phase'), label: Text(120).nullish(), fee_cents: PosCents, pct_complete: Pct.default(0) })).max(20).default([]), pct_of_budget: Pct.nullish(), budget_cents: PosCents.nullish(), procurement_fee_pct: Pct.nullish(), reimbursable_markup_pct: z.number().min(0).max(5).nullish(), retainer_cents: PosCents.default(0), retainer_evergreen: z.boolean().default(false) }) }),
  z.object({ op: z.literal('draft_fee_invoice'), through: IsoDate.nullish(), kinds: z.array(z.enum(['HOURLY', 'PHASE', 'PCT_BUDGET', 'PROCUREMENT_FEE'])).min(1).max(4).nullish() }),
]);

function itemRow(i: Partial<z.infer<typeof Item>>): Record<string, unknown> {
  const map: Array<[keyof z.infer<typeof Item>, string]> = [['room', 'room'], ['name', 'name'], ['docCode', 'doc_code'], ['category', 'category'], ['description', 'description'], ['qty', 'qty'], ['isPlaceholder', 'is_placeholder'], ['budgetCents', 'budget_cents'], ['clientUnitPriceCents', 'client_unit_price_cents'], ['depositPct', 'deposit_pct'], ['imageUrl', 'image_url'], ['vendorUrl', 'vendor_url'], ['clientVisible', 'client_visible']];
  const out: Record<string, unknown> = {};
  for (const [k, col] of map) if (i[k] !== undefined) out[col] = i[k] === '' ? null : i[k];
  return out;
}

export const POST = route({
  access: { cap: 'projects.selections', action: 'view' },
  ops: {
    add_item: { cap: 'projects.selections', action: 'edit' }, update_item: { cap: 'projects.selections', action: 'edit' }, add_component: { cap: 'projects.selections', action: 'edit' },
    send_proposal: { cap: 'projects.selections', action: 'edit' }, decide: { cap: 'projects.selections', action: 'approve' },
    request_deposits: { cap: 'projects.billing', action: 'create' }, reallocate: { cap: 'projects.billing', action: 'edit' }, create_pos: { cap: 'projects.commitments', action: 'create' },
    fee_agreement: { cap: 'projects.billing', action: 'edit' }, draft_fee_invoice: { cap: 'projects.billing', action: 'create' },
  },
  mask: ['estimate', 'billing', 'commitment'],
  body: Op,
}, async ({ db, params, body }) => {
  const job = params.jobId!;
  const pm = db.schema('pm');
  switch (body.op) {
    case 'add_item': {
      const r = await dwrite<Array<{ id: string }>>(pm.from('dsn_items').insert({ job_id: job, ...itemRow(body.item), status: body.item.isPlaceholder ? 'PLACEHOLDER' : 'SPECIFIED' }).select('id'), 'add item');
      return { id: r[0]?.id ?? null };
    }
    case 'update_item': {
      const patch = itemRow(body.item);
      if (!Object.keys(patch).length) throw new HttpError(422, 'Nothing to change.', 'VALIDATION');
      const r = await dwrite<unknown[]>(pm.from('dsn_items').update(patch).eq('id', body.itemId).eq('job_id', job).select('id'), 'update item');
      if (!r.length) throw new HttpError(404, 'That item was not found on this project.', 'NOT_FOUND');
      return { ok: true };
    }
    case 'add_component':
      return { id: await xcall<string>(db, 'dsn_add_component', { p_item: body.itemId, p_kind: body.kind, p_vendor: body.vendorId, p_description: body.description, p_qty: body.qty, p_uom: body.uom, p_unit_cost_cents: body.unitCostCents, p_markup_pct: body.markupPct ?? null, p_vendor_sku: body.vendorSku ?? null, p_sidemark: body.sidemark ?? null, p_vendor_deposit_pct: body.vendorDepositPct ?? null, p_install_on: body.installOn ?? null }) };
    case 'send_proposal': {
      const r = await xcall<{ proposal_id: string; number: string; items: number }>(db, 'dsn_send_proposal', { p_job: job, p_item_ids: body.itemIds, p_title: body.title ?? null });
      if (body.notifyContactId) {
        const m = await sendCustomerMessage(db, { event: 'customer.selection_reminder', channel: 'email', jobId: job, contactId: body.notifyContactId, subject: `Selections to review: ${r.number}`, body: `Your designer sent ${r.items} item${r.items === 1 ? '' : 's'} for your approval. Open your project portal to approve or comment on each one.`, dedupe: `dsn:proposal:${r.proposal_id}` });
        return { ...r, message: m };
      }
      return r;
    }
    case 'decide':
      return xcall(db, 'dsn_record_decision', { p_proposal_item: body.proposalItemId, p_decision: body.decision, p_name: body.name, p_comment: body.comment ?? null, p_method: body.method, p_request_deposit: body.requestDeposit });
    case 'request_deposits':
      return xcall(db, 'dsn_request_deposits', { p_job: job, p_item_ids: body.itemIds });
    case 'reallocate':
      return xcall(db, 'dsn_reallocate_deposit', { p_from_item: body.fromItemId, p_to_item: body.toItemId, p_cents: body.cents, p_reason: body.reason });
    case 'create_pos':
      return xcall(db, 'dsn_create_pos', { p_job: job, p_component_ids: body.componentIds ?? null });
    case 'fee_agreement':
      return { id: await xcall<string>(db, 'dsn_set_fee_agreement', { p_job: job, p_agreement: body.agreement }) };
    case 'draft_fee_invoice':
      return xcall(db, 'dsn_draft_fee_invoice', { p_job: job, p_through: body.through ?? null, p_kinds: body.kinds ?? null });
  }
});

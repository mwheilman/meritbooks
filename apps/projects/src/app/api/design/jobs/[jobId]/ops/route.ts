export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { pm } from '@/lib/pm/db';
import { resRpc, resWrote } from '@/lib/residential/rpc';
import { Cents, Day, Text, Uuid } from '@/lib/residential/schemas';

const View = z.enum(['rooms', 'ffe', 'boards', 'agreement', 'statement', 'changes', 'claims', 'reimbursables', 'install']);

/** A design project's 1124 views: rooms + budgets, FF&E schedule, boards, agreement, deposit statement, changes, freight claims, reimbursables, install day. */
export const GET = route({ access: { cap: 'projects.selections', action: 'view' }, mask: ['selection', 'procurement', 'billing'],
  query: z.object({ view: View, room: z.string().max(120).optional(), on: Day.optional() }) }, async ({ db, params, query }) => {
  const job = params.jobId!;
  switch (query.view) {
    case 'rooms': return resRpc(db, 'dsn_room_budgets', { p_job: job });
    case 'ffe': return resRpc(db, 'dsn_ffe_schedule', { p_job: job, p_room: query.room ?? null });
    case 'statement': return resRpc(db, 'dsn_deposit_statement', { p_job: job });
    case 'install': return resRpc(db, 'dsn_install_day', { p_job: job, p_on: query.on ?? new Date().toISOString().slice(0, 10), p_room: query.room ?? null });
    case 'boards': {
      const boards = resWrote<Array<{ id: string }>>(await pm(db).from('dsn_boards').select('id, room, title, status, presented_at, updated_at').eq('job_id', job).neq('status', 'ARCHIVED').order('updated_at', { ascending: false }));
      const items = boards.length ? resWrote(await pm(db).from('dsn_board_items').select('id, board_id, kind, dsn_item_id, document_id, image_url, caption, x, y, w, h, sort').in('board_id', boards.map((b) => b.id)).order('sort')) : [];
      return { boards, items };
    }
    case 'agreement': return { agreements: resWrote(await pm(db).from('dsn_agreements').select('id, version, status, letter, retainer_cents, signer_name, signed_at, envelope_id, retainer_deposit_id, created_at').eq('job_id', job).order('version', { ascending: false })) };
    case 'changes': return { changes: resWrote(await pm(db).from('v_dsn_item_changes_masked').select('id, item_id, kind, reason, components_affected, restocking_fee_cents, deposit_moved_cents, to_item_id, created_at').eq('job_id', job).order('created_at', { ascending: false })) };
    case 'claims': return { claims: resWrote(await pm(db).from('v_dsn_freight_claims_masked').select('id, procurement_item_id, carrier, tracking_ref, damage, claim_cents, status, filed_on, settled_cents, created_at').eq('job_id', job).order('created_at', { ascending: false })) };
    case 'reimbursables': return { reimbursables: resWrote(await pm(db).from('dsn_reimbursables').select('id, kind, description, incurred_on, cost_cents, markup_pct, billable, status, billing_request_id').eq('job_id', job).order('incurred_on', { ascending: false })) };
  }
});

const Body = z.discriminatedUnion('op', [
  z.object({ op: z.literal('agreement_draft'), extraTerms: Text(4000).nullish() }),
  z.object({ op: z.literal('agreement_sent'), agreementId: Uuid, envelopeId: Uuid.nullish() }),
  z.object({ op: z.literal('agreement_signed'), agreementId: Uuid, signerName: Text(200).min(1) }),
  z.object({ op: z.literal('room'), roomId: Uuid.nullish(), name: Text(120).min(1), phase: z.enum(['PROGRAMMING', 'CONCEPT', 'DESIGN_DEVELOPMENT', 'PROCUREMENT', 'INSTALL', 'COMPLETE']).nullish(), budgetCents: Cents.nullish() }),
  z.object({ op: z.literal('add_product'), productId: Uuid, room: Text(120).min(1), qty: z.number().positive().max(100000).default(1), replaceItemId: Uuid.nullish() }),
  z.object({ op: z.literal('board'), boardId: Uuid.nullish(), title: Text(200).min(1), room: Text(120).nullish(),
    items: z.array(z.object({ kind: z.enum(['ITEM', 'SWATCH', 'RENDERING', 'IMAGE', 'NOTE']), dsn_item_id: Uuid.nullish(), document_id: Uuid.nullish(), image_url: z.string().url().startsWith('https://').nullish(),
      caption: Text(500).nullish(), x: z.number().min(0).max(100).default(0), y: z.number().min(0).max(100).default(0), w: z.number().min(1).max(100).default(25), h: z.number().min(1).max(100).default(25) })).max(200) }),
  z.object({ op: z.literal('present_board'), boardId: Uuid }),
  z.object({ op: z.literal('change_item'), itemId: Uuid, kind: z.enum(['CANCEL', 'RETURN', 'CHANGE']), reason: Text(1000).min(1, 'Give the reason'), toItemId: Uuid.nullish() }),
  z.object({ op: z.literal('freight_claim'), componentId: Uuid, damage: Text(2000).min(1), carrier: Text(120).nullish(), tracking: Text(120).nullish(), photoDocumentIds: z.array(Uuid).max(20).default([]), claimCents: Cents.nullish() }),
  z.object({ op: z.literal('claim_status'), claimId: Uuid, status: z.enum(['FILED', 'PAID', 'DENIED', 'WITHDRAWN']), settledCents: Cents.nullish() }),
  z.object({ op: z.literal('complete_install'), checklistId: Uuid, doneKeys: z.array(z.string().max(40)).max(40), stylingPhotoIds: z.array(Uuid).max(60).default([]),
    punch: z.array(z.object({ title: Text(200).min(1), description: Text(2000).nullish() })).max(100).default([]), installedItemIds: z.array(Uuid).max(500).default([]) }),
  z.object({ op: z.literal('product_invoice'), kind: z.enum(['DEPOSIT', 'PROGRESS', 'FINAL']), itemIds: z.array(Uuid).min(1).max(500), taxRate: z.number().min(0).max(0.5).default(0),
    shipToState: z.string().regex(/^[A-Z]{2}$/).nullish() }),
  z.object({ op: z.literal('reimbursable'), kind: z.enum(['SAMPLES', 'TRAVEL', 'PRINTING', 'FREIGHT', 'STORAGE', 'OTHER']), description: Text(300).min(1), incurredOn: Day.nullish(),
    costCents: Cents.refine((n) => n > 0, 'More than zero'), markupPct: z.number().min(0).max(5).nullish(), billable: z.boolean().default(true), receiptDocumentId: Uuid.nullish(), booksTxnRef: Text(120).nullish() }),
  z.object({ op: z.literal('bill_reimbursables') }),
]);

export const POST = route({ access: { cap: 'projects.selections', action: 'view' },
  ops: {
    agreement_draft: { cap: 'projects.estimates', action: 'edit' }, agreement_sent: { cap: 'projects.estimates', action: 'edit' }, agreement_signed: { cap: 'projects.billing', action: 'create' },
    room: { cap: 'projects.selections', action: 'edit' }, add_product: { cap: 'projects.selections', action: 'edit' }, board: { cap: 'projects.selections', action: 'edit' },
    present_board: { cap: 'projects.selections', action: 'edit' }, change_item: { cap: 'projects.selections', action: 'edit' }, freight_claim: { cap: 'projects.selections', action: 'edit' },
    claim_status: { cap: 'projects.selections', action: 'edit' }, complete_install: { cap: 'projects.jobs', action: 'edit' }, product_invoice: { cap: 'projects.billing', action: 'create' },
    reimbursable: { cap: 'projects.jobs', action: 'edit' }, bill_reimbursables: { cap: 'projects.billing', action: 'create' },
  },
  mask: ['selection', 'procurement', 'billing'], body: Body }, async ({ db, params, body }) => {
  const job = params.jobId!;
  switch (body.op) {
    case 'agreement_draft': return { agreementId: await resRpc<string>(db, 'dsn_draft_agreement', { p_job: job, p_extra_terms: body.extraTerms ?? null }) };
    case 'agreement_sent': return { agreementId: await resRpc<string>(db, 'dsn_mark_agreement_sent', { p_agreement: body.agreementId, p_envelope: body.envelopeId ?? null }) };
    case 'agreement_signed': return resRpc(db, 'dsn_mark_agreement_signed', { p_agreement: body.agreementId, p_signer_name: body.signerName });
    case 'room': return { roomId: await resRpc<string>(db, 'dsn_save_room', { p_job: job, p_name: body.name, p_phase: body.phase ?? null, p_budget_cents: body.budgetCents ?? null, p_room: body.roomId ?? null }) };
    case 'add_product': return { itemId: await resRpc<string>(db, 'dsn_add_product_item', { p_job: job, p_product: body.productId, p_room: body.room, p_qty: body.qty, p_replace_item: body.replaceItemId ?? null }) };
    case 'board': return { boardId: await resRpc<string>(db, 'dsn_save_board', { p_job: job, p_title: body.title, p_room: body.room ?? null, p_items: body.items, p_board: body.boardId ?? null }) };
    case 'present_board': return resRpc(db, 'dsn_present_board', { p_board: body.boardId });
    case 'change_item': return resRpc(db, 'dsn_change_item', { p_item: body.itemId, p_kind: body.kind, p_reason: body.reason, p_to_item: body.toItemId ?? null });
    case 'freight_claim': return { claimId: await resRpc<string>(db, 'dsn_open_freight_claim', { p_component: body.componentId, p_damage: body.damage, p_carrier: body.carrier ?? null,
      p_tracking: body.tracking ?? null, p_photos: body.photoDocumentIds, p_claim_cents: body.claimCents ?? null }) };
    case 'claim_status': return { claimId: await resRpc<string>(db, 'dsn_update_freight_claim', { p_claim: body.claimId, p_status: body.status, p_settled_cents: body.settledCents ?? null }) };
    case 'complete_install': return resRpc(db, 'dsn_complete_install', { p_checklist: body.checklistId, p_done_keys: body.doneKeys, p_styling_photos: body.stylingPhotoIds, p_punch: body.punch,
      p_installed_items: body.installedItemIds });
    case 'product_invoice': return resRpc(db, 'dsn_draft_product_invoice', { p_job: job, p_kind: body.kind, p_item_ids: body.itemIds, p_tax_rate: body.taxRate, p_ship_to_state: body.shipToState ?? null });
    case 'reimbursable': return { id: await resRpc<string>(db, 'dsn_add_reimbursable', { p_job: job, p_fields: { kind: body.kind, description: body.description, incurred_on: body.incurredOn ?? null,
      cost_cents: body.costCents, markup_pct: body.markupPct ?? null, billable: body.billable, receipt_document_id: body.receiptDocumentId ?? null, books_txn_ref: body.booksTxnRef ?? null } }) };
    case 'bill_reimbursables': return resRpc(db, 'dsn_bill_reimbursables', { p_job: job });
  }
});

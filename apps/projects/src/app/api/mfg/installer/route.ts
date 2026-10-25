export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { deskBody, deskQuery, op, runOp, runView, view } from '@/lib/dealer/desk';
import { IsoDate, PosCents, Req, Text, Uuid } from '@/lib/dealer/schemas';

/**
 * The installer's phone (1125, MFG-46 / MFG-47): today's installs for the crews the person is on, room-by-room
 * time, punch with photos and the responsible party, back-charges (GC → a billing request; vendor →
 * held for Books AP), warranty work on the original job, and the customer sign-off. No money on the
 * installer's screens; back-charge amounts need Billing (or Commitments for vendors).
 */
const views = {
  home: view('mfg_installer_home', z.object({ company: Uuid, day: IsoDate.optional() }), (q) => ({ p_location: q.company, p_day: q.day ?? null })),
  punch: view('mfg_punch_board', z.object({ job: Uuid }), (q) => ({ p_job: q.job })),
  sheets: view('mfg_current_sheets', z.object({ job: Uuid }), (q) => ({ p_job: q.job })),
};

export const GET = route({ access: { cap: 'projects.jobs', action: 'view' }, mask: 'billing', query: deskQuery(views) }, async ({ db, query, tenant }) =>
  runView(views, query, db, tenant));

const Photos = z.array(Uuid).max(20).default([]);
const ops = {
  log_time: op('mfg_log_install_time', z.object({ installId: Uuid, hours: z.number().positive().max(16), room: Text(80).nullish(), note: Text(300).nullish(), commandId: Uuid.nullish() }),
    (b) => ({ p_install: b.installId, p_hours: b.hours, p_room: b.room ?? null, p_note: b.note ?? null, p_command: b.commandId ?? null })),
  add_punch: op('mfg_add_punch', z.object({ jobId: Uuid, title: Req(200, 'The punch item'), description: Text(2000).nullish(), wbsId: Uuid.nullish(), room: Text(80).nullish(),
    responsible: z.enum(['SHOP', 'INSTALL', 'GC', 'VENDOR', 'DESIGN', 'CUSTOMER']).default('INSTALL'), vendorId: Uuid.nullish(), dueOn: IsoDate.nullish(), workOrderId: Uuid.nullish(),
    partIssue: z.enum(['MISSING', 'DAMAGED']).nullish(), partLabel: Text(60).nullish(), qty: z.number().positive().max(1000).nullish(), photoIds: Photos }),
  (b) => ({ p_job: b.jobId, p_attrs: { title: b.title, description: b.description ?? null, wbs_id: b.wbsId ?? null, room: b.room ?? null, responsible: b.responsible, vendor_id: b.vendorId ?? null,
    due_on: b.dueOn ?? null, work_order_id: b.workOrderId ?? null, part_issue: b.partIssue ?? null, part_label: b.partLabel ?? null, qty: b.qty ?? null, photo_document_ids: b.photoIds } })),
  backcharge: op('mfg_backcharge', z.object({ punchId: Uuid, to: z.enum(['GC', 'VENDOR']), amountCents: PosCents.refine((n) => n > 0, 'The back-charge is above zero'), partyId: Uuid.nullish() }),
    (b) => ({ p_punch: b.punchId, p_to: b.to, p_amount_cents: b.amountCents, p_party: b.partyId ?? null })),
  warranty: op('mfg_open_warranty', z.object({ jobId: Uuid, title: Req(200, 'The issue'), room: Text(80).nullish(), wbsId: Uuid.nullish(), responsible: z.enum(['SHOP', 'INSTALL', 'GC', 'VENDOR', 'DESIGN', 'CUSTOMER']).nullish(), photoIds: Photos }),
    (b) => ({ p_job: b.jobId, p_title: b.title, p_attrs: { room: b.room ?? null, wbs_id: b.wbsId ?? null, responsible: b.responsible ?? null, photo_document_ids: b.photoIds } })),
  signoff: op('mfg_install_signoff', z.object({ installId: Uuid, signer: Req(120, 'The customer name'), signatureDocumentId: Uuid.nullish(), photoIds: Photos, notes: Text(1000).nullish() }),
    (b) => ({ p_install: b.installId, p_signer: b.signer, p_signature_document: b.signatureDocumentId ?? null, p_photos: b.photoIds, p_notes: b.notes ?? null })),
};

export const POST = route({ access: { cap: 'projects.jobs', action: 'view' }, mask: 'billing', body: deskBody(ops) }, async ({ db, body, tenant }) => runOp(ops, body, db, tenant));

import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { assertCompany, route } from '@/lib/api';
import { decideObject } from '@/lib/approvals/server';
import { fsCall, fsOwn } from '@/lib/fieldservice/rpc';
import { loadInstallItems, rpcLoad } from '@/lib/fieldservice/completion';
import type { InstallBoardRow } from '@/lib/fieldservice/completion-types';
import { Cents, Day, Text, Uuid } from '@/lib/pm/ops/schemas';

/**
 * Install projects (FS-79 … FS-86, FS-90). GET ?companyId= is the stage board (contract value only
 * for contract-value holders — stripped in the database); GET ?projectId= one project's items
 * (masked view), readiness and earliest date. POST runs one step; every step is guarded again in
 * its definer RPC. Purchase orders and invoices are DRAFTS that go through the 1113 approval engine
 * (submit: true routes them now — the engine decides who approves).
 */
const Q = z.object({ companyId: Uuid.optional(), projectId: Uuid.optional() });

export const GET = route({ access: { cap: 'projects.jobs', action: 'view' }, mask: false, query: Q }, async ({ db, tenant, query }) => {
  if (query.projectId) {
    const p = await fsOwn<{ id: string; location_id: string; job_id: string }>(db, 'fs_install_projects', 'id, location_id, job_id', query.projectId, 'That install was not found.');
    assertCompany(tenant, p.location_id);
    const [items, earliest, pos, permits, inspections] = await Promise.all([
      loadInstallItems(db, p.id),
      rpcLoad<{ date: string; reasons: string[]; readiness: unknown[] } | null>(db, 'fs_install_earliest', { p_project: p.id }, null),
      db.schema('pm').from('fs_po_details').select('commitment_id, fulfillment, expected_on, picked_up_at').eq('project_id', p.id),
      db.schema('pm').from('res_permits').select('id, kind, number, authority, status, applied_on, issued_on').eq('job_id', p.job_id),
      db.schema('pm').from('res_inspections').select('id, permit_id, kind, scheduled_on, result, result_on').eq('job_id', p.job_id).order('requested_on'),
    ]);
    const poIds = ((pos.data ?? []) as Array<{ commitment_id: string }>).map((x) => x.commitment_id);
    const commitments = poIds.length ? await db.schema('pm').from('commitments').select('id, number, status, vendor_id').in('id', poIds) : { data: [] };
    return { items: items.data, earliest: earliest.data, pos: pos.data ?? [], commitments: commitments.data ?? [], permits: permits.data ?? [], inspections: inspections.data ?? [], error: items.error };
  }
  if (!query.companyId) throw new HttpError(422, 'Pick the company.', 'VALIDATION');
  assertCompany(tenant, query.companyId);
  const b = await rpcLoad<InstallBoardRow[]>(db, 'fs_install_board', { p_location: query.companyId }, []);
  return { projects: b.data, error: b.error };
});

const P = { projectId: Uuid };
const Body = z.discriminatedUnion('op', [
  z.object({ op: z.literal('handoff'), estimateId: Uuid }),
  z.object({ op: z.literal('stage'), ...P, stage: z.enum(['SOLD', 'ORDERED', 'PERMITTED', 'SCHEDULED', 'INSTALLED', 'INSPECTED', 'CLOSED', 'CANCELLED']), note: Text(500).nullish() }),
  z.object({ op: z.literal('po'), ...P, vendorId: Uuid, fulfillment: z.enum(['WILL_CALL', 'DELIVERY']), expectedOn: Day.nullish(), itemIds: z.array(Uuid).max(100).nullish(),
             title: Text(200).nullish(), note: Text(500).nullish(), submit: z.boolean().default(true) }),
  z.object({ op: z.literal('receive'), commitmentId: Uuid, receivedOn: Day.nullish(),
             lines: z.array(z.object({ line_id: Uuid, qty: z.number().positive().max(1e6), serials: z.array(z.string().trim().min(1).max(80)).max(50).default([]),
                                       make: Text(80).nullish(), model: Text(80).nullish() })).min(1).max(100) }),
  z.object({ op: z.literal('permit'), ...P, templateId: Uuid.nullish(), number: Text(60).nullish(), appliedOn: Day.nullish() }),
  z.object({ op: z.literal('permit_status'), permitId: Uuid, status: z.enum(['NOT_STARTED', 'APPLIED', 'ISSUED', 'APPROVED', 'DENIED', 'EXPIRED', 'CLOSED']),
             number: Text(60).nullish(), on: Day.nullish() }),
  z.object({ op: z.literal('inspection'), inspectionId: Uuid, result: z.enum(['PASS', 'FAIL', 'PARTIAL', 'CANCELLED']), on: Day.nullish(), inspector: Text(120).nullish(), notes: Text(2000).nullish() }),
  z.object({ op: z.literal('schedule'), ...P, start: Day, days: z.number().int().min(1).max(60).nullish(), crewId: Uuid.nullish(), leadId: Uuid.nullish(),
             helperIds: z.array(Uuid).max(10).default([]), overrideReason: Text(300).nullish(), hours: z.number().positive().max(24).default(8) }),
  z.object({ op: z.literal('bill'), ...P, kind: z.enum(['DEPOSIT', 'PROGRESS', 'FINAL', 'SOV']), amountCents: Cents.nullish(), pct: z.number().gt(0).max(1).nullish(),
             memo: Text(500).nullish(), periodEnd: Day.nullish(), submit: z.boolean().default(true) }),
  z.object({ op: z.literal('sov'), ...P, retainagePct: z.number().min(0).max(0.25).nullish(),
             lines: z.array(z.object({ description: z.string().trim().min(1).max(300), scheduled_value_cents: Cents })).min(1).max(200) }),
]);

export const POST = route({ access: { cap: 'projects.jobs', action: 'view' }, mask: false, body: Body }, async ({ db, body }) => {
  switch (body.op) {
    case 'handoff':
      return { projectId: await fsCall<string>(db, 'fs_handoff_install', { p_estimate: body.estimateId }) };
    case 'stage':
      return fsCall(db, 'fs_set_install_stage', { p_project: body.projectId, p_stage: body.stage, p_note: body.note ?? null });
    case 'po': {
      const id = await fsCall<string>(db, 'fs_install_po', { p_project: body.projectId, p_vendor: body.vendorId, p_fulfillment: body.fulfillment,
        p_expected_on: body.expectedOn ?? null, p_item_ids: body.itemIds ?? null, p_title: body.title ?? null, p_note: body.note ?? null });
      const approval = body.submit ? await decideObject(db, 'commitment', id).catch(() => null) : null;
      return { commitmentId: id, approval: approval ? { status: approval.status, requestId: approval.request_id ?? null } : null };
    }
    case 'receive':
      return fsCall(db, 'fs_receive_po', { p_commitment: body.commitmentId, p_lines: body.lines, p_pickup_code: null, p_received_on: body.receivedOn ?? null, p_command: null });
    case 'permit':
      return { permitId: await fsCall<string>(db, 'fs_apply_permit', { p_project: body.projectId, p_template: body.templateId ?? null, p_number: body.number ?? null, p_applied_on: body.appliedOn ?? null }) };
    case 'permit_status':
      return fsCall(db, 'fs_update_permit', { p_permit: body.permitId, p_status: body.status, p_number: body.number ?? null, p_on: body.on ?? null, p_document: null, p_fee_cents: null });
    case 'inspection':
      return fsCall(db, 'res_record_inspection', { p_inspection: body.inspectionId, p_result: body.result, p_on: body.on ?? null, p_inspector: body.inspector ?? null, p_notes: body.notes ?? null });
    case 'schedule':
      return fsCall(db, 'fs_schedule_install', { p_project: body.projectId, p_start: body.start, p_days: body.days ?? null, p_crew: body.crewId ?? null,
        p_lead: body.leadId ?? null, p_helpers: body.helperIds, p_override_reason: body.overrideReason ?? null, p_hours: body.hours });
    case 'bill': {
      const r = await fsCall<{ kind: string; billing_request_id?: string; deposit_request_id?: string; amount_cents?: number }>(db, 'fs_install_bill', {
        p_project: body.projectId, p_kind: body.kind, p_amount_cents: body.amountCents ?? null, p_pct: body.pct ?? null, p_memo: body.memo ?? null,
        p_period_end: body.periodEnd ?? null, p_sov_lines: [] });
      const approval = body.submit && r.billing_request_id ? await decideObject(db, 'billing_request', r.billing_request_id).catch(() => null) : null;
      return { ...r, approval: approval ? { status: approval.status, requestId: approval.request_id ?? null } : null };
    }
    case 'sov':
      return { sovVersionId: await fsCall<string>(db, 'fs_install_setup_sov', { p_project: body.projectId, p_lines: body.lines, p_retainage_pct: body.retainagePct ?? null }) };
  }
});

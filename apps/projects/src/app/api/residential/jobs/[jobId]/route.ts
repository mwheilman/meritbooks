export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { linkBase } from '@/lib/documents/http';
import { pm } from '@/lib/pm/db';
import { loadHomeWorkspace } from '@/lib/residential/queries';
import { resRpc, resWrote } from '@/lib/residential/rpc';
import { publicLink, tradeToken } from '@/lib/residential/sign';
import { Cents, Day, Text, Uuid } from '@/lib/residential/schemas';

/** The residential workspace of a job: home profile, RRP, household, checks, chain, walks, permits, COs, trades, payments, decisions. */
export const GET = route({ access: { cap: 'projects.jobs', action: 'view' }, mask: ['change_order', 'billing', 'selection'] }, async ({ db, params }) =>
  loadHomeWorkspace(db, params.jobId!));

const Profile = z.object({
  op: z.literal('profile'),
  occupied: z.boolean().optional(), yearBuilt: z.number().int().min(1600).max(2100).nullish(),
  lockboxCode: Text(40).nullish(), alarmCode: Text(40).nullish(), garageCode: Text(40).nullish(), gateCode: Text(40).nullish(),
  pets: Text(500).nullish(), children: Text(500).nullish(), workHours: Text(200).nullish(), parking: Text(500).nullish(),
  offLimits: Text(500).nullish(), utilityNotice: Text(500).nullish(), tempKitchen: Text(500).nullish(), bathroomForCrew: Text(200).nullish(),
  notes: Text(4000).nullish(), asbestosSuspect: z.boolean().optional(), moldSuspect: z.boolean().optional(),
});
const PROFILE_COLS: Record<string, string> = {
  occupied: 'occupied', yearBuilt: 'year_built', lockboxCode: 'lockbox_code', alarmCode: 'alarm_code', garageCode: 'garage_code', gateCode: 'gate_code',
  pets: 'pets', children: 'children', workHours: 'work_hours', parking: 'parking', offLimits: 'off_limits', utilityNotice: 'utility_notice',
  tempKitchen: 'temp_kitchen', bathroomForCrew: 'bathroom_for_crew', notes: 'notes', asbestosSuspect: 'asbestos_suspect', moldSuspect: 'mold_suspect',
};
const Rrp = z.object({
  op: z.literal('rrp'), renovatorName: Text(200).nullish(), renovatorCertNumber: Text(60).nullish(), renovatorCertExpiresOn: Day.nullish(),
  pamphletAckName: Text(200).nullish(), pamphletAck: z.boolean().optional(), containmentVerified: z.boolean().optional(), cleaningVerified: z.boolean().optional(),
  cleaningCardResult: z.enum(['PASS', 'FAIL', 'RECLEAN_PASS']).nullish(), asbestosTest: z.enum(['NOT_TESTED', 'NEGATIVE', 'POSITIVE', 'PRESUMED']).optional(),
  moldTest: z.enum(['NOT_TESTED', 'NEGATIVE', 'POSITIVE', 'PRESUMED']).optional(),
});

const Op = z.discriminatedUnion('op', [
  Profile,
  Rrp,
  z.object({ op: z.literal('field_co'), title: Text(200).min(1, 'Say what you found'), note: Text(4000).nullish(), transcript: Text(8000).nullish(),
    photoDocumentIds: z.array(Uuid).max(20).default([]), voiceDocumentId: Uuid.nullish(), demoDiscovery: z.boolean().default(false),
    emergency: z.boolean().default(false), area: Text(120).nullish() }),
  z.object({ op: z.literal('internal_co'), title: Text(200).min(1), reasonCode: z.enum(['BUILDER_ERROR', 'GOODWILL', 'VENDOR_ERROR', 'DAMAGE', 'OTHER']), costCents: Cents, costCodeId: Uuid.nullish(), note: Text(4000).nullish() }),
  z.object({ op: z.literal('reminders') }),
  z.object({ op: z.literal('deadlines') }),
  z.object({ op: z.literal('protection_start'), kind: z.enum(['DAY1_CONTAINMENT', 'DAILY_CLEANUP', 'PROTECTION_REMOVAL']), date: Day.nullish() }),
  z.object({ op: z.literal('protection_complete'), checkId: Uuid, doneKeys: z.array(z.string().max(40)).max(40), photoDocumentIds: z.array(Uuid).max(20).default([]), note: Text(2000).nullish() }),
  z.object({ op: z.literal('chain_create') }),
  z.object({ op: z.literal('chain_advance'), stepId: Uuid, actualOn: Day.nullish() }),
  z.object({ op: z.literal('walk_plan'), kind: z.enum(['FINAL_WALKTHROUGH', 'ORIENTATION', 'CUSTOM']), dueOn: Day.nullish() }),
  z.object({ op: z.literal('walk_complete'), walkId: Uuid, acceptedBy: Text(200).nullish(),
    items: z.array(z.object({ title: Text(200).min(1), location: Text(120).nullish(), description: Text(2000).nullish(), tradeVendorId: Uuid.nullish() })).max(200).default([]) }),
  z.object({ op: z.literal('warranty_walks'), from: Day.nullish() }),
  z.object({ op: z.literal('permit'), kind: z.enum(['BUILDING', 'ELECTRICAL', 'PLUMBING', 'MECHANICAL', 'DEMOLITION', 'HOA', 'ARCHITECTURAL', 'ZONING', 'NEIGHBOR_NOTICE', 'DUMPSTER', 'PORTABLE_TOILET', 'OTHER']),
    number: Text(60).nullish(), authority: Text(200).nullish(), status: z.enum(['NOT_STARTED', 'APPLIED', 'ISSUED', 'APPROVED', 'DENIED', 'EXPIRED', 'CLOSED', 'ORDERED', 'DELIVERED', 'REMOVED', 'SENT']).default('NOT_STARTED'),
    appliedOn: Day.nullish(), issuedOn: Day.nullish(), expiresOn: Day.nullish(), deliveredOn: Day.nullish(), removalOn: Day.nullish(), notes: Text(2000).nullish(), permitId: Uuid.nullish() }),
  z.object({ op: z.literal('inspection'), kind: z.enum(['FOOTING', 'FOUNDATION', 'FRAMING', 'MEP_ROUGH', 'INSULATION', 'DRYWALL', 'FINAL', 'OTHER']), permitId: Uuid.nullish(), taskId: Uuid.nullish(), scheduledOn: Day.nullish() }),
  z.object({ op: z.literal('inspection_result'), inspectionId: Uuid, result: z.enum(['PASS', 'FAIL', 'PARTIAL', 'CANCELLED']), on: Day.nullish(), inspector: Text(200).nullish(), notes: Text(2000).nullish() }),
  z.object({ op: z.literal('assign_trade'), taskId: Uuid, vendorId: Uuid, contactId: Uuid.nullish() }),
  z.object({ op: z.literal('household'), name: Text(200).min(1), email: z.string().email().max(254).nullish(), phone: Text(40).nullish(),
    relation: z.enum(['OWNER', 'SPOUSE', 'FAMILY', 'ARCHITECT', 'DESIGNER', 'REALTOR', 'LENDER', 'PROPERTY_MANAGER', 'OTHER']), canSign: z.boolean().default(false), canPay: z.boolean().default(false) }),
  z.object({ op: z.literal('closing_open'), scheduledOn: Day.nullish(), titleCompany: Text(200).nullish() }),
  z.object({ op: z.literal('vpo'), vendorId: Uuid, reasonCode: z.enum(['BUILDER_ERROR', 'FIELD_CHANGE', 'VENDOR_ERROR', 'DESIGN_CHANGE', 'DAMAGE_THEFT', 'OTHER']),
    amountCents: Cents.refine((n) => n > 0, 'More than zero'), description: Text(1000).min(1), costCodeId: Uuid.nullish(), chargebackVendorId: Uuid.nullish() }),
]);

const OPS = {
  profile: { cap: 'projects.jobs', action: 'edit' }, rrp: { cap: 'projects.jobs', action: 'edit' }, internal_co: { cap: 'projects.change_orders', action: 'create' },
  reminders: { cap: 'projects.selections', action: 'edit' }, deadlines: { cap: 'projects.selections', action: 'view' }, chain_create: { cap: 'projects.jobs', action: 'edit' },
  chain_advance: { cap: 'projects.jobs', action: 'edit' }, walk_plan: { cap: 'projects.jobs', action: 'edit' }, warranty_walks: { cap: 'projects.jobs', action: 'edit' },
  permit: { cap: 'projects.jobs', action: 'edit' }, inspection: { cap: 'projects.jobs', action: 'edit' }, inspection_result: { cap: 'projects.jobs', action: 'edit' },
  assign_trade: { cap: 'projects.jobs', action: 'edit' }, household: { cap: 'projects.customers', action: 'create' }, closing_open: { cap: 'projects.jobs', action: 'edit' },
} as const;

export const POST = route({ access: { cap: 'projects.jobs', action: 'view' }, ops: OPS, mask: ['change_order', 'billing', 'commitment'], body: Op }, async ({ req, db, params, body, tenant }) => {
  const job = params.jobId!;
  switch (body.op) {
    case 'profile': {
      const patch: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(body)) if (k !== 'op' && v !== undefined && PROFILE_COLS[k]) patch[PROFILE_COLS[k]!] = v;
      resWrote(await pm(db).from('res_home_profiles').upsert({ org_id: tenant.orgId, job_id: job, ...patch }, { onConflict: 'org_id,job_id' }).select('id'));
      return { ok: true };
    }
    case 'rrp': {
      const now = new Date().toISOString();
      const patch: Record<string, unknown> = {
        ...(body.renovatorName !== undefined ? { renovator_name: body.renovatorName } : {}), ...(body.renovatorCertNumber !== undefined ? { renovator_cert_number: body.renovatorCertNumber } : {}),
        ...(body.renovatorCertExpiresOn !== undefined ? { renovator_cert_expires_on: body.renovatorCertExpiresOn } : {}), ...(body.pamphletAckName !== undefined ? { pamphlet_ack_name: body.pamphletAckName } : {}),
        ...(body.pamphletAck ? { pamphlet_ack_at: now } : {}), ...(body.containmentVerified ? { containment_verified_at: now } : {}), ...(body.cleaningVerified ? { cleaning_verified_at: now } : {}),
        ...(body.cleaningCardResult !== undefined ? { cleaning_card_result: body.cleaningCardResult } : {}), ...(body.asbestosTest ? { asbestos_test: body.asbestosTest } : {}),
        ...(body.moldTest ? { mold_test: body.moldTest } : {}),
      };
      resWrote(await pm(db).from('res_rrp_records').upsert({ org_id: tenant.orgId, job_id: job, ...patch }, { onConflict: 'org_id,job_id' }).select('id'));
      return { ok: true };
    }
    case 'field_co':
      return { changeOrderId: await resRpc<string>(db, 'res_request_field_co', { p_job: job, p_title: body.title, p_note: body.note ?? null, p_transcript: body.transcript ?? null,
        p_photo_documents: body.photoDocumentIds, p_voice_document: body.voiceDocumentId ?? null, p_demo_discovery: body.demoDiscovery, p_emergency: body.emergency, p_area: body.area ?? null }) };
    case 'internal_co':
      return { changeOrderId: await resRpc<string>(db, 'res_create_internal_co', { p_job: job, p_title: body.title, p_reason_code: body.reasonCode, p_cost_cents: body.costCents, p_cost_code: body.costCodeId ?? null, p_note: body.note ?? null }) };
    case 'reminders': return { reminded: await resRpc<number>(db, 'res_send_selection_reminders', { p_job: job }) };
    case 'deadlines': return { refreshed: await resRpc<number>(db, 'res_refresh_selection_deadlines', { p_job: job }) };
    case 'protection_start': return { checkId: await resRpc<string>(db, 'res_start_protection_check', { p_job: job, p_kind: body.kind, p_date: body.date ?? null }) };
    case 'protection_complete': return resRpc(db, 'res_complete_protection_check', { p_check: body.checkId, p_done_keys: body.doneKeys, p_photos: body.photoDocumentIds, p_note: body.note ?? null });
    case 'chain_create': return { chainId: await resRpc<string>(db, 'res_create_chain', { p_job: job, p_kind: 'CABINET_COUNTER' }) };
    case 'chain_advance': return resRpc(db, 'res_advance_chain_step', { p_step: body.stepId, p_actual_on: body.actualOn ?? null });
    case 'walk_plan': return { walkId: await resRpc<string>(db, 'res_plan_walk', { p_job: job, p_kind: body.kind, p_due_on: body.dueOn ?? null, p_scheduled_at: null }) };
    case 'walk_complete':
      return resRpc(db, 'res_complete_walk', { p_walk: body.walkId, p_accepted_by: body.acceptedBy ?? null, p_signature_document: null,
        p_items: body.items.map((i) => ({ title: i.title, location: i.location ?? null, description: i.description ?? null, trade_vendor_id: i.tradeVendorId ?? null })) });
    case 'warranty_walks': return { scheduled: await resRpc<number>(db, 'res_schedule_warranty_walks', { p_job: job, p_from: body.from ?? null }) };
    case 'permit': {
      const row = { kind: body.kind, number: body.number ?? null, authority: body.authority ?? null, status: body.status, applied_on: body.appliedOn ?? null, issued_on: body.issuedOn ?? null,
        expires_on: body.expiresOn ?? null, delivered_on: body.deliveredOn ?? null, removal_on: body.removalOn ?? null, notes: body.notes ?? null };
      if (body.permitId) { resWrote(await pm(db).from('res_permits').update(row).eq('id', body.permitId).eq('job_id', job).select('id')); return { permitId: body.permitId }; }
      const r = resWrote<Array<{ id: string }>>(await pm(db).from('res_permits').insert({ org_id: tenant.orgId, job_id: job, ...row }).select('id'));
      return { permitId: r[0]?.id ?? null };
    }
    case 'inspection': {
      const r = resWrote<Array<{ id: string }>>(await pm(db).from('res_inspections').insert({ org_id: tenant.orgId, job_id: job, kind: body.kind, permit_id: body.permitId ?? null, task_id: body.taskId ?? null, scheduled_on: body.scheduledOn ?? null }).select('id'));
      return { inspectionId: r[0]?.id ?? null };
    }
    case 'inspection_result':
      return resRpc(db, 'res_record_inspection', { p_inspection: body.inspectionId, p_result: body.result, p_on: body.on ?? null, p_inspector: body.inspector ?? null, p_notes: body.notes ?? null });
    case 'assign_trade': {
      const t = tradeToken();
      return resRpc(db, 'res_assign_trade', { p_task: body.taskId, p_vendor: body.vendorId, p_contact: body.contactId ?? null, p_token_hash: t.hash, p_link: publicLink(linkBase(req), 'trade', t.token) });
    }
    case 'household': {
      const r = resWrote<Array<{ id: string }>>(await pm(db).from('res_household_members').insert({ org_id: tenant.orgId, job_id: job, name: body.name, email: body.email ?? null,
        phone: body.phone ?? null, relation: body.relation, can_sign: body.canSign, can_pay: body.canPay }).select('id'));
      return { memberId: r[0]?.id ?? null };
    }
    case 'closing_open': return { closingId: await resRpc<string>(db, 'res_open_closing', { p_job: job, p_scheduled_on: body.scheduledOn ?? null, p_title_company: body.titleCompany ?? null }) };
    case 'vpo':
      return resRpc(db, 'res_create_vpo', { p_job: job, p_vendor: body.vendorId, p_reason_code: body.reasonCode, p_amount_cents: body.amountCents, p_description: body.description,
        p_cost_code: body.costCodeId ?? null, p_chargeback_vendor: body.chargebackVendorId ?? null, p_by_trade: false, p_evidence: [] });
  }
});

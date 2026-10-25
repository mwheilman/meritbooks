export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { deskBody, deskQuery, op, runOp, runView, view } from '@/lib/dealer/desk';
import { IsoDate, PosCents, Req, Text, Uuid } from '@/lib/dealer/schemas';

/**
 * Engineering + area gates (1125): site measure (MFG-14), cabinet selections (MFG-15), the shop-drawing
 * submittal log with stamps (MFG-16), current-set sheets (MFG-17), the engineering queue + drafter
 * load (MFG-18), CO re-engineering (MFG-22), cut list (MFG-20), family routings (MFG-25), traveler
 * (MFG-32). Production, documents, selections and change-order capabilities each satisfy their own
 * operations: the route admits job viewers and every pm function's guard decides (the database is
 * the boundary), as the 1122 install route does.
 */
const views = {
  areas: view('mfg_area_board', z.object({ job: Uuid }), (q) => ({ p_job: q.job })),
  drawings: view('mfg_shop_drawing_log', z.object({ job: Uuid }), (q) => ({ p_job: q.job })),
  queue: view('mfg_eng_board', z.object({ company: Uuid, weeks: z.coerce.number().int().min(1).max(26).optional() }), (q) => ({ p_location: q.company, p_weeks: q.weeks ?? 8 })),
  sheets: view('mfg_current_sheets', z.object({ job: Uuid }), (q) => ({ p_job: q.job })),
  sheet_status: view('mfg_sheet_status', z.object({ revision: Uuid }), (q) => ({ p_revision: q.revision })),
  co_impact: view('mfg_co_impact', z.object({ co: Uuid }), (q) => ({ p_co: q.co })),
  cut_list: view('mfg_cut_list', z.object({ wo: Uuid }), (q) => ({ p_wo: q.wo })),
  traveler: view('mfg_traveler', z.object({ wo: Uuid, operation: Uuid.optional() }), (q) => ({ p_wo: q.wo, p_operation: q.operation ?? null })),
  config: view('mfg_ops_config', z.object({ company: Uuid }), (q) => ({ p_location: q.company })),
};

export const GET = route({ access: { cap: 'projects.jobs', action: 'view' }, mask: 'work_order', query: deskQuery(views) }, async ({ db, query, tenant }) =>
  runView(views, query, db, tenant));

const Dim = z.object({ wall: Text(40), width_in: z.number().min(0).max(10000).nullish(), height_in: z.number().min(0).max(10000).nullish(), depth_in: z.number().min(0).max(10000).nullish(), note: Text(300).nullish() });
const Family = z.enum(['BASE', 'WALL', 'TALL', 'VANITY', 'CLOSET', 'PANEL', 'FILLER', 'COUNTERTOP', 'DESK', 'FEATURE_WALL', 'OTHER']);

const ops = {
  settings: op('mfg_set_ops_settings', z.object({ companyId: Uuid, currentSetOnly: z.boolean().nullish(), measureRequired: z.boolean().nullish(), selectionsGate: z.boolean().nullish(),
    engBufferDays: z.number().int().min(0).max(120).nullish(), drafterHoursPerWeek: z.number().positive().max(168).nullish(), storedMaterialsBilling: z.boolean().nullish() }),
  (b) => ({ p_location: b.companyId, p_patch: { current_set_only: b.currentSetOnly ?? null, measure_required: b.measureRequired ?? null, selections_gate: b.selectionsGate ?? null,
    eng_buffer_days: b.engBufferDays ?? null, drafter_hours_per_week: b.drafterHoursPerWeek ?? null, stored_materials_billing: b.storedMaterialsBilling ?? null } })),
  schedule_measure: op('mfg_schedule_measure', z.object({ jobId: Uuid, wbsId: Uuid.nullish(), on: IsoDate, room: Text(80).nullish(), notes: Text(500).nullish() }),
    (b) => ({ p_job: b.jobId, p_wbs: b.wbsId ?? null, p_on: b.on, p_attrs: { room: b.room ?? null, notes: b.notes ?? null } })),
  record_measure: op('mfg_record_measure', z.object({ measureId: Uuid, dims: z.array(Dim).max(100), photoIds: z.array(Uuid).max(30).default([]), notes: Text(1000).nullish(), linkMeasureId: Uuid.nullish() }),
    (b) => ({ p_measure: b.measureId, p_dims: b.dims, p_photos: b.photoIds, p_notes: b.notes ?? null, p_link_measure: b.linkMeasureId ?? null })),
  waive_measure: op('mfg_waive_measure', z.object({ measureId: Uuid, reason: Req(500, 'The reason') }), (b) => ({ p_measure: b.measureId, p_reason: b.reason })),
  seed_selections: op('mfg_seed_cabinet_selections', z.object({ jobId: Uuid, wbsId: Uuid.nullish(), dueOn: IsoDate.nullish(), rows: z.array(z.object({
    category: Req(80, 'The category'), title: Text(200).nullish(), description: Text(1000).nullish(), allowance_cents: PosCents.default(0), due_on: IsoDate.nullish(), room: Text(80).nullish(),
    options: z.array(z.object({ label: Req(200, 'The option'), description: Text(500).nullish(), upcharge_cents: PosCents.default(0), finish: Text(80).nullish(), recommended: z.boolean().nullish() })).max(20).default([]) })).min(1).max(40) }),
  (b) => ({ p_job: b.jobId, p_wbs: b.wbsId ?? null, p_rows: b.rows, p_due_on: b.dueOn ?? null })),
  create_drawing: op('mfg_create_shop_drawing', z.object({ jobId: Uuid, wbsId: Uuid.nullish(), title: Req(200, 'The title'), fileId: Uuid.nullish() }), (b) => ({ p_job: b.jobId, p_wbs: b.wbsId ?? null, p_title: b.title, p_file: b.fileId ?? null })),
  stamp: op('mfg_record_stamp', z.object({ id: Uuid, code: z.enum(['APPROVED', 'APPROVED_AS_NOTED', 'REVISE_RESUBMIT', 'REJECTED']), by: Req(200, 'Who stamped it'), comments: Text(2000).nullish(), stampedFileId: Uuid.nullish() }),
    (b) => ({ p_id: b.id, p_code: b.code, p_by: b.by, p_comments: b.comments ?? null, p_stamped_file: b.stampedFileId ?? null })),
  release_drawing: op('mfg_release_shop_drawing', z.object({ id: Uuid }), (b) => ({ p_id: b.id })),
  save_task: op('mfg_save_eng_task', z.object({ jobId: Uuid, id: Uuid.nullish(), wbsId: Uuid.nullish(), kind: z.enum(['DRAFTING', 'REVISION', 'CAD', 'CHECK', 'CO_REVISION']).nullish(), title: Text(200).nullish(),
    assigneeId: Uuid.nullish(), slotOn: IsoDate.nullish(), dueOn: IsoDate.nullish(), estHours: z.number().min(0).max(2000).nullish() }),
  (b) => ({ p_job: b.jobId, p_id: b.id ?? null, p_attrs: { wbs_id: b.wbsId ?? null, kind: b.kind ?? null, title: b.title ?? null, assignee_membership: b.assigneeId ?? null, slot_on: b.slotOn ?? null,
    due_on: b.dueOn ?? null, est_hours: b.estHours ?? null } })),
  move_task: op('mfg_move_eng_task', z.object({ taskId: Uuid, status: z.enum(['QUEUED', 'IN_PROGRESS', 'SUBMITTED', 'DONE', 'CANCELLED']) }), (b) => ({ p_task: b.taskId, p_status: b.status })),
  log_hours: op('mfg_log_eng_hours', z.object({ taskId: Uuid, hours: z.number().positive().max(24), workDate: IsoDate.nullish(), note: Text(300).nullish() }), (b) => ({ p_task: b.taskId, p_hours: b.hours, p_work_date: b.workDate ?? null, p_note: b.note ?? null })),
  co_areas: op('mfg_link_co_areas', z.object({ coId: Uuid, wbsIds: z.array(Uuid).max(100) }), (b) => ({ p_co: b.coId, p_wbs: b.wbsIds })),
  part_edges: op('mfg_set_part_edges', z.object({ lineId: Uuid, edges: z.object({ l1: z.string().max(20).nullish(), l2: z.string().max(20).nullish(), w1: z.string().max(20).nullish(), w2: z.string().max(20).nullish() }), label: Text(40).nullish(), machining: z.boolean().nullish() }),
    (b) => ({ p_line: b.lineId, p_edges: b.edges, p_label: b.label ?? null, p_machining: b.machining ?? null })),
  family_routing: op('mfg_set_family_routing', z.object({ companyId: Uuid, family: Family, routingId: Uuid.nullable() }), (b) => ({ p_location: b.companyId, p_family: b.family, p_routing: b.routingId })),
  apply_family: op('mfg_apply_family_routing', z.object({ woId: Uuid, family: Family }), (b) => ({ p_wo: b.woId, p_family: b.family })),
};

export const POST = route({ access: { cap: 'projects.jobs', action: 'view' }, ops: { settings: { cap: 'projects.production', action: 'edit' } }, mask: 'work_order', body: deskBody(ops) },
  async ({ db, body, tenant }) => runOp(ops, body, db, tenant));

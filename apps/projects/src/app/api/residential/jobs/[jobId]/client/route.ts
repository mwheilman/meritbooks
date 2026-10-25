export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { pm } from '@/lib/pm/db';
import { resRpc, resWrote } from '@/lib/residential/rpc';
import { Text, Uuid } from '@/lib/residential/schemas';

export interface DateChangeRow { id: string; task_id: string; task_title: string; old_start: string | null; new_start: string | null; old_finish: string | null; new_finish: string | null;
  shift_days: number; status: string; reason_code: string | null; explanation: string | null; created_at: string; posted_at: string | null }
export interface ClientUpdateRow { id: string; week_of: string; status: string; body: string; sections: Record<string, unknown>; photo_document_ids: string[]; drafted_by: string; edited: boolean; sent_at: string | null }
export interface CloseoutItemRow { id: string; kind: string; title: string; detail: Record<string, unknown>; doc_file_id: string | null; document_id: string | null; source: string; included: boolean; sort: number }

/** The homeowner-facing side of a job: date changes to explain (RES-52), weekly updates (RES-90), the closeout package (RES-97). */
export const GET = route({ access: { cap: 'projects.jobs', action: 'view' }, mask: false }, async ({ db, params }) => {
  const job = params.jobId!;
  const changes = resWrote<DateChangeRow[]>(await pm(db).from('res_client_date_changes')
    .select('id, task_id, task_title, old_start, new_start, old_finish, new_finish, shift_days, status, reason_code, explanation, created_at, posted_at')
    .eq('job_id', job).order('created_at', { ascending: false }).limit(50));
  const updates = resWrote<ClientUpdateRow[]>(await pm(db).from('res_client_updates')
    .select('id, week_of, status, body, sections, photo_document_ids, drafted_by, edited, sent_at').eq('job_id', job).neq('status', 'DISCARDED').order('week_of', { ascending: false }).limit(12));
  const pkg = resWrote<Array<{ id: string; status: string; title: string; published_at: string | null }>>(await pm(db).from('res_closeout_packages').select('id, status, title, published_at').eq('job_id', job).limit(1));
  const items = pkg[0] ? resWrote<CloseoutItemRow[]>(await pm(db).from('res_closeout_items')
    .select('id, kind, title, detail, doc_file_id, document_id, source, included, sort').eq('package_id', pkg[0].id).order('sort')) : [];
  const visible = resWrote<Array<{ id: string; title: string; is_milestone: boolean; client_visible: boolean }>>(await pm(db).from('tasks')
    .select('id, title, is_milestone, client_visible').eq('job_id', job).eq('client_visible', true).limit(300));
  return { changes, updates, closeout: pkg[0] ? { ...pkg[0], items } : null, clientVisibleTasks: visible.length };
});

const Reason = z.enum(['WEATHER', 'INSPECTION', 'MATERIAL', 'SELECTION', 'TRADE', 'CHANGE_ORDER', 'HOMEOWNER', 'OTHER']);
const Body = z.discriminatedUnion('op', [
  z.object({ op: z.literal('schedule_filter'), keywords: z.array(Text(40).min(2)).max(30).nullish() }),
  z.object({ op: z.literal('post_change'), changeId: Uuid, reason: Reason, explanation: Text(2000).nullish() }),
  z.object({ op: z.literal('dismiss_change'), changeId: Uuid }),
  z.object({ op: z.literal('draft_update') }),
  z.object({ op: z.literal('edit_update'), updateId: Uuid, body: Text(4000).min(1, 'Write the update'), photoDocumentIds: z.array(Uuid).max(10).nullish() }),
  z.object({ op: z.literal('send_update'), updateId: Uuid }),
  z.object({ op: z.literal('assemble_closeout') }),
  z.object({ op: z.literal('add_closeout_item'), kind: z.enum(['WARRANTY', 'MANUAL', 'PAINT_COLOR', 'PRODUCT', 'SPEC_BOOK', 'ROUGH_IN_PHOTO', 'LIEN_RELEASE', 'OTHER']),
    title: Text(200).min(1), docFileId: Uuid.nullish(), documentId: Uuid.nullish() }),
  z.object({ op: z.literal('include_item'), itemId: Uuid, included: z.boolean() }),
  z.object({ op: z.literal('publish_closeout'), packageId: Uuid }),
]);

export const POST = route({ access: { cap: 'projects.jobs', action: 'edit' },
  ops: { assemble_closeout: { cap: 'projects.documents', action: 'edit' }, add_closeout_item: { cap: 'projects.documents', action: 'edit' },
    include_item: { cap: 'projects.documents', action: 'edit' }, publish_closeout: { cap: 'projects.documents', action: 'edit' } },
  mask: false, body: Body }, async ({ db, params, body }) => {
  const job = params.jobId!;
  switch (body.op) {
    case 'schedule_filter': return resRpc(db, 'res_apply_client_schedule_filter', { p_job: job, p_keywords: body.keywords ?? null });
    case 'post_change': return resRpc(db, 'res_post_date_change', { p_change: body.changeId, p_reason: body.reason, p_explanation: body.explanation ?? null });
    case 'dismiss_change': return { changeId: await resRpc<string>(db, 'res_dismiss_date_change', { p_change: body.changeId }) };
    case 'draft_update': return { updateId: await resRpc<string>(db, 'res_draft_client_update', { p_job: job, p_week_of: null }) };
    case 'edit_update': return { updateId: await resRpc<string>(db, 'res_edit_client_update', { p_update: body.updateId, p_body: body.body, p_photos: body.photoDocumentIds ?? null }) };
    case 'send_update': return resRpc(db, 'res_send_client_update', { p_update: body.updateId });
    case 'assemble_closeout': return resRpc(db, 'res_assemble_closeout', { p_job: job });
    case 'add_closeout_item':
      return { itemId: await resRpc<string>(db, 'res_add_closeout_item', { p_job: job, p_kind: body.kind, p_title: body.title, p_detail: {}, p_doc_file: body.docFileId ?? null, p_document: body.documentId ?? null }) };
    case 'include_item': return { itemId: await resRpc<string>(db, 'res_set_closeout_item', { p_item: body.itemId, p_included: body.included }) };
    case 'publish_closeout': return resRpc(db, 'res_publish_closeout', { p_package: body.packageId });
  }
});

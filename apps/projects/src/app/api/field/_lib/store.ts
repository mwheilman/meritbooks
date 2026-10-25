import 'server-only';
/**
 * The Supabase FieldStore: every call runs on the caller's RLS client (route() hands it over),
 * never the service role. Reads of time come from pm.v_time_entries_masked and select only
 * non-money columns; writes touch only field-owned columns.
 *
 * Idempotency keys, per record:
 *   time entry   pm.time_entries.source_ref = 'wf:seg:<clock-in command id>[:<employee id>]'
 *                (unique per org — the database is the dedupe guarantor)
 *   daily log /  pm.field_logs.ext->>'_client_command_id' (system ext keys start with "_": pm.validate_ext)
 *   checklist
 *   punch item   pm.punch_items.ext->>'_client_command_id'
 *   photo        public.documents.storage_path = '<org>/projects/field/<job>/<command id>.<ext>'
 *                (unique per org)
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { HttpError, PmQueryError, type PgErrorLike } from '@/lib/api-errors';
import { call } from '@/lib/pm/ops/rpc';
import { laborErrorCopy } from '@/lib/pm/labor/errors';
import { approveTimeEntries } from '@/lib/approvals/server';
import {
  DuplicateRowError, extError, extViolation,
  type DocSubject, type FieldJob, type FieldMe, type FieldStore, type NewDocument, type NewLog, type NewPunch, type NewTime, type TimeRow,
} from './store-types';
import type { AssignmentStatus } from './rules';

const TIME_FIELD_COLS = 'id, job_id, employee_id, user_id, work_date, hours, cost_code_id, notes, approval_state, source_ref';

function fail(what: string, e: PgErrorLike): never {
  if ((e.code ?? '') === '23505') throw new DuplicateRowError(what);
  throw new PmQueryError(what, e);
}

export function createFieldStore(db: SupabaseClient, who: { userId: string; orgId: string }): FieldStore {
  const pm = () => db.schema('pm');
  let meCache: Promise<FieldMe | null> | null = null;

  return {
    me() {
      meCache ??= (async () => {
        const r = await db.schema('core').from('employees').select('id, first_name, last_name').eq('clerk_user_id', who.userId).eq('is_active', true).limit(1).maybeSingle();
        if (r.error) return null;
        const e = r.data as { id: string; first_name: string | null; last_name: string | null } | null;
        return e ? { employeeId: e.id, name: [e.first_name, e.last_name].filter(Boolean).join(' ') || 'Team member' } : { employeeId: null, name: 'Team member' };
      })();
      return meCache;
    },

    async job(jobId) {
      const r = await pm().from('projects').select('job_id, location_id, site_lat, site_lng').eq('job_id', jobId).maybeSingle();
      if (r.error) fail('load job', r.error);
      const j = r.data as { job_id: string; location_id: string; site_lat: number | string | null; site_lng: number | string | null } | null;
      return j ? ({ jobId: j.job_id, companyId: j.location_id, siteLat: j.site_lat == null ? null : Number(j.site_lat), siteLng: j.site_lng == null ? null : Number(j.site_lng) } satisfies FieldJob) : null;
    },

    async assignment(id) {
      const r = await pm().from('dispatch_assignments').select('id, job_id, status').eq('id', id).maybeSingle();
      if (r.error) fail('load visit', r.error);
      return (r.data ?? null) as { id: string; job_id: string; status: AssignmentStatus } | null;
    },

    async setAssignmentStatus(id, status) {
      await call(db, 'set_assignment_status', { p_assignment: id, p_status: status });
    },

    async timeBySourceRef(ref) {
      const r = await pm().from('v_time_entries_masked').select(TIME_FIELD_COLS).eq('source_ref', ref).maybeSingle();
      if (r.error) fail('load time', r.error);
      return (r.data ?? null) as TimeRow | null;
    },

    async timeByIds(ids) {
      if (!ids.length) return [];
      const r = await pm().from('v_time_entries_masked').select(TIME_FIELD_COLS).in('id', [...ids]);
      if (r.error) fail('load time', r.error);
      return (r.data ?? []) as TimeRow[];
    },

    async insertTime(row: NewTime) {
      const r = await pm().from('time_entries').insert({ ...row, pay_type: 'REG', approval_state: 'DRAFT' }).select('id');
      if (r.error) fail('add time', r.error);
      const id = (r.data as Array<{ id: string }> | null)?.[0]?.id;
      if (!id) throw new HttpError(500, 'The time was not saved. It will be sent again.', 'CREATE_FAILED');
      return id;
    },

    async updateTime(id, patch) {
      const r = await pm().from('time_entries').update(patch).eq('id', id).select('id');
      if (r.error) fail('update time', r.error);
      if (!(r.data as unknown[] | null)?.length) throw new HttpError(403, 'That time entry can’t be changed from your phone any more.', 'TIME_NOT_EDITABLE');
    },

    async submitTime(ids) {
      if (!ids.length) return 0;
      const r = await pm().from('time_entries').update({ approval_state: 'SUBMITTED' }).in('id', [...ids]).in('approval_state', ['DRAFT', 'REJECTED']).select('id');
      if (r.error) fail('submit time', r.error);
      return (r.data as unknown[] | null)?.length ?? 0;
    },

    async approveTime(ids) {
      // through the approvals engine (1113): counts entries approved now (a later step may remain for others)
      const r = await approveTimeEntries(db, [...ids], (e) => {
        const c = laborErrorCopy(e);
        return c ? new HttpError(c.status, c.error, c.code) : new PmQueryError('approve time', e);
      }, 'phone');
      return r.approved;
    },

    async logByCommand(commandId) {
      const r = await pm().from('field_logs').select('id, job_id').eq('ext->>_client_command_id', commandId).limit(1).maybeSingle();
      if (r.error) fail('load log', r.error);
      const row = r.data as { id: string; job_id: string } | null;
      return row ? { id: row.id, jobId: row.job_id } : null;
    },

    async insertLog(row: NewLog) {
      const bad = extViolation(row.ext);
      if (bad) throw new PmQueryError('add daily log', extError(bad, 'field_log'));
      const r = await pm().from('field_logs').insert(row).select('id');
      if (r.error) fail('add daily log', r.error);
      const id = (r.data as Array<{ id: string }> | null)?.[0]?.id;
      if (!id) throw new HttpError(500, 'The log was not saved. It will be sent again.', 'CREATE_FAILED');
      return id;
    },

    async punchByCommand(commandId) {
      const r = await pm().from('punch_items').select('id, job_id').eq('ext->>_client_command_id', commandId).limit(1).maybeSingle();
      if (r.error) fail('load punch item', r.error);
      const row = r.data as { id: string; job_id: string } | null;
      return row ? { id: row.id, jobId: row.job_id } : null;
    },

    async insertPunch(row: NewPunch) {
      const bad = extViolation(row.ext);
      if (bad) throw new PmQueryError('add punch item', extError(bad, 'punch_item'));
      const r = await pm().from('punch_items').insert({ ...row, kind: 'PUNCH' }).select('id');
      if (r.error) fail('add punch item', r.error);
      const id = (r.data as Array<{ id: string }> | null)?.[0]?.id;
      if (!id) throw new HttpError(500, 'The punch item was not saved. It will be sent again.', 'CREATE_FAILED');
      return id;
    },

    async documentByPath(path) {
      const r = await db.from('documents').select('id').eq('storage_path', path).limit(1).maybeSingle();
      if (r.error) fail('load photo', r.error);
      return (r.data as { id: string } | null)?.id ?? null;
    },

    async uploadObject(path, bytes, contentType) {
      // The `documents` bucket's storage policies let a member write only under their org's folder (mig 112).
      const up = await db.storage.from('documents').upload(path, bytes, { contentType, upsert: false });
      if (!up.error) return 'ok';
      const status = Number((up.error as { statusCode?: string | number }).statusCode ?? 0);
      if (status === 409 || /exists/i.test(up.error.message)) return 'exists';
      throw new HttpError(status >= 400 && status < 500 && status !== 429 ? 422 : 503, 'The photo did not upload. It will be sent again.', 'UPLOAD_FAILED');
    },

    async insertDocument(row: NewDocument) {
      const r = await db.from('documents').insert({ ...row, org_id: who.orgId, doc_type: 'OTHER', uploaded_by_user: who.userId }).select('id');
      if (r.error) fail('record photo', r.error);
      const id = (r.data as Array<{ id: string }> | null)?.[0]?.id;
      if (!id) throw new HttpError(500, 'The photo was not recorded. It will be sent again.', 'CREATE_FAILED');
      return id;
    },

    async linkDocument(documentId, jobId, subject: DocSubject, role) {
      const r = await pm().from('document_links').insert({ document_id: documentId, job_id: jobId, subject_table: subject.table, subject_id: subject.id, role }).select('id');
      if (r.error && (r.error.code ?? '') !== '23505') fail('link photo', r.error);
    },
  };
}

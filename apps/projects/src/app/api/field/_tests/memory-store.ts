/** In-memory FieldStore for the field API tests: same contract as the Supabase store, no database. */
import { PmQueryError } from '@/lib/api-errors';
import { DuplicateRowError, extError, extViolation, type DocSubject, type FieldJob, type FieldMe, type FieldStore, type NewDocument, type NewLog, type NewPunch, type NewTime, type TimeRow } from '../_lib/store-types';
import type { ApprovalState, AssignmentStatus } from '../_lib/rules';

export interface MemoryState {
  me: FieldMe | null;
  jobs: Map<string, FieldJob>;
  assignments: Map<string, { id: string; job_id: string; status: AssignmentStatus }>;
  time: Map<string, TimeRow>;
  logs: Map<string, NewLog & { id: string }>;
  punches: Map<string, NewPunch & { id: string }>;
  documents: Map<string, NewDocument & { id: string }>;
  objects: Map<string, number>;
  links: Array<{ documentId: string; jobId: string; subject: DocSubject; role: string }>;
  /** Merged into the next ext written (to prove a bad key is refused end to end). */
  injectExt: Record<string, unknown> | null;
  /** Set to make the next store call fail like a database outage. */
  failNext: { code: string; message: string } | null;
  calls: string[];
}

let seq = 0;
const nextId = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

export function memoryState(): MemoryState {
  return {
    me: { employeeId: 'eeeeeeee-0000-4000-8000-000000000001', name: 'Andre Willis' },
    jobs: new Map(), assignments: new Map(), time: new Map(), logs: new Map(), punches: new Map(), documents: new Map(),
    objects: new Map(), links: [], injectExt: null, failNext: null, calls: [],
  };
}

export function memoryStore(s: MemoryState): FieldStore {
  const trip = (what: string) => {
    s.calls.push(what);
    if (s.failNext) {
      const e = s.failNext;
      s.failNext = null;
      throw new PmQueryError(what, e);
    }
  };
  const withInjected = (ext: Record<string, unknown>): Record<string, unknown> => {
    const extra = s.injectExt;
    s.injectExt = null;
    return extra ? { ...ext, ...extra } : ext;
  };
  return {
    async me() { return s.me; },
    async job(id) { trip('job'); return s.jobs.get(id) ?? null; },
    async assignment(id) { trip('assignment'); return s.assignments.get(id) ?? null; },
    async setAssignmentStatus(id, status) {
      trip('setAssignmentStatus');
      const a = s.assignments.get(id);
      if (a) a.status = status;
    },
    async timeBySourceRef(ref) { trip('timeBySourceRef'); return [...s.time.values()].find((t) => t.source_ref === ref) ?? null; },
    async timeByIds(ids) { trip('timeByIds'); return ids.map((i) => s.time.get(i)).filter((x): x is TimeRow => !!x); },
    async insertTime(row: NewTime) {
      trip('insertTime');
      if ([...s.time.values()].some((t) => t.source_ref === row.source_ref)) throw new DuplicateRowError('time');
      const id = nextId();
      s.time.set(id, { id, ...row, approval_state: 'DRAFT' });
      return id;
    },
    async updateTime(id, patch) {
      trip('updateTime');
      const t = s.time.get(id);
      if (t) s.time.set(id, { ...t, ...(patch as Partial<TimeRow>) });
    },
    async submitTime(ids) {
      trip('submitTime');
      let n = 0;
      for (const id of ids) {
        const t = s.time.get(id);
        if (t && (t.approval_state === 'DRAFT' || t.approval_state === 'REJECTED')) {
          t.approval_state = 'SUBMITTED';
          n += 1;
        }
      }
      return n;
    },
    async approveTime(ids) {
      trip('approveTime');
      for (const id of ids) {
        const t = s.time.get(id);
        if (t) t.approval_state = 'APPROVED' as ApprovalState;
      }
      return ids.length;
    },
    async logByCommand(cmd) {
      trip('logByCommand');
      const l = [...s.logs.values()].find((x) => x.ext._client_command_id === cmd);
      return l ? { id: l.id, jobId: l.job_id } : null;
    },
    async insertLog(row) {
      trip('insertLog');
      const ext = withInjected(row.ext);
      const bad = extViolation(ext); // pm.validate_ext: the trigger on pm.field_logs
      if (bad) throw new PmQueryError('add daily log', extError(bad, 'field_log'));
      const id = nextId();
      s.logs.set(id, { id, ...row, ext });
      return id;
    },
    async punchByCommand(cmd) {
      trip('punchByCommand');
      const p = [...s.punches.values()].find((x) => x.ext._client_command_id === cmd);
      return p ? { id: p.id, jobId: p.job_id } : null;
    },
    async insertPunch(row) {
      trip('insertPunch');
      const ext = withInjected(row.ext);
      const bad = extViolation(ext); // pm.validate_ext: the trigger on pm.punch_items
      if (bad) throw new PmQueryError('add punch item', extError(bad, 'punch_item'));
      const id = nextId();
      s.punches.set(id, { id, ...row, ext });
      return id;
    },
    async documentByPath(path) { trip('documentByPath'); return [...s.documents.values()].find((d) => d.storage_path === path)?.id ?? null; },
    async uploadObject(path, bytes) {
      trip('uploadObject');
      if (s.objects.has(path)) return 'exists';
      s.objects.set(path, bytes.byteLength);
      return 'ok';
    },
    async insertDocument(row) { trip('insertDocument'); const id = nextId(); s.documents.set(id, { id, ...row }); return id; },
    async linkDocument(documentId, jobId, subject, role) { trip('linkDocument'); s.links.push({ documentId, jobId, subject, role }); },
  };
}

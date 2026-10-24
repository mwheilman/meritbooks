/**
 * What the field command handlers need from the database, as an interface: the Supabase
 * implementation (store.ts) runs every call on the caller's RLS client; tests use an in-memory
 * one. No method reads or writes a money column.
 */
import type { ApprovalState, AssignmentStatus } from './rules';

export interface FieldJob {
  jobId: string;
  companyId: string;
  siteLat: number | null;
  siteLng: number | null;
}

export interface FieldMe {
  employeeId: string | null;
  name: string;
}

/** pm.time_entries as the phone may see it (from pm.v_time_entries_masked; no rate columns). */
export interface TimeRow {
  id: string;
  job_id: string;
  employee_id: string | null;
  user_id: string | null;
  work_date: string;
  hours: number;
  cost_code_id: string | null;
  notes: string | null;
  approval_state: ApprovalState;
  source_ref: string | null;
}

export interface NewTime {
  job_id: string;
  employee_id: string | null;
  user_id: string | null;
  work_date: string;
  hours: number;
  cost_code_id: string | null;
  notes: string | null;
  source_ref: string;
}

export interface NewLog {
  job_id: string;
  log_date: string;
  kind: 'DAILY' | 'INSPECTION' | 'SAFETY' | 'DELIVERY' | 'VISIT';
  body: string | null;
  weather: Record<string, unknown> | null;
  crew_count: number | null;
  hours: number | null;
  ext: Record<string, unknown>;
}

export interface NewPunch {
  job_id: string;
  title: string;
  description: string | null;
  area: string | null;
  due_on: string | null;
  ext: Record<string, unknown>;
}

export interface NewDocument {
  storage_path: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  entity_type: string;
  entity_id: string;
  notes: string | null;
}

export type DocSubject = { table: 'projects' | 'field_logs' | 'punch_items'; id: string };

/** Thrown by insert* when the row's unique key already exists (a racing re-send). */
export class DuplicateRowError extends Error {
  constructor(what: string) {
    super(`${what} already exists`);
    this.name = 'DuplicateRowError';
  }
}

export interface FieldStore {
  me(): Promise<FieldMe | null>;
  job(jobId: string): Promise<FieldJob | null>;
  assignment(id: string): Promise<{ id: string; job_id: string; status: AssignmentStatus } | null>;
  setAssignmentStatus(id: string, status: 'EN_ROUTE' | 'ON_SITE'): Promise<void>;
  timeBySourceRef(ref: string): Promise<TimeRow | null>;
  timeByIds(ids: ReadonlyArray<string>): Promise<TimeRow[]>;
  insertTime(row: NewTime): Promise<string>;
  updateTime(id: string, patch: Record<string, unknown>): Promise<void>;
  submitTime(ids: ReadonlyArray<string>): Promise<number>;
  approveTime(ids: ReadonlyArray<string>): Promise<number>;
  /** The log or checklist a command made, and its job (photos may attach only on the same job). */
  logByCommand(commandId: string): Promise<{ id: string; jobId: string } | null>;
  insertLog(row: NewLog): Promise<string>;
  punchByCommand(commandId: string): Promise<{ id: string; jobId: string } | null>;
  insertPunch(row: NewPunch): Promise<string>;
  documentByPath(path: string): Promise<string | null>;
  uploadObject(path: string, bytes: ArrayBuffer, contentType: string): Promise<'ok' | 'exists'>;
  insertDocument(row: NewDocument): Promise<string>;
  linkDocument(documentId: string, jobId: string, subject: DocSubject, role: string): Promise<void>;
}

/**
 * The top-level rule of pm.validate_ext (1100), which guards pm.field_logs.ext and
 * pm.punch_items.ext: a key must be a company-defined field (pm.field_defs) or a system key
 * starting with "_". The field routes write system keys only, so `defined` is empty for them.
 * Returns the first key the database would refuse, or null.
 */
export function extViolation(ext: Readonly<Record<string, unknown>>, defined: ReadonlyArray<string> = []): string | null {
  for (const k of Object.keys(ext)) {
    if (k.startsWith('_')) continue;
    if (!defined.includes(k)) return k;
  }
  return null;
}

/** The PG error pm.validate_ext raises (22023), for stores that check before writing. */
export function extError(key: string, object: string): { code: string; message: string } {
  return { code: '22023', message: `PM_EXT_UNKNOWN_FIELD: ${key} is not a defined ${object} field` };
}

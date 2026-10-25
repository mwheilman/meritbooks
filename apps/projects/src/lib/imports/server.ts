import 'server-only';
/**
 * Import engine ↔ database (migration 1121). RLS client only; every write is a guarded definer
 * RPC (pm.import_* / pm.opening_* / pm.onboarding_*). Each function throws PmQueryError on a PG
 * error so route() maps it to a plain response.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { must } from '@/lib/api';
import { plainMapping } from './mapping';
import { stagePayload } from './engine';
import type { HandoffDraft, CommittedRow } from './opening';
import type { BatchSummary, CommitResult, ImportEntity, OpeningKind, PreviewResult, SavedMapping, StageResult, TieOut } from './types';

const pm = (db: SupabaseClient) => db.schema('pm');

export async function savedMappings(db: SupabaseClient, companyId: string): Promise<SavedMapping[]> {
  const res = await pm(db).from('import_mappings').select('source_system, entity, header_signature, mapping').eq('location_id', companyId).limit(200);
  return (must(res, 'load saved mappings') ?? []) as SavedMapping[];
}

export async function stageImport(db: SupabaseClient, companyId: string, p: PreviewResult, extraReport: Record<string, unknown> = {}): Promise<StageResult> {
  return must(await pm(db).rpc('import_stage', {
    p_location: companyId, p_source_system: p.source, p_entity: p.entity, p_file_name: p.fileName, p_file_hash: p.fileHash,
    p_mapping: plainMapping(p.mapping), p_rows: stagePayload(p),
    p_report: { header_signature: p.headerSignature, validation: p.report, detection: p.detection, ...extraReport },
  }), 'stage the import') as StageResult;
}

export const BATCH_COLS = 'id, location_id, source_system, entity, file_name, status, row_count, valid_count, invalid_count, created_count, matched_count, skipped_count, error_count, created_at, committed_at';

export async function loadBatch(db: SupabaseClient, batchId: string) {
  const res = await pm(db).from('import_batches').select(`${BATCH_COLS}, mapping, report, result`).eq('id', batchId).maybeSingle();
  return must(res, 'load the import') as (BatchSummary & { location_id: string; mapping: Record<string, string>; report: Record<string, unknown>; result: Record<string, unknown> }) | null;
}

export async function commitImport(db: SupabaseClient, batchId: string): Promise<CommitResult> {
  return must(await pm(db).rpc('import_commit', { p_batch: batchId }), 'bring the import in') as CommitResult;
}

export async function discardImport(db: SupabaseClient, batchId: string): Promise<{ batch_id: string; status: string; rows_removed: number }> {
  return must(await pm(db).rpc('import_discard', { p_batch: batchId }), 'undo the import') as { batch_id: string; status: string; rows_removed: number };
}

export async function saveMapping(db: SupabaseClient, companyId: string, source: string, entity: string, signature: string, mapping: Record<string, string>): Promise<void> {
  must(await pm(db).rpc('import_save_mapping', { p_location: companyId, p_source_system: source, p_entity: entity, p_header_signature: signature, p_mapping: mapping }), 'save the column mapping');
}

export async function listBatches(db: SupabaseClient, companyId: string, limit = 100): Promise<BatchSummary[]> {
  const res = await pm(db).from('import_batches').select(BATCH_COLS).eq('location_id', companyId).neq('status', 'DISCARDED').order('created_at', { ascending: false }).limit(limit);
  return (must(res, 'load imports') ?? []) as BatchSummary[];
}

export interface RowDetail {
  row_number: number;
  external_ref: string | null;
  validation: 'VALID' | 'WARN' | 'INVALID';
  outcome: string;
  issues: { level: 'error' | 'warn'; field?: string; message: string }[];
  message: string | null;
  target_table: string | null;
  target_id: string | null;
  data: Record<string, unknown>;
  match: { name?: string; score?: number; level?: string } | null;
}

export async function batchRows(db: SupabaseClient, batchId: string, opts: { outcome?: string | null; offset?: number; limit?: number } = {}): Promise<{ rows: RowDetail[]; total: number }> {
  let qy = pm(db).from('import_rows').select('row_number, external_ref, validation, outcome, issues, message, target_table, target_id, data, match', { count: 'exact' }).eq('batch_id', batchId);
  if (opts.outcome) qy = qy.eq('outcome', opts.outcome);
  const off = Math.max(0, opts.offset ?? 0);
  const res = await qy.order('row_number').range(off, off + Math.min(200, opts.limit ?? 50) - 1);
  return { rows: (must(res, 'load import rows') ?? []) as RowDetail[], total: res.count ?? 0 };
}

/** Rows of the latest committed batch of each entity (the inputs of an opening handoff). */
export async function committedRows(db: SupabaseClient, companyId: string, entities: readonly ImportEntity[]): Promise<{ rows: Partial<Record<ImportEntity, CommittedRow[]>>; batchIds: string[] }> {
  const res = await pm(db).from('import_batches').select('id, entity, committed_at').eq('location_id', companyId).eq('status', 'COMMITTED').in('entity', [...entities])
    .order('committed_at', { ascending: true }).limit(500);
  const batches = (must(res, 'load committed imports') ?? []) as { id: string; entity: ImportEntity }[];
  const out: Partial<Record<ImportEntity, CommittedRow[]>> = {};
  for (const b of batches) {
    const r = await pm(db).from('import_rows').select('row_number, entity, external_ref, data, outcome, target_id').eq('batch_id', b.id).neq('validation', 'INVALID').order('row_number').limit(5000);
    (out[b.entity] ??= []).push(...((must(r, 'load committed rows') ?? []) as CommittedRow[]));
  }
  return { rows: out, batchIds: batches.map((b) => b.id) };
}

export interface HandoffRow {
  id: string;
  kind: OpeningKind;
  as_of_date: string;
  status: 'DRAFT' | 'VALIDATED' | 'SUBMITTED' | 'ACCEPTED' | 'REJECTED' | 'SUPERSEDED';
  totals: Record<string, number>;
  blockers: { ref: string | null; message: string }[];
  tieout: TieOut | null;
  tied_at: string | null;
  books_ref: string | null;
  books_reason: string | null;
  submitted_at: string | null;
  created_at: string;
}
const HANDOFF_COLS = 'id, kind, as_of_date, status, totals, blockers, tieout, tied_at, books_ref, books_reason, submitted_at, created_at';

export async function listHandoffs(db: SupabaseClient, companyId: string): Promise<HandoffRow[]> {
  const res = await pm(db).from('opening_handoffs').select(HANDOFF_COLS).eq('location_id', companyId).neq('status', 'SUPERSEDED').order('created_at', { ascending: false }).limit(50);
  return (must(res, 'load opening positions') ?? []) as HandoffRow[];
}

export async function loadHandoff(db: SupabaseClient, id: string): Promise<(HandoffRow & { location_id: string; payload: Record<string, unknown> }) | null> {
  const res = await pm(db).from('opening_handoffs').select(`${HANDOFF_COLS}, location_id, payload`).eq('id', id).maybeSingle();
  return must(res, 'load the opening position') as (HandoffRow & { location_id: string; payload: Record<string, unknown> }) | null;
}

export async function stageHandoff(db: SupabaseClient, companyId: string, draft: HandoffDraft, batchIds: string[]): Promise<{ handoff_id: string; status: string; totals: Record<string, number>; blockers: unknown[] }> {
  return must(await pm(db).rpc('opening_stage_handoff', {
    p_location: companyId, p_kind: draft.kind, p_as_of: draft.asOf, p_payload: draft.payload, p_facts: draft.facts, p_batch_ids: batchIds,
  }), 'stage the opening position') as { handoff_id: string; status: string; totals: Record<string, number>; blockers: unknown[] };
}

export async function tieOut(db: SupabaseClient, handoffId: string): Promise<TieOut> {
  return must(await pm(db).rpc('opening_tieout', { p_handoff: handoffId }), 'tie out to Merit Books') as TieOut;
}

export async function submitHandoff(db: SupabaseClient, handoffId: string): Promise<{ handoff_id: string; status: string }> {
  return must(await pm(db).rpc('opening_submit_handoff', { p_handoff: handoffId }), 'send the opening position to Merit Books') as { handoff_id: string; status: string };
}

export interface InviteIn {
  name: string;
  email: string | null;
  phone: string | null;
  title: string | null;
  role_key: string;
  projects_only: boolean;
  source: 'import' | 'books_team' | 'manual';
  import_row_id?: string | null;
  employee_id?: string | null;
}

export async function inviteCrew(db: SupabaseClient, companyId: string, people: InviteIn[]) {
  return must(await pm(db).rpc('onboarding_invite_crew', { p_location: companyId, p_people: people }), 'invite the crew') as
    { id: string; name: string; email: string | null; role_key: string; projects_only: boolean; status: 'PENDING' | 'ACCEPTED' | 'CANCELLED' }[];
}

export async function listInvites(db: SupabaseClient, companyId: string) {
  const res = await pm(db).from('crew_invites').select('id, name, email, phone, title, role_key, projects_only, status, created_at, accepted_at').eq('location_id', companyId).neq('status', 'CANCELLED').order('created_at').limit(500);
  return (must(res, 'load invites') ?? []) as { id: string; name: string; email: string | null; phone: string | null; title: string | null; role_key: string; projects_only: boolean; status: string; created_at: string; accepted_at: string | null }[];
}

export async function goLive(db: SupabaseClient, companyId: string, release: string[], discard: string[]) {
  return must(await pm(db).rpc('onboarding_go_live', { p_location: companyId, p_release: release, p_discard: discard }), 'go live') as { live: boolean; released: number; discarded: number; still_held: number };
}

/** Roster rows (imported employees) for the crew step. */
export async function rosterRows(db: SupabaseClient, companyId: string) {
  const b = await pm(db).from('import_batches').select('id').eq('location_id', companyId).eq('entity', 'employee').eq('status', 'COMMITTED').limit(20);
  const ids = ((must(b, 'load imported people') ?? []) as { id: string }[]).map((x) => x.id);
  if (ids.length === 0) return [];
  const r = await pm(db).from('import_rows').select('id, data').in('batch_id', ids).eq('outcome', 'ROSTER').limit(1000);
  return ((must(r, 'load imported people') ?? []) as { id: string; data: Record<string, unknown> }[]);
}

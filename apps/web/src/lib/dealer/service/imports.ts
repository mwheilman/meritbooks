/**
 * Import batches (FPB §8, V10). D2 owns parsing + mapping profiles + the AI parsers;
 * D1 owns the batch record and the "undo an unposted batch" guarantee. Imported rows
 * carry import_batch_id so a batch can be undone while nothing in it has posted.
 */

import type { ImportFileKind, ImportStatus } from '../types';
import type { DealerCtx } from './context';
import { DealerError, dbFail } from './errors';
import { getRow, insertRow, updateRow } from './rows';
import { audit } from './audit';

export interface ImportBatchRow {
  id: string;
  source_system: string;
  file_kind: ImportFileKind;
  file_name: string | null;
  document_id: string | null;
  row_count: number;
  accepted_count: number;
  rejected_count: number;
  errors: unknown;
  status: ImportStatus;
}

export async function createImportBatch(
  d: DealerCtx,
  input: { sourceSystem: string; fileKind: ImportFileKind; fileName?: string | null; documentId?: string | null; rowCount?: number },
): Promise<ImportBatchRow> {
  return insertRow<ImportBatchRow>(d, 'dealer_import_batches', {
    source_system: input.sourceSystem, file_kind: input.fileKind, file_name: input.fileName ?? null,
    document_id: input.documentId ?? null, row_count: input.rowCount ?? 0, created_by: d.userId,
  }, 'Import batch');
}

export async function updateImportBatch(
  d: DealerCtx,
  id: string,
  p: { status?: Exclude<ImportStatus, 'UNDONE'>; rowCount?: number; acceptedCount?: number; rejectedCount?: number; errors?: unknown[] },
): Promise<ImportBatchRow> {
  const b = await getRow<ImportBatchRow>(d, 'dealer_import_batches', id, 'Import batch');
  if (b.status === 'UNDONE') throw new DealerError('CONFLICT', 'This batch was undone');
  const v: Record<string, unknown> = {};
  if (p.status) v.status = p.status;
  if (p.rowCount !== undefined) v.row_count = p.rowCount;
  if (p.acceptedCount !== undefined) v.accepted_count = p.acceptedCount;
  if (p.rejectedCount !== undefined) v.rejected_count = p.rejectedCount;
  if (p.errors !== undefined) v.errors = p.errors;
  return (await updateRow<ImportBatchRow>(d, 'dealer_import_batches', id, v, 'Import batch')) ?? b;
}

/** Undo a batch: refuses if anything in it posted to the GL; otherwise voids its rows. */
export async function undoImportBatch(d: DealerCtx, id: string): Promise<{ voided: Record<string, number> }> {
  const b = await getRow<ImportBatchRow>(d, 'dealer_import_batches', id, 'Import batch');
  if (b.status === 'UNDONE') return { voided: {} };
  const base = (t: string) => d.admin.from(t).select('id, status', { count: 'exact' }).eq('org_id', d.orgId).eq('import_batch_id', id);
  const [units, notes, sales, claims, lstmts, ostmts] = await Promise.all([
    base('dealer_units'), base('floor_plan_notes'), base('dealer_unit_sales'), base('warranty_claims'),
    d.admin.from('lender_statements').select('id, status').eq('org_id', d.orgId).eq('import_batch_id', id),
    d.admin.from('oem_statements').select('id, status').eq('org_id', d.orgId).eq('import_batch_id', id),
  ]);
  for (const r of [units, notes, sales, claims, lstmts, ostmts]) if (r.error) dbFail('Import batch lookup failed', r.error);
  const noteIds = ((notes.data ?? []) as { id: string; status: string }[]).map((n) => n.id);
  const unitIds = ((units.data ?? []) as { id: string }[]).map((u) => u.id);

  const blockers: string[] = [];
  if (noteIds.length) {
    const { count } = await d.admin.from('floor_plan_transactions').select('id', { count: 'exact', head: true }).eq('org_id', d.orgId).in('note_id', noteIds).eq('status', 'POSTED').neq('txn_type', 'OPENING');
    if ((count ?? 0) > 0) blockers.push(`${count} posted floor-plan transaction(s)`);
  }
  if (unitIds.length) {
    const { count } = await d.admin.from('dealer_unit_costs').select('id', { count: 'exact', head: true }).eq('org_id', d.orgId).in('unit_id', unitIds).eq('status', 'POSTED').not('gl_entry_id', 'is', null);
    if ((count ?? 0) > 0) blockers.push(`${count} posted unit cost row(s)`);
  }
  if (((sales.data ?? []) as { status: string }[]).some((s) => s.status === 'POSTED')) blockers.push('posted sale(s)');
  if (((claims.data ?? []) as { status: string }[]).some((c) => c.status !== 'DRAFT' && c.status !== 'VOID')) blockers.push('submitted warranty claim(s)');
  if (((lstmts.data ?? []) as { status: string }[]).some((s) => s.status === 'APPROVED')) blockers.push('an approved lender reconciliation');
  if (blockers.length) throw new DealerError('CONFLICT', `This batch can't be undone: it has ${blockers.join(', ')}. Reverse those first.`, { blockers });

  const voided: Record<string, number> = {};
  const v = async (table: string, values: Record<string, unknown>, label: string) => {
    const { data, error } = await d.admin.from(table).update(values).eq('org_id', d.orgId).eq('import_batch_id', id).neq('status', 'VOID').select('id');
    if (error) dbFail(`Undoing ${label} failed`, error);
    voided[label] = (data ?? []).length;
  };
  if (noteIds.length) {
    await d.admin.from('floor_plan_transactions').update({ status: 'VOID' }).eq('org_id', d.orgId).in('note_id', noteIds).eq('status', 'PROPOSED');
    await d.admin.from('floor_plan_curtailments').update({ status: 'WAIVED', waived_by: d.userId, waived_reason: 'Import undone' }).eq('org_id', d.orgId).in('note_id', noteIds).eq('status', 'DUE');
    // OPENING rows carry no GL and stay as the immutable record; voiding the note drops
    // it (and its unit) out of every position and tie-out.
  }
  await v('floor_plan_notes', { status: 'VOID' }, 'notes');
  if (unitIds.length) {
    await d.admin.from('dealer_unit_costs').update({ status: 'VOID' }).eq('org_id', d.orgId).in('unit_id', unitIds).eq('status', 'PROPOSED');
  }
  await v('dealer_unit_sales', { status: 'VOID' }, 'sales');
  await v('warranty_claims', { status: 'VOID' }, 'warrantyClaims');
  await v('dealer_units', { status: 'VOID' }, 'units');
  for (const s of (lstmts.data ?? []) as { id: string }[]) await d.admin.from('lender_statements').delete().eq('org_id', d.orgId).eq('id', s.id);
  for (const s of (ostmts.data ?? []) as { id: string }[]) await d.admin.from('oem_statements').delete().eq('org_id', d.orgId).eq('id', s.id);
  await updateRow(d, 'dealer_import_batches', id, { status: 'UNDONE' }, 'Import batch');
  await audit(d, 'import.undo', 'dealer_import_batches', id, `Undid import batch ${b.file_kind}`, { voided });
  return { voided };
}

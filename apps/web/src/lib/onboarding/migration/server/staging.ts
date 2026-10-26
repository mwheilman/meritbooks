/**
 * Getting a client's data INTO STAGING ("Staged, not in your books" — nothing here posts):
 *
 *   stageFile   a recipe file dropped on a source slot → recognized by its headers (rules
 *               only, recognize.ts) → one run (file name + SHA-256 + parser + control totals)
 *               + its normalized staged rows. Dropping the same slot again supersedes the
 *               earlier run; dropping the identical bytes again is a no-op.
 *   pullQbo     QuickBooks Online, read-only, when the tenant has a live connection: chart,
 *               trial balance at the cutover, customers, vendors, open invoices and bills,
 *               one run per kind.
 */

import crypto from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { serviceWriter } from '@/lib/db/scoped-writer';
import { readRawGrid } from '@/lib/onboarding/intake/sheet';
import { resolveMigrationProvider } from '@/lib/integrations/erp/resolve-provider';
import { dollarsStrToCents } from '@/lib/integrations/erp/quickbooks/transforms';
import { recognizeGrid, inferAccountType, normalizePartyName } from '../recognize';
import { getSourceSystem } from '../catalog';
import type { StagedEntity, StagedPayload } from '../types';
import { STAGED_ENTITIES } from '../types';
import { longDate, plural } from '../format';
import { protectTaxId } from '@/lib/vendors/tin-fingerprint';
import { MigrationError } from './guard';
import { loadRuns, loadSources, logEvent, type ProjectRow, type SourceRow } from './store';

type DB = SupabaseClient;

export const MAX_FILE_BYTES = 15 * 1024 * 1024;
const MAX_ROWS = 50_000;

/** Display name, amount, external id and dedupe key for a staged payload. */
export function describePayload(p: StagedPayload): { name: string; amount: number; externalId: string | null; dedupe: string | null } {
  switch (p.entity) {
    case 'account':
      return { name: `${p.data.number && p.data.number !== p.data.name ? `${p.data.number} ` : ''}${p.data.name}`, amount: p.data.balanceCents, externalId: p.data.number, dedupe: p.data.number || p.data.name.toLowerCase() };
    case 'tb_line':
      return { name: `${p.data.number && p.data.number !== p.data.name ? `${p.data.number} ` : ''}${p.data.name}`, amount: p.data.debitCents - p.data.creditCents, externalId: p.data.number, dedupe: p.data.number || p.data.name.toLowerCase() };
    case 'customer':
    case 'vendor':
      return { name: p.data.name, amount: p.data.ytdPaidCents ?? 0, externalId: null, dedupe: normalizePartyName(p.data.name) || null };
    case 'item':
      return { name: p.data.name, amount: 0, externalId: p.data.sku ?? null, dedupe: (p.data.sku ?? normalizePartyName(p.data.name)) || null };
    case 'dimension':
      return { name: p.data.name, amount: 0, externalId: null, dedupe: `${p.data.kind}:${normalizePartyName(p.data.name)}` };
    case 'job':
      return { name: `${p.data.number ? `${p.data.number} · ` : ''}${p.data.name}`, amount: p.data.contractCents ?? 0, externalId: p.data.number, dedupe: p.data.number ?? normalizePartyName(p.data.name) };
    case 'open_invoice':
    case 'open_bill':
      return { name: `${p.data.docNumber} · ${p.data.party}`, amount: p.data.balanceCents, externalId: p.data.docNumber, dedupe: `${normalizePartyName(p.data.party)}:${p.data.docNumber}` };
    case 'bank_balance':
      return { name: p.data.label, amount: p.data.statementBalanceCents, externalId: p.data.glAccountNumber, dedupe: p.data.label.toLowerCase() };
    case 'evidence':
      return { name: p.data.label, amount: p.data.amountCents ?? 0, externalId: null, dedupe: `${p.data.kind}:${p.data.label.toLowerCase()}` };
  }
}

export interface StageResult {
  runId: string | null;
  entity: StagedEntity | null;
  label: string;
  count: number;
  warnings: string[];
  dropped: number;
  duplicate: boolean;
}

interface WriteRunInput {
  orgId: string;
  userId: string;
  project: ProjectRow;
  source: SourceRow;
  runKind: 'file_parse' | 'pull';
  entity: StagedEntity;
  parser: string;
  label: string;
  fileName: string | null;
  sha: string | null;
  asOf: string | null;
  records: StagedPayload[];
  controlTotals: Record<string, number>;
  warnings: string[];
  dropped: number;
}

/**
 * Security review H2: the persisted payload of a customer / vendor never carries a plaintext tax id —
 * it becomes an org-scoped keyed fingerprint + the last four digits (lib/vendors/tin-fingerprint.ts).
 * Every staged row goes through here; nothing else writes staged_records payloads.
 */
export function persistablePayload(orgId: string, p: StagedPayload): Record<string, unknown> {
  if (p.entity === 'customer' || p.entity === 'vendor') return protectTaxId(orgId, p.data) as unknown as Record<string, unknown>;
  return p.data as unknown as Record<string, unknown>;
}

/** Write one run + its staged rows, superseding the previous active run for the same source + kind. */
async function writeRun(i: WriteRunInput): Promise<string> {
  const writer = serviceWriter();
  const { data: prev } = await writer
    .from('migration_runs')
    .select('id')
    .eq('org_id', i.orgId)
    .eq('project_id', i.project.id)
    .eq('source_id', i.source.id)
    .eq('entity', i.entity)
    .eq('status', 'staged');
  const prevIds = ((prev ?? []) as Array<{ id: string }>).map((r) => r.id);
  const { data: run, error } = await writer
    .from('migration_runs')
    .insert({
      org_id: i.orgId,
      location_id: i.project.location_id,
      project_id: i.project.id,
      source_id: i.source.id,
      run_kind: i.runKind,
      status: 'staged',
      entity: i.entity,
      parser: i.parser.slice(0, 120),
      label: i.label.slice(0, 300),
      file_name: i.fileName ? i.fileName.slice(0, 300) : null,
      file_sha256: i.sha,
      as_of: i.asOf,
      record_counts: { [i.entity]: i.records.length },
      control_totals: i.controlTotals,
      warnings: i.warnings.slice(0, 50),
      dropped_count: i.dropped,
      created_by: i.userId,
    })
    .select('id')
    .single();
  if (error || !run) throw new Error(`Could not stage the file: ${error?.message ?? 'unknown'}`);
  const runId = (run as { id: string }).id;
  const rows = i.records.map((p, idx) => {
    const d = describePayload(p);
    return {
      org_id: i.orgId,
      location_id: i.project.location_id,
      project_id: i.project.id,
      run_id: runId,
      entity: p.entity,
      external_id: d.externalId ? d.externalId.slice(0, 200) : null,
      display_name: (d.name || '(unnamed)').slice(0, 300),
      dedupe_key: d.dedupe ? d.dedupe.slice(0, 300) : null,
      amount_cents: Math.trunc(d.amount || 0),
      payload: persistablePayload(i.orgId, p),
      source_ref: { file: i.fileName, index: idx + 1, run: runId },
    };
  });
  for (let k = 0; k < rows.length; k += 500) {
    const { error: e } = await writer.from('staged_records').insert(rows.slice(k, k + 500));
    if (e) {
      await writer.from('migration_runs').update({ status: 'failed', error: e.message.slice(0, 500) }).eq('id', runId);
      throw new Error(`Could not stage the rows: ${e.message}`);
    }
  }
  if (prevIds.length > 0) {
    await writer.from('migration_runs').update({ status: 'superseded' }).eq('org_id', i.orgId).in('id', prevIds);
    await writer.from('staged_records').delete().eq('org_id', i.orgId).in('run_id', prevIds);
  }
  const now = new Date().toISOString();
  await writer
    .from('migration_sources')
    .update({ status: 'pulled', last_run_id: runId, last_pulled_at: now })
    .eq('org_id', i.orgId)
    .eq('id', i.source.id);
  return runId;
}

export async function stageFile(
  db: DB,
  ctx: { orgId: string; userId: string },
  project: ProjectRow,
  sourceId: string,
  file: { buffer: Buffer; name: string; type: string },
  expectEntity: StagedEntity | null,
): Promise<StageResult> {
  const source = (await loadSources(db, project.id)).find((s) => s.id === sourceId && s.status !== 'archived');
  if (!source) throw new MigrationError('Add the system as a source first.', 404, 'NO_SOURCE');
  if (expectEntity && !(STAGED_ENTITIES as readonly string[]).includes(expectEntity)) throw new MigrationError('Unknown file slot.', 422, 'BAD_SLOT');
  if (file.buffer.length > MAX_FILE_BYTES) throw new MigrationError('That file is over 15 MB — export a smaller date range or split it.', 413, 'TOO_LARGE');
  if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') {
    throw new MigrationError('PDFs go to Documents (they are read by document intelligence). For this step export the report to Excel or CSV — the recipe says how.', 422, 'PDF');
  }
  const sha = crypto.createHash('sha256').update(file.buffer).digest('hex');
  const active = await loadRuns(db, project.id, { activeOnly: true });
  const same = active.find((r) => r.source_id === sourceId && r.file_sha256 === sha);
  if (same) {
    return { runId: same.id, entity: same.entity, label: same.label ?? 'Already staged', count: Object.values(same.record_counts ?? {}).reduce((a, b) => a + Number(b), 0), warnings: ['This exact file is already staged — nothing changed.'], dropped: same.dropped_count, duplicate: true };
  }
  const grid = readRawGrid(file.buffer, file.type, file.name);
  if (grid.length === 0) throw new MigrationError('We couldn’t read any rows from that file. Save it as .xlsx or .csv and drop it again.', 422, 'EMPTY');
  if (grid.length > MAX_ROWS) throw new MigrationError(`That file has more than ${MAX_ROWS.toLocaleString()} rows — split it.`, 413, 'TOO_MANY_ROWS');
  const rec = recognizeGrid(grid, { fileName: file.name, systemId: source.system_id, expectEntity });
  if (!rec.entity || rec.records.length === 0) {
    const why = rec.warnings[0] ?? 'We didn’t recognize the columns.';
    throw new MigrationError(`${why} Check the recipe for the exact report to export.`, 422, 'NOT_RECOGNIZED');
  }
  const warnings = [...rec.warnings];
  if (rec.asOfHint && project.cutover_date && rec.asOfHint !== project.cutover_date && (rec.entity === 'tb_line' || rec.entity === 'open_invoice' || rec.entity === 'open_bill')) {
    warnings.unshift(`This report is as of ${longDate(rec.asOfHint)}, but the cutover is ${longDate(project.cutover_date)}. Re-export it as of the cutover date.`);
  }
  const runId = await writeRun({
    orgId: ctx.orgId, userId: ctx.userId, project, source, runKind: 'file_parse', entity: rec.entity, parser: rec.parser, label: rec.label,
    fileName: file.name, sha, asOf: rec.asOfHint, records: rec.records, controlTotals: rec.controlTotals, warnings, dropped: rec.dropped.length,
  });
  const sysName = getSourceSystem(source.system_id)?.name ?? source.system_id;
  await logEvent(ctx.orgId, project, 'file_staged', `${sysName}: ${rec.label}`, { actor: ctx.userId, detail: { runId, file: file.name, sha256: sha, parser: rec.parser, count: rec.records.length } });
  return { runId, entity: rec.entity, label: rec.label, count: rec.records.length, warnings, dropped: rec.dropped.length, duplicate: false };
}

// ── QuickBooks Online pull (read-only) ───────────────────────────────────────

const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));

export async function pullQbo(db: DB, ctx: { orgId: string; userId: string }, project: ProjectRow, clientName: string): Promise<{ results: StageResult[]; warnings: string[] }> {
  if (!project.cutover_date) throw new MigrationError('Set the cutover date first — the trial balance is pulled as of that day.', 409, 'NO_CUTOVER');
  const source = (await loadSources(db, project.id)).find((s) => s.system_id === 'quickbooks' && s.status !== 'archived');
  if (!source) throw new MigrationError('Add QuickBooks Online as a source first.', 404, 'NO_SOURCE');
  const r = await resolveMigrationProvider('quickbooks', { orgId: ctx.orgId, asOfDate: project.cutover_date });
  if (!r.qbo || r.selection.kind !== 'live') {
    const reason = 'reason' in r.selection ? r.selection.reason : null;
    throw new MigrationError(reason ?? 'QuickBooks isn’t connected. Connect it, or follow the export steps and drop the files.', 409, 'QBO_NOT_CONNECTED');
  }
  const qbo = r.qbo;
  const warnings: string[] = [];
  const profile = await qbo.companyProfile().catch(() => null);
  const companyName = profile?.legalName ?? profile?.companyName ?? null;
  if (companyName && normalizePartyName(companyName) !== normalizePartyName(clientName)) {
    warnings.push(`The connected QuickBooks company is “${companyName}”. Make sure that is ${clientName}’s file — QuickBooks connects one company at a time.`);
  }
  const [accounts, tb, customers, vendors, inv, bills] = await Promise.all([
    qbo.accountSnapshots(),
    qbo.trialBalanceLines(),
    qbo.fetchRaw('customers'),
    qbo.fetchRaw('vendors'),
    qbo.fetchRaw('open_ar'),
    qbo.fetchRaw('open_ap'),
  ]);
  const acctById = new Map(accounts.map((a) => [a.id, a]));
  const batches: Array<{ entity: StagedEntity; label: string; records: StagedPayload[]; totals: Record<string, number> }> = [];
  batches.push({
    entity: 'account',
    label: `Chart of accounts · ${plural(accounts.length, 'account')}`,
    records: accounts.map((a) => ({ entity: 'account' as const, data: { number: a.code, name: a.name, type: inferAccountType({ number: a.code, name: a.name, sourceType: a.accountType, detailType: a.accountSubType }), sourceType: a.accountType, detailType: a.accountSubType, active: a.active, balanceCents: 0 } })),
    totals: { count: accounts.length },
  });
  let dr = 0;
  let cr = 0;
  batches.push({
    entity: 'tb_line',
    label: `Trial balance as of ${longDate(project.cutover_date)} · ${plural(tb.length, 'account')}`,
    records: tb.map((l) => {
      dr += l.debitCents;
      cr += l.creditCents;
      const a = l.accountId ? acctById.get(l.accountId) : undefined;
      return { entity: 'tb_line' as const, data: { number: l.code, name: l.name, debitCents: l.debitCents, creditCents: l.creditCents, sourceType: a?.accountType ?? null, detailType: a?.accountSubType ?? null, active: a?.active ?? true, type: inferAccountType({ number: l.code, name: l.name, sourceType: a?.accountType ?? null, detailType: a?.accountSubType ?? null }) } };
    }),
    totals: { debitCents: dr, creditCents: cr },
  });
  const party = (p: Record<string, unknown>) => ({ name: str(p.DisplayName), email: str(p.PrimaryEmailAddr) || null, phone: str(p.PrimaryPhone) || null });
  batches.push({ entity: 'customer', label: `Customers · ${customers.length}`, records: customers.filter((c) => str(c.DisplayName)).map((c) => ({ entity: 'customer' as const, data: party(c) })), totals: { count: customers.length } });
  batches.push({ entity: 'vendor', label: `Vendors · ${vendors.length}`, records: vendors.filter((v) => str(v.DisplayName)).map((v) => ({ entity: 'vendor' as const, data: party(v) })), totals: { count: vendors.length } });
  const open = (o: Record<string, unknown>, partyKey: string) => ({ docNumber: str(o.DocNumber), party: str(o[partyKey]), date: str(o.TxnDate) || null, dueDate: str(o.DueDate) || null, totalCents: dollarsStrToCents(o.TotalAmt), balanceCents: dollarsStrToCents(o.Balance) });
  const invRecs = inv.map((o) => ({ entity: 'open_invoice' as const, data: open(o, 'CustomerName') }));
  const billRecs = bills.map((o) => ({ entity: 'open_bill' as const, data: open(o, 'VendorName') }));
  batches.push({ entity: 'open_invoice', label: `Open invoices · ${invRecs.length}`, records: invRecs, totals: { count: invRecs.length, openBalanceCents: invRecs.reduce((t, x) => t + x.data.balanceCents, 0) } });
  batches.push({ entity: 'open_bill', label: `Open bills · ${billRecs.length}`, records: billRecs, totals: { count: billRecs.length, openBalanceCents: billRecs.reduce((t, x) => t + x.data.balanceCents, 0) } });
  warnings.push('Open invoices and bills are QuickBooks’ open items as of today; the aging as of the cutover is checked against the A/R and A/P accounts in the data-quality step.');

  const results: StageResult[] = [];
  for (const b of batches) {
    const runId = await writeRun({ orgId: ctx.orgId, userId: ctx.userId, project, source, runKind: 'pull', entity: b.entity, parser: 'quickbooks.api v1', label: b.label, fileName: null, sha: null, asOf: b.entity === 'tb_line' ? project.cutover_date : null, records: b.records, controlTotals: b.totals, warnings: [], dropped: 0 });
    results.push({ runId, entity: b.entity, label: b.label, count: b.records.length, warnings: [], dropped: 0, duplicate: false });
  }
  await serviceWriter().from('migration_sources').update({ status: 'pulled' }).eq('org_id', ctx.orgId).eq('id', source.id);
  await logEvent(ctx.orgId, project, 'pull_staged', `QuickBooks pulled read-only: ${results.map((x) => x.label).join(' · ')}`, { actor: ctx.userId });
  return { results, warnings };
}

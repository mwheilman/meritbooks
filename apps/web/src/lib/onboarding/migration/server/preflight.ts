/**
 * "Check data quality" — build the 24 checks' input from what is staged, run them
 * (pure, AI-free: ../preflight/checks.ts), store one row per check and record each
 * person's decision. A decision survives a re-run only while the finding is unchanged
 * (same severity, same dollars); otherwise it reopens.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { serviceWriter } from '@/lib/db/scoped-writer';
import { runPreflight, rankFindings, summarizePreflight, PREFLIGHT_CHECKS } from '../preflight/checks';
import { mergeSourceAccounts } from '../source-accounts';
import type {
  PfIntercompany,
  PreflightCheckId,
  PreflightDisposition,
  PreflightInput,
  PreflightResult,
  StagedAccount,
  StagedBankBalance,
  StagedEvidence,
  StagedJob,
  StagedOpenItem,
  StagedParty,
  StagedTbLine,
} from '../types';
import { dollars } from '../format';
import { MigrationError } from './guard';
import { loadRuns, loadSources, loadStaged, logEvent, type ProjectRow, type StagedRow } from './store';

type DB = SupabaseClient;

const payloads = <T>(rows: StagedRow[], entity: StagedRow['entity'], keep?: (r: StagedRow) => boolean): T[] =>
  rows.filter((r) => r.entity === entity && (!keep || keep(r))).map((r) => r.payload as unknown as T);

/** Intercompany: due-from / due-to accounts naming another client, mirrored against that client's staged TB. */
async function intercompanyPairs(db: DB, orgId: string, project: ProjectRow, accounts: ReturnType<typeof mergeSourceAccounts>): Promise<PfIntercompany[]> {
  const ic = accounts.filter((a) => a.balanceCents !== 0 && /(due\s+(from|to)|intercompany|inter-company|loan\s+(from|to))\s+/i.test(a.name));
  if (ic.length === 0) return [];
  const { data: clients } = await db.schema('core').from('locations').select('id, name').eq('org_id', orgId).neq('id', project.location_id).limit(2000);
  const { data: me } = await db.schema('core').from('locations').select('name').eq('id', project.location_id).maybeSingle();
  const myName = ((me as { name: string } | null)?.name ?? '').toLowerCase();
  const myToken = myName.split(/\s+/)[0] ?? '';
  const out: PfIntercompany[] = [];
  for (const a of ic) {
    const lower = a.name.toLowerCase();
    const other = ((clients ?? []) as Array<{ id: string; name: string }>).find((c) => {
      const first = c.name.toLowerCase().split(/\s+/)[0] ?? '';
      return first.length >= 3 && lower.includes(first);
    });
    if (!other) continue;
    let otherSide: number | null = null;
    // The counterparty's staged TB (visible only when the caller can see that client).
    const { data: op } = await db.from('migration_projects').select('id').eq('org_id', orgId).eq('location_id', other.id).is('archived_at', null).maybeSingle();
    if (op && myToken.length >= 3) {
      const theirs = await loadStaged(db, (op as { id: string }).id, ['tb_line']);
      const mirror = theirs.find((r) => r.display_name.toLowerCase().includes(myToken) && /(due|intercompany|inter-company|loan)/i.test(r.display_name));
      if (mirror) otherSide = Number(mirror.amount_cents);
    }
    out.push({ accountNumber: a.number ?? a.key, accountName: a.name, thisSideCents: a.balanceCents, counterpartyName: other.name, otherSideCents: otherSide });
  }
  return out;
}

export async function buildPreflightInput(db: DB, orgId: string, project: ProjectRow): Promise<PreflightInput> {
  const [rows, runs, sources] = await Promise.all([
    loadStaged(db, project.id, ['account', 'tb_line', 'customer', 'vendor', 'open_invoice', 'open_bill', 'bank_balance', 'job', 'evidence']),
    loadRuns(db, project.id, { activeOnly: true }),
    loadSources(db, project.id),
  ]);
  const roleByRun = new Map(runs.map((r) => [r.id, sources.find((s) => s.id === r.source_id)?.role ?? null]));
  const fromField = (r: StagedRow) => roleByRun.get(r.run_id) === 'field_system';
  const accounts = mergeSourceAccounts(payloads<StagedAccount>(rows, 'account'), payloads<StagedTbLine>(rows, 'tb_line'));
  const tbAvailable = rows.some((r) => r.entity === 'tb_line');
  const has = (e: StagedRow['entity'], keep?: (r: StagedRow) => boolean) => rows.some((r) => r.entity === e && (!keep || keep(r)));
  const item = (o: StagedOpenItem) => ({ docNumber: o.docNumber, party: o.party, balanceCents: o.balanceCents, date: o.date });
  const party = (p: StagedParty) => ({ name: p.name, email: p.email ?? null, phone: p.phone ?? null, taxIdHash: p.taxIdHash ?? null, hasTaxId: !!(p.taxIdHash || p.taxIdLast4), is1099: !!p.is1099, ytdPaidCents: p.ytdPaidCents ?? 0 });
  const evidence = payloads<StagedEvidence>(rows, 'evidence').map((e) => ({ kind: e.kind, label: e.label, amountCents: e.amountCents, asOf: e.asOf, glAccountNumber: e.glAccountNumber ?? null, note: e.note ?? null }));
  const closed = evidence.find((e) => e.kind === 'books_closed');
  return {
    asOf: project.cutover_date,
    accounts: accounts.map((a) => ({ number: a.number ?? a.key, name: a.name, type: a.type, sourceType: a.sourceType, detailType: a.detailType, active: a.active, balanceCents: a.balanceCents })),
    tbAvailable,
    openInvoices: has('open_invoice', (r) => !fromField(r)) ? payloads<StagedOpenItem>(rows, 'open_invoice', (r) => !fromField(r)).map(item) : null,
    openBills: has('open_bill') ? payloads<StagedOpenItem>(rows, 'open_bill').map(item) : null,
    customers: has('customer') ? payloads<StagedParty>(rows, 'customer').map(party) : null,
    vendors: has('vendor') ? payloads<StagedParty>(rows, 'vendor').map(party) : null,
    bank: has('bank_balance')
      ? payloads<StagedBankBalance>(rows, 'bank_balance').map((b) => ({ label: b.label, glAccountNumber: b.glAccountNumber, statementBalanceCents: b.statementBalanceCents, lastReconciledDate: b.lastReconciledDate ?? b.statementDate, unclearedTotalCents: b.unclearedTotalCents ?? 0, oldestUnclearedDate: b.oldestUnclearedDate ?? null }))
      : null,
    jobs: has('job') ? payloads<StagedJob>(rows, 'job').map((j) => ({ number: j.number, name: j.name, costCents: j.costCents ?? 0, unbilledCents: j.unbilledCents ?? 0, billingsInExcessCents: j.billingsInExcessCents ?? 0 })) : null,
    evidence,
    fieldOpenInvoices: has('open_invoice', fromField) ? payloads<StagedOpenItem>(rows, 'open_invoice', fromField).map(item) : null,
    intercompany: tbAvailable ? await intercompanyPairs(db, orgId, project, accounts) : [],
    priorYear: null,
    booksClosedThrough: closed?.asOf ?? null,
    sourceChangedSincePull: false,
  };
}

export interface FindingRow {
  id: string;
  check_id: PreflightCheckId;
  severity: PreflightResult['severity'];
  name: string;
  title: string;
  message: string;
  fix: string | null;
  amount_cents: number;
  accounts: string[];
  records: { sample?: string[]; count?: number };
  disposition: PreflightDisposition;
  disposition_note: string | null;
  disposed_by: string | null;
  disposed_at: string | null;
  run_at: string;
}

const FIND_COLS = 'id, check_id, severity, name, title, message, fix, amount_cents, accounts, records, disposition, disposition_note, disposed_by, disposed_at, run_at';

export async function loadFindings(db: DB, projectId: string): Promise<FindingRow[]> {
  const { data, error } = await db.from('preflight_findings').select(FIND_COLS).eq('project_id', projectId).order('check_id');
  if (error) throw new Error(`Could not load the checks: ${error.message}`);
  return ((data ?? []) as unknown as FindingRow[]).map((f) => ({ ...f, amount_cents: Number(f.amount_cents ?? 0) }));
}

export async function runAndStore(db: DB, orgId: string, project: ProjectRow, actorUserId: string): Promise<FindingRow[]> {
  const input = await buildPreflightInput(db, orgId, project);
  const results = runPreflight(input);
  const prev = new Map((await loadFindings(db, project.id)).map((f) => [f.check_id, f]));
  const now = new Date().toISOString();
  const rows = results.map((r) => {
    const p = prev.get(r.checkId);
    const keep = p && p.disposition !== 'open' && p.severity === r.severity && p.amount_cents === r.amountCents && (r.severity !== 'blocker' || p.disposition !== 'accepted_with_note');
    return {
      org_id: orgId,
      location_id: project.location_id,
      project_id: project.id,
      check_id: r.checkId,
      severity: r.severity,
      name: r.name.slice(0, 200),
      title: r.title.slice(0, 400),
      message: r.message.slice(0, 4000),
      fix: r.fix.slice(0, 2000),
      amount_cents: Math.abs(Math.trunc(r.amountCents)),
      accounts: r.accounts.slice(0, 50),
      records: r.records,
      disposition: keep ? p!.disposition : 'open',
      disposition_note: keep ? p!.disposition_note : null,
      disposed_by: keep ? p!.disposed_by : null,
      disposed_at: keep ? p!.disposed_at : null,
      run_at: now,
    };
  });
  const { error } = await serviceWriter().from('preflight_findings').upsert(rows, { onConflict: 'project_id,check_id' });
  if (error) throw new Error(`Could not save the checks: ${error.message}`);
  const s = summarizePreflight(results, new Set());
  await logEvent(orgId, project, 'preflight_run', `24 checks ran · ${s.blockers} blocker${s.blockers === 1 ? '' : 's'} (${dollars(s.blockerCents)}) · ${s.warnings} warning${s.warnings === 1 ? '' : 's'} · ${s.passed} passed`, { actor: actorUserId, system: true });
  return loadFindings(db, project.id);
}

export async function decideFinding(
  db: DB,
  orgId: string,
  project: ProjectRow,
  actorUserId: string,
  input: { checkId: PreflightCheckId; disposition: PreflightDisposition; note: string | null },
): Promise<FindingRow> {
  const f = (await loadFindings(db, project.id)).find((x) => x.check_id === input.checkId);
  if (!f) throw new MigrationError('Run the checks first.', 404, 'NOT_RUN');
  if (f.severity === 'passed' || f.severity === 'not_applicable') throw new MigrationError('Nothing to decide on a check that passed.', 422, 'NOTHING');
  const note = (input.note ?? '').trim();
  if (f.severity === 'blocker' && input.disposition === 'accepted_with_note') {
    throw new MigrationError('A blocker can’t simply be accepted. Fix it in the old system, or carry the difference as one reconciling item.', 422, 'BLOCKER');
  }
  if ((input.disposition === 'accepted_with_note' || input.disposition === 'carry_as_reconciling_item') && note.length < 10) {
    throw new MigrationError('Say what you decided in a sentence — it prints on the certificate.', 422, 'NOTE');
  }
  const open = input.disposition === 'open';
  const { data, error } = await serviceWriter()
    .from('preflight_findings')
    .update({ disposition: input.disposition, disposition_note: open ? null : note || null, disposed_by: open ? null : actorUserId, disposed_at: open ? null : new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('org_id', orgId)
    .eq('id', f.id)
    .select(FIND_COLS)
    .single();
  if (error) throw new Error(`Could not save the decision: ${error.message}`);
  const words: Record<PreflightDisposition, string> = {
    open: 'reopened',
    fixed_in_source: 'will be fixed in the old system',
    carry_as_reconciling_item: 'carried as one reconciling item',
    accepted_with_note: 'accepted',
    not_applicable: 'marked not applicable',
  };
  await logEvent(orgId, project, 'finding_decided', `${f.name}: ${words[input.disposition]}${note ? ` — ${note}` : ''}`, { actor: actorUserId, detail: { checkId: f.check_id, disposition: input.disposition } });
  return data as unknown as FindingRow;
}

/** The "What we found in your books" client report: items to fix in the source + what we handle. */
export function clientReport(findings: ReadonlyArray<FindingRow>): { fixInSource: FindingRow[]; handled: FindingRow[]; passed: number } {
  const ranked = rankFindings(findings.map((f) => ({ checkId: f.check_id, severity: f.severity, name: f.name, title: f.title, message: f.message, fix: f.fix ?? '', amountCents: f.amount_cents, accounts: f.accounts, records: { sample: f.records.sample ?? [], count: f.records.count ?? 0 } })));
  const byId = new Map(findings.map((f) => [f.check_id, f]));
  const ordered = ranked.map((r) => byId.get(r.checkId)!).filter(Boolean);
  return {
    fixInSource: ordered.filter((f) => f.disposition === 'fixed_in_source' || (f.severity === 'blocker' && f.disposition === 'open')),
    handled: ordered.filter((f) => f.disposition === 'carry_as_reconciling_item' || f.disposition === 'accepted_with_note'),
    passed: findings.filter((f) => f.severity === 'passed').length,
  };
}

export { PREFLIGHT_CHECKS };

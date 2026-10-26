/**
 * The Conversion Certificate, server side: gather the five ties from the staged source and
 * the LIVE book of record AT THE CUTOVER DATE, sign the balance proof (preparer), sign off
 * (a different reviewer), void, and go live.
 *
 *   MeritBooks side   posted GL lines dated on or before the cutover for this client
 *                     (gl_entries.status POSTED), open invoices / bills dated on or before
 *                     the cutover (v_ar_aging / v_ap_aging).
 *   Source side       the opening trial balance staged on the conversion session (mapped),
 *                     the staged aging reports, the staged bank statements / reconciliations.
 *
 * Every control account is resolved BY ROLE (resolveRole) — never a hard-coded number.
 */

import crypto from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { serviceWriter } from '@/lib/db/scoped-writer';
import { getOrgToday } from '@/lib/dates/org-today';
import { setPeriodStatus, type PeriodStatus } from '@/lib/services/fiscal-periods';
import { fetchAll } from '@/lib/supabase/fetch-all';
import { PostingError, resolveRole, type AccountRoleKey } from '@/lib/posting/account-roles';
import { loadSession } from '@/lib/onboarding/session';
import type { ConversionSessionData } from '@/lib/onboarding/conversion';
import {
  canonicalJson,
  computeTies,
  nextCertificateNumber,
  proofGate,
  signOffGate,
  type BankTieInput,
  type TieInputs,
} from '../certificate';
import { mergeSourceAccounts } from '../source-accounts';
import type { CertificateGate, CertificateTie, MeritAccountType, StagedAccount, StagedBankBalance, StagedOpenItem, StagedTbLine } from '../types';
import { dollars, longDate } from '../format';
import { stageLabel } from '../stages';
import { getSourceSystem } from '../catalog';
import { MigrationError } from './guard';
import { loadRuns, loadSources, loadStaged, logEvent, patchProject, type ProjectRow } from './store';

type DB = SupabaseClient;

interface TargetAcct {
  id: string;
  number: string;
  name: string;
  type: MeritAccountType | null;
}

async function loadTargets(db: DB, orgId: string): Promise<TargetAcct[]> {
  const { data, error } = await db.from('accounts').select('id, account_number, name, account_type').eq('org_id', orgId).limit(5000);
  if (error) throw new Error(`Could not load the chart of accounts: ${error.message}`);
  return ((data ?? []) as Array<{ id: string; account_number: string; name: string; account_type: string | null }>).map((a) => ({
    id: a.id,
    number: String(a.account_number),
    name: a.name,
    type: (a.account_type as MeritAccountType | null) ?? null,
  }));
}

/** Debit-positive GL net per account id, posted entries dated on or before `asOf`, one client. */
export async function glNetAtDate(db: DB, orgId: string, locationId: string, asOf: string): Promise<Map<string, number>> {
  const { data: entries, error } = await fetchAll(
    () => db.from('gl_entries').select('id').eq('org_id', orgId).eq('location_id', locationId).eq('status', 'POSTED').lte('entry_date', asOf),
    { label: 'migration certificate gl_entries' },
  );
  if (error) throw new Error(`Could not read the ledger: ${error.message}`);
  const ids = ((entries ?? []) as Array<{ id: string }>).map((e) => e.id);
  const net = new Map<string, number>();
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const { data: lines, error: le } = await fetchAll(
      () => db.from('gl_entry_lines').select('id, account_id, debit_cents, credit_cents').eq('org_id', orgId).in('gl_entry_id', chunk),
      { label: 'migration certificate gl_entry_lines' },
    );
    if (le) throw new Error(`Could not read the ledger lines: ${le.message}`);
    for (const l of (lines ?? []) as Array<{ account_id: string; debit_cents: number; credit_cents: number }>) {
      net.set(l.account_id, (net.get(l.account_id) ?? 0) + Number(l.debit_cents ?? 0) - Number(l.credit_cents ?? 0));
    }
  }
  return net;
}

async function roleNumber(db: DB, orgId: string, role: AccountRoleKey, locationId: string): Promise<string | null> {
  try {
    return (await resolveRole(db, orgId, role, locationId)).account_number;
  } catch (e) {
    if (e instanceof PostingError) return null;
    throw e;
  }
}

async function agingTotal(db: DB, view: 'v_ar_aging' | 'v_ap_aging', locationId: string, asOf: string): Promise<number> {
  const dateCol = view === 'v_ar_aging' ? 'invoice_date' : 'bill_date';
  const { data, error } = await fetchAll(
    () => db.from(view).select(`${view === 'v_ar_aging' ? 'invoice_id' : 'bill_id'}, balance_cents`).eq('location_id', locationId).lte(dateCol, asOf).gt('balance_cents', 0),
    { orderBy: view === 'v_ar_aging' ? 'invoice_id' : 'bill_id', label: `migration certificate ${view}` },
  );
  if (error) throw new Error(`Could not read open items: ${error.message}`);
  return ((data ?? []) as Array<{ balance_cents: number }>).reduce((t, r) => t + Number(r.balance_cents ?? 0), 0);
}

const EQUITY_OR_PL: ReadonlySet<string> = new Set(['EQUITY', 'REVENUE', 'COGS', 'OPEX', 'OTHER']);

export interface ProjectTies {
  asOf: string | null;
  ties: CertificateTie[];
  session: { id: string; data: ConversionSessionData; postedGlEntryId: string | null } | null;
  carried: { ar: number; ap: number };
}

/** The five ties for a project, from real data. */
export async function computeProjectTies(db: DB, orgId: string, project: ProjectRow): Promise<ProjectTies> {
  const session = project.conversion_session_id ? await loadSession(db, orgId, project.conversion_session_id) : null;
  const asOf = project.cutover_date ?? session?.data.asOfDate ?? null;
  const posted = !!session?.postedGlEntryId;

  const [targets, staged, findings, sources, runs] = await Promise.all([
    loadTargets(db, orgId),
    loadStaged(db, project.id, ['account', 'tb_line', 'open_invoice', 'open_bill', 'bank_balance']),
    db.from('preflight_findings').select('check_id, disposition, amount_cents').eq('project_id', project.id),
    loadSources(db, project.id),
    loadRuns(db, project.id, { activeOnly: true }),
  ]);
  const byId = new Map(targets.map((t) => [t.id, t]));
  const byNumber = new Map(targets.map((t) => [t.number, t]));
  const gl = asOf && posted ? await glNetAtDate(db, orgId, project.location_id, asOf) : new Map<string, number>();
  const glByNumber = new Map<string, number>();
  for (const [id, n] of gl) {
    const t = byId.get(id);
    if (t) glByNumber.set(t.number, (glByNumber.get(t.number) ?? 0) + n);
  }

  const opening = new Map<string, number>();
  for (const ob of session?.data.openingBalances ?? []) opening.set(ob.targetAccountNumber, (ob.debitCents || 0) - (ob.creditCents || 0));

  // ── TB
  const tbLines: Array<{ label: string; sourceCents: number; meritCents: number }> = [];
  for (const num of new Set([...opening.keys(), ...glByNumber.keys()])) {
    const t = byNumber.get(num);
    tbLines.push({ label: `${num}${t ? ` ${t.name}` : ''}`, sourceCents: opening.get(num) ?? 0, meritCents: glByNumber.get(num) ?? 0 });
  }
  tbLines.sort((a, b) => a.label.localeCompare(b.label, 'en', { numeric: true }));

  // ── A/R and A/P (by role)
  const f = (findings.data ?? []) as Array<{ check_id: string; disposition: string; amount_cents: number }>;
  const carried = (id: string) => { const x = f.find((r) => r.check_id === id && r.disposition === 'carry_as_reconciling_item'); return x ? Number(x.amount_cents) : 0; };
  const sourceRoleOfRun = new Map(runs.map((r) => [r.id, sources.find((s) => s.id === r.source_id)?.role ?? null]));
  const ledgerItems = (entity: 'open_invoice' | 'open_bill') =>
    staged.filter((r) => r.entity === entity && sourceRoleOfRun.get(r.run_id) !== 'field_system').map((r) => r.payload as unknown as StagedOpenItem);
  const sum = (xs: StagedOpenItem[]) => xs.reduce((t, x) => t + (x.balanceCents || 0), 0);
  const arItems = ledgerItems('open_invoice');
  const apItems = ledgerItems('open_bill');
  const [arNum, apNum] = await Promise.all([roleNumber(db, orgId, 'AR_CONTROL', project.location_id), roleNumber(db, orgId, 'AP_CONTROL', project.location_id)]);
  const [arMerit, apMerit] = asOf && posted
    ? await Promise.all([agingTotal(db, 'v_ar_aging', project.location_id, asOf), agingTotal(db, 'v_ap_aging', project.location_id, asOf)])
    : [0, 0];
  const carriedAr = carried('PF-01');
  const carriedAp = carried('PF-02');

  // ── Bank: each staged statement / reconciliation, through the client's own mapping.
  const { data: maps } = await db.from('client_mappings').select('source_account_key, source_number, target_account_id').eq('project_id', project.id);
  const mapByNumber = new Map(((maps ?? []) as Array<{ source_account_key: string; source_number: string | null; target_account_id: string | null }>).map((m) => [m.source_number ?? m.source_account_key, m.target_account_id]));
  const srcAccts = mergeSourceAccounts(
    staged.filter((r) => r.entity === 'account').map((r) => r.payload as unknown as StagedAccount),
    staged.filter((r) => r.entity === 'tb_line').map((r) => r.payload as unknown as StagedTbLine),
  );
  const bank: BankTieInput[] = [];
  const bankRows = staged.filter((r) => r.entity === 'bank_balance').map((r) => r.payload as unknown as StagedBankBalance);
  const findSrc = (b: StagedBankBalance) =>
    (b.glAccountNumber ? srcAccts.find((a) => a.number === b.glAccountNumber || a.key === b.glAccountNumber) : undefined) ??
    srcAccts.find((a) => a.name.toLowerCase().includes(b.label.toLowerCase()) || b.label.toLowerCase().includes(a.name.toLowerCase()));
  for (const b of bankRows) {
    const src = findSrc(b);
    const targetId = src ? mapByNumber.get(src.number ?? src.key) ?? null : null;
    const target = targetId ? byId.get(targetId) : undefined;
    bank.push({
      label: b.label,
      evidenceCents: b.statementBalanceCents + (b.unclearedTotalCents ?? 0),
      sourceGlCents: src?.balanceCents ?? 0,
      meritGlCents: target ? glByNumber.get(target.number) ?? 0 : 0,
    });
  }
  if (bankRows.length === 0) {
    for (const a of srcAccts.filter((x) => /^bank$/i.test(x.sourceType ?? '') || /^(checking|savings|bank)$/i.test(x.detailType ?? ''))) {
      const targetId = mapByNumber.get(a.number ?? a.key) ?? null;
      const target = targetId ? byId.get(targetId) : undefined;
      bank.push({ label: `${a.number ? `${a.number} ` : ''}${a.name}`, evidenceCents: null, sourceGlCents: a.balanceCents, meritGlCents: target ? glByNumber.get(target.number) ?? 0 : 0 });
    }
  }

  // ── Equity (credit-positive, incl. open P&L on a mid-year cutover)
  let srcEquity = 0;
  for (const [num, n] of opening) if (EQUITY_OR_PL.has(byNumber.get(num)?.type ?? '')) srcEquity -= n;
  let meritEquity = 0;
  for (const [num, n] of glByNumber) if (EQUITY_OR_PL.has(byNumber.get(num)?.type ?? '')) meritEquity -= n;

  const data = session?.data;
  const inputs: TieInputs = {
    asOf: asOf ?? '',
    tb: {
      posted,
      lines: tbLines,
      sourceDebitCents: data?.balance.totalDebitCents ?? 0,
      sourceCreditCents: data?.balance.totalCreditCents ?? 0,
      identityDiffCents: data?.balanceSheet?.identityDiffCents ?? 0,
      plNetCents: data?.balanceSheet?.plNetCents ?? 0,
      plAcknowledged: !!data?.plAcknowledged,
    },
    ar: {
      sourceAgingCents: arItems.length > 0 ? sum(arItems) : data?.subledgerDetail?.arOpenByCustomerCents ?? null,
      sourceControlCents: Math.abs(arNum ? opening.get(arNum) ?? 0 : 0),
      meritSubledgerCents: arMerit,
      meritControlCents: Math.abs(arNum ? glByNumber.get(arNum) ?? 0 : 0),
      carriedCents: carriedAr,
      evidenced: arItems.length > 0,
    },
    ap: {
      sourceAgingCents: apItems.length > 0 ? sum(apItems) : data?.subledgerDetail?.apOpenByVendorCents ?? null,
      sourceControlCents: Math.abs(apNum ? opening.get(apNum) ?? 0 : 0),
      meritSubledgerCents: apMerit,
      meritControlCents: Math.abs(apNum ? glByNumber.get(apNum) ?? 0 : 0),
      carriedCents: carriedAp,
      evidenced: apItems.length > 0,
    },
    bank,
    equity: { sourceCents: srcEquity, meritCents: posted ? meritEquity : 0, rollForward: null },
  };
  return { asOf, ties: computeTies(inputs), session, carried: { ar: carriedAr, ap: carriedAp } };
}

// ── Gate, DTO ────────────────────────────────────────────────────────────────

export interface CertificateDto {
  id: string;
  number: string;
  status: 'prepared' | 'issued' | 'voided';
  version: number;
  cutoverDate: string;
  historyDepth: string;
  preparedBy: string;
  preparedAt: string;
  approvedBy: string | null;
  approvedAt: string | null;
  voidReason: string | null;
  contentHash: string;
  ties: CertificateTie[];
  sources: unknown[];
  mappingSummary: Record<string, unknown>;
  preflightDispositions: unknown[];
}

export interface CertificateView {
  asOf: string | null;
  ties: CertificateTie[];
  proof: CertificateGate;
  signOff: CertificateGate | null;
  certificate: CertificateDto | null;
  session: { id: string; posted: boolean } | null;
}

const CERT_COLS = 'id, certificate_number, status, version, cutover_date, history_depth, prepared_by, prepared_at, approved_by, approved_at, void_reason, content_hash, ties, sources, mapping_summary, preflight_dispositions, snapshot_id';

function toDto(r: Record<string, unknown>): CertificateDto {
  return {
    id: String(r.id),
    number: String(r.certificate_number),
    status: r.status as CertificateDto['status'],
    version: Number(r.version ?? 1),
    cutoverDate: String(r.cutover_date),
    historyDepth: String(r.history_depth),
    preparedBy: String(r.prepared_by),
    preparedAt: String(r.prepared_at),
    approvedBy: (r.approved_by as string | null) ?? null,
    approvedAt: (r.approved_at as string | null) ?? null,
    voidReason: (r.void_reason as string | null) ?? null,
    contentHash: String(r.content_hash),
    ties: (r.ties as CertificateTie[]) ?? [],
    sources: (r.sources as unknown[]) ?? [],
    mappingSummary: (r.mapping_summary as Record<string, unknown>) ?? {},
    preflightDispositions: (r.preflight_dispositions as unknown[]) ?? [],
  };
}

export async function loadCertificate(db: DB, project: ProjectRow): Promise<CertificateDto | null> {
  if (!project.certificate_id) return null;
  const { data } = await db.from('conversion_certificates').select(CERT_COLS).eq('id', project.certificate_id).maybeSingle();
  return data ? toDto(data as Record<string, unknown>) : null;
}

async function gateCounts(db: DB, projectId: string) {
  const [{ data: f }, { data: m }] = await Promise.all([
    db.from('preflight_findings').select('severity, disposition, amount_cents').eq('project_id', projectId),
    db.from('client_mappings').select('status, balance_cents, type_guard, type_reason').eq('project_id', projectId),
  ]);
  const findings = (f ?? []) as Array<{ severity: string; disposition: string; amount_cents: number }>;
  const maps = (m ?? []) as Array<{ status: string; balance_cents: number; type_guard: string; type_reason: string | null }>;
  const openBlockers = findings.filter((x) => x.severity === 'blocker' && x.disposition !== 'carry_as_reconciling_item');
  const unmatched = maps.filter((x) => Number(x.balance_cents) !== 0 && x.status !== 'accepted');
  return {
    ran: findings.length > 0,
    openBlockers: openBlockers.length,
    openBlockerCents: openBlockers.reduce((t, x) => t + Number(x.amount_cents ?? 0), 0),
    undecidedWarnings: findings.filter((x) => x.severity === 'warning' && x.disposition === 'open').length,
    unmatchedBalanceAccounts: unmatched.length,
    unmatchedBalanceCents: unmatched.reduce((t, x) => t + Math.abs(Number(x.balance_cents)), 0),
    typeGuardWithoutReason: maps.filter((x) => x.status === 'accepted' && x.type_guard === 'block' && !(x.type_reason ?? '').trim()).length,
    mappingCount: maps.length,
  };
}

const hashOf = (v: unknown) => crypto.createHash('sha256').update(canonicalJson(v), 'utf8').digest('hex');

export async function certificateView(db: DB, orgId: string, project: ProjectRow, actorUserId: string): Promise<CertificateView> {
  const t = await computeProjectTies(db, orgId, project);
  const counts = await gateCounts(db, project.id);
  const proof = proofGate({
    ties: t.ties,
    openBlockers: counts.ran ? counts.openBlockers : 1,
    openBlockerCents: counts.openBlockerCents,
    undecidedWarnings: counts.undecidedWarnings,
    unmatchedBalanceAccounts: counts.mappingCount === 0 ? 1 : counts.unmatchedBalanceAccounts,
    unmatchedBalanceCents: counts.unmatchedBalanceCents,
    typeGuardWithoutReason: counts.typeGuardWithoutReason,
    preparerUserId: project.preparer_user_id,
    reviewerUserId: project.reviewer_user_id,
    actorUserId,
  });
  if (!counts.ran) proof.blockers.unshift('Run the data-quality checks first.');
  if (counts.mappingCount === 0) proof.blockers.unshift('Match the accounts first.');
  proof.ready = proof.blockers.length === 0;
  const cert = await loadCertificate(db, project);
  let signOff: CertificateGate | null = null;
  if (cert && cert.status === 'prepared') {
    signOff = signOffGate({ status: cert.status, preparedBy: cert.preparedBy, actorUserId, reviewerUserId: project.reviewer_user_id, tiesStillTie: hashOf(t.ties) === hashOf(cert.ties) });
  }
  return { asOf: t.asOf, ties: t.ties, proof, signOff, certificate: cert, session: t.session ? { id: t.session.id, posted: !!t.session.postedGlEntryId } : null };
}

// ── Sign the balance proof (preparer) ────────────────────────────────────────

async function certificatePayload(db: DB, orgId: string, project: ProjectRow) {
  const sources = await loadSources(db, project.id);
  const runs = await loadRuns(db, project.id, { activeOnly: true });
  const srcPayload = sources.filter((s) => s.status !== 'archived').map((s) => ({
    systemId: s.system_id,
    name: getSourceSystem(s.system_id)?.name ?? s.system_id,
    role: s.role,
    files: runs.filter((r) => r.source_id === s.id).map((r) => ({ runId: r.id, kind: r.run_kind, file: r.file_name, sha256: r.file_sha256, parser: r.parser, entity: r.entity, counts: r.record_counts, at: r.created_at })),
  }));
  const { data: maps } = await db.from('client_mappings').select('source_account_key, source_name, proposal_source, band, status, type_guard, type_reason, decided_by').eq('project_id', project.id);
  const m = (maps ?? []) as Array<{ source_account_key: string; source_name: string; proposal_source: string; band: string; status: string; type_guard: string; type_reason: string | null; decided_by: string | null }>;
  const bySource: Record<string, number> = {};
  for (const x of m) bySource[x.proposal_source] = (bySource[x.proposal_source] ?? 0) + 1;
  const mappingSummary = {
    accounts: m.length,
    accepted: m.filter((x) => x.status === 'accepted').length,
    bySource,
    typeExceptions: m.filter((x) => x.type_guard === 'block' && x.status === 'accepted').map((x) => ({ account: `${x.source_account_key} ${x.source_name}`, reason: x.type_reason })),
  };
  const { data: f } = await db.from('preflight_findings').select('check_id, name, severity, amount_cents, disposition, disposition_note, disposed_by, disposed_at').eq('project_id', project.id).in('severity', ['blocker', 'warning', 'info']).order('check_id');
  return { sources: srcPayload, mappingSummary, preflightDispositions: f ?? [] };
}

export async function signProof(db: DB, orgId: string, project: ProjectRow, actorUserId: string): Promise<CertificateDto> {
  if (project.stage === 'live') throw new MigrationError('This client is already live.', 409, 'LIVE');
  const view = await certificateView(db, orgId, project, actorUserId);
  if (!view.proof.ready) throw new MigrationError(`Not ready to sign: ${view.proof.blockers[0]}`, 409, 'NOT_READY');
  if (!view.asOf) throw new MigrationError('Set the cutover date first.', 409, 'NO_CUTOVER');
  await assertCutoverNotFuture(db, orgId, view.asOf);
  if (view.certificate?.status === 'issued') throw new MigrationError('The certificate is already signed off.', 409, 'ISSUED');
  if (project.preparer_user_id && project.preparer_user_id !== actorUserId) {
    throw new MigrationError('Only this client’s preparer signs the balance proof.', 403, 'NOT_PREPARER');
  }
  const writer = serviceWriter();
  const hash = hashOf(view.ties);
  const { data: snap, error: se } = await writer
    .from('tieout_snapshots')
    .insert({ org_id: orgId, location_id: project.location_id, project_id: project.id, kind: 'cutover_tb', as_of: view.asOf, ties: view.ties, all_tied: true, blocker_count: 0, content_hash: hash, computed_by: actorUserId })
    .select('id')
    .single();
  if (se || !snap) throw new Error(`Could not save the proof: ${se?.message ?? 'unknown'}`);

  // A re-sign supersedes the earlier prepared certificate (kept, voided with the reason).
  let supersedes: string | null = null;
  if (view.certificate && view.certificate.status === 'prepared') {
    supersedes = view.certificate.id;
    await writer.from('migration_projects').update({ certificate_id: null, stage: 'tie_out' }).eq('org_id', orgId).eq('id', project.id);
    await writer.from('conversion_certificates').update({ status: 'voided', void_reason: 'Superseded — the balance proof was signed again.', voided_by: actorUserId, voided_at: new Date().toISOString() }).eq('org_id', orgId).eq('id', supersedes);
  }
  const payload = await certificatePayload(db, orgId, project);
  let inserted: Record<string, unknown> | null = null;
  for (let attempt = 0; attempt < 4 && !inserted; attempt++) {
    const { data: nums } = await writer.from('conversion_certificates').select('certificate_number').eq('org_id', orgId);
    const number = nextCertificateNumber(((nums ?? []) as Array<{ certificate_number: string }>).map((n) => n.certificate_number));
    const body = {
      org_id: orgId,
      location_id: project.location_id,
      project_id: project.id,
      certificate_number: number,
      version: supersedes ? (view.certificate?.version ?? 1) + 1 : 1,
      supersedes_id: supersedes,
      status: 'prepared',
      cutover_date: view.asOf,
      history_depth: project.history_depth,
      snapshot_id: (snap as { id: string }).id,
      sources: payload.sources,
      mapping_summary: payload.mappingSummary,
      preflight_dispositions: payload.preflightDispositions,
      ties: view.ties,
      content_hash: hashOf({ number, ties: view.ties, sources: payload.sources, asOf: view.asOf, project: project.id }),
      prepared_by: actorUserId,
    };
    const { data, error } = await writer.from('conversion_certificates').insert(body).select(CERT_COLS).single();
    if (error && /ux_conversion_certificates_number/.test(error.message)) continue;
    if (error) throw new Error(`Could not prepare the certificate: ${error.message}`);
    inserted = data as Record<string, unknown>;
  }
  if (!inserted) throw new Error('Could not number the certificate — try again.');
  const dto = toDto(inserted);
  await patchProject(orgId, project.id, { certificate_id: dto.id, stage: 'certified', stage_changed_at: new Date().toISOString() });
  await logEvent(orgId, project, 'proof_signed', `Balance proof signed · certificate ${dto.number} prepared`, { actor: actorUserId, detail: { certificate: dto.number, hash: dto.contentHash } });
  return dto;
}

// ── Sign off (reviewer) ──────────────────────────────────────────────────────

/** M4: the cutover may not be after the organization's today (sign-off hard-closes through it). */
async function assertCutoverNotFuture(db: DB, orgId: string, cutover: string): Promise<void> {
  const today = await getOrgToday(db, orgId);
  if (cutover > today) {
    throw new MigrationError(`The cutover (${longDate(cutover)}) is after today — sign-off locks every month through it. Move the cutover to the last month-end the old books are closed through.`, 409, 'CUTOVER_IN_FUTURE');
  }
}

export interface SignOffDeps {
  /** Close-management check for the actor (the route passes requirePermission(close_mgmt, manage)). */
  canManageClose: () => Promise<boolean>;
  /** The period transition (default: lib/services/fiscal-periods setPeriodStatus). */
  setStatus?: (db: DB, orgId: string, periodId: string, status: PeriodStatus, actor: string, reason: string | null) => Promise<void>;
}

/**
 * Security review M4: sign-off LOCKS the months up to the cutover, so it (1) needs close
 * management (close_mgmt:manage) on top of the reviewer's journal_entries:post, (2) refuses a
 * cutover after today, (3) locks through the normal period path (setPeriodStatus — the caller's
 * client, org + client-scope checked, closer recorded as core.users.id), and (4) issues the
 * certificate ONLY after every month locked: a lock failure fails the sign-off (no certificate).
 */
export async function signOff(db: DB, orgId: string, project: ProjectRow, actorUserId: string, deps: SignOffDeps): Promise<{ certificate: CertificateDto; periodsLocked: number }> {
  const view = await certificateView(db, orgId, project, actorUserId);
  const cert = view.certificate;
  if (!cert) throw new MigrationError('The preparer hasn’t signed the balance proof yet.', 409, 'NO_PROOF');
  if (project.shadow_mode === 'parallel' && !(project.skipped_stages ?? []).includes('shadow_close')) {
    throw new MigrationError('This client is set to practice-close in both systems. That compare arrives in the next release — switch to a clean switch, or skip the practice close with a reason, before signing off.', 409, 'PRACTICE_CLOSE');
  }
  const gate = signOffGate({ status: cert.status, preparedBy: cert.preparedBy, actorUserId, reviewerUserId: project.reviewer_user_id, tiesStillTie: hashOf(view.ties) === hashOf(cert.ties) });
  if (!gate.ready) throw new MigrationError(gate.blockers[0], 409, 'SIGN_OFF_BLOCKED');
  await assertCutoverNotFuture(db, orgId, cert.cutoverDate);
  if (!(await deps.canManageClose())) {
    throw new MigrationError('Signing off locks the months up to the cutover, so it also needs close management. Ask a controller to sign off.', 403, 'CLOSE_PERMISSION');
  }

  // Months up to the cutover lock for good (spec §10.7) — BEFORE the certificate is issued.
  const setStatus = deps.setStatus ?? setPeriodStatus;
  const { data: periods, error: pe } = await db
    .from('fiscal_periods')
    .select('id, status, end_date')
    .eq('org_id', orgId)
    .eq('location_id', project.location_id)
    .lte('end_date', cert.cutoverDate)
    .neq('status', 'HARD_CLOSE');
  if (pe) throw new MigrationError('Could not read the months to lock — nothing was signed off. Try again.', 503, 'LOCK_READ_FAILED');
  let periodsLocked = 0;
  for (const p of (periods ?? []) as Array<{ id: string }>) {
    try {
      await setStatus(db, orgId, p.id, 'HARD_CLOSE', actorUserId, `Conversion certificate ${cert.number} signed off`);
      periodsLocked += 1;
    } catch (e) {
      console.error('[onboarding-migration] period lock failed:', e instanceof Error ? e.message : e);
      throw new MigrationError(
        `Could not lock every month up to the cutover (${periodsLocked} locked before the failure) — the certificate was NOT signed off. Try again, or ask an admin to check the periods.`,
        409,
        'LOCK_FAILED',
      );
    }
  }

  const writer = serviceWriter();
  const now = new Date().toISOString();
  const { data, error } = await writer
    .from('conversion_certificates')
    .update({ status: 'issued', approved_by: actorUserId, approved_at: now })
    .eq('org_id', orgId)
    .eq('id', cert.id)
    .eq('status', 'prepared')
    .select(CERT_COLS)
    .single();
  if (error) {
    if (/conversion_certificates_values_chk/.test(error.message)) throw new MigrationError('The person who signed the balance proof can’t also sign off.', 409, 'SOD');
    throw new Error(`Could not sign off: ${error.message}`);
  }
  await patchProject(orgId, project.id, { stage: 'certified', certified_at: now, stage_changed_at: now });
  // Ledger sources are one-time: archive them at sign-off (field / bank sources stay).
  await writer.from('migration_sources').update({ status: 'archived', note: `Archived at sign-off (${cert.number})` }).eq('org_id', orgId).eq('project_id', project.id).eq('role', 'ledger_source');
  await logEvent(orgId, project, 'certificate_issued', `Certificate ${cert.number} signed off · ${periodsLocked} month${periodsLocked === 1 ? '' : 's'} up to ${longDate(cert.cutoverDate)} locked`, { actor: actorUserId, detail: { certificate: cert.number } });
  return { certificate: toDto(data as Record<string, unknown>), periodsLocked };
}

export async function voidCertificate(db: DB, orgId: string, project: ProjectRow, actorUserId: string, reason: string): Promise<void> {
  if (reason.trim().length < 10) throw new MigrationError('Give the reason in a sentence — it’s kept with the voided certificate.', 422, 'REASON');
  const cert = await loadCertificate(db, project);
  if (!cert || cert.status === 'voided') throw new MigrationError('There is no certificate to void.', 404, 'NO_CERT');
  const now = new Date().toISOString();
  const writer = serviceWriter();
  await writer.from('migration_projects').update({ certificate_id: null, stage: 'tie_out', certified_at: null, live_at: null, stage_changed_at: now }).eq('org_id', orgId).eq('id', project.id);
  const { error } = await writer.from('conversion_certificates').update({ status: 'voided', void_reason: reason.trim(), voided_by: actorUserId, voided_at: now }).eq('org_id', orgId).eq('id', cert.id);
  if (error) throw new Error(`Could not void: ${error.message}`);
  await logEvent(orgId, project, 'certificate_voided', `Certificate ${cert.number} voided: ${reason.trim()}`, { actor: actorUserId });
}

export async function goLive(db: DB, orgId: string, project: ProjectRow, actorUserId: string): Promise<ProjectRow> {
  const cert = await loadCertificate(db, project);
  if (!cert || cert.status !== 'issued') throw new MigrationError('Go-live needs a signed-off certificate. The reviewer signs it off first.', 409, 'NO_CERTIFICATE');
  const now = new Date().toISOString();
  const next = await patchProject(orgId, project.id, { stage: 'live', live_at: now, stage_changed_at: now });
  // Mirror onto the client's onboarding status (the legacy board reads it).
  await serviceWriter().schema('core').from('locations').update({ onboarding_status: 'complete', onboarding_completed_at: now }).eq('org_id', orgId).eq('id', project.location_id);
  await logEvent(orgId, project, 'went_live', `${stageLabel('live')} — MeritBooks is the book of record (certificate ${cert.number})`, { actor: actorUserId });
  return next;
}

export { dollars };

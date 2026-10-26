/**
 * "Load" — hand the matched, checked data to the EXISTING engines (reuse, don't rebuild):
 *
 *   Opening balances  the staged trial balance + this client's accepted matches become a
 *                     historical-conversion session (same ai_decisions shape the conversion
 *                     review / tie-out / post path already uses — lib/onboarding/conversion.ts).
 *                     The opening entry posts there, through postJournalEntry, gated as today.
 *   Open A/R / A/P    the staged aging rows (ledger source only), with every party named as
 *                     the existing record a person linked it to, shaped for the existing
 *                     /api/onboarding/import/{ar,ap} commit (which creates the open invoices /
 *                     bills and writes Σ open into the session's subledger detail).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { serviceWriter } from '@/lib/db/scoped-writer';
import { applyMapping, CONVERSION_FEATURE, CONVERSION_KIND, type ConversionSessionData, type MappingTable, type SourceLine } from '@/lib/onboarding/conversion';
import { loadSession, loadTargetAccounts, saveSessionData } from '@/lib/onboarding/session';
import type { RawArOpenItem, RawArParty } from '@/lib/onboarding/import/ar';
import type { RawApOpenItem, RawApParty } from '@/lib/onboarding/import/ap';
import type { StagedOpenItem, StagedParty, StagedTbLine } from '../types';
import { longDate, plural } from '../format';
import { MigrationError } from './guard';
import { loadRuns, loadSources, loadStaged, logEvent, patchProject, type ProjectRow } from './store';
import { loadMappings } from './mapping';

type DB = SupabaseClient;

export async function stageOpeningSession(db: DB, orgId: string, project: ProjectRow, userId: string): Promise<{ sessionId: string; created: boolean }> {
  if (!project.cutover_date) throw new MigrationError('Set the cutover date first.', 409, 'NO_CUTOVER');
  const tb = await loadStaged(db, project.id, ['tb_line']);
  if (tb.length === 0) throw new MigrationError('Drop the trial balance as of the cutover first.', 409, 'NO_TB');
  const maps = await loadMappings(db, project.id);
  const open = maps.filter((m) => m.balance_cents !== 0 && m.status !== 'accepted');
  if (open.length > 0) throw new MigrationError(`${plural(open.length, 'account')} with a balance still need a match (for example ${open[0].source_name}).`, 409, 'UNMATCHED');

  const { data: accts } = await db.from('accounts').select('id, account_number').eq('org_id', orgId).limit(5000);
  const numberOf = new Map(((accts ?? []) as Array<{ id: string; account_number: string }>).map((a) => [a.id, String(a.account_number)]));
  const lines: SourceLine[] = [];
  for (const r of tb) {
    const p = r.payload as unknown as StagedTbLine;
    if ((p.debitCents || 0) === 0 && (p.creditCents || 0) === 0) continue;
    const num = p.number && p.number !== p.name && /\d/.test(p.number) ? p.number : null;
    lines.push({ sourceAccount: num ?? p.name.trim(), sourceName: p.name, debitCents: p.debitCents || 0, creditCents: p.creditCents || 0 });
  }
  const mapping: MappingTable = {};
  for (const m of maps) {
    const n = m.target_account_id ? numberOf.get(m.target_account_id) ?? null : null;
    mapping[m.source_account_key] = {
      targetAccountNumber: m.status === 'accepted' ? n : null,
      confidence: m.confidence,
      source: m.proposal_source === 'ai' ? 'ai' : m.proposal_source === 'human' ? 'human' : m.status === 'accepted' ? 'human' : 'heuristic',
      reasoning: m.reason ?? undefined,
    };
  }
  const targets = await loadTargetAccounts(db, orgId);
  const assembled = applyMapping(lines, mapping, targets);
  const { data: loc } = await db.schema('core').from('locations').select('id, short_code, name').eq('org_id', orgId).eq('id', project.location_id).maybeSingle();
  if (!loc) throw new MigrationError('That client was not found.', 404, 'NOT_FOUND');
  const company = loc as { id: string; short_code: string; name: string };

  // An existing, un-posted session is refreshed in place (keeps its subledger detail).
  if (project.conversion_session_id) {
    const s = await loadSession(db, orgId, project.conversion_session_id);
    if (s && s.postedGlEntryId) throw new MigrationError('The opening entry already posted. Reverse it from the journal before loading again.', 409, 'POSTED');
    if (s) {
      const data: ConversionSessionData = {
        ...s.data,
        asOfDate: project.cutover_date,
        sourceLines: lines,
        mapping,
        openingBalances: assembled.openingBalances,
        balance: assembled.balance,
        balanceSheet: assembled.balanceSheet,
        unmapped: assembled.unmapped,
        unknownTargets: assembled.unknownTargets,
        sourceTotals: assembled.sourceTotals,
        tiedOut: false,
        tiedOutBy: null,
        tiedOutAt: null,
      };
      await saveSessionData(db, orgId, s.id, data);
      await logEvent(orgId, project, 'opening_staged', `Opening balances refreshed as of ${longDate(project.cutover_date)} · ${plural(assembled.openingBalances.length, 'account')}`, { actor: userId });
      return { sessionId: s.id, created: false };
    }
  }

  const data: ConversionSessionData = {
    kind: CONVERSION_KIND,
    companyId: company.id,
    companyShortCode: company.short_code,
    asOfDate: project.cutover_date,
    sourceLines: lines,
    mapping,
    openingBalances: assembled.openingBalances,
    balance: assembled.balance,
    balanceSheet: assembled.balanceSheet,
    unmapped: assembled.unmapped,
    unknownTargets: assembled.unknownTargets,
    sourceTotals: assembled.sourceTotals,
    plAcknowledged: false,
    intake: { fileName: 'Client migration (matched)', aiUsed: maps.some((m) => m.proposal_source === 'ai'), aiError: null, excluded: [], excludedCount: 0, zeroRows: 0 },
    tiedOut: false,
    tiedOutBy: null,
    tiedOutAt: null,
  };
  const { data: inserted, error } = await serviceWriter()
    .from('ai_decisions')
    .insert({
      org_id: orgId,
      location_id: company.id,
      feature: CONVERSION_FEATURE,
      model_requested: null,
      input_summary: `Client migration — ${company.name} (${company.short_code}) opening balances as of ${project.cutover_date}: ${lines.length} source accounts, matched in the migration workspace`.slice(0, 2000),
      proposed_output: data,
      reasoning: 'Matches were decided in the client migration (firm rules, crosswalk, heuristics, AI-capped, and people). Every balance comes from the staged trial balance. Posting stays gated on the conversion tie-out.',
      status: 'PROPOSED',
      created_by_user: userId,
    })
    .select('id')
    .single();
  if (error || !inserted) throw new Error(`Could not stage the opening balances: ${error?.message ?? 'unknown'}`);
  const sessionId = (inserted as { id: string }).id;
  await patchProject(orgId, project.id, { conversion_session_id: sessionId });
  await logEvent(orgId, project, 'opening_staged', `Opening balances staged as of ${longDate(project.cutover_date)} · ${plural(assembled.openingBalances.length, 'account')} · ready to review and post`, { actor: userId, detail: { sessionId } });
  return { sessionId, created: true };
}

export interface OpenItemsPayload {
  kind: 'ar' | 'ap';
  companyId: string;
  parties: Array<RawArParty | RawApParty>;
  openItems: Array<RawArOpenItem | RawApOpenItem>;
  count: number;
  totalCents: number;
  skippedUnapplied: number;
}

/** Staged open invoices / bills (ledger source) shaped for the existing AR / AP commit. */
export async function openItemsPayload(db: DB, project: ProjectRow, kind: 'ar' | 'ap'): Promise<OpenItemsPayload> {
  if (!project.conversion_session_id) throw new MigrationError('Load the opening balances first — open items attach to the opening.', 409, 'NO_SESSION');
  const entity = kind === 'ar' ? 'open_invoice' : 'open_bill';
  const partyEntity = kind === 'ar' ? 'customer' : 'vendor';
  const [items, parties, runs, sources] = await Promise.all([
    loadStaged(db, project.id, [entity]),
    loadStaged(db, project.id, [partyEntity]),
    loadRuns(db, project.id, { activeOnly: true }),
    loadSources(db, project.id),
  ]);
  const roleByRun = new Map(runs.map((r) => [r.id, sources.find((s) => s.id === r.source_id)?.role ?? null]));
  const ledgerItems = items.filter((r) => roleByRun.get(r.run_id) !== 'field_system');

  // Name each party as the existing record a person linked it to, so the importer reuses it.
  const linkedIds = Array.from(new Set(parties.filter((p) => p.match_status === 'matched' && p.matched_object_id).map((p) => p.matched_object_id!)));
  const existingName = new Map<string, string>();
  if (linkedIds.length > 0) {
    const { data } = await db.schema('core').from(kind === 'ar' ? 'customers' : 'vendors').select('id, name').in('id', linkedIds.slice(0, 1000));
    for (const r of (data ?? []) as Array<{ id: string; name: string }>) existingName.set(r.id, r.name);
  }
  const canonical = new Map<string, string>();
  const partyRows: Array<RawArParty | RawApParty> = [];
  for (const p of parties) {
    if (p.match_status === 'ignored') continue;
    const d = p.payload as unknown as StagedParty;
    const name = p.match_status === 'matched' && p.matched_object_id ? existingName.get(p.matched_object_id) ?? d.name : d.name;
    canonical.set(d.name.trim().toLowerCase(), name);
    partyRows.push(kind === 'ar' ? { name, email: d.email ?? null, phone: d.phone ?? null } : { name, email: d.email ?? null, phone: d.phone ?? null, is1099Eligible: d.is1099 ?? null });
  }
  let skippedUnapplied = 0;
  const openItems: Array<RawArOpenItem | RawApOpenItem> = [];
  let total = 0;
  const fallbackDate = project.cutover_date ?? new Date().toISOString().slice(0, 10);
  for (const r of ledgerItems) {
    const o = r.payload as unknown as StagedOpenItem;
    if (o.unapplied || o.balanceCents <= 0) { skippedUnapplied++; continue; }
    const partyName = canonical.get(o.party.trim().toLowerCase()) ?? o.party;
    const totalCents = Math.max(o.totalCents || 0, o.balanceCents);
    openItems.push({ partyName, docNumber: o.docNumber, date: o.date ?? fallbackDate, dueDate: o.dueDate ?? o.date ?? fallbackDate, totalCents, amountPaidCents: totalCents - o.balanceCents });
    total += o.balanceCents;
  }
  if (openItems.length === 0) throw new MigrationError(`No open ${kind === 'ar' ? 'invoices' : 'bills'} are staged. Drop the ${kind === 'ar' ? 'A/R' : 'A/P'} aging as of the cutover.`, 409, 'NONE');
  return { kind, companyId: project.location_id, parties: partyRows, openItems, count: openItems.length, totalCents: total, skippedUnapplied };
}

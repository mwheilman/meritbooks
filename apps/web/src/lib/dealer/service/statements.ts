/**
 * Lender statements / floor checks (FPB §3.10, V5) and manufacturer statements
 * (§3.8.3, §5 A3 rule layer).
 */

import { decideDisposition, loadAutonomyGovernance } from '@/lib/autonomy/disposition';
import { assertApprover, blockingLines, footStatement, matchStatement, type NoteForMatch, type StatementLineIn } from '../engine/statement-match';
import { matchOemCredits, type OpenClaim } from '../engine/oem-match';
import type { StatementKind, StatementMatchStatus } from '../types';
import type { DealerCtx } from './context';
import { DealerError, dbFail } from './errors';
import { coerceMoney, getRow, insertRow, updateRow, type LineRow } from './rows';
import { loadSettings } from './settings';
import { settleIncentive, settleWarrantyClaim } from './claims';
import { audit } from './audit';

export const DEALER_OEM_MATCH_FEATURE = 'DEALER_OEM_CREDIT_MATCH';

export interface LenderStatementLineInput {
  lenderInvoiceNumber?: string | null;
  serialNumber?: string | null;
  model?: string | null;
  originalCents?: number | null;
  currentCents?: number | null;
  interestCents?: number | null;
  feesCents?: number | null;
  lenderCode?: string | null;
  dispositionDate?: string | null;
  days?: number | null;
}

export interface LenderStatementInput {
  lineId: string;
  kind: StatementKind;
  statementDate: string;
  documentId?: string | null;
  importBatchId?: string | null;
  footer: { principalCents: number | null; interestCents?: number | null; feesCents?: number | null; lineCount?: number | null };
  lines: LenderStatementLineInput[];
  notes?: string | null;
}

export interface StatementHeader {
  id: string;
  line_id: string;
  kind: StatementKind;
  statement_date: string;
  status: 'IMPORTED' | 'MATCHING' | 'PREPARED' | 'APPROVED';
  prepared_by: string | null;
  approved_by: string | null;
}

export async function importLenderStatement(d: DealerCtx, input: LenderStatementInput): Promise<{ statement: StatementHeader; lineCount: number }> {
  await getRow<LineRow>(d, 'floor_plan_lines', input.lineId, 'Floor-plan line');
  const rows = input.lines.map((l) => ({
    lender_invoice_number: l.lenderInvoiceNumber ?? null,
    serial_number: l.serialNumber ?? null,
    model: l.model ?? null,
    original_cents: l.originalCents ?? null,
    current_cents: l.currentCents ?? null,
    interest_cents: l.interestCents ?? null,
    fees_cents: l.feesCents ?? null,
    lender_code: l.lenderCode ?? null,
  }));
  const foot = footStatement(rows, {
    principalCents: input.footer.principalCents,
    interestCents: input.footer.interestCents ?? null,
    feesCents: input.footer.feesCents ?? null,
    lineCount: input.footer.lineCount ?? null,
  });
  if (!foot.ok) throw new DealerError('NOT_FOOTING', 'The statement does not foot to its footer — fix the import before matching.', { problems: foot.problems, sums: foot.sums });

  const statement = await insertRow<StatementHeader>(d, 'lender_statements', {
    line_id: input.lineId, kind: input.kind, statement_date: input.statementDate, document_id: input.documentId ?? null,
    import_batch_id: input.importBatchId ?? null, footer_principal_cents: input.footer.principalCents,
    footer_interest_cents: input.footer.interestCents ?? null, footer_fees_cents: input.footer.feesCents ?? null,
    footer_line_count: input.footer.lineCount ?? null, notes: input.notes ?? null, created_by: d.userId,
  }, 'Lender statement');
  if (rows.length > 0) {
    const { error } = await d.admin.from('lender_statement_lines').insert(
      input.lines.map((l, i) => ({
        org_id: d.orgId, location_id: d.locationId, statement_id: statement.id, line_number: i + 1, ...rows[i],
        disposition_date: l.dispositionDate ?? null, days: l.days ?? null,
      })),
    );
    if (error) {
      await d.admin.from('lender_statements').delete().eq('org_id', d.orgId).eq('id', statement.id);
      dbFail('Saving statement lines failed', error);
    }
  }
  return { statement, lineCount: rows.length };
}

export async function matchLenderStatement(d: DealerCtx, statementId: string): Promise<ReturnType<typeof matchStatement>> {
  const st = await getRow<StatementHeader>(d, 'lender_statements', statementId, 'Lender statement');
  if (st.status === 'PREPARED' || st.status === 'APPROVED') throw new DealerError('CONFLICT', 'A prepared reconciliation cannot be re-matched — reopen it first');
  const line = await getRow<LineRow>(d, 'floor_plan_lines', st.line_id, 'Floor-plan line');
  const settings = await loadSettings(d);

  // Clear prior synthetic BOOKS_ONLY rows so a re-run is idempotent.
  await d.admin.from('lender_statement_lines').delete().eq('org_id', d.orgId).eq('statement_id', st.id).eq('match_status', 'BOOKS_ONLY').is('line_number', null);

  const [linesRes, notesRes] = await Promise.all([
    d.admin.from('lender_statement_lines').select('*').eq('org_id', d.orgId).eq('statement_id', st.id).order('line_number'),
    d.admin.from('floor_plan_notes').select('id, unit_id, lender_invoice_number, original_principal_cents, principal_balance_cents, status')
      .eq('org_id', d.orgId).eq('line_id', st.line_id).in('status', ['OPEN', 'SOLD_UNPAID', 'IN_DEFAULT']),
  ]);
  if (linesRes.error) dbFail('Statement lines lookup failed', linesRes.error);
  if (notesRes.error) dbFail('Notes lookup failed', notesRes.error);
  const notes = ((notesRes.data ?? []) as Record<string, unknown>[]).map((r) => coerceMoney<{ id: string; unit_id: string | null; lender_invoice_number: string; original_principal_cents: number; principal_balance_cents: number; status: NoteForMatch['status'] }>(r));
  const unitIds = notes.map((n) => n.unit_id).filter((x): x is string => !!x);
  const unitsRes = unitIds.length
    ? await d.admin.from('dealer_units').select('id, serial_number, model').eq('org_id', d.orgId).in('id', unitIds)
    : { data: [], error: null };
  if (unitsRes.error) dbFail('Units lookup failed', unitsRes.error);
  const unitById = new Map(((unitsRes.data ?? []) as { id: string; serial_number: string; model: string | null }[]).map((u) => [u.id, u]));

  const allLines = ((linesRes.data ?? []) as Record<string, unknown>[])
    .map((r) => coerceMoney<StatementLineIn & { match_status: StatementMatchStatus; matched_note_id?: string | null }>(r));
  const stmtLines = allLines.filter((l) => l.match_status !== 'RESOLVED');
  // A note already accounted for by a RESOLVED line (incl. a resolved books-only row)
  // must not resurface as a fresh BOOKS_ONLY row on re-match (D2 fix: it re-blocked Prepare).
  const resolvedNoteIds = new Set(
    allLines.filter((l) => l.match_status === 'RESOLVED' && l.matched_note_id).map((l) => l.matched_note_id as string),
  );
  const raw = matchStatement({
    kind: st.kind,
    lines: stmtLines,
    notes: notes.map((n) => ({
      id: n.id, lender_invoice_number: n.lender_invoice_number, serial_number: n.unit_id ? unitById.get(n.unit_id)?.serial_number ?? null : null,
      model: n.unit_id ? unitById.get(n.unit_id)?.model ?? null : null, original_principal_cents: n.original_principal_cents,
      principal_balance_cents: n.principal_balance_cents, status: n.status,
    })),
    toleranceCents: settings.statement_tolerance_cents,
    sauCodes: line.sau_codes ?? [],
  });
  const booksOnlyNoteIds = raw.booksOnlyNoteIds.filter((id) => !resolvedNoteIds.has(id));
  const result = { ...raw, booksOnlyNoteIds, summary: { ...raw.summary, booksOnly: booksOnlyNoteIds.length } };
  for (const m of result.lines) {
    const { error } = await d.admin.from('lender_statement_lines').update({
      matched_note_id: m.matchedNoteId, match_status: m.matchStatus, match_method: m.method, variance_cents: m.varianceCents, sau_flag: m.sauFlag,
    }).eq('org_id', d.orgId).eq('id', m.lineId);
    if (error) dbFail('Saving match results failed', error);
  }
  if (result.booksOnlyNoteIds.length > 0) {
    const byId = new Map(notes.map((n) => [n.id, n]));
    const { error } = await d.admin.from('lender_statement_lines').insert(
      result.booksOnlyNoteIds.map((id) => ({
        org_id: d.orgId, location_id: d.locationId, statement_id: st.id, line_number: null,
        lender_invoice_number: byId.get(id)?.lender_invoice_number ?? null, matched_note_id: id,
        match_status: 'BOOKS_ONLY', match_method: 'BOOKS_ONLY', variance_cents: byId.get(id)?.principal_balance_cents ?? 0,
      })),
    );
    if (error) dbFail('Saving books-only lines failed', error);
  }
  await updateRow(d, 'lender_statements', st.id, { status: 'MATCHING' }, 'Lender statement');
  return result;
}

export async function resolveStatementLine(d: DealerCtx, lineId: string, resolution: string): Promise<void> {
  const { data, error } = await d.admin.from('lender_statement_lines').select('id, statement_id').eq('org_id', d.orgId).eq('location_id', d.locationId).eq('id', lineId).maybeSingle();
  if (error) dbFail('Statement line lookup failed', error);
  if (!data) throw new DealerError('NOT_FOUND', 'Statement line not found');
  const st = await getRow<StatementHeader>(d, 'lender_statements', (data as { statement_id: string }).statement_id, 'Lender statement');
  if (st.status === 'PREPARED' || st.status === 'APPROVED') throw new DealerError('CONFLICT', 'The reconciliation is already prepared');
  const { error: uErr } = await d.admin.from('lender_statement_lines')
    .update({ match_status: 'RESOLVED', resolution, resolved_by: d.userId, resolved_at: new Date().toISOString() })
    .eq('org_id', d.orgId).eq('id', lineId);
  if (uErr) dbFail('Resolving the line failed', uErr);
}

export async function prepareLenderStatement(d: DealerCtx, statementId: string): Promise<StatementHeader> {
  const st = await getRow<StatementHeader>(d, 'lender_statements', statementId, 'Lender statement');
  if (st.status !== 'MATCHING') throw new DealerError('CONFLICT', 'Run matching before preparing the reconciliation');
  const settings = await loadSettings(d);
  const { data, error } = await d.admin.from('lender_statement_lines').select('id, match_status, variance_cents').eq('org_id', d.orgId).eq('statement_id', st.id);
  if (error) dbFail('Statement lines lookup failed', error);
  const blocking = blockingLines(((data ?? []) as { id: string; match_status: StatementMatchStatus; variance_cents: number }[]).map((l) => ({ ...l, variance_cents: Number(l.variance_cents) })), settings.statement_tolerance_cents);
  if (blocking.length > 0) {
    throw new DealerError('CONFLICT', `Resolve ${blocking.length} line(s) (variance over tolerance, lender-only or books-only) before preparing.`, { lineIds: blocking.map((b) => b.id), detector: 'DL-8' });
  }
  const row = await updateRow<StatementHeader>(d, 'lender_statements', st.id, { status: 'PREPARED', prepared_by: d.userId, prepared_at: new Date().toISOString() }, 'Lender statement', { status: 'MATCHING' });
  return row ?? st;
}

export async function approveLenderStatement(d: DealerCtx, statementId: string): Promise<StatementHeader> {
  const st = await getRow<StatementHeader>(d, 'lender_statements', statementId, 'Lender statement');
  if (st.status !== 'PREPARED') throw new DealerError('CONFLICT', 'Only a prepared reconciliation can be approved');
  try {
    assertApprover(st.prepared_by, d.userId);
  } catch (e) {
    throw new DealerError('SEPARATION_OF_DUTIES', (e as Error).message);
  }
  const row = await updateRow<StatementHeader>(d, 'lender_statements', st.id, { status: 'APPROVED', approved_by: d.userId, approved_at: new Date().toISOString() }, 'Lender statement', { status: 'PREPARED' });
  await audit(d, 'lender_statement.approve', 'lender_statements', st.id, `Signed off the ${st.kind.toLowerCase()} of ${st.statement_date}`, { preparedBy: st.prepared_by });
  return row ?? st;
}

/** Send a prepared (not yet approved) reconciliation back to matching. */
export async function reopenLenderStatement(d: DealerCtx, statementId: string): Promise<StatementHeader> {
  const st = await getRow<StatementHeader>(d, 'lender_statements', statementId, 'Lender statement');
  if (st.status !== 'PREPARED') throw new DealerError('CONFLICT', 'Only a prepared reconciliation can be reopened');
  return (await updateRow<StatementHeader>(d, 'lender_statements', st.id, { status: 'MATCHING', prepared_by: null, prepared_at: null }, 'Lender statement', { status: 'PREPARED' })) ?? st;
}

// ── OEM statements ────────────────────────────────────────────────────────────

export interface OemStatementInput {
  oemVendorId: string;
  statementDate: string;
  documentId?: string | null;
  importBatchId?: string | null;
  footerTotalCents: number;
  lines: { lineType: 'WARRANTY_CREDIT' | 'INCENTIVE_CREDIT' | 'DEBIT' | 'PARTS_INVOICE' | 'OTHER'; reference?: string | null; serialNumber?: string | null; description?: string | null; amountCents: number }[];
}

/** Lines are signed as the manufacturer states them; they must sum to the footer. */
export async function importOemStatement(d: DealerCtx, input: OemStatementInput): Promise<{ id: string; lineCount: number }> {
  const sum = input.lines.reduce((s, l) => s + l.amountCents, 0);
  if (sum !== input.footerTotalCents) {
    throw new DealerError('NOT_FOOTING', `Lines total ${sum} but the statement footer says ${input.footerTotalCents}.`);
  }
  const st = await insertRow<{ id: string }>(d, 'oem_statements', {
    oem_vendor_id: input.oemVendorId, statement_date: input.statementDate, document_id: input.documentId ?? null,
    import_batch_id: input.importBatchId ?? null, footer_total_cents: input.footerTotalCents, created_by: d.userId,
  }, 'Manufacturer statement');
  if (input.lines.length > 0) {
    const { error } = await d.admin.from('oem_statement_lines').insert(input.lines.map((l, i) => ({
      org_id: d.orgId, location_id: d.locationId, statement_id: st.id, line_number: i + 1, line_type: l.lineType,
      reference: l.reference ?? null, serial_number: l.serialNumber ?? null, description: l.description ?? null, amount_cents: l.amountCents,
    })));
    if (error) {
      await d.admin.from('oem_statements').delete().eq('org_id', d.orgId).eq('id', st.id);
      dbFail('Saving manufacturer statement lines failed', error);
    }
  }
  return { id: st.id, lineCount: input.lines.length };
}

export interface OemMatchResult {
  proposals: ReturnType<typeof matchOemCredits>;
  autoSettled: string[];
}

/**
 * Deterministic matcher over open claims of the statement's manufacturer. Pairs are
 * PROPOSED; an exact claim # + exact amount pair auto-settles ONLY when the tenant
 * raised the DEALER_OEM_CREDIT_MATCH dial to AUTO_UNDER_LIMIT and the amount is under
 * its cap. Short-pays and rejections never auto-settle.
 */
export async function matchOemStatement(d: DealerCtx, statementId: string): Promise<OemMatchResult> {
  const st = await getRow<{ id: string; oem_vendor_id: string; statement_date: string }>(d, 'oem_statements', statementId, 'Manufacturer statement');
  const settings = await loadSettings(d);
  const [linesRes, wRes, iRes] = await Promise.all([
    d.admin.from('oem_statement_lines').select('*').eq('org_id', d.orgId).eq('statement_id', st.id).in('match_status', ['UNMATCHED', 'PROPOSED']),
    d.admin.from('warranty_claims').select('id, oem_claim_number, serial_number, claimed_cents, settled_cents, written_off_cents, status')
      .eq('org_id', d.orgId).eq('location_id', d.locationId).eq('oem_vendor_id', st.oem_vendor_id).in('status', ['SUBMITTED', 'PARTIAL', 'RESUBMITTED']),
    d.admin.from('v_incentive_aging').select('claim_id, open_cents, status').eq('org_id', d.orgId).eq('location_id', d.locationId).eq('oem_vendor_id', st.oem_vendor_id),
  ]);
  for (const r of [linesRes, wRes, iRes]) if (r.error) dbFail('OEM match inputs lookup failed', r.error);
  const incIds = ((iRes.data ?? []) as { claim_id: string }[]).map((x) => x.claim_id);
  const incRefs = incIds.length
    ? await d.admin.from('oem_incentive_claims').select('id, claim_reference, unit_id').eq('org_id', d.orgId).in('id', incIds)
    : { data: [], error: null };
  if (incRefs.error) dbFail('Incentive lookup failed', incRefs.error);
  const refById = new Map(((incRefs.data ?? []) as { id: string; claim_reference: string | null }[]).map((x) => [x.id, x.claim_reference]));
  const claims: OpenClaim[] = [
    ...((wRes.data ?? []) as Record<string, unknown>[]).map((w) => {
      const c = coerceMoney<{ id: string; oem_claim_number: string | null; serial_number: string | null; claimed_cents: number; settled_cents: number; written_off_cents: number }>(w);
      return { kind: 'WARRANTY' as const, id: c.id, reference: c.oem_claim_number, serial_number: c.serial_number, openCents: c.claimed_cents - c.settled_cents - c.written_off_cents };
    }),
    ...((iRes.data ?? []) as { claim_id: string; open_cents: number; status: string }[])
      .filter((x) => x.status !== 'REJECTED')
      .map((x) => ({ kind: 'INCENTIVE' as const, id: x.claim_id, reference: refById.get(x.claim_id) ?? null, serial_number: null, openCents: Number(x.open_cents) })),
  ];
  const lines = ((linesRes.data ?? []) as Record<string, unknown>[]).map((r) => coerceMoney<{ id: string; line_type: string; reference: string | null; serial_number: string | null; amount_cents: number }>(r));
  const proposals = matchOemCredits({ lines, claims, autoMinConfidenceBps: settings.auto_match_min_confidence_bps });
  const gov = await loadAutonomyGovernance(d.db, d.orgId, DEALER_OEM_MATCH_FEATURE);
  const autoSettled: string[] = [];
  for (const p of proposals) {
    const { error } = await d.admin.from('oem_statement_lines').update({
      match_status: 'PROPOSED', match_confidence_bps: p.confidenceBps,
      matched_warranty_claim_id: p.claimKind === 'WARRANTY' ? p.claimId : null,
      matched_incentive_claim_id: p.claimKind === 'INCENTIVE' ? p.claimId : null,
    }).eq('org_id', d.orgId).eq('id', p.lineId);
    if (error) dbFail('Saving OEM match proposals failed', error);
    if (!p.autoSettleEligible) continue;
    const line = lines.find((l) => l.id === p.lineId)!;
    const decision = decideDisposition({ killSwitchEngaged: gov.killSwitchEngaged, setting: gov.setting, scoreTier: 'auto', amountCents: line.amount_cents });
    if (decision.disposition !== 'AUTO') continue;
    await settleOemLine(d, p.lineId, st.statement_date);
    autoSettled.push(p.lineId);
  }
  await updateRow(d, 'oem_statements', st.id, { status: 'MATCHING' }, 'Manufacturer statement');
  return { proposals, autoSettled };
}

/** Human confirmation of a proposed (or hand-picked) line ↔ claim pair: settle by statement credit. */
export async function settleOemLine(
  d: DealerCtx,
  lineId: string,
  date: string,
  pick?: { claimKind: 'WARRANTY' | 'INCENTIVE'; claimId: string },
): Promise<void> {
  const { data, error } = await d.admin.from('oem_statement_lines').select('*').eq('org_id', d.orgId).eq('location_id', d.locationId).eq('id', lineId).maybeSingle();
  if (error) dbFail('OEM line lookup failed', error);
  if (!data) throw new DealerError('NOT_FOUND', 'Manufacturer statement line not found');
  const line = coerceMoney<{ id: string; amount_cents: number; match_status: string; matched_warranty_claim_id: string | null; matched_incentive_claim_id: string | null }>(data as Record<string, unknown>);
  if (line.match_status === 'SETTLED') return;
  if (line.amount_cents <= 0) throw new DealerError('VALIDATION', 'Only a credit line settles a claim');
  const kind = pick?.claimKind ?? (line.matched_warranty_claim_id ? 'WARRANTY' : line.matched_incentive_claim_id ? 'INCENTIVE' : null);
  const claimId = pick?.claimId ?? line.matched_warranty_claim_id ?? line.matched_incentive_claim_id;
  if (!kind || !claimId) throw new DealerError('VALIDATION', 'Pick the claim this credit settles');
  const input = { claimId, amountCents: line.amount_cents, method: 'STATEMENT_CREDIT' as const, date, oemStatementLineId: line.id };
  if (kind === 'WARRANTY') await settleWarrantyClaim(d, input);
  else await settleIncentive(d, input);
}

export async function ignoreOemLine(d: DealerCtx, lineId: string): Promise<void> {
  const { error } = await d.admin.from('oem_statement_lines').update({ match_status: 'IGNORED' })
    .eq('org_id', d.orgId).eq('location_id', d.locationId).eq('id', lineId).neq('match_status', 'SETTLED');
  if (error) dbFail('Ignoring the line failed', error);
}

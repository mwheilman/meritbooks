/**
 * DL-8 — Lender statement variance (FPB §6, AC 11). HIGH, one exception per
 * statement (key DL-8:<statement>), refreshed as lines are worked, expired when the
 * statement is approved or every blocking line is resolved.
 *
 * Reuses D1's `blockingLines` rule. A VARIANCE line beyond `statement_tolerance_cents`
 * fires as soon as it exists; unresolved LENDER_ONLY / BOOKS_ONLY / UNMATCHED lines
 * fire from the month end of the statement date (they are often timing items until
 * then). Payoff quotes are not reconciliations and are skipped.
 */

import { blockingLines } from '@/lib/dealer/engine/statement-match';
import { monthBounds } from '@/lib/dealer/dates';
import type { StatementKind, StatementMatchStatus, StatementStatus } from '@/lib/dealer/types';
import { STATEMENT_KIND } from '@/lib/dealer/ui/labels';
import { dealerLinks } from '@/lib/dealer/ui/links';
import { dateLabel } from '@/lib/dealer/ui/format';
import { fetchAll, fetchAllIn } from '@/lib/supabase/fetch-all';
import { DEALER_FEATURES, money, plural, readFail, type ClientScan, type DealerDetectorDef, type DealerFinding } from './shared';

export interface StatementIn {
  id: string;
  line_id: string;
  line_name: string;
  kind: StatementKind;
  statement_date: string;
  status: StatementStatus;
}

export interface StatementLineIn {
  id: string;
  statement_id: string;
  match_status: StatementMatchStatus;
  variance_cents: number;
  current_cents: number | null;
}

/** $ a blocking line puts in question. */
export function lineAtRisk(l: StatementLineIn): number {
  if (l.match_status === 'VARIANCE' || l.match_status === 'BOOKS_ONLY') return Math.abs(l.variance_cents);
  return Math.abs(l.current_cents ?? l.variance_cents ?? 0);
}

export function statementFindings(input: {
  asOf: string;
  toleranceCents: number;
  statements: StatementIn[];
  lines: StatementLineIn[];
}): DealerFinding[] {
  const linesBy = new Map<string, StatementLineIn[]>();
  for (const l of input.lines) linesBy.set(l.statement_id, [...(linesBy.get(l.statement_id) ?? []), l]);
  const out: DealerFinding[] = [];
  for (const s of input.statements) {
    if (s.kind === 'PAYOFF_QUOTE' || s.status === 'APPROVED') continue;
    const atMonthEnd = input.asOf >= monthBounds(s.statement_date).end;
    const blocking = blockingLines(linesBy.get(s.id) ?? [], input.toleranceCents).filter(
      (l) => l.match_status === 'VARIANCE' || atMonthEnd,
    );
    if (blocking.length === 0) continue;
    const variances = blocking.filter((l) => l.match_status === 'VARIANCE').length;
    const lenderOnly = blocking.filter((l) => l.match_status === 'LENDER_ONLY').length;
    const booksOnly = blocking.filter((l) => l.match_status === 'BOOKS_ONLY').length;
    const unmatched = blocking.filter((l) => l.match_status === 'UNMATCHED').length;
    const atRisk = blocking.reduce((sum, l) => sum + lineAtRisk(l), 0);
    const parts = [
      variances && `${plural(variances, 'balance difference')} over ${money(input.toleranceCents)}`,
      lenderOnly && `${plural(lenderOnly, 'unit')} only on the lender's statement`,
      booksOnly && `${plural(booksOnly, 'note')} only in Books`,
      unmatched && `${plural(unmatched, 'line')} not matched yet`,
    ].filter(Boolean);
    const kindLabel = (STATEMENT_KIND[s.kind] ?? 'statement').toLowerCase();
    out.push({
      control: 'DL-8',
      kind: variances ? 'variance' : 'unresolved',
      dedupKey: `DL-8:${s.id}`,
      severity: 'HIGH',
      amountAtRiskCents: atRisk,
      title: `Lender ${kindLabel} not reconciled: ${s.line_name} · ${dateLabel(s.statement_date)} · ${plural(blocking.length, 'open line')} (${money(atRisk)})`,
      reason: `The ${dateLabel(s.statement_date)} ${kindLabel} for "${s.line_name}" has ${parts.join(', ')}. The reconciliation can't be prepared until each is resolved, and the close item "Lender reconciliation signed for every active line" stays open.`,
      question: 'Resolve each open line (match it, record the sale, or explain the difference), then prepare the reconciliation for a second person to approve.',
      href: dealerLinks.lenderStatement(s.id),
      subjects: { statement_id: s.id, line_id: s.line_id },
      subjectTable: 'lender_statements',
      subjectId: s.id,
      facts: { variances, lender_only: lenderOnly, books_only: booksOnly, unmatched, statement_date: s.statement_date },
    });
  }
  return out;
}

async function collect(c: ClientScan): Promise<DealerFinding[]> {
  const stRes = await fetchAll<Record<string, unknown>>(
    () =>
      c.db
        .from('lender_statements')
        .select('id, line_id, kind, statement_date, status')
        .eq('org_id', c.orgId)
        .eq('location_id', c.locationId)
        .in('status', ['IMPORTED', 'MATCHING', 'PREPARED']),
    { label: 'DL-8 statements' },
  );
  if (stRes.error) readFail('Lender statements lookup failed', stRes.error);
  const raw = (stRes.data ?? []) as unknown as Array<{ id: string; line_id: string; kind: StatementKind; statement_date: string; status: StatementStatus }>;
  const statements = raw.filter((s) => s.kind !== 'PAYOFF_QUOTE');
  if (statements.length === 0) return [];
  const lineIds = [...new Set(statements.map((s) => s.line_id))];
  const namesRes = await c.db.from('floor_plan_lines').select('id, name').eq('org_id', c.orgId).in('id', lineIds);
  if (namesRes.error) readFail('Floor-plan lines lookup failed', namesRes.error);
  const names = new Map(((namesRes.data ?? []) as Array<{ id: string; name: string }>).map((l) => [l.id, l.name]));
  const linesRes = await fetchAllIn<Record<string, unknown>>(
    statements.map((s) => s.id),
    (chunk) =>
      c.db
        .from('lender_statement_lines')
        .select('id, statement_id, match_status, variance_cents, current_cents')
        .eq('org_id', c.orgId)
        .in('statement_id', chunk)
        .in('match_status', ['UNMATCHED', 'VARIANCE', 'LENDER_ONLY', 'BOOKS_ONLY']),
    { label: 'DL-8 statement lines' },
  );
  if (linesRes.error) readFail('Statement lines lookup failed', linesRes.error);
  return statementFindings({
    asOf: c.asOf,
    toleranceCents: c.settings.statement_tolerance_cents,
    statements: statements.map((s) => ({ ...s, line_name: names.get(s.line_id) ?? 'Floor-plan line' })),
    lines: (linesRes.data ?? []).map((l) => ({
      id: l.id as string,
      statement_id: l.statement_id as string,
      match_status: l.match_status as StatementMatchStatus,
      variance_cents: Number(l.variance_cents ?? 0),
      current_cents: l.current_cents == null ? null : Number(l.current_cents),
    })),
  });
}

export const STATEMENT_VARIANCE_DETECTOR: DealerDetectorDef = {
  key: 'dealer_statement_variance',
  feature: DEALER_FEATURES.STATEMENT_VARIANCE,
  control: 'DL-8',
  label: 'Lender statement variance',
  collect,
};

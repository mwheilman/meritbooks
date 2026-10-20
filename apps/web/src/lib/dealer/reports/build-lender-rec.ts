/**
 * R8 Lender reconciliation — pure builder.
 *
 * For each lender statement / floor check in the period, by line: status, who
 * prepared and approved it and when, the lender's principal (statement footer) vs
 * Books principal reconstructed from the match snapshot, the difference, open items,
 * and for floor checks the sold-and-unpaid findings and how fast they were cleared
 * (latest resolution − statement date). Variance lines are listed under their
 * statement with the recorded resolution.
 */

import type { StatementKind, StatementMatchStatus, StatementStatus } from '@/lib/dealer/types';
import { STATEMENT_KIND, STATEMENT_MATCH, STATEMENT_STATUS } from '@/lib/dealer/ui/labels';
import { dealerLinks } from '@/lib/dealer/ui/links';
import { diffDays } from '@/lib/dealer/dates';
import type { DealerReport, DealerReportColumn, DealerReportRow } from './catalog';
import { makeReport } from './build-floor-plan';
import { isoLabel, row, spacer } from './model';

export interface RecStatementIn {
  id: string;
  line_id: string;
  kind: StatementKind;
  statement_date: string;
  status: StatementStatus;
  prepared_by: string | null;
  prepared_at: string | null;
  approved_by: string | null;
  approved_at: string | null;
  footer_principal_cents: number | null;
}

export interface RecLineIn {
  id: string;
  statement_id: string;
  line_number: number | null;
  lender_invoice_number: string | null;
  serial_number: string | null;
  current_cents: number | null;
  variance_cents: number;
  match_status: StatementMatchStatus;
  matched_note_id: string | null;
  sau_flag: boolean;
  resolution: string | null;
  resolved_at: string | null;
}

export interface LenderRecInput {
  start: string;
  end: string;
  entityLabel: string;
  toleranceCents: number;
  statements: RecStatementIn[];
  lines: RecLineIn[];
  lineNames: Map<string, string>;
  /** Clerk user id → display name (best-effort). */
  userNames: Map<string, string>;
}

export const LENDER_REC_COLUMNS: DealerReportColumn[] = [
  { key: 'status', label: 'Status', kind: 'text' },
  { key: 'preparedBy', label: 'Prepared by', kind: 'text' },
  { key: 'prepared', label: 'Prepared', kind: 'date' },
  { key: 'approvedBy', label: 'Approved by', kind: 'text' },
  { key: 'approved', label: 'Approved', kind: 'date' },
  { key: 'lender', label: 'Lender principal', kind: 'money' },
  { key: 'books', label: 'Books principal', kind: 'money' },
  { key: 'difference', label: 'Difference', kind: 'money' },
  { key: 'open', label: 'Open items', kind: 'count' },
  { key: 'sau', label: 'Sold-unpaid findings', kind: 'count' },
  { key: 'clearDays', label: 'Days to clear findings', kind: 'days' },
];

/** Books principal from the match snapshot: matched lines' note balance + books-only notes. */
export function booksPrincipal(lines: RecLineIn[]): number {
  let s = 0;
  for (const l of lines) {
    if (l.line_number == null && l.matched_note_id) s += l.variance_cents; // synthetic books-only row (variance = note balance)
    else if (l.matched_note_id) s += (l.current_cents ?? 0) - l.variance_cents;
  }
  return s;
}

/** What one line adds to (lender − Books): Σ over a statement's lines = lender lines total − Books principal. */
export function lineContribution(l: RecLineIn): number {
  if (l.line_number == null && l.matched_note_id) return -l.variance_cents;
  if (l.matched_note_id) return l.variance_cents;
  return l.current_cents ?? 0;
}

/** Statement total from its lines when the footer is missing. */
export function lenderPrincipal(st: RecStatementIn, lines: RecLineIn[]): number {
  if (st.footer_principal_cents != null) return st.footer_principal_cents;
  return lines.filter((l) => l.line_number != null).reduce((s, l) => s + (l.current_cents ?? 0), 0);
}

function isOpen(l: RecLineIn, tol: number): boolean {
  return (
    l.match_status === 'UNMATCHED' ||
    l.match_status === 'LENDER_ONLY' ||
    l.match_status === 'BOOKS_ONLY' ||
    (l.match_status === 'VARIANCE' && Math.abs(l.variance_cents) > tol)
  );
}

export function buildLenderRec(input: LenderRecInput): DealerReport {
  const cols = LENDER_REC_COLUMNS;
  const user = (id: string | null) => (id ? input.userNames.get(id) ?? 'A team member' : null);
  const linesBy = new Map<string, RecLineIn[]>();
  for (const l of input.lines) linesBy.set(l.statement_id, [...(linesBy.get(l.statement_id) ?? []), l]);
  const rows: DealerReportRow[] = [];
  const byLine = new Map<string, RecStatementIn[]>();
  for (const s of input.statements) if (s.kind !== 'PAYOFF_QUOTE') byLine.set(s.line_id, [...(byLine.get(s.line_id) ?? []), s]);
  const lineLabel = (id: string) => input.lineNames.get(id) ?? 'Floor-plan line';
  for (const [lineId, sts] of [...byLine.entries()].sort((a, b) => lineLabel(a[0]).localeCompare(lineLabel(b[0])))) {
    if (rows.length) rows.push(spacer(cols));
    rows.push(row('section', lineLabel(lineId), cols, {}, { href: dealerLinks.lenderStatements({ lineId }) }));
    for (const st of [...sts].sort((a, b) => b.statement_date.localeCompare(a.statement_date))) {
      const lines = linesBy.get(st.id) ?? [];
      const lender = lenderPrincipal(st, lines);
      const books = booksPrincipal(lines);
      const sau = lines.filter((l) => l.sau_flag);
      let clearDays: number | null = null;
      if (st.kind === 'AUDIT' && sau.length && sau.every((l) => l.resolved_at)) {
        const last = sau.map((l) => (l.resolved_at as string).slice(0, 10)).sort().pop() as string;
        clearDays = Math.max(0, diffDays(st.statement_date, last));
      }
      rows.push(
        row('account', `${isoLabel(st.statement_date)} · ${STATEMENT_KIND[st.kind] ?? st.kind}`, cols, {
          status: STATEMENT_STATUS[st.status]?.label ?? st.status,
          preparedBy: user(st.prepared_by),
          prepared: st.prepared_at ? st.prepared_at.slice(0, 10) : null,
          approvedBy: user(st.approved_by),
          approved: st.approved_at ? st.approved_at.slice(0, 10) : null,
          lender,
          books,
          difference: lender - books,
          open: lines.filter((l) => isOpen(l, input.toleranceCents)).length,
          sau: st.kind === 'AUDIT' ? sau.length : null,
          clearDays,
        }, { indent: 1, href: dealerLinks.lenderStatement(st.id), ...(st.status !== 'APPROVED' ? { tone: 'warning' as const } : {}) }),
      );
      const exceptions = lines.filter((l) => l.match_status !== 'MATCHED' && (l.match_status !== 'VARIANCE' || l.variance_cents !== 0));
      for (const l of exceptions) {
        const who = l.serial_number ? `Serial ${l.serial_number}` : l.lender_invoice_number ? `Invoice ${l.lender_invoice_number}` : 'Line';
        const status = STATEMENT_MATCH[l.match_status]?.label ?? l.match_status;
        const resolution = l.resolution ? ` — ${l.resolution}` : '';
        rows.push(
          row('account', `${who} · ${status}${l.sau_flag ? ' · coded sold-unpaid' : ''}${resolution}`, cols, {
            difference: lineContribution(l),
            open: isOpen(l, input.toleranceCents) ? 1 : 0,
          }, { indent: 2, ...(l.matched_note_id ? { href: dealerLinks.note(l.matched_note_id) } : {}) }),
        );
      }
    }
  }
  const notes = [
    'Books principal is reconstructed from the match snapshot: the Books balance of every matched note plus notes Books carries that the lender did not list. Difference = lender principal − Books principal.',
    'Open items are lines still blocking the reconciliation (unmatched, lender-only, Books-only, or a balance difference over the statement tolerance). Days to clear findings = the last resolution of a sold-unpaid line on a floor check less the floor-check date.',
    'Line-level rows show the difference each exception contributes; they explain the statement row and are not added to it.',
  ];
  return makeReport('dealer_lender_rec', input.entityLabel, { start: input.start, end: input.end }, cols, rows, notes);
}

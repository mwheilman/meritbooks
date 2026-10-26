/**
 * The Conversion Certificate's five ties (spec §10.3 / §10.7, part 1): trial balance,
 * receivables, payables, bank and equity — each "old books minus new books = 0" — and the
 * gate that decides whether the preparer may sign. PURE: the service gathers the figures
 * from the staged source and the LIVE book of record (posted GL, open invoices / bills).
 *
 * Evidence: a tie is "evidenced" when an outside document backs the source side (a bank
 * statement / reconciliation, an aging report), "internal only" when the source side is
 * only the old ledger itself. Internal-only ties don't block; they print on the certificate.
 * A difference blocks — except a data-quality finding the preparer chose to CARRY as one
 * reconciling item (PF-01 / PF-02), which is shown as its own line and must match exactly.
 */

import type { CertificateGate, CertificateTie, TieLine, TieStatus } from './types';
import { dollars, longDate, plural } from './format';

export interface TbTieInput {
  /** The opening entry has posted (the MeritBooks side exists). */
  posted: boolean;
  /** Per account: source (mapped opening) vs MeritBooks (posted GL), debit-positive. */
  lines: ReadonlyArray<{ label: string; sourceCents: number; meritCents: number }>;
  sourceDebitCents: number;
  sourceCreditCents: number;
  /** Assets − (liabilities + equity) on the source side. */
  identityDiffCents: number;
  /** Open income-statement balances (mid-year cutover) and whether a person acknowledged them. */
  plNetCents: number;
  plAcknowledged: boolean;
}

export interface SubledgerTieInput {
  /** Source aging total (dropped / pulled aging report); null = no aging staged. */
  sourceAgingCents: number | null;
  /** Source control account balance at cutover (absolute). */
  sourceControlCents: number;
  /** MeritBooks open items loaded (Σ open balance). */
  meritSubledgerCents: number;
  /** MeritBooks control account (posted GL, absolute). */
  meritControlCents: number;
  /** A data-quality difference carried as one reconciling item (PF-01 / PF-02), absolute. */
  carriedCents: number;
  /** The aging came from an outside report (vs. the ledger's own list). */
  evidenced: boolean;
}

export interface BankTieInput {
  label: string;
  /** Statement / reconciled balance, minus outstanding items (the book balance it implies). */
  evidenceCents: number | null;
  sourceGlCents: number;
  meritGlCents: number;
}

export interface EquityTieInput {
  /** Source equity at cutover (credit-positive), incl. open P&L when mid-year. */
  sourceCents: number;
  /** MeritBooks equity (credit-positive), incl. open P&L when mid-year. */
  meritCents: number;
  /** Prior-year roll-forward check, when last year's closing figures were staged. */
  rollForward: { expectedRetainedEarningsCents: number; retainedEarningsCents: number } | null;
}

export interface TieInputs {
  asOf: string;
  tb: TbTieInput;
  ar: SubledgerTieInput;
  ap: SubledgerTieInput;
  bank: ReadonlyArray<BankTieInput>;
  equity: EquityTieInput;
}

const line = (label: string, sourceCents: number, meritCents: number): TieLine => ({
  label,
  sourceCents,
  meritCents,
  differenceCents: sourceCents - meritCents,
});

function tbTie(i: TbTieInput, asOf: string): CertificateTie {
  const balanced = i.sourceDebitCents === i.sourceCreditCents;
  const diffs = i.lines.filter((l) => l.sourceCents !== l.meritCents);
  // Only the accounts that differ are listed (the rest are zero by definition), capped at 25.
  const lines: TieLine[] = diffs.slice(0, 25).map((l) => line(l.label, l.sourceCents, l.meritCents));
  let status: TieStatus = 'tied';
  let summary = `All accounts tie at ${longDate(asOf)} · ${plural(i.lines.length, 'account')}`;
  if (!i.posted) {
    status = 'waiting';
    summary = 'The opening entry hasn’t posted yet, so there is no MeritBooks side to compare.';
  } else if (!balanced) {
    status = 'difference';
    summary = `The source trial balance is out of balance by ${dollars(Math.abs(i.sourceDebitCents - i.sourceCreditCents))}.`;
  } else if (diffs.length > 0) {
    status = 'difference';
    const total = diffs.reduce((s, l) => s + Math.abs(l.sourceCents - l.meritCents), 0);
    summary = `${plural(diffs.length, 'account')} differ by ${dollars(total)} between the old books and MeritBooks.`;
  } else if (i.plNetCents !== 0 && !i.plAcknowledged) {
    status = 'difference';
    summary = `${dollars(Math.abs(i.plNetCents))} of profit or loss is still open on the income statement — confirm a mid-year cutover in the opening review.`;
  } else if (i.identityDiffCents !== i.plNetCents) {
    status = 'difference';
    summary = `Assets don’t equal liabilities plus equity by ${dollars(Math.abs(i.identityDiffCents - i.plNetCents))}.`;
  }
  return { key: 'tb', label: 'Trial balance', status, summary, lines: i.posted ? lines : [], evidence: 'internal_only' };
}

function subledgerTie(key: 'ar' | 'ap', i: SubledgerTieInput, asOf: string): CertificateTie {
  const noun = key === 'ar' ? 'Receivables' : 'Payables';
  const items = key === 'ar' ? 'open invoices' : 'open bills';
  const lines: TieLine[] = [];
  const nothing = i.sourceControlCents === 0 && i.meritControlCents === 0 && (i.sourceAgingCents ?? 0) === 0 && i.meritSubledgerCents === 0;
  if (nothing) {
    return { key, label: noun, status: 'not_applicable', summary: `No ${items} at ${longDate(asOf)}.`, lines, evidence: 'not_applicable' };
  }
  if (i.sourceAgingCents !== null) lines.push(line(`Source aging → MeritBooks ${items}`, i.sourceAgingCents, i.meritSubledgerCents));
  lines.push(line(`Source control → MeritBooks control`, i.sourceControlCents, i.meritControlCents));
  lines.push(line(`MeritBooks ${items} + carried item → MeritBooks control`, i.meritSubledgerCents + i.carriedCents, i.meritControlCents));
  let status: TieStatus = 'tied';
  let summary = `${noun} tie: ${dollars(i.meritSubledgerCents)} in ${items}${i.carriedCents ? ` plus ${dollars(i.carriedCents)} carried as one reconciling item` : ''} = the control account.`;
  if (i.meritControlCents !== 0 && i.meritSubledgerCents === 0 && i.carriedCents === 0) {
    status = 'waiting';
    summary = `The control account carries ${dollars(i.meritControlCents)} but no ${items} are loaded yet — load the aging.`;
  } else if (lines.some((l) => l.differenceCents !== 0)) {
    status = 'difference';
    const worst = lines.reduce((m, l) => Math.max(m, Math.abs(l.differenceCents)), 0);
    summary = `${noun} are off by ${dollars(worst)}.`;
  }
  return { key, label: noun, status, summary, lines, evidence: i.sourceAgingCents !== null && i.evidenced ? 'evidenced' : 'internal_only' };
}

function bankTie(rows: ReadonlyArray<BankTieInput>): CertificateTie {
  if (rows.length === 0) {
    return { key: 'bank', label: 'Bank', status: 'not_applicable', summary: 'No bank accounts at the cutover.', lines: [], evidence: 'not_applicable' };
  }
  const lines: TieLine[] = [];
  let evidenced = 0;
  for (const r of rows) {
    lines.push(line(`${r.label} · old books → MeritBooks`, r.sourceGlCents, r.meritGlCents));
    if (r.evidenceCents !== null) {
      evidenced++;
      lines.push(line(`${r.label} · statement after outstanding items → MeritBooks`, r.evidenceCents, r.meritGlCents));
    }
  }
  const off = lines.filter((l) => l.differenceCents !== 0);
  const status: TieStatus = off.length > 0 ? 'difference' : 'tied';
  const summary = off.length > 0
    ? `${plural(off.length, 'bank figure')} differ — largest ${dollars(off.reduce((m, l) => Math.max(m, Math.abs(l.differenceCents)), 0))}.`
    : evidenced === rows.length
      ? `${plural(rows.length, 'bank account')} tie to the statements.`
      : `${plural(rows.length, 'bank account')} tie to the old books; ${evidenced} of ${rows.length} backed by a statement.`;
  return { key: 'bank', label: 'Bank', status, summary, lines, evidence: evidenced === rows.length ? 'evidenced' : 'internal_only' };
}

function equityTie(i: EquityTieInput): CertificateTie {
  const lines: TieLine[] = [line('Total equity · old books → MeritBooks', i.sourceCents, i.meritCents)];
  if (i.rollForward) lines.push(line('Retained earnings roll-forward (last year + net income)', i.rollForward.expectedRetainedEarningsCents, i.rollForward.retainedEarningsCents));
  const off = lines.filter((l) => l.differenceCents !== 0);
  return {
    key: 'equity',
    label: 'Equity',
    status: off.length > 0 ? 'difference' : 'tied',
    summary: off.length > 0 ? `Equity is off by ${dollars(Math.abs(off[0].differenceCents))}.` : `Equity ties at ${dollars(i.meritCents)}.`,
    lines,
    evidence: i.rollForward ? 'evidenced' : 'internal_only',
  };
}

/** The five ties, in certificate order. */
export function computeTies(input: TieInputs): CertificateTie[] {
  return [tbTie(input.tb, input.asOf), subledgerTie('ar', input.ar, input.asOf), subledgerTie('ap', input.ap, input.asOf), bankTie(input.bank), equityTie(input.equity)];
}

export interface GateInputs {
  ties: ReadonlyArray<CertificateTie>;
  openBlockers: number;
  openBlockerCents: number;
  undecidedWarnings: number;
  unmatchedBalanceAccounts: number;
  unmatchedBalanceCents: number;
  typeGuardWithoutReason: number;
  preparerUserId: string | null;
  reviewerUserId: string | null;
  actorUserId: string;
}

/** Can the preparer sign the balance proof? Every reason it can't, in dollars. */
export function proofGate(g: GateInputs): CertificateGate {
  const blockers: string[] = [];
  if (g.openBlockers > 0) blockers.push(`${plural(g.openBlockers, 'data-quality blocker')} still open (${dollars(g.openBlockerCents)}). Fix in the source or carry as a reconciling item.`);
  if (g.undecidedWarnings > 0) blockers.push(`${plural(g.undecidedWarnings, 'data-quality warning')} need a decision.`);
  if (g.unmatchedBalanceAccounts > 0) blockers.push(`${plural(g.unmatchedBalanceAccounts, 'account')} with ${dollars(g.unmatchedBalanceCents)} of balance aren’t matched.`);
  if (g.typeGuardWithoutReason > 0) blockers.push(`${plural(g.typeGuardWithoutReason, 'match')} across account types need a typed reason.`);
  for (const t of g.ties) {
    if (t.status === 'difference' || t.status === 'waiting') blockers.push(`${t.label}: ${t.summary}`);
  }
  if (!g.reviewerUserId) blockers.push('Name a reviewer first — someone other than the preparer signs off.');
  if (g.reviewerUserId && g.reviewerUserId === g.actorUserId) blockers.push('You are this client’s reviewer, so you can’t also sign the balance proof.');
  return { ready: blockers.length === 0, blockers };
}

/** Can this person sign off (issue) the certificate? */
export function signOffGate(opts: { status: 'prepared' | 'issued' | 'voided'; preparedBy: string; actorUserId: string; reviewerUserId: string | null; tiesStillTie: boolean }): CertificateGate {
  const blockers: string[] = [];
  if (opts.status !== 'prepared') blockers.push(opts.status === 'issued' ? 'This certificate is already signed off.' : 'This certificate was voided.');
  if (opts.actorUserId === opts.preparedBy) blockers.push('You signed the balance proof, so someone else must sign off. That’s the point of a second signature.');
  if (opts.reviewerUserId && opts.reviewerUserId !== opts.actorUserId) blockers.push('Only this client’s named reviewer can sign off.');
  if (!opts.tiesStillTie) blockers.push('The books changed since the balance proof was signed — the preparer must re-sign.');
  return { ready: blockers.length === 0, blockers };
}

/** Canonical JSON (sorted keys) — the input to the certificate / snapshot hash. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).filter((k) => obj[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

/** Next certificate number after the highest existing one ("CC-0007" → "CC-0008"). */
export function nextCertificateNumber(existing: ReadonlyArray<string>): string {
  let max = 0;
  for (const n of existing) {
    const m = /^CC-(\d+)$/.exec(n);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `CC-${String(max + 1).padStart(4, '0')}`;
}

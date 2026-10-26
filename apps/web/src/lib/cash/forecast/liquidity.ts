/**
 * Liquidity headroom + minimum-cash recommendations (FP-12, AC-CF8) — pure, advice only.
 *
 * Available on a line = min(commitment, borrowing base when known) − drawn, floored at 0.
 * Source priority per line: a cash_liquidity_lines row → a LINE_OF_CREDIT bank account (the bank's
 * available balance) → a LINE_OF_CREDIT debt instrument (original − current balance).
 *
 * Recommendations, for each company that falls below its minimum:
 *   1. transfers from companies whose projected LOW POINT is above their own minimum — largest
 *      surplus first; a donor is never taken below its own minimum (surplus = min over the horizon
 *      of closing − minimum);
 *   2. then a draw on the company's own available lines;
 *   3. the rest is uncovered.
 * Nothing here moves money.
 */

import type { ScopeForecast } from './engine';

export interface LiquidityLineRow {
  id: string;
  companyId: string;
  name: string;
  commitmentCents: number;
  borrowingBaseCents: number | null;
  drawnCents: number | null;
  instrumentId: string | null;
  asOfDate: string | null;
}

export interface LocBankAccount {
  id: string;
  companyId: string;
  name: string;
  /** Plaid: available credit on a line of credit. */
  availableCents: number | null;
  /** Plaid: balance owed. */
  currentCents: number | null;
}

export interface LocInstrument {
  id: string;
  companyId: string | null;
  name: string;
  originalCents: number;
  currentBalanceCents: number;
}

export interface AvailableLine {
  key: string;
  companyId: string;
  name: string;
  commitmentCents: number | null;
  borrowingBaseCents: number | null;
  drawnCents: number | null;
  availableCents: number;
  source: 'CONFIGURED' | 'BANK_FEED' | 'DEBT_REGISTER';
}

export function availableLines(rows: readonly LiquidityLineRow[], banks: readonly LocBankAccount[], instruments: readonly LocInstrument[]): AvailableLine[] {
  const out: AvailableLine[] = [];
  const coveredInstruments = new Set<string>();
  const configuredCompanies = new Set<string>();
  for (const r of rows) {
    const inst = r.instrumentId ? instruments.find((i) => i.id === r.instrumentId) : undefined;
    const drawn = r.drawnCents ?? (inst ? Math.max(0, inst.currentBalanceCents) : 0);
    const cap = r.borrowingBaseCents !== null ? Math.min(r.commitmentCents, r.borrowingBaseCents) : r.commitmentCents;
    if (r.instrumentId) coveredInstruments.add(r.instrumentId);
    configuredCompanies.add(r.companyId);
    out.push({
      key: `line:${r.id}`,
      companyId: r.companyId,
      name: r.name,
      commitmentCents: r.commitmentCents,
      borrowingBaseCents: r.borrowingBaseCents,
      drawnCents: drawn,
      availableCents: Math.max(0, cap - drawn),
      source: 'CONFIGURED',
    });
  }
  const bankCompanies = new Set<string>();
  for (const b of banks) {
    if (configuredCompanies.has(b.companyId)) continue;
    if (b.availableCents === null || !(b.availableCents >= 0)) continue;
    bankCompanies.add(b.companyId);
    out.push({
      key: `bank:${b.id}`,
      companyId: b.companyId,
      name: b.name,
      commitmentCents: b.currentCents !== null ? Math.abs(b.currentCents) + b.availableCents : null,
      borrowingBaseCents: null,
      drawnCents: b.currentCents !== null ? Math.abs(b.currentCents) : null,
      availableCents: Math.max(0, b.availableCents),
      source: 'BANK_FEED',
    });
  }
  for (const i of instruments) {
    if (!i.companyId || coveredInstruments.has(i.id) || configuredCompanies.has(i.companyId) || bankCompanies.has(i.companyId)) continue;
    out.push({
      key: `debt:${i.id}`,
      companyId: i.companyId,
      name: i.name,
      commitmentCents: i.originalCents,
      borrowingBaseCents: null,
      drawnCents: Math.max(0, i.currentBalanceCents),
      availableCents: Math.max(0, i.originalCents - Math.max(0, i.currentBalanceCents)),
      source: 'DEBT_REGISTER',
    });
  }
  return out;
}

export function availableByCompany(lines: readonly AvailableLine[], movement?: ReadonlyMap<string, number>): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of lines) m.set(l.companyId, (m.get(l.companyId) ?? 0) + l.availableCents);
  if (movement) for (const [c, v] of movement) m.set(c, Math.max(0, (m.get(c) ?? 0) - v));
  return m;
}

export interface Recommendation {
  companyId: string;
  companyName: string;
  firstBreachDate: string;
  firstBreachWeek: number;
  shortfallCents: number;
  transfers: Array<{ fromCompanyId: string; fromName: string; cents: number; byDate: string }>;
  lineDrawCents: number;
  uncoveredCents: number;
  summary: string;
}

function usd(c: number): string {
  const sign = c < 0 ? '−' : '';
  return `${sign}$${Math.round(Math.abs(c) / 100).toLocaleString('en-US')}`;
}

export function recommend(scopes: readonly ScopeForecast[], available: ReadonlyMap<string, number>): Recommendation[] {
  // Donor capacity: the lowest projected headroom over its own minimum (never below it).
  const capacity = new Map<string, number>();
  for (const s of scopes) {
    if (s.firstBreach) continue;
    const lows = [s.openingCents, ...s.weeks.map((w) => w.closingCents)];
    const surplus = Math.min(...lows) - Math.max(0, s.minimumCents);
    if (surplus > 0) capacity.set(s.scopeId, surplus);
  }
  const lineLeft = new Map(available);
  const out: Recommendation[] = [];
  const breaching = scopes.filter((s) => s.firstBreach).sort((a, b) => (a.firstBreach!.date < b.firstBreach!.date ? -1 : 1));
  for (const s of breaching) {
    const need = s.maxShortfallCents;
    let left = need;
    const transfers: Recommendation['transfers'] = [];
    const donors = scopes
      .filter((d) => d.scopeId !== s.scopeId && (capacity.get(d.scopeId) ?? 0) > 0)
      .sort((a, b) => (capacity.get(b.scopeId) ?? 0) - (capacity.get(a.scopeId) ?? 0));
    for (const d of donors) {
      if (left <= 0) break;
      const cap = capacity.get(d.scopeId) ?? 0;
      const take = Math.min(cap, left);
      if (take <= 0) continue;
      transfers.push({ fromCompanyId: d.scopeId, fromName: d.name, cents: take, byDate: s.firstBreach!.date });
      capacity.set(d.scopeId, cap - take);
      left -= take;
    }
    const line = Math.min(Math.max(0, left), lineLeft.get(s.scopeId) ?? 0);
    lineLeft.set(s.scopeId, (lineLeft.get(s.scopeId) ?? 0) - line);
    left -= line;
    const parts: string[] = [];
    if (transfers.length) parts.push(transfers.map((t) => `move ${usd(t.cents)} from ${t.fromName}`).join(', '));
    if (line > 0) parts.push(`draw ${usd(line)} on the line`);
    if (left > 0) parts.push(`${usd(left)} still uncovered`);
    out.push({
      companyId: s.scopeId,
      companyName: s.name,
      firstBreachDate: s.firstBreach!.date,
      firstBreachWeek: s.firstBreach!.weekIndex + 1,
      shortfallCents: need,
      transfers,
      lineDrawCents: line,
      uncoveredCents: Math.max(0, left),
      summary: `${s.name} drops ${usd(need)} below its ${usd(s.minimumCents)} minimum by week ${s.firstBreach!.weekIndex + 1}: ${parts.join('; ') || 'no action found'}.`,
    });
  }
  return out;
}

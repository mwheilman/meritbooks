/**
 * Flux drivers (FPB-financial-reports §5 A-3E.2) — pure, deterministic.
 *
 * Given the posted GL lines behind one flux line, rank what moved it:
 *   • LARGEST           the three largest lines this month (by |effect|);
 *   • NEW_COUNTERPARTY  a vendor / customer with activity this month and none in the prior
 *                       three months (or the comparison month);
 *   • ONE_OFF           a line ≥ 25% of the change whose counterparty / memo signature was
 *                       not seen in the prior three months, and not from a recurring source
 *                       (recurring JEs, schedules, depreciation);
 *   • RECLASS           a manual / adjusting entry whose legs all sit on the same statement
 *                       and touch no bank account (money moved between accounts, not in/out).
 * plus the counterparty decomposition of the change (current vs comparison by vendor/customer).
 *
 * Every driver carries a citation ref ("L1", "L2", …) — the only ids an AI draft may cite.
 */

import type { CounterpartyDelta, DriverTag, FluxDriver, FluxDrivers } from './types';

export interface DriverLineInput {
  glLineId: string;
  glEntryId: string;
  entryNumber: string | null;
  entryDate: string;
  periodKey: string;
  memo: string | null;
  sourceModule: string | null;
  entryType: string | null;
  counterparty: string | null;
  /** Debit − credit of this line (the caller's sign is applied here). */
  netDebitCents: number;
  /** Shape of the whole entry this line belongs to. */
  entryAllSameStatement: boolean;
  entryTouchesCash: boolean;
}

export interface RankDriversInput {
  /** +1 for a debit-normal account, −1 for credit-normal. */
  sign: 1 | -1;
  /** Lines in the closing month. */
  current: DriverLineInput[];
  /** Lines in the comparison month (for the counterparty decomposition). */
  comparison: DriverLineInput[];
  /** Lines in the three months before the closing month (for new / one-off detection). */
  prior: DriverLineInput[];
  /** The flux line's change (normal-signed), for the one-off share test. */
  changeCents: number;
  /** Max driver lines returned. */
  limit?: number;
}

const RECURRING_SOURCES = new Set(['RECURRING', 'RECURRING_JE', 'SCHEDULE', 'DEPRECIATION', 'PAYROLL', 'LEASE', 'PREPAID', 'DEBT']);
const RECLASS_SOURCES = new Set(['MANUAL', 'JOURNAL', 'JE']);
export const NO_COUNTERPARTY = 'No counterparty (journal entries)';

/** A normalized signature for "have we seen this before": counterparty, else memo words. */
export function signatureOf(l: Pick<DriverLineInput, 'counterparty' | 'memo'>): string | null {
  if (l.counterparty) return `cp:${l.counterparty.trim().toLowerCase()}`;
  const memo = (l.memo ?? '').toLowerCase().replace(/[0-9#/.,:;\-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return memo.length >= 3 ? `memo:${memo}` : null;
}

export function isReclass(l: DriverLineInput): boolean {
  const src = (l.sourceModule ?? 'MANUAL').toUpperCase();
  const manual = RECLASS_SOURCES.has(src) || (l.entryType ?? '').toUpperCase() === 'ADJUSTING';
  return manual && l.entryAllSameStatement && !l.entryTouchesCash;
}

export function rankDrivers(input: RankDriversInput): FluxDrivers {
  const limit = input.limit ?? 8;
  const eff = (l: DriverLineInput) => input.sign * l.netDebitCents || 0;

  const priorCounterparties = new Set<string>();
  const priorSignatures = new Set<string>();
  for (const l of [...input.prior, ...input.comparison]) {
    if (l.counterparty) priorCounterparties.add(l.counterparty.trim().toLowerCase());
    const s = signatureOf(l);
    if (s) priorSignatures.add(s);
  }

  const ranked = [...input.current].sort(
    (a, b) => Math.abs(eff(b)) - Math.abs(eff(a)) || a.entryDate.localeCompare(b.entryDate) || a.glLineId.localeCompare(b.glLineId),
  );
  const oneOffFloor = Math.abs(input.changeCents) * 0.25;

  const lines: FluxDriver[] = ranked.slice(0, limit).map((l, i) => {
    const tags: DriverTag[] = [];
    const amount = eff(l);
    if (i < 3 && amount !== 0) tags.push('LARGEST');
    if (l.counterparty && !priorCounterparties.has(l.counterparty.trim().toLowerCase())) tags.push('NEW_COUNTERPARTY');
    const sig = signatureOf(l);
    const recurringSource = RECURRING_SOURCES.has((l.sourceModule ?? '').toUpperCase()) || (l.entryType ?? '').toUpperCase() === 'RECURRING';
    if (!recurringSource && sig && !priorSignatures.has(sig) && Math.abs(amount) >= oneOffFloor && amount !== 0) tags.push('ONE_OFF');
    if (isReclass(l)) tags.push('RECLASS');
    return {
      ref: `L${i + 1}`,
      glEntryId: l.glEntryId,
      glLineId: l.glLineId,
      entryNumber: l.entryNumber,
      entryDate: l.entryDate,
      memo: l.memo,
      sourceModule: l.sourceModule,
      counterparty: l.counterparty,
      amountCents: amount,
      tags,
    };
  });

  // Counterparty decomposition (current vs comparison month).
  const byCp = new Map<string, { current: number; comparison: number }>();
  for (const l of input.current) {
    const k = l.counterparty ?? NO_COUNTERPARTY;
    const v = byCp.get(k) ?? { current: 0, comparison: 0 };
    v.current += eff(l);
    byCp.set(k, v);
  }
  for (const l of input.comparison) {
    const k = l.counterparty ?? NO_COUNTERPARTY;
    const v = byCp.get(k) ?? { current: 0, comparison: 0 };
    v.comparison += eff(l);
    byCp.set(k, v);
  }
  const counterparties: CounterpartyDelta[] = [...byCp.entries()]
    .map(([counterparty, v]) => ({
      counterparty,
      currentCents: v.current,
      comparisonCents: v.comparison,
      changeCents: v.current - v.comparison,
      isNew: counterparty !== NO_COUNTERPARTY && v.current !== 0 && !priorCounterparties.has(counterparty.trim().toLowerCase()),
    }))
    .filter((c) => c.changeCents !== 0)
    .sort((a, b) => Math.abs(b.changeCents) - Math.abs(a.changeCents) || a.counterparty.localeCompare(b.counterparty))
    .slice(0, 6);

  return {
    lines,
    counterparties,
    activityCents: input.current.reduce((s, l) => s + eff(l), 0),
    lineCount: input.current.length,
  };
}

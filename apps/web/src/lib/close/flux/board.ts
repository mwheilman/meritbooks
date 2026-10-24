/**
 * Flux board assembly — pure glue between the computed lines, their drivers, the
 * stored explanations and the waiver. Produces exactly what the Flux review screen and
 * the close gate consume. No IO (the loader in ./load.ts feeds it), so the end-to-end
 * "material line → explained → reviewed → gate passes" path is unit-testable.
 */

import { computeFluxLines, lineKeyFor, shiftPeriod, statementOf, type ActivityCell } from './compute';
import { rankDrivers, type DriverLineInput } from './drivers';
import { carryForwardSuggestion, lineStatus } from './explanations';
import { evaluateFluxGate } from './gate';
import { normalBalanceFor } from '@/lib/posting/account-direction';
import type {
  FluxAccount,
  FluxBoardLine,
  FluxBoardSummary,
  FluxCloseSignal,
  FluxExplanation,
  FluxPolicy,
  FluxWaiver,
} from './types';

/** A posted GL line with its account + dimensions (drivers need the detail). */
export interface DetailLine extends DriverLineInput {
  accountId: string;
  departmentId: string | null;
  classId: string | null;
}

export interface AssembleInput {
  periodKey: string;
  accounts: FluxAccount[];
  policy: FluxPolicy;
  activity: ActivityCell[];
  closingBalanceDebit: Map<string, number>;
  budget?: Map<string, number> | null;
  dimensionNames?: Map<string, string>;
  /** Detail lines for the closing month, the comparison month and the 3 months before. */
  detail: DetailLine[];
  /** Explanations stored for the closing month. */
  explanations: FluxExplanation[];
  /** Submitted explanations for the 3 prior months (carry-forward). */
  history: FluxExplanation[];
  waiver: FluxWaiver | null;
}

export interface AssembleResult {
  lines: FluxBoardLine[];
  summary: FluxBoardSummary;
  gate: FluxCloseSignal;
}

/** Aggregate detail lines into activity cells (one per account × dims × month). */
export function activityFromDetail(detail: Array<Pick<DetailLine, 'accountId' | 'departmentId' | 'classId' | 'periodKey' | 'netDebitCents'>>): ActivityCell[] {
  const map = new Map<string, ActivityCell>();
  for (const d of detail) {
    const k = `${d.accountId}|${d.departmentId ?? ''}|${d.classId ?? ''}|${d.periodKey}`;
    const cell = map.get(k);
    if (cell) cell.netDebitCents += d.netDebitCents;
    else map.set(k, { accountId: d.accountId, departmentId: d.departmentId, classId: d.classId, periodKey: d.periodKey, netDebitCents: d.netDebitCents });
  }
  return [...map.values()];
}

export function driverComparisonPeriod(policy: FluxPolicy, periodKey: string): string {
  return policy.comparisonBasis === 'PRIOR_YEAR_MONTH' ? shiftPeriod(periodKey, -12) : shiftPeriod(periodKey, -1);
}

export function assembleFluxBoard(input: AssembleInput): AssembleResult {
  const { lines, excludedCount } = computeFluxLines(input);
  const acct = new Map(input.accounts.map((a) => [a.id, a]));
  const cmpPeriod = driverComparisonPeriod(input.policy, input.periodKey);
  const priorPeriods = new Set([1, 2, 3].map((n) => shiftPeriod(input.periodKey, -n)));

  // Detail grouped by flux line key.
  const byKey = new Map<string, { current: DetailLine[]; comparison: DetailLine[]; prior: DetailLine[] }>();
  for (const d of input.detail) {
    const a = acct.get(d.accountId);
    if (!a) continue;
    const key = lineKeyFor(a.id, statementOf(a.type), input.policy.dimension, d.departmentId, d.classId);
    const g = byKey.get(key) ?? { current: [], comparison: [], prior: [] };
    if (d.periodKey === input.periodKey) g.current.push(d);
    if (d.periodKey === cmpPeriod) g.comparison.push(d);
    if (priorPeriods.has(d.periodKey)) g.prior.push(d);
    byKey.set(key, g);
  }

  const explByKey = new Map(input.explanations.map((e) => [e.lineKey, e]));
  const historyByKey = new Map<string, FluxExplanation[]>();
  for (const h of input.history) historyByKey.set(h.lineKey, [...(historyByKey.get(h.lineKey) ?? []), h]);

  const boardLines: FluxBoardLine[] = lines.map((line) => {
    const a = acct.get(line.accountId)!;
    const sign: 1 | -1 = normalBalanceFor(a.type, a.subType) === 'DEBIT' ? 1 : -1;
    const g = byKey.get(line.lineKey) ?? { current: [], comparison: [], prior: [] };
    const drivers = rankDrivers({ sign, current: g.current, comparison: g.comparison, prior: g.prior, changeCents: line.changeCents });
    const explanation = explByKey.get(line.lineKey) ?? null;
    const status = lineStatus(explanation, line.changeCents);
    const wantsSuggestion = !explanation || (explanation.status === 'DRAFT' && !explanation.explanation);
    const suggestion = wantsSuggestion ? carryForwardSuggestion(historyByKey.get(line.lineKey) ?? [], input.periodKey) : null;
    return { ...line, status, explanation, suggestion, drivers, driverComparisonPeriod: cmpPeriod };
  });

  const material = boardLines.filter((l) => l.material);
  const count = (st: FluxBoardLine['status']) => material.filter((l) => l.status === st).length;
  const summary: FluxBoardSummary = {
    totalLines: boardLines.length,
    material: material.length,
    unexplained: count('UNEXPLAINED'),
    draft: count('DRAFT'),
    explained: count('EXPLAINED'),
    reviewed: count('REVIEWED'),
    stale: count('STALE'),
    excluded: excludedCount,
  };
  const gate = evaluateFluxGate({
    reviewRequired: input.policy.reviewRequired,
    materialStatuses: material.map((l) => l.status),
    waiver: input.waiver,
  });
  return { lines: boardLines, summary, gate };
}

/**
 * Flux review → close package / board pack (FPB-financial-reports §5 A-3E.5) — pure.
 *
 * `buildFluxPackageSection(board)` is the seam the packs slice calls to drop the month's
 * flux commentary into a close package or board pack: one row per material (or explained)
 * line with the figures, the explanation, its category, who prepared and reviewed it, and
 * the waiver if the review was overridden. `fluxCsv(board)` is the CSV export.
 */

import { formatMoney } from '@meritbooks/shared';
import { BASIS_LABEL, CATEGORY_LABEL, type FluxBoard, type FluxBoardLine } from './types';
import { describeThreshold } from './materiality';
import { fluxChangeLabel } from './change-label';

export interface FluxPackageRow {
  account: string;
  dimension: string | null;
  statement: 'P&L' | 'Balance sheet';
  currentCents: number;
  comparisonCents: number;
  changeCents: number;
  changePct: string;
  basis: string;
  threshold: string;
  status: string;
  category: string | null;
  explanation: string | null;
  preparedBy: string | null;
  reviewedBy: string | null;
}

export interface FluxPackageSection {
  title: string;
  company: string;
  period: string;
  summary: string;
  waiver: { reason: string; by: string | null; at: string | null } | null;
  rows: FluxPackageRow[];
}

const STATUS_WORD: Record<FluxBoardLine['status'], string> = {
  UNEXPLAINED: 'Unexplained',
  DRAFT: 'Draft',
  EXPLAINED: 'Awaiting review',
  REVIEWED: 'Reviewed',
  STALE: 'Numbers moved — re-explain',
};

export function pctText(l: { changePctBps: number | null; currentCents: number; comparisonCents: number }): string {
  return fluxChangeLabel(l.changePctBps, l.currentCents, l.comparisonCents, { signed: false });
}

export function buildFluxPackageSection(board: FluxBoard): FluxPackageSection {
  const who = (id: string | null | undefined) => (id ? board.names[id] ?? 'A teammate' : null);
  const rows = board.lines
    .filter((l) => l.material || (l.explanation && l.explanation.status !== 'DRAFT'))
    .map<FluxPackageRow>((l) => ({
      account: `${l.accountNumber} ${l.accountName}`,
      dimension: l.dimensionLabel,
      statement: l.statement === 'BS' ? 'Balance sheet' : 'P&L',
      currentCents: l.currentCents,
      comparisonCents: l.comparisonCents,
      changeCents: l.changeCents,
      changePct: pctText(l),
      basis: BASIS_LABEL[l.basisUsed],
      threshold: describeThreshold(l.threshold, formatMoney),
      status: STATUS_WORD[l.status],
      category: l.explanation?.category ? CATEGORY_LABEL[l.explanation.category] : null,
      explanation: l.explanation && l.explanation.status !== 'DRAFT' ? l.explanation.explanation : null,
      preparedBy: who(l.explanation?.preparedBy),
      reviewedBy: who(l.explanation?.reviewedBy),
    }));
  const s = board.summary;
  return {
    title: 'Flux analysis',
    company: board.location.name,
    period: board.period.label,
    summary: `${s.material} material change${s.material === 1 ? '' : 's'} vs ${BASIS_LABEL[board.policy.comparisonBasis].toLowerCase()}; ${s.reviewed} reviewed, ${s.explained} awaiting review, ${s.unexplained + s.draft} unexplained${s.stale ? `, ${s.stale} need re-explaining` : ''}.`,
    waiver: board.waiver?.status === 'WAIVED' && board.waiver.reason
      ? { reason: board.waiver.reason, by: who(board.waiver.waivedBy), at: board.waiver.waivedAt }
      : null,
    rows,
  };
}

function csvCell(v: string | number | null): string {
  const s = v === null ? '' : String(v);
  // Neutralize spreadsheet formula injection, then quote.
  const safe = /^[=+\-@\t\r]/.test(s) && typeof v === 'string' ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}

const dollars = (cents: number) => (cents / 100).toFixed(2);

export function fluxCsv(board: FluxBoard): string {
  const header = ['Account', 'Dimension', 'Statement', 'Current', 'Comparison', 'Change', 'Change %', 'Basis', 'Threshold', 'Material', 'Status', 'Category', 'Explanation', 'Prepared by', 'Reviewed by'];
  const who = (id: string | null | undefined) => (id ? board.names[id] ?? id : '');
  const lines = board.lines.map((l) => [
    `${l.accountNumber} ${l.accountName}`,
    l.dimensionLabel,
    l.statement === 'BS' ? 'Balance sheet' : 'P&L',
    dollars(l.currentCents),
    dollars(l.comparisonCents),
    dollars(l.changeCents),
    pctText(l),
    BASIS_LABEL[l.basisUsed],
    describeThreshold(l.threshold, formatMoney),
    l.material ? 'Yes' : 'No',
    STATUS_WORD[l.status],
    l.explanation?.category ? CATEGORY_LABEL[l.explanation.category] : '',
    l.explanation?.explanation ?? '',
    who(l.explanation?.preparedBy),
    who(l.explanation?.reviewedBy),
  ]);
  return [header, ...lines].map((r) => r.map((c) => csvCell(c)).join(',')).join('\r\n') + '\r\n';
}

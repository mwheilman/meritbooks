/**
 * AC-3E.5 — the flux gate end to end through the pure board assembly:
 * a material line blocks; explained-but-unreviewed blocks; reviewed passes; a later move
 * (stale) blocks again; a waiver passes; "review not required" and "nothing material" pass.
 */

import { describe, it, expect } from 'vitest';
import { assembleFluxBoard, type AssembleInput, type DetailLine } from './board';
import { evaluateFluxGate, fluxSignalPasses, FLUX_SIGNAL_UNKNOWN } from './gate';
import { DEFAULT_FLUX_POLICY } from './materiality';
import type { FluxAccount, FluxExplanation } from './types';

const ACCTS: FluxAccount[] = [
  { id: 'repairs', number: '6300', name: 'Repairs', type: 'OPEX', subType: 'OPERATING_EXPENSE', groupId: null, groupName: null },
  { id: 'rent', number: '6100', name: 'Rent', type: 'OPEX', subType: 'OPERATING_EXPENSE', groupId: null, groupName: null },
];

const D = (accountId: string, periodKey: string, net: number, over: Partial<DetailLine> = {}): DetailLine => ({
  accountId, departmentId: null, classId: null, glLineId: `${accountId}-${periodKey}-${net}`, glEntryId: `e-${accountId}-${periodKey}`,
  entryNumber: null, entryDate: `${periodKey}-15`, periodKey, memo: null, sourceModule: 'BILL', entryType: 'STANDARD',
  counterparty: 'Vendor', netDebitCents: net, entryAllSameStatement: false, entryTouchesCash: false, ...over,
});

const detail = [D('repairs', '2026-10', 1_500_000, { counterparty: 'New Mech Co' }), D('repairs', '2026-09', 200_000), D('rent', '2026-10', 1_000_000), D('rent', '2026-09', 1_000_000)];
const activity = detail.map((d) => ({ accountId: d.accountId, departmentId: null, classId: null, periodKey: d.periodKey, netDebitCents: d.netDebitCents }));

const base = (over: Partial<AssembleInput> = {}): AssembleInput => ({
  periodKey: '2026-10', accounts: ACCTS, policy: DEFAULT_FLUX_POLICY, activity, closingBalanceDebit: new Map(),
  detail, explanations: [], history: [], waiver: null, ...over,
});

const X = (over: Partial<FluxExplanation>): FluxExplanation => ({
  id: 'x', locationId: 'loc', periodKey: '2026-10', lineKey: 'repairs', accountId: 'repairs', status: 'EXPLAINED',
  explanation: 'Emergency compressor replacement at the main shop.', category: 'ONE_TIME', comparisonBasis: 'PRIOR_MONTH',
  currentCents: 1_500_000, comparisonCents: 200_000, changeCents: 1_300_000, changePctBps: 65_000,
  attachmentDocumentId: null, draftedByAi: false, aiDecisionId: null, carriedFromId: null,
  preparedBy: 'prep', preparedAt: '2026-11-02T00:00:00Z', reviewedBy: null, reviewedAt: null, reviewNote: null, explanationHash: 'h', reviewedExplanationHash: null, updatedAt: null, ...over,
});

describe('flux gate through the board', () => {
  it('an unexplained material line blocks (OPEN)', () => {
    const r = assembleFluxBoard(base());
    expect(r.summary).toMatchObject({ material: 1, unexplained: 1 });
    expect(r.gate).toMatchObject({ applicable: true, status: 'OPEN', material: 1, unexplained: 1 });
    expect(fluxSignalPasses(r.gate)).toBe(false);
    const line = r.lines.find((l) => l.lineKey === 'repairs')!;
    expect(line.drivers.lines[0].tags).toContain('NEW_COUNTERPARTY');
  });

  it('explained but not reviewed still blocks', () => {
    const r = assembleFluxBoard(base({ explanations: [X({})] }));
    expect(r.gate).toMatchObject({ status: 'OPEN', explained: 1 });
  });

  it('reviewed passes (COMPLETE)', () => {
    const r = assembleFluxBoard(base({ explanations: [X({ status: 'REVIEWED', reviewedBy: 'rev', reviewedAt: '2026-11-03T00:00:00Z' })] }));
    expect(r.gate).toMatchObject({ status: 'COMPLETE', reviewed: 1 });
    expect(fluxSignalPasses(r.gate)).toBe(true);
  });

  it('a reviewed line whose numbers moved is stale and blocks again', () => {
    const r = assembleFluxBoard(base({ explanations: [X({ status: 'REVIEWED', reviewedBy: 'rev', changeCents: 300_000 })] }));
    expect(r.lines.find((l) => l.lineKey === 'repairs')!.status).toBe('STALE');
    expect(r.gate).toMatchObject({ status: 'OPEN', stale: 1 });
  });

  it('a controller waiver passes with the reason', () => {
    const r = assembleFluxBoard(base({ waiver: { status: 'WAIVED', reason: 'Owner-approved interim close', waivedBy: 'ctl', waivedAt: 'now' } }));
    expect(r.gate).toMatchObject({ status: 'WAIVED', waiverReason: 'Owner-approved interim close' });
    expect(fluxSignalPasses(r.gate)).toBe(true);
  });

  it('review not required ⇒ NOT_REQUIRED (passes, not applicable)', () => {
    const r = assembleFluxBoard(base({ policy: { ...DEFAULT_FLUX_POLICY, reviewRequired: false } }));
    expect(r.gate).toMatchObject({ applicable: false, status: 'NOT_REQUIRED' });
  });

  it('nothing material ⇒ NOTHING_MATERIAL (passes)', () => {
    const r = assembleFluxBoard(base({ policy: { ...DEFAULT_FLUX_POLICY, absThresholdCents: 99_000_000, pctThresholdBps: 999_999 } }));
    expect(r.gate.status).toBe('NOTHING_MATERIAL');
  });

  it('offers a carry-forward suggestion on an unexplained line', () => {
    const r = assembleFluxBoard(base({ history: [X({ id: 'sep', periodKey: '2026-09', category: 'TIMING', status: 'REVIEWED' })] }));
    expect(r.lines.find((l) => l.lineKey === 'repairs')!.suggestion).toMatchObject({ fromId: 'sep', category: 'TIMING' });
  });
});

describe('evaluateFluxGate / UNKNOWN', () => {
  it('UNKNOWN never passes; absent passes', () => {
    expect(fluxSignalPasses(FLUX_SIGNAL_UNKNOWN)).toBe(false);
    expect(fluxSignalPasses(null)).toBe(true);
  });
  it('waiver does not hide a fully reviewed month', () => {
    expect(evaluateFluxGate({ reviewRequired: true, materialStatuses: ['REVIEWED'], waiver: { status: 'WAIVED', reason: 'r', waivedBy: null, waivedAt: null } }).status).toBe('COMPLETE');
  });
});

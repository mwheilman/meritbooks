/** A-3E.5 — the close-package section and CSV export. */

import { describe, it, expect } from 'vitest';
import { buildFluxPackageSection, fluxCsv } from './package';
import { assembleFluxBoard } from './board';
import { DEFAULT_FLUX_POLICY } from './materiality';
import type { FluxAccount, FluxBoard } from './types';

const ACCTS: FluxAccount[] = [
  { id: 'repairs', number: '6300', name: 'Repairs', type: 'OPEX', subType: 'OPERATING_EXPENSE', groupId: null, groupName: null },
  { id: 'rent', number: '6100', name: '=HYPERLINK("x")', type: 'OPEX', subType: 'OPERATING_EXPENSE', groupId: null, groupName: null },
];

function board(): FluxBoard {
  const activity = [
    { accountId: 'repairs', departmentId: null, classId: null, periodKey: '2026-10', netDebitCents: 1_500_000 },
    { accountId: 'repairs', departmentId: null, classId: null, periodKey: '2026-09', netDebitCents: 200_000 },
    { accountId: 'rent', departmentId: null, classId: null, periodKey: '2026-10', netDebitCents: 1_000_000 },
    { accountId: 'rent', departmentId: null, classId: null, periodKey: '2026-09', netDebitCents: 1_000_000 },
  ];
  const a = assembleFluxBoard({
    periodKey: '2026-10', accounts: ACCTS, policy: DEFAULT_FLUX_POLICY, activity, closingBalanceDebit: new Map(), detail: [], history: [],
    waiver: { status: 'WAIVED', reason: 'Interim close for the lender', waivedBy: 'ctl', waivedAt: '2026-11-04T00:00:00Z' },
    explanations: [{
      id: 'x', locationId: 'loc', periodKey: '2026-10', lineKey: 'repairs', accountId: 'repairs', status: 'REVIEWED',
      explanation: 'Emergency compressor replacement.', category: 'ONE_TIME', comparisonBasis: 'PRIOR_MONTH',
      currentCents: 1_500_000, comparisonCents: 200_000, changeCents: 1_300_000, changePctBps: 65_000,
      attachmentDocumentId: null, draftedByAi: true, aiDecisionId: null, carriedFromId: null,
      preparedBy: 'prep', preparedAt: null, reviewedBy: 'rev', reviewedAt: null, reviewNote: null, explanationHash: 'h', reviewedExplanationHash: null, updatedAt: null,
    }],
  });
  return {
    period: { key: '2026-10', label: 'October 2026', year: 2026, month: 10, start: '2026-10-01', end: '2026-10-31' },
    location: { id: 'loc', name: 'Heartland' }, fiscalPeriodId: null, periodStatus: 'OPEN', editable: true,
    policy: DEFAULT_FLUX_POLICY, lines: a.lines, summary: a.summary, gate: a.gate,
    waiver: { status: 'WAIVED', reason: 'Interim close for the lender', waivedBy: 'ctl', waivedAt: '2026-11-04T00:00:00Z' },
    aiConfigured: false, names: { prep: 'Pat Preparer', rev: 'Rae Reviewer', ctl: 'Cam Controller' }, generatedAt: '',
  };
}

describe('buildFluxPackageSection', () => {
  it('carries the material lines with explanation, category, preparer, reviewer and the waiver', () => {
    const sec = buildFluxPackageSection(board());
    expect(sec).toMatchObject({ title: 'Flux analysis', company: 'Heartland', period: 'October 2026' });
    expect(sec.rows).toHaveLength(1);
    expect(sec.rows[0]).toMatchObject({
      account: '6300 Repairs', changeCents: 1_300_000, changePct: '650.0%', status: 'Reviewed', category: 'One-time',
      explanation: 'Emergency compressor replacement.', preparedBy: 'Pat Preparer', reviewedBy: 'Rae Reviewer', threshold: '$5,000.00 or 10%',
    });
    expect(sec.waiver).toEqual({ reason: 'Interim close for the lender', by: 'Cam Controller', at: '2026-11-04T00:00:00Z' });
    expect(sec.summary).toBe('1 material change vs prior month; 1 reviewed, 0 awaiting review, 0 unexplained.');
  });
});

describe('fluxCsv', () => {
  it('exports every line and neutralizes spreadsheet formulas', () => {
    const csv = fluxCsv(board());
    const rows = csv.trim().split('\r\n');
    expect(rows[0]).toContain('"Account","Dimension","Statement","Current"');
    expect(rows).toHaveLength(3);
    expect(csv).toContain('"6100 =HYPERLINK(""x"")"'); // starts with a digit → harmless, untouched
    expect(csv).toContain('"13000.00"');
    expect(csv).toContain('"Emergency compressor replacement."');
    const b = board();
    b.lines[0].explanation!.explanation = '=cmd|calc';
    expect(fluxCsv(b)).toContain(`"'=cmd|calc"`);
  });
});

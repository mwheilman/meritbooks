import { describe, it, expect } from 'vitest';
import { detectSoldOutOfTrust, type SotNote, type SotUnit } from './sot';
import { footStatement, matchStatement, blockingLines, assertApprover, type NoteForMatch } from './statement-match';
import { matchOemCredits } from './oem-match';
import { ageBucket, bucketsFromEdges, evaluateTieout } from './summary';

const unit = (id: string, extra: Partial<SotUnit> = {}): SotUnit => ({ id, serial_number: `SN-${id}`, status: 'IN_STOCK', warranty_registered_date: null, ...extra });
const note = (id: string, unitId: string, extra: Partial<SotNote> = {}): SotNote => ({
  id, unit_id: unitId, line_id: 'L1', status: 'OPEN', principal_balance_cents: 900_000, sold_date: null, payoff_due_date: null, ...extra,
});

describe('sold-out-of-trust detection (FPB V3, DL-1, AC6)', () => {
  it('Books sale past payoff + grace → CRITICAL with days since sale', () => {
    const f = detectSoldOutOfTrust({
      asOf: '2026-08-20', graceDays: 2,
      notes: [note('N1', 'U1', { status: 'SOLD_UNPAID', sold_date: '2026-08-15', payoff_due_date: '2026-08-15' })],
      units: [unit('U1', { status: 'SOLD' })], signals: [],
    });
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ severity: 'CRITICAL', detectedBy: 'BOOKS_SALE', saleMissingInBooks: false, daysSinceSale: 5, daysPastDue: 5, principalCents: 900_000, dedupKey: 'DL-1:N1' });
  });

  it('Books sale inside grace → HIGH (payoff pending)', () => {
    const f = detectSoldOutOfTrust({
      asOf: '2026-08-16', graceDays: 2,
      notes: [note('N1', 'U1', { status: 'SOLD_UNPAID', sold_date: '2026-08-15', payoff_due_date: '2026-08-15' })],
      units: [unit('U1', { status: 'SOLD' })], signals: [],
    });
    expect(f[0].severity).toBe('HIGH');
  });

  it('warranty registration with no Books sale → CRITICAL, sale missing in Books (the lender\'s own test)', () => {
    const f = detectSoldOutOfTrust({
      asOf: '2026-09-30', graceDays: 2,
      notes: [note('N1', 'U1')], units: [unit('U1', { warranty_registered_date: '2026-09-01' })], signals: [],
    });
    expect(f[0]).toMatchObject({ severity: 'CRITICAL', detectedBy: 'WARRANTY_REG', saleMissingInBooks: true, daysSinceSale: 29, earliestSaleDate: '2026-09-01' });
  });

  it('a DMS deal not posted in Books → CRITICAL; earliest signal wins', () => {
    const f = detectSoldOutOfTrust({
      asOf: '2026-09-30', graceDays: 2,
      notes: [note('N1', 'U1')], units: [unit('U1', { warranty_registered_date: '2026-09-10' })],
      signals: [{ unitId: 'U1', source: 'DMS_DEAL', date: '2026-09-05', ref: 'DEAL-77' }],
    });
    expect(f[0]).toMatchObject({ detectedBy: 'DMS_DEAL', daysSinceSale: 25 });
    expect(f[0].evidence.map((e) => e.source)).toEqual(['DMS_DEAL', 'WARRANTY_REG']);
  });

  it('paid-off notes, unsold units and future-dated signals raise nothing', () => {
    const f = detectSoldOutOfTrust({
      asOf: '2026-09-30', graceDays: 2,
      notes: [note('N1', 'U1', { status: 'PAID_OFF', principal_balance_cents: 0 }), note('N2', 'U2'), note('N3', 'U3')],
      units: [unit('U1', { warranty_registered_date: '2026-09-01' }), unit('U2'), unit('U3', { warranty_registered_date: '2026-12-01' })],
      signals: [],
    });
    expect(f).toEqual([]);
  });
});

describe('lender statement reconciliation (FPB §3.10, AC11)', () => {
  const notes: NoteForMatch[] = [
    { id: 'N1', lender_invoice_number: 'INV-100', serial_number: 'SN1', model: 'M1', original_principal_cents: 1_000_000, principal_balance_cents: 900_000, status: 'OPEN' },
    { id: 'N2', lender_invoice_number: 'INV-200', serial_number: 'SN2', model: 'M2', original_principal_cents: 500_000, principal_balance_cents: 500_000, status: 'OPEN' },
    { id: 'N3', lender_invoice_number: 'INV-300', serial_number: 'SN3', model: 'M3', original_principal_cents: 400_000, principal_balance_cents: 400_000, status: 'OPEN' },
    { id: 'N4', lender_invoice_number: 'INV-400', serial_number: 'SN4', model: 'M4', original_principal_cents: 300_000, principal_balance_cents: 300_000, status: 'OPEN' },
  ];
  const L = (id: string, o: Partial<Parameters<typeof matchStatement>[0]['lines'][number]>) => ({
    id, lender_invoice_number: null, serial_number: null, model: null, original_cents: null, current_cents: null, interest_cents: null, fees_cents: null, lender_code: null, ...o,
  });

  it('rejects a statement that does not foot', () => {
    const r = footStatement([L('a', { current_cents: 100 }), L('b', { current_cents: 200 })], { principalCents: 301, interestCents: null, feesCents: null, lineCount: 2 });
    expect(r.ok).toBe(false);
    expect(footStatement([L('a', { current_cents: 100 })], { principalCents: 100, interestCents: null, feesCents: null, lineCount: 1 }).ok).toBe(true);
    expect(footStatement([], { principalCents: null, interestCents: null, feesCents: null, lineCount: null }).ok).toBe(false);
  });

  it('matches by invoice #, then serial, then model + amount; labels variance, lender-only, books-only, SAU tasks', () => {
    const r = matchStatement({
      kind: 'AUDIT',
      notes,
      toleranceCents: 100,
      sauCodes: ['NP'],
      lines: [
        L('l1', { lender_invoice_number: 'inv 100', current_cents: 900_000 }),
        L('l2', { serial_number: 'sn2', current_cents: 499_950 }),
        L('l3', { model: 'M3', original_cents: 400_000, current_cents: 390_000, lender_code: 'np' }),
        L('l4', { lender_invoice_number: 'INV-999', current_cents: 10 }),
      ],
    });
    expect(r.lines.map((x) => [x.lineId, x.matchedNoteId, x.matchStatus, x.method, x.varianceCents, x.overTolerance])).toEqual([
      ['l1', 'N1', 'MATCHED', 'INVOICE_NUMBER', 0, false],
      ['l2', 'N2', 'VARIANCE', 'SERIAL', -50, false],
      ['l3', 'N3', 'VARIANCE', 'MODEL_AMOUNT', -10_000, true],
      ['l4', null, 'LENDER_ONLY', null, 0, false],
    ]);
    expect(r.booksOnlyNoteIds).toEqual(['N4']);
    expect(r.recordSaleTasks).toEqual([{ lineId: 'l3', noteId: 'N3' }]);
    expect(r.summary).toEqual({ matched: 1, variance: 2, overTolerance: 1, lenderOnly: 1, booksOnly: 1 });
  });

  it('blocks prepare on unresolved lines; the preparer cannot approve', () => {
    const blocking = blockingLines(
      [
        { match_status: 'MATCHED', variance_cents: 0 },
        { match_status: 'VARIANCE', variance_cents: -50 },
        { match_status: 'VARIANCE', variance_cents: -10_000 },
        { match_status: 'RESOLVED', variance_cents: -10_000 },
        { match_status: 'BOOKS_ONLY', variance_cents: 0 },
      ],
      100,
    );
    expect(blocking).toHaveLength(2);
    expect(() => assertApprover('user_a', 'user_a')).toThrow(/separation of duties/);
    expect(() => assertApprover(null, 'user_a')).toThrow();
    expect(() => assertApprover('user_a', 'user_b')).not.toThrow();
  });
});

describe('OEM credit matching (A3 rule layer, AC16)', () => {
  const claims = [
    { kind: 'WARRANTY' as const, id: 'W1', reference: 'C-1', serial_number: 'SN1', openCents: 29_400 },
    { kind: 'WARRANTY' as const, id: 'W2', reference: 'C-2', serial_number: 'SN2', openCents: 10_000 },
    { kind: 'INCENTIVE' as const, id: 'I1', reference: null, serial_number: 'SN9', openCents: 20_000 },
  ];
  it('auto-settle only for exact claim # + exact amount + confidence ≥ threshold', () => {
    const p = matchOemCredits({
      autoMinConfidenceBps: 9_500,
      claims,
      lines: [
        { id: 'a', line_type: 'WARRANTY_CREDIT', reference: 'c-1', serial_number: null, amount_cents: 27_000 },
        { id: 'b', line_type: 'WARRANTY_CREDIT', reference: 'C-2', serial_number: null, amount_cents: 10_000 },
        { id: 'c', line_type: 'INCENTIVE_CREDIT', reference: null, serial_number: 'SN9', amount_cents: 20_000 },
        { id: 'd', line_type: 'DEBIT', reference: 'C-1', serial_number: null, amount_cents: 5 },
      ],
    });
    expect(p.map((x) => [x.lineId, x.claimId, x.method, x.shortPayCents, x.autoSettleEligible])).toEqual([
      ['a', 'W1', 'CLAIM_NUMBER_SHORT', 2_400, false],
      ['b', 'W2', 'CLAIM_NUMBER', 0, true],
      ['c', 'I1', 'SERIAL_AMOUNT', 0, false],
    ]);
  });
});

describe('summary helpers', () => {
  it('buckets units by age with the client edges', () => {
    expect(bucketsFromEdges([90, 180]).map((b) => b.label)).toEqual(['0-90', '91-180', '181+']);
    const r = ageBucket(
      [{ d: '2026-09-30', c: 1 }, { d: '2026-05-01', c: 2 }, { d: null, c: 4 }],
      [90, 180],
      '2026-10-01',
      (x) => ({ date: x.d, cents: x.c }),
    );
    expect(r.buckets.map((b) => [b.label, b.count, b.cents])).toEqual([['0-90', 1, 1], ['91-180', 1, 2], ['181+', 0, 0]]);
    expect(r.undated).toEqual({ count: 1, cents: 4 });
  });

  it('tie-out fails on any difference or unmapped account', () => {
    expect(evaluateTieout([{ bucket: 'FLOOR_PLAN_PAYABLE', account_id: 'a', subledger_cents: 5, gl_cents: 5, difference_cents: 0 }]).ok).toBe(true);
    expect(evaluateTieout([{ bucket: 'UNIT_INVENTORY', account_id: 'a', subledger_cents: 5, gl_cents: 4, difference_cents: 1 }]).ok).toBe(false);
    expect(evaluateTieout([{ bucket: 'UNIT_INVENTORY', account_id: null, subledger_cents: 5, gl_cents: 0, difference_cents: 5 }]).ok).toBe(false);
  });
});

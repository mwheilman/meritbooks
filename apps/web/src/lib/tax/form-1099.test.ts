import { describe, it, expect } from 'vitest';
import {
  assembleForm1099Batch,
  box1FromPayments,
  classifyRecipient,
  centsToAmountString,
  formatEin,
  isValidTin,
  maskTin,
  normalizeTin,
  toNecImportCsv,
  REPORTABLE_THRESHOLD_CENTS,
  type PayerInfo,
  type RecipientInput,
} from './form-1099';

const PAYER: PayerInfo = {
  name: 'Acme Holdings LLC',
  tin: '12-3456789',
  addressLine1: '100 Main St',
  addressLine2: null,
  city: 'Des Moines',
  state: 'IA',
  zip: '50309',
  phone: '515-555-0100',
};

const emptyAddress = { line1: '1 Elm', line2: null, city: 'Ames', state: 'IA', zip: '50010' };

function recipient(over: Partial<RecipientInput>): RecipientInput {
  return {
    vendorId: over.vendorId ?? 'v1',
    vendorName: over.vendorName ?? 'Jane Contractor',
    totalPaidCents: over.totalPaidCents ?? 120_000,
    paymentCount: over.paymentCount ?? 3,
    is1099Eligible: over.is1099Eligible ?? true,
    w9Status: over.w9Status ?? 'on_file',
    // Respect an explicit `tin: null` (don't let ?? swap it for the default).
    tin: 'tin' in over ? over.tin ?? null : '987654321',
    address: over.address ?? emptyAddress,
    payments: over.payments,
    federalTaxWithheldCents: over.federalTaxWithheldCents,
    state: over.state,
  };
}

describe('TIN helpers', () => {
  it('normalizes, validates, formats, and masks TINs', () => {
    expect(normalizeTin('12-3456789')).toBe('123456789');
    expect(isValidTin('12-3456789')).toBe(true);
    expect(isValidTin('123')).toBe(false);
    expect(isValidTin(null)).toBe(false);
    expect(formatEin('123456789')).toBe('12-3456789');
    expect(maskTin('987654321')).toBe('XXX-XX-4321');
    expect(maskTin(null)).toBe('XXX-XX-XXXX');
  });
});

describe('centsToAmountString — integer-exact, no float drift', () => {
  it('formats cents to 2dp dollars', () => {
    expect(centsToAmountString(120_000)).toBe('1200.00');
    expect(centsToAmountString(60_000)).toBe('600.00');
    expect(centsToAmountString(1)).toBe('0.01');
    expect(centsToAmountString(999_99)).toBe('999.99');
    expect(centsToAmountString(-12_345)).toBe('-123.45');
  });
});

describe('box1FromPayments — card rails excluded (1099-K, not NEC)', () => {
  it('sums only reportable (non-card) rails into Box 1', () => {
    const box1 = box1FromPayments([
      { amountCents: 50_000, method: 'ACH', rail: 'ACH' },
      { amountCents: 40_000, method: 'CHECK', rail: null },
      { amountCents: 30_000, method: 'CREDIT_CARD', rail: 'CARD' }, // excluded
      { amountCents: 10_000, method: null, rail: 'card' }, // excluded (case-insensitive)
    ]);
    expect(box1).toBe(90_000);
  });
});

describe('classifyRecipient — threshold, eligibility, TIN/W-9 gate', () => {
  it('excludes vendors under the $600 floor', () => {
    const c = classifyRecipient(recipient({ totalPaidCents: REPORTABLE_THRESHOLD_CENTS - 1 }));
    expect(c.status).toBe('EXCLUDED');
    expect(c.code).toBe('BELOW_THRESHOLD');
  });

  it('excludes vendors not marked 1099-eligible (corp / exempt)', () => {
    const c = classifyRecipient(recipient({ is1099Eligible: false }));
    expect(c.status).toBe('EXCLUDED');
    expect(c.code).toBe('NOT_1099_ELIGIBLE');
  });

  it('BLOCKS an eligible vendor with a missing / invalid TIN', () => {
    expect(classifyRecipient(recipient({ tin: null })).code).toBe('MISSING_TIN');
    expect(classifyRecipient(recipient({ tin: '123' })).code).toBe('MISSING_TIN');
  });

  it('BLOCKS an eligible, TIN-present vendor whose W-9 is not on file', () => {
    expect(classifyRecipient(recipient({ w9Status: 'missing' })).code).toBe('MISSING_W9');
    expect(classifyRecipient(recipient({ w9Status: 'expired' })).code).toBe('MISSING_W9');
  });

  it('marks a fully-documented eligible vendor READY', () => {
    expect(classifyRecipient(recipient({})).status).toBe('READY');
  });

  it('re-derives Box 1 from payments when supplied (card excluded) for the threshold test', () => {
    // totalPaidCents claims $650, but reportable payments are only $500 → EXCLUDED.
    const c = classifyRecipient(
      recipient({
        totalPaidCents: 65_000,
        payments: [
          { amountCents: 50_000, method: 'ACH', rail: 'ACH' },
          { amountCents: 15_000, method: 'CARD', rail: 'CARD' },
        ],
      }),
    );
    expect(c.status).toBe('EXCLUDED');
    expect(c.code).toBe('BELOW_THRESHOLD');
  });
});

describe('assembleForm1099Batch', () => {
  const recipients: RecipientInput[] = [
    recipient({ vendorId: 'ready-big', vendorName: 'Big Sub', totalPaidCents: 500_000 }),
    recipient({ vendorId: 'ready-small', vendorName: 'Small Sub', totalPaidCents: 90_000 }),
    recipient({ vendorId: 'blocked-tin', vendorName: 'No TIN Sub', tin: null, totalPaidCents: 200_000 }),
    recipient({ vendorId: 'blocked-w9', vendorName: 'No W9 Sub', w9Status: 'missing', totalPaidCents: 150_000 }),
    recipient({ vendorId: 'excl-corp', vendorName: 'Corp Inc', is1099Eligible: false, totalPaidCents: 300_000 }),
    recipient({ vendorId: 'excl-small', vendorName: 'Tiny Sub', totalPaidCents: 40_000 }),
  ];
  const batch = assembleForm1099Batch(PAYER, recipients, 2026);

  it('files only fully-documented eligible vendors, largest comp first', () => {
    expect(batch.records.map((r) => r.vendorId)).toEqual(['ready-big', 'ready-small']);
    expect(batch.records[0].box1NonemployeeCompCents).toBe(500_000);
  });

  it('sums Box 1 across ready records into the summary', () => {
    expect(batch.summary.readyCount).toBe(2);
    expect(batch.summary.totalNonemployeeCompCents).toBe(590_000);
  });

  it('reports blocked (fix-first) missing-TIN / W-9 candidates with $ at risk', () => {
    expect(batch.summary.blockedCount).toBe(2);
    expect(batch.summary.blockedDollarsCents).toBe(350_000);
    const blocked = batch.exclusions.filter((e) => e.status === 'BLOCKED');
    expect(blocked.every((e) => e.fixFirst)).toBe(true);
    // Fix-first sorts ahead of plain exclusions.
    expect(batch.exclusions[0].status).toBe('BLOCKED');
  });

  it('excludes below-threshold and not-eligible candidates (not fix-first)', () => {
    expect(batch.summary.excludedCount).toBe(2);
    const codes = batch.exclusions.filter((e) => e.status === 'EXCLUDED').map((e) => e.code).sort();
    expect(codes).toEqual(['BELOW_THRESHOLD', 'NOT_1099_ELIGIBLE']);
  });

  it('flags a missing payer EIN as a filing blocker', () => {
    const noEin = assembleForm1099Batch({ ...PAYER, tin: null }, recipients, 2026);
    expect(noEin.summary.payerTinMissing).toBe(true);
    expect(batch.summary.payerTinMissing).toBe(false);
  });
});

describe('toNecImportCsv — the filing-service e-file', () => {
  const batch = assembleForm1099Batch(
    PAYER,
    [
      recipient({ vendorId: 'r1', vendorName: 'Jane, Contractor', totalPaidCents: 123_456 }),
      recipient({ vendorId: 'blocked', tin: null, totalPaidCents: 200_000 }),
    ],
    2026,
  );
  const csv = toNecImportCsv(batch);
  const lines = csv.trim().split('\r\n');

  it('emits a header + one row per READY record only (blocked never reaches the file)', () => {
    expect(lines).toHaveLength(2); // header + 1 ready row
    expect(lines[0]).toContain('Box 1 Nonemployee Compensation');
  });

  it('writes Box 1 in dollars and quotes cells containing commas', () => {
    expect(lines[1]).toContain('1234.56');
    expect(lines[1]).toContain('"Jane, Contractor"');
    expect(lines[1]).toContain('12-3456789'); // payer EIN formatted
  });
});

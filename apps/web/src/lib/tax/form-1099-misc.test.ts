import { describe, it, expect } from 'vitest';
import {
  assembleForm1099MiscBatch,
  classifyMiscRecipient,
  meetsAnyMiscThreshold,
  toMiscImportCsv,
  MISC_GENERAL_THRESHOLD_CENTS,
  MISC_ROYALTY_THRESHOLD_CENTS,
  type RecipientMiscInput,
} from './form-1099-misc';
import type { PayerInfo } from './form-1099';

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

const addr = { line1: '1 Elm', line2: null, city: 'Ames', state: 'IA', zip: '50010' };

function recipient(over: Partial<RecipientMiscInput>): RecipientMiscInput {
  return {
    vendorId: over.vendorId ?? 'v1',
    vendorName: over.vendorName ?? 'Landlord LLC',
    totalPaidCents: over.totalPaidCents ?? 90_000,
    paymentCount: over.paymentCount ?? 2,
    is1099Eligible: over.is1099Eligible ?? true,
    w9Status: over.w9Status ?? 'on_file',
    tin: 'tin' in over ? over.tin ?? null : '987654321',
    address: over.address ?? addr,
    miscBoxCents: over.miscBoxCents ?? { MISC_1: 90_000 },
    payments: over.payments,
    federalTaxWithheldCents: over.federalTaxWithheldCents,
    state: over.state,
  };
}

describe('meetsAnyMiscThreshold — royalties clear at $10, everything else at $600', () => {
  it('royalties qualify at $10 (the one sub-$600 MISC box)', () => {
    expect(MISC_ROYALTY_THRESHOLD_CENTS).toBe(1_000);
    expect(meetsAnyMiscThreshold({ MISC_2: 1_000 })).toBe(true); // exactly $10
    expect(meetsAnyMiscThreshold({ MISC_2: 999 })).toBe(false); // $9.99 → no
  });

  it('rents / other / medical / attorney need the full $600 floor', () => {
    expect(MISC_GENERAL_THRESHOLD_CENTS).toBe(60_000);
    expect(meetsAnyMiscThreshold({ MISC_1: 60_000 })).toBe(true); // exactly $600
    expect(meetsAnyMiscThreshold({ MISC_1: 59_999 })).toBe(false); // $599.99 → no
    // A $15 royalty alongside a sub-$600 rent still triggers the form (royalty floor).
    expect(meetsAnyMiscThreshold({ MISC_1: 40_000, MISC_2: 1_500 })).toBe(true);
  });
});

describe('classifyMiscRecipient — threshold, eligibility, TIN/W-9 gate, card carve-out', () => {
  it('excludes when no box clears its floor', () => {
    const c = classifyMiscRecipient(recipient({ miscBoxCents: { MISC_1: 40_000 } })); // $400 rent
    expect(c.status).toBe('EXCLUDED');
    expect(c.code).toBe('BELOW_THRESHOLD');
  });

  it('files a $15 royalty (below $600 but above the $10 royalty floor)', () => {
    const c = classifyMiscRecipient(recipient({ miscBoxCents: { MISC_2: 1_500 } }));
    expect(c.status).toBe('READY');
  });

  it('excludes an all-card (1099-K) vendor even when a box shows dollars', () => {
    const c = classifyMiscRecipient(
      recipient({
        miscBoxCents: { MISC_1: 90_000 },
        payments: [
          { amountCents: 60_000, method: 'CREDIT_CARD', rail: 'CARD' },
          { amountCents: 30_000, method: null, rail: 'card' },
        ],
      }),
    );
    expect(c.status).toBe('EXCLUDED');
    expect(c.code).toBe('BELOW_THRESHOLD');
  });

  it('blocks eligible vendors missing a TIN or W-9', () => {
    expect(classifyMiscRecipient(recipient({ tin: null })).code).toBe('MISSING_TIN');
    expect(classifyMiscRecipient(recipient({ w9Status: 'missing' })).code).toBe('MISSING_W9');
    expect(classifyMiscRecipient(recipient({ w9Status: 'expired' })).code).toBe('MISSING_W9');
  });

  it('excludes vendors not marked 1099-eligible (corp / exempt)', () => {
    expect(classifyMiscRecipient(recipient({ is1099Eligible: false })).code).toBe('NOT_1099_ELIGIBLE');
  });

  it('marks a fully-documented eligible vendor READY', () => {
    expect(classifyMiscRecipient(recipient({})).status).toBe('READY');
  });
});

describe('assembleForm1099MiscBatch — per-box amounts, sorting, summary', () => {
  const recipients: RecipientMiscInput[] = [
    recipient({ vendorId: 'rent-big', vendorName: 'Big Landlord', miscBoxCents: { MISC_1: 500_000 }, totalPaidCents: 500_000 }),
    recipient({
      vendorId: 'mixed',
      vendorName: 'Mixed Vendor',
      miscBoxCents: { MISC_2: 2_000, MISC_10: 120_000 }, // $20 royalties + $1,200 attorney
      totalPaidCents: 122_000,
    }),
    recipient({ vendorId: 'blocked-tin', vendorName: 'No TIN Landlord', tin: null, miscBoxCents: { MISC_1: 200_000 }, totalPaidCents: 200_000 }),
    recipient({ vendorId: 'excl-small', vendorName: 'Tiny Rent', miscBoxCents: { MISC_1: 40_000 }, totalPaidCents: 40_000 }),
    recipient({ vendorId: 'excl-nec', vendorName: 'Pure Services', miscBoxCents: {}, totalPaidCents: 300_000 }), // all NEC → no MISC box
  ];
  const batch = assembleForm1099MiscBatch(PAYER, recipients, 2026);

  it('files only fully-documented eligible vendors, largest total first', () => {
    expect(batch.records.map((r) => r.vendorId)).toEqual(['rent-big', 'mixed']);
  });

  it('keeps each box amount in its own box (rents, royalties, attorney)', () => {
    const mixed = batch.records.find((r) => r.vendorId === 'mixed')!;
    expect(mixed.boxAmounts.MISC_2).toBe(2_000);
    expect(mixed.boxAmounts.MISC_10).toBe(120_000);
    expect(mixed.boxAmounts.MISC_1).toBeUndefined();
    expect(mixed.totalReportableMiscCents).toBe(122_000);
  });

  it('sums per-box totals across ready records into the summary', () => {
    expect(batch.summary.readyCount).toBe(2);
    expect(batch.summary.boxTotals.MISC_1).toBe(500_000);
    expect(batch.summary.boxTotals.MISC_2).toBe(2_000);
    expect(batch.summary.boxTotals.MISC_10).toBe(120_000);
    expect(batch.summary.totalReportableMiscCents).toBe(622_000);
  });

  it('blocks missing-TIN candidates (fix-first) and excludes below-threshold / NEC-only', () => {
    expect(batch.summary.blockedCount).toBe(1);
    expect(batch.summary.blockedDollarsCents).toBe(200_000);
    // Tiny rent (below $600) + pure-services (no MISC box) are plain exclusions.
    expect(batch.summary.excludedCount).toBe(2);
    expect(batch.exclusions[0].status).toBe('BLOCKED'); // fix-first sorts ahead
  });

  it('flags a missing payer EIN as a filing blocker', () => {
    const noEin = assembleForm1099MiscBatch({ ...PAYER, tin: null }, recipients, 2026);
    expect(noEin.summary.payerTinMissing).toBe(true);
    expect(batch.summary.payerTinMissing).toBe(false);
  });
});

describe('toMiscImportCsv — the filing-service e-file', () => {
  const batch = assembleForm1099MiscBatch(
    PAYER,
    [
      recipient({ vendorId: 'r1', vendorName: 'Rent, Co', miscBoxCents: { MISC_1: 123_456 }, totalPaidCents: 123_456 }),
      recipient({ vendorId: 'blocked', tin: null, miscBoxCents: { MISC_1: 200_000 }, totalPaidCents: 200_000 }),
    ],
    2026,
  );
  const csv = toMiscImportCsv(batch);
  const lines = csv.trim().split('\r\n');

  it('emits a header + one row per READY record only (blocked never reaches the file)', () => {
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('Box 1 Rents');
    expect(lines[0]).toContain('Box 10 Gross Proceeds Paid to an Attorney');
    expect(lines[0]).toContain('Form Type');
  });

  it('writes the rent box in dollars, quotes comma cells, and tags the form type', () => {
    expect(lines[1]).toContain('1234.56'); // $123,456 rent
    expect(lines[1]).toContain('"Rent, Co"');
    expect(lines[1]).toContain('1099-MISC');
    expect(lines[1]).toContain('12-3456789'); // payer EIN formatted
  });
});

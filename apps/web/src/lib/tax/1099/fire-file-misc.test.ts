import { describe, it, expect } from 'vitest';
import { assembleForm1099MiscBatch, type RecipientMiscInput } from '../form-1099-misc';
import type { PayerInfo } from '../form-1099';
import {
  buildMiscFireFile,
  MISC_TYPE_OF_RETURN,
  MISC_BOX_AMOUNT_CODE,
  amountCodeOrdinal,
  paymentAmountStart,
  controlTotalStart,
} from './fire-file-misc';
import { FIRE_RECORD_LENGTH, TCC_PLACEHOLDER, type FireTransmitter } from './fire-file';

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

const TRANSMITTER: FireTransmitter = {
  tcc: 'AB123',
  tin: '12-3456789',
  name: 'Acme Holdings LLC',
  companyName: null,
  addressLine1: '100 Main St',
  city: 'Des Moines',
  state: 'IA',
  zip: '50309',
  contactName: 'Jane Filer',
  contactPhone: '5155550100',
  contactEmail: 'jane@acme.test',
  testFile: false,
};

const addr = { line1: '1 Elm', line2: null, city: 'Ames', state: 'IA', zip: '50010' };

function recipient(over: Partial<RecipientMiscInput>): RecipientMiscInput {
  return {
    vendorId: over.vendorId ?? 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    vendorName: over.vendorName ?? 'Landlord LLC',
    totalPaidCents: over.totalPaidCents ?? 90_000,
    paymentCount: over.paymentCount ?? 2,
    is1099Eligible: over.is1099Eligible ?? true,
    w9Status: over.w9Status ?? 'on_file',
    tin: 'tin' in over ? over.tin ?? null : '987654321',
    address: over.address ?? addr,
    miscBoxCents: over.miscBoxCents ?? { MISC_1: 90_000 },
    federalTaxWithheldCents: over.federalTaxWithheldCents,
    state: over.state,
  };
}

function build(recipients: RecipientMiscInput[], t: FireTransmitter = TRANSMITTER, taxYear = 2026) {
  const batch = assembleForm1099MiscBatch(PAYER, recipients, taxYear);
  return { batch, ...buildMiscFireFile(batch, { taxYear, transmitter: t }) };
}

function lines(content: string): string[] {
  return content.replace(/\r\n$/, '').split('\r\n');
}

describe('amount-code geometry (Pub. 1220)', () => {
  it('maps each MISC box to its IRS amount code', () => {
    expect(MISC_BOX_AMOUNT_CODE).toEqual({ MISC_1: '1', MISC_2: '2', MISC_3: '3', MISC_6: '6', MISC_10: 'B' });
  });

  it('places payment + control-total fields off the code ordinal', () => {
    expect(amountCodeOrdinal('1')).toBe(1);
    expect(amountCodeOrdinal('B')).toBe(11); // 9 numeric + A,B
    expect(paymentAmountStart('1')).toBe(55);
    expect(paymentAmountStart('2')).toBe(67);
    expect(paymentAmountStart('B')).toBe(175); // attorney gross proceeds field
    expect(controlTotalStart('1')).toBe(16);
    expect(controlTotalStart('B')).toBe(196);
  });
});

describe('buildMiscFireFile — structure', () => {
  const { content, recordCount, payeeCount } = build([
    recipient({ vendorId: '11111111-2222-3333-4444-555555555555', vendorName: 'Big Landlord', miscBoxCents: { MISC_1: 500_000 } }),
    recipient({ vendorId: '66666666-7777-8888-9999-aaaaaaaaaaaa', vendorName: 'Small Landlord', miscBoxCents: { MISC_1: 90_000 } }),
  ]);
  const rows = lines(content);

  it('emits T, A, B×n, C, F in order', () => {
    expect(rows.map((l) => l[0])).toEqual(['T', 'A', 'B', 'B', 'C', 'F']);
    expect(recordCount).toBe(6);
    expect(payeeCount).toBe(2);
  });

  it('makes every record exactly 750 positions wide and CRLF-terminates', () => {
    for (const l of rows) expect(l).toHaveLength(FIRE_RECORD_LENGTH);
    expect(content.endsWith('\r\n')).toBe(true);
  });

  it('carries the 1099-MISC type of return "A" on the A record', () => {
    const a = rows[1];
    expect(a.slice(25, 27)).toBe(`${MISC_TYPE_OF_RETURN} `); // "A "
  });
});

describe('buildMiscFireFile — box amounts land in the right payment fields', () => {
  const { content } = build([
    recipient({
      vendorName: 'Jane Attorney',
      tin: '987654321',
      miscBoxCents: { MISC_1: 123_456, MISC_2: 2_000, MISC_10: 120_000 },
      totalPaidCents: 245_456,
      federalTaxWithheldCents: 5_000,
    }),
  ]);
  const rows = lines(content);
  const a = rows[1];
  const b = rows[2];

  it('lists exactly the amount codes present, sorted (rents, royalties, fed, attorney)', () => {
    // codes 1 (rents), 2 (royalties), 4 (fed w/h), B (attorney) → "124B"
    expect(a.slice(27, 43)).toBe('124B'.padEnd(16, ' '));
  });

  it('writes each box in integer cents, zero-filled, in its own field', () => {
    expect(b.slice(54, 66)).toBe('000000123456'); // Box 1 rents (field 1)
    expect(b.slice(66, 78)).toBe('000000002000'); // Box 2 royalties (field 2)
    expect(b.slice(90, 102)).toBe('000000005000'); // Box 4 fed w/h (field 4)
    expect(b.slice(174, 186)).toBe('000000120000'); // Box 10 attorney (field "B")
  });

  it('leaves an unused box field blank/zero (no medical here)', () => {
    // Field 6 (medical) is untouched space-fill, not a money value.
    expect(b.slice(114, 126)).toBe(' '.repeat(12));
  });
});

describe('buildMiscFireFile — C control totals sum each box across payees', () => {
  const { content } = build([
    recipient({ vendorId: '11111111-1111-1111-1111-111111111111', miscBoxCents: { MISC_1: 500_000, MISC_2: 3_000 }, totalPaidCents: 503_000 }),
    recipient({ vendorId: '22222222-2222-2222-2222-222222222222', miscBoxCents: { MISC_1: 90_000 }, totalPaidCents: 90_000 }),
  ]);
  const c = lines(content).find((l) => l[0] === 'C')!;

  it('reports payee count and per-amount-code control totals in integer cents', () => {
    expect(c.slice(1, 9)).toBe('00000002'); // 2 payees
    expect(c.slice(15, 33)).toBe('590000'.padStart(18, '0')); // CT1 (rents): 500k + 90k
    expect(c.slice(33, 51)).toBe('3000'.padStart(18, '0')); // CT2 (royalties)
  });
});

describe('buildMiscFireFile — degrade-safe + blocked-recipient exclusion', () => {
  it('warns and emits a placeholder when the TCC is missing', () => {
    const { content, warnings, hasPlaceholders } = build([recipient({ miscBoxCents: { MISC_1: 90_000 } })], {
      ...TRANSMITTER,
      tcc: null,
    });
    expect(hasPlaceholders).toBe(true);
    expect(warnings.some((w) => w.includes('TCC'))).toBe(true);
    expect(lines(content)[0].slice(15, 20)).toBe(TCC_PLACEHOLDER); // "00000"
  });

  it('never emits a BLOCKED (missing-TIN) recipient as a B record', () => {
    const { content, payeeCount } = build([
      recipient({ vendorId: '11111111-1111-1111-1111-111111111111', miscBoxCents: { MISC_1: 500_000 } }), // ready
      recipient({ vendorId: '22222222-2222-2222-2222-222222222222', tin: null, miscBoxCents: { MISC_1: 400_000 } }), // blocked
    ]);
    expect(payeeCount).toBe(1);
    expect(lines(content).filter((l) => l[0] === 'B')).toHaveLength(1);
  });
});

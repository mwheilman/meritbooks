import { describe, it, expect } from 'vitest';
import { assembleForm1099Batch, type PayerInfo, type RecipientInput } from '../form-1099';
import {
  buildFireFile,
  nameControl,
  FIRE_RECORD_LENGTH,
  NEC_TYPE_OF_RETURN,
  TCC_PLACEHOLDER,
  type FireTransmitter,
} from './fire-file';

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

function recipient(over: Partial<RecipientInput>): RecipientInput {
  return {
    vendorId: over.vendorId ?? 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    vendorName: over.vendorName ?? 'Jane Contractor',
    totalPaidCents: over.totalPaidCents ?? 120_000,
    paymentCount: over.paymentCount ?? 3,
    is1099Eligible: over.is1099Eligible ?? true,
    w9Status: over.w9Status ?? 'on_file',
    tin: 'tin' in over ? over.tin ?? null : '987654321',
    address: over.address ?? addr,
    payments: over.payments,
    federalTaxWithheldCents: over.federalTaxWithheldCents,
    state: over.state,
  };
}

function build(recipients: RecipientInput[], t: FireTransmitter = TRANSMITTER, taxYear = 2026) {
  const batch = assembleForm1099Batch(PAYER, recipients, taxYear);
  return { batch, ...buildFireFile(batch, { taxYear, transmitter: t }) };
}

function lines(content: string): string[] {
  return content.replace(/\r\n$/, '').split('\r\n');
}

describe('nameControl', () => {
  it('takes the first 4 alphanumerics, uppercased, padded', () => {
    expect(nameControl('Jane Contractor')).toBe('JANE');
    expect(nameControl("O'Brien & Co")).toBe('OBRI');
    expect(nameControl('AB')).toBe('AB  ');
    expect(nameControl(null)).toBe('    ');
  });
});

describe('buildFireFile — structure', () => {
  const { content, recordCount, payeeCount } = build([
    recipient({ vendorId: '11111111-2222-3333-4444-555555555555', vendorName: 'Big Sub', totalPaidCents: 500_000 }),
    recipient({ vendorId: '66666666-7777-8888-9999-aaaaaaaaaaaa', vendorName: 'Small Sub', totalPaidCents: 90_000 }),
  ]);
  const rows = lines(content);

  it('emits T, A, B×n, C, F in order', () => {
    expect(rows.map((l) => l[0])).toEqual(['T', 'A', 'B', 'B', 'C', 'F']);
    expect(recordCount).toBe(6);
    expect(payeeCount).toBe(2);
  });

  it('makes every record exactly 750 positions wide', () => {
    for (const l of rows) expect(l).toHaveLength(FIRE_RECORD_LENGTH);
  });

  it('CRLF-terminates the file (including the final record)', () => {
    expect(content.endsWith('\r\n')).toBe(true);
    expect(content.split('\r\n').filter(Boolean)).toHaveLength(6);
  });

  it('assigns ascending record sequence numbers at positions 500-507', () => {
    rows.forEach((l, i) => {
      expect(l.slice(499, 507)).toBe(String(i + 1).padStart(8, '0'));
    });
  });
});

describe('buildFireFile — T (transmitter) record', () => {
  const { content } = build([recipient({ totalPaidCents: 90_000 })]);
  const t = lines(content)[0];

  it('carries year, TIN, TCC, contact, and payee count', () => {
    expect(t.slice(1, 5)).toBe('2026'); // payment year
    expect(t.slice(6, 15)).toBe('123456789'); // transmitter TIN
    expect(t.slice(15, 20)).toBe('AB123'); // TCC
    expect(t.slice(27, 28)).toBe(' '); // not a test file
    expect(t.slice(295, 303)).toBe('00000001'); // total payees
    expect(t.slice(517, 518)).toBe('I'); // vendor indicator
  });
});

describe('buildFireFile — A (payer) record', () => {
  it('carries payer TIN, NEC type-of-return, and amount codes', () => {
    const withFed = build([recipient({ federalTaxWithheldCents: 5_000, totalPaidCents: 90_000 })]);
    const a = lines(withFed.content)[1];
    expect(a.slice(11, 20)).toBe('123456789'); // payer TIN
    expect(a.slice(25, 27)).toBe(NEC_TYPE_OF_RETURN); // "NE"
    expect(a.slice(27, 43)).toBe('14'.padEnd(16, ' ')); // amount codes 1 + 4
  });

  it('drops amount code 4 when no federal tax was withheld', () => {
    const noFed = build([recipient({ totalPaidCents: 90_000 })]);
    const a = lines(noFed.content)[1];
    expect(a.slice(27, 43)).toBe('1'.padEnd(16, ' '));
  });
});

describe('buildFireFile — B (payee) record: money is integer cents, zero-filled', () => {
  const { content } = build([
    recipient({ vendorName: 'Jane Contractor', tin: '987654321', totalPaidCents: 123_456, federalTaxWithheldCents: 5_000 }),
  ]);
  const b = lines(content)[1 + 1]; // T, A, then first B

  it('right-justifies Box 1 (Amount 1) at positions 55-66 with no decimal point', () => {
    // $1,234.56 -> 123456 cents -> "000000123456"
    expect(b.slice(54, 66)).toBe('000000123456');
  });

  it('right-justifies Box 4 (Amount 4) at positions 91-102', () => {
    expect(b.slice(90, 102)).toBe('000000005000'); // $50.00 fed w/h
  });

  it('carries recipient name control, TIN, and name', () => {
    expect(b.slice(6, 10)).toBe('JANE'); // name control
    expect(b.slice(11, 20)).toBe('987654321'); // recipient TIN
    expect(b.slice(247, 287).trim()).toBe('JANE CONTRACTOR');
  });
});

describe('buildFireFile — C control totals sum Box 1 / Box 4 across payees', () => {
  const { content } = build([
    recipient({ vendorId: '11111111-1111-1111-1111-111111111111', totalPaidCents: 500_000, federalTaxWithheldCents: 1_000 }),
    recipient({ vendorId: '22222222-2222-2222-2222-222222222222', totalPaidCents: 90_000, federalTaxWithheldCents: 2_000 }),
  ]);
  const c = lines(content).find((l) => l[0] === 'C')!;

  it('reports payee count and control totals in integer cents', () => {
    expect(c.slice(1, 9)).toBe('00000002'); // 2 payees
    // Control total 1 (Box 1): 590000 cents, 18-wide right-justified.
    expect(c.slice(15, 33)).toBe('590000'.padStart(18, '0'));
    // Control total 4 (Box 4): 3000 cents.
    expect(c.slice(69, 87)).toBe('3000'.padStart(18, '0'));
  });
});

describe('buildFireFile — F (end of transmission) record', () => {
  it('reports one A record and zero-fills the count field', () => {
    const { content } = build([recipient({ totalPaidCents: 90_000 })]);
    const f = lines(content).find((l) => l[0] === 'F')!;
    expect(f.slice(1, 9)).toBe('00000001'); // one A record
    expect(f.slice(9, 30)).toBe('0'.repeat(21)); // zero field
  });
});

describe('buildFireFile — degrade-safe warnings, never a silently-invalid required field', () => {
  it('warns and emits a placeholder when the TCC is missing', () => {
    const { content, warnings, hasPlaceholders } = build([recipient({ totalPaidCents: 90_000 })], {
      ...TRANSMITTER,
      tcc: null,
    });
    expect(hasPlaceholders).toBe(true);
    expect(warnings.some((w) => w.includes('TCC'))).toBe(true);
    expect(lines(content)[0].slice(15, 20)).toBe(TCC_PLACEHOLDER); // "00000"
  });

  it('warns when the transmitter or payer TIN is missing', () => {
    const noTin = build([recipient({ totalPaidCents: 90_000 })], { ...TRANSMITTER, tin: null });
    expect(noTin.warnings.some((w) => w.toLowerCase().includes('transmitter tin'))).toBe(true);

    const batch = assembleForm1099Batch({ ...PAYER, tin: null }, [recipient({ totalPaidCents: 90_000 })], 2026);
    const noPayer = buildFireFile(batch, { taxYear: 2026, transmitter: TRANSMITTER });
    expect(noPayer.warnings.some((w) => w.toLowerCase().includes('payer ein'))).toBe(true);
  });

  it('marks the test indicator and warns when testFile is set', () => {
    const { content, warnings } = build([recipient({ totalPaidCents: 90_000 })], { ...TRANSMITTER, testFile: true });
    expect(lines(content)[0].slice(27, 28)).toBe('T');
    expect(warnings.some((w) => w.toUpperCase().includes('TEST'))).toBe(true);
  });

  it('never emits a BLOCKED (missing-TIN/W-9) contractor as a B record', () => {
    const { content, payeeCount } = build([
      recipient({ vendorId: '11111111-1111-1111-1111-111111111111', totalPaidCents: 500_000 }), // ready
      recipient({ vendorId: '22222222-2222-2222-2222-222222222222', tin: null, totalPaidCents: 400_000 }), // blocked
    ]);
    expect(payeeCount).toBe(1);
    expect(lines(content).filter((l) => l[0] === 'B')).toHaveLength(1);
  });
});

import { describe, expect, it } from 'vitest';
import { allocateProRata, buildProgressApplication, isProgressBilling, priorProgressBills, type ProgressBillFact } from './progress-application';
import { applicationLines } from './progress-pdf';

const bill = (over: Partial<ProgressBillFact> & Pick<ProgressBillFact, 'id' | 'invoiceNumber' | 'invoiceDate'>): ProgressBillFact => ({
  status: 'SENT', applicationNumber: null, retainageCents: 0, lines: [], ...over,
});
const work = (description: string, amountCents: number) => ({ description, amountCents, isRelease: false });

describe('isProgressBilling — which invoices print the G702/G703 layout', () => {
  it('progress flag or an application number selects it; a plain invoice does not', () => {
    expect(isProgressBilling({ is_progress_bill: true })).toBe(true);
    expect(isProgressBilling({ is_progress_bill: false, application_number: 3 })).toBe(true);
    expect(isProgressBilling({ is_progress_bill: false, application_number: null })).toBe(false);
    expect(isProgressBilling({})).toBe(false);
  });
});

describe('G702 arithmetic', () => {
  it('INV-NWC-202606-0001: first draw $150,000 on a $1.2M contract, no retainage', () => {
    const current = bill({ id: 'a', invoiceNumber: 'INV-NWC-202606-0001', invoiceDate: '2026-06-15', lines: [work('[SANDBOX] Progress draw #1', 15_000_000)] });
    const p = buildProgressApplication({ current, jobBills: [current], contract: { originalContractCents: null, contractSumToDateCents: 120_000_000 } });
    expect(p.summary).toEqual({
      applicationNumber: 1,
      originalContractCents: 120_000_000,
      netChangeOrdersCents: 0,
      contractSumToDateCents: 120_000_000,
      completedToDateCents: 15_000_000,
      retainageToDateCents: 0,
      earnedLessRetainageCents: 15_000_000,
      previousCertificatesCents: 0,
      currentPaymentDueCents: 15_000_000,
      balanceToFinishCents: 105_000_000,
      percentComplete: 12.5,
    });
    expect(p.rows).toHaveLength(1);
    expect(p.rows[0]).toMatchObject({ scheduledValueCents: 120_000_000, thisPeriodCents: 15_000_000, previousCents: 0, percentComplete: 12.5, balanceToFinishCents: 105_000_000 });
  });

  it('third application with change orders, 10% retainage and a partial release ties line 8 to the invoice', () => {
    const b1 = bill({ id: '1', invoiceNumber: 'INV-1', invoiceDate: '2026-01-31', applicationNumber: 1, retainageCents: 10_000, lines: [work('Sitework', 60_000), work('Framing', 40_000)] });
    const b2 = bill({ id: '2', invoiceNumber: 'INV-2', invoiceDate: '2026-02-28', applicationNumber: 2, retainageCents: 5_000, lines: [work('Framing', 50_000)] });
    const voided = bill({ id: 'v', invoiceNumber: 'INV-V', invoiceDate: '2026-02-15', status: 'VOIDED', retainageCents: 99, lines: [work('Framing', 99_999)] });
    const later = bill({ id: 'L', invoiceNumber: 'INV-9', invoiceDate: '2026-04-30', lines: [work('Framing', 1)] });
    const current = bill({
      id: '3', invoiceNumber: 'INV-3', invoiceDate: '2026-03-31', applicationNumber: 3, retainageCents: 3_000,
      lines: [work('Framing', 10_000), work('Roofing', 20_000), { description: 'Retainage release', amountCents: 4_000, isRelease: true }],
    });
    const p = buildProgressApplication({ current, jobBills: [b1, b2, voided, later, current], contract: { originalContractCents: 400_000, contractSumToDateCents: 450_000 } });
    const s = p.summary;
    expect(s.netChangeOrdersCents).toBe(50_000);
    expect(s.completedToDateCents).toBe(180_000); // 100k + 50k + 30k
    expect(s.retainageToDateCents).toBe(14_000); // 10k + 5k + 3k − 4k released
    expect(s.earnedLessRetainageCents).toBe(166_000);
    expect(s.previousCertificatesCents).toBe(135_000); // 150k − 15k
    expect(s.currentPaymentDueCents).toBe(31_000); // 30k work − 3k withheld + 4k released
    expect(s.balanceToFinishCents).toBe(284_000); // 450k − 166k
    expect(s.percentComplete).toBe(40);
    // G703: rows by description; previous vs this period; retainage allocated and tied.
    expect(p.rows.map((r) => [r.description, r.previousCents, r.thisPeriodCents])).toEqual([
      ['Sitework', 60_000, 0], ['Framing', 90_000, 10_000], ['Roofing', 0, 20_000],
    ]);
    expect(p.rows.every((r) => r.scheduledValueCents === null)).toBe(true);
    expect(p.rows.reduce((t, r) => t + r.retainageCents, 0)).toBe(14_000);
    expect(p.totals).toMatchObject({ scheduledValueCents: 450_000, previousCents: 150_000, thisPeriodCents: 30_000, completedToDateCents: 180_000, balanceToFinishCents: 270_000, retainageCents: 14_000 });
    expect(p.previousBills.map((b) => b.invoiceNumber)).toEqual(['INV-1', 'INV-2']);
    // Tie-out on the document: line 8 + tax = invoice total (30k − 3k + 4k = 31k; + 1.5k tax).
    const tail = applicationLines(p, { tax_cents: 1_500, total_cents: 32_500 }).slice(-2);
    expect(tail).toEqual([{ no: '', label: 'Plus sales tax', value: 1_500 }, { no: '', label: 'Amount due on this invoice', value: 32_500, strong: true }]);
  });

  it('unknown contract sum leaves lines 1–3 and 9 blank, never invents them', () => {
    const current = bill({ id: 'x', invoiceNumber: 'I', invoiceDate: '2026-05-01', lines: [work('Draw', 1_000)] });
    const p = buildProgressApplication({ current, jobBills: [], contract: null });
    expect(p.summary).toMatchObject({ originalContractCents: null, netChangeOrdersCents: null, contractSumToDateCents: null, balanceToFinishCents: null, percentComplete: null, currentPaymentDueCents: 1_000 });
  });

  it('priorProgressBills orders by date then number and skips drafts, voids and itself', () => {
    const a = bill({ id: 'a', invoiceNumber: 'B', invoiceDate: '2026-01-01' });
    const b = bill({ id: 'b', invoiceNumber: 'A', invoiceDate: '2026-01-01' });
    const d = bill({ id: 'd', invoiceNumber: 'C', invoiceDate: '2025-12-01', status: 'DRAFT' });
    const cur = bill({ id: 'c', invoiceNumber: 'C', invoiceDate: '2026-01-01' });
    expect(priorProgressBills(cur, [a, b, d, cur]).map((x) => x.id)).toEqual(['b', 'a']);
  });

  it('allocateProRata always sums to the total', () => {
    expect(allocateProRata(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocateProRata(-10, [3, 1])).toEqual([-8, -2]);
    expect(allocateProRata(5, [0, 0])).toEqual([0, 0]);
  });
});

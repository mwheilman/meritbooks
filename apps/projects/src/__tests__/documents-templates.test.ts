import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { DEFAULT_VOCAB } from '@/lib/packs';
import { renderTemplate, usd, fmtDate } from '@/lib/templates/render';
import { TEMPLATE_KEYS, type TemplateContext, type TemplateDataMap, type TemplateKey } from '@/lib/templates/types';
import { buildSignedPdf, HashMismatchError } from '@/lib/esign/certificate';
import { sha256Hex } from '@/lib/documents/pdf';
import { winAnsi } from '@/lib/templates/layout';
import { StandardFonts } from 'pdf-lib';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const ctx = (vocab = DEFAULT_VOCAB): TemplateContext => ({
  brand: { companyName: 'Heartland Remodeling', primaryColor: '#2563EB', inkColor: '#0A1628', logo: null },
  vocab: { ...vocab },
  settings: {},
  today: '2026-10-24',
});

const customer = { name: 'Pat and Sam Rivera', lines: ['1412 Grand Ave', 'Des Moines, IA 50309'], email: 'pat@example.test' };
const lines = [
  { description: 'Demolition and haul-off', qty: 1, uom: 'LS', unitCents: 180000, amountCents: 180000 },
  { description: 'Cabinets — shaker, painted (allowance)', qty: 22, uom: 'LF', unitCents: 45000, amountCents: 990000, note: 'Allowance' },
];

const SAMPLES: { [K in TemplateKey]: TemplateDataMap[K] } = {
  proposal: { number: 'EST-HR-2026-0042', version: 2, date: '2026-10-20', validUntil: '2026-11-20', jobName: 'Rivera kitchen', customer, site: '1412 Grand Ave', lines, allowanceCents: 990000, totalCents: 1170000, customerSigners: ['Pat Rivera', 'Sam Rivera'] },
  contract: { number: 'EST-HR-2026-0042', date: '2026-10-21', jobName: 'Rivera kitchen', customer, lines, totalCents: 1170000, contractType: 'Fixed price', paymentSchedule: [{ label: 'Deposit at signing', amountCents: 351000, pct: 0.3 }, { label: 'Cabinets set', amountCents: 585000, pct: 0.5 }, { label: 'Final', amountCents: 234000, pct: 0.2 }] },
  change_order: { number: 'CO-2026-0007', title: 'Replace rotten subfloor under tub', date: '2026-10-22', jobName: 'Rivera kitchen', customer, description: '40 sq ft of subfloor found rotten during demolition.', reason: 'Hidden condition', amountCents: 184000, scheduleDays: 2, originalContractCents: 1170000, previousChangesCents: 0 },
  pay_app_cover: { applicationNo: 3, periodEnd: '2026-10-31', date: '2026-10-31', jobName: 'Clive office TI', owner: { name: 'Clive Partners LLC' }, originalContractCents: 48000000, changeOrdersCents: 1250000, totalCompletedCents: 30000000, retainageCents: 3000000, previousCertificatesCents: 18000000, currentDueCents: 9000000 },
  work_order: { number: 'WO-2026-00031', kindLabel: 'Service', date: '2026-10-23', scheduled: '2026-10-24', customer, site: '1412 Grand Ave', summary: 'No heat — furnace short-cycling', complaint: 'Furnace shuts off after 2 minutes', cause: 'Dirty flame sensor', resolution: 'Cleaned sensor, tested 3 cycles', lines: [{ description: 'Diagnostic', qty: 1, uom: 'EA', unitCents: 12900, amountCents: 12900 }], showPrices: true, totalCents: 12900 },
  daily_report: { date: '2026-10-23', jobName: 'Clive office TI', kindLabel: 'Daily', author: 'Jordan (super)', weather: 'Clear, 54°F', crewCount: 6, hours: 48, body: 'Framing level 2 complete. Inspector passed rough electrical.\nDelivery of drywall moved to Monday.', photos: 4 },
  install_ticket: { number: 'WO-2026-00044', kindLabel: 'Install', date: '2026-10-23', customer, summary: 'Install LVP — kitchen and hall', lines: [{ description: 'LVP plank', qty: 420, uom: 'SF', amountCents: null }], showPrices: false, checklist: ['Transitions installed', 'Baseboard reset', 'Site cleaned'] },
  purchase_order: { number: 'PO-HR-2026-0102', date: '2026-10-22', jobName: 'Rivera kitchen', vendor: { name: 'Midwest Cabinet Supply', email: 'orders@mcs.test' }, shipTo: '1412 Grand Ave', lines, totalCents: 1170000 },
  buyers_order: { number: 'Q-2026-0091 v1', date: '2026-10-22', validUntil: '2026-10-29', customer: { name: 'Lee Farms' }, lines: [{ description: '2024 Kubota M7-172', qty: 1, unitCents: 18900000, amountCents: 18900000 }], trades: [{ description: '2016 JD 6155R', allowanceCents: 6500000, payoffCents: 1200000 }], products: [{ description: 'Extended powertrain 5 yr', priceCents: 420000 }], totals: { saleCents: 18900000, feesCents: 35000, productsCents: 420000, taxCents: 0, cashPriceCents: 19355000, tradeAllowanceCents: 6500000, tradePayoffCents: 1200000, depositsCents: 500000, balanceDueCents: 13555000 } },
  draw_request: { drawNo: 4, periodEnd: '2026-10-31', date: '2026-11-02', jobName: 'Swan Creek lots 1–12', lender: { name: 'West Bank' }, loanNumber: 'CL-88213', requestedCents: 41200000, retainageHeldCents: 2060000, equityAppliedCents: 0 },
  lien_waiver: { waiverType: 'unconditional_progress', date: '2026-10-24', claimant: { name: 'Precision Electric Inc.' }, customer: { name: 'Heartland Remodeling' }, jobName: 'Clive office TI', jobAddress: '1800 NW 114th St', throughDate: '2026-09-30', amountCents: 2875000 },
};

describe('templates render to branded PDFs', () => {
  for (const key of TEMPLATE_KEYS) {
    it(`${key}`, async () => {
      const r = await renderTemplate(key, SAMPLES[key] as never, ctx());
      const doc = await PDFDocument.load(r.bytes);
      expect(doc.getPageCount()).toBe(r.pageCount);
      expect(doc.getTitle()).toBe(r.title);
      expect(r.fileName).toMatch(/\.pdf$/);
      expect(r.anchors.length).toBeGreaterThanOrEqual(1);
      for (const a of r.anchors) {
        expect(a.page).toBeLessThan(r.pageCount);
        expect(a.y).toBeGreaterThan(40);
      }
    });
  }
  it('uses the pack vocabulary in titles (a field-service company calls it a service ticket)', async () => {
    const r = await renderTemplate('work_order', SAMPLES.work_order, ctx({ ...DEFAULT_VOCAB, work_order: 'Service ticket', estimate: 'Quote' }));
    expect(r.title).toBe('Service ticket');
    const p = await renderTemplate('proposal', SAMPLES.proposal, ctx({ ...DEFAULT_VOCAB, estimate: 'Quote' }));
    expect(p.title).toBe('Quote');
  });
  it('two customer signers + the company → three anchors, positions 1..3', async () => {
    const r = await renderTemplate('proposal', SAMPLES.proposal, ctx());
    expect(r.anchors.map((a) => a.position)).toEqual([1, 2, 3]);
  });
  it('long scopes paginate and keep footers', async () => {
    const many = Array.from({ length: 120 }, (_, i) => ({ description: `Line ${i + 1} with a long enough description to wrap across the column a second time`, qty: 1, uom: 'EA', unitCents: 1000, amountCents: 1000 }));
    const r = await renderTemplate('purchase_order', { ...SAMPLES.purchase_order, lines: many, totalCents: 120000 }, ctx());
    expect(r.pageCount).toBeGreaterThan(2);
  });
  it('money and dates format without time-zone drift', () => {
    expect(usd(1234567)).toBe('$12,345.67');
    expect(usd(-5)).toBe('($0.05)');
    expect(usd(null)).toBe('-');
    expect(fmtDate('2026-01-01')).toBe('January 1, 2026');
  });
  it('characters outside the standard fonts are folded, never thrown', async () => {
    const d = await PDFDocument.create();
    const f = await d.embedFont(StandardFonts.Helvetica);
    expect(winAnsi(f, 'Price → $5 ≥ cost — ok 你好')).toBe('Price -> $5 >= cost — ok ??');
  });
});

describe('signed PDF + audit certificate', () => {
  it('stamps each signer on their anchor and appends the certificate; hash checked first', async () => {
    const r = await renderTemplate('change_order', { ...SAMPLES.change_order, customerSigners: ['Pat Rivera'] }, ctx());
    const original = r.bytes;
    const signed = await buildSignedPdf({
      original, expectedSha256: sha256Hex(original), envelopeId: '7f1d2c3b-0000-4000-8000-000000000001', title: 'CO-2026-0007',
      companyName: 'Heartland Remodeling', sentAt: '2026-10-22T15:00:00Z', completedAt: '2026-10-22T16:30:00Z', senderName: 'Dana Lee',
      consentText: 'I agree to sign electronically.',
      signers: [
        { position: 1, name: 'Pat Rivera', email: 'pat@example.test', phone: null, roleLabel: 'Owner', typedName: 'Pat Rivera', signaturePng: PNG, signedAt: '2026-10-22T16:00:00Z', consentedAt: '2026-10-22T16:00:00Z', consentVersion: 'esign-consent-v1', ip: '203.0.113.9', userAgent: 'Mozilla/5.0' },
        { position: 2, name: 'Dana Lee', email: 'dana@hr.test', phone: null, roleLabel: null, typedName: 'Dana Lee', signaturePng: PNG, signedAt: '2026-10-22T16:30:00Z', consentedAt: '2026-10-22T16:30:00Z', consentVersion: 'esign-consent-v1', ip: '198.51.100.7', userAgent: 'Safari' },
      ],
      events: [
        { at: '2026-10-22T15:00:00Z', event: 'sent', signerName: null, ip: null },
        { at: '2026-10-22T15:10:00Z', event: 'viewed', signerName: 'Pat Rivera', ip: '203.0.113.9' },
        { at: '2026-10-22T16:00:00Z', event: 'signed', signerName: 'Pat Rivera', ip: '203.0.113.9' },
        { at: '2026-10-22T16:30:00Z', event: 'completed', signerName: null, ip: null },
      ],
      anchors: r.anchors,
    });
    const doc = await PDFDocument.load(signed.bytes);
    expect(signed.pageCount).toBe(r.pageCount + signed.certificatePages);
    expect(doc.getPageCount()).toBe(signed.pageCount);
    expect(signed.sha256).toBe(sha256Hex(signed.bytes));
    expect(signed.sha256).not.toBe(sha256Hex(original));
    expect(doc.getTitle()).toBe('CO-2026-0007 (signed)');
  });
  it('refuses when the stored bytes are not the version that was sent', async () => {
    const r = await renderTemplate('daily_report', SAMPLES.daily_report, ctx());
    await expect(buildSignedPdf({
      original: r.bytes, expectedSha256: 'a'.repeat(64), envelopeId: 'e', title: 't', companyName: 'c', sentAt: null, completedAt: '2026-10-22T16:30:00Z',
      senderName: 's', consentText: 'x', signers: [], events: [],
    })).rejects.toBeInstanceOf(HashMismatchError);
  });
});

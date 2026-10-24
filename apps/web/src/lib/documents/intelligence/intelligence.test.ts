/**
 * Document intelligence — the pure pieces: PDF text-layer sniffer, the deterministic
 * classifier (AI-off path), the AI-answer normalizer, the AI + rules merge, the company
 * suggestion, and the routing table / permission map (FPB-document-intelligence §5, §9).
 */
import { describe, it, expect } from 'vitest';
import { makePdf } from '@/test/pdf-fixture';
import { decodeHex, decodeLiteral, extractPdfText, readability, textFromContentStream } from './pdf-text';
import {
  classifyByName,
  classifyByText,
  classifyDeterministic,
  counterpartyFromText,
  keyDatesFromText,
  largestAmountCents,
  mergeClass,
  parseLooseDate,
  suggestCompany,
} from './rules';
import { dollarsToCentsLoose, normalizeAiClassification } from './ai-classify';
import { CLASS_TARGETS, DOC_CLASSES, TARGETS, foundMessage, mapDocClass, presetFromDocType, classFromIntakeType } from './types';
import { retryDelayMinutes, isEligible } from './service';
import { effectiveMediaType, readTextSample, sha256Hex } from './text';

const LEASE_LINES = [
  'COMMERCIAL LEASE AGREEMENT',
  'This Lease is made between Acme Properties LLC ("Lessor") and Merit SPE 2 LLC ("Lessee").',
  'Premises: 123 Main Street, Suite 200, Des Moines, Iowa (4,200 square feet).',
  'Commencement Date: March 1, 2025. Expiration Date: February 28, 2030.',
  'Base Rent: $8,500.00 per month, payable in advance. Security Deposit: $17,000.00.',
];

describe('pdf-text', () => {
  it('reads the text layer of a FlateDecode content stream', () => {
    const t = extractPdfText(makePdf(LEASE_LINES));
    expect(t).toContain('COMMERCIAL LEASE AGREEMENT');
    expect(t).toContain('Lessee');
    expect(readability(t)).toBeGreaterThan(0.9);
  });
  it('reads uncompressed streams and the Info title', () => {
    const t = extractPdfText(makePdf(['Invoice Number 1001'], { compress: false, title: 'Scan 2024' }));
    expect(t).toContain('Scan 2024');
    expect(t).toContain('Invoice Number 1001');
  });
  it('returns empty for non-PDFs and image-only PDFs, never throws', () => {
    expect(extractPdfText(Buffer.from('hello world'))).toBe('');
    expect(extractPdfText(Buffer.from('%PDF-1.4\n4 0 obj << /Length 3 /Filter /DCTDecode >>\nstream\nabc\nendstream\n'))).toBe('');
    expect(extractPdfText(Buffer.from('%PDF-1.4\n4 0 obj << /Length 3 /Filter /FlateDecode >>\nstream\nnot-zlib\nendstream\n'))).toBe('');
  });
  it('decodes literal escapes, hex and TJ kerning', () => {
    expect(decodeLiteral('a\\(b\\)\\101')).toBe('a(b)A');
    expect(decodeHex('00480069')).toBe('Hi');
    expect(textFromContentStream('BT [(Lea)-20(se)-400(Agreement)] TJ ET')).toContain('Lease Agreement');
  });
});

describe('deterministic classifier (AI off)', () => {
  it('AC1: a scanner-named PDF with a lease text layer is a lease by rules alone', () => {
    const pdf = makePdf(LEASE_LINES);
    const s = readTextSample(pdf, effectiveMediaType(pdf, 'application/pdf', '20240912122602102.pdf'), '20240912122602102.pdf');
    const r = classifyDeterministic({ fileName: '20240912122602102.pdf', text: s.text, cells: s.cells });
    expect(r.docClass).toBe('lease');
    expect(r.confidence).toBeGreaterThanOrEqual(0.6);
  });
  it('AC2: no text and an uninformative name → other at 0', () => {
    const r = classifyDeterministic({ fileName: '20240912122602102.pdf', text: '', cells: [] });
    expect(r).toEqual({ docClass: 'other', confidence: 0, reason: '' });
  });
  it('types W-9s strongly enough to keep them away from AI', () => {
    const r = classifyByText('Form W-9 (Rev. March 2024) Request for Taxpayer Identification Number and Certification. Exempt payee code. Backup withholding.');
    expect(r.docClass).toBe('w9');
    expect(r.confidence).toBeGreaterThanOrEqual(0.8);
  });
  it.each([
    ['PROMISSORY NOTE $300,000.00. Borrower promises to pay Lender the principal sum with interest. Maturity Date', 'loan'],
    ['CERTIFICATE OF LIABILITY INSURANCE ACORD 25 PRODUCER INSURER A: Certificate holder each occurrence', 'coi'],
    ['COMMON POLICY DECLARATIONS Named Insured Policy Period Premium Deductible', 'insurance_policy'],
    ['Payroll Register Pay Period Check Date Gross Pay FICA Medicare Net Pay', 'payroll_register'],
    ['Account Statement Statement Period Beginning Balance Deposits and Credits Withdrawals Ending Balance Member FDIC', 'bank_statement'],
    ['PURCHASE ORDER P.O. Number 4410 Ship To Qty Unit Price Buyer', 'purchase_order'],
    ['STATEMENT OF WORK Client Contractor Deliverables Milestones Payment Schedule', 'customer_contract'],
    ['Order Form Subscription Term auto-renew seats per user annual plan Software as a Service', 'subscription'],
    ['Form 1099-NEC Nonemployee compensation PAYER\'S TIN RECIPIENT\'S TIN', 'form_1099'],
    ['Articles of Organization filed with the Secretary of State registered agent members', 'formation'],
    ['INVOICE Invoice Number 7781 Bill To Amount Due Remit To Due Date Subtotal Sales Tax', 'vendor_bill'],
    ['INVOICE Invoice Number 7781 Bill To Amount Due Remit To — Model No. X200 forklift Serial Number 99812', 'fixed_asset_invoice'],
  ])('text: %s → %s', (text, want) => {
    expect(classifyByText(text).docClass).toBe(want);
  });
  it('file names (Smart Intake rules + this vocabulary)', () => {
    expect(classifyByName('Office Lease - 123 Main.pdf').docClass).toBe('lease');
    expect(classifyByName('Acme W9.pdf').docClass).toBe('w9');
    expect(classifyByName('2025 1099 forms.pdf').docClass).toBe('form_1099');
    expect(classifyByName('PO 10442.pdf').docClass).toBe('purchase_order');
    expect(classifyByName('2024 tax return 1120S.pdf').docClass).toBe('tax_document');
    expect(classifyByName('scan0001.pdf').docClass).toBe('other');
  });
  it('agreement between name and text boosts confidence', () => {
    const t = classifyDeterministic({ fileName: 'lease.pdf', text: LEASE_LINES.join('\n') });
    const only = classifyDeterministic({ fileName: 'x.pdf', text: LEASE_LINES.join('\n') });
    expect(t.docClass).toBe('lease');
    expect(t.confidence).toBeGreaterThan(only.confidence);
  });
  it('spreadsheets use the Smart Intake sniff', () => {
    const csv = Buffer.from('Account,Debit,Credit\n1000 Cash,100,\n3000 Equity,,100\n');
    const s = readTextSample(csv, 'text/csv', 'export.csv');
    expect(classifyDeterministic({ fileName: 'export.csv', text: s.text, cells: s.cells }).docClass).toBe('ledger_report');
  });
});

describe('hints from text', () => {
  it('dates, counterparty, amount', () => {
    const text = LEASE_LINES.join('\n');
    expect(keyDatesFromText(text)).toMatchObject({ effective_date: '2025-03-01', expiration_date: '2030-02-28' });
    expect(largestAmountCents(text)).toBe(1_700_000);
    expect(counterpartyFromText('Lessor: Acme Properties LLC\nLessee: Merit', 'lease')).toBe('Acme Properties LLC');
    expect(counterpartyFromText(text, 'lease')).toBe('Acme Properties LLC');
    expect(counterpartyFromText('This Note is between Merit and First State Bank ("Lender").', 'loan')).toBe('First State Bank');
    expect(parseLooseDate('09/17/2024')).toBe('2024-09-17');
    expect(parseLooseDate('Feb 30, 2024')).toBeNull();
  });
});

describe('AI answer normalizer + merge', () => {
  it('maps loose answers; unsure → other; amounts to integer cents', () => {
    const a = normalizeAiClassification({ doc_class: 'Lease Agreement', confidence: 0.92, amount: '8,500.00', key_dates: { effective_date: 'March 1, 2025', junk: 'x' }, company_name: 'Merit SPE 2 LLC' });
    expect(a.docClass).toBe('lease');
    expect(a.amountCents).toBe(850_000);
    expect(a.keyDates).toEqual({ effective_date: '2025-03-01' });
    expect(normalizeAiClassification({ doc_class: 'loan', confidence: 0.2 }).docClass).toBe('other');
    expect(normalizeAiClassification({ doc_class: 'hallucinated_type', confidence: 0.99 }).docClass).toBe('other');
    expect(dollarsToCentsLoose(0.1 + 0.2)).toBe(30);
    expect(dollarsToCentsLoose('abc')).toBeNull();
  });
  it('merge rules', () => {
    const rules = { docClass: 'lease' as const, confidence: 0.9, reason: '' };
    expect(mergeClass(null, rules)).toEqual({ docClass: 'lease', confidence: 0.9, source: 'rules' });
    expect(mergeClass({ docClass: 'other', confidence: 0.3, summary: null }, rules).source).toBe('rules');
    expect(mergeClass({ docClass: 'lease', confidence: 0.7, summary: null }, rules)).toEqual({ docClass: 'lease', confidence: 0.9, source: 'ai' });
    expect(mergeClass({ docClass: 'loan', confidence: 0.5, summary: null }, rules).docClass).toBe('lease');
    expect(mergeClass({ docClass: 'loan', confidence: 0.8, summary: null }, rules).docClass).toBe('loan');
    expect(mapDocClass('W-9')).toBe('w9');
  });
});

describe('company suggestion (AC7)', () => {
  const cos = [
    { id: 'a', name: 'Merit Management Group' },
    { id: 'b', name: 'Merit SPE 2 LLC' },
    { id: 'c', name: 'Heritage Interiors' },
  ];
  it('upload company first, then the only company, then a named one (longest wins)', () => {
    expect(suggestCompany(cos, { uploadLocationId: 'c', text: 'Merit SPE 2' })).toEqual({ locationId: 'c', source: 'upload' });
    expect(suggestCompany([cos[0]], {})).toEqual({ locationId: 'a', source: 'single_company' });
    expect(suggestCompany(cos, { text: 'between Acme and Merit SPE 2, L.L.C. ("Lessee")' })).toEqual({ locationId: 'b', source: 'rules' });
    expect(suggestCompany(cos, { aiCompanyName: 'Heritage Interiors, Inc.' })).toEqual({ locationId: 'c', source: 'ai' });
    expect(suggestCompany(cos, { text: 'nothing relevant' })).toEqual({ locationId: null, source: null });
  });
});

describe('routing table + permissions (AC8)', () => {
  it('every class routes to known targets; the module gates are the modules’ own', () => {
    for (const c of DOC_CLASSES) for (const k of CLASS_TARGETS[c]) expect(TARGETS[k]).toBeDefined();
    expect(CLASS_TARGETS.lease).toEqual(['lease']);
    expect(CLASS_TARGETS.fixed_asset_invoice).toEqual(['fixed_asset', 'bill']);
    expect(TARGETS.lease.permission).toEqual({ feature: 'journal_entries', action: 'create' });
    expect(TARGETS.debt_instrument.permission).toEqual({ feature: 'journal_entries', action: 'post' });
    expect(TARGETS.bill.permission).toEqual({ feature: 'bills', action: 'create' });
    expect(TARGETS.vendor_w9.permission).toEqual({ feature: 'vendors', action: 'edit' });
    expect(TARGETS.vendor_w9.extractorFeature).toBeNull();
  });
  it('messages, presets, intake mapping, retry backoff, eligibility', () => {
    expect(foundMessage('lease', ['lease'], false)).toBe('We found a lease — added to Leases for your review.');
    expect(foundMessage('insurance_policy', ['insurance_policy'], true)).toMatch(/^We found an insurance policy — added to Insurance for your review\. AI will read/);
    expect(foundMessage('payroll_register', ['payroll_register'], false)).toMatch(/linked to Payroll/);
    expect(presetFromDocType('LEASE')).toEqual({ docClass: 'lease', confidence: 1, source: 'user' });
    expect(presetFromDocType('OTHER')).toBeNull();
    expect(classFromIntakeType('INSURANCE_POLICY')).toBe('insurance_policy');
    expect(retryDelayMinutes('unavailable', 3)).toBe(15);
    expect(retryDelayMinutes('budget_blocked', 1)).toBe(60);
    expect(retryDelayMinutes('failed', 3)).toBe(60);
    expect(retryDelayMinutes('failed', 20)).toBe(360);
    expect(isEligible({ entity_type: null })).toBe(true);
    expect(isEligible({ entity_type: 'location' })).toBe(true);
    expect(isEligible({ entity_type: 'lease' })).toBe(false);
    expect(sha256Hex(Buffer.from('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

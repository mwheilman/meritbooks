/**
 * Security review H4 — the taxpayer-ID screen and the redactor (pure).
 */
import { describe, it, expect } from 'vitest';
import { containsTin, redactDeep, redactFields, redactTin } from './redact';
import { screenForTin, tinFormFromName, tinFormFromText, tinScreenedClass, TIN_CLASSES } from './tin-guard';
import { presentIntel, presentProposal, presentProposalSummary } from './present';
import { ACCEPT_RECORD_TYPES, acceptableRecordType, TARGET_KINDS, TARGETS, type IntelligenceDto, type ProposalDto } from './types';

describe('redactTin', () => {
  it('masks SSN / ITIN / EIN shapes, keeping the last four', () => {
    expect(redactTin('SSN 123-45-6789 on file')).toBe('SSN *****6789 on file');
    expect(redactTin('id 123-45-6789')).toBe('id ***-**-6789');
    expect(redactTin('ITIN 912-78-1234')).toBe('ITIN *****1234');
    expect(redactTin('vendor 912-78-1234')).toBe('vendor ***-**-1234');
    expect(redactTin('EIN: 12-3456789')).toBe('EIN: *****6789');
    expect(redactTin('acct 12-3456789')).toBe('acct **-***6789');
    expect(redactTin('Taxpayer Identification Number 123456789')).toBe('Taxpayer Identification Number *****6789');
    expect(redactTin('social security number: 123 45 6789')).toBe('social security number: *****6789');
    expect(redactTin('Tax ID #987654321')).toBe('Tax ID #*****4321');
  });

  it('leaves money, dates, phone numbers, zips and unlabelled 9-digit runs alone', () => {
    const keep = [
      'Total $123,456,789.00 due 2025-03-01',
      'Call (515) 555-1234 or 515-555-1234',
      'Des Moines IA 50309-1234',
      'Routing 073000228 account 1234567890',
      'Invoice 2024-0915 dated 03/01/2025',
      'Qty 100 25 1500',
      'Tin roof, 2 sheets, 123456789 units',
    ];
    for (const s of keep) expect(redactTin(s), s).toBe(s);
    expect(containsTin(keep.join(' '))).toBe(false);
    expect(containsTin('SSN 123-45-6789')).toBe(true);
  });

  it('redacts recursively and only the named fields of a row', () => {
    const v = redactDeep({ a: 'EIN 12-3456789', b: [{ c: '123-45-6789' }], n: 5, z: null });
    expect(v).toEqual({ a: 'EIN *****6789', b: [{ c: '***-**-6789' }], n: 5, z: null });
    const row = redactFields({ id: '12-3456789', summary: 'x 12-3456789', payload: { t: '12-3456789' } }, ['summary', 'payload']);
    expect(row).toEqual({ id: '12-3456789', summary: 'x **-***6789', payload: { t: '**-***6789' } });
  });
});

describe('tinFormFromText / tinFormFromName', () => {
  it('recognises the TIN-bearing forms by their own text', () => {
    expect(tinFormFromText('Form W-9 Request for Taxpayer Identification Number and Certification')).toMatchObject({ form: 'W-9', docClass: 'w9' });
    expect(tinFormFromText('Form W-8BEN Certificate of Foreign Status of Beneficial Owner')).toMatchObject({ form: 'W-8' });
    expect(tinFormFromText("Form 1099-NEC Nonemployee Compensation PAYER'S TIN")).toMatchObject({ form: '1099', docClass: 'form_1099' });
    expect(tinFormFromText('W-2 Wage and Tax Statement')).toMatchObject({ form: 'W-2', docClass: 'tax_document' });
    expect(tinFormFromText("Form W-4 Employee's Withholding Certificate")).toMatchObject({ form: 'W-4' });
    expect(tinFormFromText('Form SS-4 Application for Employer Identification Number')).toMatchObject({ form: 'SS-4', docClass: 'formation' });
    expect(tinFormFromText('Thank you for applying. We assigned you an Employer Identification Number (EIN)')).toMatchObject({ form: 'CP-575' });
    expect(tinFormFromText("Form 941 Employer's QUARTERLY Federal Tax Return")).toMatchObject({ form: '941/940' });
    expect(tinFormFromText('Form 1120-S U.S. Income Tax Return for an S Corporation')).toMatchObject({ form: 'tax return' });
  });

  it('does not flag a lease or MSA that merely asks for a W-9', () => {
    expect(tinFormFromText('LEASE AGREEMENT. Tenant shall deliver a completed IRS Form W-9 with its taxpayer identification number before the first payment.')).toBeNull();
    expect(tinFormFromText('Invoice 1099 for consulting')).toBeNull();
  });

  it('file names', () => {
    for (const n of ['Bolt W9.pdf', 'bolt_w-9.png', 'BoltW9.jpg', 'w8ben acme.pdf', '2025 1099s.pdf', 'John W2 2025.pdf', 'w-4 new hire.jpg', 'SS4.pdf', 'CP575 EIN letter.pdf', 'EIN confirmation.pdf', 'Form 941 Q3.pdf', '941 Q2 2025.pdf', 'tax return 2024.pdf', 'jane ssn card.jpg']) {
      expect(tinFormFromName(n), n).not.toBeNull();
    }
    for (const n of ['Office Lease.pdf', 'Invoice 941.pdf', 'IMG_4471.png', 'Stein LLC invoice.pdf', 'scan0001.pdf', 'Q2 2025 budget.xlsx']) {
      expect(tinFormFromName(n), n).toBeNull();
    }
  });
});

describe('screenForTin', () => {
  const base = { fileName: 'scan.pdf', screenText: '', readableText: '', rulesClass: 'other' as const, rulesConfidence: 0, userClass: null };

  it('a photo / scan with nothing safe to go on → unknown (manual review)', () => {
    expect(screenForTin(base)).toEqual({ verdict: 'unknown' });
    expect(screenForTin({ ...base, fileName: 'IMG_4471.png' })).toEqual({ verdict: 'unknown' });
  });

  it('a readable text layer, a non-tax type a person chose, or a confident non-tax file name → clear', () => {
    const text = 'COMMERCIAL LEASE AGREEMENT between Acme Properties LLC (Lessor) and Co (Lessee).';
    expect(screenForTin({ ...base, screenText: text, readableText: text })).toEqual({ verdict: 'clear', via: 'text' });
    expect(screenForTin({ ...base, userClass: 'lease' })).toEqual({ verdict: 'clear', via: 'user' });
    expect(screenForTin({ ...base, fileName: 'Office Lease.png' })).toEqual({ verdict: 'clear', via: 'name' });
  });

  it('TIN signals win over everything (text, a person choosing a tax type, the file name, the rules)', () => {
    const w9 = 'Request for Taxpayer Identification Number and Certification';
    expect(screenForTin({ ...base, screenText: w9, readableText: w9, userClass: 'lease' })).toMatchObject({ verdict: 'tin_form', via: 'text' });
    expect(screenForTin({ ...base, userClass: 'w9' })).toMatchObject({ verdict: 'tin_form', via: 'user' });
    expect(screenForTin({ ...base, fileName: 'acme w9.png' })).toMatchObject({ verdict: 'tin_form', via: 'name', docClass: 'w9' });
    expect(screenForTin({ ...base, rulesClass: 'form_1099', rulesConfidence: 0.85 })).toMatchObject({ verdict: 'tin_form', via: 'rules' });
    // Garbled text the classifier would discard still trips the screen.
    expect(screenForTin({ ...base, screenText: `x\u0001 ${w9} \u0002`, readableText: '' })).toMatchObject({ verdict: 'tin_form' });
  });

  it('tinScreenedClass keeps a near-certain non-tax class, else the form', () => {
    expect(tinScreenedClass({ verdict: 'tin_form', form: 'W-9', docClass: 'w9', via: 'name' }, { docClass: 'lease', confidence: 0.9 })).toEqual({ docClass: 'lease', confidence: 0.9 });
    expect(tinScreenedClass({ verdict: 'tin_form', form: 'W-2', docClass: 'tax_document', via: 'text' }, { docClass: 'payroll_register', confidence: 0.5 })).toEqual({ docClass: 'tax_document', confidence: 0.9 });
    expect(tinScreenedClass({ verdict: 'tin_form', form: null, docClass: 'w9', via: 'user' }, { docClass: 'other', confidence: 0 })).toEqual({ docClass: 'w9', confidence: 1 });
    expect(TIN_CLASSES.has('w9') && TIN_CLASSES.has('form_1099') && TIN_CLASSES.has('tax_document')).toBe(true);
  });
});

describe('present (what reaches the browser)', () => {
  it('intelligence: DTO columns only, redacted', () => {
    const row = { id: 'i', document_id: 'd', location_id: null, location_source: null, doc_class: 'lease', confidence: '0.9', class_source: 'ai', status: 'routed', ai_status: 'done', ai_attempts: 1, next_retry_at: null, counterparty: 'Acme 12-3456789', key_dates: {}, amount_cents: null, summary: 'SSN 123-45-6789', reason: null, duplicate_of: null, source: 'center', classified_at: null, updated_at: 'u', content_sha256: 'f'.repeat(64), ai_last_error: 'boom', company_hint: 'x', created_by: 'user_1' } as unknown as IntelligenceDto;
    const out = presentIntel(row) as unknown as Record<string, unknown>;
    expect(out.summary).toBe('SSN *****6789');
    expect(out.counterparty).toBe('Acme **-***6789');
    expect(out.confidence).toBe(0.9);
    for (const k of ['content_sha256', 'ai_last_error', 'company_hint', 'created_by']) expect(out).not.toHaveProperty(k);
  });

  it('proposal summary has no payload; detail payload is redacted', () => {
    const p = { id: 'p', document_id: 'd', location_id: null, target_kind: 'lease', mode: 'staged', status: 'pending', extract_state: 'done', payload: { lease: { lessor_tin: '12-3456789' } }, title: 't', summary: null, confidence: 0.5, native_table: null, native_id: null, target_href: '/leases', accepted_target_type: null, accepted_target_id: null, last_error: null, created_at: 'c' } as ProposalDto;
    expect(presentProposalSummary(p)).not.toHaveProperty('payload');
    expect(presentProposal(p).payload).toEqual({ lease: { lessor_tin: '**-***6789' } });
  });
});

describe('ACCEPT_RECORD_TYPES', () => {
  it('each kind closes only onto its own record type (a contract also onto an invoice)', () => {
    for (const k of TARGET_KINDS) expect(acceptableRecordType(k, TARGETS[k].recordType), k).toBe(true);
    expect(acceptableRecordType('lease', 'bill')).toBe(false);
    expect(acceptableRecordType('bill', 'vendor')).toBe(false);
    expect(acceptableRecordType('vendor_w9', 'vendor')).toBe(true);
    expect(acceptableRecordType('insurance_policy', 'policy')).toBe(true);
    expect(ACCEPT_RECORD_TYPES.customer_contract).toEqual(['customer_contract', 'invoice']);
  });
});

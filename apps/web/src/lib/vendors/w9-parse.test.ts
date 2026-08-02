import { describe, it, expect } from 'vitest';
import {
  normalizeW9Extraction,
  mapEntityType,
  mapLlcTaxClass,
  infer1099Eligibility,
  maskTin,
  tinLast4,
  inferTinType,
} from './w9-parse';

describe('mapEntityType — W-9 line-3 classification mapping', () => {
  it('maps direct enum values through unchanged', () => {
    expect(mapEntityType('C_CORP')).toBe('C_CORP');
    expect(mapEntityType('llc')).toBe('LLC');
  });

  it('classifies free-form language', () => {
    expect(mapEntityType('Individual/sole proprietor or single-member LLC')).toBe('INDIVIDUAL_SOLE_PROP');
    expect(mapEntityType('C Corporation')).toBe('C_CORP');
    expect(mapEntityType('S Corporation')).toBe('S_CORP');
    expect(mapEntityType('Partnership')).toBe('PARTNERSHIP');
    expect(mapEntityType('Trust/estate')).toBe('TRUST_ESTATE');
  });

  it('treats an LLC taxed as a corporation as an LLC (treatment carried separately)', () => {
    expect(mapEntityType('Limited liability company taxed as C corp')).toBe('LLC');
  });

  it('falls back to OTHER on unknown / non-string', () => {
    expect(mapEntityType('government entity')).toBe('OTHER');
    expect(mapEntityType('')).toBe('OTHER');
    expect(mapEntityType(null)).toBe('OTHER');
    expect(mapEntityType(42)).toBe('OTHER');
  });
});

describe('mapLlcTaxClass', () => {
  it('normalizes the C/S/P letter and prose', () => {
    expect(mapLlcTaxClass('C')).toBe('C');
    expect(mapLlcTaxClass('s')).toBe('S');
    expect(mapLlcTaxClass('P')).toBe('P');
    expect(mapLlcTaxClass('taxed as S corp')).toBe('S');
    expect(mapLlcTaxClass('partnership')).toBe('P');
  });
  it('returns null when absent / unknown', () => {
    expect(mapLlcTaxClass(null)).toBeNull();
    expect(mapLlcTaxClass('')).toBeNull();
    expect(mapLlcTaxClass('X')).toBeNull();
  });
});

describe('infer1099Eligibility — mechanical inference from classification', () => {
  it('individuals and partnerships are reportable', () => {
    expect(infer1099Eligibility('INDIVIDUAL_SOLE_PROP', null)).toBe(true);
    expect(infer1099Eligibility('PARTNERSHIP', null)).toBe(true);
  });
  it('corporations are exempt', () => {
    expect(infer1099Eligibility('C_CORP', null)).toBe(false);
    expect(infer1099Eligibility('S_CORP', null)).toBe(false);
  });
  it('LLC depends on its elected tax class', () => {
    expect(infer1099Eligibility('LLC', 'C')).toBe(false);
    expect(infer1099Eligibility('LLC', 'S')).toBe(false);
    expect(infer1099Eligibility('LLC', 'P')).toBe(true);
    expect(infer1099Eligibility('LLC', null)).toBeNull(); // ambiguous → human decides
  });
  it('trust/estate and other are undetermined', () => {
    expect(infer1099Eligibility('TRUST_ESTATE', null)).toBeNull();
    expect(infer1099Eligibility('OTHER', null)).toBeNull();
  });
});

describe('inferTinType + maskTin — masking preserves only the last four', () => {
  it('infers EIN/SSN from formatting when no hint', () => {
    expect(inferTinType(null, '12-3456789')).toBe('EIN');
    expect(inferTinType(null, '123-45-6789')).toBe('SSN');
    expect(inferTinType('EIN', 'garbage')).toBe('EIN');
    expect(inferTinType(null, 'garbage')).toBeNull();
  });

  it('masks an EIN to last four in EIN shape', () => {
    expect(maskTin('12-3456789', 'EIN')).toBe('XX-XXX6789');
  });

  it('masks an SSN to last four in SSN shape', () => {
    expect(maskTin('123-45-6789', 'SSN')).toBe('XXX-XX-6789');
  });

  it('masks an unknown-type TIN generically', () => {
    expect(maskTin('987654321', null)).toBe('XXXXX4321');
  });

  it('returns null when there are fewer than four digits (nothing safe to show)', () => {
    expect(maskTin('12', 'EIN')).toBeNull();
    expect(maskTin(null, 'EIN')).toBeNull();
  });

  it('tinLast4 extracts the trailing four digits', () => {
    expect(tinLast4('12-3456789')).toBe('6789');
    expect(tinLast4('999')).toBeNull();
    expect(tinLast4(null)).toBeNull();
  });
});

describe('normalizeW9Extraction — full proposal', () => {
  it('maps a clean corporation W-9 and marks it 1099-exempt, TIN masked', () => {
    const p = normalizeW9Extraction({
      legal_name: 'Acme Construction Inc',
      business_name: 'Acme',
      entity_type: 'C Corporation',
      tin: '12-3456789',
      tin_type: 'EIN',
      address_line1: '100 Main St',
      city: 'Des Moines',
      state: 'IA',
      zip: '50309',
      confidence: { legal_name: 0.98, entity_type: 0.95, tin: 0.9, address: 0.9 },
    });
    expect(p.legal_name).toBe('Acme Construction Inc');
    expect(p.entity_type).toBe('C_CORP');
    expect(p.is_1099_eligible_signal).toBe(false);
    expect(p.tin_masked).toBe('XX-XXX6789');
    expect(p.tin_last4).toBe('6789');
    // raw TIN must NOT be present anywhere on the proposal
    expect(JSON.stringify(p)).not.toContain('3456789'.slice(0, 5)); // '34567'
    expect(p.lowConfidenceFields).not.toContain('legal_name');
  });

  it('leaves undeterminable fields blank and flags them (never guessed)', () => {
    const p = normalizeW9Extraction({
      legal_name: null,
      entity_type: 'unknown blob',
      tin: null,
      confidence: {},
    });
    expect(p.legal_name).toBeNull();
    expect(p.business_name).toBeNull();
    expect(p.entity_type).toBe('OTHER');
    expect(p.tin_masked).toBeNull();
    expect(p.is_1099_eligible_signal).toBeNull();
    expect(p.lowConfidenceFields).toEqual(
      expect.arrayContaining(['legal_name', 'entity_type', 'tin', 'is_1099_eligible']),
    );
  });

  it('flags a low-confidence entity type even when it maps', () => {
    const p = normalizeW9Extraction({
      legal_name: 'Jane Doe',
      entity_type: 'Individual',
      tin: '123-45-6789',
      confidence: { legal_name: 0.9, entity_type: 0.3, tin: 0.9 },
    });
    expect(p.entity_type).toBe('INDIVIDUAL_SOLE_PROP');
    expect(p.is_1099_eligible_signal).toBe(true);
    expect(p.lowConfidenceFields).toContain('entity_type');
  });

  it('never throws on a malformed shape', () => {
    expect(() => normalizeW9Extraction(null)).not.toThrow();
    expect(() => normalizeW9Extraction('nope')).not.toThrow();
    const p = normalizeW9Extraction(undefined);
    expect(p.entity_type).toBe('OTHER');
  });
});

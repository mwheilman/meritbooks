import { describe, it, expect } from 'vitest';
import {
  normalizeFormation,
  normalizeMembers,
  mapEntityType,
  mapState,
  normalizeEin,
  ENTITY_TYPES,
} from './parse-formation';

describe('mapEntityType', () => {
  it('maps loose entity-form strings to the canonical enum', () => {
    expect(mapEntityType('limited liability company')).toBe('LLC');
    expect(mapEntityType('L.L.C.')).toBe('LLC');
    expect(mapEntityType('LLC')).toBe('LLC');
    expect(mapEntityType('S corporation')).toBe('S_CORP');
    expect(mapEntityType('subchapter S')).toBe('S_CORP');
    expect(mapEntityType('C-Corp')).toBe('C_CORP');
    expect(mapEntityType('Corporation')).toBe('C_CORP');
    expect(mapEntityType('Incorporated')).toBe('C_CORP');
    expect(mapEntityType('Limited Partnership')).toBe('PARTNERSHIP');
    expect(mapEntityType('LLP')).toBe('PARTNERSHIP');
    expect(mapEntityType('sole proprietorship')).toBe('SOLE_PROP');
    expect(mapEntityType('501(c)(3) nonprofit')).toBe('NONPROFIT');
    expect(mapEntityType('not-for-profit')).toBe('NONPROFIT');
  });

  it('returns null (never guesses) when the form cannot be determined', () => {
    expect(mapEntityType(null)).toBeNull();
    expect(mapEntityType('')).toBeNull();
    expect(mapEntityType('   ')).toBeNull();
    expect(mapEntityType('something unclear')).toBeNull();
    expect(mapEntityType(42)).toBeNull();
  });

  it('only ever returns a value in the canonical set', () => {
    for (const v of ['LLC', 'corp', 'S corp', 'partnership', 'nonprofit', 'sole prop', 'huh']) {
      const out = mapEntityType(v);
      expect(out === null || ENTITY_TYPES.includes(out)).toBe(true);
    }
  });
});

describe('mapState', () => {
  it('resolves spelled-out states to two-letter codes', () => {
    expect(mapState('Delaware')).toBe('DE');
    expect(mapState('new york')).toBe('NY');
    expect(mapState('DE')).toBe('DE');
    expect(mapState('Washington D.C.')).toBe('DC');
  });
  it('keeps an unresolvable raw name and nulls empties', () => {
    expect(mapState('Ontario')).toBe('Ontario');
    expect(mapState(null)).toBeNull();
    expect(mapState('  ')).toBeNull();
  });
});

describe('normalizeEin', () => {
  it('formats a 9-digit EIN to NN-NNNNNNN', () => {
    expect(normalizeEin('123456789')).toBe('12-3456789');
    expect(normalizeEin('12-3456789')).toBe('12-3456789');
    expect(normalizeEin('EIN: 98 7654321')).toBe('98-7654321');
  });
  it('keeps a non-9-digit value as-is and nulls empties', () => {
    expect(normalizeEin('pending')).toBe('pending');
    expect(normalizeEin(null)).toBeNull();
    expect(normalizeEin('')).toBeNull();
  });
});

describe('normalizeMembers', () => {
  it('maps names/roles and clamps ownership 0-100, dropping unnamed rows', () => {
    const members = normalizeMembers([
      { name: 'Jane Doe', role: 'Managing Member', ownership_pct: 60 },
      { name: 'John Roe', title: 'Member', percentage: '40%' },
      { name: '  ', role: 'ghost' }, // dropped — no usable name
      { owner: 'Overclaimer', ownership: 150 }, // clamped to 100
      { name: 'Underclaimer', ownership_pct: -10 }, // clamped to 0
    ]);
    expect(members).toHaveLength(4);
    expect(members[0]).toEqual({ name: 'Jane Doe', role: 'Managing Member', ownership_pct: 60 });
    expect(members[1]).toEqual({ name: 'John Roe', role: 'Member', ownership_pct: 40 });
    expect(members[2]).toEqual({ name: 'Overclaimer', role: null, ownership_pct: 100 });
    expect(members[3].ownership_pct).toBe(0);
  });
  it('never throws on a malformed shape', () => {
    expect(normalizeMembers(null)).toEqual([]);
    expect(normalizeMembers('nope')).toEqual([]);
    expect(normalizeMembers([null, 42, {}])).toEqual([]);
  });
});

describe('normalizeFormation', () => {
  it('maps a well-formed extraction and normalizes each field', () => {
    const f = normalizeFormation({
      formation: {
        legal_name: 'Acme Holdings, LLC',
        entity_type: 'limited liability company',
        ein: '12-3456789',
        formation_state: 'Delaware',
        formation_date: '2024-03-15',
        registered_agent: 'Corporation Service Company',
        members: [
          { name: 'Jane Doe', role: 'Managing Member', ownership_pct: 100 },
        ],
        snippet: 'Acme Holdings, LLC, a Delaware limited liability company (EIN 12-3456789)',
        document_note: null,
        confidence: {
          legal_name: 0.99,
          entity_type: 0.95,
          ein: 0.98,
          formation_state: 0.97,
          formation_date: 0.9,
          registered_agent: 0.85,
        },
      },
    });
    expect(f.legal_name).toBe('Acme Holdings, LLC');
    expect(f.entity_type).toBe('LLC');
    expect(f.ein).toBe('12-3456789');
    expect(f.formation_state).toBe('DE');
    expect(f.formation_date).toBe('2024-03-15');
    expect(f.registered_agent).toBe('Corporation Service Company');
    expect(f.members).toHaveLength(1);
    expect(f.members[0].name).toBe('Jane Doe');
    expect(f.lowConfidenceFields).toHaveLength(0);
  });

  it('leaves undeterminable fields blank and flags them', () => {
    const f = normalizeFormation({
      formation: {
        legal_name: 'Mystery Co',
        entity_type: 'unclear',
        ein: null,
        formation_state: null,
        formation_date: null,
        confidence: { legal_name: 0.9 },
      },
    });
    expect(f.entity_type).toBeNull();
    expect(f.ein).toBeNull();
    expect(f.formation_state).toBeNull();
    expect(f.formation_date).toBeNull();
    expect(f.lowConfidenceFields).toContain('entity_type');
    expect(f.lowConfidenceFields).toContain('ein');
    expect(f.lowConfidenceFields).toContain('formation_state');
    expect(f.lowConfidenceFields).toContain('formation_date');
    expect(f.lowConfidenceFields).not.toContain('legal_name');
  });

  it('flags present-but-low-confidence fields', () => {
    const f = normalizeFormation({
      formation: {
        legal_name: 'Blurry Scan LLC',
        entity_type: 'LLC',
        ein: '99-9999999',
        formation_state: 'TX',
        formation_date: '2020-01-01',
        confidence: {
          legal_name: 0.2, // present but low
          entity_type: 0.9,
          ein: 0.3, // present but low
          formation_state: 0.9,
          formation_date: 0.9,
        },
      },
    });
    expect(f.legal_name).toBe('Blurry Scan LLC');
    expect(f.lowConfidenceFields).toContain('legal_name');
    expect(f.lowConfidenceFields).toContain('ein');
    expect(f.lowConfidenceFields).not.toContain('entity_type');
  });

  it('rejects malformed dates', () => {
    const f = normalizeFormation({
      formation: { legal_name: 'X', formation_date: '03/15/2024' },
    });
    expect(f.formation_date).toBeNull();
    const bad = normalizeFormation({ formation: { legal_name: 'Y', formation_date: '2024-02-30' } });
    expect(bad.formation_date).toBeNull();
  });

  it('accepts a bare (unwrapped) object and never throws on garbage', () => {
    const bare = normalizeFormation({ legal_name: 'Bare Co', entity_type: 'S corp' });
    expect(bare.legal_name).toBe('Bare Co');
    expect(bare.entity_type).toBe('S_CORP');
    expect(() => normalizeFormation(null)).not.toThrow();
    expect(() => normalizeFormation('nonsense')).not.toThrow();
    const empty = normalizeFormation({});
    expect(empty.legal_name).toBe('');
    expect(empty.members).toEqual([]);
  });
});

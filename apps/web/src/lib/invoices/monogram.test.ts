import { describe, it, expect } from 'vitest';
import { monogram } from './monogram';

describe('monogram — the pay page letter mark', () => {
  it('skips a leading bracketed tag and punctuation', () => {
    expect(monogram('[SANDBOX] Coho Builders')).toBe('C');
    expect(monogram('[SANDBOX] Clive Power Equipment', 2)).toBe('CP');
    expect(monogram('(TEST) acme')).toBe('A');
    expect(monogram('"Quoted" Co')).toBe('Q');
    expect(monogram('...3M Partners')).toBe('3');
  });
  it('plain names', () => {
    expect(monogram('Heritage Interiors')).toBe('H');
    expect(monogram('heritage interiors', 2)).toBe('HI');
    expect(monogram('Élan Studio')).toBe('É');
  });
  it('a name that is only a tag still yields its letters; nothing usable → fallback', () => {
    expect(monogram('[SANDBOX]')).toBe('S');
    expect(monogram('')).toBe('I');
    expect(monogram(null, 1, 'M')).toBe('M');
    expect(monogram('— · —')).toBe('I');
  });
});

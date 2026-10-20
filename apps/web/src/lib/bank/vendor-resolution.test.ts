import { describe, it, expect } from 'vitest';
import { cleanVendorName, decideVendor, escapeLike, sameVendorName } from './vendor-resolution';

const AI = { id: '11111111-1111-1111-1111-111111111111', name: 'HOME DEPOT #123', display_name: 'Home Depot' };

describe('bank-feed vendor resolution', () => {
  it('keeps the AI vendor when the name is blank', () => {
    expect(decideVendor('   ', AI.id, AI)).toEqual({ kind: 'keep', vendorId: AI.id });
    expect(decideVendor(undefined, null, null)).toEqual({ kind: 'keep', vendorId: null });
  });

  it('keeps the AI vendor when the name is unchanged (name or display_name, case-insensitive)', () => {
    expect(decideVendor('home depot', AI.id, AI)).toEqual({ kind: 'keep', vendorId: AI.id });
    expect(decideVendor('  HOME   DEPOT #123 ', AI.id, AI)).toEqual({ kind: 'keep', vendorId: AI.id });
  });

  it('resolves a different typed name instead of dropping it (the bug)', () => {
    expect(decideVendor('Lowes', AI.id, AI)).toEqual({ kind: 'resolve', name: 'Lowes' });
  });

  it('resolves a typed name when there was no AI vendor', () => {
    expect(decideVendor('  Acme   Supply ', null, null)).toEqual({ kind: 'resolve', name: 'Acme Supply' });
  });

  it('normalizes and compares names', () => {
    expect(cleanVendorName('  a \n b ')).toBe('a b');
    expect(sameVendorName('ACME', 'acme ')).toBe(true);
    expect(sameVendorName(null, '')).toBe(true);
  });

  it('escapes LIKE wildcards so a name matches literally', () => {
    expect(escapeLike('50%_off\\')).toBe('50\\%\\_off\\\\');
  });
});

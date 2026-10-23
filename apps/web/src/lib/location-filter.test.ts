import { describe, it, expect } from 'vitest';
import { parseLocationFilter, reconcileClientScope } from './location-filter';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

describe('reconcileClientScope — the header client wins (1G-2)', () => {
  it('a stale company filter from the previous client is replaced by the active client', () => {
    expect(reconcileClientScope(B, A)).toBe(B);
    expect(reconcileClientScope(B, `${A},${B}`)).toBe(B);
  });
  it('a matching filter, consolidated, or no filter is left alone', () => {
    expect(reconcileClientScope(A, A)).toBeNull();
    expect(reconcileClientScope('all', `${A},${B}`)).toBeNull();
    expect(reconcileClientScope(null, `${A},${B}`)).toBeNull();
    expect(reconcileClientScope(A, null)).toBeNull();
    expect(reconcileClientScope('not-a-uuid', A)).toBeNull();
  });
  it('after reconciling, routes parse exactly the active client', () => {
    const sp = new URLSearchParams({ location_id: B, location_ids: A });
    const fixed = reconcileClientScope(sp.get('location_id'), sp.get('location_ids'));
    if (fixed) sp.set('location_ids', fixed);
    expect(parseLocationFilter(sp)).toEqual([B]);
  });
});

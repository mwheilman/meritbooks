import { describe, it, expect } from 'vitest';
import { companyFromUrl } from './company-scope-url';

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';

describe('companyFromUrl', () => {
  it('returns an assigned company from ?location_id=', () => {
    expect(companyFromUrl(`?location_id=${B}`, [A, B])).toBe(B);
  });
  it('ignores unassigned ids (never scopes to a company the user cannot see)', () => {
    expect(companyFromUrl(`?location_id=${B}`, [A])).toBeNull();
  });
  it('ignores missing, empty and the consolidated sentinel', () => {
    expect(companyFromUrl('', [A])).toBeNull();
    expect(companyFromUrl('?location_id=', [A])).toBeNull();
    expect(companyFromUrl('?location_id=all', [A, 'all'])).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { DEFAULT_VOCAB } from '@meritbooks/industry-packs';
import { lower, vocabularyFrom, workspaceVocabulary } from '@/lib/pm/vocab';

describe('vocabulary fallback', () => {
  it('no rows → every default term', () => {
    expect(vocabularyFrom([])).toEqual(DEFAULT_VOCAB);
  });

  it('uses the company terms and falls back for the rest', () => {
    const v = vocabularyFrom([
      { location_id: 'a', vocab_key: 'job', label: 'Repair order' },
      { location_id: 'a', vocab_key: 'jobs', label: 'Repair orders' },
      { location_id: 'b', vocab_key: 'jobs', label: 'Projects' },
    ], 'a');
    expect(v.job).toBe('Repair order');
    expect(v.jobs).toBe('Repair orders');
    expect(v.customer).toBe(DEFAULT_VOCAB.customer);
  });

  it('blank, null and unknown keys never replace a default', () => {
    const v = vocabularyFrom([
      { location_id: 'a', vocab_key: 'jobs', label: '   ' },
      { location_id: 'a', vocab_key: 'customer', label: null },
      { location_id: 'a', vocab_key: 'warp_drive', label: 'Engage' },
    ], 'a');
    expect(v.jobs).toBe('Jobs');
    expect(v.customer).toBe('Customer');
    expect((v as Record<string, string>).warp_drive).toBeUndefined();
  });

  it('workspace view keeps a term only when every company agrees', () => {
    const rows = [
      { location_id: 'a', vocab_key: 'jobs', label: 'Projects' },
      { location_id: 'b', vocab_key: 'jobs', label: 'Projects' },
      { location_id: 'a', vocab_key: 'customers', label: 'Clients' },
    ];
    const v = workspaceVocabulary(rows, ['a', 'b']);
    expect(v.jobs).toBe('Projects');
    expect(v.customers).toBe('Customers');
    expect(workspaceVocabulary(rows, [])).toEqual(DEFAULT_VOCAB);
  });

  it('lower-cases mid-sentence terms but keeps acronyms', () => {
    expect(lower('Change orders')).toBe('change orders');
    expect(lower('RO list')).toBe('RO list');
  });
});

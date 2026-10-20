import { describe, it, expect } from 'vitest';
import { jeDeepLinkId, withCanonicalJeId } from './je-deep-link';

const ID = '3f1c2a9e-1b2c-4d5e-8f90-0123456789ab';

describe('journal-entry deep links', () => {
  it('honors ?id=, ?entry= and ?highlight=', () => {
    expect(jeDeepLinkId(`?id=${ID}`)).toBe(ID);
    expect(jeDeepLinkId(`?entry=${ID}`)).toBe(ID);
    expect(jeDeepLinkId(`?highlight=${ID}`)).toBe(ID);
  });

  it('prefers id over the legacy aliases', () => {
    const other = '00000000-0000-4000-8000-000000000000';
    expect(jeDeepLinkId(`?highlight=${other}&id=${ID}`)).toBe(ID);
  });

  it('ignores missing or malformed ids', () => {
    expect(jeDeepLinkId('')).toBeNull();
    expect(jeDeepLinkId('?entry=null')).toBeNull();
    expect(jeDeepLinkId('?highlight=undefined&tab=all')).toBeNull();
  });

  it('normalizes the URL to ?id= and drops aliases, keeping other params', () => {
    const out = new URL(withCanonicalJeId(`https://x.test/journal-entries?tab=all&highlight=${ID}`, ID));
    expect(out.searchParams.get('id')).toBe(ID);
    expect(out.searchParams.get('highlight')).toBeNull();
    expect(out.searchParams.get('tab')).toBe('all');
    const closed = new URL(withCanonicalJeId(`https://x.test/journal-entries?entry=${ID}`, null));
    expect(closed.search).toBe('');
  });
});

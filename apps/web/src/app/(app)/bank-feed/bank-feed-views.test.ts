import { describe, it, expect } from 'vitest';
import {
  type SavedView,
  normalizeView,
  parseViews,
  serializeViews,
  upsertView,
  removeView,
  newViewId,
} from './bank-feed-views';

function view(partial: Partial<SavedView> & { id: string; name: string }): SavedView {
  return {
    id: partial.id,
    name: partial.name,
    status: partial.status ?? 'all',
    band: partial.band ?? 'all',
    vendor: partial.vendor ?? null,
    search: partial.search ?? '',
    sortField: partial.sortField ?? 'confidence',
    sortDir: partial.sortDir ?? 'asc',
  };
}

describe('normalizeView', () => {
  it('rejects payloads without id or name', () => {
    expect(normalizeView({ name: 'x' })).toBeNull();
    expect(normalizeView({ id: 'a' })).toBeNull();
    expect(normalizeView({ id: 'a', name: '   ' })).toBeNull();
    expect(normalizeView(null)).toBeNull();
    expect(normalizeView('nope')).toBeNull();
  });

  it('coerces unknown band/sort values to safe defaults and trims name', () => {
    const v = normalizeView({
      id: 'a',
      name: '  My view  ',
      status: 'PENDING',
      band: 'bogus',
      vendor: 42,
      search: 5,
      sortField: 'nope',
      sortDir: 'sideways',
    });
    expect(v).toEqual({
      id: 'a',
      name: 'My view',
      status: 'PENDING',
      band: 'all',
      vendor: null,
      search: '',
      sortField: 'confidence',
      sortDir: 'asc',
    });
  });
});

describe('parseViews', () => {
  it('returns [] for empty / invalid / non-array payloads', () => {
    expect(parseViews(null)).toEqual([]);
    expect(parseViews('')).toEqual([]);
    expect(parseViews('{not json')).toEqual([]);
    expect(parseViews('{"a":1}')).toEqual([]);
  });

  it('round-trips serialized views and drops duplicate ids', () => {
    const views = [view({ id: '1', name: 'A' }), view({ id: '2', name: 'B' })];
    expect(parseViews(serializeViews(views))).toEqual(views);

    const dupe = JSON.stringify([view({ id: '1', name: 'A' }), view({ id: '1', name: 'A again' })]);
    expect(parseViews(dupe).map((v) => v.id)).toEqual(['1']);
  });
});

describe('upsertView', () => {
  it('appends a new view', () => {
    const start = [view({ id: '1', name: 'A' })];
    const next = upsertView(start, view({ id: '2', name: 'B' }));
    expect(next.map((v) => v.name)).toEqual(['A', 'B']);
  });

  it('replaces in place by case-insensitive name, keeping the original id', () => {
    const start = [view({ id: '1', name: 'Low review', band: 'low' })];
    const next = upsertView(start, view({ id: '2', name: 'low REVIEW', band: 'high' }));
    expect(next).toHaveLength(1);
    expect(next[0].id).toBe('1'); // original id preserved
    expect(next[0].band).toBe('high'); // lens updated
  });
});

describe('removeView', () => {
  it('drops the matching id only', () => {
    const start = [view({ id: '1', name: 'A' }), view({ id: '2', name: 'B' })];
    expect(removeView(start, '1').map((v) => v.id)).toEqual(['2']);
    expect(removeView(start, 'nope')).toHaveLength(2);
  });
});

describe('newViewId', () => {
  it('produces distinct, non-empty ids', () => {
    const a = newViewId(1000);
    const b = newViewId(1000);
    expect(a).toMatch(/^v_/);
    expect(a).not.toBe(b); // random suffix differentiates same-timestamp ids
  });
});

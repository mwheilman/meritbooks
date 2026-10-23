import { describe, it, expect } from 'vitest';
import { pageRows } from './generic-rows-pager';

// Slice 1F — generic catalog reports used to stop at 200 rows with no warning.
describe('pageRows', () => {
  const rows = Array.from({ length: 250 }, (_, i) => i);
  it('pages through every row', () => {
    expect(pageRows(rows, 1, 100, false)).toHaveLength(100);
    expect(pageRows(rows, 3, 100, false)).toEqual(rows.slice(200));
    const seen = [1, 2, 3].flatMap((p) => pageRows(rows, p, 100, false));
    expect(seen).toEqual(rows);
  });
  it('clamps out-of-range pages', () => {
    expect(pageRows(rows, 99, 100, false)).toEqual(rows.slice(200));
    expect(pageRows(rows, 0, 100, false)).toEqual(rows.slice(0, 100));
  });
  it('show all returns every row', () => {
    expect(pageRows(rows, 1, 100, true)).toHaveLength(250);
  });
});

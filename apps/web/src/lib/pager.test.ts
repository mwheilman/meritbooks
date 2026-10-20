import { describe, it, expect } from 'vitest';
import { pagerState } from './pager';

describe('pagerState', () => {
  it('reports more rows beyond the first 50 (the silent-cap bug)', () => {
    const s = pagerState(1, 50, 132);
    expect(s).toMatchObject({ from: 1, to: 50, total: 132, totalPages: 3, hasPrev: false, hasNext: true });
  });

  it('handles the last partial page', () => {
    expect(pagerState(3, 50, 132)).toMatchObject({ from: 101, to: 132, hasPrev: true, hasNext: false });
  });

  it('clamps out-of-range pages', () => {
    expect(pagerState(9, 50, 132).page).toBe(3);
    expect(pagerState(0, 50, 132).page).toBe(1);
  });

  it('is empty-safe', () => {
    expect(pagerState(1, 50, 0)).toMatchObject({ from: 0, to: 0, totalPages: 1, hasNext: false, hasPrev: false });
  });
});

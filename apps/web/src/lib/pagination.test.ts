import { describe, it, expect } from 'vitest';
import {
  resolvePageParams,
  totalPages,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from './pagination';

describe('resolvePageParams', () => {
  it('applies defaults when params are missing', () => {
    const p = resolvePageParams({});
    expect(p.page).toBe(1);
    expect(p.perPage).toBe(DEFAULT_PAGE_SIZE);
    expect(p.offset).toBe(0);
    expect(p.rangeFrom).toBe(0);
    expect(p.rangeTo).toBe(DEFAULT_PAGE_SIZE - 1);
  });

  it('hard-clamps an oversized per_page to MAX_PAGE_SIZE (prevents whole-table pulls)', () => {
    const p = resolvePageParams({ per_page: '1000000' });
    expect(p.perPage).toBe(MAX_PAGE_SIZE);
    expect(p.rangeTo).toBe(MAX_PAGE_SIZE - 1);
  });

  it('computes offset/range from page and per_page (no dropped or duplicated rows)', () => {
    const p = resolvePageParams({ page: '3', per_page: '25' });
    expect(p.page).toBe(3);
    expect(p.perPage).toBe(25);
    expect(p.offset).toBe(50); // (3 - 1) * 25
    expect(p.rangeFrom).toBe(50);
    expect(p.rangeTo).toBe(74); // 50 + 25 - 1 → contiguous with page 2's [25..49]
  });

  it('floors invalid/negative/zero/non-integer input to safe values', () => {
    expect(resolvePageParams({ page: '0' }).page).toBe(1);
    expect(resolvePageParams({ page: '-5' }).page).toBe(1);
    expect(resolvePageParams({ page: 'abc' }).page).toBe(1);
    expect(resolvePageParams({ per_page: '0' }).perPage).toBe(DEFAULT_PAGE_SIZE);
    expect(resolvePageParams({ per_page: '-3' }).perPage).toBe(DEFAULT_PAGE_SIZE);
    expect(resolvePageParams({ per_page: '10.5' }).perPage).toBe(DEFAULT_PAGE_SIZE);
    expect(resolvePageParams({ page: null, per_page: null }).offset).toBe(0);
  });

  it('honors custom default/max size options', () => {
    const p = resolvePageParams({ per_page: '500' }, { defaultSize: 20, maxSize: 200 });
    expect(p.perPage).toBe(200);
    expect(resolvePageParams({}, { defaultSize: 20 }).perPage).toBe(20);
  });
});

describe('totalPages', () => {
  it('computes ceil pages and never returns < 1', () => {
    expect(totalPages(0, 50)).toBe(1);
    expect(totalPages(50, 50)).toBe(1);
    expect(totalPages(51, 50)).toBe(2);
    expect(totalPages(125, 50)).toBe(3);
  });

  it('is safe against a zero page size', () => {
    expect(totalPages(100, 0)).toBe(1);
  });
});

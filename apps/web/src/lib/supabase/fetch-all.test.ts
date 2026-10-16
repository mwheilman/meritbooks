import { describe, it, expect } from 'vitest';
import {
  fetchAll,
  fetchAllIn,
  FetchAllLimitError,
  FETCH_ALL_PAGE_SIZE,
  type FetchAllPageResult,
  type PageableQuery,
} from './fetch-all';

interface Row {
  id: number;
  group: string;
}

/**
 * Fake PostgREST builder over an in-memory table. Mimics the real server: rows
 * are sorted by the requested order columns, `.range()` is inclusive, and any
 * response is capped at `maxRowsPerResponse` (Supabase's default 1,000).
 */
class FakeQuery implements PageableQuery<Row> {
  readonly orders: string[] = [];
  constructor(
    private readonly rows: Row[],
    private readonly log: { ranges: Array<[number, number]>; orders: string[][] },
    private readonly maxRowsPerResponse = 1000,
    private readonly failOnFrom: number | null = null,
  ) {}

  order(column: string): PageableQuery<Row> {
    this.orders.push(column);
    return this;
  }

  range(from: number, to: number): PromiseLike<FetchAllPageResult<Row>> {
    this.log.ranges.push([from, to]);
    this.log.orders.push([...this.orders]);
    if (this.failOnFrom !== null && from === this.failOnFrom) {
      return Promise.resolve({ data: null, error: { message: 'boom' } });
    }
    const sorted = [...this.rows].sort((a, b) => {
      for (const col of this.orders) {
        const av = a[col as keyof Row];
        const bv = b[col as keyof Row];
        if (av < bv) return -1;
        if (av > bv) return 1;
      }
      return 0;
    });
    const end = Math.min(to + 1, from + this.maxRowsPerResponse);
    return Promise.resolve({ data: sorted.slice(from, end), error: null });
  }
}

function makeRows(n: number): Row[] {
  // Deliberately shuffled ids so ordering actually matters.
  const rows = Array.from({ length: n }, (_, i) => ({ id: i + 1, group: i % 2 === 0 ? 'a' : 'b' }));
  return rows.reverse();
}

function harness(rows: Row[], failOnFrom: number | null = null) {
  const log = { ranges: [] as Array<[number, number]>, orders: [] as string[][] };
  const factory = () => new FakeQuery(rows, log, 1000, failOnFrom);
  return { log, factory };
}

describe('fetchAll', () => {
  it('returns an empty array (one request) for an empty table', async () => {
    const { log, factory } = harness([]);
    const res = await fetchAll<Row>(factory);
    expect(res.error).toBeNull();
    expect(res.data).toEqual([]);
    expect(log.ranges).toEqual([[0, 999]]);
  });

  it('returns a short single page with one request', async () => {
    const { log, factory } = harness(makeRows(37));
    const res = await fetchAll<Row>(factory);
    expect(res.data).toHaveLength(37);
    expect(log.ranges).toHaveLength(1);
  });

  it('pages across multiple pages with no gaps or duplicates (2,345 rows)', async () => {
    const { log, factory } = harness(makeRows(2345));
    const res = await fetchAll<Row>(factory);
    const ids = (res.data ?? []).map((r) => r.id);
    expect(ids).toHaveLength(2345);
    expect(new Set(ids).size).toBe(2345);
    expect(ids).toEqual(Array.from({ length: 2345 }, (_, i) => i + 1));
    expect(log.ranges).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ]);
  });

  it('handles an exact multiple of the page size (one extra empty page, no loss)', async () => {
    const { log, factory } = harness(makeRows(3000));
    const res = await fetchAll<Row>(factory);
    expect(res.data).toHaveLength(3000);
    expect(new Set((res.data ?? []).map((r) => r.id)).size).toBe(3000);
    expect(log.ranges).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
      [3000, 3999],
    ]);
  });

  it('exactly one full page (1,000 rows) issues a confirming second request', async () => {
    const { log, factory } = harness(makeRows(FETCH_ALL_PAGE_SIZE));
    const res = await fetchAll<Row>(factory);
    expect(res.data).toHaveLength(1000);
    expect(log.ranges).toHaveLength(2);
  });

  it('applies the stable order (default `id`) on a FRESH builder every page', async () => {
    const { log, factory } = harness(makeRows(1500));
    await fetchAll<Row>(factory);
    // Each page's builder saw exactly one `.order('id')` — fresh builder per page.
    expect(log.orders).toEqual([['id'], ['id']]);
  });

  it('appends multi-column orderBy as tie-breakers', async () => {
    const { log, factory } = harness(makeRows(10));
    await fetchAll<Row>(factory, { orderBy: ['group', 'id'] });
    expect(log.orders).toEqual([['group', 'id']]);
  });

  it('rejects an empty orderBy (no stable order = unsafe paging)', async () => {
    const { factory } = harness(makeRows(10));
    await expect(fetchAll<Row>(factory, { orderBy: [] })).rejects.toThrow(/orderBy/);
  });

  it('throws FetchAllLimitError instead of silently truncating past the ceiling', async () => {
    const { factory } = harness(makeRows(2500));
    await expect(fetchAll<Row>(factory, { maxRows: 2000, label: 'test lines' })).rejects.toBeInstanceOf(
      FetchAllLimitError,
    );
    await expect(fetchAll<Row>(factory, { maxRows: 2000, label: 'test lines' })).rejects.toThrow(/test lines/);
  });

  it('does not throw when the row count equals the ceiling', async () => {
    const { factory } = harness(makeRows(2000));
    const res = await fetchAll<Row>(factory, { maxRows: 2000 });
    expect(res.data).toHaveLength(2000);
  });

  it('surfaces a mid-stream query error as { data: null, error } (no partial data)', async () => {
    const { factory } = harness(makeRows(2500), 1000);
    const res = await fetchAll<Row>(factory);
    expect(res.data).toBeNull();
    expect(res.error?.message).toBe('boom');
  });

  it('respects a custom page size', async () => {
    const { log, factory } = harness(makeRows(25));
    const res = await fetchAll<Row>(factory, { pageSize: 10 });
    expect(res.data).toHaveLength(25);
    expect(log.ranges).toEqual([
      [0, 9],
      [10, 19],
      [20, 29],
    ]);
  });
});

describe('fetchAllIn', () => {
  /** Fake whose factory filters by an id chunk (simulating `.in('id', chunk)`). */
  function inHarness(rows: Row[]) {
    const log = { ranges: [] as Array<[number, number]>, orders: [] as string[][] };
    const chunks: number[][] = [];
    const factory = (chunk: number[]) => {
      chunks.push(chunk);
      const set = new Set(chunk);
      return new FakeQuery(
        rows.filter((r) => set.has(r.id)),
        log,
      );
    };
    return { log, chunks, factory };
  }

  it('returns [] without querying for an empty id list', async () => {
    const { chunks, factory } = inHarness(makeRows(10));
    const res = await fetchAllIn<Row, number>([], factory);
    expect(res.data).toEqual([]);
    expect(chunks).toHaveLength(0);
  });

  it('chunks a large id list and returns every matching row exactly once', async () => {
    const rows = makeRows(2500);
    const ids = rows.map((r) => r.id);
    const { chunks, factory } = inHarness(rows);
    const res = await fetchAllIn<Row, number>([...ids, ...ids.slice(0, 50)], factory, { chunkSize: 300 });
    expect(chunks).toHaveLength(Math.ceil(2500 / 300));
    expect(chunks.every((c) => c.length <= 300)).toBe(true);
    const got = (res.data ?? []).map((r) => r.id).sort((a, b) => a - b);
    expect(got).toEqual(Array.from({ length: 2500 }, (_, i) => i + 1));
  });

  it('pages within a chunk when one chunk matches more than a page of rows', async () => {
    // One "parent id" owning 2,100 child rows: filter by group instead of id.
    const rows = makeRows(4200);
    const log = { ranges: [] as Array<[number, number]>, orders: [] as string[][] };
    const res = await fetchAllIn<Row, string>(['a', 'b'], (chunk) => {
      const set = new Set(chunk);
      return new FakeQuery(
        rows.filter((r) => set.has(r.group)),
        log,
      );
    }, { chunkSize: 1 });
    expect(res.data).toHaveLength(4200);
    // 2,100 rows per chunk -> 3 pages each.
    expect(log.ranges).toHaveLength(6);
  });

  it('enforces the ceiling across chunks', async () => {
    const rows = makeRows(1200);
    const { factory } = inHarness(rows);
    await expect(
      fetchAllIn<Row, number>(rows.map((r) => r.id), factory, { chunkSize: 500, maxRows: 1000 }),
    ).rejects.toBeInstanceOf(FetchAllLimitError);
  });
});

/**
 * Statement tie-out over a >1,000-line ledger, through a fake PostgREST that
 * enforces Supabase's 1,000-row response cap.
 *
 * Why a fake and not the PGlite harness (src/test/pg.ts): PGlite replays the
 * migrations into a real Postgres, but there is no PostgREST layer in front of
 * it — and the bug being guarded is a PostgREST behaviour (the `max-rows` cap on
 * every response). So this suite drives the REAL statement aggregation code
 * (board-package `fetchIncomeStatement` / `fetchBalanceSheet`, which share the
 * on-screen statements' query + aggregation shape) against an in-memory server
 * that applies the same filter / order / range semantics and the same cap.
 */
import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAll } from './fetch-all';
import { fetchBalanceSheet, fetchIncomeStatement } from '@/app/api/reports/board-package/queries';

const SERVER_MAX_ROWS = 1000;

type Json = string | number | boolean | null | JsonObj | Json[];
interface JsonObj {
  [k: string]: Json;
}
type Row = JsonObj;
interface FakeResult {
  data: Row[] | null;
  error: { message: string } | null;
}

function getPath(row: Row, path: string): Json | undefined {
  let cur: Json | undefined = row;
  for (const part of path.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
    cur = (cur as JsonObj)[part];
  }
  return cur;
}

/** Minimal PostgREST query builder: filters on (possibly embedded) paths, order, range, 1,000-row cap. */
class FakeQuery implements PromiseLike<FakeResult> {
  private readonly filters: Array<(r: Row) => boolean> = [];
  private readonly orders: string[] = [];
  private from = 0;
  private to = Number.MAX_SAFE_INTEGER;

  constructor(private readonly rows: Row[]) {}

  select(): this {
    return this;
  }
  eq(path: string, v: Json): this {
    this.filters.push((r) => getPath(r, path) === v);
    return this;
  }
  lte(path: string, v: string): this {
    this.filters.push((r) => String(getPath(r, path)) <= v);
    return this;
  }
  gte(path: string, v: string): this {
    this.filters.push((r) => String(getPath(r, path)) >= v);
    return this;
  }
  lt(path: string, v: string): this {
    this.filters.push((r) => String(getPath(r, path)) < v);
    return this;
  }
  in(path: string, vs: Json[]): this {
    this.filters.push((r) => vs.includes(getPath(r, path) as Json));
    return this;
  }
  order(col: string): this {
    this.orders.push(col);
    return this;
  }
  range(from: number, to: number): this {
    this.from = from;
    this.to = to;
    return this;
  }

  private exec(): FakeResult {
    let out = this.rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.orders.length > 0) {
      out = [...out].sort((a, b) => {
        for (const col of this.orders) {
          const av = String(getPath(a, col));
          const bv = String(getPath(b, col));
          if (av !== bv) return av < bv ? -1 : 1;
        }
        return 0;
      });
    }
    const end = Math.min(this.to + 1, this.from + SERVER_MAX_ROWS);
    return { data: out.slice(this.from, end), error: null };
  }

  then<A = FakeResult, B = never>(
    onFulfilled?: ((v: FakeResult) => A | PromiseLike<A>) | null,
    onRejected?: ((e: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return Promise.resolve(this.exec()).then(onFulfilled, onRejected);
  }
}

function fakeClient(tables: Record<string, Row[]>): SupabaseClient {
  const client = {
    from: (table: string) => new FakeQuery(tables[table] ?? []),
  };
  return client as unknown as SupabaseClient;
}

// ── Synthetic ledger ─────────────────────────────────────────────────────────
interface AcctDef {
  id: string;
  number: string;
  name: string;
  type: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'OPEX';
  normal: 'DEBIT' | 'CREDIT';
}
const ACCTS: Record<string, AcctDef> = {
  cash: { id: 'a-cash', number: '1000', name: 'Operating Cash', type: 'ASSET', normal: 'DEBIT' },
  loan: { id: 'a-loan', number: '2500', name: 'Term Loan', type: 'LIABILITY', normal: 'CREDIT' },
  equity: { id: 'a-equity', number: '3000', name: 'Owner Capital', type: 'EQUITY', normal: 'CREDIT' },
  revenue: { id: 'a-rev', number: '4000', name: 'Service Revenue', type: 'REVENUE', normal: 'CREDIT' },
  opex: { id: 'a-opex', number: '6000', name: 'Rent Expense', type: 'OPEX', normal: 'DEBIT' },
};

function acctEmbed(a: AcctDef): JsonObj {
  return {
    account_number: a.number,
    name: a.name,
    account_type: a.type,
    display_order: Number(a.number),
    account_groups: {
      name: `${a.type} group`,
      display_order: 1,
      account_sub_types: {
        name: `${a.type} sub`,
        display_order: 1,
        account_types: { name: a.type, display_order: 1, normal_balance: a.normal },
      },
    },
  };
}

interface Ledger {
  lines: Row[];
  expected: { cash: number; loan: number; equity: number; revenue: number; opex: number };
  postedLineCount: number;
}

/** 1,300 POSTED two-line entries (2,600 lines) + 20 DRAFT entries that must be ignored. */
function buildLedger(): Ledger {
  const lines: Row[] = [];
  const expected = { cash: 0, loan: 0, equity: 0, revenue: 0, opex: 0 };
  let lineSeq = 0;
  const pushEntry = (n: number, status: string, dr: AcctDef, cr: AcctDef, cents: number) => {
    const entryId = `e${String(n).padStart(5, '0')}`;
    const month = (n % 12) + 1;
    const entry: JsonObj = { id: entryId, entry_date: `2026-${String(month).padStart(2, '0')}-15`, status };
    for (const [acct, debit, credit] of [
      [dr, cents, 0],
      [cr, 0, cents],
    ] as const) {
      lineSeq += 1;
      lines.push({
        // Interleave ids so `id` order differs from insertion order.
        id: `l${String((lineSeq * 7919) % 100000).padStart(5, '0')}-${lineSeq}`,
        account_id: acct.id,
        debit_cents: debit,
        credit_cents: credit,
        location_id: 'loc-1',
        gl_entry_id: entryId,
        accounts: acctEmbed(acct),
        gl_entries: entry,
      });
    }
  };

  let n = 0;
  for (let i = 0; i < 1300; i++) {
    n += 1;
    const cents = 10_000 + i * 37; // integer cents
    switch (i % 4) {
      case 0: // cash sale
        pushEntry(n, 'POSTED', ACCTS.cash, ACCTS.revenue, cents);
        expected.cash += cents;
        expected.revenue += cents;
        break;
      case 1: // pay rent
        pushEntry(n, 'POSTED', ACCTS.opex, ACCTS.cash, Math.floor(cents / 2));
        expected.opex += Math.floor(cents / 2);
        expected.cash -= Math.floor(cents / 2);
        break;
      case 2: // owner contribution
        pushEntry(n, 'POSTED', ACCTS.cash, ACCTS.equity, cents);
        expected.cash += cents;
        expected.equity += cents;
        break;
      default: // loan draw
        pushEntry(n, 'POSTED', ACCTS.cash, ACCTS.loan, cents);
        expected.cash += cents;
        expected.loan += cents;
        break;
    }
  }
  for (let i = 0; i < 20; i++) {
    n += 1;
    pushEntry(n, 'DRAFT', ACCTS.cash, ACCTS.revenue, 999_999);
  }
  return { lines, expected, postedLineCount: 2600 };
}

describe('statement tie-out over a >1,000-line ledger (PostgREST 1,000-row cap)', () => {
  const ledger = buildLedger();
  const supabase = fakeClient({ gl_entry_lines: ledger.lines });

  it('the cap is real: an unpaged read silently returns only 1,000 of 2,600 posted lines', async () => {
    const { data } = await supabase.from('gl_entry_lines').select('*').eq('gl_entries.status', 'POSTED');
    expect(data).toHaveLength(SERVER_MAX_ROWS);
  });

  it('trial balance via fetchAll: every posted line read once, debits = credits', async () => {
    const { data, error } = await fetchAll<Row>(
      () => supabase.from('gl_entry_lines').select('*').eq('gl_entries.status', 'POSTED'),
      { label: 'tie-out TB' },
    );
    expect(error).toBeNull();
    const rows = data ?? [];
    expect(rows).toHaveLength(ledger.postedLineCount);
    expect(new Set(rows.map((r) => r.id)).size).toBe(ledger.postedLineCount);
    const debits = rows.reduce((s, r) => s + Number(r.debit_cents), 0);
    const credits = rows.reduce((s, r) => s + Number(r.credit_cents), 0);
    expect(Number.isInteger(debits)).toBe(true);
    expect(debits).toBe(credits);
    expect(debits).toBeGreaterThan(0);
  });

  it('income statement totals match the full ledger (not the first 1,000 lines)', async () => {
    const is = await fetchIncomeStatement(supabase, {
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      locationIds: [],
      basis: 'accrual',
    });
    expect(is.summary.revenueCents).toBe(ledger.expected.revenue);
    expect(is.summary.opexCents).toBe(ledger.expected.opex);
    expect(is.summary.netIncomeCents).toBe(ledger.expected.revenue - ledger.expected.opex);
  });

  it('balance sheet ties: Assets = Liabilities + Equity + current-period net income', async () => {
    const bs = await fetchBalanceSheet(supabase, { asOfDate: '2026-12-31', locationIds: [] });
    const is = await fetchIncomeStatement(supabase, {
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      locationIds: [],
      basis: 'accrual',
    });
    expect(bs.summary.totalAssetsCents).toBe(ledger.expected.cash);
    expect(bs.summary.totalLiabilitiesCents).toBe(ledger.expected.loan);
    expect(bs.summary.totalEquityCents).toBe(ledger.expected.equity);
    // No year-end close has run, so retained earnings for the year live in the P&L.
    expect(bs.summary.totalAssetsCents).toBe(
      bs.summary.totalLiabilitiesCents + bs.summary.totalEquityCents + is.summary.netIncomeCents,
    );
  });

  it('location-scoped statements still respect the filter while paging', async () => {
    const bs = await fetchBalanceSheet(supabase, { asOfDate: '2026-12-31', locationIds: ['loc-other'] });
    expect(bs.summary.totalAssetsCents).toBe(0);
    expect(bs.summary.totalLiabilitiesCents).toBe(0);
  });
});

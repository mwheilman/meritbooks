import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createCompany, deriveShortCode } from './create-company';
import { assignShortCodes, baseShortCode } from './short-code';
import { buildNewCompanyPeriods, defaultCutoverDate, newCompanyPeriodStatus } from './fiscal-periods';

// ── deriveShortCode ──────────────────────────────────────────────────────────

describe('deriveShortCode', () => {
  it('uses initials for multi-word names (matches the tenant style)', () => {
    expect(deriveShortCode('Swan Creek Construction', new Set())).toBe('SCC');
    expect(deriveShortCode('Heartland HVAC', new Set())).toBe('HH');
    expect(deriveShortCode('Iowa Custom Cabinetry', new Set())).toBe('ICC');
  });

  it('drops legal suffixes and filler words', () => {
    expect(deriveShortCode('Swan Creek Construction, LLC', new Set())).toBe('SCC');
    expect(deriveShortCode('The Heritage Interiors Co.', new Set())).toBe('HI');
  });

  it('uses the word itself (≤6 chars) for one-word names', () => {
    expect(deriveShortCode('Acme', new Set())).toBe('ACME');
    expect(deriveShortCode('Microsoft Inc', new Set())).toBe('MICROS');
  });

  it('is uppercase A–Z/0–9 only and at most 10 characters', () => {
    const code = deriveShortCode('Ünïcode & Sons — 2nd Street Partners of Des Moines Iowa Holdings Group', new Set());
    expect(code).toMatch(/^[A-Z0-9]{1,10}$/);
    expect(deriveShortCode('Café Olé', new Set())).toBe('CO');
  });

  it('falls back to CO for names with no letters or digits', () => {
    expect(baseShortCode('!!!')).toBe('CO');
  });

  it('keeps noise words when the name is only noise', () => {
    expect(deriveShortCode('The Company', new Set())).toBe('TC');
  });

  it('is unique against taken codes (case-insensitive) with a numeric suffix', () => {
    expect(deriveShortCode('Swan Creek Construction', new Set(['scc']))).toBe('SCC2');
    expect(deriveShortCode('Swan Creek Construction', new Set(['SCC', 'SCC2']))).toBe('SCC3');
  });

  it('trims the base so a suffixed code still fits in 10 characters', () => {
    const name = 'Alpha Bravo Charlie Delta Echo Foxtrot Golf Hotel India Juliet';
    expect(deriveShortCode(name, new Set())).toBe('ABCDEFGHIJ');
    expect(deriveShortCode(name, new Set(['ABCDEFGHIJ']))).toBe('ABCDEFGHI2');
  });

  it('assignShortCodes keeps typed codes and makes the batch unique', () => {
    const codes = assignShortCodes(
      [
        { name: 'Swan Creek Construction' },
        { name: 'Sunset Cove Cafe' },
        { name: 'Heartland HVAC', shortCode: 'hvac' },
        { name: 'Second Heartland Holdings', shortCode: 'MMG' }, // collides with existing → derived
      ],
      ['MMG'],
    );
    expect(codes).toEqual(['SCC', 'SCC2', 'HVAC', 'SHH']);
  });
});

// ── fiscal periods ───────────────────────────────────────────────────────────

describe('buildNewCompanyPeriods', () => {
  const now = new Date(Date.UTC(2026, 9, 16)); // 2026-10-16

  it('creates 36 monthly periods for prior, current and next calendar year', () => {
    const rows = buildNewCompanyPeriods('org', 'loc', now);
    expect(rows).toHaveLength(36);
    expect(rows[0]).toMatchObject({ period_year: 2025, period_month: 1, start_date: '2025-01-01', end_date: '2025-01-31' });
    expect(rows[35]).toMatchObject({ period_year: 2027, period_month: 12, start_date: '2027-12-01', end_date: '2027-12-31' });
    expect(rows.every((r) => r.org_id === 'org' && r.location_id === 'loc')).toBe(true);
  });

  it('never creates HARD_CLOSE: months before the current month are SOFT_CLOSE, the rest OPEN', () => {
    const rows = buildNewCompanyPeriods('org', 'loc', now);
    expect(rows.some((r) => (r.status as string) === 'HARD_CLOSE')).toBe(false);
    const status = (y: number, m: number) => rows.find((r) => r.period_year === y && r.period_month === m)?.status;
    expect(status(2025, 1)).toBe('SOFT_CLOSE');
    expect(status(2025, 12)).toBe('SOFT_CLOSE');
    expect(status(2026, 9)).toBe('SOFT_CLOSE');
    expect(status(2026, 10)).toBe('OPEN');
    expect(status(2026, 11)).toBe('OPEN');
    expect(status(2027, 1)).toBe('OPEN');
    expect(rows.filter((r) => r.status === 'SOFT_CLOSE')).toHaveLength(12 + 9);
  });

  it('handles leap-year February and January "now"', () => {
    const jan = new Date(Date.UTC(2028, 0, 3));
    const rows = buildNewCompanyPeriods('o', 'l', jan);
    expect(rows.find((r) => r.period_year === 2028 && r.period_month === 2)?.end_date).toBe('2028-02-29');
    expect(newCompanyPeriodStatus(2028, 1, jan)).toBe('OPEN');
    expect(newCompanyPeriodStatus(2027, 12, jan)).toBe('SOFT_CLOSE');
  });

  it('defaultCutoverDate is the last day of the previous month', () => {
    expect(defaultCutoverDate(now)).toBe('2026-09-30');
    expect(defaultCutoverDate(new Date(Date.UTC(2026, 0, 5)))).toBe('2025-12-31');
    expect(defaultCutoverDate(new Date(Date.UTC(2028, 2, 1)))).toBe('2028-02-29');
  });
});

// ── createCompany (with a minimal in-memory Supabase fake) ───────────────────

interface FakeState {
  locations: Array<{ id: string; org_id: string; name: string; short_code: string; [k: string]: unknown }>;
  periods: Array<Record<string, unknown>>;
  failPeriods?: boolean;
  failDelete?: boolean;
}

function fakeDb(state: FakeState): SupabaseClient {
  let seq = 0;
  const table = (name: string) => {
    const filters: Array<[string, unknown]> = [];
    let op: 'select' | 'insert' | 'delete' | 'upsert' = 'select';
    let payload: unknown = null;
    const rowsFor = () =>
      (name === 'locations' ? state.locations : state.periods).filter((r) =>
        filters.every(([k, v]) => (r as Record<string, unknown>)[k] === v),
      );
    const run = () => {
      if (op === 'select') return { data: rowsFor(), error: null };
      if (op === 'insert') {
        const row = { id: `loc-${++seq}`, ...(payload as Record<string, unknown>) } as FakeState['locations'][number];
        if (state.locations.some((l) => l.org_id === row.org_id && l.short_code === row.short_code)) {
          return { data: null, error: { code: '23505', message: 'duplicate key' } };
        }
        state.locations.push(row);
        return { data: { id: row.id }, error: null };
      }
      if (op === 'delete') {
        if (state.failDelete) return { data: null, error: { message: 'denied' } };
        const kill = new Set(rowsFor());
        state.locations = state.locations.filter((l) => !kill.has(l));
        return { data: null, error: null };
      }
      // upsert periods (ignore duplicates)
      if (state.failPeriods) return { data: null, error: { message: 'periods boom' } };
      const added: Array<{ id: string }> = [];
      for (const p of payload as Array<Record<string, unknown>>) {
        const dup = state.periods.some(
          (e) => e.location_id === p.location_id && e.period_year === p.period_year && e.period_month === p.period_month,
        );
        if (!dup) { state.periods.push(p); added.push({ id: `p-${state.periods.length}` }); }
      }
      return { data: added, error: null };
    };
    const b: Record<string, unknown> = {
      select: () => b,
      eq: (k: string, v: unknown) => { filters.push([k, v]); return b; },
      limit: () => b,
      single: () => b,
      insert: (p: unknown) => { op = 'insert'; payload = p; return b; },
      upsert: (p: unknown) => { op = 'upsert'; payload = p; return b; },
      delete: () => { op = 'delete'; return b; },
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej),
    };
    return b;
  };
  const db = { from: (n: string) => table(n === 'fiscal_periods' ? 'periods' : n), schema: () => ({ from: (n: string) => table(n) }) };
  return db as unknown as SupabaseClient;
}

describe('createCompany', () => {
  const ORG = 'org-1';

  it('creates the company with a derived short code and 36 periods', async () => {
    const state: FakeState = { locations: [{ id: 'x', org_id: ORG, name: 'Merit Management Group', short_code: 'SCC' }], periods: [] };
    const res = await createCompany(fakeDb(state), { orgId: ORG, name: '  Swan Creek   Construction ', industry: 'Construction' });
    expect(res).toMatchObject({ ok: true, shortCode: 'SCC2', periodsCreated: 36 });
    const loc = state.locations.find((l) => l.name === 'Swan Creek Construction');
    expect(loc).toMatchObject({ org_id: ORG, industry: 'Construction', fiscal_year_start_month: 1, rev_rec_method: 'POINT_OF_SALE' });
    expect(state.periods.some((p) => p.status === 'HARD_CLOSE')).toBe(false);
  });

  it('409s on a duplicate name (case-insensitive) and on a taken short code', async () => {
    const state: FakeState = { locations: [{ id: 'x', org_id: ORG, name: 'Acme', short_code: 'ACME' }], periods: [] };
    expect(await createCompany(fakeDb(state), { orgId: ORG, name: 'ACME' })).toMatchObject({ ok: false, status: 409 });
    expect(await createCompany(fakeDb(state), { orgId: ORG, name: 'Acme Two', shortCode: 'acme' })).toMatchObject({ ok: false, status: 409 });
  });

  it('only checks duplicates within the same org', async () => {
    const state: FakeState = { locations: [{ id: 'x', org_id: 'other-org', name: 'Acme', short_code: 'ACME' }], periods: [] };
    expect(await createCompany(fakeDb(state), { orgId: ORG, name: 'Acme' })).toMatchObject({ ok: true, shortCode: 'ACME' });
  });

  it('validates input with friendly 4xx errors', async () => {
    const db = fakeDb({ locations: [], periods: [] });
    expect(await createCompany(db, { orgId: '', name: 'A' })).toMatchObject({ ok: false, status: 400 });
    expect(await createCompany(db, { orgId: ORG, name: '   ' })).toMatchObject({ ok: false, status: 422 });
    expect(await createCompany(db, { orgId: ORG, name: 'A', fiscalYearStartMonth: 13 })).toMatchObject({ ok: false, status: 422 });
    expect(await createCompany(db, { orgId: ORG, name: 'A', revRecMethod: 'MAGIC' })).toMatchObject({ ok: false, status: 422 });
    expect(await createCompany(db, { orgId: ORG, name: 'A', shortCode: 'BAD-CODE' })).toMatchObject({ ok: false, status: 422 });
  });

  it('rolls the company back when its periods cannot be created', async () => {
    const state: FakeState = { locations: [], periods: [], failPeriods: true };
    const res = await createCompany(fakeDb(state), { orgId: ORG, name: 'Acme' });
    expect(res).toMatchObject({ ok: false, status: 500 });
    expect(state.locations).toHaveLength(0);
  });

  it('keeps the company (periodsCreated 0) if the rollback is refused', async () => {
    const state: FakeState = { locations: [], periods: [], failPeriods: true, failDelete: true };
    const res = await createCompany(fakeDb(state), { orgId: ORG, name: 'Acme' });
    expect(res).toMatchObject({ ok: true, periodsCreated: 0 });
  });
});

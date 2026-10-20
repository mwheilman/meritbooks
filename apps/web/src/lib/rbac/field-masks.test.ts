import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  LOCKED_FIELD_POLICY,
  MAX_REVEAL_SUBJECTS,
  applyFieldMasks,
  last4Mask,
  maskValue,
  normalizeFieldPolicy,
  parseRevealRequest,
  resolveFieldAccess,
  type FieldAccess,
} from './field-masks';
import type { FieldPolicy } from './access-templates';

vi.mock('@/lib/trust/action-log', () => ({ logHumanAction: vi.fn(async () => undefined) }));

const access = (policy: Partial<FieldPolicy>, revealed: Array<'tin' | 'bank'> = []): FieldAccess => ({
  policy: { ...LOCKED_FIELD_POLICY, ...policy },
  revealed: new Set(revealed),
});

describe('field masks — masked by default', () => {
  it('last-4 mask', () => {
    expect(last4Mask('12-3456789')).toBe('•••• 6789');
    expect(last4Mask('  ')).toBeNull();
    expect(last4Mask(null)).toBeNull();
  });

  it('tin / bank: hidden → null, masked → last 4, reveal_logged → last 4 until revealed, visible → raw', () => {
    expect(maskValue('tin', '123456789', access({ tin: 'hidden' }))).toBeNull();
    expect(maskValue('tin', '123456789', access({ tin: 'masked' }))).toBe('•••• 6789');
    expect(maskValue('tin', '123456789', access({ tin: 'masked' }, ['tin']))).toBe('•••• 6789');
    expect(maskValue('tin', '123456789', access({ tin: 'reveal_logged' }))).toBe('•••• 6789');
    expect(maskValue('tin', '123456789', access({ tin: 'reveal_logged' }, ['tin']))).toBe('123456789');
    expect(maskValue('bank', '000123', access({ bank: 'visible' }))).toBe('000123');
  });

  it('comp: only visible returns the number; grouped / hidden → null. secrets: always null', () => {
    expect(maskValue('comp', 5000, access({ comp: 'visible' }))).toBe(5000);
    expect(maskValue('comp', 5000, access({ comp: 'grouped' }))).toBeNull();
    expect(maskValue('comp', 5000, access({ comp: 'hidden' }))).toBeNull();
    expect(maskValue('secrets', 'sk_live_x', access({ comp: 'visible', tin: 'visible', bank: 'visible' }))).toBeNull();
  });

  it('applyFieldMasks reports masked columns and never mutates the input', () => {
    const row = { id: 'e1', gross_cents: 100000, name: 'A' };
    const res = applyFieldMasks(row, { gross_cents: 'comp' }, access({ comp: 'grouped' }));
    expect(res.row).toEqual({ id: 'e1', gross_cents: null, name: 'A' });
    expect(res.masked).toEqual(['gross_cents']);
    expect(row.gross_cents).toBe(100000);
  });

  it('normalizeFieldPolicy fills invalid / missing levels from the (restrictive) fallback', () => {
    expect(normalizeFieldPolicy({ comp: 'visible', tin: 'bogus' })).toEqual({ ...LOCKED_FIELD_POLICY, comp: 'visible' });
    expect(normalizeFieldPolicy(null)).toEqual(LOCKED_FIELD_POLICY);
  });

  it('a reveal needs a reason and only tin / bank are revealable', () => {
    expect(parseRevealRequest('https://x/api/v?reveal=tin')).toBeNull();
    expect(parseRevealRequest('https://x/api/v?reveal=tin&reason=ok')).toBeNull();
    expect(parseRevealRequest('https://x/api/v?reveal=tin,comp,bank&reason=W-9%20check')).toEqual({ classes: ['tin', 'bank'], reason: 'W-9 check' });
  });
});

// ── resolveFieldAccess against a tiny fake service-role client ────────────────
function fakeAdmin(opts: { role: string | null; fieldPolicy?: Record<string, string> | null; failReveal?: boolean }) {
  const inserts: Array<Record<string, unknown>[]> = [];
  const q = (table: string) => {
    const chain = {
      select: () => chain, eq: () => chain, limit: () => chain,
      maybeSingle: async () => {
        if (table === 'employees') return { data: opts.role ? { role: opts.role } : null, error: null };
        if (table === 'role_definitions') return { data: opts.fieldPolicy ? { field_policy: opts.fieldPolicy } : null, error: null };
        return { data: null, error: null };
      },
      insert: async (rows: Record<string, unknown>[]) => {
        inserts.push(rows);
        return { error: opts.failReveal ? { message: 'boom' } : null };
      },
    };
    return chain;
  };
  const db = { schema: () => ({ from: q }), from: q } as unknown as SupabaseClient;
  return { db, inserts };
}

describe('resolveFieldAccess', () => {
  const subject = { table: 'vendors', ids: ['v1'] };

  it('unknown / absent role → everything locked', async () => {
    const { db } = fakeAdmin({ role: null });
    const a = await resolveFieldAccess(db, 'org', 'user');
    expect(a.policy).toEqual(LOCKED_FIELD_POLICY);
  });

  it('a reveal_logged role that asks to reveal (with reason) is unmasked AND logged', async () => {
    const { db, inserts } = fakeAdmin({ role: 'cfo', fieldPolicy: { comp: 'visible', tin: 'reveal_logged', bank: 'masked', personal: 'hidden' } });
    const a = await resolveFieldAccess(db, 'org', 'user', { request: { classes: ['tin', 'bank'], reason: 'W-9 check' }, subject });
    expect([...a.revealed]).toEqual(['tin']); // bank is only `masked` → not revealable
    expect(inserts).toHaveLength(1);
    expect(inserts[0][0]).toMatchObject({ org_id: 'org', field_class: 'tin', subject_table: 'vendors', subject_id: 'v1', reason: 'W-9 check' });
  });

  it('a masked role asking to reveal stays masked and nothing is logged', async () => {
    const { db, inserts } = fakeAdmin({ role: 'accounting_specialist', fieldPolicy: { comp: 'grouped', tin: 'masked', bank: 'masked', personal: 'hidden' } });
    const a = await resolveFieldAccess(db, 'org', 'user', { request: { classes: ['tin'], reason: 'curious' }, subject });
    expect(a.revealed.size).toBe(0);
    expect(inserts).toHaveLength(0);
  });

  it('no unlogged reveal: when the log write fails the value stays masked', async () => {
    const { db } = fakeAdmin({ role: 'cfo', fieldPolicy: { comp: 'visible', tin: 'reveal_logged', bank: 'masked', personal: 'hidden' }, failReveal: true });
    const a = await resolveFieldAccess(db, 'org', 'user', { request: { classes: ['tin'], reason: 'W-9 check' }, subject });
    expect(a.revealed.size).toBe(0);
  });

  it('wave 2G: a reveal over the cap is refused outright — never "log some, unmask all"', async () => {
    const { db, inserts } = fakeAdmin({ role: 'cfo', fieldPolicy: { comp: 'visible', tin: 'reveal_logged', bank: 'masked', personal: 'hidden' } });
    const ids = Array.from({ length: MAX_REVEAL_SUBJECTS + 1 }, (_, i) => `v${i}`);
    const a = await resolveFieldAccess(db, 'org', 'user', { request: { classes: ['tin'], reason: 'W-9 check' }, subject: { table: 'vendors', ids } });
    expect(a.revealed.size).toBe(0);
    expect(inserts).toHaveLength(0);
  });

  it('wave 2G: at the cap every subject is logged (one row each, duplicates collapsed)', async () => {
    const { db, inserts } = fakeAdmin({ role: 'cfo', fieldPolicy: { comp: 'visible', tin: 'reveal_logged', bank: 'masked', personal: 'hidden' } });
    const ids = [...Array.from({ length: MAX_REVEAL_SUBJECTS }, (_, i) => `v${i}`), 'v0'];
    const a = await resolveFieldAccess(db, 'org', 'user', { request: { classes: ['tin'], reason: 'W-9 check' }, subject: { table: 'vendors', ids } });
    expect([...a.revealed]).toEqual(['tin']);
    expect(inserts[0]).toHaveLength(MAX_REVEAL_SUBJECTS);
  });
});

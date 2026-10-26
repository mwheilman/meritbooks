/**
 * Report packs — number governance. Scheduled / emailed delivery is governed by the
 * RECIPIENT audience (always non-finance, whoever scheduled it): an unreleased section is
 * never read and the delivery is HELD; interactive downloads follow the reader.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { CO_A, chainSupabase, company, facts, factsLoader } from '@/test/governance-facts';
import type { ResolvedPack } from './spec';
import * as React from 'react';

// scheduled-delivery.tsx renders JSX with the classic runtime under vitest.
vi.stubGlobal('React', React);

// The scheduler's user would be finance — it must not matter for emailed packs.
vi.mock('@/lib/rbac/require-permission', () => ({ requirePermission: async () => ({ ok: true }) }));
vi.mock('@/lib/dates/org-today', () => ({ getOrgToday: async () => '2026-10-24' }));
vi.mock('@/lib/reports/governance/load', async (orig) => ({
  ...(await orig<typeof import('@/lib/reports/governance/load')>()),
  // Jan–Sep closed, released through Jul.
  loadGovernanceFacts: factsLoader(() => facts(company(CO_A, [1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 5, 6, 7]))),
}));
const fetchIncomeStatement = vi.fn(async () => ({ sections: [], summary: {} }));
vi.mock('@/app/api/reports/board-package/queries', () => ({
  fetchIncomeStatement: (...a: unknown[]) => fetchIncomeStatement(...(a as [])),
  fetchBalanceSheet: vi.fn(),
  fetchCashFlow: vi.fn(),
  fetchArAging: vi.fn(),
  fetchApAging: vi.fn(),
}));
vi.mock('@/lib/reports/export/build-model', () => ({
  buildIncomeStatement: () => ({ title: 'Income Statement', entityLabel: '', periodLabel: '', generatedAt: '', columns: [{ key: 'a', label: 'A', money: true }], rows: [{ kind: 'total', label: 'Net income', values: [123_45] }] }),
  buildBalanceSheet: vi.fn(),
  buildCashFlow: vi.fn(),
  buildTrialBalance: vi.fn(),
}));
vi.mock('@react-pdf/renderer', () => ({ renderToBuffer: async () => Buffer.from('%PDF') }));
vi.mock('@/app/api/reports/compile/compile-pack-pdf', () => ({ CompilePackPdf: () => null }));
vi.mock('@/lib/reports/compiler/org-scoped-client', () => ({ createOrgScopedSupabase: () => chainSupabase() }));
const send = vi.fn(async () => undefined);
vi.mock('@/lib/email/provider', () => ({
  resolveEmailProvider: () => ({ send }),
  resolveFromAddress: () => 'reports@example.com',
  EmailSendError: class extends Error {},
}));
let pack: ResolvedPack;
vi.mock('@/lib/reports/compiler/packs', () => ({
  parseStoredSpecs: () => [],
  resolveSavedPack: () => pack,
  nextOccurrence: () => '2026-11-01',
  cadenceLabel: () => 'Monthly',
}));

const { runPack } = await import('./run');
const { heldReason } = await import('./governance');
const { deliverDuePacks } = await import('./scheduled-delivery');

const JUL = { startDate: '2026-07-01', endDate: '2026-07-31', asOfDate: '2026-07-31', label: 'Jul 2026' };
const SEP = { startDate: '2026-09-01', endDate: '2026-09-30', asOfDate: '2026-09-30', label: 'Sep 2026' };
const packOf = (...periods: (typeof JUL)[]): ResolvedPack => ({
  entityLabel: 'Alpha',
  locationIds: [CO_A],
  specs: [{ report: 'INCOME_STATEMENT', basis: 'ACCRUAL', periods, cashWarning: null }],
});

function admin(updates: Array<Record<string, unknown>>): SupabaseClient {
  const row = { id: 'pack-1', org_id: 'org-1', name: 'Monthly pack', entity_label: 'Alpha', location_ids: [CO_A], specs: {}, schedule_cadence: 'MONTHLY', recipients: ['lender@bank.example'], next_run_date: '2026-10-24' };
  const base = chainSupabase(() => ({ data: [row], error: null }));
  const from = (t: string) => {
    const q = base.from(t) as unknown as Record<string, unknown>;
    return new Proxy(q, {
      get(target, prop) {
        if (prop === 'update') return (v: Record<string, unknown>) => { updates.push(v); return q; };
        return (target as Record<string | symbol, unknown>)[prop];
      },
    });
  };
  // core.* reads (the H3 creator-scope check): the org's client_scope_rls_mode is unset → 'off'.
  return { from, schema: () => ({ from }) } as unknown as SupabaseClient;
}

beforeEach(() => {
  fetchIncomeStatement.mockClear();
  send.mockClear();
});

describe('runPack — governed per reader', () => {
  it('no user (emailed): released sections compile, unreleased ones are withheld WITHOUT reading figures', async () => {
    const out = await runPack(chainSupabase(), 'org-1', packOf(JUL, SEP), { userId: null });
    expect(out.sections).toHaveLength(2);
    expect(out.sections[0].withheld).toBeFalsy();
    expect(out.sections[1].withheld).toBe(true);
    expect(JSON.stringify(out.sections[1].model)).not.toContain('12345');
    expect(fetchIncomeStatement).toHaveBeenCalledTimes(1);
    expect(out.withheld).toEqual([{ report: 'INCOME_STATEMENT', periodLabel: 'Sep 2026', periods: ['2026-09'] }]);
    expect(heldReason(out)).toMatch(/not released/);
  });

  it('a finance reader downloading interactively sees every section (labelled preview)', async () => {
    const out = await runPack(chainSupabase(), 'org-1', packOf(JUL, SEP), { userId: 'user_1' });
    expect(out.withheld).toEqual([]);
    expect(out.sections[1].model.watermark).toBe('PREVIEW — NOT RELEASED');
    expect(heldReason(out)).toBeNull();
  });
});

describe('deliverDuePacks — external recipients', () => {
  it('holds a pack whose period is not released (nothing is emailed) and records why', async () => {
    pack = packOf(JUL, SEP);
    const updates: Array<Record<string, unknown>> = [];
    const res = await deliverDuePacks(admin(updates), { orgId: 'org-1', today: '2026-10-24' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(send).not.toHaveBeenCalled();
    expect(res.results[0].status).toBe('SKIPPED');
    expect(res.results[0].detail).toMatch(/^held — not released/);
    expect(updates.some((u) => String(u.last_run_status ?? '').startsWith('HELD:'))).toBe(true);
  });

  it('delivers a pack whose every section is released', async () => {
    pack = packOf(JUL);
    const res = await deliverDuePacks(admin([]), { orgId: 'org-1', today: '2026-10-24' });
    expect(res.ok && res.delivered).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

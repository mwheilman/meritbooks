import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolvePlanLines, type RoleMapRow } from './posting';
import { DealerError } from './errors';
import { flooringPlan, interestAccrualPlan } from '../engine/floor-plan-postings';
import type { DealerCtx } from './context';
import type { DeptRole } from '../types';

/** Minimal PostgREST stand-in: from('accounts').select().eq().in() → preset rows. */
function fakeAdmin(accounts: Record<string, unknown>[]): SupabaseClient {
  const builder = {
    select: () => builder,
    eq: () => builder,
    in: (_c: string, ids: string[]) => Promise.resolve({ data: accounts.filter((a) => ids.includes(a.id as string)), error: null }),
  };
  return { from: () => builder } as unknown as SupabaseClient;
}

const ctx = (accounts: Record<string, unknown>[]): DealerCtx => ({
  userId: 'user_a', orgId: 'org', locationId: 'loc', db: fakeAdmin([]), admin: fakeAdmin(accounts),
});
const roleMap = (pairs: Record<string, string | null>) =>
  new Map<string, RoleMapRow>(Object.entries(pairs).map(([k, v]) => [k, { role_key: k, account_id: v, mapped_directly: true }]));
const DEPTS = new Map<DeptRole, string>([['WG_NEW', 'dept-new'], ['PARTS', 'dept-parts'], ['SERVICE', 'dept-svc']]);

const INV = { id: 'acc-inv', account_type: 'ASSET', account_sub_type: 'CURRENT_ASSET', account_number: '1400', is_active: true };
const FPP = { id: 'acc-fpp', account_type: 'LIABILITY', account_sub_type: 'CURRENT_LIABILITY', account_number: '2150', is_active: true };

describe('resolvePlanLines (role → account, type-derived DR/CR, departments)', () => {
  const plan = flooringPlan({ principalCents: 1_000_000, inventoryRole: 'WHOLE_GOODS_INVENTORY', deptRole: 'WG_NEW', memo: 'U-1' });

  it('resolves roles, derives DR/CR from the account type and tags every line with the department', async () => {
    const lines = await resolvePlanLines(ctx([INV, FPP]), plan, {
      roleMap: roleMap({ WHOLE_GOODS_INVENTORY: 'acc-inv', FLOOR_PLAN_PAYABLE: 'acc-fpp' }),
      deptMap: DEPTS,
    });
    expect(lines.map((l) => [l.account_id, l.debit_cents, l.credit_cents, l.department_id, l.location_id])).toEqual([
      ['acc-inv', 1_000_000, 0, 'dept-new', 'loc'],
      ['acc-fpp', 0, 1_000_000, 'dept-new', 'loc'],
    ]);
  });

  it('refuses with a plain-English message when a role is unmapped', async () => {
    const err = await resolvePlanLines(ctx([INV]), plan, { roleMap: roleMap({ WHOLE_GOODS_INVENTORY: 'acc-inv', FLOOR_PLAN_PAYABLE: null }), deptMap: DEPTS }).catch((e) => e);
    expect(err).toBeInstanceOf(DealerError);
    expect((err as DealerError).code).toBe('UNMAPPED_ROLE');
    expect((err as Error).message).toMatch(/Map 'Floor plan payable' \(FLOOR_PLAN_PAYABLE\) for this client/);
  });

  it('refuses a role mapped to the wrong account type (cannot invert a leg)', async () => {
    const asExpense = { ...FPP, account_type: 'OPEX', account_sub_type: 'OPERATING_EXPENSE' };
    const err = await resolvePlanLines(ctx([INV, asExpense]), plan, {
      roleMap: roleMap({ WHOLE_GOODS_INVENTORY: 'acc-inv', FLOOR_PLAN_PAYABLE: 'acc-fpp' }), deptMap: DEPTS,
    }).catch((e) => e);
    expect((err as DealerError).code).toBe('UNMAPPED_ROLE');
    expect((err as Error).message).toMatch(/must be LIABILITY/);
  });

  it('honours a line-level payable override', async () => {
    const own = { ...FPP, id: 'acc-line' };
    const p = flooringPlan({ principalCents: 5, inventoryRole: 'WHOLE_GOODS_INVENTORY', deptRole: 'WG_NEW', lineLiabilityAccountId: 'acc-line', memo: 'x' });
    const lines = await resolvePlanLines(ctx([INV, own]), p, { roleMap: roleMap({ WHOLE_GOODS_INVENTORY: 'acc-inv', FLOOR_PLAN_PAYABLE: 'acc-fpp' }), deptMap: DEPTS });
    expect(lines[1].account_id).toBe('acc-line');
  });

  it('accepts floor plan interest on an OTHER (other-expense) account, refuses other-income', async () => {
    const accrual = interestAccrualPlan([{ amountCents: 7_397, deptRole: 'WG_NEW' }], 'acc');
    const otherExp = { id: 'acc-int', account_type: 'OTHER', account_sub_type: 'OTHER_EXPENSE', account_number: '8000', is_active: true };
    const accrued = { id: 'acc-accr', account_type: 'LIABILITY', account_sub_type: 'CURRENT_LIABILITY', account_number: '2155', is_active: true };
    const rm = roleMap({ FLOOR_PLAN_INTEREST: 'acc-int', FLOOR_PLAN_INTEREST_ACCRUED: 'acc-accr' });
    const lines = await resolvePlanLines(ctx([otherExp, accrued]), accrual, { roleMap: rm, deptMap: DEPTS });
    expect(lines.map((l) => [l.debit_cents, l.credit_cents])).toEqual([[7_397, 0], [0, 7_397]]);
    const otherInc = { ...otherExp, account_sub_type: 'OTHER_INCOME' };
    const err = await resolvePlanLines(ctx([otherInc, accrued]), accrual, { roleMap: rm, deptMap: DEPTS }).catch((e) => e);
    expect((err as DealerError).code).toBe('UNMAPPED_ROLE');
  });

  it('refuses when the department role is unmapped', async () => {
    const err = await resolvePlanLines(ctx([INV, FPP]), plan, {
      roleMap: roleMap({ WHOLE_GOODS_INVENTORY: 'acc-inv', FLOOR_PLAN_PAYABLE: 'acc-fpp' }), deptMap: new Map(),
    }).catch((e) => e);
    expect((err as DealerError).code).toBe('UNMAPPED_DEPARTMENT');
  });
});

/**
 * Wave 2G — H6_JE_SELF_POST at the manual JE post routes, by access mode:
 * v2 refuses at/above the tenant threshold; dual allows and logs the would-deny
 * (unexplained, so the tenant must acknowledge it before the flip); legacy allows.
 */
import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { checkManualJePostSod, type JePostSodDeps } from './je-post-sod';
import type { EnforcementMode } from './authorize';

const admin = {} as SupabaseClient;
const input = { orgId: 'org1', actor: 'user_1', amountCents: 30_000_00, route: '/api/gl/post' };

function deps(mode: EnforcementMode | null, threshold = 25_000_00) {
  const logWouldDeny = vi.fn(async () => undefined);
  const d: Partial<JePostSodDeps> = { mode: async () => mode, thresholdCents: async () => threshold, logWouldDeny };
  return { d, logWouldDeny };
}

describe('checkManualJePostSod', () => {
  it('a separately prepared entry (e.g. a WIP proposal): only the preparer is refused', async () => {
    const { d } = deps('v2');
    // someone else approves the proposal → fine
    expect(await checkManualJePostSod(admin, { ...input, preparedBy: 'user_9' }, d)).toEqual({ ok: true, wouldDeny: false });
    // the proposer approves their own proposal at/above the threshold → refused
    expect(await checkManualJePostSod(admin, { ...input, preparedBy: 'user_1' }, d)).toMatchObject({ ok: false, code: 'SOD_SELF_POST' });
    // a scheduler-made proposal has no human preparer → no conflict
    expect(await checkManualJePostSod(admin, { ...input, preparedBy: null }, d)).toEqual({ ok: true, wouldDeny: false });
  });

  it('v2: at/above the threshold the preparer cannot post their own entry', async () => {
    const { d } = deps('v2');
    expect(await checkManualJePostSod(admin, input, d)).toMatchObject({ ok: false, status: 409, code: 'SOD_SELF_POST' });
    expect(await checkManualJePostSod(admin, { ...input, amountCents: 25_000_00 }, d)).toMatchObject({ ok: false });
    expect(await checkManualJePostSod(admin, { ...input, amountCents: 24_999_99 }, d)).toEqual({ ok: true, wouldDeny: false });
  });

  it('an unreadable mode is treated as enforcing (fail closed)', async () => {
    const { d } = deps(null);
    expect((await checkManualJePostSod(admin, input, d)).ok).toBe(false);
  });

  it('dual: allowed, and the would-deny is logged once', async () => {
    const { d, logWouldDeny } = deps('dual');
    expect(await checkManualJePostSod(admin, input, d)).toEqual({ ok: true, wouldDeny: true });
    expect(logWouldDeny).toHaveBeenCalledTimes(1);
  });

  it('legacy: allowed, nothing logged', async () => {
    const { d, logWouldDeny } = deps('legacy');
    expect(await checkManualJePostSod(admin, input, d)).toEqual({ ok: true, wouldDeny: true });
    expect(logWouldDeny).not.toHaveBeenCalled();
  });

  it('v2 with unreadable settings fails closed (503); dual does not block', async () => {
    const boom: Partial<JePostSodDeps> = { mode: async () => 'v2', thresholdCents: async () => { throw new Error('db'); } };
    expect(await checkManualJePostSod(admin, input, boom)).toMatchObject({ ok: false, status: 503 });
    const dual: Partial<JePostSodDeps> = { mode: async () => 'dual', thresholdCents: async () => { throw new Error('db'); } };
    expect((await checkManualJePostSod(admin, input, dual)).ok).toBe(true);
  });
});

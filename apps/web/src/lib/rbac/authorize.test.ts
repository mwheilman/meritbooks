/**
 * authorize() — the R-11 policy decision point in its three enforcement modes
 * (05-RBAC-SPEC §5.1, §5.7). Pure: every DB dependency is injected.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MONEY_APPROVE_REFS,
  authorize,
  authorizeAny,
  authorizeLegacyCell,
  classifyDisagreement,
  flushDualRunLogs,
  refsForLegacyCell,
  resetDualRunDedupe,
  v2AccessFromSnapshot,
  DEFAULT_DEPS,
  type AuthorizeDeps,
  type CapabilityRef,
  type DualRunLogEntry,
  type EnforcementMode,
} from './authorize';
import type { AccessSnapshot } from './effective-access';

const CTX = { userId: 'user_1', orgId: '00000000-0000-0000-0000-0000000000a1' };

/** A v2 world where exactly `held` (cap:action) are allowed; view is implied by any held action. */
function fakeDeps(opts: {
  mode: EnforcementMode | 'throw';
  held?: string[];
  legacy?: boolean;
  v2Throws?: boolean;
  dbCheck?: boolean;
  log?: (e: DualRunLogEntry) => Promise<void>;
}): { deps: Partial<AuthorizeDeps>; logs: DualRunLogEntry[]; calls: { v2: number; legacy: number; db: number } } {
  const held = new Set(opts.held ?? []);
  const logs: DualRunLogEntry[] = [];
  const calls = { v2: 0, legacy: 0, db: 0 };
  const deps: Partial<AuthorizeDeps> = {
    mode: async () => {
      if (opts.mode === 'throw') throw new Error('db down');
      return opts.mode;
    },
    legacy: async () => {
      calls.legacy++;
      return opts.legacy ?? false;
    },
    v2: async () => {
      calls.v2++;
      if (opts.v2Throws) throw new Error('snapshot failed');
      return {
        membershipId: 'mem-1',
        decide: (r: CapabilityRef) => {
          if (held.has(`${r.capability}:${r.action}`)) return { allow: true, implied: false, reason: 'ok' };
          if (r.action === 'view' && [...held].some((h) => h.startsWith(`${r.capability}:`))) return { allow: true, implied: true, reason: 'ok' };
          return { allow: false, implied: false, reason: 'no_grant' };
        },
      };
    },
    dbCheck: async () => {
      calls.db++;
      return opts.dbCheck ?? true;
    },
    log: opts.log ?? (async (e) => { logs.push(e); }),
    route: async () => '/api/test',
    legacyGrants: async () => null,
  };
  return { deps, logs, calls };
}

beforeEach(() => resetDualRunDedupe());

describe('legacy mode', () => {
  it('returns the legacy decision and never computes v2 or logs', async () => {
    const { deps, logs, calls } = fakeDeps({ mode: 'legacy', held: [], legacy: true });
    const d = await authorize(CTX, 'ap.bills', 'approve', {}, deps);
    await flushDualRunLogs();
    expect(d).toMatchObject({ allow: true, mode: 'legacy', legacy: true, v2: null });
    expect(calls.v2).toBe(0);
    expect(logs).toHaveLength(0);
  });

  it('a call-site legacy thunk wins over the default evaluator', async () => {
    const { deps, calls } = fakeDeps({ mode: 'legacy', legacy: true });
    const d = await authorize(CTX, 'ap.bills', 'approve', { legacy: async () => false }, deps);
    expect(d.allow).toBe(false);
    expect(calls.legacy).toBe(0);
  });

  it('a throwing legacy thunk fails closed', async () => {
    const { deps } = fakeDeps({ mode: 'legacy' });
    const d = await authorize(CTX, 'ap.bills', 'approve', { legacy: async () => { throw new Error('x'); } }, deps);
    expect(d.allow).toBe(false);
  });
});

describe('dual mode — legacy decides, v2 is compared', () => {
  it('returns LEGACY even when v2 disagrees (both directions)', async () => {
    const a = fakeDeps({ mode: 'dual', held: [], legacy: true });
    expect((await authorize(CTX, 'ap.bills', 'approve', {}, a.deps)).allow).toBe(true);
    const b = fakeDeps({ mode: 'dual', held: ['ap.bills:approve'], legacy: false });
    expect((await authorize(CTX, 'ap.bills', 'approve', {}, b.deps)).allow).toBe(false);
  });

  it('logs only on disagreement', async () => {
    const agree = fakeDeps({ mode: 'dual', held: ['ap.bills:approve'], legacy: true });
    const d1 = await authorize(CTX, 'ap.bills', 'approve', {}, agree.deps);
    await flushDualRunLogs();
    expect(d1.disagreement).toBeNull();
    expect(agree.logs).toHaveLength(0);

    const differ = fakeDeps({ mode: 'dual', held: [], legacy: true });
    const d2 = await authorize(CTX, 'ap.bills', 'approve', { locationId: 'loc-1' }, differ.deps);
    await flushDualRunLogs();
    expect(d2.disagreement).toBe('disagree');
    expect(differ.logs).toHaveLength(1);
    expect(differ.logs[0]).toMatchObject({
      orgId: CTX.orgId, clerkUserId: CTX.userId, membershipId: 'mem-1', capability: 'ap.bills', action: 'approve',
      locationId: 'loc-1', legacyDecision: true, v2Decision: false, route: '/api/test', kind: 'disagree', explained: false,
    });
  });

  it('dedupes a repeated disagreement within the window', async () => {
    const f = fakeDeps({ mode: 'dual', held: [], legacy: true });
    for (let i = 0; i < 5; i++) await authorize(CTX, 'ap.bills', 'approve', {}, f.deps);
    await flushDualRunLogs();
    expect(f.logs).toHaveLength(1);
    // a different route is a different finding
    await authorize(CTX, 'ap.bills', 'approve', { route: '/api/other' }, f.deps);
    await flushDualRunLogs();
    expect(f.logs).toHaveLength(2);
  });

  it('a failing log sink never blocks or throws (async rejection and sync throw)', async () => {
    const rejecting = fakeDeps({ mode: 'dual', held: [], legacy: true, log: async () => { throw new Error('insert failed'); } });
    await expect(authorize(CTX, 'ap.bills', 'approve', {}, rejecting.deps)).resolves.toMatchObject({ allow: true });
    resetDualRunDedupe();
    const throwing = fakeDeps({ mode: 'dual', held: [], legacy: true });
    throwing.deps.log = (() => { throw new Error('sync boom'); }) as unknown as AuthorizeDeps['log'];
    await expect(authorize(CTX, 'ap.bills', 'approve', {}, throwing.deps)).resolves.toMatchObject({ allow: true });
    await expect(flushDualRunLogs()).resolves.toBeUndefined();
  });

  it('does not wait for the log write before answering', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    const f = fakeDeps({ mode: 'dual', held: [], legacy: true, log: () => gate });
    const d = await authorize(CTX, 'ap.bills', 'approve', {}, f.deps);
    expect(d.allow).toBe(true); // answered while the log write is still pending
    release();
    await flushDualRunLogs();
  });

  it('a v2 failure keeps the legacy answer and is logged as v2_error (unexplained)', async () => {
    const f = fakeDeps({ mode: 'dual', legacy: true, v2Throws: true });
    const d = await authorize(CTX, 'ap.bills', 'approve', {}, f.deps);
    await flushDualRunLogs();
    expect(d.allow).toBe(true);
    expect(f.logs[0]).toMatchObject({ kind: 'v2_error', explained: false, v2Decision: null });
  });

  it('never calls the DB re-check', async () => {
    const f = fakeDeps({ mode: 'dual', held: ['gl.journal_entries:post'], legacy: true });
    await authorize(CTX, 'gl.journal_entries', 'post', {}, f.deps);
    expect(f.calls.db).toBe(0);
  });
});

describe('v2 mode — the capability model decides', () => {
  it('returns v2 and ignores legacy', async () => {
    const f = fakeDeps({ mode: 'v2', held: ['ap.bills:create'], legacy: false });
    expect((await authorize(CTX, 'ap.bills', 'create', {}, f.deps)).allow).toBe(true);
    const g = fakeDeps({ mode: 'v2', held: [], legacy: true });
    expect((await authorize(CTX, 'ap.bills', 'create', {}, g.deps)).allow).toBe(false);
    expect(g.calls.legacy).toBe(0);
  });

  it('post / approve / release are re-decided by the DB and the DB can veto', async () => {
    for (const action of ['post', 'approve', 'release'] as const) {
      const cap = action === 'post' ? 'gl.journal_entries' : 'pay.batches';
      const ok = fakeDeps({ mode: 'v2', held: [`${cap}:${action}`], dbCheck: true });
      expect((await authorize(CTX, cap, action, {}, ok.deps)).allow).toBe(true);
      expect(ok.calls.db).toBe(1);
      const veto = fakeDeps({ mode: 'v2', held: [`${cap}:${action}`], dbCheck: false });
      const d = await authorize(CTX, cap, action, {}, veto.deps);
      expect(d).toMatchObject({ allow: false, reason: 'db_deny' });
    }
  });

  it('view / create do not hit the DB re-check', async () => {
    const f = fakeDeps({ mode: 'v2', held: ['ap.bills:create'] });
    await authorize(CTX, 'ap.bills', 'view', {}, f.deps);
    await authorize(CTX, 'ap.bills', 'create', {}, f.deps);
    expect(f.calls.db).toBe(0);
  });

  it('a v2 failure denies (fail closed)', async () => {
    const f = fakeDeps({ mode: 'v2', legacy: true, v2Throws: true });
    expect((await authorize(CTX, 'ap.bills', 'view', {}, f.deps)).allow).toBe(false);
  });

  it('amountCents / preparedBy reach the 2C constraints hook; nothing else evaluates them', async () => {
    const f = fakeDeps({ mode: 'v2', held: ['pay.batches:approve'] });
    const constraints = vi.fn(async (allow: boolean) => allow);
    f.deps.constraints = constraints;
    const d = await authorize(CTX, 'pay.batches', 'approve', { amountCents: 9_999_999_00, preparedBy: 'user_2' }, f.deps);
    expect(d.allow).toBe(true);
    expect(constraints).toHaveBeenCalledWith(true, CTX, [{ capability: 'pay.batches', action: 'approve' }],
      expect.objectContaining({ amountCents: 9_999_999_00, preparedBy: 'user_2' }));
  });
});

describe('mode unreadable — fail closed', () => {
  it('allows only when BOTH legacy and v2 allow', async () => {
    expect((await authorize(CTX, 'ap.bills', 'view', {}, fakeDeps({ mode: 'throw', held: ['ap.bills:view'], legacy: true }).deps)).allow).toBe(true);
    expect((await authorize(CTX, 'ap.bills', 'view', {}, fakeDeps({ mode: 'throw', held: [], legacy: true }).deps)).allow).toBe(false);
    expect((await authorize(CTX, 'ap.bills', 'view', {}, fakeDeps({ mode: 'throw', held: ['ap.bills:view'], legacy: false }).deps)).allow).toBe(false);
  });
});

describe('classification of expected disagreements', () => {
  it('05 §2.3 tighten rows', () => {
    expect(classifyDisagreement({ legacy: true, v2: false, v2Implied: false, refs: [{ capability: 'pay.vendor_bank_details', action: 'edit' }], equivalentAllowed: false })).toBe('tighten');
  });
  it('view implied by another held action', async () => {
    const f = fakeDeps({ mode: 'dual', held: ['ap.bills:create'], legacy: false });
    const d = await authorize(CTX, 'ap.bills', 'view', {}, f.deps);
    expect(d.disagreement).toBe('implied_view');
  });
  it('v2 allowing what another legacy key already granted is same_capability_other_key', async () => {
    const f = fakeDeps({ mode: 'dual', held: ['ar.invoices:view'], legacy: false });
    f.deps.legacyGrants = async () => new Map([['ar.invoices', new Set(['view' as const])]]);
    const d = await authorizeLegacyCell(CTX, 'invoices', 'view', {}, f.deps);
    expect(d.disagreement).toBe('same_capability_other_key');
    const g = fakeDeps({ mode: 'dual', held: ['ar.invoices:view'], legacy: false });
    expect((await authorizeLegacyCell(CTX, 'invoices', 'view', {}, g.deps)).disagreement).toBe('disagree');
  });
  it('retired legacy cells map to their granular equivalents', async () => {
    expect(refsForLegacyCell('payments', 'run').map((r) => `${r.capability}:${r.action}`)).toContain('pay.batches:release');
    expect(refsForLegacyCell('journal_entries', 'post')).toEqual([{ capability: 'gl.journal_entries', action: 'post' }]);
    const f = fakeDeps({ mode: 'dual', held: [], legacy: true });
    const d = await authorizeLegacyCell(CTX, 'payments', 'run', {}, f.deps);
    expect(d.disagreement).toBe('unmapped_cell');
  });
  it('per-kind money approval narrowing is classified money_kind and needs acknowledgement', async () => {
    const f = fakeDeps({ mode: 'dual', held: ['ap.bills:approve'], legacy: true });
    const d = await authorizeAny(CTX, [{ capability: 'payroll.runs', action: 'approve' }], { equivalentRefs: MONEY_APPROVE_REFS }, f.deps);
    await flushDualRunLogs();
    expect(d).toMatchObject({ allow: true, disagreement: 'money_kind' });
    expect(f.logs[0]).toMatchObject({ kind: 'money_kind', explained: false });
  });
  it('MONEY_APPROVE_REFS are the v2 images of the legacy money-approve cells', () => {
    expect(MONEY_APPROVE_REFS.map((r) => `${r.capability}:${r.action}`).sort())
      .toEqual(['ap.bills:approve', 'pay.batches:approve', 'payroll.runs:approve']);
  });
});

describe('v2AccessFromSnapshot (pure resolver adapter)', () => {
  const snap: AccessSnapshot = {
    membership: { id: 'm1', orgId: CTX.orgId, status: 'active', audience: 'internal_staff', accessEpoch: 0 },
    envelopes: {},
    assignments: [{
      id: 'a1', grantType: 'role',
      source: { id: 'r1', key: 'bookkeeper', name: 'Bookkeeper', ownerLevel: 'tenant', locationId: null, audience: 'internal_staff', version: 1 },
      grants: [{ capability: 'ap.bills', actions: ['view', 'create'], constraints: { amount_limit: { max_per_item_cents: 100 } } }],
      scopeType: 'client', locationId: 'L1', clientSetId: null, clientSetLocationIds: [], groupId: null,
      readOnly: false, muted: {}, constraintOverrides: {}, effectiveFrom: null, effectiveTo: null, status: 'active',
    }],
  };
  it('scopes to the client and treats null location as "any client"', () => {
    expect(v2AccessFromSnapshot(snap, 'L1').decide({ capability: 'ap.bills', action: 'create' }).allow).toBe(true);
    expect(v2AccessFromSnapshot(snap, 'L2').decide({ capability: 'ap.bills', action: 'create' }).allow).toBe(false);
    expect(v2AccessFromSnapshot(snap, null).decide({ capability: 'ap.bills', action: 'create' }).allow).toBe(true);
  });
  it('unknown capabilities deny', () => {
    expect(v2AccessFromSnapshot(snap, null).decide({ capability: 'nope.nothing', action: 'view' })).toMatchObject({ allow: false, reason: 'unknown_capability' });
  });
});

describe('wave 2G — dollar limits on approve / post / release', () => {
  const withLimit = (deps: Partial<AuthorizeDeps>, maxCents: number): Partial<AuthorizeDeps> => ({
    ...deps,
    v2: async (ctx, loc) => {
      const base = await deps.v2!(ctx, loc);
      return { ...base, limit: (_ref, amount) => ({ allowed: amount <= maxCents, limitCents: maxCents, held: true }) };
    },
  });

  it('v2: over the holder\'s limit is denied (reason over_limit); within it allowed', async () => {
    const f = fakeDeps({ mode: 'v2', held: ['pay.batches:approve'] });
    const deps = withLimit(f.deps, 10_000_00);
    expect(await authorize(CTX, 'pay.batches', 'approve', { amountCents: 10_000_01 }, deps)).toMatchObject({ allow: false, reason: 'over_limit' });
    expect(await authorize(CTX, 'pay.batches', 'approve', { amountCents: 10_000_00 }, deps)).toMatchObject({ allow: true });
    // no amount → no limit check
    expect((await authorize(CTX, 'pay.batches', 'approve', {}, deps)).allow).toBe(true);
    // view is never limited
    expect((await authorize(CTX, 'pay.batches', 'view', { amountCents: 99_999_999_00 }, deps)).allow).toBe(true);
  });

  it('dual: legacy still decides; the would-deny is logged as a disagreement', async () => {
    const f = fakeDeps({ mode: 'dual', held: ['pay.batches:approve'], legacy: true });
    const d = await authorize(CTX, 'pay.batches', 'approve', { amountCents: 50_000_00, route: '/api/x' }, withLimit(f.deps, 1_000_00));
    await flushDualRunLogs();
    expect(d).toMatchObject({ allow: true, legacy: true, v2: false });
    expect(f.logs[0]).toMatchObject({ reason: 'over_limit', legacyDecision: true, v2Decision: false, route: '/api/x' });
  });

  it('v2AccessFromSnapshot applies the grant amount_limit', () => {
    const snap: AccessSnapshot = {
      membership: { id: 'm1', orgId: CTX.orgId, status: 'active', audience: 'internal_staff', accessEpoch: 0 },
      envelopes: {},
      assignments: [{
        id: 'a1', grantType: 'role',
        source: { id: 'r1', key: 'ap', name: 'AP', ownerLevel: 'tenant', locationId: null, audience: 'internal_staff', version: 1 },
        grants: [{ capability: 'ap.bills', actions: ['view', 'approve'], constraints: { amount_limit: { max_per_item_cents: 5_000_00 } } }],
        scopeType: 'all_clients', locationId: null, clientSetId: null, clientSetLocationIds: [], groupId: null,
        readOnly: false, muted: {}, constraintOverrides: {}, effectiveFrom: null, effectiveTo: null, status: 'active',
      }],
    };
    const v2 = v2AccessFromSnapshot(snap, null);
    expect(v2.limit!({ capability: 'ap.bills', action: 'approve' }, 5_000_00).allowed).toBe(true);
    expect(v2.limit!({ capability: 'ap.bills', action: 'approve' }, 5_000_01).allowed).toBe(false);
  });
});

describe('wave 2G — dual-run route label never comes from request headers', () => {
  it('the default route dependency is null → the label is the call site\'s static route or "unknown"', async () => {
    expect(await DEFAULT_DEPS.route()).toBeNull();
    const f = fakeDeps({ mode: 'dual', held: [], legacy: true });
    f.deps.route = DEFAULT_DEPS.route;
    await authorize(CTX, 'ap.bills', 'approve', {}, f.deps);
    await flushDualRunLogs();
    expect(f.logs[0].route).toBe('unknown');
  });
});

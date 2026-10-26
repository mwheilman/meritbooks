/**
 * Wave 4 security review fixes — the APP half (services, helpers, route wiring):
 *
 *   H2  a staged customer / vendor payload never carries a plaintext tax id: an org-scoped keyed
 *       fingerprint + last four replace it before the write; matching compares fingerprints.
 *   H3  pack companies (location_ids ∪ every dashboard's) are write-scope checked; an all-companies
 *       pack needs all-clients scope; at delivery the creator must STILL cover them and a dashboard
 *       renders only inside its pack's companies.
 *   H4  the combined snapshot row is written only when asked (job / all-clients caller); a row
 *       already on file for the week is skipped, never collided with.
 *   M1  org-wide cash scenarios / levers need all-clients scope; referenced ids are org-checked.
 *   M2  the FP&A summary decision row holds metadata only.
 *   M4  sign-off: cutover never in the future; closed_by gets a core.users uuid (never a Clerk id).
 *   LOW per-user AI / matcher throttles.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { PGlite } from '@electric-sql/pglite';
import { protectTaxId, tinFingerprint, tinLastFour } from '@/lib/vendors/tin-fingerprint';
import { persistablePayload } from '@/lib/onboarding/migration/server/staging';
import { matchParties as matchStaged } from '@/lib/onboarding/migration/masters';
import { assertPackWriteScope, itemWithinPack, packCompanySet, packCreatorScope } from '@/lib/reports/compiler/pack-scope';
import { clientScopeBypass, type ClientScopeState } from '@/lib/rbac/client-scope';
import { isWriteScopeError } from '@/lib/db/scoped-writer';
import { requireOrgWide, type CashRouteCtx } from '@/lib/cash/forecast/route-support';
import { userRateLimited } from '@/lib/security/user-limits';
import { createRateLimiter } from '@/lib/security/rate-limit';
import { closerUserUuid } from '@/lib/services/fiscal-periods';
import { cutoverNotInFuture } from '@/lib/validations/onboarding-migration';
import { takeSnapshots, type ForecastRequest, type WorkspaceForecast } from '@/lib/cash/forecast/service';
import { createTestDb } from './pg';
import { pgSupabase } from './pg-supabase';
import { monthRange, seedReportTenant, type ReportTenant } from './report-engine-fixture';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');

const ORG_1 = '00000000-0000-0000-0000-0000000000a1';
const ORG_2 = '00000000-0000-0000-0000-0000000000a2';
process.env.TIN_FINGERPRINT_KEY = process.env.TIN_FINGERPRINT_KEY ?? 'test-tin-fingerprint-key-0123456789abcdef';

// ── H2 ─────────────────────────────────────────────────────────────────────────
describe('H2 — no plaintext TIN in staging', () => {
  it('the fingerprint is keyed, org-scoped and digits-only; last four for display', () => {
    const a = tinFingerprint(ORG_1, '12-3456789');
    expect(a).toMatch(/^t1:/);
    expect(a).toBe(tinFingerprint(ORG_1, '123456789'));
    expect(a).not.toBe(tinFingerprint(ORG_2, '123456789'));
    expect(a).not.toContain('123456789');
    expect(tinFingerprint(ORG_1, '1234')).toBeNull(); // not a 9-digit TIN
    expect(tinLastFour('12-3456789')).toBe('6789');
  });

  it('no key configured → no fingerprint (never a bare hash, never the id)', () => {
    const saved = { f: process.env.TIN_FINGERPRINT_KEY, e: process.env.TIN_ENCRYPTION_KEY };
    delete process.env.TIN_FINGERPRINT_KEY;
    delete process.env.TIN_ENCRYPTION_KEY;
    try {
      expect(tinFingerprint(ORG_1, '123456789')).toBeNull();
      expect(protectTaxId(ORG_1, { name: 'X', taxId: '123456789' })).toEqual({ name: 'X', taxIdHash: null, taxIdLast4: '6789' });
    } finally {
      process.env.TIN_FINGERPRINT_KEY = saved.f;
      if (saved.e) process.env.TIN_ENCRYPTION_KEY = saved.e;
    }
  });

  it('the persisted staged payload drops taxId (key removed) and keeps fingerprint + last four', () => {
    const p = persistablePayload(ORG_1, { entity: 'vendor', data: { name: 'Ankeny Electric LLC', email: null, phone: null, taxId: '47-7654321', is1099: true } });
    expect(Object.keys(p)).not.toContain('taxId');
    expect(p).toMatchObject({ name: 'Ankeny Electric LLC', taxIdLast4: '4321', is1099: true });
    expect(String(p.taxIdHash)).toMatch(/^t1:/);
    expect(JSON.stringify(p)).not.toMatch(/7654321/);
    // non-party payloads pass through untouched
    const acct = persistablePayload(ORG_1, { entity: 'account', data: { number: '1000', name: 'Cash', type: 'ASSET', balanceCents: 0 } as never });
    expect(acct).toMatchObject({ number: '1000' });
  });

  it('master matching links on the same fingerprint (never on the id)', () => {
    const h = tinFingerprint(ORG_1, '123456789');
    const out = matchStaged(
      [{ stagedId: 's', name: 'Ferguson Ent.', email: null, phone: null, taxIdHash: h, address: null }],
      [{ id: 'v', name: 'Ferguson Enterprises', displayName: null, email: null, phone: null, taxIdHash: h }],
    );
    expect(out[0]).toMatchObject({ status: 'matched', matchedId: 'v' });
    expect(out[0].reason).toMatch(/Same tax ID/);
  });
});

// ── H3 ─────────────────────────────────────────────────────────────────────────
const L1 = '11111111-0000-0000-0000-000000000001';
const L2 = '11111111-0000-0000-0000-000000000002';

/** A caller whose client_scope_state is `state`, plus a service writer that knows `orgLocations`. */
function scopeFakes(state: Record<string, unknown>, orgLocations: string[]) {
  const caller = {
    schema: () => ({ rpc: async (fn: string) => (fn === 'client_scope_state' ? { data: state, error: null } : { data: null, error: null }) }),
  } as unknown as SupabaseClient;
  const writer = {
    schema: () => ({
      from: () => ({ select: () => ({ eq: () => ({ in: async (_c: string, ids: string[]) => ({ data: ids.filter((i) => orgLocations.includes(i)).map((id) => ({ id })), error: null }) }) }) }),
    }),
  } as unknown as SupabaseClient;
  return { caller, writer };
}

describe('H3 — report pack client scope', () => {
  it('the company set is location_ids ∪ every dashboard; an empty one means all companies', () => {
    expect(packCompanySet([L1], [{ companies: [L2] }])).toEqual({ ids: [L1, L2], orgWide: false });
    expect(packCompanySet([], [{ companies: [L1] }]).orgWide).toBe(true);
    expect(packCompanySet([L1], [{ companies: [] }]).orgWide).toBe(true);
  });

  it('a dashboard renders only inside its pack (all-companies pack → any)', () => {
    expect(itemWithinPack([L1], [L1, L2])).toBe(true);
    expect(itemWithinPack([L2], [L1])).toBe(false);
    expect(itemWithinPack([], [L1])).toBe(false);
    expect(itemWithinPack([L2], [])).toBe(true);
  });

  it('write: an out-of-scope company or an all-companies pack is refused to a scoped caller (enforce)', async () => {
    const scoped = { mode: 'enforce', membership_id: 'm1', all_clients: false, location_ids: [L1] };
    const f = scopeFakes(scoped, [L1, L2]);
    await expect(assertPackWriteScope(f.caller, ORG_1, [L1], [], { writer: f.writer })).resolves.toBeUndefined();
    const outOfScope = await assertPackWriteScope(f.caller, ORG_1, [L1], [{ companies: [L2] }], { writer: f.writer }).catch((e: unknown) => e);
    expect(isWriteScopeError(outOfScope)).toBe(true);
    const orgWide = await assertPackWriteScope(f.caller, ORG_1, [], [], { writer: f.writer }).catch((e: unknown) => e);
    expect(isWriteScopeError(orgWide) && (orgWide as Error).message).toMatch(/every company/);
    const notUuid = await assertPackWriteScope(f.caller, ORG_1, ['not-a-company'], [], { writer: f.writer }).catch((e: unknown) => e);
    expect(isWriteScopeError(notUuid)).toBe(true);
    // an all-clients caller may save an all-companies pack
    const all = scopeFakes({ mode: 'enforce', membership_id: 'm2', all_clients: true, location_ids: [L1, L2] }, [L1, L2]);
    await expect(assertPackWriteScope(all.caller, ORG_1, [], [], { writer: all.writer })).resolves.toBeUndefined();
  });

  it('delivery: the creator must STILL cover the pack (enforce); scope off → unchanged', async () => {
    const admin = (mode: string, assignments: Array<Record<string, unknown>>, members: Array<{ location_id: string }> = []) => {
      const tables: Record<string, unknown> = {
        organizations: { client_scope_rls_mode: mode },
        users: { id: 'u1' },
        memberships: { id: 'm1' },
      };
      const chain = (t: string): Record<string, unknown> => {
        const q: Record<string, unknown> = {};
        for (const k of ['select', 'eq', 'in']) q[k] = () => q;
        q.maybeSingle = async () => ({ data: tables[t] ?? null, error: null });
        q.then = (res: (v: unknown) => unknown) => res({ data: t === 'access_assignments' ? assignments : t === 'client_set_members' ? members : [], error: null });
        return q;
      };
      return { schema: () => ({ from: chain }) } as unknown as SupabaseClient;
    };
    const client = { scope_type: 'client', location_id: L1, client_set_id: null, effective_from: '2026-01-01T00:00:00Z', effective_to: null };
    expect(await packCreatorScope(admin('enforce', [client]), ORG_1, 'user_x', [L1])).toEqual({ ok: true });
    expect((await packCreatorScope(admin('enforce', [client]), ORG_1, 'user_x', [L1, L2])).ok).toBe(false);
    expect((await packCreatorScope(admin('enforce', [client]), ORG_1, 'user_x', [])).ok).toBe(false);
    expect((await packCreatorScope(admin('enforce', [client]), ORG_1, null, [L1])).ok).toBe(false);
    const expired = { ...client, effective_to: '2026-02-01T00:00:00Z' };
    expect((await packCreatorScope(admin('enforce', [expired]), ORG_1, 'user_x', [L1])).ok).toBe(false);
    expect(await packCreatorScope(admin('enforce', [{ ...client, scope_type: 'all_clients', location_id: null }]), ORG_1, 'user_x', [])).toEqual({ ok: true });
    const set = { scope_type: 'client_set', location_id: null, client_set_id: 's1', effective_from: null, effective_to: null };
    expect(await packCreatorScope(admin('enforce', [set], [{ location_id: L1 }, { location_id: L2 }]), ORG_1, 'user_x', [L1, L2])).toEqual({ ok: true });
    expect(await packCreatorScope(admin('off', []), ORG_1, null, [])).toEqual({ ok: true });
  });

  it('every pack write path uses the service role after reports:export + the pack scope check', () => {
    for (const rel of ['app/api/reports/packs/route.ts', 'app/api/reports/packs/[id]/route.ts', 'app/api/fpna/workspace/add-to-pack/route.ts']) {
      const src = read(rel);
      expect(src, rel).toMatch(/'reports', 'export'/);
      expect(src, rel).toMatch(/assertPackWriteScope\(/);
      expect(src, rel).not.toMatch(/ctx\.supabase\s*\.from\('report_packs'\)\s*\.(insert|update|delete)/);
      expect(src, rel).not.toMatch(/ctx\.supabase\.from\('report_packs'\)\.(insert|update|delete)/);
    }
    expect(read('lib/reports/compiler/scheduled-delivery.tsx')).toMatch(/packCreatorScope\(/);
    expect(read('lib/fpna/workspace/server/pack-delivery.ts')).toMatch(/itemWithinPack\(/);
  });
});

// ── client-scope bypass mirror (H4 / M1) ───────────────────────────────────────
describe('clientScopeBypass (mirror of core.client_scope_bypass)', () => {
  const s = (o: Partial<ClientScopeState>): ClientScopeState => ({ mode: 'enforce', membershipId: 'm', allClients: false, locationIds: new Set(), ...o });
  it('all-clients or not enforced → bypass; fails closed on the degraded (no membership) state', () => {
    expect(clientScopeBypass(s({ allClients: true }))).toBe(true);
    expect(clientScopeBypass(s({}))).toBe(false);
    expect(clientScopeBypass(s({ mode: 'off' }))).toBe(true);
    expect(clientScopeBypass(s({ mode: 'shadow' }))).toBe(true);
    expect(clientScopeBypass(s({ mode: 'off', membershipId: null }))).toBe(false);
  });
});

// ── M1 ─────────────────────────────────────────────────────────────────────────
describe('M1 — org-wide scenarios / levers need all-clients scope', () => {
  const ctx = (scopeBypass: boolean) => ({ scopeBypass } as unknown as CashRouteCtx);
  it('a company row is fine; an org-wide row needs scopeBypass', async () => {
    expect(requireOrgWide(ctx(false), L1)).toBeNull();
    expect(requireOrgWide(ctx(true), null)).toBeNull();
    const denied = requireOrgWide(ctx(false), null);
    expect(denied?.status).toBe(403);
  });
  it('the scenario / lever routes enforce it and org-check every referenced id', () => {
    const sc = read('app/api/cash/scenarios/route.ts');
    expect(sc.match(/requireOrgWide\(c, loc\)/g)).toHaveLength(2);
    const adj = read('app/api/cash/scenarios/adjustments/route.ts');
    expect(adj.match(/requireOrgWide\(c,/g)).toHaveLength(2);
    for (const t of ["table: 'cash_forecast_scenarios'", "table: 'customers'", "table: 'vendors'", "table: 'debt_instruments'"]) expect(adj).toContain(t);
    const items = read('app/api/cash/items/route.ts');
    for (const t of ["table: 'cash_forecast_scenarios'", "table: 'accounts'"]) expect(items).toContain(t);
    expect(read('app/api/cash/snapshot/route.ts')).toMatch(/combined: c\.scopeBypass && !c\.locationId/);
  });
});

// ── M2 ─────────────────────────────────────────────────────────────────────────
describe('M2 — the FP&A summary decision row is metadata only', () => {
  it('no bullets / figures in proposed_output; a hash instead; tagged to the one company', () => {
    const src = read('app/api/fpna/workspace/summarize/route.ts');
    const block = src.slice(src.indexOf('proposed_output'), src.indexOf('reasoning:'));
    expect(block).not.toMatch(/bullets:/);
    expect(block).toMatch(/output_sha256/);
    expect(src).toMatch(/location_id: view\.scope\.companies\.length === 1/);
    expect(src).toMatch(/userRateLimited\('fpnaSummarize'/);
  });
});

// ── M4 ─────────────────────────────────────────────────────────────────────────
describe('M4 — onboarding sign-off', () => {
  it('a cutover after today is refused (one day of time-zone slack)', () => {
    const now = new Date('2026-10-26T12:00:00Z');
    expect(cutoverNotInFuture('2026-09-30', now)).toBe(true);
    expect(cutoverNotInFuture('2026-10-27', now)).toBe(true);
    expect(cutoverNotInFuture('2026-10-31', now)).toBe(false);
  });

  it('closed_by is the closer’s core.users uuid — never the Clerk id', async () => {
    const reader = (row: { id: string } | null) =>
      ({ schema: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) }) }) }) }) as unknown as SupabaseClient;
    const U = '22222222-0000-0000-0000-000000000001';
    expect(await closerUserUuid(U, reader(null))).toBe(U);
    expect(await closerUserUuid('user_2abc', reader({ id: U }))).toBe(U);
    expect(await closerUserUuid('user_2abc', reader(null))).toBeNull();
    expect(await closerUserUuid('', reader(null))).toBeNull();
  });

  it('the route adds close_mgmt:manage to the sign-off', () => {
    expect(read('app/api/onboarding/migrations/certificate/route.ts')).toMatch(/requirePermission\(pc\.userId, 'close_mgmt', 'manage'/);
  });
});

// ── LOW: throttles ─────────────────────────────────────────────────────────────
describe('per-user throttles', () => {
  it('the 11th summary in a minute is a 429 with Retry-After; another user is unaffected', () => {
    const limiter = createRateLimiter(() => 1_000);
    for (let i = 0; i < 10; i++) expect(userRateLimited('fpnaSummarize', 'u1', limiter)).toBeNull();
    const r = userRateLimited('fpnaSummarize', 'u1', limiter);
    expect(r?.status).toBe(429);
    expect(r?.headers.get('Retry-After')).toBe('60');
    expect(userRateLimited('fpnaSummarize', 'u2', limiter)).toBeNull();
  });
  it('the matcher and the AI mapping run are throttled', () => {
    expect(read('app/api/parties/match/route.ts')).toMatch(/userRateLimited\('partiesMatch'/);
    expect(read('app/api/onboarding/migrations/mapping/route.ts')).toMatch(/userRateLimited\('mappingAi'/);
  });
});

// ── H4: snapshots on a real schema ─────────────────────────────────────────────
describe('H4 — takeSnapshots: combined only when asked; never collides with a row on file', () => {
  let db: PGlite;
  let t: ReportTenant;
  let sb: SupabaseClient;
  beforeAll(async () => {
    ({ db } = await createTestDb());
    sb = pgSupabase(db);
    t = await seedReportTenant(db, { slug: 'w4snap', companies: 2, months: monthRange('2026-01', 12) });
  }, 300_000);
  afterAll(async () => { await db?.close(); });

  // The forecast itself is the engine's business (forecast.test.ts); here only what gets WRITTEN matters.
  const compute = async (_db: SupabaseClient, req: ForecastRequest): Promise<WorkspaceForecast> => {
    const scope = (scopeId: string) => ({ scopeId, name: scopeId, openingCents: 100_000, closingCents: 90_000, weeks: [], firstBreach: null });
    return {
      forecast: { horizonWeeks: 13, companies: req.companies.map((c) => scope(c.id)), combined: scope('combined') },
      positions: [],
      recommendations: [],
    } as unknown as WorkspaceForecast;
  };

  const rows = async () => (await db.query<{ location_id: string | null; source: string }>(
    `select location_id, source from public.cash_forecast_snapshots where org_id = $1 order by location_id nulls last`, [t.org])).rows;

  it('a scoped caller’s manual snapshot (explicit companies, combined: false) writes only its companies', async () => {
    const companies = [{ id: t.companies[0], name: 'One', minimumCashCents: 0 }];
    const out = await takeSnapshots(sb, sb, { orgId: t.org, today: '2026-10-21', source: 'MANUAL', actor: 'user_scoped', companies, alerts: false, combined: false, compute });
    expect(out.written).toBe(1);
    expect((await rows()).map((r) => r.location_id)).toEqual([t.companies[0]]);
  });

  it('even with several companies, combined: false never writes the NULL row', async () => {
    const companies = t.companies.map((id, i) => ({ id, name: `C${i}`, minimumCashCents: 0 }));
    const out = await takeSnapshots(sb, sb, { orgId: t.org, today: '2026-10-21', source: 'MANUAL', actor: 'user_scoped', companies, alerts: false, combined: false, compute });
    expect(out).toMatchObject({ written: 1, skipped: 1 }); // company 0 already on file → skipped, not an error
    expect((await rows()).some((r) => r.location_id === null)).toBe(false);
  });

  it('the weekly job (no explicit companies) adds the combined row and skips what is on file', async () => {
    const out = await takeSnapshots(sb, sb, { orgId: t.org, today: '2026-10-21', source: 'SCHEDULED', actor: 'system', alerts: false, compute });
    expect(out.written).toBe(1);
    expect(out.skipped).toBe(t.companies.length);
    const r = await rows();
    expect(r.filter((x) => x.location_id === null)).toHaveLength(1);
  });
});

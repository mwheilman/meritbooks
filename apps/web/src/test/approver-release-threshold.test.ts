/**
 * Migration 174 — optional approver-release threshold, proven against a real Postgres
 * (PGlite migration replay WITH hosted Supabase's default grants).
 *
 *   1. core.organizations.sole_approver_max_cents: nullable, > 0 when set.
 *   2. public.approvals release guard: Off → the approver never releases; On, any amount →
 *      the approver may; On, up to $X → at / below X yes, above X (or no amount) no. The
 *      preparer never releases. PAYROLL_RUN keeps approver ≠ releaser in every mode.
 *   3. core.set_approver_release_policy: tenant admin only; firms can't turn it on; a
 *      LOOSENING change needs the session-policy attestation, a tightening doesn't;
 *      unchanged is a no-op; bad amounts are refused.
 *   4. every change (RPC or any other writer) lands in core.access_change_log with
 *      before / after / loosening and the actor.
 *   5. members can't call the RPC or write the columns.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './pg';

const ORG = '17400000-0000-0000-0000-000000000001';
const ORG_FIRM = '17400000-0000-0000-0000-000000000002';

let db: PGlite;
const users = new Map<string, string>();

async function errorOf(sql: string, params: unknown[] = []): Promise<string | null> {
  try {
    await db.query(sql, params);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

async function addPerson(label: string, orgId: string, role: string): Promise<void> {
  const u = await db.query<{ id: string }>(`insert into core.users (clerk_user_id) values ($1) returning id`, [`user_${label}`]);
  users.set(label, u.rows[0].id);
  await db.query(`insert into core.memberships (user_id, org_id, role) values ($1, $2, $3)`, [u.rows[0].id, orgId, role]);
}

async function setMode(mode: boolean, max: number | null): Promise<void> {
  await db.query(`update core.organizations set sole_approver_mode = $2, sole_approver_max_cents = $3 where id = $1`, [ORG, mode, max]);
}

async function approved(amountCents: number | null, kind = 'AP_DISBURSEMENT'): Promise<string> {
  const r = await db.query<{ id: string }>(
    `insert into public.approvals (org_id, kind, subject_table, subject_id, status, prepared_by, approved_by, amount_cents)
     values ($1, $2, $3, gen_random_uuid(), 'APPROVED', 'user_prep', 'user_appr', $4) returning id`,
    [ORG, kind, kind === 'PAYROLL_RUN' ? 'payroll_runs' : 'bill_payments', amountCents],
  );
  return r.rows[0].id;
}

function release(id: string, by: string): Promise<string | null> {
  return errorOf(`update public.approvals set status = 'RELEASED', released_by = $2 where id = $1`, [id, by]);
}

async function rpc(choice: string, max: number | null, actor: string, attested: boolean, org = ORG): Promise<string | null> {
  return errorOf(
    `select core.set_approver_release_policy($1, $2, $3, $4, $5, 'test', '203.0.113.7')`,
    [org, choice, max, users.get(actor), attested],
  );
}

async function current(): Promise<{ mode: boolean; max: string | null }> {
  const r = await db.query<{ mode: boolean; max: string | null }>(
    `select sole_approver_mode as mode, sole_approver_max_cents::text as max from core.organizations where id = $1`, [ORG]);
  return r.rows[0];
}

beforeAll(async () => {
  ({ db } = await createTestDb({ supabaseDefaultGrants: true }));
  await db.exec(`
    insert into core.organizations (id, name, slug, tenant_type) values
      ('${ORG}', 'Company 174', 'company-174', 'company'),
      ('${ORG_FIRM}', 'Firm 174', 'firm-174', 'firm');
  `);
  await addPerson('owner', ORG, 'owner');
  await addPerson('clerk', ORG, 'accounting_specialist');
  await addPerson('firm_owner', ORG_FIRM, 'owner');
}, 120_000);

afterAll(async () => {
  await db?.close();
});

describe('1. the threshold column', () => {
  it('defaults to null and must be > 0 when set', async () => {
    expect(await current()).toEqual({ mode: false, max: null });
    expect(await errorOf(`update core.organizations set sole_approver_max_cents = 0 where id = $1`, [ORG])).toMatch(/sole_approver_max_chk/);
    expect(await errorOf(`update core.organizations set sole_approver_max_cents = -5 where id = $1`, [ORG])).toMatch(/sole_approver_max_chk/);
  });
});

describe('2. release guard — off / any / up to $X', () => {
  it('Off: the approver can never release; a second person can', async () => {
    await setMode(false, null);
    const a = await approved(100_000);
    expect(await release(a, 'user_appr')).toMatch(/approved this payment cannot also release/);
    expect(await release(a, 'user_prep')).toMatch(/prepared this payment/);
    expect(await release(a, 'user_other')).toBeNull();
  });

  it('On, any amount: the approver may release any amount; the preparer still never', async () => {
    await setMode(true, null);
    expect(await release(await approved(999_999_999), 'user_appr')).toBeNull();
    expect(await release(await approved(null), 'user_appr')).toBeNull();
    expect(await release(await approved(100), 'user_prep')).toMatch(/prepared this payment/);
  });

  it('On, up to $5,000: at and below yes, above no, unknown amount no', async () => {
    await setMode(true, 500_000);
    expect(await release(await approved(500_000), 'user_appr')).toBeNull(); // at
    expect(await release(await approved(499_999), 'user_appr')).toBeNull(); // below
    expect(await release(await approved(1), 'user_appr')).toBeNull();
    const over = await approved(500_001);
    expect(await release(over, 'user_appr')).toMatch(/over the amount its approver may also release/);
    expect(await release(over, 'user_other')).toBeNull(); // a second person releases it
    expect(await release(await approved(-500_001), 'user_appr')).toMatch(/over the amount/); // |amount|
    expect(await release(await approved(null), 'user_appr')).toMatch(/over the amount/); // fail closed
    expect(await release(await approved(100), 'user_prep')).toMatch(/prepared this payment/);
  });

  it('a threshold left over while Off does not let the approver release', async () => {
    await setMode(false, 500_000);
    expect(await release(await approved(100), 'user_appr')).toMatch(/approved this payment cannot also release/);
  });

  it('payroll: the approver never releases, whatever the setting', async () => {
    for (const [mode, max] of [[false, null], [true, null], [true, 10_000_000]] as const) {
      await setMode(mode, max);
      const p = await approved(100, 'PAYROLL_RUN');
      expect(await release(p, 'user_appr')).toMatch(/payroll must be released by someone other/);
      expect(await release(p, 'user_prep')).toMatch(/prepared this payment/);
      expect(await release(p, 'user_other')).toBeNull();
    }
  });

  it('the un-claim revert (released_by → null) still works', async () => {
    await setMode(true, 500_000);
    const a = await approved(100);
    expect(await release(a, 'user_appr')).toBeNull();
    expect(await errorOf(`update public.approvals set status = 'APPROVED', released_by = null where id = $1`, [a])).toBeNull();
  });
});

describe('3. core.set_approver_release_policy', () => {
  it('only a tenant admin may change it', async () => {
    await setMode(false, null);
    expect(await rpc('any', null, 'clerk', true)).toMatch(/Only a tenant admin/);
    expect(await current()).toEqual({ mode: false, max: null });
  });

  it('firms can’t turn it on (but can turn it off)', async () => {
    expect(await rpc('any', null, 'firm_owner', true, ORG_FIRM)).toMatch(/isn't available for firms/);
    expect(await rpc('up_to', 100, 'firm_owner', true, ORG_FIRM)).toMatch(/isn't available for firms/);
    expect(await rpc('off', null, 'firm_owner', false, ORG_FIRM)).toBeNull();
  });

  it('rejects a bad choice or amount', async () => {
    expect(await rpc('sometimes', null, 'owner', true)).toMatch(/choose off/);
    expect(await rpc('up_to', null, 'owner', true)).toMatch(/greater than \$0/);
    expect(await rpc('up_to', 0, 'owner', true)).toMatch(/greater than \$0/);
  });

  it('LOOSENING needs the session-policy attestation; tightening does not', async () => {
    await setMode(false, null);
    // off → up to $5,000: loosening
    expect(await rpc('up_to', 500_000, 'owner', false)).toMatch(/meets your security policy/);
    expect(await current()).toEqual({ mode: false, max: null });
    expect(await rpc('up_to', 500_000, 'owner', true)).toBeNull();
    expect(await current()).toEqual({ mode: true, max: '500000' });
    // raising the limit: loosening
    expect(await rpc('up_to', 600_000, 'owner', false)).toMatch(/meets your security policy/);
    expect(await rpc('up_to', 600_000, 'owner', true)).toBeNull();
    // lowering the limit: tightening
    expect(await rpc('up_to', 200_000, 'owner', false)).toBeNull();
    expect(await current()).toEqual({ mode: true, max: '200000' });
    // up to → any: loosening
    expect(await rpc('any', null, 'owner', false)).toMatch(/meets your security policy/);
    expect(await rpc('any', null, 'owner', true)).toBeNull();
    expect(await current()).toEqual({ mode: true, max: null });
    // any → up to: tightening
    expect(await rpc('up_to', 300_000, 'owner', false)).toBeNull();
    // → off: tightening
    expect(await rpc('off', null, 'owner', false)).toBeNull();
    expect(await current()).toEqual({ mode: false, max: null });
  });

  it('an unchanged choice is a no-op', async () => {
    const r = await db.query<{ r: { status: string } }>(
      `select core.set_approver_release_policy($1, 'off', null, $2, false) as r`, [ORG, users.get('owner')]);
    expect(r.rows[0].r.status).toBe('unchanged');
  });

  it('the TS loosening rule agrees with the DB', async () => {
    const { isApproverReleaseLoosening, approverReleasePolicyOf } = await import('@/lib/rbac/sod');
    const states: Array<[boolean, number | null]> = [[false, null], [true, null], [true, 100], [true, 500]];
    for (const [fm, fx] of states) {
      for (const [tm, tx] of states) {
        const r = await db.query<{ l: boolean }>(`select core.approver_release_is_loosening($1, $2, $3, $4) as l`, [fm, fx, tm, tx]);
        const from = approverReleasePolicyOf(fm, fx);
        const to = approverReleasePolicyOf(tm, tx);
        const same = from.choice === to.choice && from.maxCents === to.maxCents;
        if (!same) expect(isApproverReleaseLoosening(from, to)).toBe(r.rows[0].l);
      }
    }
  });
});

describe('4. every change is in the access log', () => {
  it('RPC changes carry the actor, the reason, the IP and the loosening flag', async () => {
    await setMode(false, null);
    const before = await db.query<{ n: number }>(`select count(*)::int as n from core.access_change_log where org_id = $1`, [ORG]);
    // separate statements = separate transactions, so the context from one RPC can't leak
    expect(await rpc('up_to', 750_000, 'owner', true)).toBeNull();
    const rows = await db.query<{
      event: string; subject_type: string; source: string; actor_user_id: string | null;
      before: Record<string, unknown>; after: Record<string, unknown>; request_ip: string | null; reason: string | null;
    }>(
      `select event, subject_type, source, actor_user_id, before, after, request_ip, reason
         from core.access_change_log where org_id = $1 order by seq desc limit 1`, [ORG]);
    const after = await db.query<{ n: number }>(`select count(*)::int as n from core.access_change_log where org_id = $1`, [ORG]);
    expect(after.rows[0].n).toBeGreaterThan(before.rows[0].n);
    expect(rows.rows[0]).toMatchObject({
      event: 'approver_release.change',
      subject_type: 'tenant_setting',
      source: 'ui',
      actor_user_id: users.get('owner'),
      request_ip: '203.0.113.7',
      reason: 'test',
      before: { approver_may_release: 'off', up_to_cents: null },
      after: { approver_may_release: 'up_to', up_to_cents: 750000, loosening: true },
    });
  });

  it('a direct write by any other writer is logged too', async () => {
    await setMode(true, null);
    const r = await db.query<{ source: string; after: Record<string, unknown> }>(
      `select source, after from core.access_change_log where org_id = $1 and event = 'approver_release.change' order by seq desc limit 1`, [ORG]);
    expect(r.rows[0]).toMatchObject({ source: 'system', after: { approver_may_release: 'any', loosening: true } });
  });
});

describe('5. members can’t change it', () => {
  it('authenticated can neither execute the RPC nor write the columns', async () => {
    await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: 'user_owner', org_id: ORG, role: 'authenticated' })]);
    await db.exec('set role authenticated');
    try {
      expect(await errorOf(`select core.set_approver_release_policy($1, 'any', null, $2, true)`, [ORG, users.get('owner')])).toMatch(/permission denied/);
      const upd = await errorOf(`update core.organizations set sole_approver_max_cents = 1 where id = $1`, [ORG]);
      // Either refused outright (154 revoke) or matches no row under RLS — never applied.
      if (upd === null) {
        await db.exec('reset role');
        expect((await current()).max).not.toBe('1');
      } else {
        expect(upd).toMatch(/permission denied/);
      }
    } finally {
      await db.exec('reset role');
      await db.query(`select set_config('request.jwt.claims', '{}', false)`);
    }
  });
});

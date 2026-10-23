/**
 * Migration 183 — per-company inbound aliases, the inbound message log and the
 * attachment fingerprints, against a REAL Postgres (PGlite replay WITH hosted
 * Supabase's default grants, so "members can't write" is not vacuous).
 * FPB-ap-intake §6 criteria 1, 5 (DB half), 6 (DB half), 10.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './pg';

const ORG_A = '18300000-0000-0000-0000-00000000000a';
const ORG_B = '18300000-0000-0000-0000-00000000000b';
const ORG_L = '18300000-0000-0000-0000-00000000000c';

let db: PGlite;

async function errorOf(sql: string, params: unknown[] = []): Promise<string | null> {
  try {
    await db.query(sql, params);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

async function as<T>(sub: string | null, org: string | null, fn: () => Promise<T>): Promise<T> {
  const claims = sub ? { sub, org_id: org, role: 'authenticated' } : {};
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify(claims)]);
  await db.exec(`set role ${sub ? 'authenticated' : 'anon'}`);
  try {
    return await fn();
  } finally {
    await db.exec('reset role');
    await db.query(`select set_config('request.jwt.claims', '{}', false)`);
  }
}

async function addLocation(org: string, name: string, code: string): Promise<string> {
  const r = await db.query<{ id: string }>(
    `insert into core.locations (org_id, name, short_code) values ($1, $2, $3) returning id`,
    [org, name, code],
  );
  return r.rows[0].id;
}

async function aliasesOf(location: string): Promise<Record<string, string>> {
  const r = await db.query<{ purpose: string; local_part: string }>(
    `select purpose, local_part from core.inbound_aliases where location_id = $1`,
    [location],
  );
  return Object.fromEntries(r.rows.map((x) => [x.purpose, x.local_part]));
}

beforeAll(async () => {
  ({ db } = await createTestDb({ supabaseDefaultGrants: true }));
  await db.exec(`
    insert into core.organizations (id, name, slug) values
      ('${ORG_A}', 'Merit Group', 'merit-group'),
      ('${ORG_B}', 'Other Tenant', 'other-tenant'),
      ('${ORG_L}', 'Legacy Co', 'legacy-co');
    update core.organizations set inbound_ap_address = 'ap-swan-creek@inbound.meritbooks.app' where id = '${ORG_L}';
  `);
  await db.exec(`
    insert into core.users (clerk_user_id) values ('user_a');
    insert into core.memberships (user_id, org_id, role, status)
      select id, '${ORG_A}', 'owner', 'active' from core.users where clerk_user_id = 'user_a';
  `);
}, 300_000);

afterAll(async () => {
  await db?.close();
});

describe('migration 183 — slugs and alias generation', () => {
  it('slugifies company names (strips [tags] and legal suffixes)', async () => {
    const r = await db.query<{ a: string; b: string; c: string; d: string; e: string }>(`
      select core.inbound_alias_slug('Heritage Interiors, LLC') a,
             core.inbound_alias_slug('[SANDBOX] Coho Flooring') b,
             core.inbound_alias_slug('  Clive Power Equipment Inc. ') c,
             core.inbound_alias_slug('!!!') d,
             core.inbound_alias_slug('Dorrian HVAC & Plumbing Co') e`);
    expect(r.rows[0]).toEqual({ a: 'heritage-interiors', b: 'coho-flooring', c: 'clive-power-equipment', d: 'company', e: 'dorrian-hvac-plumbing' });
  });

  it('a new company gets ap- and receipts- addresses automatically (trigger)', async () => {
    const heritage = await addLocation(ORG_A, 'Heritage Interiors LLC', 'HI');
    expect(await aliasesOf(heritage)).toEqual({ ap: 'ap-heritage-interiors', receipts: 'receipts-heritage-interiors' });
  });

  it('two tenants with the same company name get different (globally unique) addresses', async () => {
    const a = await addLocation(ORG_A, 'Main Office', 'MA');
    const b = await addLocation(ORG_B, 'Main Office', 'MB');
    const aa = await aliasesOf(a);
    const bb = await aliasesOf(b);
    expect(aa.ap).toBe('ap-main-office');
    expect(bb.ap).toBe('ap-main-office-other-tenant');
    expect(bb.receipts).toBe('receipts-main-office-other-tenant');
  });

  it('never takes another org’s legacy (135) address — but the owning org may', async () => {
    // ORG_L's legacy org address is ap-swan-creek@… ; a Swan Creek in ORG_A must not take it.
    const a = await addLocation(ORG_A, 'Swan Creek', 'SC');
    expect((await aliasesOf(a)).ap).toBe('ap-swan-creek-merit-group');
    const l = await addLocation(ORG_L, 'Swan Creek', 'SL');
    expect((await aliasesOf(l)).ap).toBe('ap-swan-creek');
  });

  it('falls back to a numeric suffix when name and name+org are both taken', async () => {
    const again = await addLocation(ORG_A, 'Main Office', 'M2');
    expect((await aliasesOf(again)).ap).toBe('ap-main-office-merit-group');
    const third = await addLocation(ORG_A, 'Main Office', 'M3');
    expect((await aliasesOf(third)).ap).toBe('ap-main-office-2');
  });

  it('ensure_inbound_aliases is idempotent and keeps the pair on one slug', async () => {
    const loc = await addLocation(ORG_A, 'Clive Power Equipment', 'CP');
    await db.query(`delete from core.inbound_aliases where location_id = $1 and purpose = 'receipts'`, [loc]);
    const n1 = await db.query<{ n: number }>(`select core.ensure_inbound_aliases($1) n`, [loc]);
    const n2 = await db.query<{ n: number }>(`select core.ensure_inbound_aliases($1) n`, [loc]);
    expect(n1.rows[0].n).toBe(1);
    expect(n2.rows[0].n).toBe(0);
    expect(await aliasesOf(loc)).toEqual({ ap: 'ap-clive-power-equipment', receipts: 'receipts-clive-power-equipment' });
  });

  it('backfill: every company that existed before 183 has both addresses', async () => {
    const r = await db.query<{ missing: number }>(`
      select count(*)::int missing from core.locations l
       where (select count(*) from core.inbound_aliases a where a.location_id = l.id) <> 2`);
    expect(r.rows[0].missing).toBe(0);
  });
});

describe('migration 183 — constraints', () => {
  it('CHECKs hold: bad local part, bad purpose, non-google confirm URL, bad sha256, bad outcome', async () => {
    const loc = await addLocation(ORG_A, 'Check Co', 'CC');
    expect(await errorOf(`update core.inbound_aliases set local_part = 'AP Bad!' where location_id = $1 and purpose = 'ap'`, [loc])).toMatch(/inbound_aliases_local_chk/);
    expect(await errorOf(`update core.inbound_aliases set purpose = 'payroll' where location_id = $1 and purpose = 'ap'`, [loc])).toMatch(/inbound_aliases_purpose_chk/);
    expect(await errorOf(`update core.inbound_aliases set fwd_confirm_url = 'https://evil.test/google.com/x' where location_id = $1 and purpose = 'ap'`, [loc])).toMatch(/inbound_aliases_fwd_chk/);
    expect(await errorOf(`update core.inbound_aliases set fwd_confirm_url = 'https://mail-settings.google.com/mail/vf-abc' where location_id = $1 and purpose = 'ap'`, [loc])).toBeNull();
    expect(await errorOf(`insert into core.inbound_attachment_fingerprints (org_id, sha256) values ('${ORG_A}', 'nope')`)).toMatch(/inbound_fingerprints_sha_chk/);
    expect(await errorOf(`insert into core.inbound_messages (org_id, provider, provider_message_id, from_address, to_address, outcome) values ('${ORG_A}', 'postmark', 'm1', 'a@b.c', 'ap-x@y.z', 'posted')`)).toMatch(/inbound_messages_outcome_chk/);
  });

  it('a redelivery of the same provider message to the same address is refused by the DB', async () => {
    const ins = `insert into core.inbound_messages (org_id, provider, provider_message_id, from_address, to_address) values ('${ORG_A}', 'postmark', 'dup-1', 'v@vendor.test', $1)`;
    expect(await errorOf(ins, ['ap-heritage-interiors@inbound.test'])).toBeNull();
    expect(await errorOf(ins, ['AP-Heritage-Interiors@inbound.test'])).toMatch(/duplicate key|unique/i);
    // the same message to a different address (cc'd company) is a separate delivery
    expect(await errorOf(ins, ['ap-clive-power-equipment@inbound.test'])).toBeNull();
  });

  it('the same PDF hash cannot be fingerprinted twice in one org, but can in another', async () => {
    const sha = 'a'.repeat(64);
    const ins = `insert into core.inbound_attachment_fingerprints (org_id, sha256) values ($1, $2)`;
    expect(await errorOf(ins, [ORG_A, sha])).toBeNull();
    expect(await errorOf(ins, [ORG_A, sha])).toMatch(/duplicate key|unique/i);
    expect(await errorOf(ins, [ORG_B, sha])).toBeNull();
  });
});

describe('migration 183 — RLS and write locks', () => {
  it('members cannot write any 183 table; anon cannot read them', async () => {
    for (const t of ['inbound_aliases', 'inbound_messages', 'inbound_attachment_fingerprints']) {
      const ins = await as('user_a', ORG_A, () => errorOf(`insert into core.${t} (org_id) values ('${ORG_A}')`));
      expect(ins, t).toMatch(/permission denied|row-level security|violates not-null/i);
      expect(await as('user_a', ORG_A, () => errorOf(`update core.${t} set org_id = org_id`)), t).toMatch(/permission denied/i);
      expect(await as('user_a', ORG_A, () => errorOf(`delete from core.${t}`)), t).toMatch(/permission denied/i);
      expect(await as(null, null, () => errorOf(`select 1 from core.${t}`)), t).toMatch(/permission denied/i);
    }
  });

  it('members read only their own org’s addresses and log', async () => {
    const seen = await as('user_a', ORG_A, async () =>
      (await db.query<{ org_id: string }>(`select org_id from core.inbound_aliases`)).rows);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((r) => r.org_id === ORG_A)).toBe(true);
    const forged = await as('user_a', ORG_B, async () =>
      (await db.query<{ org_id: string }>(`select org_id from core.inbound_messages`)).rows);
    expect(forged.every((r) => r.org_id === ORG_B)).toBe(true);
  });

  it('members cannot call the alias generator', async () => {
    const loc = (await db.query<{ id: string }>(`select id from core.locations where org_id = $1 limit 1`, [ORG_A])).rows[0].id;
    expect(await as('user_a', ORG_A, () => errorOf(`select core.ensure_inbound_aliases($1)`, [loc]))).toMatch(/permission denied/i);
  });
});

/**
 * 1121 imports & onboarding against a PGlite replay of every migration. Real fixture files go
 * through the real app engine (apps/projects/src/lib/imports) and are staged / committed through
 * the RPCs: match at the door, idempotency, undo of an uncommitted batch, agreements with the
 * deferred reconciliation, mid-stream jobs → opening facts → tie-out against Books, c-Systems units
 * unit by unit, parts with bins and on hand, crew invites → roles + Projects-only, go-live.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { buildFixture, as, q, errorOf, type Fixture, ORG_A, L1, LB } from './fixture';
import { applyMigration, listMigrationFiles } from './pg';
import { buildPreview, isFailure, readUpload, stagePayload } from '../../../apps/projects/src/lib/imports/engine';
import { buildDealerUnitsHandoff, buildJobWipHandoff, type CommittedRow } from '../../../apps/projects/src/lib/imports/opening';
import type { PreviewResult } from '../../../apps/projects/src/lib/imports/types';

const FIX = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../apps/projects/src/lib/imports/__fixtures__');
const forbidden = /PM_FORBIDDEN|permission denied|row-level security/i;
let f: Fixture;
const skipped: string[] = [];

function preview(fixture: string, extra: Record<string, unknown> = {}): PreviewResult {
  const bytes = new Uint8Array(fs.readFileSync(path.join(FIX, fixture)));
  const t = readUpload(fixture, 'text/csv', bytes, (d) => new Uint8Array(inflateRawSync(d)));
  if (isFailure(t)) throw new Error(t.message);
  return buildPreview(t, { fileHash: createHash('sha256').update(bytes).digest('hex'), jobTypes: [{ key: 'build', label: 'Build', archetype: 'project' }], ...extra });
}

interface Staged { batch_id: string; status: string; reused: boolean; row_count: number; valid_count: number; invalid_count: number; report?: Record<string, unknown>; result?: Record<string, unknown> }
interface Committed { batch_id: string; status: string; replayed: boolean; counts: Record<string, number>; errors: { row: number; message: string }[]; matched: unknown[]; first_job_id: string | null }

async function stage(p: PreviewResult, loc = L1, hash = p.fileHash): Promise<Staged> {
  const r = await q<{ r: Staged }>(f.db, `select pm.import_stage($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, '{}'::jsonb) as r`,
    [loc, p.source, p.entity, p.fileName, hash, JSON.stringify(Object.fromEntries(Object.entries(p.mapping).map(([k, v]) => [k, v.header]))), JSON.stringify(stagePayload(p))]);
  return r[0]!.r;
}
async function commit(batch: string): Promise<Committed> {
  return (await q<{ r: Committed }>(f.db, `select pm.import_commit($1) as r`, [batch]))[0]!.r;
}
async function bringIn(fixture: string, extra: Record<string, unknown> = {}) {
  return as(f, 'owner', async () => {
    const s = await stage(preview(fixture, extra));
    return { staged: s, committed: await commit(s.batch_id) };
  });
}
async function rows(batch: string): Promise<CommittedRow[]> {
  return q<CommittedRow>(f.db, `select row_number, entity, external_ref, data, outcome, target_id from pm.import_rows where batch_id = $1 and validation <> 'INVALID' order by row_number`, [batch]);
}

beforeAll(async () => {
  f = await buildFixture();
  for (const file of listMigrationFiles().filter((x) => parseInt(x, 10) > 1110)) {
    try {
      await applyMigration(f.db, file);
    } catch (e) {
      if (/^11(11|12|13|14|15|16|17|21)_/.test(file)) throw e;
      skipped.push(`${file}: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`);
    }
  }
  if (skipped.length) console.warn(`[imports.test] skipped in-progress migrations:\n  ${skipped.join('\n  ')}`);
  // the fixture's job type machine: a bid stage first, then an active one
  await f.db.query(`insert into pm.stage_defs (org_id, location_id, install_id, machine_key, stage_key, label, sort, core_status, is_initial, is_active)
                    select org_id, location_id, id, 'm', 'lead', 'Lead', 0, 'BID', true, true from pm.pack_installs where location_id = $1`, [L1]);
  await f.db.query(`insert into pm.stage_defs (org_id, location_id, install_id, machine_key, stage_key, label, sort, core_status, is_initial, is_active)
                    select org_id, location_id, id, 'm', 'in_progress', 'In progress', 1, 'ACTIVE', false, true from pm.pack_installs where location_id = $1`, [L1]);
  // a customer Books already has (same email as the ServiceTitan export) — must be linked, not duplicated
  await f.db.query(`insert into core.customers (org_id, name, email, phone) values ($1, 'Linda S. Park', 'linda.park@example.com', '515-555-0700')`, [ORG_A]);
}, 900_000);

afterAll(async () => {
  await f?.db.close();
});

describe('registry guards (1110 / 1121)', () => {
  it('every pm table is classified and every member definer RPC is guarded', async () => {
    expect(await q(f.db, `select * from pm.access_unclassified_tables()`)).toEqual([]);
    expect(await q(f.db, `select * from pm.access_unguarded_rpcs()`)).toEqual([]);
  });
  it('1121 re-applies cleanly (idempotent) and stays guarded', async () => {
    await applyMigration(f.db, '1121_pm_imports_onboarding.sql');
    expect(await q(f.db, `select * from pm.access_unguarded_rpcs()`)).toEqual([]);
    const def = await q<{ n: number }>(f.db, `select (length(pg_get_functiondef('pm.import_commit(uuid)'::regprocedure)) - length(replace(pg_get_functiondef('pm.import_commit(uuid)'::regprocedure), 'pm_access_guard', ''))) / length('pm_access_guard') as n`);
    expect(def[0]!.n).toBe(1);
  });
  it('nothing in 1121 is executable by anon', async () => {
    const r = await q<{ n: string }>(f.db, `select p.proname as n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
       where s.nspname = 'pm' and (p.proname like '%import%' or p.proname like 'opening_%' or p.proname like 'onboarding_%' or p.proname like '%crew_invite%')
         and has_function_privilege('anon', p.oid, 'execute')`);
    expect(r).toEqual([]);
  });
});

describe('customers through match at the door', () => {
  let batch = '';
  it('links the customer Books already has, creates the rest with site + contact', async () => {
    const { staged, committed } = await bringIn('servicetitan-customers.csv');
    batch = staged.batch_id;
    expect(staged).toMatchObject({ status: 'STAGED', reused: false, row_count: 3, valid_count: 3 });
    expect(committed.counts).toEqual({ CREATED: 2, MATCHED: 1 });
    expect(committed.matched).toHaveLength(1);
    const linda = await q<{ n: number }>(f.db, `select count(*)::int as n from core.customers where org_id = $1 and email = 'linda.park@example.com'`, [ORG_A]);
    expect(linda[0]!.n).toBe(1);
    const sites = await q<{ n: number }>(f.db, `select count(*)::int as n from core.sites s join pm.import_rows r on r.target_id = s.customer_id where r.batch_id = $1`, [batch]);
    expect(sites[0]!.n).toBe(3);
    const contacts = await q<{ n: number }>(f.db, `select count(*)::int as n from core.contacts c join pm.import_rows r on r.target_id = c.customer_id where r.batch_id = $1`, [batch]);
    expect(contacts[0]!.n).toBe(3);
  });
  it('is idempotent: commit again replays, the same file re-stages to the committed batch, another file skips known refs', async () => {
    await as(f, 'owner', async () => {
      const again = await commit(batch);
      expect(again).toMatchObject({ replayed: true, counts: { CREATED: 2, MATCHED: 1 } });
      const restage = await stage(preview('servicetitan-customers.csv'));
      expect(restage).toMatchObject({ batch_id: batch, status: 'COMMITTED', reused: true });
      const other = await stage(preview('servicetitan-customers.csv'), L1, 'e'.repeat(64));
      expect(other.batch_id).not.toBe(batch);
      const c = await commit(other.batch_id);
      expect(c.counts).toEqual({ SKIPPED: 3 });
    });
    const n = await q<{ n: number }>(f.db, `select count(*)::int as n from core.customers where org_id = $1 and deleted_at is null`, [ORG_A]);
    expect(n[0]!.n).toBe(3);
  });
  it('locations and equipment find their customer by the export’s customer id', async () => {
    const loc = await bringIn('servicetitan-locations.csv');
    expect(loc.committed.counts).toEqual({ CREATED: 1, MATCHED: 2 }); // Linda's home and Building A = the customer's own address
    const eq = await bringIn('servicetitan-equipment.csv');
    expect(eq.committed.counts).toEqual({ CREATED: 3 });
    const a = await q<{ kind: string; serial_number: string; customer: string }>(f.db,
      `select a.kind, a.serial_number, c.name as customer from pm.assets a join core.customers c on c.id = a.customer_id where a.org_id = $1 and a.serial_number = '3417A51234'`, [ORG_A]);
    expect(a[0]).toEqual({ kind: 'CUSTOMER_EQUIPMENT', serial_number: '3417A51234', customer: 'Linda S. Park' });
  });
});

describe('undo of an uncommitted batch', () => {
  it('discard removes the staged rows; a discarded batch can’t be committed; a committed one can’t be discarded', async () => {
    await as(f, 'owner', async () => {
      const s = await stage(preview('jobber-team.csv'));
      const d = await q<{ r: { status: string; rows_removed: number } }>(f.db, `select pm.import_discard($1) as r`, [s.batch_id]);
      expect(d[0]!.r).toEqual({ batch_id: s.batch_id, status: 'DISCARDED', rows_removed: 3 });
      expect(await errorOf(f.db, `select pm.import_commit($1)`, [s.batch_id])).toMatch(/PM_IMPORT_STATE/);
      const s2 = await stage(preview('jobber-team.csv'));
      expect(s2.batch_id).not.toBe(s.batch_id);
      await commit(s2.batch_id);
      expect(await errorOf(f.db, `select pm.import_discard($1)`, [s2.batch_id])).toMatch(/PM_IMPORT_COMMITTED/);
    });
  });
});

describe('access', () => {
  it('only a settings holder at the company stages or commits; other tenants see nothing', async () => {
    const p = preview('fieldedge-customers.csv');
    expect(await as(f, 'labor', async () => errorOf(f.db, `select pm.import_stage($1, 'FIELDEDGE', 'customer', 'x.csv', $2, '{}'::jsonb, $3::jsonb)`, [L1, p.fileHash, JSON.stringify(stagePayload(p))]))).toMatch(forbidden);
    const s = await as(f, 'owner', () => stage(p));
    expect(await as(f, 'pm', async () => errorOf(f.db, `select pm.import_commit($1)`, [s.batch_id]))).toMatch(forbidden);
    expect(await as(f, 'bOwner', async () => errorOf(f.db, `select pm.import_commit($1)`, [s.batch_id]))).toMatch(forbidden);
    expect(await as(f, 'bOwner', async () => errorOf(f.db, `select pm.import_stage($1, 'FIELDEDGE', 'customer', 'x.csv', $2, '{}'::jsonb, $3::jsonb)`, [L1, p.fileHash, JSON.stringify(stagePayload(p))]))).toMatch(forbidden);
    expect(await as(f, 'labor', () => q(f.db, `select id from pm.import_batches`))).toEqual([]);
    expect(await as(f, 'bOwner', () => q(f.db, `select id from pm.import_batches`))).toEqual([]);
    expect((await as(f, 'owner', () => q(f.db, `select id from pm.import_batches where id = $1`, [s.batch_id])))).toHaveLength(1);
    expect(await as(f, 'labor', async () => errorOf(f.db, `insert into pm.import_batches (location_id, source_system, entity, file_hash) values ($1, 'CSV', 'job', $2)`, [L1, 'f'.repeat(64)]))).toMatch(forbidden);
  });
  it('saved mappings upsert per source and entity', async () => {
    await as(f, 'owner', async () => {
      await q(f.db, `select pm.import_save_mapping($1, 'SERVICETITAN', 'customer', 'sig1', '{"name":"Customer Name"}'::jsonb)`, [L1]);
      await q(f.db, `select pm.import_save_mapping($1, 'SERVICETITAN', 'customer', 'sig2', '{"name":"Name"}'::jsonb)`, [L1]);
      const m = await q<{ header_signature: string; use_count: number; mapping: unknown }>(f.db, `select header_signature, use_count, mapping from pm.import_mappings where location_id = $1`, [L1]);
      expect(m).toEqual([{ header_signature: 'sig2', use_count: 2, mapping: { name: 'Name' } }]);
    });
  });
});

describe('FS-65 agreements with remaining visits and the deferred balance', () => {
  it('the stage dry run reports count, deferred dollars and visits owed; commit creates agreements, visits and opening deferred facts', async () => {
    const { staged, committed } = await bringIn('servicetitan-memberships.csv');
    const rep = staged.report!.agreements as { ok: number; deferred_cents: number; visits_owed: number; errors: unknown[]; dry_run: boolean };
    expect(rep).toMatchObject({ ok: 3, deferred_cents: 146_950, visits_owed: 6, dry_run: true });
    expect(committed.counts).toEqual({ CREATED: 3 });
    const agr = await q<{ n: number; visits: number }>(f.db, `select count(distinct a.id)::int as n, count(w.id)::int as visits from pm.service_agreements a
       left join pm.work_orders w on w.agreement_id = a.id and w.kind = 'MAINTENANCE_VISIT' where a.org_id = $1 and a.import_ref like 'M-30%'`, [ORG_A]);
    expect(agr[0]!.n).toBe(3);
    expect(agr[0]!.visits).toBeGreaterThan(0);
    const facts = await q<{ c: string }>(f.db, `select coalesce(sum(amount_cents), 0)::text as c from pm.agreement_revenue_facts where org_id = $1 and kind = 'OPENING_BALANCE'`, [ORG_A]);
    expect(facts[0]!.c).toBe('146950');
  });
});

describe('CGC-08 mid-stream jobs → opening facts for Books with a tie-out', () => {
  let handoff = '';
  let jobs: CommittedRow[] = [];
  it('jobs, SOV and commitments come in (subs join the vendor list at the door)', async () => {
    const j = await bringIn('procore-prime-contracts.csv');
    expect(j.committed.counts).toEqual({ CREATED: 3 });
    expect(j.committed.first_job_id).toBeTruthy();
    jobs = await rows(j.staged.batch_id);
    const p = await q<{ stage_key: string; status: string; contract: string; ext: Record<string, unknown> }>(f.db,
      `select p.stage_key, j.status, k.original_cents::text as contract, p.ext from pm.projects p join core.jobs j on j.id = p.job_id
         join pm.contracts k on k.job_id = p.job_id where p.job_id = $1`, [j.committed.first_job_id]);
    expect(p[0]).toMatchObject({ stage_key: 'in_progress', status: 'ACTIVE', contract: '443640000' });
    expect(p[0]!.ext).toMatchObject({ _source: 'import', _external_id: '2026-014', _import_batch_id: j.staged.batch_id });
    const sov = await bringIn('procore-sov.csv');
    expect(sov.committed.counts).toEqual({ CREATED: 3 });
    const lines = await q<{ n: number; total: string }>(f.db, `select count(*)::int as n, sum(scheduled_value_cents)::text as total from pm.sov_lines l join pm.sov_versions v on v.id = l.sov_version_id where v.job_id = $1 and v.status = 'DRAFT'`, [j.committed.first_job_id]);
    expect(lines[0]).toEqual({ n: 3, total: '443640000' });
    const cm = await bringIn('procore-commitments.csv');
    expect(cm.committed.counts).toEqual({ REFERENCE: 3 });
    const v = await q<{ name: string }>(f.db, `select name from core.vendors where org_id = $1 order by name`, [ORG_A]);
    expect(v.map((x) => x.name)).toEqual(expect.arrayContaining(['Central Iowa Concrete Co.', 'Metro Drywall', 'Midwest Steel Fabricators']));
    const again = await bringIn('procore-prime-contracts.csv', {});
    expect(again.committed.replayed).toBe(true);
  });
  it('the handoff is staged (totals re-footed in SQL), refused when the totals don’t foot', async () => {
    const sovRows = await q<CommittedRow>(f.db, `select r.row_number, r.entity, r.external_ref, r.data, r.outcome, r.target_id from pm.import_rows r join pm.import_batches b on b.id = r.batch_id where b.entity = 'sov_line' and b.org_id = $1`, [ORG_A]);
    const cmtRows = await q<CommittedRow>(f.db, `select r.row_number, r.entity, r.external_ref, r.data, r.outcome, r.target_id from pm.import_rows r join pm.import_batches b on b.id = r.batch_id where b.entity = 'commitment' and b.org_id = $1`, [ORG_A]);
    const h = buildJobWipHandoff({ asOf: '2026-09-30', jobs, sov: sovRows, commitments: cmtRows });
    expect(h.payload.blockers).toEqual([]);
    await as(f, 'owner', async () => {
      const bad = { ...h.payload, totals: { ...h.payload.totals, cost_to_date_cents: 1 } };
      expect(await errorOf(f.db, `select pm.opening_stage_handoff($1, 'JOB_WIP', '2026-09-30', $2::jsonb, $3::jsonb)`, [L1, JSON.stringify(bad), JSON.stringify(h.facts)])).toMatch(/does not equal the sum/);
      const r = await q<{ r: { handoff_id: string; status: string; totals: Record<string, number> } }>(f.db,
        `select pm.opening_stage_handoff($1, 'JOB_WIP', '2026-09-30', $2::jsonb, $3::jsonb) as r`, [L1, JSON.stringify(h.payload), JSON.stringify(h.facts)]);
      expect(r[0]!.r.status).toBe('VALIDATED');
      expect(Number(r[0]!.r.totals.cost_to_date_cents)).toBe(h.payload.totals.cost_to_date_cents);
      handoff = r[0]!.r.handoff_id;
    });
    const facts = await q<{ n: number }>(f.db, `select count(*)::int as n from pm.opening_job_facts where handoff_id = $1`, [handoff]);
    expect(facts[0]!.n).toBe(3);
  });
  it('tie-out: pending before Books loads it, ok when Books matches, an exception when it doesn’t', async () => {
    const t0 = await as(f, 'owner', () => q<{ r: { summary: Record<string, number>; lines: { key: string; status: string; job_number: string }[] } }>(f.db, `select pm.opening_tieout($1) as r`, [handoff]));
    expect(t0[0]!.r.summary.exceptions).toBe(0);
    expect(t0[0]!.r.lines.every((l) => l.status === 'pending')).toBe(true);
    // Books' WIP importer records its opening figures on core.jobs (one right, one wrong)
    const [a, b] = jobs;
    await f.db.query(`update core.jobs set actual_cost_cents = $2, billed_to_date_cents = $3 where id = $1`, [a!.target_id, 223_050_000, 266_184_000]);
    await f.db.query(`update core.jobs set actual_cost_cents = $2, billed_to_date_cents = $3 where id = $1`, [b!.target_id, 50_000_000, 59_120_000]);
    const t1 = await as(f, 'owner', () => q<{ r: { summary: Record<string, number>; lines: { key: string; status: string; job_id: string; diff_cents: number }[]; controls: { key: string; status: string }[] } }>(f.db, `select pm.opening_tieout($1) as r`, [handoff]));
    const line = (job: string, key: string) => t1[0]!.r.lines.find((l) => l.job_id === job && l.key === key)!;
    expect(line(a!.target_id!, 'cost_to_date').status).toBe('ok');
    expect(line(a!.target_id!, 'billed_to_date').status).toBe('ok');
    expect(line(b!.target_id!, 'cost_to_date')).toMatchObject({ status: 'exception', diff_cents: 1_230_000 });
    expect(t1[0]!.r.controls.map((c) => c.key)).toEqual(['JOB_WIP', 'UNBILLED_RECEIVABLE', 'DEFERRED_REVENUE', 'RETAINAGE_RECEIVABLE', 'RETAINAGE_PAYABLE', 'CUSTOMER_DEPOSITS']);
    expect(await as(f, 'labor', async () => errorOf(f.db, `select pm.opening_tieout($1)`, [handoff]))).toMatch(forbidden);
    expect(await as(f, 'labor', () => q(f.db, `select id from pm.opening_job_facts`))).toEqual([]);
  });
  it('submit → Books decides (service role only); an accepted position can’t be re-staged', async () => {
    await as(f, 'owner', async () => {
      const s = await q<{ r: { status: string } }>(f.db, `select pm.opening_submit_handoff($1) as r`, [handoff]);
      expect(s[0]!.r.status).toBe('SUBMITTED');
      expect(await errorOf(f.db, `select pm.opening_books_decision($1, 'ACCEPTED', 'JE-1', null)`, [handoff])).toMatch(/permission denied|PM_FORBIDDEN/);
    });
    await f.db.query(`select pm.opening_books_decision($1, 'ACCEPTED', 'JE-OPEN-0001', null)`, [handoff]);
    expect((await q<{ status: string; books_ref: string }>(f.db, `select status, books_ref from pm.opening_handoffs where id = $1`, [handoff]))[0]).toEqual({ status: 'ACCEPTED', books_ref: 'JE-OPEN-0001' });
    expect(await as(f, 'owner', async () => errorOf(f.db, `select pm.opening_stage_handoff($1, 'JOB_WIP', '2026-09-30', '{"totals":{}}'::jsonb, '[]'::jsonb)`, [L1]))).toMatch(/PM_OPENING_ACCEPTED/);
  });
});

describe('DLR-81 c-Systems: units, parts, unit-by-unit tie-out', () => {
  let unitRows: CommittedRow[] = [];
  it('units join inventory at cost (floored, lender matched at the door) without telling Books "received"', async () => {
    const u = await bringIn('csystems-units.csv');
    expect(u.committed.counts).toEqual({ CREATED: 4 });
    unitRows = await rows(u.staged.batch_id);
    const a = await q<{ kind: string; unit_status: string; condition: string; dealer_cost_cents: string; floored: boolean; lender: string | null; stock_number: string }>(f.db,
      `select a.kind, a.unit_status, a.condition, a.dealer_cost_cents::text, a.floored, v.name as lender, a.stock_number from pm.assets a
         left join core.vendors v on v.id = a.floor_lender_vendor_id where a.org_id = $1 and a.serial_number = 'KBT3100A55012'`, [ORG_A]);
    expect(a[0]).toEqual({ kind: 'DEALER_UNIT', unit_status: 'IN_STOCK', condition: 'NEW', dealer_cost_cents: '2148000', floored: true, lender: 'Kubota Credit Corp', stock_number: 'K24-118' });
    const transit = await q<{ unit_status: string }>(f.db, `select unit_status from pm.assets where serial_number = 'KBT3100A55077'`);
    expect(transit[0]!.unit_status).toBe('IN_TRANSIT');
    const out = await q<{ n: number }>(f.db, `select count(*)::int as n from pm.dealer_outbox where org_id = $1 and event_type = 'DEALER_UNIT_RECEIVED'`, [ORG_A]);
    expect(out[0]!.n).toBe(0);
  });
  it('parts land with their bin and the opening on-hand count (a re-import adds nothing)', async () => {
    const p = await bringIn('csystems-parts.csv');
    expect(p.committed.counts).toEqual({ CREATED: 3 });
    const oh = await q<{ qty: string; bin: string }>(f.db, `select pm.part_on_hand(p.org_id, t.stock_location_id, p.item_id)::text as qty, t.bin from pm.parts p
       join pm.stock_targets t on t.item_id = p.item_id where p.part_number = 'HH150-32094'`);
    expect(oh[0]).toEqual({ qty: '14.0000', bin: 'A-12-3' });
    const again = await as(f, 'owner', async () => { const s = await stage(preview('csystems-parts.csv'), L1, '9'.repeat(64)); return commit(s.batch_id); });
    expect(again.counts).toEqual({ MATCHED: 3 });
    const oh2 = await q<{ qty: string }>(f.db, `select pm.part_on_hand(p.org_id, t.stock_location_id, p.item_id)::text as qty from pm.parts p join pm.stock_targets t on t.item_id = p.item_id where p.part_number = 'HH150-32094'`);
    expect(oh2[0]!.qty).toBe('14.0000'); // the opening on-hand is recorded once per part; later changes are physical counts
  });
  it('unit by unit against Books: ok, cost differs, missing in Books, missing in the import', async () => {
    const h = buildDealerUnitsHandoff('2026-10-24', unitRows);
    await f.db.query(`insert into public.dealer_units (org_id, location_id, serial_number, model, cost_cents, status, source)
                      values ($1, $2, '8RA12345Q', '1025R', 930000, 'IN_STOCK', 'OPENING'), ($1, $2, 'EXM404871233', 'LZS740GKA', 1200000, 'IN_STOCK', 'OPENING'),
                             ($1, $2, 'BOOKS-ONLY-1', 'X', 500000, 'IN_STOCK', 'OPENING')`, [ORG_A, L1]);
    const t = await as(f, 'owner', async () => {
      const s = await q<{ r: { handoff_id: string } }>(f.db, `select pm.opening_stage_handoff($1, 'DEALER_UNITS', '2026-10-24', $2::jsonb, '[]'::jsonb) as r`, [L1, JSON.stringify(h.payload)]);
      return q<{ r: { lines: { serial_number: string; status: string }[]; controls: { key: string }[] } }>(f.db, `select pm.opening_tieout($1) as r`, [s[0]!.r.handoff_id]);
    });
    const by = Object.fromEntries(t[0]!.r.lines.map((l) => [l.serial_number, l.status]));
    expect(by).toEqual({ KBT3100A55012: 'missing_in_books', EXM404871233: 'cost_differs', '8RA12345Q': 'ok', KBT3100A55077: 'missing_in_books', 'BOOKS-ONLY-1': 'missing_in_import' });
    expect(t[0]!.r.controls.map((c) => c.key)).toEqual(['WHOLE_GOODS_INVENTORY', 'FLOOR_PLAN_PAYABLE']);
  });
  it('reference files keep their links (open ROs → customer, warranty claims → unit)', async () => {
    await bringIn('csystems-customers.csv');
    const ro = await bringIn('csystems-open-ros.csv');
    expect(ro.committed.counts).toEqual({ REFERENCE: 3 });
    const r = await rows(ro.staged.batch_id);
    expect(r.every((x) => typeof x.data._customer_id === 'string')).toBe(true);
    const wc = await bringIn('csystems-warranty.csv');
    expect(wc.committed.counts).toEqual({ REFERENCE: 3 });
  });
});

describe('residential: Buildertrend contacts → jobs → budgets', () => {
  it('jobs link to the contact file’s customers, finished jobs stay out, budgets land by cost code', async () => {
    await bringIn('buildertrend-contacts.csv');
    const j = await bringIn('buildertrend-jobs.csv');
    expect(j.committed.counts).toEqual({ CREATED: 2, SKIPPED: 1 });
    const holt = await q<{ customer: string }>(f.db, `select c.name as customer from core.jobs j join core.customers c on c.id = j.customer_id join pm.projects p on p.job_id = j.id where p.ext ->> '_external_id' = 'BT-1043'`);
    expect(holt[0]!.customer).toBe('Dana & Chris Holt');
    // the fixture company's one cost code is "01 General"; codes we don't have are reported, not invented
    const b = await bringIn('buildertrend-budget.csv');
    expect(b.committed.counts.ERROR).toBe(3);
    expect(b.committed.errors[0]!.message).toMatch(/cost code 06-200 is not in your cost codes/);
  });
});

describe('opening handoffs: totals and blockers come from the facts, never the client', () => {
  const stageRaw = (kind: string, payload: unknown) => as(f, 'owner', () => q<{ r: { handoff_id: string; status: string; totals: Record<string, number>; blockers: { message: string }[] } }>(f.db,
    `select pm.opening_stage_handoff($1, $2, '2026-10-24', $3::jsonb, '[]'::jsonb) as r`, [L1, kind, JSON.stringify(payload)]));
  it('units: payload totals and empty blockers are ignored; a floored unit with no lender blocks', async () => {
    const r = await stageRaw('DEALER_UNITS', { totals: { units: 99, cost_cents: 1 }, blockers: [],
      units: [{ serial_number: 'T-1', cost_cents: 500_000, floor_balance_cents: 400_000, floor_lender: null }, { serial_number: 'T-2', cost_cents: 250_000, floor_balance_cents: 0 }] });
    expect(r[0]!.r.totals).toEqual({ units: 2, cost_cents: 750_000, floor_cents: 400_000, floored_units: 1 });
    expect(r[0]!.r.status).toBe('DRAFT');
    expect(r[0]!.r.blockers.map((b) => b.message)).toEqual(['T-1 owes the lender but no lender is named']);
    const stored = await q<{ totals: Record<string, number>; pt: Record<string, number> }>(f.db, `select totals, payload -> 'totals' as pt from pm.opening_handoffs where id = $1`, [r[0]!.r.handoff_id]);
    expect(stored[0]!.pt).toEqual(stored[0]!.totals);
  });
  it('a client blocker list can’t clear or add blockers; bad values are refused', async () => {
    const ok = await stageRaw('CUSTOMER_DEPOSITS', { totals: { deposits_cents: 5 }, blockers: [{ message: 'fake' }], deposits: [{ amount_cents: 1_000 }, { amount_cents: 2_500 }] });
    expect(ok[0]!.r).toMatchObject({ status: 'VALIDATED', totals: { deposits: 2, deposits_cents: 3_500 }, blockers: [] });
    expect(await as(f, 'owner', async () => errorOf(f.db, `select pm.opening_stage_handoff($1, 'CUSTOMER_DEPOSITS', '2026-10-24', $2::jsonb, '[]'::jsonb)`, [L1, JSON.stringify({ totals: {}, deposits: [{ amount_cents: -10 }] })]))).toMatch(/can't be negative/);
    expect(await as(f, 'owner', async () => errorOf(f.db, `select pm.opening_stage_handoff($1, 'OPEN_AR', '2026-10-24', $2::jsonb, '[]'::jsonb)`, [L1, JSON.stringify({ totals: {}, customers: [{ customer_id: 'b0000000-0000-4000-8000-0000000000c9', open_cents: 10 }] })]))).toMatch(/not in the caller's organization/);
    const parts = await stageRaw('PARTS_INVENTORY', { totals: { value_cents: 1 }, parts: [{ on_hand: 3, cost_cents: 842 }, { on_hand: 1.5, cost_cents: 101 }] });
    expect(parts[0]!.r.totals).toMatchObject({ parts: 2, value_cents: 2_678 });
  });
});

describe('crew invites (pack titles → Projects roles + the Projects-only flag)', () => {
  it('an invite is claimed when the person joins: role at the company, Projects-only seat', async () => {
    const r = await as(f, 'owner', () => q<{ r: { id: string; status: string; projects_only: boolean }[] }>(f.db, `select pm.onboarding_invite_crew($1, $2::jsonb) as r`,
      [L1, JSON.stringify([{ name: 'Nia Tech', email: 'Nia.Tech@example.test', title: 'Technician', role_key: 'projects_labor' }, { name: 'Pat PM', email: 'pm@example.test', title: 'Project manager', role_key: 'projects_pm' }])]));
    expect(r[0]!.r.map((x) => [x.status, x.projects_only])).toEqual([['PENDING', true], ['ACCEPTED', false]]);
    const u = await q<{ id: string }>(f.db, `insert into core.users (clerk_user_id, email, first_name, last_name) values ('user_nia', 'nia.tech@example.test', 'Nia', 'Tech') returning id`);
    const m = await q<{ id: string }>(f.db, `insert into core.memberships (user_id, org_id, role) values ($1, $2, 'member') returning id`, [u[0]!.id, ORG_A]);
    const seat = await q<{ projects_only: boolean; role: string; loc: string }>(f.db, `select ms.projects_only, d.key as role, a.location_id as loc from core.memberships ms
       join core.access_assignments a on a.membership_id = ms.id join core.role_definitions d on d.id = a.role_id where ms.id = $1`, [m[0]!.id]);
    expect(seat).toEqual([{ projects_only: true, role: 'projects_labor', loc: L1 }]);
    const inv = await q<{ status: string }>(f.db, `select status from pm.crew_invites where lower(email) = 'nia.tech@example.test'`);
    expect(inv[0]!.status).toBe('ACCEPTED');
  });
  it('refuses the owner role, other tenants and seats without team:edit', async () => {
    expect(await as(f, 'owner', async () => errorOf(f.db, `select pm.onboarding_invite_crew($1, '[{"name":"X","email":"x@example.test","role_key":"projects_owner"}]'::jsonb)`, [L1]))).toMatch(/PM_INVALID/);
    expect(await as(f, 'labor', async () => errorOf(f.db, `select pm.onboarding_invite_crew($1, '[{"name":"X","email":"x@example.test","role_key":"projects_labor"}]'::jsonb)`, [L1]))).toMatch(forbidden);
    expect(await as(f, 'bOwner', async () => errorOf(f.db, `select pm.onboarding_invite_crew($1, '[{"name":"X","email":"x@example.test","role_key":"projects_labor"}]'::jsonb)`, [L1]))).toMatch(forbidden);
    expect(await as(f, 'bOwner', async () => errorOf(f.db, `select pm.onboarding_invite_crew($1, '[{"name":"X","email":"x@example.test","role_key":"projects_labor"}]'::jsonb)`, [LB]))).toBeNull();
  });
});

describe('go-live switch (step 9)', () => {
  it('turns customer messages on and releases the held ones the owner reviewed', async () => {
    const c = await q<{ id: string }>(f.db, `select id from core.customers where org_id = $1 limit 1`, [ORG_A]);
    const held = await q<{ id: string }>(f.db, `insert into core.outbound_messages (org_id, location_id, channel, audience, to_address, body, status, status_reason)
       values ($1, $2, 'email', 'customer', 'linda.park@example.com', 'Your technician is on the way', 'held', 'held until live'),
              ($1, $2, 'email', 'customer', 'raj.m@example.com', 'Old reminder', 'held', 'held until live') returning id`, [ORG_A, L1]);
    expect(c).toHaveLength(1);
    const r = await as(f, 'owner', () => q<{ r: { live: boolean; released: number; discarded: number; still_held: number } }>(f.db,
      `select pm.onboarding_go_live($1, array[$2]::uuid[], array[$3]::uuid[]) as r`, [L1, held[0]!.id, held[1]!.id]));
    expect(r[0]!.r).toEqual({ live: true, released: 1, discarded: 1, still_held: 0 });
    const s = await q<{ customer_messages_live: boolean }>(f.db, `select customer_messages_live from core.notification_settings where org_id = $1 and location_id = $2`, [ORG_A, L1]);
    expect(s[0]!.customer_messages_live).toBe(true);
    const st = await q<{ status: string }>(f.db, `select status from core.outbound_messages where id = any($1::uuid[]) order by body desc`, [[held[0]!.id, held[1]!.id]]);
    expect(st.map((x) => x.status)).toEqual(['queued', 'cancelled']);
    expect(await as(f, 'pm', async () => errorOf(f.db, `select pm.onboarding_go_live($1)`, [L1]))).toMatch(forbidden);
  });
});

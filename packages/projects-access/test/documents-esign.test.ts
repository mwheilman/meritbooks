/**
 * 1115 documents & e-sign: versioning, retention / legal hold, folders, sheet split + current set,
 * markups visibility, the token signing flow (expiry, replay, decline, void, resend, sequential order),
 * finalize → locked signed version, the outbox, and RLS per persona (money documents included).
 *
 * Replays 1111 + 1112 + 1115 on the 1110 fixture (1115 depends on nothing in 1113 / 1114 / 1116, and
 * those are other Wave A agents' files — the full-chain replay is exercised by app-queries.test.ts).
 */

import { createHash, randomBytes } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildFixture, as, q, errorOf, type Fixture, type Persona, ORG_A, ORG_B, L1, L2, J1, J2, J3 } from './fixture';
import { applyMigration, listMigrationFiles } from './pg';

let f: Fixture;
const forbidden = /PM_FORBIDDEN/;
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const token = (): string => randomBytes(32).toString('base64url');
const PNG = `data:image/png;base64,${'iVBORw0KGgo'.padEnd(400, 'A')}=`;
let seq = 0;

beforeAll(async () => {
  f = await buildFixture();
  for (const file of listMigrationFiles().filter((x) => /^(1111|1112|1115)_/.test(x))) await applyMigration(f.db, file);
}, 600_000);

afterAll(async () => {
  await f?.db.close();
});

/** public.documents row uploaded by the persona (RLS as that persona). */
async function upload(p: Persona, name = 'file.pdf', mime = 'application/pdf'): Promise<string> {
  seq += 1;
  const org = p === 'bOwner' ? ORG_B : ORG_A;
  return as(f, p, async () => {
    const r = await q<{ id: string }>(f.db,
      `insert into public.documents (org_id, storage_path, file_name, mime_type, size_bytes, doc_type, entity_type, uploaded_by_user)
       values ($1, $2, $3, $4, 1234, 'OTHER', 'pm.doc_files', $5) returning id`,
      [org, `${org}/pm/docs/${seq}-${name}`, name, mime, f.clerk[p]]);
    return r[0].id;
  });
}

async function createDoc(p: Persona, job: string | null, attrs: Record<string, unknown> = {}, location: string | null = null): Promise<{ file_id: string; version_id: string }> {
  const doc = await upload(p, String(attrs.file_name ?? 'file.pdf'));
  return as(f, p, async () => {
    const r = await q<{ r: { file_id: string; version_id: string } }>(f.db, `select pm.doc_create($1, $2, $3, $4::jsonb) as r`,
      [job, location, doc, JSON.stringify({ mime_type: 'application/pdf', content_sha256: sha(`bytes-${seq}`), ...attrs })]);
    return r[0].r;
  });
}

const count = async (p: Persona, sql: string, params: unknown[] = []): Promise<number> =>
  as(f, p, async () => (await q<{ n: number }>(f.db, /^\s*(update|delete|insert)/i.test(sql)
    ? `with x as (${sql}) select count(*)::int as n from x` : `select count(*)::int as n from (${sql}) x`, params))[0].n);

async function asAnon<T>(fn: () => Promise<T>): Promise<T> {
  await f.db.query(`select set_config('request.jwt.claims', '{}', false)`);
  await f.db.exec('set role anon');
  try {
    return await fn();
  } finally {
    await f.db.exec('reset role');
  }
}
const anon = async (sql: string, params: unknown[]): Promise<Record<string, unknown>> =>
  asAnon(async () => (await q<{ r: Record<string, unknown> }>(f.db, sql, params))[0].r);

describe('guards (1110 contract)', () => {
  it('every new pm table is classified, every member definer RPC guarded, no Books-table gap', async () => {
    expect(await q(f.db, `select * from pm.access_unclassified_tables()`)).toEqual([]);
    expect(await q(f.db, `select * from pm.access_unguarded_rpcs()`)).toEqual([]);
    expect(await q(f.db, `select * from pm.access_seat_unprotected_tables()`)).toEqual([]);
  });
  it('anon executes nothing in pm, and exactly esign.open / sign / decline', async () => {
    expect(await q(f.db, `select p.oid::regprocedure::text f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                           where n.nspname = 'pm' and has_function_privilege('anon', p.oid, 'execute')`)).toEqual([]);
    const r = await q<{ f: string }>(f.db, `select p.proname::text f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                                             where n.nspname = 'esign' and has_function_privilege('anon', p.oid, 'execute') order by 1`);
    expect(r.map((x) => x.f)).toEqual(['decline', 'document', 'open', 'sign']);
  });
  it('members cannot read token hashes or write versions / envelopes / events directly', async () => {
    expect(await as(f, 'owner', () => errorOf(f.db, `select token_hash from pm.esign_tokens`))).toMatch(/permission denied/);
    expect(await as(f, 'owner', () => errorOf(f.db, `insert into pm.doc_versions (file_id, version_no, document_id, file_name) values (gen_random_uuid(), 1, gen_random_uuid(), 'x')`))).toMatch(/permission denied/);
    expect(await as(f, 'owner', () => errorOf(f.db, `insert into pm.esign_events (org_id, envelope_id, event) values ($1, gen_random_uuid(), 'signed')`, [ORG_A]))).toMatch(/permission denied/);
    expect(await as(f, 'owner', () => errorOf(f.db, `update pm.doc_photo_meta set received_at = now()`))).toMatch(/permission denied/);
  });
});

describe('versioning, folders, retention, legal hold', () => {
  let file: string;
  let v1: string;
  it('a new document gets version 1 and is filed into the job folder its pack names', async () => {
    const r = await createDoc('pm', J1, { title: 'Site plan', kind: 'drawing_set' });
    file = r.file_id; v1 = r.version_id;
    const folders = await as(f, 'pm', () => q<{ key: string; name: string }>(f.db, `select key, name from pm.doc_folders where job_id = $1 order by sort`, [J1]));
    expect(folders.length).toBeGreaterThanOrEqual(8);
    const row = await as(f, 'pm', () => q<{ version_count: number; folder_key: string; retention_class: string }>(f.db,
      `select d.version_count, fo.key as folder_key, d.retention_class from pm.doc_files d left join pm.doc_folders fo on fo.id = d.folder_id where d.id = $1`, [file]));
    expect(row[0]).toEqual({ version_count: 1, folder_key: 'drawings', retention_class: 'project_record' });
    expect(await as(f, 'pm', () => q(f.db, `select pm.doc_ensure_job_folders($1) as n`, [J1]))).toEqual([{ n: 0 }]); // idempotent
  });
  it('a new version supersedes the current one; history keeps both', async () => {
    const doc2 = await upload('pm');
    const r = await as(f, 'pm', () => q<{ r: { version_no: number } }>(f.db, `select pm.doc_add_version($1, $2, $3::jsonb) as r`,
      [file, doc2, JSON.stringify({ label: 'Rev B', content_sha256: sha('v2') })]));
    expect(r[0].r.version_no).toBe(2);
    const vs = await as(f, 'pm', () => q<{ version_no: number; is_current: boolean; superseded: boolean; label: string | null }>(f.db,
      `select version_no, is_current, superseded_at is not null as superseded, label from pm.doc_versions where file_id = $1 order by version_no`, [file]));
    expect(vs).toEqual([{ version_no: 1, is_current: false, superseded: true, label: null }, { version_no: 2, is_current: true, superseded: false, label: 'Rev B' }]);
    expect(await count('pm', `select 1 from pm.document_links where subject_table = 'doc_files' and subject_id = $1`, [file])).toBe(2);
  });
  it('restoring an earlier version makes a new current version on the same bytes', async () => {
    const r = await as(f, 'pm', () => q<{ r: { version_no: number } }>(f.db, `select pm.doc_restore_version($1) as r`, [v1]));
    expect(r[0].r.version_no).toBe(3);
    const cur = await as(f, 'pm', () => q<{ same: boolean; source: string }>(f.db,
      `select v.document_id = (select document_id from pm.doc_versions where id = $2) as same, v.source from pm.doc_versions v where v.file_id = $1 and v.is_current`, [file, v1]));
    expect(cur).toEqual([{ same: true, source: 'restore' }]);
    expect(await as(f, 'pm', () => errorOf(f.db, `select pm.doc_restore_version((select id from pm.doc_versions where file_id = $1 and is_current))`, [file]))).toMatch(/already current/);
  });
  it('an upload that belongs to another document cannot be reused', async () => {
    const other = await createDoc('pm', J1, { title: 'Other' });
    const used = await as(f, 'pm', () => q<{ document_id: string }>(f.db, `select document_id from pm.doc_versions where id = $1`, [v1]));
    expect(await as(f, 'pm', () => errorOf(f.db, `select pm.doc_add_version($1, $2)`, [other.file_id, used[0].document_id]))).toMatch(/PM_DOC_FILE_IN_USE/);
  });
  it('legal hold blocks new versions, restore and removal until released', async () => {
    expect(await as(f, 'pm', () => errorOf(f.db, `select pm.doc_set_legal_hold($1, true, '')`, [file]))).toMatch(/say why/);
    await as(f, 'pm', () => q(f.db, `select pm.doc_set_legal_hold($1, true, 'Claim from owner — keep everything')`, [file]));
    const doc = await upload('pm');
    expect(await as(f, 'pm', () => errorOf(f.db, `select pm.doc_add_version($1, $2)`, [file, doc]))).toMatch(/PM_DOC_LEGAL_HOLD/);
    expect(await as(f, 'pm', () => errorOf(f.db, `select pm.doc_remove($1, 'cleanup')`, [file]))).toMatch(/PM_DOC_LEGAL_HOLD/);
    expect(await as(f, 'pm', () => errorOf(f.db, `update pm.doc_files set title = 'renamed' where id = $1`, [file]))).toMatch(/PM_DOC_LEGAL_HOLD/);
    // the supervisor (documents view / create / edit, no delete) cannot release it
    expect(await as(f, 'supervisor', () => errorOf(f.db, `select pm.doc_set_legal_hold($1, false)`, [file]))).toMatch(forbidden);
    await as(f, 'pm', () => q(f.db, `select pm.doc_set_legal_hold($1, false)`, [file]));
    await as(f, 'pm', () => q(f.db, `select pm.doc_set_retention($1, 'project_record', current_date + 30)`, [file]));
    expect(await as(f, 'pm', () => errorOf(f.db, `select pm.doc_remove($1, 'cleanup')`, [file]))).toMatch(/PM_DOC_RETAINED/);
    await as(f, 'pm', () => q(f.db, `select pm.doc_set_retention($1, 'standard', null)`, [file]));
    await as(f, 'pm', () => q(f.db, `select pm.doc_remove($1, 'duplicate upload')`, [file]));
    const row = await as(f, 'pm', () => q<{ status: string; by: string }>(f.db, `select status, deleted_by as by from pm.doc_files where id = $1`, [file]));
    expect(row).toEqual([{ status: 'deleted', by: f.clerk.pm }]);
    expect(await as(f, 'pm', () => errorOf(f.db, `update pm.doc_files set status = 'active' where id = $1`, [file]))).toMatch(/Remove action/);
  });
  it('Labor adds versions to their own documents only; nobody adds a money document they cannot read', async () => {
    const own = await createDoc('labor', J2, { title: 'Crew photo sheet' });
    const doc = await upload('labor');
    expect(await as(f, 'labor', () => errorOf(f.db, `select pm.doc_add_version($1, $2)`, [own.file_id, doc]))).toBeNull();
    const ownerDoc = await createDoc('owner', J2, { title: 'Owner memo' });
    const doc2 = await upload('labor');
    expect(await as(f, 'labor', () => errorOf(f.db, `select pm.doc_add_version($1, $2)`, [ownerDoc.file_id, doc2]))).toMatch(forbidden);
    // not their job at all
    const doc3 = await upload('labor');
    expect(await as(f, 'labor', () => errorOf(f.db, `select pm.doc_create($1, null, $2, '{}'::jsonb)`, [J1, doc3]))).toMatch(forbidden);
    // a contract (money) needs contract_value
    const doc4 = await upload('supervisor');
    expect(await as(f, 'supervisor', () => errorOf(f.db, `select pm.doc_create($1, null, $2, '{"kind":"contract"}'::jsonb)`, [J1, doc4]))).toMatch(/money document/);
  });
});

describe('RLS per persona (money documents included)', () => {
  let contract: string;
  let plan: string;
  let crewDoc: string;
  let j3Doc: string;
  beforeAll(async () => {
    contract = (await createDoc('pm', J1, { title: 'Prime contract', kind: 'contract' })).file_id;
    plan = (await createDoc('pm', J1, { title: 'Floor plan', kind: 'file' })).file_id;
    crewDoc = (await createDoc('labor', J2, { title: 'Job hazard analysis', kind: 'form' })).file_id;
    j3Doc = (await createDoc('owner', J3, { title: 'L2 permit', kind: 'permit' })).file_id;
  });
  const sees = async (p: Persona, id: string): Promise<boolean> => (await count(p, `select 1 from pm.doc_files where id = $1`, [id])) === 1;

  it('a contract is visible only with contract_value on the job', async () => {
    expect(await sees('pm', contract)).toBe(true);
    expect(await sees('owner', contract)).toBe(true);
    expect(await sees('gm', contract)).toBe(true);
    expect(await sees('accountant', contract)).toBe(true);
    for (const p of ['supervisor', 'dispatcher', 'labor', 'bOwner'] as const) expect(await sees(p, contract), p).toBe(false);
    // and so are its versions, its document links, and (for Projects-only seats) its public.documents bytes row
    expect(await count('supervisor', `select 1 from pm.doc_versions where file_id = $1`, [contract])).toBe(0);
    expect(await count('supervisor', `select 1 from pm.document_links where subject_table = 'doc_files' and subject_id = $1`, [contract])).toBe(0);
    const docId = (await q<{ document_id: string }>(f.db, `select document_id from pm.doc_versions where file_id = $1`, [contract]))[0].document_id;
    expect(await count('supervisor', `select 1 from public.documents where id = $1`, [docId])).toBe(0);
    expect(await count('dispatcher', `select 1 from public.documents where id = $1`, [docId])).toBe(0);
    expect(await count('gm', `select 1 from public.documents where id = $1`, [docId])).toBe(1);
  });
  it('job documents follow job reach: own jobs for PM / Supervisor / Labor, all for office roles', async () => {
    expect(await sees('supervisor', plan)).toBe(true);    // own job J1 (task assignee)
    expect(await sees('dispatcher', plan)).toBe(true);    // all jobs at L1
    expect(await sees('labor', plan)).toBe(false);        // J2 only
    expect(await sees('labor', crewDoc)).toBe(true);
    expect(await sees('pm', crewDoc)).toBe(false);        // J2 is not the PM's job
    expect(await sees('gm', j3Doc)).toBe(false);          // L2
    expect(await sees('owner', j3Doc)).toBe(true);
    expect(await count('bOwner', `select 1 from pm.doc_files`)).toBe(0);
  });
  it('renaming needs documents:edit (Labor cannot; PM can); a contract cannot be renamed by a non-money role', async () => {
    expect(await count('labor', `update pm.doc_files set title = 'x' where id = $1 returning 1`, [crewDoc])).toBe(0);
    expect(await count('pm', `update pm.doc_files set title = 'Floor plan L1' where id = $1 returning 1`, [plan])).toBe(1);
    expect(await count('supervisor', `update pm.doc_files set title = 'x' where id = $1 returning 1`, [contract])).toBe(0);
  });
  it('company-level documents (no job) follow the company', async () => {
    const lib = (await createDoc('owner', null, { title: 'Safety manual L1', kind: 'manual' }, L1)).file_id;
    expect(await sees('labor', lib)).toBe(true);
    expect(await sees('gm', lib)).toBe(true);
    const lib2 = (await createDoc('owner', null, { title: 'L2 manual', kind: 'manual' }, L2)).file_id;
    expect(await sees('gm', lib2)).toBe(false);
  });
  it('photo metadata: Labor records it on their job; received_at is server time', async () => {
    const doc = await upload('labor', 'IMG_1.jpg', 'image/jpeg');
    await as(f, 'labor', () => q(f.db, `insert into pm.doc_photo_meta (document_id, job_id, taken_at, taken_at_source, gps_lat, gps_lng, device_make)
                                          values ($1, $2, '2026-10-01T14:03:00Z', 'exif', 41.586835, -93.625000, 'Apple')`, [doc, J2]));
    const r = await as(f, 'labor', () => q<{ fresh: boolean; lat: string }>(f.db, `select received_at > now() - interval '1 minute' as fresh, gps_lat::text as lat from pm.doc_photo_meta where document_id = $1`, [doc]));
    expect(r).toEqual([{ fresh: true, lat: '41.586835' }]);
    const doc2 = await upload('labor', 'IMG_2.jpg', 'image/jpeg');
    expect(await as(f, 'labor', () => errorOf(f.db, `insert into pm.doc_photo_meta (document_id, job_id) values ($1, $2)`, [doc2, J1]))).toMatch(/row-level security/);
  });
});

describe('drawing sets: sheet split, current set, revisions', () => {
  let set1: string;
  const sheets: Record<string, string> = {};
  const revs: Record<string, string> = {};
  async function addSheet(p: Persona, set: string, page: number, number: string, extra: Record<string, unknown> = {}): Promise<{ sheet_id: string; revision_id: string }> {
    const doc = await upload(p, `p${page}.pdf`);
    return as(f, p, async () => (await q<{ r: { sheet_id: string; revision_id: string } }>(f.db, `select pm.drawing_add_sheet($1, $2, $3::jsonb) as r`,
      [set, doc, JSON.stringify({ page_index: page, sheet_number: number, extraction: 'text', confidence: 0.9, width_pt: 2592, height_pt: 1728, ...extra })]))[0].r);
  }
  const current = async (p: Persona): Promise<Array<{ sheet_number: string; set_name: string }>> => as(f, p, () => q(f.db,
    `select sh.sheet_number, s.name as set_name from pm.drawing_sheets sh join pm.drawing_revisions r on r.id = sh.current_revision_id
       join pm.drawing_sets s on s.id = r.set_id where sh.job_id = $1 order by 1`, [J1]));

  it('a set in review adds sheets but no current revisions until it is published', async () => {
    set1 = await as(f, 'pm', async () => (await q<{ id: string }>(f.db, `select pm.drawing_set_create($1, '{"name":"IFC 1","set_kind":"ifc","issued_on":"2026-09-01","page_count":3}'::jsonb) as id`, [J1]))[0].id);
    for (const [i, n] of ['A-101', 'a-102 ', 'S-201'].entries()) {
      const r = await addSheet('pm', set1, i, n, { title: `Sheet ${n.trim().toUpperCase()}` });
      sheets[n.trim().toUpperCase()] = r.sheet_id; revs[`${n.trim().toUpperCase()}@1`] = r.revision_id;
    }
    expect(Object.keys(sheets).sort()).toEqual(['A-101', 'A-102', 'S-201']); // numbers normalized
    expect(await current('pm')).toEqual([]);
    const pub = await as(f, 'pm', () => q<{ r: { sheets: number; current: number } }>(f.db, `select pm.drawing_publish_set($1) as r`, [set1]));
    expect(pub[0].r).toMatchObject({ sheets: 3, current: 3 });
    expect((await current('pm')).map((r) => r.sheet_number)).toEqual(['A-101', 'A-102', 'S-201']);
  });
  it('a later set supersedes only the sheets it reissues', async () => {
    const set2 = await as(f, 'pm', async () => (await q<{ id: string }>(f.db, `select pm.drawing_set_create($1, '{"name":"ASI 2","set_kind":"asi","issued_on":"2026-10-01"}'::jsonb) as id`, [J1]))[0].id);
    revs['A-101@2'] = (await addSheet('pm', set2, 0, 'A-101', { revision_label: '2' })).revision_id;
    await addSheet('pm', set2, 1, 'A-103');
    const dupDoc = await upload('pm');
    expect(await as(f, 'pm', () => errorOf(f.db, `select pm.drawing_add_sheet($1, $2, '{"page_index":2,"sheet_number":"A-101"}'::jsonb)`, [set2, dupDoc]))).toMatch(/PM_DRAWING_DUPLICATE_SHEET/);
    await as(f, 'pm', () => q(f.db, `select pm.drawing_publish_set($1)`, [set2]));
    expect(await current('pm')).toEqual([
      { sheet_number: 'A-101', set_name: 'ASI 2' }, { sheet_number: 'A-102', set_name: 'IFC 1' },
      { sheet_number: 'A-103', set_name: 'ASI 2' }, { sheet_number: 'S-201', set_name: 'IFC 1' }]);
    const old = await as(f, 'pm', () => q<{ is_current: boolean }>(f.db, `select is_current from pm.drawing_revisions where id = $1`, [revs['A-101@1']]));
    expect(old).toEqual([{ is_current: false }]);
    // an unpublished third set does not move the current sheet
    const set3 = await as(f, 'pm', async () => (await q<{ id: string }>(f.db, `select pm.drawing_set_create($1, '{"name":"Bulletin 3","issued_on":"2026-11-01"}'::jsonb) as id`, [J1]))[0].id);
    await addSheet('pm', set3, 0, 'A-101', { revision_label: '3' });
    expect((await current('pm')).find((r) => r.sheet_number === 'A-101')?.set_name).toBe('ASI 2');
  });
  it('a sheet renumbered by hand moves to the right sheet (and an emptied sheet disappears)', async () => {
    const r103 = await as(f, 'pm', () => q<{ id: string }>(f.db, `select r.id from pm.drawing_revisions r join pm.drawing_sheets s on s.id = r.sheet_id where s.sheet_number = 'A-103'`));
    await as(f, 'pm', () => q(f.db, `select pm.drawing_update_revision($1, '{"sheet_number":"A-104","title":"Enlarged plan","discipline":"Architectural"}'::jsonb)`, [r103[0].id]));
    const nums = await as(f, 'pm', () => q<{ sheet_number: string; title: string | null; extraction: string }>(f.db,
      `select s.sheet_number, s.title, r.extraction from pm.drawing_sheets s left join pm.drawing_revisions r on r.id = s.current_revision_id where s.job_id = $1 order by 1`, [J1]));
    expect(nums.map((n) => n.sheet_number)).toEqual(['A-101', 'A-102', 'A-104', 'S-201']);
    expect(nums.find((n) => n.sheet_number === 'A-104')).toEqual({ sheet_number: 'A-104', title: 'Enlarged plan', extraction: 'manual' });
  });
  it('drawings follow job reach; Labor cannot add a set to a job that is not theirs', async () => {
    expect(await count('supervisor', `select 1 from pm.drawing_sheets where job_id = $1`, [J1])).toBe(4);
    expect(await count('labor', `select 1 from pm.drawing_sheets where job_id = $1`, [J1])).toBe(0);
    expect(await as(f, 'labor', () => errorOf(f.db, `select pm.drawing_set_create($1, '{}'::jsonb)`, [J1]))).toMatch(forbidden);
    expect(await as(f, 'supervisor', () => errorOf(f.db, `select pm.drawing_publish_set($1)`, [set1]))).toBeNull(); // documents:edit
  });

  describe('markups: personal vs published', () => {
    let rev: string;
    let pmPin: string;
    beforeAll(async () => { rev = revs['A-101@2']; });
    const insertMarkup = (p: Persona, vis: 'personal' | 'published', revision = rev): Promise<string | null> => as(f, p, () => errorOf(f.db,
      `insert into pm.drawing_markups (revision_id, visibility, kind, geometry) values ($1, $2, 'pin', '{"x":0.4,"y":0.6}'::jsonb)`, [revision, vis]));
    it("a personal markup is the author's only", async () => {
      expect(await insertMarkup('pm', 'personal')).toBeNull();
      pmPin = (await as(f, 'pm', () => q<{ id: string }>(f.db, `select id from pm.drawing_markups where revision_id = $1`, [rev])))[0].id;
      expect(await insertMarkup('supervisor', 'personal')).toBeNull();
      expect(await count('pm', `select 1 from pm.drawing_markups where revision_id = $1`, [rev])).toBe(1);
      expect(await count('supervisor', `select 1 from pm.drawing_markups where revision_id = $1`, [rev])).toBe(1);
      expect(await count('owner', `select 1 from pm.drawing_markups where revision_id = $1`, [rev])).toBe(0);
      const a = await as(f, 'pm', () => q<{ author_user: string; job_id: string; sheet_id: string }>(f.db, `select author_user, job_id, sheet_id from pm.drawing_markups where id = $1`, [pmPin]));
      expect(a).toEqual([{ author_user: f.clerk.pm, job_id: J1, sheet_id: sheets['A-101'] }]);
    });
    it('published markups are visible to the job; publishing needs documents:edit', async () => {
      await as(f, 'pm', () => q(f.db, `select pm.drawing_markup_publish($1, true)`, [pmPin]));
      expect(await count('supervisor', `select 1 from pm.drawing_markups where revision_id = $1`, [rev])).toBe(2);
      expect(await count('owner', `select 1 from pm.drawing_markups where revision_id = $1 and visibility = 'published'`, [rev])).toBe(1);
      expect(await count('labor', `select 1 from pm.drawing_markups where revision_id = $1`, [rev])).toBe(0); // not their job
      // someone else's personal markup cannot be published by another member
      const supPin = (await as(f, 'supervisor', () => q<{ id: string }>(f.db, `select id from pm.drawing_markups where revision_id = $1 and visibility = 'personal'`, [rev])))[0].id;
      expect(await as(f, 'pm', () => errorOf(f.db, `select pm.drawing_markup_publish($1, true)`, [supPin]))).toMatch(forbidden);
    });
    it('Labor (documents view + create) keeps personal markups, cannot publish or edit published ones', async () => {
      const set = await as(f, 'owner', async () => (await q<{ id: string }>(f.db, `select pm.drawing_set_create($1, '{"name":"J2 set"}'::jsonb) as id`, [J2]))[0].id);
      const r = await addSheet('owner', set, 0, 'M-101');
      await as(f, 'owner', () => q(f.db, `select pm.drawing_publish_set($1)`, [set]));
      expect(await insertMarkup('labor', 'personal', r.revision_id)).toBeNull();
      expect(await insertMarkup('labor', 'published', r.revision_id)).toMatch(/row-level security/);
      const mine = (await as(f, 'labor', () => q<{ id: string }>(f.db, `select id from pm.drawing_markups where revision_id = $1`, [r.revision_id])))[0].id;
      expect(await count('labor', `update pm.drawing_markups set geometry = '{"x":0.5,"y":0.5}' where id = $1 returning 1`, [mine])).toBe(1);
      expect(await as(f, 'labor', () => errorOf(f.db, `select pm.drawing_markup_publish($1, true)`, [mine]))).toMatch(forbidden);
      expect(await insertMarkup('owner', 'published', r.revision_id)).toBeNull();
      const pub = (await as(f, 'labor', () => q<{ id: string }>(f.db, `select id from pm.drawing_markups where revision_id = $1 and visibility = 'published'`, [r.revision_id])))[0].id;
      expect(await count('labor', `update pm.drawing_markups set body = 'x' where id = $1 returning 1`, [pub])).toBe(0);
      expect(await count('labor', `delete from pm.drawing_markups where id = $1 returning 1`, [pub])).toBe(0);
      expect(await as(f, 'labor', () => errorOf(f.db, `insert into pm.drawing_markups (revision_id, kind, geometry, author_user) values ($1, 'pin', '{}', 'user_owner')`, [r.revision_id]))).toMatch(/permission denied/);
    });
  });
});

describe('e-sign: one-time tokens, order, expiry, replay, decline, finalize', () => {
  let contract: string;
  let env: string;
  let signers: string[];
  const tA = token();
  const tB = token();
  let estimate: string;

  beforeAll(async () => {
    estimate = f.ids[`estimate:${J1}`];
    contract = (await createDoc('pm', J1, { title: 'Kitchen contract', kind: 'contract', subject_table: 'estimates', subject_id: estimate })).file_id;
  });

  it('only a document reader may request signatures; the completion subject must be on the job', async () => {
    expect(await as(f, 'supervisor', () => errorOf(f.db, `select pm.esign_create($1, '[{"name":"A","email":"a@x.test"}]'::jsonb)`, [contract]))).toMatch(forbidden);
    expect(await as(f, 'pm', () => errorOf(f.db, `select pm.esign_create($1, '[{"name":"A","email":"a@x.test"}]'::jsonb, $2::jsonb)`,
      [contract, JSON.stringify({ on_completed: { kind: 'estimate', id: f.ids[`estimate:${J2}`] } })]))).toMatch(/not on this document/);
    expect(await as(f, 'pm', () => errorOf(f.db, `select pm.esign_create($1, '[]'::jsonb)`, [contract]))).toMatch(/between 1 and 10/);
  });
  it('H2: an unrelated PDF can never accept an estimate or approve a change order when signed', async () => {
    // a PM's unrelated document pointed at the estimate is refused: only the estimate's own document can
    const other = (await createDoc('pm', J1, { title: 'Lunch menu', kind: 'file' })).file_id;
    expect(await as(f, 'pm', () => errorOf(f.db, `select pm.esign_create($1, '[{"name":"C","channel":"link"}]'::jsonb, $2::jsonb)`,
      [other, JSON.stringify({ on_completed: { kind: 'estimate', id: estimate } })]))).toMatch(/only the estimate document itself/);
    expect(await as(f, 'pm', () => errorOf(f.db, `select pm.esign_create($1, '[{"name":"C","channel":"link"}]'::jsonb, $2::jsonb)`,
      [other, JSON.stringify({ on_completed: { kind: 'change_order', id: f.ids[`co:${J1}`] } })]))).toMatch(/only the change order document itself/);
    // a supervisor cannot even link a document to the estimate (cannot see it) …
    const doc = await upload('supervisor');
    expect(await as(f, 'supervisor', () => errorOf(f.db, `select pm.doc_create($1, null, $2, $3::jsonb)`,
      [J1, doc, JSON.stringify({ title: 'x', kind: 'file', subject_table: 'estimates', subject_id: estimate })]))).toMatch(forbidden);
    // … and a CO document (which they may file) cannot carry an approval they do not hold
    const coDoc = (await createDoc('supervisor', J1, { title: 'CO sheet', kind: 'file', subject_table: 'change_orders', subject_id: f.ids[`co:${J1}`] })).file_id;
    expect(await as(f, 'supervisor', () => errorOf(f.db, `select pm.esign_create($1, '[{"name":"C","channel":"link"}]'::jsonb, $2::jsonb)`,
      [coDoc, JSON.stringify({ on_completed: { kind: 'change_order', id: f.ids[`co:${J1}`] } })]))).toMatch(/cannot approve this change order/);
    // a linked record must be on the same job
    const doc2 = await upload('pm');
    expect(await as(f, 'pm', () => errorOf(f.db, `select pm.doc_create($1, null, $2, $3::jsonb)`,
      [J1, doc2, JSON.stringify({ title: 'x', subject_table: 'estimates', subject_id: f.ids[`estimate:${J2}`] })]))).toMatch(/not on this document/);
  });
  it('H1: a Books file (or someone else\'s upload) cannot be attached as a Projects version', async () => {
    const books = (await q<{ id: string }>(f.db, `insert into public.documents (org_id, storage_path, file_name, doc_type, entity_type) values ($1, $2, 'bill.pdf', 'BILL', 'bill') returning id`, [ORG_A, `${ORG_A}/bill/x-bill.pdf`]))[0].id;
    expect(await as(f, 'pm', () => errorOf(f.db, `select pm.doc_create($1, null, $2, '{}'::jsonb)`, [J1, books]))).toMatch(/upload the file to Projects first/);
    const others = await upload('owner');
    expect(await as(f, 'pm', () => errorOf(f.db, `select pm.doc_create($1, null, $2, '{}'::jsonb)`, [J1, others]))).toMatch(/upload the file to Projects first/);
  });
  it('sequential: signer 2 waits until signer 1 signs', async () => {
    env = await as(f, 'pm', async () => (await q<{ id: string }>(f.db, `select pm.esign_create($1, $2::jsonb, $3::jsonb) as id`, [contract,
      JSON.stringify([{ name: 'Pat Homeowner', email: 'pat@x.test', role_label: 'Owner' }, { name: 'Sam Homeowner', phone: '+15155550100', channel: 'sms' }]),
      JSON.stringify({ title: 'Kitchen remodel contract', on_completed: { kind: 'estimate', id: estimate } })]))[0].id);
    expect(await as(f, 'pm', () => errorOf(f.db, `select pm.esign_create($1, '[{"name":"A","email":"a@x.test"}]'::jsonb)`, [contract]))).toMatch(/PM_ESIGN_OPEN/);
    const sent = await as(f, 'pm', () => q<{ r: { pending: string[] } }>(f.db, `select pm.esign_send($1) as r`, [env]));
    expect(sent[0].r.pending).toHaveLength(1);
    signers = (await q<{ id: string }>(f.db, `select id from pm.esign_signers where envelope_id = $1 order by position`, [env])).map((r) => r.id);
    expect(sent[0].r.pending).toEqual([signers[0]]);
    const issued = await as(f, 'pm', () => q<{ r: { email: string; resend: boolean } }>(f.db, `select pm.esign_issue_token($1, $2) as r`, [signers[0], sha(tA)]));
    expect(issued[0].r).toMatchObject({ email: 'pat@x.test', resend: false });
    expect(await as(f, 'pm', () => errorOf(f.db, `select pm.esign_issue_token($1, $2)`, [signers[1], sha(token())]))).toMatch(/waiting/);
  });
  it('the public page opens with the token only; unknown tokens learn nothing', async () => {
    const bad = await anon(`select esign.open($1, '203.0.113.9', 'UA') as r`, [token()]);
    expect(bad).toEqual({ ok: false, reason: 'invalid' });
    const r = await anon(`select esign.open($1, '203.0.113.9', 'Mozilla/5.0') as r`, [tA]) as {
      ok: boolean; can_act: boolean; signer: { name: string; status: string }; signers: Array<{ name: string; status: string; you: boolean }>;
      envelope: { sha256: string }; consent: { version: string; text: string }; company: { company_name: string } };
    expect(r.ok).toBe(true);
    expect(r.can_act).toBe(true);
    expect(r.signer).toMatchObject({ name: 'Pat Homeowner', status: 'viewed' });
    expect(r.signers.map((s) => [s.name, s.status, s.you])).toEqual([['Pat Homeowner', 'viewed', true], ['Sam Homeowner', 'waiting', false]]);
    expect(JSON.stringify(r)).not.toMatch(/view_url|final_url|https?:|\/pm\//);   // no URL, no storage key
    expect(r.consent.version).toBe('esign-consent-v1');
    expect(r.company.company_name).toBe('L1');
    expect(JSON.stringify(r)).not.toMatch(/\+1515/); // the other signer's contact details never leak
  });
  it('signing needs consent, a name and a drawn signature', async () => {
    expect(await anon(`select esign.sign($1, 'Pat Homeowner', $2, false, 'ip', 'ua') as r`, [tA, PNG])).toMatchObject({ ok: false, reason: 'consent_required' });
    expect(await anon(`select esign.sign($1, 'P', $2, true, 'ip', 'ua') as r`, [tA, PNG])).toMatchObject({ ok: false, reason: 'name_required' });
    expect(await anon(`select esign.sign($1, 'Pat Homeowner', 'data:image/png;base64,AAAA', true, 'ip', 'ua') as r`, [tA])).toMatchObject({ ok: false, reason: 'signature_required' });
  });
  it("signer 1 signs; the token is spent (replay refused); signer 2 becomes the outbox's turn", async () => {
    const r = await anon(`select esign.sign($1, 'Pat Homeowner', $2, true, '203.0.113.9', 'Mozilla/5.0') as r`, [tA, PNG]);
    expect(r).toMatchObject({ ok: true });
    const replay = await anon(`select esign.sign($1, 'Pat Homeowner', $2, true, '203.0.113.9', 'Mozilla/5.0') as r`, [tA, PNG]);
    expect(replay).toEqual({ ok: false, reason: 'used' });
    expect(await anon(`select esign.decline($1, 'changed my mind', 'ip', 'ua') as r`, [tA])).toEqual({ ok: false, reason: 'used' });
    expect(await anon(`select esign.document($1) as r`, [tA])).toEqual({ ok: false, reason: 'used' });
    const s = await q<{ status: string; ip: string; ua: string; typed: string }>(f.db, `select status, sign_ip as ip, sign_user_agent as ua, typed_name as typed from pm.esign_signers where envelope_id = $1 order by position`, [env]);
    expect(s).toEqual([{ status: 'signed', ip: '203.0.113.9', ua: 'Mozilla/5.0', typed: 'Pat Homeowner' }, { status: 'pending_send', ip: null, ua: null, typed: null }]);
    const out = await as(f, 'pm', () => q<{ kind: string; signer_id: string }>(f.db, `select kind, signer_id from pm.esign_outbox where envelope_id = $1`, [env]));
    expect(out).toEqual([{ kind: 'signer.turn', signer_id: signers[1] }]);
    expect(await count('pm', `select 1 from pm.esign_events where envelope_id = $1 and event = 'token_rejected'`, [env])).toBe(2);
  });
  it('the last signature completes the envelope and queues envelope.completed for the estimate', async () => {
    await as(f, 'pm', () => q(f.db, `select pm.esign_issue_token($1, $2)`, [signers[1], sha(tB)]));
    await as(f, 'pm', async () => {
      const turn = await q<{ id: string }>(f.db, `select id from pm.esign_outbox where envelope_id = $1 and kind = 'signer.turn'`, [env]);
      expect(await q(f.db, `select pm.esign_outbox_settle($1, true, '{"sent":1}'::jsonb) as s`, [turn[0].id])).toEqual([{ s: 'done' }]);
    });
    expect(await anon(`select esign.sign($1, 'Sam Homeowner', $2, true, '198.51.100.7', 'Safari') as r`, [tB, PNG])).toMatchObject({ ok: true });
    const e = await as(f, 'pm', () => q<{ status: string; finalize_state: string }>(f.db, `select status, finalize_state from pm.esign_envelopes where id = $1`, [env]));
    expect(e).toEqual([{ status: 'completed', finalize_state: 'pending' }]);
    const out = await as(f, 'pm', () => q<{ subject_kind: string; subject_id: string; status: string }>(f.db,
      `select subject_kind, subject_id, status from pm.esign_outbox where envelope_id = $1 and kind = 'envelope.completed'`, [env]));
    expect(out).toEqual([{ subject_kind: 'estimate', subject_id: estimate, status: 'pending' }]);
    const events = await as(f, 'pm', () => q<{ event: string }>(f.db, `select event from pm.esign_events where envelope_id = $1 and event <> 'token_rejected' order by seq`, [env]));
    expect(events.map((x) => x.event)).toEqual(['created', 'sent', 'delivered', 'viewed', 'consented', 'signed', 'delivered', 'consented', 'signed', 'completed']);
  });
  it('finalize stores the signed PDF as a locked current version; signed records cannot be replaced or removed', async () => {
    const signedDoc = await upload('pm', 'Kitchen contract (signed).pdf');
    expect(await as(f, 'supervisor', () => errorOf(f.db, `select pm.esign_finalize($1, $2, $3)`, [env, signedDoc, sha('signed')]))).toMatch(forbidden);
    const r = await as(f, 'pm', () => q<{ r: { version_no: number } }>(f.db, `select pm.esign_finalize($1, $2, $3) as r`, [env, signedDoc, sha('signed')]));
    expect(r[0].r.version_no).toBe(2);
    const v = await as(f, 'pm', () => q<{ locked: boolean; source: string; label: string; is_current: boolean }>(f.db, `select locked, source, label, is_current from pm.doc_versions where file_id = $1 and version_no = 2`, [contract]));
    expect(v).toEqual([{ locked: true, source: 'esign', label: 'Signed', is_current: true }]);
    const file = await as(f, 'pm', () => q<{ kept: boolean }>(f.db, `select retain_until >= current_date + 365 * 9 as kept from pm.doc_files where id = $1`, [contract]));
    expect(file).toEqual([{ kept: true }]);
    const again = await as(f, 'pm', () => q<{ r: { already: boolean } }>(f.db, `select pm.esign_finalize($1, $2, $3) as r`, [env, signedDoc, sha('signed')]));
    expect(again[0].r.already).toBe(true);
    const doc = await upload('pm');
    expect(await as(f, 'pm', () => errorOf(f.db, `select pm.doc_add_version($1, $2)`, [contract, doc]))).toMatch(/PM_DOC_LOCKED/);
    expect(await as(f, 'pm', () => errorOf(f.db, `select pm.doc_remove($1, 'x')`, [contract]))).toMatch(/PM_DOC_RETAINED|PM_DOC_LOCKED/);
    // the signer page now offers the final copy
    // M: a spent link learns nothing but why
    expect(await anon(`select esign.open($1) as r`, [tB])).toEqual({ ok: false, reason: 'used' });
  });
  it('the outbox is settled by the sender (retries, then fails); other members cannot', async () => {
    const out = await as(f, 'pm', () => q<{ id: string }>(f.db, `select id from pm.esign_outbox where envelope_id = $1 and kind = 'envelope.completed'`, [env]));
    expect(await as(f, 'supervisor', () => errorOf(f.db, `select pm.esign_outbox_settle($1, true)`, [out[0].id]))).toMatch(forbidden);
    // H2: a document editor (GM) may not run the record callback under their authority — only the sender
    expect(await as(f, 'gm', () => errorOf(f.db, `select pm.esign_outbox_settle($1, true)`, [out[0].id]))).toMatch(/only the person who sent/);
    expect(await as(f, 'pm', () => q(f.db, `select pm.esign_outbox_settle($1, false, '{}'::jsonb, 'temporary') as s`, [out[0].id]))).toEqual([{ s: 'pending' }]);
    expect(await as(f, 'pm', () => q(f.db, `select pm.esign_outbox_settle($1, true, '{"estimate":"accepted"}'::jsonb) as s`, [out[0].id]))).toEqual([{ s: 'done' }]);
    expect(await count('pm', `select 1 from pm.esign_events where envelope_id = $1 and event = 'callback_done'`, [env])).toBe(1);
  });

  async function sendOne(title: string, signer: Record<string, unknown> = { name: 'Lee Client', email: 'lee@x.test' }): Promise<{ env: string; signer: string; tok: string }> {
    const doc = (await createDoc('pm', J1, { title, kind: 'proposal' })).file_id;
    const e = await as(f, 'pm', async () => (await q<{ id: string }>(f.db, `select pm.esign_create($1, $2::jsonb) as id`, [doc, JSON.stringify([signer])]))[0].id);
    await as(f, 'pm', () => q(f.db, `select pm.esign_send($1)`, [e]));
    const s = (await q<{ id: string }>(f.db, `select id from pm.esign_signers where envelope_id = $1`, [e]))[0].id;
    const tok = token();
    await as(f, 'pm', () => q(f.db, `select pm.esign_issue_token($1, $2)`, [s, sha(tok)]));
    return { env: e, signer: s, tok };
  }

  it('an expired link (token or request) cannot be used', async () => {
    const a = await sendOne('Proposal A');
    const short = token();
    await as(f, 'pm', () => q(f.db, `select pm.esign_issue_token($1, $2, now() - interval '1 second')`, [a.signer, sha(short)]));
    expect(await anon(`select esign.sign($1, 'Lee Client', $2, true) as r`, [short, PNG])).toMatchObject({ ok: false, reason: 'expired' });
    const b = await sendOne('Proposal B');
    await f.db.query(`update pm.esign_envelopes set expires_at = now() - interval '1 minute' where id = $1`, [b.env]);
    await f.db.query(`update pm.esign_tokens set expires_at = now() + interval '1 day' where signer_id = $1`, [b.signer]);
    const o = await anon(`select esign.open($1) as r`, [b.tok]) as { ok: boolean; reason: string; envelope: { status: string } };
    expect(o).toEqual({ ok: false, reason: 'expired' });
    expect((await q<{ status: string }>(f.db, `select status from pm.esign_envelopes where id = $1`, [b.env]))[0].status).toBe('expired');
    expect(await anon(`select esign.sign($1, 'Lee Client', $2, true) as r`, [b.tok, PNG])).toMatchObject({ ok: false, reason: 'expired' });
    expect(await anon(`select esign.document($1) as r`, [b.tok])).toEqual({ ok: false, reason: 'expired' });
  });
  it('re-sending a link revokes the earlier one', async () => {
    const a = await sendOne('Proposal C');
    const fresh = token();
    const r = await as(f, 'pm', () => q<{ r: { resend: boolean } }>(f.db, `select pm.esign_issue_token($1, $2) as r`, [a.signer, sha(fresh)]));
    expect(r[0].r.resend).toBe(true);
    expect(await anon(`select esign.open($1) as r`, [a.tok])).toEqual({ ok: false, reason: 'revoked' });
    expect(await anon(`select esign.open($1) as r`, [fresh])).toMatchObject({ ok: true });
  });
  it('decline needs a reason, ends the request, revokes every other link and queues envelope.declined', async () => {
    const doc = (await createDoc('pm', J1, { title: 'CO 7', kind: 'change_order' })).file_id;
    const e = await as(f, 'pm', async () => (await q<{ id: string }>(f.db, `select pm.esign_create($1, $2::jsonb, '{"routing":"parallel"}'::jsonb) as id`,
      [doc, JSON.stringify([{ name: 'One', email: 'one@x.test' }, { name: 'Two', email: 'two@x.test' }])]))[0].id);
    const sent = await as(f, 'pm', () => q<{ r: { pending: string[] } }>(f.db, `select pm.esign_send($1) as r`, [e]));
    expect(sent[0].r.pending).toHaveLength(2); // parallel: everyone at once
    const [s1, s2] = sent[0].r.pending;
    const t1 = token(); const t2 = token();
    await as(f, 'pm', () => q(f.db, `select pm.esign_issue_token($1, $2), pm.esign_issue_token($3, $4)`, [s1, sha(t1), s2, sha(t2)]));
    expect(await anon(`select esign.decline($1, '', 'ip', 'ua') as r`, [t1])).toMatchObject({ ok: false, reason: 'reason_required' });
    expect(await anon(`select esign.decline($1, 'The price is not what we agreed', '192.0.2.1', 'ua') as r`, [t1])).toMatchObject({ ok: true });
    const st = await as(f, 'pm', () => q<{ status: string; decline_reason: string }>(f.db, `select status, decline_reason from pm.esign_envelopes where id = $1`, [e]));
    expect(st).toEqual([{ status: 'declined', decline_reason: 'The price is not what we agreed' }]);
    expect(await anon(`select esign.sign($1, 'Two', $2, true) as r`, [t2, PNG])).toMatchObject({ ok: false, reason: 'revoked' });
    expect(await anon(`select esign.document($1) as r`, [t2])).toEqual({ ok: false, reason: 'revoked' });
    expect(await anon(`select esign.document($1) as r`, [t1])).toEqual({ ok: false, reason: 'used' });
    expect(await count('pm', `select 1 from pm.esign_outbox where envelope_id = $1 and kind = 'envelope.declined'`, [e])).toBe(1);
  });
  it('voiding revokes the links; a new request can then be sent', async () => {
    const a = await sendOne('Proposal D');
    expect(await as(f, 'pm', () => errorOf(f.db, `select pm.esign_void($1, '')`, [a.env]))).toMatch(/say why/);
    await as(f, 'pm', () => q(f.db, `select pm.esign_void($1, 'Wrong price')`, [a.env]));
    expect(await anon(`select esign.open($1) as r`, [a.tok])).toMatchObject({ ok: false, reason: 'revoked' });
  });
  it('a document out for signature cannot get a new version until the request ends', async () => {
    const a = await sendOne('Proposal E');
    const file = (await q<{ file_id: string }>(f.db, `select file_id from pm.esign_envelopes where id = $1`, [a.env]))[0].file_id;
    const doc = await upload('pm');
    expect(await as(f, 'pm', () => errorOf(f.db, `select pm.doc_add_version($1, $2)`, [file, doc]))).toMatch(/PM_DOC_OUT_FOR_SIGNATURE/);
  });
  it("envelopes and their trail follow the document's money rule", async () => {
    expect(await count('pm', `select 1 from pm.esign_envelopes where id = $1`, [env])).toBe(1);
    expect(await count('supervisor', `select 1 from pm.esign_envelopes where id = $1`, [env])).toBe(0);
    expect(await count('dispatcher', `select 1 from pm.esign_signers where envelope_id = $1`, [env])).toBe(0);
    expect(await count('gm', `select 1 from pm.esign_events where envelope_id = $1`, [env])).toBeGreaterThan(5);
    expect(await count('bOwner', `select 1 from pm.esign_envelopes`)).toBe(0);
  });
});

describe('branding helper', () => {
  it('pm.doc_brand returns the company brand (falls back to defaults) and is company-guarded', async () => {
    await f.db.query(`insert into public.brand_profiles (org_id, location_id, use_tenant_brand, primary_color) values ($1, null, true, '#112233')`, [ORG_A]);
    const b = await as(f, 'pm', () => q<{ b: { company_name: string; primary_color: string } }>(f.db, `select pm.doc_brand($1) as b`, [L1]));
    expect(b[0].b).toMatchObject({ company_name: 'L1', primary_color: '#112233' });
    expect(await as(f, 'bOwner', () => errorOf(f.db, `select pm.doc_brand($1)`, [L1]))).toMatch(forbidden);
  });
});

describe('H1: storage objects under <org>/pm/ follow Projects visibility', () => {
  let contractPath: string;
  let planPath: string;
  let crewPath: string;
  const booksPath = `${ORG_A}/bill/0001-bill.pdf`;
  const pathOf = async (file: string) => (await q<{ p: string }>(f.db, `select d.storage_path p from pm.doc_versions v join public.documents d on d.id = v.document_id where v.file_id = $1 and v.is_current`, [file]))[0].p;
  const obj = async (path: string) => f.db.query(`insert into storage.objects (bucket_id, name) values ('documents', $1)`, [path]);
  const sees = async (p: Persona, path: string) => (await as(f, p, () => q(f.db, `select 1 from storage.objects where bucket_id = 'documents' and name = $1`, [path]))).length === 1;
  const anonSees = async (path: string) => asAnon(async () => (await q(f.db, `select 1 from storage.objects where name = $1`, [path])).length === 1);

  beforeAll(async () => {
    await f.db.exec(`alter table storage.objects enable row level security; grant select, insert, update, delete on storage.objects to authenticated, anon;`);
    contractPath = await pathOf((await createDoc('pm', J1, { title: 'Storage contract', kind: 'contract' })).file_id);
    planPath = await pathOf((await createDoc('pm', J1, { title: 'Storage plan', kind: 'file' })).file_id);
    crewPath = await pathOf((await createDoc('labor', J2, { title: 'Storage crew form', kind: 'form' })).file_id);
    for (const p of [contractPath, planPath, crewPath, booksPath]) await obj(p);
  });

  it('read: money files need the money capability; job files need reach; Books paths are unchanged', async () => {
    expect(await sees('pm', contractPath)).toBe(true);
    expect(await sees('gm', contractPath)).toBe(true);
    for (const p of ['labor', 'dispatcher', 'supervisor'] as const) expect(await sees(p, contractPath), p).toBe(false);
    expect(await sees('dispatcher', planPath)).toBe(true);
    expect(await sees('labor', planPath)).toBe(false);
    expect(await sees('labor', crewPath)).toBe(true);
    expect(await sees('labor', booksPath)).toBe(true);     // 112's org rule, untouched for non-pm paths
    expect(await sees('bOwner', planPath)).toBe(false);
    const listed = await as(f, 'labor', () => q<{ name: string }>(f.db, `select name from storage.objects where name like $1`, [`${ORG_A}/pm/%`]));
    expect(listed.map((x) => x.name)).toEqual([crewPath]);
  });
  it('no overwrite and no delete of a filed object, even by the person who uploaded it', async () => {
    expect(await count('pm', `update storage.objects set metadata = '{"x":1}' where name = $1 returning 1`, [contractPath])).toBe(0);
    expect(await count('pm', `delete from storage.objects where name = $1 returning 1`, [contractPath])).toBe(0);
    expect(await count('labor', `delete from storage.objects where name = $1 returning 1`, [crewPath])).toBe(0);
    expect(await count('owner', `delete from storage.objects where name = $1 returning 1`, [planPath])).toBe(0);
  });
  it('insert: only bytes for your own pending upload row under pm/{docs,drawings,esign,photos}/', async () => {
    expect(await as(f, 'pm', () => errorOf(f.db, `insert into storage.objects (bucket_id, name) values ('documents', $1)`, [`${ORG_A}/pm/docs/stray.pdf`]))).toMatch(/row-level security/);
    const id = await upload('pm', 'pending.pdf');
    const path = (await q<{ p: string }>(f.db, `select storage_path p from public.documents where id = $1`, [id]))[0].p;
    expect(await as(f, 'labor', () => errorOf(f.db, `insert into storage.objects (bucket_id, name) values ('documents', $1)`, [path]))).toMatch(/row-level security/);
    expect(await as(f, 'pm', () => errorOf(f.db, `insert into storage.objects (bucket_id, name) values ('documents', $1)`, [path]))).toBeNull();
    expect(await sees('pm', path)).toBe(true);     // own pending upload, before it is filed
    expect(await sees('owner', path)).toBe(false);
    // discard: own, never filed → row gone, 10-minute delete grant
    expect(await as(f, 'labor', () => errorOf(f.db, `select pm.doc_discard_upload($1)`, [id]))).toMatch(forbidden);
    expect(await as(f, 'pm', () => q(f.db, `select pm.doc_discard_upload($1) as p`, [id]))).toEqual([{ p: path }]);
    expect(await count('pm', `delete from storage.objects where name = $1 returning 1`, [path])).toBe(1);
    // a filed document can never be discarded
    const filedDoc = (await q<{ document_id: string }>(f.db, `select v.document_id from pm.doc_versions v join public.documents d on d.id = v.document_id where d.storage_path = $1`, [planPath]))[0].document_id;
    expect(await as(f, 'pm', () => errorOf(f.db, `select pm.doc_discard_upload($1)`, [filedDoc]))).toMatch(/PM_DOC_FILE_IN_USE/);
  });
  it('anon: no storage access at all; esign.document gives the file route its one key only while the link may act', async () => {
    const file = (await q<{ id: string }>(f.db, `select v.file_id id from pm.doc_versions v join public.documents d on d.id = v.document_id where d.storage_path = $1`, [planPath]))[0].id;
    const e = await as(f, 'pm', async () => (await q<{ id: string }>(f.db, `select pm.esign_create($1, '[{"name":"Viewer","channel":"link"}]'::jsonb) as id`, [file]))[0].id);
    await as(f, 'pm', () => q(f.db, `select pm.esign_send($1)`, [e]));
    const s = (await q<{ id: string }>(f.db, `select id from pm.esign_signers where envelope_id = $1`, [e]))[0].id;
    const t = token();
    await as(f, 'pm', () => q(f.db, `select pm.esign_issue_token($1, $2)`, [s, sha(t)]));
    expect(await anon(`select esign.open($1) as r`, [t])).toMatchObject({ ok: true });
    for (const p of [planPath, contractPath, crewPath, booksPath]) expect(await anonSees(p), p).toBe(false);
    expect(await asAnon(async () => (await q(f.db, `select 1 from storage.objects where name like $1`, [`${ORG_A}/pm/%`])).length)).toBe(0);
    const d = await anon(`select esign.document($1) as r`, [t]);
    expect(d).toMatchObject({ ok: true, path: planPath });
    expect(await anon(`select esign.document($1) as r`, [token()])).toEqual({ ok: false, reason: 'invalid' });
    // void → the very next file request is refused (the route answers 410)
    await as(f, 'pm', () => q(f.db, `select pm.esign_void($1, 'wrong address')`, [e]));
    expect(await anon(`select esign.document($1) as r`, [t])).toEqual({ ok: false, reason: 'revoked' });
    expect(await anonSees(planPath)).toBe(false);
  });
});

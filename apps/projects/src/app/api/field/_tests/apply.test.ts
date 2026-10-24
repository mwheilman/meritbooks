import { beforeEach, describe, expect, it } from 'vitest';
import { buildAccess } from '@/lib/access/derive';
import { PERSONA_TEMPLATE_GRANTS } from '@/lib/access/templates';
import type { AccessRow, PersonaKey } from '@/lib/access/types';
import { applyBatch, applyPhoto, applyRaw, captured, type FieldCtx } from '../_lib/apply';
import { extViolation } from '../_lib/store-types';
import { CHECKLISTS } from '../_lib/checklists';
import { memoryState, memoryStore, type MemoryState } from './memory-store';

const L1 = '11111111-1111-4111-8111-111111111111';
const JOB = '33333333-3333-4333-8333-333333333333';
const VISIT = '44444444-4444-4444-8444-444444444444';
const CC = '55555555-5555-4555-8555-555555555555';
const NOW = new Date('2026-10-24T22:00:00Z');
let n = 0;
const cid = () => `aaaaaaaa-0000-4000-8000-${String(++n).padStart(12, '0')}`;

function rowsFor(persona: PersonaKey, loc: string): AccessRow[] {
  const byCap = new Map<string, string[]>();
  for (const g of PERSONA_TEMPLATE_GRANTS[persona]) {
    const [cap, action] = g.split(':') as [string, string];
    byCap.set(cap, [...(byCap.get(cap) ?? []), action]);
  }
  return [...byCap].map(([capability, actions]) => ({ location_id: loc, capability, actions, role_key: persona, role_name: null }));
}

let s: MemoryState;
function ctx(persona: PersonaKey = 'projects_labor'): FieldCtx {
  return {
    store: memoryStore(s), access: buildAccess(rowsFor(persona, L1)), userId: 'user_andre', orgId: 'org-1',
    companyName: () => 'Heartland', now: NOW, defaultTz: 'America/Chicago',
  };
}

beforeEach(() => {
  s = memoryState();
  s.jobs.set(JOB, { jobId: JOB, companyId: L1, siteLat: 41.5868, siteLng: -93.625 });
  s.assignments.set(VISIT, { id: VISIT, job_id: JOB, status: 'DISPATCHED' });
});

const onSite = { lat: 41.5868, lng: -93.625, accuracyM: 8 };
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

describe('clock commands', () => {
  it('On my way and clock in move the visit; clock out makes one DRAFT entry with the original times', async () => {
    const enRoute = { id: cid(), kind: 'clock', event: 'EN_ROUTE', at: '2026-10-24T12:40:00Z', jobId: JOB, assignmentId: VISIT };
    const inId = cid();
    const clockIn = { id: inId, kind: 'clock', event: 'IN', at: '2026-10-24T13:02:00Z', tz: 'America/Chicago', geo: onSite, jobId: JOB, assignmentId: VISIT, costCodeId: CC };
    const out = { id: cid(), kind: 'clock', event: 'OUT', at: '2026-10-24T21:32:00Z', tz: 'America/Chicago', geo: onSite, jobId: JOB, costCodeId: CC, offline: true, segment: { startId: inId, startAt: clockIn.at, startGeo: onSite } };
    const r = await applyBatch(ctx(), [enRoute, clockIn, out]);
    expect(r.map((x) => x.outcome)).toEqual(['applied', 'applied', 'applied']);
    expect(s.assignments.get(VISIT)!.status).toBe('ON_SITE');
    const [entry] = [...s.time.values()];
    expect(entry).toMatchObject({ job_id: JOB, hours: 8.5, work_date: '2026-10-24', cost_code_id: CC, approval_state: 'DRAFT', source_ref: `wf:seg:${inId}`, employee_id: s.me!.employeeId, user_id: null });
    expect(entry!.notes).toContain('Clocked 8:02 AM – 4:32 PM (out) · in: on site · out: on site · sent after reconnecting');
  });

  it('re-sending the same clock-out is a duplicate (server dedupes by command)', async () => {
    const inId = cid();
    const out = { id: cid(), kind: 'clock', event: 'OUT', at: '2026-10-24T17:00:00Z', jobId: JOB, segment: { startId: inId, startAt: '2026-10-24T13:00:00Z' } };
    expect((await applyRaw(ctx(), out)).outcome).toBe('applied');
    const again = await applyRaw(ctx(), out);
    expect(again.outcome).toBe('duplicate');
    expect(s.time.size).toBe(1);
  });

  it('a corrected clock-out for the same clock-in wins while DRAFT, and is refused once approved', async () => {
    const inId = cid();
    const seg = { startId: inId, startAt: '2026-10-24T13:00:00Z' };
    await applyRaw(ctx(), { id: cid(), kind: 'clock', event: 'OUT', at: '2026-10-24T17:00:00Z', jobId: JOB, segment: seg });
    const fixed = await applyRaw(ctx(), { id: cid(), kind: 'clock', event: 'OUT', at: '2026-10-24T18:00:00Z', jobId: JOB, segment: seg });
    expect(fixed.outcome).toBe('applied');
    expect([...s.time.values()][0]!.hours).toBe(5);
    [...s.time.values()][0]!.approval_state = 'APPROVED';
    const late = await applyRaw(ctx(), { id: cid(), kind: 'clock', event: 'OUT', at: '2026-10-24T19:00:00Z', jobId: JOB, segment: seg });
    expect(late).toMatchObject({ outcome: 'rejected', code: 'TIME_APPROVED' });
    expect(late.reason).toMatch(/unapprove/);
  });

  it('an off-site clock out is recorded and flagged, never blocked', async () => {
    const r = await applyRaw(ctx(), { id: cid(), kind: 'clock', event: 'OUT', at: '2026-10-24T17:00:00Z', geo: { lat: 41.65, lng: -93.625 }, jobId: JOB, segment: { startId: cid(), startAt: '2026-10-24T13:00:00Z' } });
    expect(r.outcome).toBe('applied');
    expect(r.note).toMatch(/4\.4 mi from the site/);
    expect([...s.time.values()][0]!.notes).toContain('out: 4.4 mi from the site');
  });

  it('a clock out without the clock-in it closes is refused with a reason', async () => {
    const r = await applyRaw(ctx(), { id: cid(), kind: 'clock', event: 'OUT', at: '2026-10-24T17:00:00Z', jobId: JOB });
    expect(r).toMatchObject({ outcome: 'rejected', code: 'VALIDATION' });
  });

  it('crew clock-in needs a supervisor; a supervisor gets one entry per crew member', async () => {
    const crew = ['eeeeeeee-0000-4000-8000-000000000002', 'eeeeeeee-0000-4000-8000-000000000003'];
    const inId = cid();
    const cmd = { id: cid(), kind: 'clock', event: 'OUT', at: '2026-10-24T17:00:00Z', jobId: JOB, crewEmployeeIds: crew, segment: { startId: inId, startAt: '2026-10-24T13:00:00Z' } };
    expect(await applyRaw(ctx('projects_labor'), cmd)).toMatchObject({ outcome: 'rejected', code: 'CREW_CLOCK_NOT_ALLOWED' });
    const ok = await applyRaw(ctx('projects_supervisor'), cmd);
    expect(ok.outcome).toBe('applied');
    expect(ok.serverIds).toHaveLength(2);
    expect([...s.time.values()].map((t) => t.source_ref).sort()).toEqual(crew.map((e) => `wf:seg:${inId}:${e}`).sort());
    expect([...s.time.values()][0]!.notes).toContain('crew clock by Andre Willis');
  });

  it('a job the caller cannot reach is refused (RLS returns nothing)', async () => {
    const r = await applyRaw(ctx(), { id: cid(), kind: 'clock', event: 'IN', at: '2026-10-24T13:00:00Z', jobId: '99999999-9999-4999-8999-999999999999' });
    expect(r).toMatchObject({ outcome: 'rejected', code: 'JOB_NOT_FOUND' });
  });

  it('a database outage is retried, not rejected', async () => {
    s.failNext = { code: '08006', message: 'connection failure' };
    const r = await applyRaw(ctx(), { id: cid(), kind: 'clock', event: 'IN', at: '2026-10-24T13:00:00Z', jobId: JOB });
    expect(r.outcome).toBe('retry');
  });

  it('an RLS refusal is final and says so', async () => {
    s.failNext = { code: '42501', message: 'new row violates row-level security policy' };
    const r = await applyRaw(ctx(), { id: cid(), kind: 'clock', event: 'IN', at: '2026-10-24T13:00:00Z', jobId: JOB });
    expect(r.outcome).toBe('rejected');
  });
});

describe('time corrections and week submit', () => {
  it('edit then submit my week; someone else’s entry is not mine to submit', async () => {
    await applyRaw(ctx(), { id: cid(), kind: 'clock', event: 'OUT', at: '2026-10-24T17:00:00Z', jobId: JOB, segment: { startId: cid(), startAt: '2026-10-24T13:00:00Z' } });
    const mine = [...s.time.values()][0]!;
    s.time.set('other', { ...mine, id: 'other', employee_id: 'someone-else', user_id: null, source_ref: null });
    const upd = await applyRaw(ctx(), { id: cid(), kind: 'time.update', at: '2026-10-24T21:00:00Z', entryId: mine.id, hours: 3.75, notes: 'Left early for parts' });
    expect(upd.outcome).toBe('applied');
    expect(s.time.get(mine.id)).toMatchObject({ hours: 3.75, notes: 'Left early for parts' });
    const sub = await applyRaw(ctx(), { id: cid(), kind: 'time.submit', at: '2026-10-24T21:05:00Z', entryIds: [mine.id, 'other'].map((x) => (x === 'other' ? '66666666-6666-4666-8666-666666666666' : x)) });
    expect(sub.outcome).toBe('applied');
    expect(s.time.get(mine.id)!.approval_state).toBe('SUBMITTED');
    expect(s.time.get('other')!.approval_state).toBe('DRAFT');
    expect((await applyRaw(ctx(), { id: cid(), kind: 'time.submit', at: '2026-10-24T21:06:00Z', entryIds: [mine.id] })).outcome).toBe('duplicate');
  });

  it('crew approval: labor is refused, a supervisor approves submitted time, a second approve is a duplicate', async () => {
    await applyRaw(ctx(), { id: cid(), kind: 'clock', event: 'OUT', at: '2026-10-24T17:00:00Z', jobId: JOB, segment: { startId: cid(), startAt: '2026-10-24T13:00:00Z' } });
    const e = [...s.time.values()][0]!;
    e.approval_state = 'SUBMITTED';
    const cmd = { id: cid(), kind: 'crew.approve', at: '2026-10-24T21:00:00Z', entryIds: [e.id] };
    expect((await applyRaw(ctx('projects_labor'), cmd)).outcome).toBe('rejected');
    expect((await applyRaw(ctx('projects_supervisor'), cmd)).outcome).toBe('applied');
    expect(e.approval_state).toBe('APPROVED');
    expect((await applyRaw(ctx('projects_supervisor'), { ...cmd, id: cid() })).outcome).toBe('duplicate');
  });
});

describe('logs, checklists, punch and photos', () => {
  it('a daily log is stored once with signature, GPS and the command id', async () => {
    const log = { id: cid(), kind: 'log.submit', at: '2026-10-24T21:00:00Z', geo: onSite, jobId: JOB, logDate: '2026-10-24', body: 'Set the condenser. Inspector Tuesday.', weather: { conditions: 'Clear', highF: 61, lowF: 44, source: 'auto' }, crewCount: 3, signature: { name: 'Andre Willis', path: 'M1 1 L5 5', signedAt: '2026-10-24T21:00:00Z' } };
    expect((await applyRaw(ctx(), log)).outcome).toBe('applied');
    expect((await applyRaw(ctx(), log)).outcome).toBe('duplicate');
    const [row] = [...s.logs.values()];
    expect(row).toMatchObject({ kind: 'DAILY', crew_count: 3, weather: { conditions: 'Clear', high_f: 61, low_f: 44, source: 'auto' } });
    expect(row!.ext).toMatchObject({ _client_command_id: log.id, _source: 'merit_workforce', _signature: { name: 'Andre Willis' }, _geo: { lat: 41.5868 } });
    expect(Object.keys(row!.ext).every((k) => k.startsWith('_'))).toBe(true);
  });

  it('an empty log is refused', async () => {
    expect(await applyRaw(ctx(), { id: cid(), kind: 'log.submit', at: '2026-10-24T21:00:00Z', jobId: JOB, logDate: '2026-10-24' })).toMatchObject({ outcome: 'rejected', code: 'VALIDATION' });
  });

  it('a checklist is stored as a log with every answer; a supervisor’s failed item becomes a punch, a crew member’s stays on the checklist', async () => {
    const t = CHECKLISTS.find((c) => c.key === 'site_safety')!;
    const chkId = cid();
    const items = t.items.map((i) => ({ key: i.key, result: i.key === 'ladders' ? 'FAIL' : 'PASS', note: i.key === 'ladders' ? 'Not tied off' : null, photoIds: i.photo === 'required' || i.key === 'ladders' ? [cid()] : [] }));
    const punch = { id: cid(), kind: 'punch.create', at: '2026-10-24T21:00:00Z', jobId: JOB, title: 'Ladders inspected and tied off', description: 'Not tied off', fromChecklist: { commandId: chkId, itemKey: 'ladders' } };
    const [c, p] = await applyBatch(ctx('projects_labor'), [{ id: chkId, kind: 'checklist.submit', at: '2026-10-24T21:00:00Z', jobId: JOB, templateKey: 'site_safety', items }, punch]);
    expect(c).toMatchObject({ outcome: 'applied', note: '1 failed item will be added to the punch list.' });
    const [log] = [...s.logs.values()];
    expect(log!.kind).toBe('SAFETY');
    expect(log!.body).toContain('Fail: Ladders inspected and tied off — Not tied off');
    // Crew role: pm.punch_items RLS needs projects.jobs:create — refused with a reason, the failure stays on the checklist.
    expect(p).toMatchObject({ outcome: 'rejected', code: 'PUNCH_NOT_ALLOWED' });
    expect(p!.reason).toMatch(/saved on the checklist/);
    expect(Object.keys(log!.ext).sort()).toEqual(['_captured_at', '_checklist', '_client_command_id', '_source']);
    // Supervisor: holds projects.jobs:create (1111), so the failed item becomes a punch item.
    const sup = await applyRaw(ctx('projects_supervisor'), punch);
    expect(sup.outcome).toBe('applied');
    expect([...s.punches.values()][0]!.ext).toMatchObject({ _client_command_id: punch.id, _from_checklist: { command_id: chkId, item_key: 'ladders' } });
    expect((await applyRaw(ctx('projects_supervisor'), punch)).outcome).toBe('duplicate');
  });

  it('a checklist missing a required photo is refused with the item named', async () => {
    const t = CHECKLISTS.find((c) => c.key === 'site_safety')!;
    const r = await applyRaw(ctx(), { id: cid(), kind: 'checklist.submit', at: '2026-10-24T21:00:00Z', jobId: JOB, templateKey: 'site_safety', items: t.items.map((i) => ({ key: i.key, result: 'PASS', photoIds: [] })) });
    expect(r).toMatchObject({ outcome: 'rejected', code: 'CHECKLIST_PHOTO_REQUIRED' });
    expect(r.reason).toContain('Fall protection');
  });

  it('a photo is uploaded once to the org folder, recorded and linked to the log it was taken for', async () => {
    const logId = cid();
    await applyRaw(ctx(), { id: logId, kind: 'log.submit', at: '2026-10-24T21:00:00Z', jobId: JOB, logDate: '2026-10-24', body: 'Rough-in done' });
    const meta = { id: cid(), kind: 'photo.upload' as const, at: '2026-10-24T21:01:00Z', jobId: JOB, attachTo: { kind: 'log' as const, commandId: logId } };
    const file = { bytes: JPEG.buffer, name: 'IMG_1.jpg' };
    const r = await applyPhoto(ctx(), meta, file);
    expect(r.outcome).toBe('applied');
    expect([...s.objects.keys()]).toEqual([`org-1/projects/field/${JOB}/${meta.id}.jpg`]);
    expect(s.links[0]).toMatchObject({ jobId: JOB, subject: { table: 'field_logs' }, role: 'photo' });
    expect((await applyPhoto(ctx(), meta, file)).outcome).toBe('duplicate');
    expect(s.documents.size).toBe(1);
  });

  it('a photo whose bytes landed but whose row did not is recorded on the retry', async () => {
    const meta = { id: cid(), kind: 'photo.upload' as const, at: '2026-10-24T21:01:00Z', jobId: JOB };
    s.objects.set(`org-1/projects/field/${JOB}/${meta.id}.jpg`, 3);
    const r = await applyPhoto(ctx(), meta, { bytes: JPEG.buffer, name: 'a.jpg' });
    expect(r.outcome).toBe('applied');
    expect(s.links[0]!.subject).toEqual({ table: 'projects', id: JOB });
  });

  it('a non-image or oversized photo is refused, whatever the client called it', async () => {
    const meta = { id: cid(), kind: 'photo.upload' as const, at: '2026-10-24T21:01:00Z', jobId: JOB };
    const pdf = new TextEncoder().encode('%PDF-1.7 fake photo');
    expect(await applyPhoto(ctx(), meta, { bytes: pdf.buffer as ArrayBuffer, name: 'IMG_9.jpg' })).toMatchObject({ outcome: 'rejected', code: 'PHOTO_TYPE' });
    expect(await applyPhoto(ctx(), meta, { bytes: new ArrayBuffer(13 * 1024 * 1024), name: 'x.jpg' })).toMatchObject({ outcome: 'rejected', code: 'PHOTO_TOO_LARGE' });
    expect(s.objects.size).toBe(0);
  });

  it('the stored type comes from the bytes: PNG bytes sent as "IMG.jpg" are stored as a PNG', async () => {
    const meta = { id: cid(), kind: 'photo.upload' as const, at: '2026-10-24T21:01:00Z', jobId: JOB };
    expect((await applyPhoto(ctx(), meta, { bytes: PNG.buffer, name: 'IMG_2.jpg' })).outcome).toBe('applied');
    expect([...s.objects.keys()][0]).toBe(`org-1/projects/field/${JOB}/${meta.id}.png`);
    expect([...s.documents.values()][0]).toMatchObject({ mime_type: 'image/png', file_name: 'IMG_2.png' });
  });

  it('a photo cannot attach to a log or punch item on another job (refused, nothing uploaded)', async () => {
    const OTHER = '88888888-8888-4888-8888-888888888888';
    s.jobs.set(OTHER, { jobId: OTHER, companyId: L1, siteLat: null, siteLng: null });
    const logId = cid();
    await applyRaw(ctx(), { id: logId, kind: 'log.submit', at: '2026-10-24T21:00:00Z', jobId: OTHER, logDate: '2026-10-24', body: 'Other job' });
    const r = await applyPhoto(ctx(), { id: cid(), kind: 'photo.upload', at: '2026-10-24T21:01:00Z', jobId: JOB, attachTo: { kind: 'log', commandId: logId } }, { bytes: JPEG.buffer, name: 'a.jpg' });
    expect(r).toMatchObject({ outcome: 'rejected', code: 'ATTACH_JOB_MISMATCH' });
    expect(s.objects.size).toBe(0);
    expect(s.documents.size).toBe(0);
    const punchId = cid();
    await applyRaw(ctx('projects_supervisor'), { id: punchId, kind: 'punch.create', at: '2026-10-24T21:00:00Z', jobId: OTHER, title: 'Door' });
    const p = await applyPhoto(ctx(), { id: cid(), kind: 'photo.upload', at: '2026-10-24T21:01:00Z', jobId: JOB, attachTo: { kind: 'punch', commandId: punchId } }, { bytes: JPEG.buffer, name: 'b.jpg' });
    expect(p).toMatchObject({ outcome: 'rejected', code: 'ATTACH_JOB_MISMATCH' });
  });
});

describe('batches', () => {
  it('one bad command never sinks the batch; unknown kinds ask for an app update; a repeated id applies once', async () => {
    const log = { id: cid(), kind: 'log.submit', at: '2026-10-24T21:00:00Z', jobId: JOB, logDate: '2026-10-24', body: 'ok' };
    const r = await applyBatch(ctx(), [{ kind: 'teleport', id: cid() }, { kind: 'log.submit', id: 'not-a-uuid' }, log, log]);
    expect(r.map((x) => x.outcome)).toEqual(['rejected', 'rejected', 'applied', 'duplicate']);
    expect(r[0]!.code).toBe('UNKNOWN_KIND');
    expect(s.logs.size).toBe(1);
  });
});

describe('ext keys (pm.validate_ext: system keys must start with "_")', () => {
  it('the rule mirror refuses non-underscore keys and allows company-defined fields', () => {
    expect(extViolation({ _client_command_id: 'x', _geo: { lat: 1 } })).toBeNull();
    expect(extViolation({ client_command_id: 'x' })).toBe('client_command_id');
    expect(extViolation({ _source: 'a', signature: {} })).toBe('signature');
    expect(extViolation({ gate_code: '1234' }, ['gate_code'])).toBeNull();
  });

  it('captured() writes only underscore keys, with and without GPS and offline', () => {
    expect(Object.keys(captured({ id: 'i', at: 'a', geo: onSite, offline: true })).sort()).toEqual(['_captured_at', '_client_command_id', '_geo', '_offline', '_source']);
    expect(extViolation(captured({ id: 'i', at: 'a' }))).toBeNull();
  });

  it('a non-underscore key reaching the table is refused like the database does (final, not retried)', async () => {
    s.injectExt = { client_command_id: 'legacy' };
    const r = await applyRaw(ctx(), { id: cid(), kind: 'log.submit', at: '2026-10-24T21:00:00Z', jobId: JOB, logDate: '2026-10-24', body: 'x' });
    expect(r).toMatchObject({ outcome: 'rejected', code: 'PM_EXT_UNKNOWN_FIELD' });
    expect(s.logs.size).toBe(0);
    s.injectExt = { from_checklist: {} };
    const p = await applyRaw(ctx('projects_supervisor'), { id: cid(), kind: 'punch.create', at: '2026-10-24T21:00:00Z', jobId: JOB, title: 'Door sticks' });
    expect(p).toMatchObject({ outcome: 'rejected', code: 'PM_EXT_UNKNOWN_FIELD' });
  });
});

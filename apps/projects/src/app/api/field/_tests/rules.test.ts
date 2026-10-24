import { describe, expect, it } from 'vitest';
import {
  assignmentMove, checkAge, checkChecklist, decideTimeChange, geoStatus, localDay, planApprove, planSubmit, segmentHours, segmentNote,
  type ServerTime,
} from '../_lib/rules';
import { CHECKLISTS, templatesFor } from '../_lib/checklists';

const NOW = new Date('2026-10-24T15:00:00Z');
const base: ServerTime = { hours: 4, cost_code_id: 'cc-1', work_date: '2026-10-23', notes: 'Clocked 7:00 AM – 11:00 AM', approval_state: 'DRAFT' };

describe('sync conflict rules: field-owned fields win until approval', () => {
  it('a later field change wins over a DRAFT the office edited', () => {
    const d = decideTimeChange({ ...base, hours: 3.5 }, { hours: 4.25, cost_code_id: 'cc-2' });
    expect(d).toEqual({ action: 'apply', patch: { hours: 4.25, cost_code_id: 'cc-2' } });
  });

  it('field changes still win while SUBMITTED (the supervisor sees the corrected hours)', () => {
    expect(decideTimeChange({ ...base, approval_state: 'SUBMITTED' }, { hours: 5 })).toEqual({ action: 'apply', patch: { hours: 5 } });
  });

  it('correcting a REJECTED entry puts it back to DRAFT so it can be resubmitted', () => {
    expect(decideTimeChange({ ...base, approval_state: 'REJECTED' }, { hours: 5 })).toEqual({ action: 'apply', patch: { hours: 5, approval_state: 'DRAFT' } });
  });

  it('APPROVED time is locked: a different value is rejected with a reason the phone shows', () => {
    const d = decideTimeChange({ ...base, approval_state: 'APPROVED' }, { hours: 6 });
    expect(d).toMatchObject({ action: 'reject', code: 'TIME_APPROVED' });
    expect(d.action === 'reject' && d.reason).toMatch(/already approved.*unapprove/i);
  });

  it('re-sending the same values to approved time is a harmless duplicate, not an error', () => {
    expect(decideTimeChange({ ...base, approval_state: 'APPROVED' }, { hours: 4, cost_code_id: 'cc-1' })).toEqual({ action: 'duplicate' });
  });

  it('VOID time is locked', () => {
    expect(decideTimeChange({ ...base, approval_state: 'VOID' }, { hours: 2 })).toMatchObject({ action: 'reject', code: 'TIME_VOIDED' });
  });

  it('no change is a duplicate; numeric strings from Postgres compare as numbers', () => {
    expect(decideTimeChange({ ...base, hours: '4.00' as unknown as number }, { hours: 4, work_date: '2026-10-23' })).toEqual({ action: 'duplicate' });
  });

  it('server-owned fields cannot be patched (the patch type carries only field-owned columns)', () => {
    const d = decideTimeChange(base, { hours: 1, ...({ approval_state: 'APPROVED', cost_rate_cents: 9999 } as object) });
    expect(d).toEqual({ action: 'apply', patch: { hours: 1 } });
  });
});

describe('command age and clock math', () => {
  it('rejects a command from a phone whose clock is far ahead, and very old commands', () => {
    expect(checkAge('2026-10-24T15:05:00Z', NOW)).toBeNull();
    expect(checkAge('2026-10-24T16:00:00Z', NOW)?.code).toBe('CLOCK_AHEAD');
    expect(checkAge('2026-09-01T12:00:00Z', NOW)?.code).toBe('STALE');
    expect(checkAge('nope', NOW)?.code).toBe('BAD_TIME');
  });

  it('segment hours round to the hundredth; reversed, too long and too short are handled', () => {
    expect(segmentHours('2026-10-24T12:00:00Z', '2026-10-24T16:20:00Z')).toEqual({ ok: true, hours: 4.33, tooShort: false });
    expect(segmentHours('2026-10-24T12:00:00Z', '2026-10-24T11:00:00Z')).toMatchObject({ ok: false, code: 'INVALID_SEGMENT' });
    expect(segmentHours('2026-10-23T00:00:00Z', '2026-10-24T01:00:00Z')).toMatchObject({ ok: false, code: 'SEGMENT_TOO_LONG' });
    expect(segmentHours('2026-10-24T12:00:00Z', '2026-10-24T12:00:10Z')).toEqual({ ok: true, hours: 0, tooShort: true });
  });

  it('the work date is the clock-in day in the phone’s time zone (a night shift belongs to its start day)', () => {
    expect(localDay('2026-10-24T03:30:00Z', 'America/Chicago')).toBe('2026-10-23');
    expect(localDay('2026-10-24T03:30:00Z', 'UTC')).toBe('2026-10-24');
  });

  it('geofence flags but never blocks: on site, miles away, no fix, no site', () => {
    const site = { lat: 41.5868, lng: -93.625 };
    expect(geoStatus(site, { lat: 41.5869, lng: -93.6251, accuracyM: 10 })).toEqual({ kind: 'on_site' });
    expect(geoStatus(site, { lat: 41.6, lng: -93.625 })).toEqual({ kind: 'away', miles: 0.9 });
    expect(geoStatus(site, null)).toEqual({ kind: 'no_fix' });
    expect(geoStatus({ lat: null, lng: null }, { lat: 1, lng: 1 })).toEqual({ kind: 'no_site' });
  });

  it('the segment note carries the original punch times and where they were made', () => {
    const n = segmentNote({ startAt: '2026-10-24T12:02:00Z', endAt: '2026-10-24T16:30:00Z', tz: 'America/Chicago', endEvent: 'OUT', startGeo: { kind: 'on_site' }, endGeo: { kind: 'away', miles: 1.2 }, offline: true });
    expect(n).toBe('Clocked 7:02 AM – 11:30 AM (out) · in: on site · out: 1.2 mi from the site · sent after reconnecting · Merit Workforce');
  });
});

describe('submit, approve and visit moves', () => {
  const rows = [
    { id: 'a', approval_state: 'DRAFT' as const },
    { id: 'b', approval_state: 'SUBMITTED' as const },
    { id: 'c', approval_state: 'APPROVED' as const },
    { id: 'd', approval_state: 'REJECTED' as const },
  ];
  it('submit moves drafts and corrected rejections, leaves the rest', () => {
    expect(planSubmit(['a', 'b', 'c', 'd', 'x', 'a'], rows)).toEqual({ submit: ['a', 'd'], already: ['b'], locked: ['c'], missing: ['x'] });
  });
  it('approve sends only SUBMITTED entries to the all-or-nothing RPC', () => {
    expect(planApprove(['a', 'b', 'c', 'x'], rows)).toEqual({ approve: ['b'], already: ['c'], notSubmitted: ['a'], missing: ['x'] });
  });
  it('a visit only moves forward; a re-sent punch is a no-op', () => {
    expect(assignmentMove('DISPATCHED', 'EN_ROUTE')).toBe('EN_ROUTE');
    expect(assignmentMove('EN_ROUTE', 'IN')).toBe('ON_SITE');
    expect(assignmentMove('ON_SITE', 'IN')).toBeNull();
    expect(assignmentMove('ON_SITE', 'EN_ROUTE')).toBeNull();
    expect(assignmentMove('DONE', 'IN')).toBeNull();
    expect(assignmentMove('ASSIGNED', 'OUT')).toBeNull();
  });
});

describe('checklists', () => {
  const t = CHECKLISTS.find((c) => c.key === 'site_safety')!;
  const label = (k: string) => t.items.find((i) => i.key === k)?.text.en ?? k;
  const all = (over: Record<string, { result: 'PASS' | 'FAIL' | 'NA'; note?: string; photoIds?: string[] }> = {}) =>
    t.items.map((i) => {
      const o = over[i.key];
      return { key: i.key, result: o?.result ?? ('PASS' as const), note: o?.note ?? null, photoIds: o?.photoIds ?? (i.photo === 'required' ? ['p1'] : []) };
    });

  it('every item passes', () => {
    expect(checkChecklist(t.items, all(), label)).toMatchObject({ ok: true, pass: 7, fail: 0, na: 0 });
  });
  it('a missing answer, a missing required photo and a failure without a note are refused', () => {
    expect(checkChecklist(t.items, all().slice(1), label)).toMatchObject({ ok: false, code: 'CHECKLIST_INCOMPLETE' });
    expect(checkChecklist(t.items, all({ fall_protection: { result: 'PASS', photoIds: [] } }), label)).toMatchObject({ ok: false, code: 'CHECKLIST_PHOTO_REQUIRED' });
    expect(checkChecklist(t.items, all({ ladders: { result: 'FAIL', photoIds: ['p2'] } }), label)).toMatchObject({ ok: false, code: 'CHECKLIST_FAIL_NOTE' });
    expect(checkChecklist(t.items, all({ ladders: { result: 'FAIL', note: 'Not tied off' } }), label)).toMatchObject({ ok: false, code: 'CHECKLIST_PHOTO_REQUIRED' });
  });
  it('N/A on a photo-required item needs no photo; fails are listed for punch items', () => {
    const r = checkChecklist(t.items, all({ fall_protection: { result: 'NA', photoIds: [] }, ladders: { result: 'FAIL', note: 'Not tied off', photoIds: ['p3'] } }), label);
    expect(r).toMatchObject({ ok: true, pass: 5, fail: 1, na: 1 });
    expect(r.ok && r.failed.map((f) => f.key)).toEqual(['ladders']);
  });
  it('templates are offered by the job type’s modules', () => {
    expect(templatesFor([])).toEqual(['site_safety']);
    expect(templatesFor(['dispatch'])).toEqual(['site_safety', 'visit_closeout']);
    expect(templatesFor(['punch_warranty', 'schedule'])).toEqual(['site_safety', 'punch_walk']);
  });
  it('every template item has English and Spanish text and a unique key', () => {
    for (const c of CHECKLISTS) {
      expect(new Set(c.items.map((i) => i.key)).size).toBe(c.items.length);
      for (const i of c.items) {
        expect(i.text.en.length).toBeGreaterThan(3);
        expect(i.text.es.length).toBeGreaterThan(3);
      }
    }
  });
});

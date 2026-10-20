import { describe, expect, it } from 'vitest';
import {
  GRID_END_MIN, GRID_START_MIN, bookedMinutes, capacityOf, clockOf, dayBoundsUtc, defaultDuration, durationText, findOverlap,
  gridGeometry, localParts, missingSkills, overlaps, parseHhmm, parseSlot, shiftDay, slotOnDay, slotStarts, windowText, zonedToUtc,
} from '@/lib/pm/ops/dispatch-math';
import { suggestSlot, type TechRow } from '@/components/ops/dispatch/model';
import type { AssignmentRow } from '@/lib/pm/ops/types';

const TZ = 'America/Chicago';

describe('slot parsing (tstzrange text from PostgREST)', () => {
  it('reads the quoted, space-separated form Postgres prints', () => {
    expect(parseSlot('["2026-10-20 14:00:00+00","2026-10-20 15:30:00+00")')).toEqual({
      start: '2026-10-20T14:00:00.000Z',
      end: '2026-10-20T15:30:00.000Z',
    });
  });
  it('reads offsets with minutes and unquoted bounds', () => {
    expect(parseSlot('[2026-10-20T09:00:00+05:30,2026-10-20T10:00:00+05:30)')).toEqual({
      start: '2026-10-20T03:30:00.000Z',
      end: '2026-10-20T04:30:00.000Z',
    });
  });
  it('rejects text that is not a range', () => {
    expect(parseSlot('empty')).toBeNull();
    expect(parseSlot('["nope","2026-10-20 15:30:00+00")')).toBeNull();
  });
});

describe('local time zone windows', () => {
  it('maps a local wall-clock time to UTC on both sides of the DST change', () => {
    // Central daylight time (UTC−5) in October, standard time (UTC−6) in December.
    expect(zonedToUtc('2026-10-20', 8 * 60, TZ).toISOString()).toBe('2026-10-20T13:00:00.000Z');
    expect(zonedToUtc('2026-12-01', 8 * 60, TZ).toISOString()).toBe('2026-12-01T14:00:00.000Z');
  });
  it('round-trips through localParts', () => {
    expect(localParts('2026-10-20T13:00:00.000Z', TZ)).toEqual({ day: '2026-10-20', minutes: 480 });
    expect(localParts('2026-10-21T04:30:00.000Z', TZ)).toEqual({ day: '2026-10-20', minutes: 23 * 60 + 30 });
  });
  it('day bounds are local midnight to local midnight (23 h on the fall-back day)', () => {
    expect(dayBoundsUtc('2026-10-20', TZ)).toEqual({ from: '2026-10-20T05:00:00.000Z', to: '2026-10-21T05:00:00.000Z' });
    const fallBack = dayBoundsUtc('2026-11-01', TZ);
    expect((Date.parse(fallBack.to) - Date.parse(fallBack.from)) / 3_600_000).toBe(25);
  });
  it('places a slot on its local day and clips one that crosses midnight', () => {
    const slot = { start: '2026-10-20T14:00:00.000Z', end: '2026-10-20T15:30:00.000Z' };
    expect(slotOnDay(slot, '2026-10-20', TZ)).toEqual({ start: 540, end: 630 });
    expect(slotOnDay(slot, '2026-10-21', TZ)).toBeNull();
    const overnight = { start: '2026-10-21T03:00:00.000Z', end: '2026-10-21T07:00:00.000Z' }; // 22:00 → 02:00 local
    expect(slotOnDay(overnight, '2026-10-20', TZ)).toEqual({ start: 22 * 60, end: 24 * 60 });
    expect(slotOnDay(overnight, '2026-10-21', TZ)).toEqual({ start: 0, end: 120 });
  });
  it('says the arrival window in one phrase', () => {
    expect(windowText('2026-10-20T13:00:00.000Z', '2026-10-20T17:00:00.000Z', TZ, '2026-10-20')).toBe('Today 8:00 AM–12:00 PM');
    expect(windowText('2026-10-22T13:00:00.000Z', null, TZ, '2026-10-20')).toBe('2026-10-22 from 8:00 AM');
    expect(windowText(null, null, TZ, '2026-10-20')).toBeNull();
  });
});

describe('overlap detection (client hint for the gist exclusion)', () => {
  const blocks = [
    { id: 'a', label: 'WO-1', start: 540, end: 600 },
    { id: 'b', label: 'WO-2', start: 660, end: 720 },
  ];
  it('is half-open like tstzrange &&: touching ends do not clash', () => {
    expect(overlaps({ start: 540, end: 600 }, { start: 600, end: 660 })).toBe(false);
    expect(overlaps({ start: 540, end: 600 }, { start: 599, end: 660 })).toBe(true);
    expect(findOverlap(blocks, { start: 600, end: 660 })).toBeNull();
  });
  it('names the first block hit and can ignore the visit being moved', () => {
    expect(findOverlap(blocks, { start: 570, end: 690 })?.id).toBe('a');
    expect(findOverlap(blocks, { start: 570, end: 690 }, ['a'])?.id).toBe('b');
    expect(findOverlap(blocks, { start: 570, end: 590 }, ['a'])).toBeNull();
  });
  it('a containing interval clashes', () => {
    expect(findOverlap(blocks, { start: 500, end: 800 })?.id).toBe('a');
  });
});

describe('durations, grid and capacity', () => {
  it('rounds the estimate up to 15 minutes, 60 when there is none', () => {
    expect(defaultDuration(null)).toBe(60);
    expect(defaultDuration(0)).toBe(60);
    expect(defaultDuration(50)).toBe(60);
    expect(defaultDuration(61)).toBe(75);
    expect(defaultDuration(90)).toBe(90);
  });
  it('offers half-hour starts across the visible day', () => {
    const s = slotStarts();
    expect(s[0]).toBe(GRID_START_MIN);
    expect(s[s.length - 1]).toBe(GRID_END_MIN - 30);
    expect(s).toHaveLength((GRID_END_MIN - GRID_START_MIN) / 30);
  });
  it('clocks and parses times', () => {
    expect(clockOf(0)).toBe('12:00 AM');
    expect(clockOf(12 * 60 + 5)).toBe('12:05 PM');
    expect(clockOf(13 * 60 + 30)).toBe('1:30 PM');
    expect(parseHhmm('09:30')).toBe(570);
    expect(durationText(90)).toBe('1 h 30 min');
    expect(durationText(45)).toBe('45 min');
  });
  it('positions a block on the grid in percent', () => {
    const g = gridGeometry({ start: GRID_START_MIN, end: GRID_START_MIN + 84 });
    expect(g?.left).toBeCloseTo(0);
    expect(g?.width).toBeCloseTo((84 / (GRID_END_MIN - GRID_START_MIN)) * 100);
  });
  it('counts overlapping bookings once', () => {
    expect(bookedMinutes([{ start: 480, end: 600 }, { start: 540, end: 660 }, { start: 720, end: 780 }])).toBe(240);
    expect(bookedMinutes([])).toBe(0);
  });
  it('states capacity in plain words, and says when the day is over', () => {
    expect(capacityOf(300, 480)).toMatchObject({ free: 180, over: false, text: '5 h of 8 h booked, 3 h free' });
    const over = capacityOf(540, 480);
    expect(over.over).toBe(true);
    expect(over.fill).toBe(1);
    expect(over.text).toBe('9 h booked, 1 h over the 8 h day');
  });
  it('lists the required skills nobody assigned holds', () => {
    expect(missingSkills(['epa_608', 'gas'], ['gas'])).toEqual(['epa_608']);
    expect(missingSkills([], ['gas'])).toEqual([]);
  });
  it('shifts calendar days without time-zone drift', () => {
    expect(shiftDay('2026-10-31', 1)).toBe('2026-11-01');
    expect(shiftDay('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('suggested slot (keyboard path)', () => {
  const assignment = (wo: string): AssignmentRow => ({
    id: `as-${wo}`, job_id: 'j', work_order_id: wo, employee_id: 'e', crew_id: null, slot: '', status: 'ASSIGNED', is_lead: true,
    dispatched_at: null, en_route_at: null, arrived_at: null, done_at: null,
  });
  const row = (key: string, skills: string[], blocks: Array<[number, number, string]>): TechRow => ({
    key, employeeId: key, crewId: null, name: key, crewName: null, skills, capacityMinutes: 480,
    blocks: blocks.map(([start, end, wo]) => ({ id: `as-${wo}`, label: wo, start, end, assignment: assignment(wo), order: null })),
    capacity: capacityOf(bookedMinutes(blocks.map(([start, end]) => ({ start, end }))), 480),
  });

  it('picks the earliest free start among qualified techs', () => {
    const rows = [row('ann', ['gas'], [[360, 600, 'w1']]), row('bo', [], [])];
    expect(suggestSlot(rows, 60, ['gas'], 0)).toEqual({ techKey: 'ann', start: 600 });
    expect(suggestSlot(rows, 60, [], 0)).toEqual({ techKey: 'bo', start: 360 });
  });
  it('starts no earlier than now, rounded up to 15 minutes', () => {
    expect(suggestSlot([row('bo', [], [])], 60, [], 9 * 60 + 7)).toEqual({ techKey: 'bo', start: 9 * 60 + 15 });
  });
  it('ignores the visit being rescheduled', () => {
    expect(suggestSlot([row('ann', [], [[360, 480, 'w1']])], 60, [], 0, 'w1')).toEqual({ techKey: 'ann', start: 360 });
  });
  it('returns null when nobody qualified has room', () => {
    expect(suggestSlot([row('ann', ['gas'], [])], 60, ['epa_608'], 0)).toBeNull();
    expect(suggestSlot([row('ann', [], [[GRID_START_MIN, GRID_END_MIN, 'w1']])], 30, [], 0)).toBeNull();
  });
});

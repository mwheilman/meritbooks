import { describe, expect, it } from 'vitest';
import type { FieldExtras, FieldToday } from './contract';
import { exitPlan, stationOnly, stationRedirect, tapAge, TAP_REVIEW_MS, TAP_STALE_MS } from './station';

const can = { approveTime: false, crewClock: false, punch: false, logs: false, photos: false, time: false };
const kiosk = { features: { approvals: true, esign: false, drawings: false, kiosk: true, roClock: false, installerPay: false } } as Pick<FieldExtras, 'features'>;

describe('station-mode lock (security review M3)', () => {
  it('a seat whose only phone feature is stations is always on the station screen', () => {
    const t = { can, assignments: [] } as Pick<FieldToday, 'can' | 'assignments'>;
    expect(stationOnly(t, kiosk)).toBe(true);
    expect(stationOnly({ ...t, can: { ...can, time: true } }, kiosk)).toBe(false);
    expect(stationOnly(t, { features: { ...kiosk.features, kiosk: false } })).toBe(false);
    expect(stationOnly(null, kiosk)).toBe(false);
  });

  it('locked: every route but the station and its send list goes back to /kiosk (push taps, deep links, back)', () => {
    for (const seg of ['(tabs)', 'inbox', 'drawings', 'sell', 'sign', undefined]) expect(stationRedirect(true, false, seg)).toBe('/kiosk');
    expect(stationRedirect(true, false, 'kiosk')).toBeNull();
    expect(stationRedirect(true, false, 'queue')).toBeNull();
    expect(stationRedirect(false, true, 'inbox')).toBe('/kiosk');
    expect(stationRedirect(false, false, 'inbox')).toBeNull();
    expect(stationRedirect(null, false, 'inbox')).toBeNull();
  });

  it('leaving needs the tablet’s screen lock; without one (or for a station-only seat) it signs out, after the queue is empty', () => {
    expect(exitPlan(1, 0, false)).toBe('device-auth');
    expect(exitPlan(3, 5, false)).toBe('device-auth');
    expect(exitPlan(0, 0, false)).toBe('sign-out');
    expect(exitPlan(0, 2, false)).toBe('wait-for-queue');
    expect(exitPlan(3, 0, true)).toBe('sign-out');
  });
});

describe('dealer clock lateness', () => {
  it('fresh within 15 min, late after (reviewed), stale after 72 h (refused)', () => {
    const now = Date.parse('2026-10-25T18:00:00Z');
    expect(tapAge(new Date(now - TAP_REVIEW_MS).toISOString(), now)).toBe('fresh');
    expect(tapAge(new Date(now - TAP_REVIEW_MS - 1000).toISOString(), now)).toBe('late');
    expect(tapAge(new Date(now - TAP_STALE_MS - 1000).toISOString(), now)).toBe('stale');
  });
});

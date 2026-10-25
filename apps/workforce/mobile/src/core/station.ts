/**
 * Station-mode lock (security review M3): a tablet in station mode stays in it — a passer-by must
 * not get the station seat's full app. Leaving needs the tablet owner's screen lock (passcode /
 * biometrics); a tablet with no screen lock can only leave by signing the station seat out (the
 * next person needs the seat's own sign-in). A seat whose only phone feature is stations is always
 * locked to the station screen. Plus the dealer clock's lateness rules for the RO screen. Pure.
 */
import type { FieldExtras, FieldToday } from './contract';

/** Screens a locked station may show: the station itself and its "waiting to send" list. */
export const STATION_SCREENS: ReadonlySet<string> = new Set(['kiosk', 'queue']);

export function stationOnly(today: Pick<FieldToday, 'can' | 'assignments'> | null, extras: Pick<FieldExtras, 'features'> | null): boolean {
  if (!extras?.features.kiosk || !today) return false;
  const c = today.can;
  return !c.time && !c.logs && !c.punch && !c.approveTime && !c.crewClock && today.assignments.length === 0;
}

/** Where the app must be: null = anywhere, else the station screen. */
export function stationRedirect(locked: boolean | null, only: boolean, segment: string | undefined): '/kiosk' | null {
  if (!(locked || only)) return null;
  return STATION_SCREENS.has(segment ?? '') ? null : '/kiosk';
}

/** expo-local-authentication SecurityLevel: 0 = no screen lock on the device. */
export type ExitPlan = 'device-auth' | 'sign-out' | 'wait-for-queue' | 'stay';

/**
 * How "Leave station mode" works on this tablet. A station-only seat never leaves except by
 * signing out; signing out deletes the queue, so it waits until everything is sent.
 */
export function exitPlan(securityLevel: number, waiting: number, only: boolean): ExitPlan {
  if (!only && securityLevel > 0) return 'device-auth';
  return waiting > 0 ? 'wait-for-queue' : 'sign-out';
}

/** The dealer clock reviews a tap that reaches the office more than 15 minutes after it was tapped… */
export const TAP_REVIEW_MS = 15 * 60_000;
/** …and refuses one more than 72 hours old (PM_PUNCH_STALE). */
export const TAP_STALE_MS = 72 * 3_600_000;

export type TapAge = 'fresh' | 'late' | 'stale';

export function tapAge(atIso: string, now: number): TapAge {
  const age = now - Date.parse(atIso);
  if (!Number.isFinite(age) || age <= TAP_REVIEW_MS) return 'fresh';
  return age > TAP_STALE_MS ? 'stale' : 'late';
}

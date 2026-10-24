/**
 * Sync and conflict rules for field commands. Pure (unit-tested in ../_tests).
 *
 * The rule the phone and the office both live by: FIELD-OWNED FIELDS WIN. What the worker
 * recorded on site (when they clocked in and out, the hours, the cost code, their notes) is the
 * truth even if it reaches the server late or the office typed something else meanwhile —
 * until the time is APPROVED. Approval is the office's: approved or voided time is locked, and a
 * late field change is REJECTED with a reason the phone shows ("ask your supervisor to unapprove").
 * Server-owned fields (approval state, approver, pinned rates, billable) are never taken from the
 * phone.
 */
import type { CheckResult, Geo } from './contract';

export const MAX_COMMAND_AGE_DAYS = 35;
/** A phone clock a little ahead of the server is normal; far ahead means a wrong clock. */
export const MAX_FUTURE_SKEW_MS = 10 * 60_000;
/** Within this distance of the job site (plus GPS accuracy) a punch is "on site". */
export const ON_SITE_METERS = 300;

export interface Rejection {
  code: string;
  reason: string;
}

/** Commands must be recent and not from the future. */
export function checkAge(atIso: string, now: Date): Rejection | null {
  const at = Date.parse(atIso);
  if (Number.isNaN(at)) return { code: 'BAD_TIME', reason: 'The phone sent a time we can’t read. Check the phone’s date and time.' };
  if (at - now.getTime() > MAX_FUTURE_SKEW_MS) {
    return { code: 'CLOCK_AHEAD', reason: 'Your phone’s clock is ahead of the real time. Turn on automatic date and time, then try again.' };
  }
  if (now.getTime() - at > MAX_COMMAND_AGE_DAYS * 86_400_000) {
    return { code: 'STALE', reason: `This was saved more than ${MAX_COMMAND_AGE_DAYS} days ago. Ask the office to enter it for you.` };
  }
  return null;
}

export type SegmentHours =
  | { ok: true; hours: number; tooShort: boolean }
  | { ok: false; code: string; reason: string };

/** Hours between two instants, to the hundredth (pm.time_entries.hours is numeric(6,2), 0 < h ≤ 24). */
export function segmentHours(startIso: string, endIso: string): SegmentHours {
  const s = Date.parse(startIso);
  const e = Date.parse(endIso);
  if (Number.isNaN(s) || Number.isNaN(e)) return { ok: false, code: 'BAD_TIME', reason: 'The clock times could not be read.' };
  if (e <= s) return { ok: false, code: 'INVALID_SEGMENT', reason: 'The clock-out is before the clock-in. Check the phone’s date and time.' };
  const hours = Math.round(((e - s) / 3_600_000) * 100) / 100;
  if (hours > 24) return { ok: false, code: 'SEGMENT_TOO_LONG', reason: 'This shift is longer than 24 hours. Ask your supervisor to enter it in pieces.' };
  return { ok: true, hours, tooShort: hours < 0.01 };
}

/** The calendar day of an instant in a time zone ("2026-10-20"). */
export function localDay(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** "7:02 AM" in a time zone. */
export function localClock(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(iso));
}

export function isTimeZone(tz: string | null | undefined): tz is string {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Great-circle distance in meters. */
export function distanceMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6_371_000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export type GeoStatus = { kind: 'on_site' } | { kind: 'away'; miles: number } | { kind: 'no_fix' } | { kind: 'no_site' };

/** Where a punch was made relative to the job site. Off-site punches are flagged, never blocked. */
export function geoStatus(site: { lat: number | null; lng: number | null } | null, geo: Geo | null | undefined): GeoStatus {
  if (!geo) return { kind: 'no_fix' };
  if (!site || site.lat == null || site.lng == null) return { kind: 'no_site' };
  const d = distanceMeters({ lat: Number(site.lat), lng: Number(site.lng) }, geo);
  if (d <= ON_SITE_METERS + Math.min(geo.accuracyM ?? 0, 500)) return { kind: 'on_site' };
  return { kind: 'away', miles: Math.round((d / 1609.344) * 10) / 10 };
}

export function geoText(g: GeoStatus): string {
  switch (g.kind) {
    case 'on_site': return 'on site';
    case 'away': return `${g.miles} mi from the site`;
    case 'no_fix': return 'no GPS';
    case 'no_site': return 'site location not set';
  }
}

/** The note a clocked segment carries on its time entry (punch times + where, in plain words). */
export function segmentNote(o: {
  startAt: string; endAt: string; tz: string; endEvent: string;
  startGeo: GeoStatus; endGeo: GeoStatus; offline: boolean; crewBy?: string | null; extra?: string | null;
}): string {
  const end = o.endEvent === 'BREAK_START' ? 'break' : o.endEvent === 'SWITCH' ? 'switched job' : 'out';
  const parts = [
    `Clocked ${localClock(o.startAt, o.tz)} – ${localClock(o.endAt, o.tz)} (${end})`,
    `in: ${geoText(o.startGeo)}`,
    `out: ${geoText(o.endGeo)}`,
  ];
  if (o.offline) parts.push('sent after reconnecting');
  if (o.crewBy) parts.push(`crew clock by ${o.crewBy}`);
  if (o.extra) parts.push(o.extra);
  return `${parts.join(' · ')} · Merit Workforce`.slice(0, 1000);
}

// ---------------------------------------------------------------- time entry conflicts

export type ApprovalState = 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'VOID';

/** The field-owned columns of pm.time_entries. Nothing else is ever written from the phone. */
export interface FieldOwnedTime {
  hours: number;
  cost_code_id: string | null;
  work_date: string;
  notes: string | null;
}

export interface ServerTime extends FieldOwnedTime {
  approval_state: ApprovalState;
}

export type TimeDecision =
  | { action: 'apply'; patch: Partial<FieldOwnedTime> & { approval_state?: 'DRAFT' } }
  | { action: 'duplicate' }
  | { action: 'reject'; code: string; reason: string };

const LOCKED: Readonly<Record<'APPROVED' | 'VOID', Rejection>> = {
  APPROVED: { code: 'TIME_APPROVED', reason: 'Your supervisor already approved this time, so it is locked. Ask them to unapprove it if it needs to change.' },
  VOID: { code: 'TIME_VOIDED', reason: 'The office voided this time entry. Ask your supervisor about it.' },
};

/**
 * A field change to an existing entry. Field-owned fields win over whatever the server has —
 * unless the entry is approved or void. A rejected entry the worker corrects goes back to DRAFT
 * so they can submit it again.
 */
export function decideTimeChange(server: ServerTime, incoming: Partial<FieldOwnedTime>): TimeDecision {
  if (server.approval_state === 'APPROVED' || server.approval_state === 'VOID') {
    const same = sameFieldValues(server, incoming);
    return same ? { action: 'duplicate' } : { action: 'reject', ...LOCKED[server.approval_state] };
  }
  const patch: Partial<FieldOwnedTime> = {};
  if (incoming.hours !== undefined && Number(incoming.hours) !== Number(server.hours)) patch.hours = incoming.hours;
  if (incoming.cost_code_id !== undefined && incoming.cost_code_id !== server.cost_code_id) patch.cost_code_id = incoming.cost_code_id;
  if (incoming.work_date !== undefined && incoming.work_date !== server.work_date) patch.work_date = incoming.work_date;
  if (incoming.notes !== undefined && (incoming.notes || null) !== (server.notes || null)) patch.notes = incoming.notes || null;
  if (Object.keys(patch).length === 0) return { action: 'duplicate' };
  return { action: 'apply', patch: server.approval_state === 'REJECTED' ? { ...patch, approval_state: 'DRAFT' } : patch };
}

function sameFieldValues(server: FieldOwnedTime, incoming: Partial<FieldOwnedTime>): boolean {
  return (incoming.hours === undefined || Number(incoming.hours) === Number(server.hours))
    && (incoming.cost_code_id === undefined || incoming.cost_code_id === server.cost_code_id)
    && (incoming.work_date === undefined || incoming.work_date === server.work_date)
    && (incoming.notes === undefined || (incoming.notes || null) === (server.notes || null));
}

export interface SubmitPlan {
  submit: string[];
  already: string[];
  locked: string[];
  missing: string[];
}

/** "Submit my week": drafts and corrected rejections go to SUBMITTED; approved/void are left alone. */
export function planSubmit(ids: ReadonlyArray<string>, rows: ReadonlyArray<{ id: string; approval_state: ApprovalState }>): SubmitPlan {
  const byId = new Map(rows.map((r) => [r.id, r.approval_state]));
  const plan: SubmitPlan = { submit: [], already: [], locked: [], missing: [] };
  for (const id of new Set(ids)) {
    const s = byId.get(id);
    if (!s) plan.missing.push(id);
    else if (s === 'DRAFT' || s === 'REJECTED') plan.submit.push(id);
    else if (s === 'SUBMITTED') plan.already.push(id);
    else plan.locked.push(id);
  }
  return plan;
}

export interface ApprovePlan {
  approve: string[];
  already: string[];
  notSubmitted: string[];
  missing: string[];
}

/** Crew approval: only SUBMITTED entries go to pm.approve_time_entries (all-or-nothing there). */
export function planApprove(ids: ReadonlyArray<string>, rows: ReadonlyArray<{ id: string; approval_state: ApprovalState }>): ApprovePlan {
  const byId = new Map(rows.map((r) => [r.id, r.approval_state]));
  const plan: ApprovePlan = { approve: [], already: [], notSubmitted: [], missing: [] };
  for (const id of new Set(ids)) {
    const s = byId.get(id);
    if (!s) plan.missing.push(id);
    else if (s === 'SUBMITTED') plan.approve.push(id);
    else if (s === 'APPROVED') plan.already.push(id);
    else plan.notSubmitted.push(id);
  }
  return plan;
}

// ---------------------------------------------------------------- assignment moves

export type AssignmentStatus = 'ASSIGNED' | 'DISPATCHED' | 'EN_ROUTE' | 'ON_SITE' | 'DONE' | 'CANCELLED';
const ASSIGNMENT_ORDER: Readonly<Record<AssignmentStatus, number>> = { ASSIGNED: 0, DISPATCHED: 1, EN_ROUTE: 2, ON_SITE: 3, DONE: 4, CANCELLED: 9 };

/**
 * Should a clock event move the visit? "On my way" → EN_ROUTE, clock in → ON_SITE. A visit that
 * is already there or further along is left alone (a re-sent punch is a no-op, not an error).
 */
export function assignmentMove(current: AssignmentStatus, event: string): 'EN_ROUTE' | 'ON_SITE' | null {
  const target = event === 'EN_ROUTE' ? 'EN_ROUTE' : event === 'IN' ? 'ON_SITE' : null;
  if (!target) return null;
  if (current === 'CANCELLED' || current === 'DONE') return null;
  return ASSIGNMENT_ORDER[current] < ASSIGNMENT_ORDER[target] ? target : null;
}

// ---------------------------------------------------------------- checklists

export interface ChecklistItemDef {
  key: string;
  photo: 'required' | 'on_fail' | 'optional';
}

export interface ChecklistAnswer {
  key: string;
  result: CheckResult;
  note?: string | null;
  photoIds: string[];
}

export type ChecklistCheck =
  | { ok: true; pass: number; fail: number; na: number; failed: ChecklistAnswer[] }
  | { ok: false; code: string; reason: string };

/** Every item answered once, photos where the template requires them, a note on every failure. */
export function checkChecklist(items: ReadonlyArray<ChecklistItemDef>, answers: ReadonlyArray<ChecklistAnswer>, labelOf: (key: string) => string): ChecklistCheck {
  const byKey = new Map<string, ChecklistAnswer>();
  for (const a of answers) {
    if (byKey.has(a.key)) return { ok: false, code: 'CHECKLIST_DUPLICATE_ITEM', reason: `“${labelOf(a.key)}” was answered twice.` };
    byKey.set(a.key, a);
  }
  for (const k of byKey.keys()) {
    if (!items.some((i) => i.key === k)) return { ok: false, code: 'CHECKLIST_UNKNOWN_ITEM', reason: 'This checklist changed since it was opened. Open it again.' };
  }
  let pass = 0;
  let fail = 0;
  let na = 0;
  const failed: ChecklistAnswer[] = [];
  for (const item of items) {
    const a = byKey.get(item.key);
    if (!a) return { ok: false, code: 'CHECKLIST_INCOMPLETE', reason: `“${labelOf(item.key)}” has no answer.` };
    const needsPhoto = item.photo === 'required' ? a.result !== 'NA' : item.photo === 'on_fail' ? a.result === 'FAIL' : false;
    if (needsPhoto && a.photoIds.length === 0) return { ok: false, code: 'CHECKLIST_PHOTO_REQUIRED', reason: `“${labelOf(item.key)}” needs a photo.` };
    if (a.result === 'FAIL' && !(a.note ?? '').trim()) return { ok: false, code: 'CHECKLIST_FAIL_NOTE', reason: `Say what is wrong with “${labelOf(item.key)}”.` };
    if (a.result === 'PASS') pass += 1;
    else if (a.result === 'FAIL') { fail += 1; failed.push(a); }
    else na += 1;
  }
  return { ok: true, pass, fail, na, failed };
}

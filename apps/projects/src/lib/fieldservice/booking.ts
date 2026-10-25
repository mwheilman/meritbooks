/**
 * Booking-screen rules that run in the browser (pure; unit-tested): CSR script checks, fee
 * disclosures with the real fee filled in, capacity cell state, the duplicate-job warning and the
 * zone a zip falls in. The database enforces the same rules (pm._fs_book); these keep the CSR from
 * hitting them blind.
 */
import { money } from '@meritbooks/merit-ui';
import type { BookingJobTypeRow, CallerPop, CapacityCell, CsrScript, ScriptDisclosure, ZoneRow } from './types';

export type Answers = Readonly<Record<string, string | boolean | undefined>>;

/** Required questions not answered yet (FS-04). */
export function missingAnswers(script: CsrScript | null | undefined, answers: Answers): string[] {
  return (script?.questions ?? [])
    .filter((qn) => qn.required)
    .filter((qn) => {
      const v = answers[qn.id];
      return v === undefined || v === '' || (typeof v === 'string' && v.trim() === '');
    })
    .map((qn) => qn.id);
}

/** Disclosures that apply to this booking, with the fee filled in. A member waives the diagnostic fee. */
export function disclosuresFor(
  jt: Pick<BookingJobTypeRow, 'script' | 'diagnostic_fee_cents' | 'after_hours_fee_cents' | 'member_waives_diagnostic'>,
  opts: { afterHours: boolean; member: boolean },
): Array<ScriptDisclosure & { rendered: string }> {
  const out: Array<ScriptDisclosure & { rendered: string }> = [];
  for (const d of jt.script?.disclosures ?? []) {
    if (d.fee === 'after_hours' && !opts.afterHours) continue;
    if (d.fee === 'diagnostic' && (jt.diagnostic_fee_cents == null || (opts.member && jt.member_waives_diagnostic))) continue;
    const rendered = d.text
      .replace('{fee}', jt.diagnostic_fee_cents != null ? `$${money(jt.diagnostic_fee_cents)}` : 'the diagnostic fee')
      .replace('{after_hours_fee}', jt.after_hours_fee_cents != null ? `$${money(jt.after_hours_fee_cents)}` : 'the after-hours fee');
    out.push({ ...d, rendered });
  }
  return out;
}

/** Disclosures that must be acknowledged but are not (the AI "missed fee disclosure" flag, done by rule). */
export function missedDisclosures(required: ReadonlyArray<{ id: string }>, acknowledged: ReadonlyArray<string>): string[] {
  const ack = new Set(acknowledged);
  return required.filter((d) => !ack.has(d.id)).map((d) => d.id);
}

export type CellState = 'open' | 'tight' | 'full' | 'unlimited' | 'closed';

/** How a capacity cell reads on the booking grid. Tight = one job (or under an hour) left. */
export function cellState(c: Pick<CapacityCell, 'limited' | 'jobs_left' | 'minutes_left' | 'is_open'>, forWidget = false): CellState {
  if (!c.limited) return forWidget ? 'closed' : 'unlimited';
  if (!c.is_open) return 'full';
  if ((c.jobs_left != null && c.jobs_left <= 1) || (c.minutes_left != null && c.minutes_left < 60)) return 'tight';
  return 'open';
}

export function cellLabel(c: Pick<CapacityCell, 'limited' | 'jobs_left' | 'minutes_left' | 'max_jobs' | 'used_jobs' | 'is_open'>): string {
  if (!c.limited) return `${c.used_jobs} booked · no limit`;
  if (c.max_jobs != null) return `${c.used_jobs} of ${c.max_jobs} booked`;
  return `${c.minutes_left ?? 0} min left`;
}

/** The open job at this site (or for this customer when no site is picked) — FS-03 duplicate warning. */
export function duplicateOf(pop: CallerPop | null, siteId: string | null): { number: string; summary: string; work_order_id: string } | null {
  const open = (pop?.open_work ?? []).filter((w) => w.kind !== 'MAINTENANCE_VISIT');
  const hit = siteId ? open.find((w) => w.site_id === siteId) : open.find((w) => w.site_id === null);
  return hit ? { number: hit.number, summary: hit.summary, work_order_id: hit.work_order_id } : null;
}

export function zoneForZip(zones: ReadonlyArray<Pick<ZoneRow, 'id' | 'zips' | 'is_active'>>, zip: string | null | undefined): string | null {
  const z = (zip ?? '').trim().slice(0, 5);
  if (!z) return null;
  return zones.find((x) => x.is_active && x.zips.includes(z))?.id ?? null;
}

/** ISO weekday (1 = Monday … 7) of a YYYY-MM-DD day. */
export function isoDow(day: string): number {
  const d = new Date(`${day}T12:00:00Z`);
  return ((d.getUTCDay() + 6) % 7) + 1;
}

/** "08:00:00" → "8:00 am". */
export function clock(t: string): string {
  const [h = '0', m = '00'] = t.split(':');
  const hh = Number(h);
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${h12}:${m.padStart(2, '0')} ${hh < 12 ? 'am' : 'pm'}`;
}

/** Digits only, last 10 (matches core.party_norm_phone). */
export function normPhone(p: string | null | undefined): string {
  const d = (p ?? '').replace(/\D/g, '');
  return d.length > 10 ? d.slice(-10) : d;
}

export function fmtPhone(p: string | null | undefined): string {
  const d = normPhone(p);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : (p ?? '');
}

/**
 * Renewals compute — PURE, deterministic, unit-tested.
 *
 * Given the register's policies and an "as-of" date, surface the ones expiring within
 * the next N days (the renewal window). Read-only: no ledger post, no DB write. The
 * API and UI both route through `dueRenewals` so the calendar/list and any reminder
 * share one definition of "due".
 */

export interface RenewablePolicy {
  id: string;
  carrier: string | null;
  policy_number: string | null;
  coverage_type: string;
  premium_cents: number | null;
  premium_frequency: string;
  expiration_date: string | null;
  status: string;
}

export interface RenewalDue<T extends RenewablePolicy = RenewablePolicy> {
  policy: T;
  /** Whole days from `asOf` to expiration. Negative when already lapsed. */
  daysUntil: number;
  /** True when expiration is on/before `asOf` (already lapsed but still not renewed). */
  overdue: boolean;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Parse a yyyy-mm-dd string to a UTC-midnight epoch, or null if malformed. */
function isoToUtc(iso: string | null | undefined): number | null {
  if (typeof iso !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!m) return null;
  const [, y, mo, d] = m;
  const t = Date.UTC(Number(y), Number(mo) - 1, Number(d));
  return Number.isFinite(t) ? t : null;
}

/** Whole-day difference (b - a), both yyyy-mm-dd. Null if either is unparseable. */
export function daysBetween(aIso: string, bIso: string): number | null {
  const a = isoToUtc(aIso);
  const b = isoToUtc(bIso);
  if (a === null || b === null) return null;
  return Math.round((b - a) / MS_PER_DAY);
}

/**
 * Policies due for renewal within `windowDays` of `asOf`.
 *
 * Included: status ACTIVE or PENDING (a CANCELLED/EXPIRED policy is not "up for
 * renewal") with a parseable expiration_date that falls on/before `asOf + windowDays`.
 * Already-lapsed-but-still-active policies are included and flagged `overdue`. Sorted
 * soonest-first (most overdue at the top). Never throws.
 */
export function dueRenewals<T extends RenewablePolicy>(
  policies: readonly T[],
  asOf: string,
  windowDays: number,
): RenewalDue<T>[] {
  if (!Array.isArray(policies)) return [];
  const window = Number.isFinite(windowDays) ? Math.max(0, Math.trunc(windowDays)) : 0;

  const out: RenewalDue<T>[] = [];
  for (const p of policies) {
    if (!p || (p.status !== 'ACTIVE' && p.status !== 'PENDING')) continue;
    const daysUntil = p.expiration_date ? daysBetween(asOf, p.expiration_date) : null;
    if (daysUntil === null) continue;
    if (daysUntil > window) continue; // renews later than the window — not yet due
    out.push({ policy: p, daysUntil, overdue: daysUntil <= 0 });
  }

  out.sort((a, b) => a.daysUntil - b.daysUntil);
  return out;
}

/**
 * Renewal alerts — PURE, deterministic, read-only. No ledger post, no DB write.
 *
 * A subscription is "due" when its next renewal falls within the window — but the window
 * is NOTICE-PERIOD-AWARE: if a subscription requires 30 days' notice to cancel and renews
 * in 25 days, the cancel window has ALREADY closed, so it is surfaced (and flagged
 * `noticeWindowPassed`) even if the renewal itself is still outside a naive N-day window.
 * This is the whole point of a subscription catcher: catch it before the notice deadline.
 */

export interface RenewableSubscription {
  id: string;
  vendor_name: string;
  product: string | null;
  amount_cents: number | null;
  billing_cadence: string;
  next_renewal_date: string | null;
  notice_period_days: number | null;
  status: string;
}

export interface RenewalDue<T extends RenewableSubscription = RenewableSubscription> {
  subscription: T;
  /** Whole days from `asOf` to the next renewal. Negative when already past. */
  daysUntilRenewal: number;
  /** Whole days from `asOf` to the notice deadline (renewal − notice period). */
  daysUntilNoticeDeadline: number;
  /** True when the notice deadline is on/before `asOf` — cancel window has closed. */
  noticeWindowPassed: boolean;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function isoToUtc(iso: string | null | undefined): number | null {
  if (typeof iso !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso.trim());
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isFinite(t) ? t : null;
}

function daysBetween(aIso: string, bIso: string): number | null {
  const a = isoToUtc(aIso);
  const b = isoToUtc(bIso);
  if (a === null || b === null) return null;
  return Math.round((b - a) / MS_PER_DAY);
}

/**
 * Subscriptions due for a renewal decision within `windowDays` of `asOf`.
 *
 * Included: live subscriptions (not CANCELLED / not KEPT — a KEPT decision means the human
 * already decided) with a parseable next_renewal_date whose NOTICE DEADLINE (renewal −
 * notice) falls on/before `asOf + windowDays`. Sorted soonest-deadline-first. Never throws.
 */
export function dueRenewals<T extends RenewableSubscription>(
  subs: readonly T[],
  asOf: string,
  windowDays: number,
): RenewalDue<T>[] {
  if (!Array.isArray(subs)) return [];
  const window = Number.isFinite(windowDays) ? Math.max(0, Math.trunc(windowDays)) : 0;

  const out: RenewalDue<T>[] = [];
  for (const s of subs) {
    if (!s) continue;
    if (s.status === 'CANCELLED' || s.status === 'KEPT') continue;
    const daysUntilRenewal = s.next_renewal_date ? daysBetween(asOf, s.next_renewal_date) : null;
    if (daysUntilRenewal === null) continue;
    const notice = typeof s.notice_period_days === 'number' && s.notice_period_days > 0 ? s.notice_period_days : 0;
    const daysUntilNoticeDeadline = daysUntilRenewal - notice;
    if (daysUntilNoticeDeadline > window) continue; // decision still comfortably ahead
    out.push({
      subscription: s,
      daysUntilRenewal,
      daysUntilNoticeDeadline,
      noticeWindowPassed: daysUntilNoticeDeadline <= 0,
    });
  }

  out.sort((a, b) => a.daysUntilNoticeDeadline - b.daysUntilNoticeDeadline);
  return out;
}

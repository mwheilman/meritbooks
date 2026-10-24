/**
 * Quiet hours — ONE display for every chase screen. PURE (no I/O).
 *
 * Two tenant settings drive quiet hours today, and both screens must say the same thing:
 *   • vendor / W-9 / COI and every other request kind → the request engine's tenant default
 *     (core.request_policies 'default' row, else DEFAULT_QUIET 20:00–07:00), changed under
 *     Requests → Cadence & quiet hours;
 *   • receipt chase to cardholders → Settings → Receipt chase (core.organizations.chase_quiet_*,
 *     DB default 21:00–06:00) — lib/requests/policy `receiptPolicy`.
 * Both are read through the SAME resolver the reminder run uses (`mergePolicy` /
 * `receiptPolicy`), so what a screen shows is exactly what the engine enforces.
 */

import { mergePolicy, receiptPolicy, type PolicyContext } from './policy';
import type { QuietHours } from './types';

export interface QuietHoursSource {
  label: string;
  href: string;
}

/** Where each quiet-hours setting is changed. */
export const QUIET_HOURS_SOURCES: Record<'vendor' | 'receipt', QuietHoursSource> = {
  vendor: { label: 'Requests → Cadence & quiet hours', href: '/requests?settings=1' },
  receipt: { label: 'Settings → Receipt chase', href: '/settings?tab=chase' },
};

export interface QuietHoursSummary {
  /** W-9 / COI vendor chase (and every other request kind's tenant default). */
  vendor: QuietHours | null;
  vendorTimezone: string;
  /** Receipt chase to cardholders. */
  receipt: QuietHours | null;
  receiptTimezone: string;
}

export function quietHoursSummary(ctx: PolicyContext): QuietHoursSummary {
  const vendor = mergePolicy('w9', ctx.org, ctx.rows);
  const receipt = receiptPolicy(ctx.org);
  return { vendor: vendor.quiet, vendorTimezone: vendor.timezone, receipt: receipt.quiet, receiptTimezone: receipt.timezone };
}

/** "20:00" → "8 pm", "07:30" → "7:30 am", "00:00" → "12 am", "12:00" → "12 pm". */
export function formatClock(hhmm: string): string {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm.trim());
  if (!m) return hhmm;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  const suffix = h < 12 ? 'am' : 'pm';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return mi === 0 ? `${h12} ${suffix}` : `${h12}:${String(mi).padStart(2, '0')} ${suffix}`;
}

/** "8 pm–7 am", or "none" when no quiet window is set. */
export function formatQuietHours(q: QuietHours | null | undefined): string {
  if (!q) return 'none';
  return `${formatClock(q.start)}–${formatClock(q.end)}`;
}

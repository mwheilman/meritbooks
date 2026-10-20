import type { SupabaseClient } from '@supabase/supabase-js';
import type { JobContext, JobResult } from '../types';

/** The org-scoped job preamble: tenant + RLS client, or a FAILED result (fail closed, visibly). */
export function scopedOrFail(
  ctx: JobContext,
): { ok: true; orgId: string; db: SupabaseClient } | { ok: false; result: JobResult } {
  if (!ctx.orgId) return { ok: false, result: { status: 'skipped', summary: 'This job runs per tenant.' } };
  const db = ctx.scopedClient();
  if (!db) {
    return {
      ok: false,
      result: {
        status: 'failed',
        error: 'Tenant-scoped database access is unavailable (SUPABASE_JWT_SECRET is not set). The job will not fall back to unscoped access.',
      },
    };
  }
  return { ok: true, orgId: ctx.orgId, db };
}

/** 'YYYY-MM-DD' (UTC) of a Date. */
export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Last calendar day of the month BEFORE `d` (UTC), 'YYYY-MM-DD'. */
export function lastDayOfPriorMonth(d: Date): string {
  return isoDate(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0)));
}

/** "$1,234.56" from cents (display only — never used for arithmetic). */
export function dollars(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(cents));
  const whole = Math.floor(abs / 100).toLocaleString('en-US');
  return `${sign}$${whole}.${String(abs % 100).padStart(2, '0')}`;
}

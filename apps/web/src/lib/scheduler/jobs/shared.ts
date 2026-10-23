import type { SupabaseClient } from '@supabase/supabase-js';
import type { JobContext, JobResult } from '../types';
import { notifyMembers, tenantAdminMemberships, type NotificationSeverity } from '@/lib/notify/in-app';

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

/** 'YYYY-MM' of a 'YYYY-MM-DD' date. */
export function monthOf(isoDay: string): string {
  return isoDay.slice(0, 7);
}

/**
 * HARD_CLOSE months per company (`location:YYYY-MM`) between two dates, read through the
 * tenant's RLS client. Degrades SAFE: a read error throws (the job fails visibly) rather
 * than pretending nothing is locked.
 */
export async function loadLockedPeriods(db: SupabaseClient, fromIso: string, toIso: string): Promise<Set<string>> {
  const from = new Date(`${fromIso}T00:00:00Z`);
  const to = new Date(`${toIso}T00:00:00Z`);
  const { data, error } = await db
    .from('fiscal_periods')
    .select('location_id, period_year, period_month, status')
    .eq('status', 'HARD_CLOSE')
    .gte('period_year', from.getUTCFullYear())
    .lte('period_year', to.getUTCFullYear());
  if (error) throw new Error(`Could not read fiscal period locks: ${error.message}`);
  const out = new Set<string>();
  for (const r of (data ?? []) as Array<{ location_id: string; period_year: number; period_month: number }>) {
    out.add(`${r.location_id}:${r.period_year}-${String(r.period_month).padStart(2, '0')}`);
  }
  return out;
}

/** Company id → display name (short code preferred), through the tenant's RLS client. */
export async function loadCompanyNames(db: SupabaseClient): Promise<Map<string, string>> {
  const { data } = await db.schema('core').from('locations').select('id, name, short_code');
  const out = new Map<string, string>();
  for (const l of (data ?? []) as Array<{ id: string; name: string | null; short_code: string | null }>) {
    out.set(l.id, l.short_code || l.name || l.id.slice(0, 8));
  }
  return out;
}

/**
 * Tell the tenant's admins / managers about something a scheduled job prepared for them
 * (in-app; the digest job folds it into their email). Idempotent per `dedupeKey`. Never
 * throws — a notification is a courtesy, the run log is the record.
 */
export async function notifyTenantAdmins(
  admin: SupabaseClient,
  orgId: string,
  n: { kind: string; title: string; body?: string | null; deepLink?: string | null; dedupeKey: string; severity?: NotificationSeverity },
): Promise<number> {
  try {
    const targets = await tenantAdminMemberships(admin, orgId);
    if (targets.length === 0) return 0;
    return await notifyMembers(admin, targets, {
      orgId,
      kind: n.kind,
      title: n.title,
      body: n.body ?? null,
      deepLink: n.deepLink ?? null,
      severity: n.severity ?? 'info',
      dedupeKey: n.dedupeKey,
    });
  } catch (e) {
    console.warn('[scheduler] admin notification failed (non-fatal):', e instanceof Error ? e.message : e);
    return 0;
  }
}

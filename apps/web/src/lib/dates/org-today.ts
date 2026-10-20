/**
 * Server-side "today in the org's timezone" (reads core.organizations.timezone).
 *
 * Use this — never `new Date().toISOString().slice(0, 10)` — for any default
 * as-of date, overdue cut-off, or "days late" anchor on the server. See
 * ./org-date.ts for the pure helpers and the rationale.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { DEFAULT_ORG_TIMEZONE, normalizeTimeZone, todayInTimeZone } from './org-date';

/**
 * The org's IANA timezone. RLS-scoped read; degrades to the platform default
 * (America/Chicago, the column default) on any read failure so a date default
 * never breaks a report.
 */
export async function getOrgTimeZone(
  supabase: SupabaseClient,
  orgId: string | null | undefined,
): Promise<string> {
  try {
    let q = supabase.schema('core').from('organizations').select('timezone').limit(1);
    if (orgId) q = q.eq('id', orgId);
    const { data, error } = await q;
    if (error) return DEFAULT_ORG_TIMEZONE;
    const tz = (data?.[0] as { timezone?: string | null } | undefined)?.timezone ?? null;
    return normalizeTimeZone(tz);
  } catch {
    return DEFAULT_ORG_TIMEZONE;
  }
}

/** Today's calendar date (`YYYY-MM-DD`) in the org's timezone. */
export async function getOrgToday(
  supabase: SupabaseClient,
  orgId: string | null | undefined,
  now: Date = new Date(),
): Promise<string> {
  return todayInTimeZone(await getOrgTimeZone(supabase, orgId), now);
}

/** Both at once — callers that also format instants (e.g. "generated at"). */
export async function getOrgDateContext(
  supabase: SupabaseClient,
  orgId: string | null | undefined,
  now: Date = new Date(),
): Promise<{ timeZone: string; today: string }> {
  const timeZone = await getOrgTimeZone(supabase, orgId);
  return { timeZone, today: todayInTimeZone(timeZone, now) };
}

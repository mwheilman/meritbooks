/**
 * Report library state per user (favourites, recently run) — public.report_user_prefs
 * (mig 185). Members read their own rows; writes go through the service role AFTER the
 * route authenticated the caller and resolved the org (never a member-client write).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { serviceWriter } from '@/lib/db/scoped-writer';

export interface ReportPref {
  reportKey: string;
  isFavorite: boolean;
  runCount: number;
  lastRunAt: string | null;
}

export async function listPrefs(supabase: SupabaseClient, userId: string): Promise<ReportPref[]> {
  const { data, error } = await supabase
    .from('report_user_prefs')
    .select('report_key, is_favorite, run_count, last_run_at')
    .eq('user_id', userId)
    .order('last_run_at', { ascending: false, nullsFirst: false })
    .limit(200);
  if (error) {
    if (error.code === '42P01') return [];
    throw new Error(error.message);
  }
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    reportKey: String(r.report_key),
    isFavorite: r.is_favorite === true,
    runCount: Number(r.run_count ?? 0),
    lastRunAt: (r.last_run_at as string) ?? null,
  }));
}

async function current(orgId: string, userId: string, reportKey: string, writer: SupabaseClient) {
  const { data } = await writer
    .from('report_user_prefs')
    .select('id, is_favorite, run_count')
    .eq('org_id', orgId)
    .eq('user_id', userId)
    .eq('report_key', reportKey)
    .maybeSingle();
  return data as { id: string; is_favorite: boolean; run_count: number } | null;
}

export async function setFavorite(orgId: string, userId: string, reportKey: string, favorite: boolean, writer?: SupabaseClient): Promise<void> {
  const w = serviceWriter(writer);
  const row = await current(orgId, userId, reportKey, w);
  if (row) {
    const { error } = await w.from('report_user_prefs').update({ is_favorite: favorite, updated_at: new Date().toISOString() }).eq('id', row.id);
    if (error) throw new Error(error.message);
  } else {
    const { error } = await w.from('report_user_prefs').insert({ org_id: orgId, user_id: userId, report_key: reportKey, is_favorite: favorite });
    if (error) throw new Error(error.message);
  }
}

/** Best-effort: a failure to record "recently run" never fails the report. */
export async function recordRun(orgId: string, userId: string, reportKey: string, config: unknown, writer?: SupabaseClient): Promise<void> {
  try {
    const w = serviceWriter(writer);
    const row = await current(orgId, userId, reportKey, w);
    const now = new Date().toISOString();
    if (row) {
      await w.from('report_user_prefs').update({ run_count: (row.run_count ?? 0) + 1, last_run_at: now, last_config: config, updated_at: now }).eq('id', row.id);
    } else {
      await w.from('report_user_prefs').insert({ org_id: orgId, user_id: userId, report_key: reportKey, run_count: 1, last_run_at: now, last_config: config });
    }
  } catch {
    /* history is a convenience, not a control */
  }
}

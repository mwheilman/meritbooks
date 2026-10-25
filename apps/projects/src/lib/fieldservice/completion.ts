import 'server-only';
/**
 * Server reads for the field-service completion screens (migration 1123). Every read runs on the
 * caller's RLS client; RPCs strip money inside, table reads use the masked views where a table has
 * masked columns. Page loaders return { data, error } so a page can show its error state instead of
 * throwing; route handlers use fsCall (lib/fieldservice/rpc.ts) for the plain-language errors.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  CALL_LOG_COLS, FINDING_COLS, FORM_TEMPLATE_COLS, INSTALL_ITEM_COLS, MESSAGE_TEMPLATE_COLS, ONLINE_ACCEPTANCE_COLS, PHONE_PROVIDER_COLS,
  THREAD_COLS, THREAD_MESSAGE_COLS,
  type CallLogRow, type FindingRow, type FormTemplateRow, type InstallItemRow, type MessageTemplateRow, type OnlineAcceptanceRow,
  type PhoneProviderRow, type ThreadMessageRow, type ThreadRow,
} from './completion-types';

export interface Loaded<T> {
  data: T;
  error: string | null;
}

const pm = (db: SupabaseClient) => db.schema('pm');

/** Plain sentence from a database refusal ("PM_FORBIDDEN: requires …" → "Requires …."). */
export function plain(message: string | null | undefined): string {
  const m = (message ?? '').replace(/^\s*[A-Z][A-Z0-9_]{3,}:\s*/, '').trim();
  return m ? m.charAt(0).toUpperCase() + m.slice(1).replace(/\.?$/, '.') : 'That did not load.';
}

/** One pm RPC for a page: the fallback value and the reason when it fails. */
export async function rpcLoad<T>(db: SupabaseClient, fn: string, args: Record<string, unknown>, fallback: T): Promise<Loaded<T>> {
  const r = await pm(db).rpc(fn, args);
  if (r.error) return { data: fallback, error: plain(r.error.message) };
  return { data: (r.data ?? fallback) as T, error: null };
}

async function tableLoad<T>(p: PromiseLike<{ data: unknown; error: { message?: string | null } | null }>): Promise<Loaded<T[]>> {
  const r = await p;
  if (r.error) return { data: [], error: plain(r.error.message) };
  return { data: (r.data ?? []) as T[], error: null };
}

export const loadCallLog = (db: SupabaseClient, companyId: string, limit = 200) =>
  tableLoad<CallLogRow>(pm(db).from('fs_call_log').select(CALL_LOG_COLS).eq('location_id', companyId).order('started_at', { ascending: false }).limit(limit));

export const loadPhoneProviders = (db: SupabaseClient, companyId: string) =>
  tableLoad<PhoneProviderRow>(pm(db).from('fs_phone_providers').select(PHONE_PROVIDER_COLS).eq('location_id', companyId));

export const loadThreads = (db: SupabaseClient, companyId: string, status: 'OPEN' | 'CLOSED' = 'OPEN', limit = 200) =>
  tableLoad<ThreadRow>(pm(db).from('fs_threads').select(THREAD_COLS).eq('location_id', companyId).eq('status', status)
    .order('last_message_at', { ascending: false }).limit(limit));

export const loadThreadMessages = (db: SupabaseClient, threadId: string) =>
  tableLoad<ThreadMessageRow>(pm(db).from('fs_thread_messages').select(THREAD_MESSAGE_COLS).eq('thread_id', threadId).order('created_at').limit(500));

export const loadMessageTemplates = (db: SupabaseClient, companyId: string) =>
  tableLoad<MessageTemplateRow>(pm(db).from('fs_message_templates').select(MESSAGE_TEMPLATE_COLS).eq('location_id', companyId).eq('is_active', true).order('label'));

export const loadFindings = (db: SupabaseClient, companyId: string) =>
  tableLoad<FindingRow>(pm(db).from('v_fs_integrity_findings_masked').select(FINDING_COLS).eq('location_id', companyId).in('status', ['OPEN', 'TASKED'])
    .order('last_seen_at', { ascending: false }).limit(300));

export const loadFormTemplates = (db: SupabaseClient, companyId: string) =>
  tableLoad<FormTemplateRow>(pm(db).from('fs_form_templates').select(FORM_TEMPLATE_COLS).eq('location_id', companyId).order('name'));

export const loadInstallItems = (db: SupabaseClient, projectId: string) =>
  tableLoad<InstallItemRow>(pm(db).from('v_fs_install_items_masked').select(INSTALL_ITEM_COLS).eq('project_id', projectId).order('sort'));

export async function loadPendingAcceptances(db: SupabaseClient, companyId: string): Promise<Loaded<Array<OnlineAcceptanceRow & { estimate_number: string | null; estimate_title: string | null; option_name: string | null }>>> {
  const acc = await tableLoad<OnlineAcceptanceRow>(pm(db).from('fs_online_acceptances').select(ONLINE_ACCEPTANCE_COLS).eq('location_id', companyId).eq('status', 'PENDING')
    .order('accepted_at', { ascending: false }).limit(100));
  if (acc.error || acc.data.length === 0) return { data: [], error: acc.error };
  const [est, opt] = await Promise.all([
    pm(db).from('fs_estimates').select('id, number, title').in('id', acc.data.map((a) => a.estimate_id)),
    pm(db).from('fs_estimate_options').select('id, name').in('id', acc.data.map((a) => a.option_id)),
  ]);
  const e = new Map(((est.data ?? []) as Array<{ id: string; number: string | null; title: string }>).map((x) => [x.id, x]));
  const o = new Map(((opt.data ?? []) as Array<{ id: string; name: string }>).map((x) => [x.id, x.name]));
  return {
    data: acc.data.map((a) => ({ ...a, estimate_number: e.get(a.estimate_id)?.number ?? null, estimate_title: e.get(a.estimate_id)?.title ?? null, option_name: o.get(a.option_id) ?? null })),
    error: null,
  };
}

/** Customer names for ids the caller can see (core.customers through RLS). */
export async function nameMap(db: SupabaseClient, table: 'customers' | 'employees', ids: ReadonlyArray<string | null | undefined>): Promise<Record<string, string>> {
  const list = [...new Set(ids.filter((x): x is string => !!x))].slice(0, 500);
  if (!list.length) return {};
  if (table === 'customers') {
    const r = await db.schema('core').from('customers').select('id, name').in('id', list);
    return Object.fromEntries(((r.data ?? []) as Array<{ id: string; name: string | null }>).map((c) => [c.id, c.name ?? 'Customer']));
  }
  const r = await db.schema('core').from('employees').select('id, first_name, last_name').in('id', list);
  return Object.fromEntries(((r.data ?? []) as Array<{ id: string; first_name: string | null; last_name: string | null }>)
    .map((e) => [e.id, [e.first_name, e.last_name].filter(Boolean).join(' ') || 'Team member']));
}

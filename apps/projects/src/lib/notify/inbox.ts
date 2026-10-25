import 'server-only';
/**
 * Inbox, preferences, devices and company notification settings — read and written AS THE USER
 * (the RLS client from route() / pages). core.notifications rows are the caller's own (RLS:
 * membership = caller); every write is a pm.notify_* definer RPC (1114).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { must } from '@/lib/api';
import type { Access } from '@/lib/access/types';
import { EVENT_INFO, INTERNAL_EVENTS, type InternalEvent, type RecipePersona } from './recipes';
import type {
  BellPayload, CompanyNotifySettings, HeldMessage, InboxFilter, InboxItem, InboxPage, MarkState, NotificationPrefs, PrefRuleRow, Severity,
} from './types';

const COLS = 'id, kind, event_type, source_app, severity, title, body, deep_link, job_id, subject_type, subject_id, item_count, delivery, read_at, done_at, created_at, updated_at, meta';

interface NoteRow {
  id: string; kind: string; event_type: string | null; source_app: string | null; severity: string; title: string; body: string | null;
  deep_link: string | null; job_id: string | null; subject_type: string | null; subject_id: string | null; item_count: number | null;
  delivery: string | null; read_at: string | null; done_at: string | null; created_at: string; updated_at: string | null; meta: Record<string, unknown> | null;
}

function toItem(r: NoteRow): InboxItem {
  const label = r.meta && typeof r.meta.job_label === 'string' ? r.meta.job_label : null;
  return {
    id: r.id,
    kind: r.kind,
    eventType: r.event_type,
    sourceApp: r.source_app === 'projects' || r.source_app === 'suite' ? r.source_app : 'books',
    severity: (['info', 'attention', 'critical'].includes(r.severity) ? r.severity : 'info') as Severity,
    title: r.title,
    body: r.body,
    deepLink: r.deep_link && r.deep_link.startsWith('/') && !r.deep_link.startsWith('//') ? r.deep_link : null,
    jobId: r.job_id,
    jobLabel: label,
    subjectType: r.subject_type,
    subjectId: r.subject_id,
    itemCount: Math.max(1, r.item_count ?? 1),
    delivery: r.delivery === 'digest' ? 'digest' : 'instant',
    readAt: r.read_at,
    doneAt: r.done_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at ?? r.created_at,
  };
}

const notes = (db: SupabaseClient) => db.schema('core').from('notifications');

async function countWhere(db: SupabaseClient, needsYou: boolean): Promise<number> {
  let qb = notes(db).select('id', { count: 'exact', head: true }).is('read_at', null).is('done_at', null);
  if (needsYou) qb = qb.in('severity', ['attention', 'critical']);
  const { count, error } = await qb;
  if (error) throw error;
  return count ?? 0;
}

/** The bell: unread count, how many need action, the latest rows. */
export async function bellPayload(db: SupabaseClient, limit = 12): Promise<BellPayload> {
  const [unread, needsYou, rows] = await Promise.all([
    countWhere(db, false),
    countWhere(db, true),
    notes(db).select(COLS).is('done_at', null).order('created_at', { ascending: false }).limit(limit),
  ]);
  const data = must(rows as { data: NoteRow[] | null; error: { code?: string; message?: string } | null }, 'load notifications') ?? [];
  return { unread, needsYou, items: data.map(toItem) };
}

export async function listInbox(db: SupabaseClient, o: { filter: InboxFilter; before?: string | null; limit?: number; jobId?: string | null }): Promise<InboxPage> {
  const limit = Math.min(Math.max(o.limit ?? 50, 1), 100);
  let qb = notes(db).select(COLS);
  if (o.filter === 'unread') qb = qb.is('read_at', null).is('done_at', null);
  else if (o.filter === 'done') qb = qb.not('done_at', 'is', null);
  else qb = qb.is('done_at', null);
  if (o.jobId) qb = qb.eq('job_id', o.jobId);
  if (o.before) qb = qb.lt('created_at', o.before);
  const [res, unread] = await Promise.all([qb.order('created_at', { ascending: false }).limit(limit + 1), countWhere(db, false)]);
  const rows = (must(res as { data: NoteRow[] | null; error: { code?: string; message?: string } | null }, 'load inbox') ?? []).map(toItem);
  const page = rows.slice(0, limit);
  return { items: page, nextBefore: rows.length > limit ? page[page.length - 1]?.createdAt ?? null : null, unread };
}

export async function markNotifications(db: SupabaseClient, ids: readonly string[], state: MarkState): Promise<number> {
  const n = must(await db.schema('pm').rpc('notify_mark', { p_ids: ids.length ? [...ids] : null, p_state: state }), 'update notifications');
  return typeof n === 'number' ? n : 0;
}

interface PrefsRow { digest: string | null; quiet_start: string | null; quiet_end: string | null; timezone: string | null; sms_phone: string | null; channels: string[] | null; muted_kinds: string[] | null }

export async function loadPrefs(db: SupabaseClient, access: Access): Promise<NotificationPrefs> {
  const core = db.schema('core');
  const [prefsRes, rulesRes, settingsRes, devicesRes] = await Promise.all([
    core.from('notification_prefs').select('digest, quiet_start, quiet_end, timezone, sms_phone, channels, muted_kinds').maybeSingle(),
    core.from('notification_pref_rules').select('event_type, channel, mode'),
    core.from('notification_settings').select('location_id, mandatory_events, sms_enabled'),
    core.from('push_devices').select('id', { count: 'exact', head: true }).is('revoked_at', null),
  ]);
  const p = must(prefsRes as { data: PrefsRow | null; error: { code?: string; message?: string } | null }, 'load notification settings');
  const rules = (must(rulesRes as { data: PrefRuleRow[] | null; error: { code?: string; message?: string } | null }, 'load notification rules') ?? [])
    .filter((r) => (INTERNAL_EVENTS as readonly string[]).includes(r.event_type));
  const settings = must(settingsRes as { data: Array<{ location_id: string | null; mandatory_events: string[] | null; sms_enabled: boolean }> | null; error: { code?: string; message?: string } | null }, 'load company settings') ?? [];
  const mine = new Set(Object.keys(access.byCompany));
  const relevant = settings.filter((s) => s.location_id === null || mine.has(s.location_id));
  let smsConsent: NotificationPrefs['smsConsent'] = null;
  if (p?.sms_phone) {
    const { data } = await core.from('sms_consents').select('status').eq('phone', p.sms_phone).maybeSingle();
    const st = (data as { status?: string } | null)?.status;
    smsConsent = st === 'opted_in' || st === 'opted_out' ? st : null;
  }
  const digest = p?.digest;
  return {
    persona: access.persona as RecipePersona,
    digest: digest === 'daily' || digest === 'weekly' || digest === 'off' ? digest : 'instant',
    quietStart: p?.quiet_start ?? null,
    quietEnd: p?.quiet_end ?? null,
    timezone: p?.timezone ?? null,
    smsPhone: p?.sms_phone ?? null,
    smsConsent,
    emailOn: p ? (p.channels ?? ['in_app', 'email']).includes('email') : true,
    muted: p?.muted_kinds ?? [],
    rules,
    mandatoryEvents: [...new Set([
      ...relevant.flatMap((s) => s.mandatory_events ?? []),
      ...INTERNAL_EVENTS.filter((e) => EVENT_INFO[e].mandatory),
    ])],
    pushDevices: devicesRes.count ?? 0,
    smsAvailable: relevant.some((s) => s.sms_enabled),
  };
}

export interface SavePrefsInput {
  rules: ReadonlyArray<{ event_type: InternalEvent; channel: PrefRuleRow['channel']; mode: PrefRuleRow['mode'] | null }>;
  digest: NotificationPrefs['digest'] | null;
  quietStart: string | null;
  quietEnd: string | null;
  timezone: string | null;
  smsPhone: string | null;
  smsConsent: boolean;
}

export async function savePrefs(db: SupabaseClient, i: SavePrefsInput): Promise<void> {
  must(await db.schema('pm').rpc('notify_save_prefs', {
    p_rules: i.rules, p_digest: i.digest, p_quiet_start: i.quietStart, p_quiet_end: i.quietEnd, p_timezone: i.timezone,
    p_sms_phone: i.smsPhone, p_sms_consent: i.smsConsent,
  }), 'save notification settings');
}

export async function registerDevice(db: SupabaseClient, i: { token: string; platform: 'ios' | 'android' | 'web'; deviceName: string | null; appVersion: string | null }): Promise<string> {
  return must(await db.schema('pm').rpc('notify_register_device', { p_token: i.token, p_platform: i.platform, p_device_name: i.deviceName, p_app_version: i.appVersion }), 'register this phone') as string;
}

export async function unregisterDevice(db: SupabaseClient, token: string): Promise<boolean> {
  return Boolean(must(await db.schema('pm').rpc('notify_unregister_device', { p_token: token }), 'unregister this phone'));
}

interface SettingsRow {
  location_id: string | null; customer_messages_live: boolean; live_at: string | null; live_by: string | null; sms_enabled: boolean; sms_from_number: string | null;
  mandatory_events: string[] | null; push_per_hour: number; sms_per_day: number; email_per_hour: number; customer_sms_per_day: number; lead_sla_minutes: number;
  quiet_start: string | null; quiet_end: string | null; timezone: string | null;
}

function toSettings(companyId: string, r: SettingsRow | undefined): CompanyNotifySettings {
  return {
    companyId,
    customerMessagesLive: r?.location_id === companyId ? r.customer_messages_live : false,
    liveAt: r?.location_id === companyId ? r.live_at : null,
    liveBy: r?.location_id === companyId ? r.live_by : null,
    smsEnabled: r?.sms_enabled ?? false,
    smsFromNumber: r?.sms_from_number ?? null,
    mandatoryEvents: r?.mandatory_events ?? [],
    pushPerHour: r?.push_per_hour ?? 6,
    smsPerDay: r?.sms_per_day ?? 3,
    emailPerHour: r?.email_per_hour ?? 12,
    customerSmsPerDay: r?.customer_sms_per_day ?? 2,
    leadSlaMinutes: r?.lead_sla_minutes ?? 60,
    quietStart: r?.quiet_start ?? null,
    quietEnd: r?.quiet_end ?? null,
    timezone: r?.timezone ?? null,
  };
}

const SETTINGS_COLS = 'location_id, customer_messages_live, live_at, live_by, sms_enabled, sms_from_number, mandatory_events, push_per_hour, sms_per_day, email_per_hour, customer_sms_per_day, lead_sla_minutes, quiet_start, quiet_end, timezone';

/** Effective settings per company (company row, else the org row, else defaults). Go-live is per company. */
export async function companySettings(db: SupabaseClient, companyIds: readonly string[]): Promise<CompanyNotifySettings[]> {
  const res = await db.schema('core').from('notification_settings').select(SETTINGS_COLS);
  const rows = must(res as { data: SettingsRow[] | null; error: { code?: string; message?: string } | null }, 'load company settings') ?? [];
  const org = rows.find((r) => r.location_id === null);
  return companyIds.map((id) => toSettings(id, rows.find((r) => r.location_id === id) ?? org));
}

export type SettingsPatch = Partial<{
  customer_messages_live: boolean; sms_enabled: boolean; mandatory_events: string[];
  push_per_hour: number; sms_per_day: number; email_per_hour: number; customer_sms_per_day: number; lead_sla_minutes: number;
  quiet_start: string | null; quiet_end: string | null; timezone: string | null;
}>;

export async function configureCompany(db: SupabaseClient, companyId: string, patch: SettingsPatch): Promise<CompanyNotifySettings> {
  const row = must(await db.schema('pm').rpc('notify_configure', { p_location: companyId, p_patch: patch }), 'save company settings') as SettingsRow;
  return toSettings(companyId, { ...row, location_id: companyId });
}

interface HeldRow { id: string; location_id: string | null; channel: string; event_type: string | null; to_address: string | null; subject: string | null; body: string | null; body_masked: boolean; status_reason: string | null; job_id: string | null; created_at: string }

/**
 * Held customer messages the caller may act on — through pm.notify_outbound_messages: rows of
 * companies where they hold projects.settings:configure; the text only with projects.contract_value
 * there (security review: no amounts past the reader's money access).
 */
export async function heldMessages(db: SupabaseClient, companyIds: readonly string[], limit = 200): Promise<HeldMessage[]> {
  const res = await db.schema('pm').rpc('notify_outbound_messages', { p_status: 'held', p_limit: limit });
  const rows = (must(res as { data: HeldRow[] | null; error: { code?: string; message?: string } | null }, 'load held messages') ?? [])
    .filter((r) => r.channel !== 'push' && (!companyIds.length || (r.location_id !== null && companyIds.includes(r.location_id))));
  return rows.map((r) => ({
    id: r.id, companyId: r.location_id, channel: r.channel === 'sms' ? 'sms' : 'email', eventType: r.event_type, toAddress: r.to_address ?? '',
    subject: r.subject, body: r.body, bodyMasked: r.body_masked, statusReason: r.status_reason, jobId: r.job_id, createdAt: r.created_at,
  }));
}

export type SenderAsk = { id: string; phone: string; status: 'pending' | 'verified' | 'revoked' };

/** Ask for a texting number (pending until the provider confirms it — lib/notify/worker.ts verifySender). */
export async function requestSender(db: SupabaseClient, companyId: string, phone: string): Promise<SenderAsk> {
  return must(await db.schema('pm').rpc('notify_request_sender', { p_location: companyId, p_phone: phone }), 'ask for the texting number') as SenderAsk;
}

export async function actOnHeld(db: SupabaseClient, ids: readonly string[], action: 'release' | 'discard'): Promise<number> {
  const n = must(await db.schema('pm').rpc('notify_held_action', { p_ids: [...ids], p_action: action }), action === 'release' ? 'release messages' : 'discard messages');
  return typeof n === 'number' ? n : 0;
}

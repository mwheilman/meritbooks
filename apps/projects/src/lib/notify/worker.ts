import 'server-only';
/**
 * The notification worker's database port and providers. THE ONLY place in lib/notify that reads
 * SUPABASE_SERVICE_ROLE_KEY: the worker has no signed-in user (it runs from the cron webhook and
 * the Twilio webhook), and every call it makes is one of the service-only 1114 core functions
 * (claim / result / digests / sweep / STOP) — never a table read or write of its own beyond the
 * organization names for email headers. Member-facing routes use the RLS client (lib/notify/inbox.ts).
 */
import { timingSafeEqual } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { resultArgs, runNotificationWorker, type ClaimedRow, type DigestRow, type WorkerPort, type WorkerSummary } from './dispatch';
import { resendSender } from './email';
import { expoSender } from './push';
import { checkTwilioNumber, twilioSender } from './sms';

let admin: SupabaseClient | null | undefined;

function workerClient(): SupabaseClient | null {
  if (admin !== undefined) return admin;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  admin = url && key ? createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }) : null;
  return admin;
}

/** Where links in emails and pushes point. */
export function appUrl(): string {
  const v = process.env.PROJECTS_APP_URL || process.env.NEXT_PUBLIC_APP_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3001');
  return v.replace(/\/+$/, '');
}

/** Bearer CRON_SECRET (Vercel Cron sends it); constant-time compare; false when unset. */
export function requireCronSecret(authorization: string | null): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || !authorization) return false;
  const given = Buffer.from(authorization.replace(/^Bearer\s+/i, ''));
  const want = Buffer.from(secret);
  return given.length === want.length && timingSafeEqual(given, want);
}

function corePort(db: SupabaseClient): WorkerPort {
  const core = db.schema('core');
  const call = async <T>(fn: string, args: Record<string, unknown>): Promise<T> => {
    const { data, error } = await core.rpc(fn, args);
    if (error) throw new Error(`core.${fn}: ${error.message}`);
    return data as T;
  };
  return {
    sweep: async (now) => (await call<number | null>('notify_sweep', { p_now: now.toISOString() })) ?? 0,
    claim: async (limit) => (await call<ClaimedRow[] | null>('notify_outbound_claim', { p_limit: limit })) ?? [],
    result: async (id, outcome) => {
      await call<null>('notify_outbound_result', resultArgs(id, outcome));
    },
    revokeToken: async (token, reason) => {
      await call<null>('notify_revoke_push_token', { p_token: token, p_reason: reason });
    },
    orgNames: async (ids) => {
      if (ids.length === 0) return new Map();
      const { data } = await core.from('organizations').select('id, name').in('id', [...ids]);
      return new Map(((data ?? []) as Array<{ id: string; name: string | null }>).map((o) => [o.id, o.name ?? 'Merit Projects']));
    },
    collectDigests: async (now) => (await call<DigestRow[] | null>('notify_digest_collect', { p_now: now.toISOString() })) ?? [],
    digestDone: async (id, ok, pid, err) => {
      await call<null>('notify_digest_done', { p_digest: id, p_ok: ok, p_provider_message_id: pid, p_error: err });
    },
  };
}

export type WorkerRun = { ok: true; summary: WorkerSummary } | { ok: false; reason: string };

export async function runWorkerOnce(): Promise<WorkerRun> {
  const db = workerClient();
  if (!db) return { ok: false, reason: 'The notification worker needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.' };
  const summary = await runNotificationWorker({ port: corePort(db), email: resendSender(), sms: twilioSender(), push: expoSender(), appUrl: appUrl() });
  return { ok: true, summary };
}

/** Inbound text → consent / STOP list (core.notify_inbound_sms). Returns the auto-reply. */
export async function handleInboundSms(from: string, to: string, body: string): Promise<{ action: string; reply: string | null } | null> {
  const db = workerClient();
  if (!db) return null;
  const { data, error } = await db.schema('core').rpc('notify_inbound_sms', { p_from: from, p_to: to, p_body: body });
  if (error) throw new Error(`core.notify_inbound_sms: ${error.message}`);
  const r = (data ?? {}) as { action?: string; reply?: string | null };
  return { action: r.action ?? 'ignored', reply: r.reply ?? null };
}

export type SenderVerdict = { status: 'verified' | 'pending' | 'refused'; reason: string | null };

/**
 * Verify a texting number a settings holder asked for (pm.notify_request_sender, as the user):
 * Twilio must confirm the number is provisioned to this tenant; only then does the service role
 * mark it verified (core.notify_verify_sender). Without credentials it stays pending.
 */
export async function verifySender(requestId: string, orgId: string, phone: string): Promise<SenderVerdict> {
  const check = await checkTwilioNumber(orgId, phone);
  if (check.status === 'unavailable') return { status: 'pending', reason: check.reason };
  const db = workerClient();
  if (!db) return { status: 'pending', reason: 'The server cannot record the verification yet (SUPABASE_SERVICE_ROLE_KEY).' };
  const ok = check.status === 'verified';
  const { error } = await db.schema('core').rpc('notify_verify_sender', {
    p_id: requestId, p_ok: ok, p_provider_sid: ok ? check.providerSid : null, p_note: ok ? 'confirmed with Twilio' : check.reason,
  });
  if (error) return { status: 'refused', reason: error.message.replace(/^PM_INVALID:\s*/, '') };
  return ok ? { status: 'verified', reason: null } : { status: 'refused', reason: check.reason };
}

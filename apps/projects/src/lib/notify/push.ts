/**
 * Push channel (PLT-45): Expo push service → APNs / FCM for the Merit Workforce app. OFF until
 * EXPO_ACCESS_TOKEN exists (the project's "enhanced push security" token). Server-side only.
 *
 * Expo answers one ticket per message, in order. "DeviceNotRegistered" means the app was
 * uninstalled or the token rotated — the worker revokes that token. Up to 100 messages per call.
 */
import type { SendOutcome } from './types';

export const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const CHUNK = 100;

export interface PushOut {
  tokens: readonly string[];
  title: string;
  body: string;
  /** Internal web path of the record ("/jobs/…"); the phone maps it to its own screen. */
  deepLink: string | null;
  data: Readonly<Record<string, unknown>>;
}

export interface ExpoMessage {
  to: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  sound: 'default';
  priority: 'high' | 'default';
  channelId: 'default';
}

export interface ExpoTicket {
  status: 'ok' | 'error';
  id?: string;
  message?: string;
  details?: { error?: string };
}

export interface PushResult {
  outcome: SendOutcome;
  /** Tokens Expo says are dead (revoke them). */
  deadTokens: string[];
}

export interface PushSender {
  readonly id: 'expo' | 'none';
  send(msg: PushOut): Promise<PushResult>;
}

export interface PushEnv {
  EXPO_ACCESS_TOKEN?: string;
}

export function pushConfig(env: PushEnv = process.env as PushEnv): { configured: boolean; reason: string | null } {
  return env.EXPO_ACCESS_TOKEN ? { configured: true, reason: null } : { configured: false, reason: 'Push is not set up (EXPO_ACCESS_TOKEN is not set).' };
}

export function isExpoToken(t: string): boolean {
  return /^Expo(nent)?PushToken\[[A-Za-z0-9_-]{8,200}\]$/.test(t);
}

/** One Expo message per live token. Title ≤ 120, body ≤ 240 (lock-screen length). */
export function buildExpoMessages(p: PushOut): ExpoMessage[] {
  const title = p.title.slice(0, 120);
  const body = p.body.slice(0, 240);
  return p.tokens.filter(isExpoToken).map((to) => ({
    to,
    title,
    body,
    data: { ...p.data, url: p.deepLink },
    sound: 'default',
    priority: 'high',
    channelId: 'default',
  }));
}

/** Fold Expo tickets into one outcome for the outbound row. */
export function foldTickets(messages: readonly ExpoMessage[], tickets: readonly ExpoTicket[]): PushResult {
  const dead: string[] = [];
  let firstId: string | null = null;
  let lastError = '';
  tickets.forEach((t, i) => {
    if (t.status === 'ok' && t.id) firstId ??= t.id;
    if (t.status === 'error') {
      lastError = t.message ?? t.details?.error ?? 'error';
      const to = messages[i]?.to;
      if (to && t.details?.error === 'DeviceNotRegistered') dead.push(to);
    }
  });
  if (firstId) return { outcome: { status: 'sent', provider: 'expo', providerMessageId: firstId }, deadTokens: dead };
  const allDead = dead.length > 0 && dead.length === messages.length;
  return {
    outcome: { status: 'failed', provider: 'expo', reason: allDead ? 'Every device for this person is unregistered.' : `Expo refused the push: ${lastError.slice(0, 300)}`, retry: !allDead },
    deadTokens: dead,
  };
}

export function expoSender(env: PushEnv = process.env as PushEnv, doFetch: typeof fetch = fetch): PushSender {
  const cfg = pushConfig(env);
  if (!cfg.configured) {
    return { id: 'none', send: async () => ({ outcome: { status: 'not_configured', reason: cfg.reason ?? 'Push is not set up.' }, deadTokens: [] }) };
  }
  const token = env.EXPO_ACCESS_TOKEN as string;
  return {
    id: 'expo',
    async send(p) {
      const messages = buildExpoMessages(p);
      if (messages.length === 0) return { outcome: { status: 'not_configured', reason: 'This person has no phone registered for push.' }, deadTokens: [] };
      const tickets: ExpoTicket[] = [];
      try {
        for (let i = 0; i < messages.length; i += CHUNK) {
          const chunk = messages.slice(i, i + CHUNK);
          const res = await doFetch(EXPO_PUSH_URL, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json', 'Accept-Encoding': 'gzip, deflate' },
            body: JSON.stringify(chunk),
          });
          const body = (await res.json().catch(() => ({}))) as { data?: ExpoTicket[]; errors?: Array<{ message?: string }> };
          if (!res.ok || !Array.isArray(body.data)) {
            const why = body.errors?.[0]?.message ?? `HTTP ${res.status}`;
            return { outcome: { status: 'failed', provider: 'expo', reason: `Expo refused the push: ${why.slice(0, 300)}`, retry: res.status === 429 || res.status >= 500 }, deadTokens: [] };
          }
          tickets.push(...body.data);
        }
      } catch (e) {
        return { outcome: { status: 'failed', provider: 'expo', reason: e instanceof Error ? e.message.slice(0, 300) : 'network error', retry: true }, deadTokens: [] };
      }
      return foldTickets(messages, tickets);
    },
  };
}

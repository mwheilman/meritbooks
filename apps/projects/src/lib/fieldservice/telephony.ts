/**
 * Telephony provider adapters (FS-05): RingCentral, Dialpad and Twilio Voice. Each adapter is OFF
 * until its credentials are in the server environment; a webhook from a provider that is not
 * configured is refused. The adapters only verify the provider's signature and normalize its call
 * event into one shape (VoiceEvent) that public.fs_voice_event (migration 1123) records — idempotent
 * per provider call id, matched to the customer and the tracking-number campaign in the database.
 *
 * Pure apart from node:crypto (unit-tested with recorded payload shapes).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

import type { VoiceProvider } from './telephony-labels';
export { VOICE_PROVIDERS, PROVIDER_LABEL, type VoiceProvider } from './telephony-labels';

export type CallOutcome = 'IN_PROGRESS' | 'ANSWERED' | 'MISSED' | 'VOICEMAIL' | 'ABANDONED' | 'BUSY' | 'FAILED';

/** The one shape public.fs_voice_event reads. Phone numbers raw (the database normalizes to E.164). */
export interface VoiceEvent {
  call_id: string;
  direction: 'INBOUND' | 'OUTBOUND';
  from: string | null;
  to: string | null;
  started_at: string | null;
  answered_at: string | null;
  ended_at: string | null;
  duration_seconds: number | null;
  outcome: CallOutcome;
  agent_name: string | null;
  recording_ref: string | null;
  recording_seconds: number | null;
  /** When the provider produced this event; the database applies an older event's outcome never over a newer one. */
  event_at: string | null;
}

export interface VoiceEnv {
  RINGCENTRAL_CLIENT_ID?: string;
  RINGCENTRAL_CLIENT_SECRET?: string;
  RINGCENTRAL_JWT?: string;
  RINGCENTRAL_WEBHOOK_TOKEN?: string;
  DIALPAD_API_KEY?: string;
  DIALPAD_WEBHOOK_SECRET?: string;
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  /** ISO time until which RingCentral's subscription handshake (Validation-Token) is answered. Set it
   *  only while creating the webhook subscription (a few minutes); unset, the handshake is refused. */
  RINGCENTRAL_SUBSCRIPTION_SETUP_UNTIL?: string;
}

/** Dialpad tokens must be fresh: issued at most this long ago (and not expired). */
export const DIALPAD_MAX_AGE_SECONDS = 300;

/** Which variables each provider needs before it can be switched on (listed in the settings screen). */
export const PROVIDER_ENV: Readonly<Record<VoiceProvider, readonly (keyof VoiceEnv)[]>> = {
  RINGCENTRAL: ['RINGCENTRAL_CLIENT_ID', 'RINGCENTRAL_CLIENT_SECRET', 'RINGCENTRAL_JWT', 'RINGCENTRAL_WEBHOOK_TOKEN'],
  DIALPAD: ['DIALPAD_API_KEY', 'DIALPAD_WEBHOOK_SECRET'],
  TWILIO_VOICE: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'],
};


export function providerFromSlug(slug: string | null | undefined): VoiceProvider | null {
  switch ((slug ?? '').toLowerCase()) {
    case 'ringcentral': return 'RINGCENTRAL';
    case 'dialpad': return 'DIALPAD';
    case 'twilio': case 'twilio-voice': case 'twilio_voice': return 'TWILIO_VOICE';
    default: return null;
  }
}

export function voiceConfig(p: VoiceProvider, env: VoiceEnv = process.env as VoiceEnv): { configured: boolean; missing: string[] } {
  const missing = PROVIDER_ENV[p].filter((k) => !env[k]);
  return { configured: missing.length === 0, missing: [...missing] };
}

function safeEq(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const b64url = (buf: Buffer): string => buf.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

/**
 * Dialpad signs webhook bodies as an HS256 JWT with the webhook secret. Returns the payload or null.
 * Replay window (security review L): the token must carry iat or exp; iat no more than 5 minutes old
 * (or ahead), exp not passed and no more than 5 minutes ahead.
 */
export function verifyDialpadJwt(token: string, secret: string | undefined, now: Date = new Date()): Record<string, unknown> | null {
  if (!secret) return null;
  const parts = token.trim().split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts as [string, string, string];
  try {
    const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8')) as { alg?: string };
    if (header.alg !== 'HS256') return null;
    const want = b64url(createHmac('sha256', secret).update(`${h}.${p}`).digest());
    if (!safeEq(want, s)) return null;
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as unknown;
    if (!payload || typeof payload !== 'object') return null;
    const claims = payload as Record<string, unknown>;
    const t = Math.floor(now.getTime() / 1000);
    const iat = typeof claims.iat === 'number' ? claims.iat : null;
    const exp = typeof claims.exp === 'number' ? claims.exp : null;
    if (iat == null && exp == null) return null;
    if (iat != null && Math.abs(t - iat) > DIALPAD_MAX_AGE_SECONDS) return null;
    if (exp != null && (exp < t || exp - t > DIALPAD_MAX_AGE_SECONDS)) return null;
    return claims;
  } catch {
    return null;
  }
}

/** The subscription handshake is answered only inside the setup window (RINGCENTRAL_SUBSCRIPTION_SETUP_UNTIL). */
export function ringCentralSetupOpen(env: VoiceEnv = process.env as VoiceEnv, now: Date = new Date()): boolean {
  const until = env.RINGCENTRAL_SUBSCRIPTION_SETUP_UNTIL ? Date.parse(env.RINGCENTRAL_SUBSCRIPTION_SETUP_UNTIL) : NaN;
  return Number.isFinite(until) && now.getTime() <= until && until - now.getTime() <= 60 * 60_000;
}

/** RingCentral webhooks carry the verification token chosen at subscription time. */
export function verifyRingCentral(header: string | null, env: VoiceEnv = process.env as VoiceEnv): boolean {
  return !!env.RINGCENTRAL_WEBHOOK_TOKEN && !!header && safeEq(header, env.RINGCENTRAL_WEBHOOK_TOKEN);
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : typeof v === 'number' ? String(v) : null);
const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
};
const iso = (v: unknown): string | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v > 1e12 ? v : v * 1000).toISOString();
  if (typeof v === 'string' && v.trim() !== '') {
    if (/^\d+$/.test(v.trim())) return iso(Number(v.trim()));
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
};
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/**
 * RingCentral telephony-session notification (/restapi/v1.0/account/~/telephony/sessions):
 * body.telephonySessionId, body.parties[0].{direction, from.phoneNumber, to.phoneNumber, status.code, missedCall}.
 */
export function normalizeRingCentral(raw: unknown): VoiceEvent | null {
  const body = obj(obj(raw).body);
  const id = str(body.telephonySessionId) ?? str(body.sessionId);
  const party = obj(Array.isArray(body.parties) ? body.parties[0] : undefined);
  if (!id) return null;
  const status = obj(party.status);
  const code = (str(status.code) ?? '').toLowerCase();
  const missed = party.missedCall === true;
  const outcome: CallOutcome = code === 'voicemail' ? 'VOICEMAIL'
    : code === 'answered' ? 'ANSWERED'
    : code === 'disconnected' ? (missed ? 'MISSED' : 'ANSWERED')
    : code === 'gone' ? 'ABANDONED'
    : 'IN_PROGRESS';
  const at = iso(obj(raw).timestamp) ?? iso(body.eventTime);
  return {
    call_id: id,
    direction: (str(party.direction) ?? 'Inbound').toLowerCase().startsWith('out') ? 'OUTBOUND' : 'INBOUND',
    from: str(obj(party.from).phoneNumber),
    to: str(obj(party.to).phoneNumber),
    started_at: code === 'setup' || code === 'proceeding' ? at : null,
    answered_at: code === 'answered' ? at : null,
    ended_at: code === 'disconnected' || code === 'voicemail' || code === 'gone' ? at : null,
    duration_seconds: null,
    outcome,
    agent_name: str(obj(party.owner).name) ?? null,
    recording_ref: str(obj(Array.isArray(party.recordings) ? party.recordings[0] : undefined).id),
    recording_seconds: null,
    event_at: at,
  };
}

/** Dialpad call event (decoded JWT): call_id, direction, external_number, internal_number, state, date_*. */
export function normalizeDialpad(raw: unknown): VoiceEvent | null {
  const p = obj(raw);
  const id = str(p.call_id);
  if (!id) return null;
  const state = (str(p.state) ?? '').toLowerCase();
  const out = (str(p.direction) ?? 'inbound').toLowerCase() === 'outbound';
  const ext = str(p.external_number);
  const int = str(p.internal_number);
  const outcome: CallOutcome = state === 'missed' ? 'MISSED' : state === 'voicemail' ? 'VOICEMAIL' : state === 'abandoned' ? 'ABANDONED'
    : state === 'connected' || state === 'hangup' ? 'ANSWERED' : 'IN_PROGRESS';
  const durationMs = num(p.duration);
  const rec = Array.isArray(p.recording_url) ? str(p.recording_url[0]) : str(p.recording_url);
  return {
    call_id: id,
    direction: out ? 'OUTBOUND' : 'INBOUND',
    from: out ? int : ext,
    to: out ? ext : int,
    started_at: iso(p.date_started),
    answered_at: iso(p.date_connected),
    ended_at: iso(p.date_ended),
    duration_seconds: durationMs == null ? null : Math.round(durationMs / 1000),
    outcome: state === 'hangup' && !p.date_connected ? 'MISSED' : outcome,
    agent_name: str(obj(p.target).name),
    recording_ref: rec,
    recording_seconds: null,
    event_at: iso(p.iat) ?? iso(p.date_ended) ?? iso(p.date_connected) ?? iso(p.date_started),
  };
}

/** Twilio Voice status callback (form fields): CallSid, Direction, From, To, CallStatus, CallDuration, Recording*. */
export function normalizeTwilio(params: Readonly<Record<string, string>>): VoiceEvent | null {
  const id = str(params.CallSid);
  if (!id) return null;
  const st = (params.CallStatus ?? '').toLowerCase();
  const outcome: CallOutcome = st === 'completed' ? (num(params.CallDuration) ? 'ANSWERED' : 'MISSED')
    : st === 'in-progress' ? 'ANSWERED' : st === 'busy' ? 'BUSY' : st === 'no-answer' ? 'MISSED' : st === 'failed' ? 'FAILED'
    : st === 'canceled' ? 'ABANDONED' : 'IN_PROGRESS';
  const at = iso(params.Timestamp) ?? new Date().toISOString();
  return {
    call_id: id,
    direction: (params.Direction ?? 'inbound').toLowerCase().startsWith('outbound') ? 'OUTBOUND' : 'INBOUND',
    from: str(params.From),
    to: str(params.To),
    started_at: st === 'ringing' || st === 'queued' || st === 'initiated' ? at : null,
    answered_at: st === 'in-progress' ? at : null,
    ended_at: ['completed', 'busy', 'no-answer', 'failed', 'canceled'].includes(st) ? at : null,
    duration_seconds: num(params.CallDuration),
    outcome,
    agent_name: null,
    recording_ref: str(params.RecordingSid) ?? str(params.RecordingUrl),
    recording_seconds: num(params.RecordingDuration),
    event_at: iso(params.Timestamp),
  };
}

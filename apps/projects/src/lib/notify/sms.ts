/**
 * SMS channel (PLT-44) behind a provider interface. The one adapter today is Twilio-shaped and
 * stays OFF until TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN exist. Every text goes From the tenant's
 * own VERIFIED number (core.sms_sender_numbers → notification_settings.sms_from_number) — never a
 * shared Messaging Service pool or a global fallback number, so a STOP reply always lands on the
 * tenant that sent the text (security re-review). No verified number → the text is refused.
 * A2P 10DLC registration happens in Twilio, outside the app. Consent, STOP / START / HELP, quiet hours and caps are enforced in the database
 * (1114); this file only sends, parses keywords (mirror of core.notify_inbound_sms) and checks
 * Twilio's webhook signature. Server-side (uses node:crypto).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { SendOutcome } from './types';

export interface SmsOut {
  to: string;
  body: string;
  /** The tenant's verified number (core.notification_settings.sms_from_number); required. */
  from: string | null;
}

export interface SmsSender {
  readonly id: 'twilio' | 'none';
  send(msg: SmsOut): Promise<SendOutcome>;
}

export interface SmsEnv {
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_STATUS_CALLBACK_URL?: string;
}

export function smsConfig(env: SmsEnv = process.env as SmsEnv): { configured: boolean; reason: string | null } {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) {
    return { configured: false, reason: 'Texting is not set up (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN are not set).' };
  }
  return { configured: true, reason: null };
}

/** Twilio errors that will never succeed on retry (bad / unsubscribed / landline numbers). */
const PERMANENT = new Set([21211, 21408, 21610, 21612, 21614, 30003, 30004, 30005, 30006, 30007]);

export function twilioSender(env: SmsEnv = process.env as SmsEnv, doFetch: typeof fetch = fetch): SmsSender {
  const cfg = smsConfig(env);
  if (!cfg.configured) return { id: 'none', send: async () => ({ status: 'not_configured', reason: cfg.reason ?? 'Texting is not set up.' }) };
  const sid = env.TWILIO_ACCOUNT_SID as string;
  const auth = Buffer.from(`${sid}:${env.TWILIO_AUTH_TOKEN as string}`).toString('base64');
  return {
    id: 'twilio',
    async send(msg) {
      const form = new URLSearchParams({ To: msg.to, Body: msg.body.slice(0, 640) });
      // From = the tenant's verified number, always; no shared pool, no fallback
      const from = toE164(msg.from);
      if (!from) return { status: 'failed', provider: 'twilio', reason: 'This company has no verified texting number, so the text was not sent.', retry: false };
      form.set('From', from);
      if (env.TWILIO_STATUS_CALLBACK_URL) form.set('StatusCallback', env.TWILIO_STATUS_CALLBACK_URL);
      try {
        const res = await doFetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
          method: 'POST',
          headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: form.toString(),
        });
        const body = (await res.json().catch(() => ({}))) as { sid?: string; code?: number; message?: string };
        if (!res.ok) {
          const permanent = typeof body.code === 'number' && PERMANENT.has(body.code);
          return { status: 'failed', provider: 'twilio', reason: `Twilio refused the text (${res.status}${body.code ? ` / ${body.code}` : ''}): ${(body.message ?? '').slice(0, 300)}`, retry: !permanent && (res.status === 429 || res.status >= 500) };
        }
        if (!body.sid) return { status: 'failed', provider: 'twilio', reason: 'Twilio answered without a message id.', retry: true };
        return { status: 'sent', provider: 'twilio', providerMessageId: body.sid };
      } catch (e) {
        return { status: 'failed', provider: 'twilio', reason: e instanceof Error ? e.message.slice(0, 300) : 'network error', retry: true };
      }
    },
  };
}

export type SmsKeyword = 'opt_out' | 'opt_in' | 'help' | 'message';

/** Same words as core.notify_inbound_sms (CTIA / carrier standard). */
export function parseSmsKeyword(body: string | null | undefined): SmsKeyword {
  const word = (body ?? '').trim().split(/\s+/)[0]?.toUpperCase().replace(/[^A-Z]/g, '') ?? '';
  if (['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'REVOKE', 'OPTOUT'].includes(word)) return 'opt_out';
  if (['START', 'UNSTOP', 'YES', 'SUBSCRIBE'].includes(word)) return 'opt_in';
  if (['HELP', 'INFO'].includes(word)) return 'help';
  return 'message';
}

/** E.164 or null (10-digit North American numbers get +1). Mirror of core.notify_e164. */
export function toE164(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const plus = phone.replace(/[^0-9+]/g, '');
  if (/^\+[1-9][0-9]{7,14}$/.test(plus)) return plus;
  const d = phone.replace(/[^0-9]/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  return null;
}

/**
 * Twilio request validation: base64(HMAC-SHA1(authToken, url + each POST param name+value in
 * name order)) must equal X-Twilio-Signature.
 */
export function twilioSignature(authToken: string, url: string, params: Readonly<Record<string, string>>): string {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  return createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
}

export function verifyTwilioSignature(authToken: string | undefined, url: string, params: Readonly<Record<string, string>>, signature: string | null): boolean {
  if (!authToken || !signature) return false;
  const expected = Buffer.from(twilioSignature(authToken, url, params));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** TwiML for an auto-reply (or an empty response). */
export function twiml(reply: string | null): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return reply ? `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${esc(reply)}</Message></Response>` : '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
}

export type NumberCheck =
  | { status: 'verified'; providerSid: string }
  | { status: 'refused'; reason: string }
  | { status: 'unavailable'; reason: string };

/**
 * Texting-number verification (security review M): the number must be an IncomingPhoneNumber in
 * Merit's Twilio account AND tagged for this tenant — its FriendlyName contains `merit-org:<orgId>`
 * (Merit ops sets the tag when it provisions the number to the tenant). Anything else is refused;
 * without Twilio credentials the request stays pending. Only the server's verdict is recorded
 * (core.notify_verify_sender, service role).
 */
export async function checkTwilioNumber(orgId: string, phone: string, env: SmsEnv = process.env as SmsEnv, doFetch: typeof fetch = fetch): Promise<NumberCheck> {
  const cfg = smsConfig(env);
  if (!cfg.configured) return { status: 'unavailable', reason: cfg.reason ?? 'Texting is not set up.' };
  const sid = env.TWILIO_ACCOUNT_SID as string;
  const auth = Buffer.from(`${sid}:${env.TWILIO_AUTH_TOKEN as string}`).toString('base64');
  try {
    const res = await doFetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(phone)}`, {
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
    });
    if (!res.ok) return { status: 'unavailable', reason: `Twilio did not answer (${res.status}). The number stays pending.` };
    const body = (await res.json().catch(() => ({}))) as { incoming_phone_numbers?: Array<{ sid?: string; phone_number?: string; friendly_name?: string }> };
    const hit = (body.incoming_phone_numbers ?? []).find((n) => n.phone_number === phone);
    if (!hit?.sid) return { status: 'refused', reason: 'That number is not in the Merit Twilio account. Ask Merit to provision it for you.' };
    if (!(hit.friendly_name ?? '').includes(`merit-org:${orgId}`)) return { status: 'refused', reason: 'That number is provisioned to a different workspace.' };
    return { status: 'verified', providerSid: hit.sid };
  } catch (e) {
    return { status: 'unavailable', reason: e instanceof Error ? e.message.slice(0, 200) : 'Twilio did not answer.' };
  }
}

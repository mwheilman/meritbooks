/**
 * Email channel — the same provider and sender Merit Books uses (Books lib/email/provider.ts:
 * Resend, RESEND_API_KEY, From = INVOICE_FROM_EMAIL), ported here because apps/projects cannot
 * import Books app code. Same posture: header-safe values, an explicit outcome, never "sent"
 * without a provider message id. NOTIFY_FROM_EMAIL overrides the From for notifications only.
 */
import type { SendOutcome } from './types';

export interface EmailOut {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
}

export interface EmailSender {
  readonly id: 'resend' | 'none';
  send(msg: EmailOut): Promise<SendOutcome>;
}

/** One-line header value: control characters become spaces (no header injection). */
export function headerSafe(value: string, max = 998): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, max);
}

export interface EmailEnv {
  RESEND_API_KEY?: string;
  INVOICE_FROM_EMAIL?: string;
  NOTIFY_FROM_EMAIL?: string;
}

export function emailConfig(env: EmailEnv = process.env as EmailEnv): { configured: boolean; from: string | null; reason: string | null } {
  const from = env.NOTIFY_FROM_EMAIL || env.INVOICE_FROM_EMAIL || null;
  if (!env.RESEND_API_KEY) return { configured: false, from, reason: 'Email is not set up (RESEND_API_KEY is not set).' };
  if (!from) return { configured: false, from, reason: 'No sending address is set (NOTIFY_FROM_EMAIL or INVOICE_FROM_EMAIL).' };
  return { configured: true, from, reason: null };
}

export function resendSender(env: EmailEnv = process.env as EmailEnv, doFetch: typeof fetch = fetch): EmailSender {
  const cfg = emailConfig(env);
  if (!cfg.configured || !cfg.from) {
    return { id: 'none', send: async () => ({ status: 'not_configured', reason: cfg.reason ?? 'Email is not set up.' }) };
  }
  const key = env.RESEND_API_KEY as string;
  const from = cfg.from;
  return {
    id: 'resend',
    async send(msg) {
      try {
        const res = await doFetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: headerSafe(from, 400),
            to: [headerSafe(msg.to, 320)],
            subject: headerSafe(msg.subject),
            html: msg.html,
            text: msg.text,
            reply_to: msg.replyTo ? headerSafe(msg.replyTo, 320) : undefined,
          }),
        });
        if (!res.ok) {
          const detail = await res.text().catch(() => '');
          // 4xx (bad address, unverified domain) will not fix itself; 429 / 5xx retry
          return { status: 'failed', provider: 'resend', reason: `Resend refused the message (${res.status}): ${detail.slice(0, 300)}`, retry: res.status === 429 || res.status >= 500 };
        }
        const body = (await res.json().catch(() => ({}))) as { id?: string };
        if (!body.id) return { status: 'failed', provider: 'resend', reason: 'Resend answered without a message id.', retry: true };
        return { status: 'sent', provider: 'resend', providerMessageId: body.id };
      } catch (e) {
        return { status: 'failed', provider: 'resend', reason: e instanceof Error ? e.message.slice(0, 300) : 'network error', retry: true };
      }
    },
  };
}

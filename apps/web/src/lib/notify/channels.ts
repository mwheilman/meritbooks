/**
 * Outbound channels for the request engine (FPB-request-engine-notifications §4).
 *
 * Every adapter returns an explicit outcome and never reports success it can't prove:
 *   sent            the provider accepted it and gave us an id
 *   not_configured  the channel isn't set up (no key / no provider chosen) — recorded as
 *                   "skipped", never as "sent"
 *   failed          the provider refused or errored — the engine frees the step and retries
 *
 * Email rides the existing Resend provider (lib/email/provider.ts). SMS and push are
 * interfaces only: no provider is chosen yet (owner decision D2, Twilio-class + 10DLC).
 */

import { EmailSendError, resolveEmailProvider, resolveFromAddress, type EmailProvider } from '@/lib/email/provider';

export type ChannelOutcome =
  | { status: 'sent'; provider: string; providerMessageId: string }
  | { status: 'not_configured'; reason: string }
  | { status: 'failed'; reason: string; provider?: string };

export interface EmailOut {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
}

export interface EmailChannel {
  readonly id: 'email';
  send(msg: EmailOut): Promise<ChannelOutcome>;
}

export interface SmsOut {
  to: string;
  body: string;
}

export interface SmsChannel {
  readonly id: 'sms';
  send(msg: SmsOut): Promise<ChannelOutcome>;
}

export interface PushOut {
  membershipId: string;
  title: string;
  body: string;
  deepLink: string | null;
}

export interface PushChannel {
  readonly id: 'push';
  send(msg: PushOut): Promise<ChannelOutcome>;
}

export interface Channels {
  email: EmailChannel;
  sms: SmsChannel;
  push: PushChannel;
}

/** Email through the configured provider (Resend today). Injectable for tests. */
export function emailChannel(provider: EmailProvider | null = resolveEmailProvider(), from: string | null = resolveFromAddress()): EmailChannel {
  return {
    id: 'email',
    async send(msg) {
      if (!provider) return { status: 'not_configured', reason: 'Email is not configured (RESEND_API_KEY is not set).' };
      if (!from) return { status: 'not_configured', reason: 'No sending address is configured (INVOICE_FROM_EMAIL is not set).' };
      try {
        const res = await provider.send({ to: [msg.to], subject: msg.subject, html: msg.html, text: msg.text, replyTo: msg.replyTo }, from);
        return { status: 'sent', provider: res.provider, providerMessageId: res.id };
      } catch (e) {
        const reason = e instanceof EmailSendError || e instanceof Error ? e.message : String(e);
        return { status: 'failed', reason: reason.slice(0, 500), provider: provider.id };
      }
    },
  };
}

/** SMS adapter seam. No provider yet → always "not configured" (never "sent"). */
export function smsChannel(): SmsChannel {
  return {
    id: 'sms',
    async send() {
      return { status: 'not_configured', reason: 'Text messages are not set up yet (no SMS provider chosen).' };
    },
  };
}

/** Push adapter seam (Merit Workforce PWA, Wave 5B). */
export function pushChannel(): PushChannel {
  return {
    id: 'push',
    async send() {
      return { status: 'not_configured', reason: 'Push notifications are not set up yet (Merit Workforce app).' };
    },
  };
}

export function defaultChannels(): Channels {
  return { email: emailChannel(), sms: smsChannel(), push: pushChannel() };
}

/** Absolute origin for links in outbound messages (same env + fallback as invitations). */
export function outboundAppUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL ?? 'https://meritbooks-web.vercel.app').replace(/\/$/, '');
}

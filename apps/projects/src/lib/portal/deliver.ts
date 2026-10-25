import 'server-only';
/**
 * Dispatch-time delivery of portal secrets (sign-in link + code, phone codes). The database (the
 * notifications service, 1114) has already decided the message may go — company live, consent,
 * STOP list — and stored the audit row with a fixed sentence and NO secret; this sends the real
 * text straight to the provider (the same Resend / Twilio adapters the worker uses) and reports
 * the outcome (portal.dispatch_result). The secret never touches the database or a log.
 */
import { buildNotificationEmail } from '@/lib/notify/digest';
import { resendSender, type EmailSender } from '@/lib/notify/email';
import { twilioSender, type SmsSender } from '@/lib/notify/sms';
import type { SendOutcome } from '@/lib/notify/types';
import { portalBaseUrl, portalServerKey } from './config';
import { portalRpc } from './db';

export interface Dispatch {
  outbound_id: string;
  channel: 'email' | 'sms';
  to: string;
  from: string | null;
  subject: string | null;
  company: string | null;
  locale: 'en' | 'es';
}

export interface DeliveryPorts { email: EmailSender; sms: SmsSender }
let ports: DeliveryPorts | null = null;
export function setDeliveryPorts(p: DeliveryPorts | null): void {
  ports = p;
}
const senders = (): DeliveryPorts => ports ?? { email: resendSender(), sms: twilioSender() };

/** The sign-in message (pure; unit-tested). */
export function signInText(d: Pick<Dispatch, 'locale' | 'company'>, code: string, url: string): string {
  return d.locale === 'es'
    ? `${d.company ? `${d.company}: ` : ''}su código es ${code}. O abra este enlace en el mismo dispositivo: ${url} (vence en 20 minutos). Si no lo pidió, ignore este mensaje.`
    : `${d.company ? `${d.company}: ` : ''}your code is ${code}. Or open this link on the same device: ${url} (expires in 20 minutes). If you didn't ask for it, ignore this message.`;
}

export function phoneCodeText(d: Pick<Dispatch, 'locale' | 'company'>, code: string): string {
  return d.locale === 'es'
    ? `${d.company ? `${d.company}: ` : ''}su código de verificación es ${code} (vence en 10 minutos).`
    : `${d.company ? `${d.company}: ` : ''}your verification code is ${code} (expires in 10 minutes).`;
}

export async function deliverSecret(d: Dispatch, text: string): Promise<SendOutcome> {
  const s = senders();
  let out: SendOutcome;
  if (d.channel === 'email') {
    const subject = d.subject ?? (d.locale === 'es' ? 'Su código para entrar' : 'Your sign-in code');
    const mail = buildNotificationEmail({ tenantName: d.company ?? 'Merit Projects', title: subject, body: text, deepLink: null, appUrl: portalBaseUrl() });
    out = await s.email.send({ to: d.to, subject, html: mail.html, text });
  } else {
    out = await s.sms.send({ to: d.to, body: text, from: d.from });
  }
  const key = portalServerKey();
  if (key) {
    await portalRpc('dispatch_result', {
      p_server_key: key, p_outbound: d.outbound_id, p_ok: out.status === 'sent',
      p_provider: out.status === 'not_configured' ? null : out.provider,
      p_provider_message_id: out.status === 'sent' ? out.providerMessageId : null,
      p_error: out.status === 'sent' ? null : out.reason,
    }).catch((e: unknown) => console.error('[portal] dispatch_result failed', e));
  }
  return out;
}

import 'server-only';
/**
 * Sends a signer their one-time link by email and / or text, through the same providers the
 * notifications module uses (lib/notify: Resend, Twilio). When a channel is not set up, or the
 * sender chose "link", the outcome is 'manual' and the link goes back to the sender to share.
 */
import { headerSafe, resendSender, type EmailSender } from '@/lib/notify/email';
import { twilioSender, type SmsSender } from '@/lib/notify/sms';

export interface DeliveryInput {
  name: string;
  email: string | null;
  phone: string | null;
  channel: 'email' | 'sms' | 'both' | 'link';
  link: string;
  title: string;
  message: string | null;
  companyName: string;
  expiresAt: string;
  resend: boolean;
}

export interface DeliveryOutcome {
  email: 'sent' | 'failed' | 'not_configured' | 'skipped';
  sms: 'sent' | 'failed' | 'not_configured' | 'skipped';
  /** The sender must share the link themselves (nothing was delivered). */
  manual: boolean;
  detail: string | null;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

function expiresWords(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

export function signingEmail(i: DeliveryInput): { subject: string; html: string; text: string } {
  const subject = headerSafe(`${i.resend ? 'Reminder: ' : ''}${i.companyName} sent you "${i.title}" to sign`);
  const lines = [
    `Hello ${i.name},`,
    `${i.companyName} sent you "${i.title}" to review and sign.`,
    ...(i.message ? [i.message] : []),
    `Review and sign: ${i.link}`,
    `This link is for you only and works once. It expires ${expiresWords(i.expiresAt)}.`,
  ];
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:20px;color:#0A1628;max-width:560px">
<p>Hello ${esc(i.name)},</p>
<p><b>${esc(i.companyName)}</b> sent you <b>${esc(i.title)}</b> to review and sign.</p>
${i.message ? `<p style="border-left:3px solid #2563EB;padding-left:12px">${esc(i.message)}</p>` : ''}
<p><a href="${esc(i.link)}" style="display:inline-block;background:#2563EB;color:#FFFFFF;padding:10px 18px;text-decoration:none;font-weight:bold">Review and sign</a></p>
<p style="color:#3D4F65;font-size:12px">This link is for you only and works once. It expires ${esc(expiresWords(i.expiresAt))}. If you were not expecting this, ignore it.</p>
</div>`;
  return { subject, html, text: lines.join('\n\n') };
}

export function signingSms(i: DeliveryInput): string {
  return `${i.companyName}: "${i.title}" is ready for your signature. ${i.link} (one-time link, expires ${expiresWords(i.expiresAt)})`;
}

export async function deliverLink(i: DeliveryInput, providers: { email?: EmailSender; sms?: SmsSender } = {}): Promise<DeliveryOutcome> {
  const out: DeliveryOutcome = { email: 'skipped', sms: 'skipped', manual: false, detail: null };
  const notes: string[] = [];
  if ((i.channel === 'email' || i.channel === 'both') && i.email) {
    const r = await (providers.email ?? resendSender()).send({ to: i.email, ...signingEmail(i) });
    out.email = r.status === 'sent' ? 'sent' : r.status === 'not_configured' ? 'not_configured' : 'failed';
    if (r.status !== 'sent') notes.push(r.reason);
  }
  if ((i.channel === 'sms' || i.channel === 'both') && i.phone) {
    const r = await (providers.sms ?? twilioSender()).send({ to: i.phone, body: signingSms(i), from: null });
    out.sms = r.status === 'sent' ? 'sent' : r.status === 'not_configured' ? 'not_configured' : 'failed';
    if (r.status !== 'sent') notes.push(r.reason);
  }
  out.manual = out.email !== 'sent' && out.sms !== 'sent';
  out.detail = notes.length ? notes.join(' ') : null;
  return out;
}

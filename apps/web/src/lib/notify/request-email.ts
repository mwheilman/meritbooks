/**
 * The request email — Merit Suite style v2.3 in an email client's terms: Midnight head
 * band carrying the ASKING client's name (white-label: never a hard-coded Merit entity),
 * Warm White body, one Electric button, square geometry, thin blue rule, DM Sans with a
 * system fallback, a plain-text twin, and an unsubscribe line. Pure (string in, string
 * out) so the payload is unit-testable.
 */

import { KIND_LABEL, type RequestKind } from '@/lib/requests/types';
import type { EmailBrand } from '@/lib/branding/email';

const MIDNIGHT = '#0A1628';
const ELECTRIC = '#2563EB';
const WARM = '#FDFCFA';
const STEEL = '#3D4F65';
const CANVAS = '#F5F3EF';
const SIGNAL = '#3B82F6';

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export interface RequestEmailInput {
  /** The client / tenant doing the asking ("Artistry Homes"). */
  senderName: string;
  recipientName: string | null;
  kind: RequestKind;
  title: string;
  message: string | null;
  /** 1 = first ask; > 1 adds "Reminder" framing. */
  step: number;
  dueDate: string | null;
  ctaUrl: string;
  ctaLabel?: string;
  unsubscribeUrl: string;
  /**
   * The asking company's brand (FPB-branding). With a brand, the head carries its logo
   * (dark-background logo on the Midnight band, else the logo on a white head) and the rule,
   * button and link wear its primary. Without one, the Merit request look.
   */
  brand?: EmailBrand | null;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const CTA: Record<RequestKind, string> = {
  receipt: 'Send the receipt',
  w9: 'Upload your W-9',
  coi: 'Upload your certificate',
  client_question: 'Answer the question',
  document: 'Upload the document',
  approval_nudge: 'Review and approve',
  dunning: 'View and pay',
};

function fmtDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[m - 1]} ${d}, ${y}`;
}

export function buildRequestEmail(i: RequestEmailInput): RenderedEmail {
  const sender = i.senderName.trim() || 'Your accounting team';
  const reminder = i.step > 1;
  const subject = `${reminder ? 'Reminder: ' : ''}${i.title}`.slice(0, 180);
  const cta = i.ctaLabel ?? CTA[i.kind];
  const greeting = i.recipientName ? `Hi ${i.recipientName.split(/\s+/)[0]},` : 'Hello,';
  const lead = reminder
    ? `${sender} is still waiting on this. It takes a minute and no login.`
    : `${sender} needs something from you. It takes a minute and no login.`;
  const due = i.dueDate ? `Needed by ${fmtDate(i.dueDate)}` : null;
  const b = i.brand ?? null;
  const act = b?.primary ?? ELECTRIC;
  const onAct = b?.onPrimary ?? '#FFFFFF';
  const font = b?.fontStack ?? "'DM Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
  // White head when the brand has only a light-background logo; Midnight otherwise.
  const whiteHead = !!b && !!b.logoUrl && !b.logoDarkUrl;
  const headLogo = b ? (whiteHead ? b.logoUrl : b.logoDarkUrl) : null;
  const kindLine = `${esc(KIND_LABEL[i.kind])} request${reminder ? ` <span style="color:#8494A7">//</span> reminder ${i.step - 1}` : ''}`;
  const head = whiteHead
    ? `<tr><td style="background:#FFFFFF;padding:18px 28px;">
  <img src="${esc(headLogo ?? '')}" alt="${esc(sender)}" height="36" style="display:block;max-height:36px;border:0;">
  <div style="color:${STEEL};font-size:11px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;margin-top:8px;">${kindLine}</div>
</td></tr>`
    : `<tr><td style="background:${MIDNIGHT};padding:18px 28px;">
  ${headLogo ? `<img src="${esc(headLogo)}" alt="${esc(sender)}" height="32" style="display:block;max-height:32px;border:0;margin-bottom:6px;">` : `<div style="color:#FFFFFF;font-size:16px;font-weight:700;letter-spacing:.01em;">${esc(sender)}</div>`}
  <div style="color:${SIGNAL};font-size:11px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;margin-top:4px;">${kindLine}</div>
</td></tr>`;

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:${CANVAS};font-family:${font};color:${MIDNIGHT};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${CANVAS};padding:32px 12px;">
<tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:${WARM};border:1px solid #E4E1DA;">
${head}
<tr><td style="height:2px;background:${act};line-height:2px;font-size:0;">&nbsp;</td></tr>
<tr><td style="padding:28px 28px 8px;">
  <div style="font-size:15px;line-height:1.55;">${esc(greeting)}</div>
  <div style="font-size:15px;line-height:1.55;margin-top:8px;">${esc(lead)}</div>
  <div style="font-size:20px;font-weight:700;line-height:1.3;margin-top:20px;">${esc(i.title)}</div>
  ${i.message ? `<div style="font-size:14px;line-height:1.6;color:${STEEL};margin-top:10px;white-space:pre-line;">${esc(i.message)}</div>` : ''}
  ${due ? `<div style="font-size:13px;font-weight:600;color:${STEEL};margin-top:14px;">${esc(due)}</div>` : ''}
</td></tr>
<tr><td style="padding:20px 28px 28px;">
  <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="background:${act};">
    <a href="${esc(i.ctaUrl)}" style="display:inline-block;padding:14px 28px;color:${onAct};font-size:15px;font-weight:700;text-decoration:none;">${esc(cta)}</a>
  </td></tr></table>
  <div style="font-size:12px;line-height:1.6;color:${STEEL};margin-top:14px;">Or paste this link into your browser:<br><span style="word-break:break-all;color:${act};">${esc(i.ctaUrl)}</span></div>
</td></tr>
<tr><td style="padding:16px 28px;border-top:1px solid #E4E1DA;font-size:11.5px;line-height:1.6;color:${STEEL};">
  This link is just for you; please don't forward it. Sent on behalf of ${esc(sender)}.<br>
  <a href="${esc(i.unsubscribeUrl)}" style="color:${STEEL};">Stop these emails</a>
</td></tr>
</table>
</td></tr></table>
</body></html>`;

  const text = [
    greeting,
    '',
    lead,
    '',
    i.title,
    i.message ?? '',
    due ?? '',
    '',
    `${cta}: ${i.ctaUrl}`,
    '',
    `This link is just for you; please don't forward it. Sent on behalf of ${sender}.`,
    `Stop these emails: ${i.unsubscribeUrl}`,
  ]
    .filter((l, idx, arr) => !(l === '' && arr[idx - 1] === ''))
    .join('\n');

  return { subject, html, text };
}

/**
 * The notification DIGEST email (IA M-13; job `notifications.digest`) — one email that
 * rolls up a member's unread in-app notifications when they chose a daily or weekly
 * digest (core.notification_prefs.digest). Merit Suite style v2.3 in email-client terms,
 * matching the request email: Midnight head band (tenant name — white-label), Warm White
 * body, thin Electric rule, square geometry, DM Sans with system fallback, a plain-text
 * twin. Pure (string in, string out).
 */

import { esc } from './request-email';

const MIDNIGHT = '#0A1628';
const ELECTRIC = '#2563EB';
const WARM = '#FDFCFA';
const STEEL = '#3D4F65';
const CANVAS = '#F5F3EF';
const SIGNAL = '#3B82F6';
const BRICK = '#B42318';

export interface DigestItem {
  title: string;
  body: string | null;
  deepLink: string | null;
  severity: 'info' | 'attention' | 'critical';
  createdAt: string;
}

export interface DigestEmailInput {
  tenantName: string;
  recipientName: string | null;
  cadence: 'daily' | 'weekly';
  items: DigestItem[];
  /** Absolute app origin. */
  appUrl: string;
  /** How many more unread items were not listed (the email caps the list). */
  more: number;
}

export function buildDigestEmail(i: DigestEmailInput): { subject: string; html: string; text: string } {
  const tenant = i.tenantName.trim() || 'MeritBooks';
  const n = i.items.length + i.more;
  const urgent = i.items.filter((x) => x.severity !== 'info').length;
  const subject = `${i.cadence === 'weekly' ? 'Your week' : 'Today'} in ${tenant}: ${n} update${n === 1 ? '' : 's'}${urgent ? ` (${urgent} need${urgent === 1 ? 's' : ''} you)` : ''}`.slice(0, 180);
  const base = i.appUrl.replace(/\/$/, '');
  const link = (dl: string | null) => `${base}${dl && dl.startsWith('/') && !dl.startsWith('//') ? dl : '/'}`;
  const greeting = i.recipientName ? `Hi ${i.recipientName.split(/\s+/)[0]},` : 'Hello,';

  const rows = i.items
    .map(
      (x) => `<tr><td style="padding:14px 28px;border-top:1px solid #E4E1DA;">
  <div style="font-size:14px;font-weight:700;line-height:1.4;color:${x.severity === 'info' ? MIDNIGHT : BRICK};">${esc(x.title)}</div>
  ${x.body ? `<div style="font-size:13px;line-height:1.55;color:${STEEL};margin-top:4px;">${esc(x.body)}</div>` : ''}
  <div style="margin-top:6px;"><a href="${esc(link(x.deepLink))}" style="font-size:12.5px;font-weight:600;color:${ELECTRIC};text-decoration:none;">Open</a></div>
</td></tr>`,
    )
    .join('\n');

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:${CANVAS};font-family:'DM Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${MIDNIGHT};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${CANVAS};padding:32px 12px;">
<tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:${WARM};border:1px solid #E4E1DA;">
<tr><td style="background:${MIDNIGHT};padding:18px 28px;">
  <div style="color:#FFFFFF;font-size:16px;font-weight:700;">${esc(tenant)}</div>
  <div style="color:${SIGNAL};font-size:11px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;margin-top:4px;">${i.cadence === 'weekly' ? 'Weekly' : 'Daily'} digest <span style="color:#8494A7">//</span> ${n} update${n === 1 ? '' : 's'}</div>
</td></tr>
<tr><td style="height:2px;background:${ELECTRIC};line-height:2px;font-size:0;">&nbsp;</td></tr>
<tr><td style="padding:24px 28px 12px;font-size:15px;line-height:1.55;">${esc(greeting)}<br>Here's what happened since your last digest.</td></tr>
${rows}
${i.more > 0 ? `<tr><td style="padding:14px 28px;border-top:1px solid #E4E1DA;font-size:13px;color:${STEEL};">…and ${i.more} more in the app.</td></tr>` : ''}
<tr><td style="padding:20px 28px 28px;border-top:1px solid #E4E1DA;">
  <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="background:${ELECTRIC};">
    <a href="${esc(base)}/" style="display:inline-block;padding:12px 24px;color:#FFFFFF;font-size:14px;font-weight:700;text-decoration:none;">Open MeritBooks</a>
  </td></tr></table>
  <div style="font-size:11.5px;line-height:1.6;color:${STEEL};margin-top:14px;">You get this because your notification setting is “${i.cadence} digest”. Change it from Notifications in the app.</div>
</td></tr>
</table>
</td></tr></table>
</body></html>`;

  const text = [
    greeting,
    "Here's what happened since your last digest.",
    '',
    ...i.items.flatMap((x) => [`• ${x.title}`, ...(x.body ? [`  ${x.body}`] : []), `  ${link(x.deepLink)}`]),
    ...(i.more > 0 ? ['', `…and ${i.more} more in the app.`] : []),
    '',
    `Open MeritBooks: ${base}/`,
    `You get this because your notification setting is "${i.cadence} digest".`,
  ].join('\n');

  return { subject, html, text };
}

/**
 * Daily / weekly digest (PLT-46): group the claimed items (core.notify_digest_collect) by job,
 * "needs you" first, and render the email — Merit Suite v2.3 in email-client terms (Midnight
 * head band with the tenant name, Warm White body, thin Electric rule, square geometry, DM Sans
 * with system fallback) plus a plain-text twin. Pure.
 */

export interface DigestSourceItem {
  id: string;
  title: string;
  body: string | null;
  deepLink: string | null;
  severity: 'info' | 'attention' | 'critical';
  eventType: string;
  jobId: string | null;
  jobLabel: string | null;
  itemCount: number;
  createdAt: string;
}

export interface DigestGroup {
  key: string;
  label: string;
  jobId: string | null;
  items: DigestSourceItem[];
  needsYou: number;
}

export interface GroupedDigest {
  groups: DigestGroup[];
  /** Updates counted with their batches (one row "3 updates" counts 3). */
  total: number;
  needsYou: number;
  headline: string;
}

const NEEDS_YOU = (i: DigestSourceItem) => i.severity !== 'info';
const RANK: Readonly<Record<DigestSourceItem['severity'], number>> = { critical: 0, attention: 1, info: 2 };

export function groupDigest(items: ReadonlyArray<DigestSourceItem>): GroupedDigest {
  const byKey = new Map<string, DigestGroup>();
  for (const it of items) {
    const key = it.jobId ?? 'general';
    let g = byKey.get(key);
    if (!g) {
      g = { key, label: it.jobId ? it.jobLabel ?? 'A job' : 'Across your work', jobId: it.jobId, items: [], needsYou: 0 };
      byKey.set(key, g);
    }
    g.items.push(it);
    if (NEEDS_YOU(it)) g.needsYou += 1;
  }
  const groups = [...byKey.values()];
  for (const g of groups) {
    g.items.sort((a, b) => RANK[a.severity] - RANK[b.severity] || b.createdAt.localeCompare(a.createdAt));
  }
  // groups that need you first, then by size, then the general group last, then by name
  groups.sort((a, b) => b.needsYou - a.needsYou || (a.jobId ? 0 : 1) - (b.jobId ? 0 : 1) || b.items.length - a.items.length || a.label.localeCompare(b.label));
  const total = items.reduce((n, i) => n + Math.max(1, i.itemCount), 0);
  const needsYou = items.filter(NEEDS_YOU).length;
  const headline = needsYou > 0
    ? `${needsYou} thing${needsYou === 1 ? '' : 's'} need${needsYou === 1 ? 's' : ''} you`
    : `${total} update${total === 1 ? '' : 's'}`;
  return { groups, total, needsYou, headline };
}

const MIDNIGHT = '#0A1628';
const ELECTRIC = '#2563EB';
const WARM = '#FDFCFA';
const STEEL = '#3D4F65';
const CANVAS = '#F5F3EF';
const SIGNAL = '#3B82F6';
const BRICK = '#B42318';
const LINE = '#E1E5EA';

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Internal deep link → absolute URL on the app origin; anything else → the app root. */
export function absoluteLink(appUrl: string, deepLink: string | null): string {
  const base = appUrl.replace(/\/+$/, '');
  return `${base}${deepLink && deepLink.startsWith('/') && !deepLink.startsWith('//') && !deepLink.includes('\\') ? deepLink : '/'}`;
}

export interface DigestEmailInput {
  tenantName: string;
  firstName: string | null;
  cadence: 'daily' | 'weekly';
  items: ReadonlyArray<DigestSourceItem>;
  appUrl: string;
  /** Rows per group shown before "…and N more". */
  perGroup?: number;
}

export function buildDigestEmail(i: DigestEmailInput): { subject: string; html: string; text: string } {
  const tenant = i.tenantName.trim() || 'Merit Projects';
  const g = groupDigest(i.items);
  const per = i.perGroup ?? 8;
  const when = i.cadence === 'weekly' ? 'This week' : 'Today';
  const subject = `${when} at ${tenant}: ${g.headline}`.slice(0, 180);
  const greeting = i.firstName ? `Hi ${i.firstName.split(/\s+/)[0]},` : 'Hello,';
  const intro = g.needsYou > 0 ? `${g.headline}. Here is what happened since your last digest.` : 'Here is what happened since your last digest.';

  const groupHtml = g.groups.map((grp) => {
    const shown = grp.items.slice(0, per);
    const rows = shown.map((x) => `<tr><td style="padding:10px 28px;border-top:1px solid ${LINE};">
  <div style="font-size:14px;font-weight:700;line-height:1.4;color:${x.severity === 'info' ? MIDNIGHT : BRICK};">${esc(x.title)}</div>
  ${x.body ? `<div style="font-size:13px;line-height:1.55;color:${STEEL};margin-top:2px;">${esc(x.body)}</div>` : ''}
  <div style="margin-top:4px;"><a href="${esc(absoluteLink(i.appUrl, x.deepLink))}" style="font-size:12.5px;font-weight:600;color:${ELECTRIC};text-decoration:none;">Open</a></div>
</td></tr>`).join('\n');
    const more = grp.items.length - shown.length;
    return `<tr><td style="padding:18px 28px 6px;font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:${STEEL};">${esc(grp.label)}${grp.needsYou ? ` <span style="color:${BRICK}">// ${grp.needsYou} need${grp.needsYou === 1 ? 's' : ''} you</span>` : ''}</td></tr>
${rows}
${more > 0 ? `<tr><td style="padding:8px 28px;font-size:12.5px;color:${STEEL};">…and ${more} more on this job.</td></tr>` : ''}`;
  }).join('\n');

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:${CANVAS};font-family:'DM Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${MIDNIGHT};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${CANVAS};padding:32px 12px;">
<tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:${WARM};border:1px solid ${LINE};">
<tr><td style="background:${MIDNIGHT};padding:18px 28px;">
  <div style="color:#FFFFFF;font-size:16px;font-weight:700;">${esc(tenant)}</div>
  <div style="color:${SIGNAL};font-size:11px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;margin-top:4px;">${i.cadence === 'weekly' ? 'Weekly' : 'Daily'} digest <span style="color:#8494A7">//</span> ${esc(g.headline)}</div>
</td></tr>
<tr><td style="height:2px;background:${ELECTRIC};line-height:2px;font-size:0;">&nbsp;</td></tr>
<tr><td style="padding:24px 28px 8px;font-size:15px;line-height:1.55;">${esc(greeting)}<br>${esc(intro)}</td></tr>
${groupHtml}
<tr><td style="padding:20px 28px 28px;border-top:1px solid ${LINE};">
  <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="background:${ELECTRIC};">
    <a href="${esc(absoluteLink(i.appUrl, '/inbox'))}" style="display:inline-block;padding:12px 24px;color:#FFFFFF;font-size:14px;font-weight:700;text-decoration:none;">Open your inbox</a>
  </td></tr></table>
  <div style="font-size:11.5px;line-height:1.6;color:${STEEL};margin-top:14px;">You get this ${i.cadence} digest because of your notification settings. Change them under Inbox, then Settings.</div>
</td></tr>
</table>
</td></tr></table>
</body></html>`;

  const text = [
    greeting,
    intro,
    ...g.groups.flatMap((grp) => [
      '',
      `${grp.label.toUpperCase()}${grp.needsYou ? ` (${grp.needsYou} need${grp.needsYou === 1 ? 's' : ''} you)` : ''}`,
      ...grp.items.slice(0, per).flatMap((x) => [`• ${x.title}`, ...(x.body ? [`  ${x.body}`] : []), `  ${absoluteLink(i.appUrl, x.deepLink)}`]),
      ...(grp.items.length > per ? [`  …and ${grp.items.length - per} more on this job.`] : []),
    ]),
    '',
    `Open your inbox: ${absoluteLink(i.appUrl, '/inbox')}`,
  ].join('\n');

  return { subject, html, text };
}

/** One instant notification as an email (internal recipients). */
export function buildNotificationEmail(i: { tenantName: string; title: string; body: string | null; deepLink: string | null; appUrl: string }): { subject: string; html: string; text: string } {
  const tenant = i.tenantName.trim() || 'Merit Projects';
  const link = absoluteLink(i.appUrl, i.deepLink);
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(i.title)}</title></head>
<body style="margin:0;padding:0;background:${CANVAS};font-family:'DM Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${MIDNIGHT};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${CANVAS};padding:32px 12px;"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:${WARM};border:1px solid ${LINE};">
<tr><td style="background:${MIDNIGHT};padding:18px 28px;color:#FFFFFF;font-size:16px;font-weight:700;">${esc(tenant)}</td></tr>
<tr><td style="height:2px;background:${ELECTRIC};line-height:2px;font-size:0;">&nbsp;</td></tr>
<tr><td style="padding:24px 28px 8px;font-size:16px;font-weight:700;line-height:1.4;">${esc(i.title)}</td></tr>
${i.body ? `<tr><td style="padding:0 28px 8px;font-size:14px;line-height:1.55;color:${STEEL};">${esc(i.body)}</td></tr>` : ''}
<tr><td style="padding:16px 28px 28px;"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="background:${ELECTRIC};">
  <a href="${esc(link)}" style="display:inline-block;padding:12px 24px;color:#FFFFFF;font-size:14px;font-weight:700;text-decoration:none;">Open</a>
</td></tr></table></td></tr>
</table></td></tr></table></body></html>`;
  return { subject: i.title.slice(0, 180), html, text: [i.title, ...(i.body ? ['', i.body] : []), '', link].join('\n') };
}

/**
 * Branded AR statement email (FPB-invoices §7).
 *
 * Table-based HTML with inline styles, same rationale as invoice-email.ts: email
 * clients aren't browsers. Visual continuity with the invoice email and hosted
 * pay page is deliberate — same accent band, same JetBrains-Mono figures — so a
 * statement and an invoice read as one system. The branded PDF rides along as an
 * attachment; the email body carries the aging summary + balance so it's useful
 * even before the PDF is opened.
 */

import { AGING_BUCKETS, AGING_BUCKET_LABELS, type StatementDoc } from './statement';
import { readableOn } from './invoice-email';

const money = (cents: number) =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const longDate = (iso: string) =>
  iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : '';
const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface StatementEmailContent {
  subject: string;
  html: string;
  text: string;
}

export function buildStatementEmail(doc: StatementDoc): StatementEmailContent {
  const accent = doc.template.accentColor || '#10b981';
  const onAccent = readableOn(accent);
  const from = doc.entity?.name ?? 'Your supplier';
  const balance = doc.totalBalanceCents;

  const subject = `Statement from ${from} — ${money(balance)} due as of ${longDate(doc.asOf)}`;

  const agingCells = AGING_BUCKETS.map(
    (b) => `
      <td align="center" style="padding:8px 6px;border:1px solid #e2e8f0;">
        <div style="color:#94a3b8;font-size:10px;letter-spacing:.5px;text-transform:uppercase;">${AGING_BUCKET_LABELS[b]}</div>
        <div style="color:#0f172a;font-size:13px;font-weight:700;font-family:'JetBrains Mono',Menlo,Consolas,monospace;">${money(doc.aging[b])}</div>
      </td>`,
  ).join('');

  const lineRows = doc.lines
    .map(
      (l) => `
      <tr>
        <td style="padding:8px 0;border-bottom:1px solid #e2e8f0;color:#0f172a;font-size:13px;font-family:'JetBrains Mono',Menlo,Consolas,monospace;">${esc(l.invoiceNumber)}</td>
        <td style="padding:8px 0;border-bottom:1px solid #e2e8f0;color:#64748b;font-size:12px;">${longDate(l.dueDate)}</td>
        <td align="right" style="padding:8px 0;border-bottom:1px solid #e2e8f0;color:${l.balanceCents > 0 ? '#0f172a' : '#94a3b8'};font-size:13px;font-family:'JetBrains Mono',Menlo,Consolas,monospace;">${money(l.balanceCents)}</td>
      </tr>`,
    )
    .join('');

  const scopeLabel = doc.mode === 'activity' ? 'Account activity' : 'Open items';

  const html = `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:'Plus Jakarta Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">Statement — ${money(balance)} due as of ${longDate(doc.asOf)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:32px 12px;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 1px 3px rgba(15,23,42,0.08);">
        <tr>
          <td style="background:${accent};padding:26px 32px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
              <td style="color:${onAccent};font-size:17px;font-weight:700;">${esc(from)}</td>
              <td align="right" style="color:${onAccent};font-size:11px;letter-spacing:1.4px;opacity:.85;">STATEMENT</td>
            </tr></table>
          </td>
        </tr>
        <tr><td style="padding:32px;">
          <div style="color:#64748b;font-size:13px;font-weight:600;">${scopeLabel} · as of ${longDate(doc.asOf)}</div>
          <div style="color:#0f172a;font-size:34px;font-weight:700;margin:6px 0 4px;font-family:'JetBrains Mono',Menlo,Consolas,monospace;">${money(balance)}</div>
          <div style="color:#64748b;font-size:13px;">Total balance due · ${doc.openInvoiceCount} open invoice${doc.openInvoiceCount === 1 ? '' : 's'}</div>

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:22px 0 6px;border-collapse:collapse;">
            <tr>${agingCells}</tr>
          </table>

          ${doc.lines.length
            ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:20px;">
            <tr>
              <td style="color:#94a3b8;font-size:11px;letter-spacing:.7px;padding-bottom:8px;">INVOICE</td>
              <td style="color:#94a3b8;font-size:11px;letter-spacing:.7px;padding-bottom:8px;">DUE</td>
              <td align="right" style="color:#94a3b8;font-size:11px;letter-spacing:.7px;padding-bottom:8px;">BALANCE</td>
            </tr>
            ${lineRows}
            <tr>
              <td colspan="2" style="padding-top:14px;color:#0f172a;font-size:15px;font-weight:700;">Total due</td>
              <td align="right" style="padding-top:14px;color:${accent};font-size:15px;font-weight:700;font-family:'JetBrains Mono',Menlo,Consolas,monospace;">${money(balance)}</td>
            </tr>
          </table>`
            : `<div style="margin-top:20px;color:#64748b;font-size:13.5px;">This account has a zero balance. Thank you.</div>`}

          <div style="color:#94a3b8;font-size:12px;margin-top:18px;">The full statement is attached as a PDF.</div>
          ${doc.template.remitTo ? `<div style="margin-top:18px;color:#64748b;font-size:12.5px;line-height:1.6;"><strong style="color:#475569;">Remit payment to</strong><br>${esc(doc.template.remitTo).replace(/\n/g, '<br>')}</div>` : ''}
        </td></tr>
        <tr><td style="padding:18px 32px;background:#f8fafc;color:#94a3b8;font-size:11.5px;">
          ${esc(from)} · Statement as of ${longDate(doc.asOf)}${doc.template.footerText ? ` · ${esc(doc.template.footerText)}` : ''}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text = [
    `Statement from ${from}`,
    '',
    `${scopeLabel} as of ${longDate(doc.asOf)}`,
    `Total balance due: ${money(balance)} (${doc.openInvoiceCount} open invoice${doc.openInvoiceCount === 1 ? '' : 's'})`,
    '',
    'Aging:',
    ...AGING_BUCKETS.map((b) => `  ${AGING_BUCKET_LABELS[b]}: ${money(doc.aging[b])}`),
    '',
    ...(doc.lines.length ? doc.lines.map((l) => `  ${l.invoiceNumber}  due ${longDate(l.dueDate)}  ${money(l.balanceCents)}`) : ['  This account has a zero balance.']),
    '',
    'The full statement is attached as a PDF.',
    doc.template.remitTo ? `\nRemit payment to:\n${doc.template.remitTo}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  return { subject, html, text };
}

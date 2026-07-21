/**
 * Branded invoice email.
 *
 * Rendered as table-based HTML with inline styles, not the styled-JSX the hosted
 * page uses. Email clients are not browsers: Outlook renders with Word's engine,
 * Gmail strips <style> blocks, and flexbox/grid are unreliable across the estate.
 * Tables and inline styles are the format that actually arrives intact.
 *
 * Visual continuity with /pay/[token] is deliberate — same accent band, same
 * hierarchy, same figures treatment — so the email and the page it links to read
 * as one document rather than two systems.
 */

import type { InvoiceDoc } from './invoice-doc';

const money = (cents: number) =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const longDate = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric',
  });

/** Black or white text, whichever reads on the accent. Mirrors the hosted page. */
export function readableOn(hex: string): string {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  // Relative luminance, sRGB coefficients.
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6 ? '#0f172a' : '#ffffff';
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface InvoiceEmailContent {
  subject: string;
  html: string;
  text: string;
}

export function buildInvoiceEmail(doc: InvoiceDoc, payUrl: string): InvoiceEmailContent {
  const accent = doc.template?.accent_color || '#10b981';
  const onAccent = readableOn(accent);
  const from = doc.entity?.name ?? 'Your supplier';
  const balance = doc.balance_cents > 0 ? doc.balance_cents : doc.total_cents;
  const overdue = new Date(`${doc.due_date}T00:00:00`) < new Date();

  const subject = `Invoice ${doc.invoice_number} from ${from} — ${money(balance)} due ${longDate(doc.due_date)}`;

  const lineRows = doc.lines
    .map(
      (l) => `
      <tr>
        <td style="padding:10px 0;border-bottom:1px solid #e2e8f0;color:#0f172a;font-size:14px;">${esc(l.description)}</td>
        <td align="right" style="padding:10px 0;border-bottom:1px solid #e2e8f0;color:#475569;font-size:14px;font-family:'JetBrains Mono',Menlo,Consolas,monospace;">${money(l.amount_cents)}</td>
      </tr>`,
    )
    .join('');

  const html = `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:'Plus Jakarta Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <!-- Preheader: shown in the inbox list, hidden in the body. -->
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">Invoice ${esc(doc.invoice_number)} — ${money(balance)} due ${longDate(doc.due_date)}</div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:32px 12px;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 1px 3px rgba(15,23,42,0.08);">

        <tr>
          <td style="background:${accent};padding:26px 32px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
              <td style="color:${onAccent};font-size:17px;font-weight:700;">${esc(from)}</td>
              <td align="right" style="color:${onAccent};font-size:11px;letter-spacing:1.4px;opacity:.85;">INVOICE</td>
            </tr></table>
          </td>
        </tr>

        <tr><td style="padding:32px;">
          <div style="color:${overdue ? '#dc2626' : '#64748b'};font-size:13px;font-weight:600;">
            ${overdue ? 'Overdue' : 'Amount due'} · ${longDate(doc.due_date)}
          </div>
          <div style="color:#0f172a;font-size:34px;font-weight:700;margin:6px 0 4px;font-family:'JetBrains Mono',Menlo,Consolas,monospace;">${money(balance)}</div>
          <div style="color:#64748b;font-size:13px;">Invoice ${esc(doc.invoice_number)}</div>

          <table role="presentation" cellpadding="0" cellspacing="0" style="margin:26px 0 8px;">
            <tr><td style="background:${accent};border-radius:9px;">
              <a href="${esc(payUrl)}" style="display:inline-block;padding:14px 34px;color:${onAccent};font-size:15px;font-weight:700;text-decoration:none;">Pay this invoice</a>
            </td></tr>
          </table>
          <div style="color:#94a3b8;font-size:12px;margin-bottom:22px;">Or view it online — the PDF is attached to this email.</div>

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:6px;">
            <tr>
              <td style="color:#94a3b8;font-size:11px;letter-spacing:.7px;padding-bottom:8px;">DESCRIPTION</td>
              <td align="right" style="color:#94a3b8;font-size:11px;letter-spacing:.7px;padding-bottom:8px;">AMOUNT</td>
            </tr>
            ${lineRows}
            <tr>
              <td style="padding-top:14px;color:#0f172a;font-size:15px;font-weight:700;">Total</td>
              <td align="right" style="padding-top:14px;color:${accent};font-size:15px;font-weight:700;font-family:'JetBrains Mono',Menlo,Consolas,monospace;">${money(doc.total_cents)}</td>
            </tr>
          </table>

          ${doc.customer_message ? `<div style="margin-top:24px;padding:14px 16px;background:#f8fafc;border-radius:9px;color:#475569;font-size:13.5px;line-height:1.55;">${esc(doc.customer_message)}</div>` : ''}
          ${doc.template?.remit_to ? `<div style="margin-top:18px;color:#64748b;font-size:12.5px;line-height:1.6;"><strong style="color:#475569;">Prefer to mail a check?</strong><br>${esc(doc.template.remit_to).replace(/\n/g, '<br>')}</div>` : ''}
        </td></tr>

        <tr><td style="padding:18px 32px;background:#f8fafc;color:#94a3b8;font-size:11.5px;">
          ${esc(from)} · Invoice ${esc(doc.invoice_number)}${doc.template?.footer_text ? ` · ${esc(doc.template.footer_text)}` : ''}
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text = [
    `Invoice ${doc.invoice_number} from ${from}`,
    '',
    `${overdue ? 'Overdue' : 'Amount due'}: ${money(balance)}`,
    `Due: ${longDate(doc.due_date)}`,
    '',
    ...doc.lines.map((l) => `  ${l.description}  ${money(l.amount_cents)}`),
    '',
    `Total: ${money(doc.total_cents)}`,
    '',
    `Pay online: ${payUrl}`,
    doc.customer_message ? `\n${doc.customer_message}` : '',
    doc.template?.remit_to ? `\nPrefer to mail a check?\n${doc.template.remit_to}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  return { subject, html, text };
}

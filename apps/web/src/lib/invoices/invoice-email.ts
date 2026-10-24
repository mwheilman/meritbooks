/**
 * Branded invoice email.
 *
 * Rendered as table-based HTML with inline styles: email clients are not browsers
 * (Outlook renders with Word's engine, Gmail strips <style> blocks, flexbox/grid are
 * unreliable). Tables and inline styles are what arrives intact.
 *
 * Driven by the same resolved template as the PDF and the hosted page (brand colour,
 * terms, payment instructions). The Pay button appears ONLY when the invoice can
 * really be paid online (doc.pay.payable) and the template shows it; otherwise the
 * email offers "View invoice" and prints the payment instructions — never a dead
 * pay link. Customer-facing: no GL account numbers or codes.
 *
 * Type: DM Sans with a system fallback (the suite has no monospace); square
 * geometry; figures tabular.
 */

import type { InvoiceDoc } from './invoice-doc';
import { onColorFor } from '@/lib/branding/color';

const money = (cents: number) =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const longDate = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric',
  });

const FONT = "'DM Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
const FIG = 'font-variant-numeric:tabular-nums;';

/**
 * White or Midnight ink, whichever has the higher WCAG contrast on the accent (one rule for
 * every surface — lib/branding/color.ts). Lower-case hex for the inline styles.
 */
export function readableOn(hex: string): string {
  return onColorFor(hex).toLowerCase();
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const escMultiline = (s: string) => esc(s).replace(/\n/g, '<br>');

export interface InvoiceEmailContent {
  subject: string;
  html: string;
  text: string;
  /** True when the email carries a Pay button (the invoice is payable online). */
  hasPayButton: boolean;
}

export interface InvoiceEmailOptions {
  /** A message typed for THIS send (replaces the invoice's customer message). */
  message?: string | null;
  /** Names of extra files attached (listed in the email so the customer knows). */
  attachmentNames?: string[];
}

/** "Pay by bank transfer or card." — only the methods the pay page really offers (pay-link.ts). */
export function payMethodsSentence(methods: ReadonlyArray<string>): string {
  const ach = methods.includes('ACH');
  const card = methods.includes('CARD');
  if (ach && card) return 'Pay by bank transfer or card.';
  if (card) return 'Pay by card.';
  return 'Pay by bank transfer.';
}

/**
 * @param payUrlOverride  legacy callers pass the pay URL; the resolved doc.pay.url is used otherwise.
 */
export function buildInvoiceEmail(doc: InvoiceDoc, payUrlOverride?: string | null, opts: InvoiceEmailOptions = {}): InvoiceEmailContent {
  const t = doc.template;
  const accent = t?.accent_color || '#2563EB';
  // The brand's own on-primary when the accent IS the brand colour; else computed.
  const onAccent = doc.brand && doc.brand.palette.primary.toLowerCase() === accent.toLowerCase()
    ? doc.brand.palette.on_primary.toLowerCase()
    : readableOn(accent);
  const font = doc.brand?.fontStack ?? FONT;
  // On a dark band, the brand's dark-background logo; a light-background logo sits on a
  // white chip so it never vanishes into the band (FPB-branding §5 logo slots).
  const darkBand = onAccent === '#ffffff';
  const useDarkLogo = darkBand && !!doc.brand?.logoDarkUrl && !!t?.logo_url && t.logo_url === doc.brand.logoUrl;
  const bandLogo = useDarkLogo ? doc.brand!.logoDarkUrl : t?.logo_url ?? null;
  const logoChip = darkBand && !useDarkLogo ? 'background:#ffffff;padding:6px 8px;' : '';
  const from = doc.entity?.name ?? 'Your supplier';
  const balance = doc.balance_cents > 0 ? doc.balance_cents : doc.total_cents;
  const overdue = new Date(`${doc.due_date}T00:00:00`) < new Date();
  const viewUrl = payUrlOverride || doc.pay?.url || '';
  const open = doc.balance_cents > 0 && !['PAID', 'VOIDED', 'WRITTEN_OFF'].includes(doc.status);
  const payable = open && !!doc.pay?.payable && (t?.show_pay_button ?? true) && !!viewUrl;
  const message = opts.message?.trim() ? opts.message.trim() : doc.customer_message;
  const instructions = t?.payment_instructions ?? null;

  const subject = `Invoice ${doc.invoice_number} from ${from} — ${money(balance)} due ${longDate(doc.due_date)}`;

  const lineRows = doc.lines
    .map(
      (l) => `
      <tr>
        <td style="padding:10px 0;border-bottom:1px solid #e3e1dc;color:#0a1628;font-size:14px;">${esc(l.description)}</td>
        <td align="right" style="padding:10px 0;border-bottom:1px solid #e3e1dc;color:#3d4f65;font-size:14px;${FIG}">${money(l.amount_cents)}</td>
      </tr>`,
    )
    .join('');

  const cta = payable
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:26px 0 8px;">
            <tr><td style="background:${accent};">
              <a href="${esc(viewUrl)}" style="display:inline-block;padding:14px 34px;color:${onAccent};font-size:15px;font-weight:700;text-decoration:none;font-family:${font};">Pay this invoice</a>
            </td></tr>
          </table>
          <div style="color:#8494a7;font-size:12px;margin-bottom:22px;">${payMethodsSentence(doc.pay?.methods ?? [])} The PDF is attached.</div>`
    : `${viewUrl ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:26px 0 8px;">
            <tr><td style="border:1px solid ${accent};">
              <a href="${esc(viewUrl)}" style="display:inline-block;padding:12px 28px;color:${accent};font-size:14px;font-weight:700;text-decoration:none;font-family:${font};">View invoice</a>
            </td></tr>
          </table>` : ''}
          <div style="color:#8494a7;font-size:12px;margin-bottom:22px;">The PDF is attached to this email.</div>`;

  const extra = (opts.attachmentNames ?? []).filter(Boolean);

  const html = `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f3ef;font-family:${font};">
  <!-- Preheader: shown in the inbox list, hidden in the body. -->
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">Invoice ${esc(doc.invoice_number)} — ${money(balance)} due ${longDate(doc.due_date)}</div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f3ef;padding:32px 12px;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border:1px solid #e3e1dc;">

        <tr>
          <td style="background:${accent};padding:24px 32px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
              <td style="color:${onAccent};font-size:17px;font-weight:700;font-family:${font};">${bandLogo ? `<span style="display:inline-block;${logoChip}"><img src="${esc(bandLogo)}" alt="${esc(from)}" height="36" style="display:block;max-height:36px;border:0;"></span>` : esc(from)}</td>
              <td align="right" style="color:${onAccent};font-size:11px;letter-spacing:1.4px;font-family:${font};">INVOICE</td>
            </tr></table>
          </td>
        </tr>

        <tr><td style="padding:32px;">
          <div style="color:${overdue ? '#b42318' : '#3d4f65'};font-size:13px;font-weight:600;">
            ${overdue ? 'Overdue' : 'Amount due'} · ${longDate(doc.due_date)}
          </div>
          <div style="color:#0a1628;font-size:34px;font-weight:700;margin:6px 0 4px;${FIG}">${money(balance)}</div>
          <div style="color:#3d4f65;font-size:13px;">Invoice ${esc(doc.invoice_number)} from ${esc(from)}</div>

          ${cta}

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:6px;">
            <tr>
              <td style="color:#8494a7;font-size:11px;letter-spacing:.7px;padding-bottom:8px;">DESCRIPTION</td>
              <td align="right" style="color:#8494a7;font-size:11px;letter-spacing:.7px;padding-bottom:8px;">AMOUNT</td>
            </tr>
            ${lineRows}
            <tr>
              <td style="padding-top:14px;color:#0a1628;font-size:15px;font-weight:700;">Total</td>
              <td align="right" style="padding-top:14px;color:#0a1628;font-size:15px;font-weight:700;${FIG}">${money(doc.total_cents)}</td>
            </tr>
          </table>

          ${message ? `<div style="margin-top:24px;padding:14px 16px;background:#f5f3ef;color:#3d4f65;font-size:13.5px;line-height:1.55;">${escMultiline(message)}</div>` : ''}
          ${instructions ? `<div style="margin-top:18px;color:#3d4f65;font-size:12.5px;line-height:1.6;"><strong style="color:#0a1628;">${payable ? 'Other ways to pay' : 'How to pay'}</strong><br>${escMultiline(instructions)}</div>` : ''}
          ${!instructions && t?.remit_to ? `<div style="margin-top:18px;color:#3d4f65;font-size:12.5px;line-height:1.6;"><strong style="color:#0a1628;">Prefer to mail a check?</strong><br>${escMultiline(t.remit_to)}</div>` : ''}
          ${t?.terms_text ? `<div style="margin-top:18px;color:#8494a7;font-size:12px;line-height:1.6;"><strong style="color:#3d4f65;">Terms</strong><br>${escMultiline(t.terms_text)}</div>` : ''}
          ${extra.length ? `<div style="margin-top:18px;color:#8494a7;font-size:12px;">Also attached: ${extra.map(esc).join(', ')}</div>` : ''}
        </td></tr>

        <tr><td style="padding:18px 32px;background:#f5f3ef;color:#8494a7;font-size:11.5px;">
          ${esc(from)} · Invoice ${esc(doc.invoice_number)}${t?.footer_text ? ` · ${esc(t.footer_text)}` : ''}
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
    payable ? `Pay online: ${viewUrl}` : viewUrl ? `View invoice: ${viewUrl}` : '',
    message ? `\n${message}` : '',
    instructions ? `\n${payable ? 'Other ways to pay' : 'How to pay'}:\n${instructions}` : '',
    !instructions && t?.remit_to ? `\nPrefer to mail a check?\n${t.remit_to}` : '',
    t?.terms_text ? `\nTerms:\n${t.terms_text}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  return { subject, html, text, hasPayButton: payable };
}

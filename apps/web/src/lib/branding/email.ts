/**
 * Brand tokens for customer-facing emails (FPB-branding §7). Email clients are not
 * browsers: everything is inline styles on tables, so the brand is reduced to the handful
 * of literal values a template needs. Pure.
 */

import { WHITE, onColorFor } from './color';
import type { ResolvedBrand } from './types';

export interface EmailBrand {
  /** Logo for a WHITE head (the light-background logo). */
  logoUrl: string | null;
  /** Logo for a DARK head, when the tenant uploaded one. */
  logoDarkUrl: string | null;
  primary: string;
  onPrimary: string;
  ink: string;
  surface: string;
  fontStack: string;
}

/** The email tokens of a resolved brand; null for the Merit default (templates keep their own look). */
export function emailBrandOf(b: ResolvedBrand | null | undefined): EmailBrand | null {
  if (!b || b.source === 'MERIT_DEFAULT') return null;
  return {
    logoUrl: b.logoUrl,
    logoDarkUrl: b.logoDarkUrl,
    primary: b.palette.primary,
    onPrimary: b.palette.on_primary,
    ink: b.palette.ink,
    surface: b.palette.surface,
    fontStack: b.fontStack,
  };
}

export function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const DEFAULT_FONT = "'DM Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";

export interface LetterInput {
  /** Plain-text letter; blank lines separate paragraphs. */
  bodyText: string;
  senderName: string;
  /** The colour to act with (a template's accent); brand.primary when branded. */
  accent: string;
  brand: EmailBrand | null;
  cta: { url: string; label: string } | null;
}

/**
 * A short branded letter (dunning reminders): logo (or the sender's name) on a white head,
 * a brand rule, the paragraphs, one brand button. Square geometry, DM Sans / brand font.
 */
export function brandedLetterHtml(i: LetterInput): string {
  const accent = i.brand?.primary ?? i.accent;
  const on = i.brand ? i.brand.onPrimary : onColorFor(accent);
  const ink = i.brand?.ink ?? '#0A1628';
  const font = i.brand?.fontStack ?? DEFAULT_FONT;
  const logo = i.brand?.logoUrl ?? null;
  const head = logo
    ? `<img src="${escHtml(logo)}" alt="${escHtml(i.senderName)}" height="36" style="display:block;max-height:36px;border:0;">`
    : `<div style="font-size:16px;font-weight:700;color:${ink};">${escHtml(i.senderName)}</div>`;
  const paragraphs = i.bodyText
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 16px;line-height:1.6;color:${ink};font-size:15px;">${escHtml(p).replace(/\n/g, '<br/>')}</p>`)
    .join('');
  const button = i.cta
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0 0;"><tr><td style="background:${accent};"><a href="${escHtml(i.cta.url)}" style="display:inline-block;padding:12px 24px;color:${on};font-weight:700;font-size:14px;text-decoration:none;font-family:${font};">${escHtml(i.cta.label)}</a></td></tr></table>`
    : '';
  return `<div style="background:#F5F3EF;padding:24px 12px;font-family:${font};">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;margin:0 auto;background:${WHITE};border:1px solid #E4E1DA;">
<tr><td style="padding:20px 28px 16px;">${head}</td></tr>
<tr><td style="height:3px;background:${accent};line-height:3px;font-size:0;">&nbsp;</td></tr>
<tr><td style="padding:24px 28px 28px;">${paragraphs}${button}</td></tr>
</table></div>`;
}

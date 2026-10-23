/**
 * Invoice design templates (migration 176, FPB-invoices §4 Slice 1B).
 *
 * A template is how a customer-facing invoice LOOKS and what it PRINTS: layout
 * variant, brand colour, font, logo, which line columns show, custom header /
 * footer fields, custom line fields, terms, payment instructions, and whether the
 * pay link + QR code print. It never changes an amount — the GL is the GL.
 *
 * Pure types + defaults: imported by the PDF renderer, the email, the hosted pay
 * page, the design screen and the routes, so they can never disagree.
 */
import { tenantLogoOrNull } from './logo-url';

export const INVOICE_LAYOUTS = ['MODERN', 'CLASSIC', 'MINIMAL', 'BOLD', 'COMPACT'] as const;
export type InvoiceLayout = (typeof INVOICE_LAYOUTS)[number];

export const INVOICE_FONTS = ['SANS', 'SERIF'] as const;
export type InvoiceFont = (typeof INVOICE_FONTS)[number];

/** Line columns a template may print. `description` and `amount` are always on. */
/** Canonical print order (left → right). Custom line fields sit before the figures. */
export const INVOICE_COLUMNS = [
  'item', 'description', 'service_date', 'job', 'cost_code', 'custom', 'quantity', 'rate', 'tax', 'amount',
] as const;
export type InvoiceColumn = (typeof INVOICE_COLUMNS)[number];

export const REQUIRED_COLUMNS: readonly InvoiceColumn[] = ['description', 'amount'];

export const COLUMN_LABELS: Record<InvoiceColumn, string> = {
  item: 'Item',
  description: 'Description',
  service_date: 'Date of service',
  job: 'Job',
  cost_code: 'Cost code',
  quantity: 'Qty',
  rate: 'Rate',
  tax: 'Tax',
  amount: 'Amount',
  custom: 'Custom line fields',
};

/** Plain-English help for the design screen. */
export const COLUMN_HELP: Record<InvoiceColumn, string> = {
  item: 'The product or service item on the line, when the line has one.',
  description: 'What you did or sold. Always printed.',
  service_date: 'The date the work was done, when the line has one.',
  job: 'The job the invoice bills.',
  cost_code: 'The job cost code on the line (for example 03-100 Concrete).',
  quantity: 'How many.',
  rate: 'Price per unit.',
  tax: 'Sales tax on each taxable line. The lines add up to the tax total.',
  amount: 'Line total. Always printed.',
  custom: 'The custom line fields you define below, one column each.',
};

/** A label/value pair printed in the header (under the invoice details) or the footer. */
export interface TemplateCustomField {
  label: string;
  value: string;
  placement: 'HEADER' | 'FOOTER';
}

/** A custom per-line column; each line stores its value under `key` in custom_fields. */
export interface TemplateLineField {
  key: string;
  label: string;
}

export interface InvoiceTemplate {
  id: string | null;            // null = the built-in template (nothing saved yet)
  org_id: string | null;
  location_id: string | null;   // null = organization-wide
  name: string;
  is_default: boolean;
  style: InvoiceLayout;
  font: InvoiceFont;
  accent_color: string;
  logo_url: string | null;
  visible_columns: InvoiceColumn[];
  custom_fields: TemplateCustomField[];
  line_fields: TemplateLineField[];
  remit_to: string | null;
  footer_text: string | null;
  default_message: string | null;
  terms_text: string | null;
  payment_instructions: string | null;
  show_qr: boolean;
  show_pay_button: boolean;
  attachments_allowed: boolean;
  updated_at: string | null;
}

/** Merit Electric Blue — the brand default (never the old emerald). */
export const DEFAULT_ACCENT = '#2563EB';
export const DEFAULT_COLUMNS: InvoiceColumn[] = ['description', 'quantity', 'rate', 'amount'];

export const BUILT_IN_TEMPLATE: InvoiceTemplate = {
  id: null,
  org_id: null,
  location_id: null,
  name: 'Standard',
  is_default: true,
  style: 'MODERN',
  font: 'SANS',
  accent_color: DEFAULT_ACCENT,
  logo_url: null,
  visible_columns: DEFAULT_COLUMNS,
  custom_fields: [],
  line_fields: [],
  remit_to: null,
  footer_text: null,
  default_message: null,
  terms_text: null,
  payment_instructions: null,
  show_qr: true,
  show_pay_button: true,
  attachments_allowed: true,
  updated_at: null,
};

/** The columns every template row read selects (Rule 11: matches migrations 050 + 176). */
export const TEMPLATE_SELECT =
  'id, org_id, location_id, name, is_default, style, font, accent_color, logo_url, visible_columns, ' +
  'custom_fields, line_fields, remit_to, footer_text, default_message, terms_text, payment_instructions, ' +
  'show_qr, show_pay_button, attachments_allowed, updated_at';

const isLayout = (v: unknown): v is InvoiceLayout => typeof v === 'string' && (INVOICE_LAYOUTS as readonly string[]).includes(v);
const isFont = (v: unknown): v is InvoiceFont => typeof v === 'string' && (INVOICE_FONTS as readonly string[]).includes(v);
const isColumn = (v: unknown): v is InvoiceColumn => typeof v === 'string' && (INVOICE_COLUMNS as readonly string[]).includes(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

/** Keep the canonical order, force the required columns on, drop unknowns. */
export function normalizeColumns(cols: readonly unknown[] | null | undefined): InvoiceColumn[] {
  const set = new Set((cols ?? []).filter(isColumn));
  for (const c of REQUIRED_COLUMNS) set.add(c);
  return INVOICE_COLUMNS.filter((c) => set.has(c));
}

function customFields(v: unknown): TemplateCustomField[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((f): TemplateCustomField[] => {
    if (!f || typeof f !== 'object') return [];
    const o = f as Record<string, unknown>;
    const label = str(o.label);
    if (!label) return [];
    return [{ label, value: typeof o.value === 'string' ? o.value : '', placement: o.placement === 'FOOTER' ? 'FOOTER' : 'HEADER' }];
  });
}

function lineFields(v: unknown): TemplateLineField[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((f): TemplateLineField[] => {
    if (!f || typeof f !== 'object') return [];
    const o = f as Record<string, unknown>;
    const key = str(o.key);
    const label = str(o.label);
    return key && label ? [{ key, label }] : [];
  });
}

/** A DB row (any shape PostgREST hands back) → a fully-populated template. */
export function templateFromRow(row: Record<string, unknown> | null | undefined): InvoiceTemplate {
  if (!row) return BUILT_IN_TEMPLATE;
  const accent = typeof row.accent_color === 'string' && /^#[0-9a-f]{6}$/i.test(row.accent_color) ? row.accent_color : DEFAULT_ACCENT;
  return {
    id: typeof row.id === 'string' ? row.id : null,
    org_id: typeof row.org_id === 'string' ? row.org_id : null,
    location_id: typeof row.location_id === 'string' ? row.location_id : null,
    name: str(row.name) ?? 'Standard',
    is_default: row.is_default === true,
    style: isLayout(row.style) ? row.style : 'MODERN',
    font: isFont(row.font) ? row.font : 'SANS',
    // A legacy emerald default is shown as the brand default it should have been.
    accent_color: accent.toLowerCase() === '#10b981' ? DEFAULT_ACCENT : accent,
    // Only the tenant's own uploaded logo ever reaches a renderer (the PDF fetches it).
    logo_url: tenantLogoOrNull(str(row.logo_url), typeof row.org_id === 'string' ? row.org_id : null),
    visible_columns: normalizeColumns(Array.isArray(row.visible_columns) ? row.visible_columns : DEFAULT_COLUMNS),
    custom_fields: customFields(row.custom_fields),
    line_fields: lineFields(row.line_fields),
    remit_to: str(row.remit_to),
    footer_text: str(row.footer_text),
    default_message: str(row.default_message),
    terms_text: str(row.terms_text),
    payment_instructions: str(row.payment_instructions),
    show_qr: row.show_qr !== false,
    show_pay_button: row.show_pay_button !== false,
    attachments_allowed: row.attachments_allowed !== false,
    updated_at: typeof row.updated_at === 'string' ? row.updated_at : null,
  };
}

/**
 * Validation for invoice design templates — shared by the routes (server truth) and
 * the design screen (inline errors). Limits match migration 176's CHECKs.
 */

import { z } from 'zod';
import { INVOICE_COLUMNS, INVOICE_FONTS, INVOICE_LAYOUTS, normalizeColumns, type InvoiceTemplate } from './types';

const text = (max: number) => z.string().max(max).nullable().optional().transform((v) => (v && v.trim() ? v : null));

export const customFieldSchema = z.object({
  label: z.string().trim().min(1, 'Give the field a label').max(40),
  value: z.string().max(200).default(''),
  placement: z.enum(['HEADER', 'FOOTER']).default('HEADER'),
});

export const lineFieldSchema = z.object({
  key: z.string().trim().regex(/^[a-z][a-z0-9_]{0,31}$/, 'Use lowercase letters, numbers and _'),
  label: z.string().trim().min(1, 'Give the column a label').max(30),
});

export const templateBodySchema = z.object({
  name: z.string().trim().min(1, 'Name the template').max(80),
  style: z.enum(INVOICE_LAYOUTS),
  font: z.enum(INVOICE_FONTS),
  accent_color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a colour like #2563EB'),
  logo_url: z.string().url('Upload a logo').max(1000).nullable().optional()
    .refine((v) => !v || /^https:\/\//.test(v), 'Upload the logo here'),
  visible_columns: z.array(z.enum(INVOICE_COLUMNS)).max(INVOICE_COLUMNS.length).transform((c) => normalizeColumns(c)),
  custom_fields: z.array(customFieldSchema).max(8, 'At most 8 custom fields'),
  line_fields: z.array(lineFieldSchema).max(4, 'At most 4 custom line columns')
    .refine((a) => new Set(a.map((f) => f.key)).size === a.length, 'Each custom line column needs its own key'),
  remit_to: text(500),
  footer_text: text(300),
  default_message: text(1000),
  terms_text: text(2000),
  payment_instructions: text(1000),
  show_qr: z.boolean(),
  show_pay_button: z.boolean(),
  attachments_allowed: z.boolean(),
  /** Print with the company brand's logo / colour / font (FPB-branding §4.3). */
  inherit_brand: z.boolean().default(true),
});

export type TemplateBody = z.infer<typeof templateBodySchema>;

export const createTemplateSchema = templateBodySchema.extend({
  location_id: z.string().uuid().nullable(),
  make_default: z.boolean().optional(),
});

export const patchTemplateSchema = templateBodySchema.partial().strict();

/** Template → the editable body (what the design screen holds in state). */
export function bodyFromTemplate(t: InvoiceTemplate): TemplateBody {
  return {
    name: t.name,
    style: t.style,
    font: t.font,
    accent_color: t.accent_color,
    logo_url: t.logo_url,
    visible_columns: t.visible_columns,
    custom_fields: t.custom_fields,
    line_fields: t.line_fields,
    remit_to: t.remit_to,
    footer_text: t.footer_text,
    default_message: t.default_message,
    terms_text: t.terms_text,
    payment_instructions: t.payment_instructions,
    show_qr: t.show_qr,
    show_pay_button: t.show_pay_button,
    attachments_allowed: t.attachments_allowed,
    inherit_brand: t.inherit_brand,
  };
}

/** A name not already used in the scope: "Copy of Standard", "Copy of Standard (2)". */
export function uniqueName(base: string, taken: ReadonlyArray<string>): string {
  const lower = new Set(taken.map((n) => n.toLowerCase()));
  const root = base.slice(0, 70);
  if (!lower.has(root.toLowerCase())) return root;
  for (let i = 2; i < 100; i++) {
    const candidate = `${root} (${i})`;
    if (!lower.has(candidate.toLowerCase())) return candidate;
  }
  return `${root} ${Date.now()}`.slice(0, 80);
}

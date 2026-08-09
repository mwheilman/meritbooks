import { z } from 'zod';

/**
 * A normalized, transport-safe model of ANY financial statement, used as the
 * single interchange format between the client (which fetches the report data
 * under RLS and builds the model) and the server PDF renderer / the client CSV
 * writer. Keeping one model means the PDF and the spreadsheet always agree with
 * each other AND with the on-screen figures (FPB Dimension 7, AC7.1/AC7.2).
 *
 * Money is carried as BIGINT CENTS (CANON-ANCHOR §2 — never floats); the
 * renderers convert to display units at the edge (formatMoney for the PDF,
 * centsToDollars for the spreadsheet's numeric cells).
 */

export type RowKind = 'section' | 'account' | 'subtotal' | 'total' | 'spacer' | 'note';

export const stmtColumnSchema = z.object({
  key: z.string(),
  label: z.string(),
  /** True → cell values are bigint cents and are formatted as currency. */
  money: z.boolean().optional(),
});

export const stmtRowSchema = z.object({
  kind: z.enum(['section', 'account', 'subtotal', 'total', 'spacer', 'note']),
  label: z.string().default(''),
  /** Optional leading code shown before the label (e.g. account number). */
  code: z.string().optional(),
  /** 0..5 — visual indent of the label cell. */
  indent: z.number().int().min(0).max(5).optional(),
  /** One entry per column. Cents (when the column is money) or a display string. */
  values: z.array(z.union([z.number(), z.string(), z.null()])).default([]),
});

export const statementModelSchema = z.object({
  title: z.string().min(1),
  entityLabel: z.string(),
  periodLabel: z.string(),
  basisLabel: z.string().optional(),
  generatedAt: z.string(),
  /** Brand accent (hex). Defaults to emerald in the renderer. */
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  columns: z.array(stmtColumnSchema).min(1),
  rows: z.array(stmtRowSchema),
});

export type StmtColumn = z.infer<typeof stmtColumnSchema>;
export type StmtRow = z.infer<typeof stmtRowSchema>;
export type StatementModel = z.infer<typeof statementModelSchema>;

/** slug for filenames — lowercase, hyphenated, ascii-safe. */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'statement';
}

/** e.g. buildExportFilename('Profit & Loss', 'pdf') → "profit-loss_2026-08-01.pdf" */
export function buildExportFilename(title: string, ext: 'pdf' | 'csv' | 'xlsx'): string {
  const stamp = new Date().toISOString().slice(0, 10);
  return `${slugify(title)}_${stamp}.${ext}`;
}

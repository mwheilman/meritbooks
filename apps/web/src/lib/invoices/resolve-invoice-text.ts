/**
 * Invoice text resolver (FPB §2/§3). Any customer-facing text slot is editable
 * at any scope and resolves most-specific-wins:
 *
 *   invoice (own column / INVOICE override) -> invoice_type -> job
 *     -> customer -> entity (invoice_templates) -> built-in default
 *
 * Pure + dependency-free: callers fetch the per-scope override rows and the
 * entity template, hand them in, and get back the resolved string per slot.
 */

export const TEXT_SLOTS = [
  'customer_message',
  'footer_text',
  'remit_to',
  'terms_note',
  'payment_instructions',
] as const;
export type TextSlot = (typeof TEXT_SLOTS)[number];

export type OverrideScope = 'CUSTOMER' | 'JOB' | 'INVOICE_TYPE' | 'INVOICE';

export interface TextOverrideRow {
  scope: OverrideScope;
  slot: string;
  value: string;
}

export interface TextResolveInput {
  /** invoice's own columns that double as the per-invoice value (e.g. customer_message). */
  invoiceColumns?: Partial<Record<TextSlot, string | null>>;
  /** rows from invoice_text_overrides for this invoice's customer/job/type/id. */
  overrides?: TextOverrideRow[];
  /** entity default from invoice_templates. */
  entity?: Partial<Record<TextSlot, string | null>>;
  /** built-in fallbacks. */
  defaults?: Partial<Record<TextSlot, string>>;
}

const ORDER: OverrideScope[] = ['INVOICE', 'INVOICE_TYPE', 'JOB', 'CUSTOMER'];

/** Resolve one slot. */
export function resolveTextSlot(slot: TextSlot, input: TextResolveInput): string | null {
  // 1. invoice's own column (most specific, e.g. a message typed on the invoice)
  const col = input.invoiceColumns?.[slot];
  if (col != null && String(col).trim() !== '') return String(col);

  // 2. override rows, most-specific scope first
  const rows = input.overrides ?? [];
  for (const scope of ORDER) {
    const hit = rows.find((r) => r.scope === scope && r.slot === slot && r.value?.trim() !== '');
    if (hit) return hit.value;
  }

  // 3. entity default
  const ent = input.entity?.[slot];
  if (ent != null && String(ent).trim() !== '') return String(ent);

  // 4. built-in default
  return input.defaults?.[slot] ?? null;
}

/** Resolve every known slot at once. */
export function resolveAllText(input: TextResolveInput): Record<TextSlot, string | null> {
  const out = {} as Record<TextSlot, string | null>;
  for (const slot of TEXT_SLOTS) out[slot] = resolveTextSlot(slot, input);
  return out;
}

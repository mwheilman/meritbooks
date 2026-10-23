import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveTextSlot, type TextOverrideRow } from './resolve-invoice-text';
import { resolveInvoiceTemplate, type TemplateSource } from './templates/resolve';
import { BUILT_IN_TEMPLATE, type InvoiceTemplate } from './templates/types';
import { allocateLineTax, type DocLineInput } from './templates/columns';
import { resolvePayLink, type PayLinkState } from './pay-link';

/**
 * Loads everything needed to render an invoice as a CUSTOMER-FACING document (PDF,
 * email, hosted pay page): header, lines, the customer, the issuing company, the
 * resolved design template (invoice → customer → company default → org default →
 * built-in), the resolved customer-facing text, and the pay-link state.
 *
 * Customer-facing rule (FPB-invoices §4, AC-1B.1): the document carries NO internal
 * GL account numbers or names. The only account fact read is the account TYPE, used
 * internally to tell taxable revenue lines from balance-sheet lines for the per-line
 * tax column; it is never put on the document.
 *
 * Cross-schema relations (customer / company / job / item) are fetched from `core`
 * separately and stitched — never a PostgREST embed (public<->core embeds 500).
 */

export type InvoiceDocLine = DocLineInput;

export interface InvoiceDoc {
  id: string;
  invoice_number: string;
  invoice_date: string;
  due_date: string;
  status: string;
  po_number: string | null;
  /** Payment terms code ('NET_30') as stored; `terms_label` is the printable form. */
  terms: string | null;
  terms_label: string | null;
  customer_message: string | null;
  public_token: string;
  payment_methods_allowed: string[] | null;
  card_surcharge_enabled: boolean | null;
  subtotal_cents: number;
  discount_cents: number;
  tax_cents: number;
  retainage_cents: number;
  total_cents: number;
  amount_paid_cents: number;
  balance_cents: number;
  bill_to: Record<string, unknown> | null;
  ship_to: Record<string, unknown> | null;
  lines: InvoiceDocLine[];
  customer: { id: string | null; name: string; email: string | null } | null;
  entity: { id: string | null; name: string; short_code: string | null } | null;
  job_label: string | null;
  /** The resolved design template with customer-facing text overrides applied. */
  template: InvoiceTemplate;
  template_source: TemplateSource;
  /** Invoice-level CC list (invoices.cc_emails). */
  cc_emails: string[];
  /** The customer's default CC list (customer_invoice_settings). */
  customer_cc_emails: string[];
  pay: PayLinkState;
}

const num = (v: unknown) => Number(v ?? 0);
const s = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

/** 'NET_30' → 'Net 30', 'DUE_ON_RECEIPT' → 'Due on receipt'; free text passes through. */
export function termsLabel(terms: string | null): string | null {
  if (!terms) return null;
  const m = /^NET_?(\d+)$/i.exec(terms.trim());
  if (m) return `Net ${m[1]}`;
  if (/^DUE_ON_RECEIPT$/i.test(terms.trim())) return 'Due on receipt';
  return terms.includes('_') ? terms.toLowerCase().replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) : terms;
}

const INVOICE_SELECT = `id, org_id, invoice_number, invoice_date, due_date, status, po_number, terms,
  customer_message, public_token, payment_methods_allowed, card_surcharge_enabled,
  subtotal_cents, discount_cents, tax_cents,
  retainage_cents, total_cents, amount_paid_cents, balance_cents,
  bill_to, ship_to, customer_id, location_id, job_id, invoice_type, template_id, cc_emails`;

/** Load by invoice id (authenticated routes). */
export async function loadInvoiceDocById(
  supabase: SupabaseClient,
  orgId: string,
  invoiceId: string
): Promise<InvoiceDoc | null> {
  const { data: inv } = await supabase
    .from('invoices')
    .select(INVOICE_SELECT)
    .eq('org_id', orgId)
    .eq('id', invoiceId)
    .single();
  if (!inv) return null;
  return hydrate(supabase, orgId, inv as Record<string, unknown>);
}

/** Load by public token (hosted customer view — no auth; pass the service role). */
export async function loadInvoiceDocByToken(
  supabase: SupabaseClient,
  token: string
): Promise<{ doc: InvoiceDoc; orgId: string } | null> {
  if (!/^[0-9a-f-]{36}$/i.test(token)) return null;
  const { data: inv } = await supabase
    .from('invoices')
    .select(INVOICE_SELECT)
    .eq('public_token', token)
    .single();
  if (!inv) return null;
  const orgId = (inv as Record<string, unknown>).org_id as string;
  const doc = await hydrate(supabase, orgId, inv as Record<string, unknown>);
  return doc ? { doc, orgId } : null;
}

/** Customer address from the master record — the fallback when no snapshot was taken. */
function addressFromCustomer(c: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!c) return null;
  const cityLine = [s(c.city), [s(c.state), s(c.zip)].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const out: Record<string, unknown> = {};
  if (s(c.address_line1)) out.line1 = c.address_line1;
  if (s(c.address_line2)) out.line2 = c.address_line2;
  if (cityLine) out.city_state_zip = cityLine;
  return Object.keys(out).length ? out : null;
}

async function hydrate(
  supabase: SupabaseClient,
  orgId: string,
  inv: Record<string, unknown>
): Promise<InvoiceDoc | null> {
  const invoiceId = inv.id as string;
  const customerId = s(inv.customer_id);
  const locationId = s(inv.location_id);
  const jobId = s(inv.job_id);

  const { data: lineRows } = await supabase
    .from('invoice_lines')
    .select(`line_number, description, quantity, unit_price_cents, amount_cents,
             service_date, item_id, cost_code_id, custom_fields,
             account:accounts!invoice_lines_account_id_fkey(account_type)`)
    .eq('invoice_id', invoiceId)
    .order('line_number', { ascending: true });
  const rawLines = (lineRows ?? []) as Record<string, unknown>[];

  const itemIds = [...new Set(rawLines.map((l) => s(l.item_id)).filter((x): x is string => !!x))];
  const codeIds = [...new Set(rawLines.map((l) => s(l.cost_code_id)).filter((x): x is string => !!x))];

  const [{ data: cust }, { data: loc }, { data: job }, items, codes, resolved, ovRes] = await Promise.all([
    customerId
      ? supabase.schema('core').from('customers')
          .select('id, name, display_name, email, address_line1, address_line2, city, state, zip')
          .eq('org_id', orgId).eq('id', customerId).maybeSingle()
      : Promise.resolve({ data: null }),
    locationId
      ? supabase.schema('core').from('locations').select('id, name, short_code').eq('org_id', orgId).eq('id', locationId).maybeSingle()
      : Promise.resolve({ data: null }),
    jobId
      ? supabase.schema('core').from('jobs').select('job_number, name').eq('org_id', orgId).eq('id', jobId).maybeSingle()
      : Promise.resolve({ data: null }),
    itemIds.length
      ? supabase.schema('core').from('items').select('id, name').eq('org_id', orgId).in('id', itemIds)
      : Promise.resolve({ data: [] }),
    codeIds.length
      ? supabase.from('job_cost_codes').select('id, code, name').eq('org_id', orgId).in('id', codeIds)
      : Promise.resolve({ data: [] }),
    resolveInvoiceTemplate(supabase, orgId, {
      template_id: s(inv.template_id), customer_id: customerId, location_id: locationId,
    }).catch(() => ({ template: BUILT_IN_TEMPLATE, source: 'BUILT_IN' as const, customerCc: [] as string[] })),
    // Customer-facing text overrides (invoice → invoice_type → job → customer → template).
    supabase.from('invoice_text_overrides').select('scope, slot, value').eq('org_id', orgId)
      .in('scope_ref', [invoiceId, s(inv.invoice_type), jobId, customerId].filter((x): x is string => !!x)),
  ]);

  const itemName = new Map(((items.data ?? []) as Array<{ id: string; name: string }>).map((i) => [i.id, i.name]));
  const codeLabel = new Map(((codes.data ?? []) as Array<{ id: string; code: string; name: string }>)
    .map((c) => [c.id, `${c.code} ${c.name}`.trim()]));

  const overrides = (ovRes.data ?? []) as TextOverrideRow[];
  const tpl = resolved.template;
  const entity = {
    customer_message: tpl.default_message,
    footer_text: tpl.footer_text,
    remit_to: tpl.remit_to,
    terms_note: tpl.terms_text,
    payment_instructions: tpl.payment_instructions,
  };
  const text = (slot: 'customer_message' | 'footer_text' | 'remit_to' | 'terms_note' | 'payment_instructions') =>
    resolveTextSlot(slot, {
      invoiceColumns: slot === 'customer_message' ? { customer_message: s(inv.customer_message) } : undefined,
      overrides,
      entity,
    });

  const taxCents = num(inv.tax_cents);
  const isTaxable = (l: Record<string, unknown>) => {
    const a = l.account as { account_type?: string } | Array<{ account_type?: string }> | null;
    const t = Array.isArray(a) ? a[0]?.account_type : a?.account_type;
    return t === 'REVENUE';
  };
  const taxes = allocateLineTax(rawLines.map((l) => ({ amount_cents: num(l.amount_cents), taxable: isTaxable(l) })), taxCents);

  const lines: InvoiceDocLine[] = rawLines.map((l, i) => {
    const cf = l.custom_fields && typeof l.custom_fields === 'object' && !Array.isArray(l.custom_fields)
      ? Object.fromEntries(Object.entries(l.custom_fields as Record<string, unknown>).map(([k, v]) => [k, v == null ? '' : String(v)]))
      : {};
    return {
      line_number: num(l.line_number),
      description: String(l.description ?? ''),
      quantity: num(l.quantity),
      unit_price_cents: num(l.unit_price_cents),
      amount_cents: num(l.amount_cents),
      item_label: s(l.item_id) ? itemName.get(l.item_id as string) ?? null : null,
      service_date: s(l.service_date),
      cost_code_label: s(l.cost_code_id) ? codeLabel.get(l.cost_code_id as string) ?? null : null,
      tax_cents: taxes[i],
      custom_fields: cf,
    };
  });

  const c = cust as Record<string, unknown> | null;
  const l = loc as { id: string; name: string; short_code: string | null } | null;
  const j = job as { job_number: string | null; name: string | null } | null;

  const pay = await resolvePayLink(supabase, orgId, {
    public_token: String(inv.public_token ?? ''),
    status: String(inv.status ?? ''),
    balance_cents: num(inv.balance_cents),
    location_id: locationId,
    customer_id: customerId,
    job_id: jobId,
    payment_methods_allowed: (inv.payment_methods_allowed as string[] | null) ?? null,
  }).catch((e: unknown) => {
    console.error('[invoice-doc] pay-link resolution failed', e);
    // Fail closed: no pay link rather than a link we can't vouch for.
    return {
      url: '', payable: false, mode: null, methods: [], code: 'NO_CONNECTION' as const,
      reason: 'Online payment status could not be checked.',
    };
  });

  return {
    id: invoiceId,
    invoice_number: String(inv.invoice_number ?? ''),
    invoice_date: String(inv.invoice_date ?? ''),
    due_date: String(inv.due_date ?? ''),
    status: String(inv.status ?? ''),
    po_number: s(inv.po_number),
    terms: s(inv.terms),
    terms_label: termsLabel(s(inv.terms)),
    customer_message: text('customer_message'),
    public_token: String(inv.public_token ?? ''),
    payment_methods_allowed: (inv.payment_methods_allowed as string[]) ?? null,
    card_surcharge_enabled: (inv.card_surcharge_enabled as boolean) ?? null,
    subtotal_cents: num(inv.subtotal_cents),
    discount_cents: num(inv.discount_cents),
    tax_cents: taxCents,
    retainage_cents: num(inv.retainage_cents),
    total_cents: num(inv.total_cents),
    amount_paid_cents: num(inv.amount_paid_cents),
    balance_cents: num(inv.balance_cents),
    bill_to: (inv.bill_to as Record<string, unknown>) ?? addressFromCustomer(c),
    ship_to: (inv.ship_to as Record<string, unknown>) ?? null,
    lines,
    customer: c ? { id: s(c.id), name: s(c.display_name) ?? String(c.name ?? ''), email: s(c.email) } : null,
    entity: l ? { id: l.id, name: l.name, short_code: l.short_code } : null,
    job_label: j ? [j.job_number, j.name].filter(Boolean).join(' · ') || null : null,
    template: {
      ...tpl,
      remit_to: text('remit_to'),
      footer_text: text('footer_text'),
      terms_text: text('terms_note'),
      payment_instructions: text('payment_instructions'),
    },
    template_source: resolved.source,
    cc_emails: Array.isArray(inv.cc_emails) ? (inv.cc_emails as string[]) : [],
    customer_cc_emails: resolved.customerCc,
    pay,
  };
}

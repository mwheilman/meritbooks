import { SupabaseClient } from '@supabase/supabase-js';
import { resolveTextSlot, type TextOverrideRow } from './resolve-invoice-text';

/**
 * Loads everything needed to render an invoice as a document (PDF or hosted
 * page): header, lines with their revenue account, the customer, the issuing
 * entity, and the entity's branding template. Cross-schema relations
 * (customer/location) are fetched from `core` separately and stitched — never a
 * PostgREST embed (public<->core embeds 500).
 */

export interface InvoiceDocLine {
  line_number: number;
  description: string;
  quantity: number;
  unit_price_cents: number;
  amount_cents: number;
  account: { account_number: string; name: string } | null;
}

export interface InvoiceDoc {
  id: string;
  invoice_number: string;
  invoice_date: string;
  due_date: string;
  status: string;
  po_number: string | null;
  terms: string | null;
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
  customer: { name: string; email: string | null } | null;
  entity: { name: string; short_code: string | null } | null;
  template: {
    style: string | null;
    logo_url: string | null;
    accent_color: string;
    remit_to: string | null;
    footer_text: string | null;
  } | null;
}

const num = (v: unknown) => Number(v ?? 0);

/** Load by invoice id (authenticated routes). */
export async function loadInvoiceDocById(
  supabase: SupabaseClient,
  orgId: string,
  invoiceId: string
): Promise<InvoiceDoc | null> {
  const { data: inv } = await supabase
    .from('invoices')
    .select(`id, invoice_number, invoice_date, due_date, status, po_number, terms,
             customer_message, public_token, payment_methods_allowed, card_surcharge_enabled,
             subtotal_cents, discount_cents, tax_cents,
             retainage_cents, total_cents, amount_paid_cents, balance_cents,
             bill_to, ship_to, customer_id, location_id, job_id, invoice_type`)
    .eq('org_id', orgId)
    .eq('id', invoiceId)
    .single();
  if (!inv) return null;
  return hydrate(supabase, orgId, inv as Record<string, unknown>);
}

/** Load by public token (hosted customer view — no auth). */
export async function loadInvoiceDocByToken(
  supabase: SupabaseClient,
  token: string
): Promise<{ doc: InvoiceDoc; orgId: string } | null> {
  const { data: inv } = await supabase
    .from('invoices')
    .select(`id, org_id, invoice_number, invoice_date, due_date, status, po_number, terms,
             customer_message, public_token, payment_methods_allowed, card_surcharge_enabled,
             subtotal_cents, discount_cents, tax_cents,
             retainage_cents, total_cents, amount_paid_cents, balance_cents,
             bill_to, ship_to, customer_id, location_id, job_id, invoice_type`)
    .eq('public_token', token)
    .single();
  if (!inv) return null;
  const orgId = (inv as Record<string, unknown>).org_id as string;
  const doc = await hydrate(supabase, orgId, inv as Record<string, unknown>);
  return doc ? { doc, orgId } : null;
}

async function hydrate(
  supabase: SupabaseClient,
  orgId: string,
  inv: Record<string, unknown>
): Promise<InvoiceDoc | null> {
  const invoiceId = inv.id as string;

  const { data: lineRows } = await supabase
    .from('invoice_lines')
    .select(`line_number, description, quantity, unit_price_cents, amount_cents,
             account:accounts!invoice_lines_account_id_fkey(account_number, name)`)
    .eq('invoice_id', invoiceId)
    .order('line_number', { ascending: true });

  const [{ data: cust }, { data: loc }, { data: tmpl }] = await Promise.all([
    inv.customer_id
      ? supabase.schema('core').from('customers').select('name, email').eq('id', inv.customer_id).maybeSingle()
      : Promise.resolve({ data: null }),
    inv.location_id
      ? supabase.schema('core').from('locations').select('name, short_code').eq('id', inv.location_id).maybeSingle()
      : Promise.resolve({ data: null }),
    inv.location_id
      ? supabase.from('invoice_templates').select('style, logo_url, accent_color, remit_to, footer_text, default_message')
          .eq('org_id', orgId).eq('location_id', inv.location_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  // Resolve customer-facing text via the override cascade
  // (invoice → invoice_type → job → customer → entity → default).
  const refList = [
    String(invoiceId),
    inv.invoice_type ? String(inv.invoice_type) : null,
    inv.job_id ? String(inv.job_id) : null,
    inv.customer_id ? String(inv.customer_id) : null,
  ].filter(Boolean) as string[];
  let overrideRows: TextOverrideRow[] = [];
  if (refList.length) {
    const { data: ov } = await supabase
      .from('invoice_text_overrides')
      .select('scope, slot, value')
      .eq('org_id', orgId)
      .in('scope_ref', refList);
    overrideRows = (ov ?? []) as TextOverrideRow[];
  }
  const tpl = (tmpl as Record<string, unknown> | null) ?? null;
  const entText = {
    customer_message: (tpl?.default_message as string) ?? null,
    footer_text: (tpl?.footer_text as string) ?? null,
    remit_to: (tpl?.remit_to as string) ?? null,
  };
  const resolvedMessage = resolveTextSlot('customer_message', { invoiceColumns: { customer_message: (inv.customer_message as string) ?? null }, overrides: overrideRows, entity: entText });
  const resolvedFooter = resolveTextSlot('footer_text', { overrides: overrideRows, entity: entText });
  const resolvedRemit = resolveTextSlot('remit_to', { overrides: overrideRows, entity: entText });

  const lines: InvoiceDocLine[] = (lineRows ?? []).map((l: Record<string, unknown>) => {
    const acct = l.account as { account_number: string; name: string } | { account_number: string; name: string }[] | null;
    return {
      line_number: num(l.line_number),
      description: String(l.description ?? ''),
      quantity: num(l.quantity),
      unit_price_cents: num(l.unit_price_cents),
      amount_cents: num(l.amount_cents),
      account: Array.isArray(acct) ? acct[0] ?? null : acct,
    };
  });

  return {
    id: invoiceId,
    invoice_number: String(inv.invoice_number ?? ''),
    invoice_date: String(inv.invoice_date ?? ''),
    due_date: String(inv.due_date ?? ''),
    status: String(inv.status ?? ''),
    po_number: (inv.po_number as string) ?? null,
    terms: (inv.terms as string) ?? null,
    customer_message: resolvedMessage,
    public_token: String(inv.public_token ?? ''),
    payment_methods_allowed: (inv.payment_methods_allowed as string[]) ?? null,
    card_surcharge_enabled: (inv.card_surcharge_enabled as boolean) ?? null,
    subtotal_cents: num(inv.subtotal_cents),
    discount_cents: num(inv.discount_cents),
    tax_cents: num(inv.tax_cents),
    retainage_cents: num(inv.retainage_cents),
    total_cents: num(inv.total_cents),
    amount_paid_cents: num(inv.amount_paid_cents),
    balance_cents: num(inv.balance_cents),
    bill_to: (inv.bill_to as Record<string, unknown>) ?? null,
    ship_to: (inv.ship_to as Record<string, unknown>) ?? null,
    lines,
    customer: (cust as { name: string; email: string | null }) ?? null,
    entity: (loc as { name: string; short_code: string | null }) ?? null,
    template: tpl
      ? { ...(tpl as InvoiceDoc['template'] as object), footer_text: resolvedFooter, remit_to: resolvedRemit } as InvoiceDoc['template']
      : ({ style: null, logo_url: null, accent_color: '#10b981', remit_to: resolvedRemit, footer_text: resolvedFooter } as InvoiceDoc['template']),
  };
}

import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Loads everything needed to render an estimate as a PDF document: the header,
 * its lines (with the chosen revenue account), the customer, the issuing entity,
 * and that entity's branding template. Cross-schema relations (customer/location)
 * are fetched from `core` separately and stitched — never a PostgREST embed
 * (public↔core embeds 500). Mirrors invoice-doc so the estimate PDF looks like a
 * sibling of the invoice PDF.
 */

export interface EstimateDocLine {
  line_number: number;
  description: string;
  quantity: number;
  unit_price_cents: number;
  amount_cents: number;
  account: { account_number: string; name: string } | null;
}

export interface EstimateDoc {
  id: string;
  estimate_number: string;
  estimate_date: string;
  expiration_date: string | null;
  status: string;
  notes: string | null;
  subtotal_cents: number;
  tax_cents: number;
  total_cents: number;
  currency: string;
  lines: EstimateDocLine[];
  customer: { name: string; email: string | null } | null;
  entity: { name: string; short_code: string | null } | null;
  template: {
    logo_url: string | null;
    accent_color: string;
    remit_to: string | null;
    footer_text: string | null;
  } | null;
}

const num = (v: unknown) => Number(v ?? 0);

/** Load an estimate document by id (authenticated, RLS-scoped context). */
export async function loadEstimateDocById(
  supabase: SupabaseClient,
  orgId: string,
  estimateId: string,
): Promise<EstimateDoc | null> {
  const { data: est } = await supabase
    .from('estimates')
    .select(
      `id, estimate_number, estimate_date, expiration_date, status, notes,
       subtotal_cents, tax_cents, total_cents, currency,
       customer_id, location_id`,
    )
    .eq('org_id', orgId)
    .eq('id', estimateId)
    .maybeSingle();

  if (!est) return null;
  const e = est as Record<string, unknown>;

  const { data: lineRows } = await supabase
    .from('estimate_lines')
    .select('line_number, description, quantity, unit_price_cents, amount_cents, revenue_account_id')
    .eq('estimate_id', estimateId)
    .order('line_number', { ascending: true });

  const rawLines = (lineRows ?? []) as Array<Record<string, unknown>>;
  const accountIds = [
    ...new Set(rawLines.map((l) => l.revenue_account_id).filter(Boolean)),
  ] as string[];

  const [{ data: cust }, { data: loc }, { data: tmpl }, { data: acctRows }] = await Promise.all([
    e.customer_id
      ? supabase.schema('core').from('customers').select('name, email').eq('id', e.customer_id).maybeSingle()
      : Promise.resolve({ data: null }),
    e.location_id
      ? supabase.schema('core').from('locations').select('name, short_code').eq('id', e.location_id).maybeSingle()
      : Promise.resolve({ data: null }),
    e.location_id
      ? supabase
          .from('invoice_templates')
          .select('logo_url, accent_color, remit_to, footer_text')
          .eq('org_id', orgId)
          .eq('location_id', e.location_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    accountIds.length
      ? supabase.from('accounts').select('id, account_number, name').in('id', accountIds)
      : Promise.resolve({ data: [] as Record<string, unknown>[] }),
  ]);

  const acctById = new Map(
    ((acctRows ?? []) as Array<Record<string, unknown>>).map((a) => [a.id as string, a]),
  );

  const lines: EstimateDocLine[] = rawLines.map((l) => {
    const acct = l.revenue_account_id ? acctById.get(l.revenue_account_id as string) : null;
    return {
      line_number: num(l.line_number),
      description: String(l.description ?? ''),
      quantity: num(l.quantity),
      unit_price_cents: num(l.unit_price_cents),
      amount_cents: num(l.amount_cents),
      account: acct
        ? { account_number: String(acct.account_number), name: String(acct.name) }
        : null,
    };
  });

  const tpl = (tmpl as Record<string, unknown> | null) ?? null;

  return {
    id: String(e.id),
    estimate_number: String(e.estimate_number ?? ''),
    estimate_date: String(e.estimate_date ?? ''),
    expiration_date: (e.expiration_date as string) ?? null,
    status: String(e.status ?? ''),
    notes: (e.notes as string) ?? null,
    subtotal_cents: num(e.subtotal_cents),
    tax_cents: num(e.tax_cents),
    total_cents: num(e.total_cents),
    currency: String(e.currency ?? 'USD'),
    lines,
    customer: (cust as { name: string; email: string | null }) ?? null,
    entity: (loc as { name: string; short_code: string | null }) ?? null,
    template: tpl
      ? {
          logo_url: (tpl.logo_url as string) ?? null,
          accent_color: (tpl.accent_color as string) ?? '#10b981',
          remit_to: (tpl.remit_to as string) ?? null,
          footer_text: (tpl.footer_text as string) ?? null,
        }
      : { logo_url: null, accent_color: '#10b981', remit_to: null, footer_text: null },
  };
}

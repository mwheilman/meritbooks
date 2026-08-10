import type { SupabaseClient } from '@supabase/supabase-js';
import { agingBucketFor, type AgingBucket } from '@/lib/invoices/statement';

/**
 * Loads everything the CUSTOMER PORTAL page renders for ONE customer: identity,
 * open balance + aging, and their full invoice list (open + paid) with each open
 * invoice's per-invoice pay token so the "Pay" button routes into the EXISTING
 * /pay/[token] flow (no new payment path is introduced here).
 *
 * SECURITY: this is the public, no-session path. The caller passes the SERVICE-ROLE
 * (admin) client plus the org_id + customer_id resolved from the magic-link token,
 * and EVERY query below filters by BOTH org_id AND customer_id. Cross-schema
 * (core.customers / core.locations) is fetched separately and stitched — never a
 * public<->core PostgREST embed. Returns null when the customer doesn't exist in
 * that org (defence in depth against a stale/mismatched token row).
 */

const num = (v: unknown): number => Number(v ?? 0);

export interface PortalInvoice {
  id: string;
  invoiceNumber: string;
  invoiceDate: string; // YYYY-MM-DD
  dueDate: string; // YYYY-MM-DD
  totalCents: number;
  paidCents: number;
  balanceCents: number;
  status: string;
  /** True when there's still a balance owed and the invoice isn't voided/written off. */
  isOpen: boolean;
  overdue: boolean;
  bucket: AgingBucket | null;
  /** Per-invoice hosted-pay token (invoices.public_token) — links to /pay/<token>. */
  payToken: string | null;
}

export interface CustomerPortalData {
  customer: { id: string; name: string; email: string | null };
  entity: { name: string } | null;
  branding: { logoUrl: string | null; accentColor: string };
  asOf: string; // YYYY-MM-DD
  invoices: PortalInvoice[];
  totalBalanceCents: number;
  openInvoiceCount: number;
  paidInvoiceCount: number;
}

export async function loadCustomerPortal(
  admin: SupabaseClient,
  orgId: string,
  customerId: string,
  now: Date = new Date(),
): Promise<CustomerPortalData | null> {
  const asOf = now.toISOString().slice(0, 10);

  // Customer identity — scoped to BOTH org and id.
  const { data: cust } = await admin
    .schema('core')
    .from('customers')
    .select('id, name, display_name, email, location_id')
    .eq('org_id', orgId)
    .eq('id', customerId)
    .maybeSingle();
  if (!cust) return null;
  const c = cust as Record<string, unknown>;

  // Invoices for THIS customer only. VOIDED never appears (reversed, no
  // obligation). Newest first so the customer sees current activity on top.
  const { data: invRows } = await admin
    .from('invoices')
    .select('id, invoice_number, invoice_date, due_date, total_cents, amount_paid_cents, balance_cents, status, location_id, public_token')
    .eq('org_id', orgId)
    .eq('customer_id', customerId)
    .neq('status', 'VOIDED')
    .order('invoice_date', { ascending: false });
  const rows = (invRows ?? []) as Array<Record<string, unknown>>;

  let totalBalanceCents = 0;
  let openInvoiceCount = 0;
  let paidInvoiceCount = 0;

  const invoices: PortalInvoice[] = rows.map((r) => {
    const balanceCents = num(r.balance_cents);
    const status = String(r.status ?? '');
    const dueDate = String(r.due_date ?? '');
    // "Open" = still owed and not written off. Written-off invoices carry a paper
    // balance we never invite payment on.
    const isOpen = balanceCents > 0 && status !== 'WRITTEN_OFF';
    if (isOpen) {
      totalBalanceCents += balanceCents;
      openInvoiceCount += 1;
    } else if (status === 'PAID' || balanceCents <= 0) {
      paidInvoiceCount += 1;
    }
    return {
      id: String(r.id),
      invoiceNumber: String(r.invoice_number ?? ''),
      invoiceDate: String(r.invoice_date ?? ''),
      dueDate,
      totalCents: num(r.total_cents),
      paidCents: num(r.amount_paid_cents),
      balanceCents,
      status,
      isOpen,
      overdue: isOpen && !!dueDate && dueDate < asOf,
      bucket: isOpen ? agingBucketFor(dueDate, asOf) : null,
      payToken: isOpen ? ((r.public_token as string) ?? null) : null,
    };
  });

  // Branding + issuing entity: the customer's home location, else the location
  // that issued the most of these invoices, else none. Same convention as the
  // statement loader so the portal reads as one system with invoices/statements.
  const locationId =
    (c.location_id as string | null) ?? mostCommonLocation(rows) ?? null;

  const [{ data: loc }, { data: tmpl }] = await Promise.all([
    locationId
      ? admin.schema('core').from('locations').select('name').eq('id', locationId).maybeSingle()
      : Promise.resolve({ data: null }),
    locationId
      ? admin
          .from('invoice_templates')
          .select('logo_url, accent_color')
          .eq('org_id', orgId)
          .eq('location_id', locationId)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  const t = (tmpl as Record<string, unknown> | null) ?? null;

  return {
    customer: {
      id: String(c.id),
      name: String(c.display_name || c.name || ''),
      email: (c.email as string) ?? null,
    },
    entity: loc ? { name: String((loc as Record<string, unknown>).name ?? '') } : null,
    branding: {
      logoUrl: (t?.logo_url as string) ?? null,
      accentColor: (t?.accent_color as string) || '#10b981',
    },
    asOf,
    invoices,
    totalBalanceCents,
    openInvoiceCount,
    paidInvoiceCount,
  };
}

function mostCommonLocation(rows: Array<Record<string, unknown>>): string | null {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const id = r.location_id as string | null;
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [id, n] of counts) {
    if (n > bestN) {
      best = id;
      bestN = n;
    }
  }
  return best;
}

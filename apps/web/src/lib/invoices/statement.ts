import type { SupabaseClient } from '@supabase/supabase-js';
import { buildActivityLedger, type StatementTxn } from '@/lib/ar/activity-ledger';

export type { StatementTxn } from '@/lib/ar/activity-ledger';

/**
 * AR CUSTOMER STATEMENT (FPB-invoices §7 — closes delta D7.3 "no per-customer AR
 * drill-down / statement" and matrix row B7 "customer statements").
 *
 * A statement is a customer-facing recap of what they owe: their invoices
 * (number, date, due, amount, paid, balance), an aging summary bucketed
 * CURRENT / 1-30 / 31-60 / 61-90 / 90+ (same buckets as `v_ar_aging`), the total
 * balance due, and a remit-to. Two forms, matching QBO/Sage:
 *   - OPEN  — open-item: only invoices with a balance still outstanding (default).
 *   - ACTIVITY — every invoice in a date window (paid + open), balance-forward feel.
 *
 * This module is split deliberately: the math (aging buckets, balance rollups) is
 * a set of PURE functions with NO I/O so they're unit-testable without a DB
 * (statement.test.ts). The loader hydrates a `StatementDoc` for the PDF.
 *
 * Money is bigint cents throughout (never floats); aging keys off `due_date`
 * relative to an "as of" date so a controller can pull an as-of-period-end
 * statement, not just as-of-now (FPB AC7.2).
 */

export type StatementMode = 'open' | 'activity';

export const AGING_BUCKETS = ['current', 'd1_30', 'd31_60', 'd61_90', 'd90_plus'] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

export const AGING_BUCKET_LABELS: Record<AgingBucket, string> = {
  current: 'Current',
  d1_30: '1–30',
  d31_60: '31–60',
  d61_90: '61–90',
  d90_plus: '90+',
};

export type AgingSummary = Record<AgingBucket, number>;

export interface StatementLine {
  id: string;
  invoiceNumber: string;
  invoiceDate: string; // YYYY-MM-DD
  dueDate: string; // YYYY-MM-DD
  totalCents: number;
  paidCents: number;
  balanceCents: number;
  status: string;
  /** Which aging bucket the OPEN balance falls in (null when fully paid). */
  bucket: AgingBucket | null;
}

export interface StatementDoc {
  customer: {
    id: string;
    name: string;
    email: string | null;
    addressLines: string[];
  };
  entity: { name: string } | null;
  template: {
    logoUrl: string | null;
    accentColor: string;
    remitTo: string | null;
    footerText: string | null;
  };
  mode: StatementMode;
  asOf: string; // YYYY-MM-DD
  periodFrom: string | null;
  periodTo: string | null;
  lines: StatementLine[];
  aging: AgingSummary;
  totalBalanceCents: number;
  openInvoiceCount: number;
  /**
   * Balance-forward ledger — populated in ACTIVITY mode only. Opening balance +
   * every charge/payment in the window with a running balance after each. Undefined
   * for OPEN-item statements (which show only what's still owed).
   */
  openingBalanceCents?: number;
  transactions?: StatementTxn[];
}

// ── Pure math (unit-tested) ──────────────────────────────────────────────────

const emptyAging = (): AgingSummary => ({ current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 });

/** Whole days from `dueDate` to `asOf` (positive = past due). Date-only, UTC-safe. */
export function daysPastDue(dueDate: string, asOf: string): number {
  const due = Date.parse(`${dueDate}T00:00:00Z`);
  const at = Date.parse(`${asOf}T00:00:00Z`);
  if (Number.isNaN(due) || Number.isNaN(at)) return 0;
  return Math.round((at - due) / 86_400_000);
}

/** Bucket an open balance by how many days past due it is as of `asOf`. */
export function agingBucketFor(dueDate: string, asOf: string): AgingBucket {
  const d = daysPastDue(dueDate, asOf);
  if (d <= 0) return 'current';
  if (d <= 30) return 'd1_30';
  if (d <= 60) return 'd31_60';
  if (d <= 90) return 'd61_90';
  return 'd90_plus';
}

/**
 * Roll the OPEN balance of each line into aging buckets. Only positive balances
 * age; fully-paid or credit lines contribute nothing (they never inflate what's
 * "owed"). Returns cents per bucket.
 */
export function computeAging(
  lines: Array<{ dueDate: string; balanceCents: number }>,
  asOf: string,
): AgingSummary {
  const out = emptyAging();
  for (const l of lines) {
    if (l.balanceCents > 0) out[agingBucketFor(l.dueDate, asOf)] += l.balanceCents;
  }
  return out;
}

/** Total balance due = sum of positive open balances (credits don't reduce it). */
export function totalBalanceCents(lines: Array<{ balanceCents: number }>): number {
  return lines.reduce((sum, l) => sum + Math.max(0, l.balanceCents), 0);
}

/** Build the aging + totals summary a statement renders. */
export function summarizeStatement(
  lines: Array<{ dueDate: string; balanceCents: number }>,
  asOf: string,
): { aging: AgingSummary; totalBalanceCents: number; openInvoiceCount: number } {
  return {
    aging: computeAging(lines, asOf),
    totalBalanceCents: totalBalanceCents(lines),
    openInvoiceCount: lines.filter((l) => l.balanceCents > 0).length,
  };
}

// ── Data loader (I/O) ─────────────────────────────────────────────────────────

const num = (v: unknown): number => Number(v ?? 0);

export interface StatementOptions {
  mode?: StatementMode;
  asOf?: string; // YYYY-MM-DD (defaults today)
  from?: string; // YYYY-MM-DD (activity mode window start)
  to?: string; // YYYY-MM-DD (activity mode window end)
}

/**
 * Hydrate a StatementDoc for a customer. RLS-scoped: the caller passes an
 * org-scoped supabase client and the resolved orgId. Cross-schema (core
 * customer/location) is fetched separately and stitched — never a public<->core
 * PostgREST embed (which 500s). Returns null when the customer doesn't exist
 * in this org.
 */
export async function loadCustomerStatement(
  supabase: SupabaseClient,
  orgId: string,
  customerId: string,
  opts: StatementOptions = {},
): Promise<StatementDoc | null> {
  const today = new Date().toISOString().slice(0, 10);
  const asOf = opts.asOf || today;
  const mode: StatementMode = opts.mode === 'activity' ? 'activity' : 'open';

  const { data: cust } = await supabase
    .schema('core')
    .from('customers')
    .select('id, name, display_name, email, address_line1, address_line2, city, state, zip, location_id')
    .eq('org_id', orgId)
    .eq('id', customerId)
    .maybeSingle();
  if (!cust) return null;
  const c = cust as Record<string, unknown>;

  // Invoices for the customer. VOIDED never appears on a statement (it was
  // reversed and carries no obligation). Everything else is a real document.
  // We always pull the FULL history (unwindowed): OPEN mode filters to what's
  // owed, ACTIVITY mode windows for display but still needs pre-window charges
  // to roll a correct opening balance, and aging is always as-of the whole book.
  const { data: invRows } = await supabase
    .from('invoices')
    .select('id, invoice_number, invoice_date, due_date, total_cents, amount_paid_cents, balance_cents, status, location_id')
    .eq('org_id', orgId)
    .eq('customer_id', customerId)
    .neq('status', 'VOIDED')
    .order('invoice_date', { ascending: true });
  const rows = (invRows ?? []) as Array<Record<string, unknown>>;

  const allLines: StatementLine[] = rows.map((r) => {
    const balanceCents = num(r.balance_cents);
    const dueDate = String(r.due_date ?? '');
    return {
      id: String(r.id),
      invoiceNumber: String(r.invoice_number ?? ''),
      invoiceDate: String(r.invoice_date ?? ''),
      dueDate,
      totalCents: num(r.total_cents),
      paidCents: num(r.amount_paid_cents),
      balanceCents,
      status: String(r.status ?? ''),
      bucket: balanceCents > 0 ? agingBucketFor(dueDate, asOf) : null,
    };
  });

  // Displayed lines: OPEN = open-item (balance still owed); ACTIVITY = every doc
  // dated within the [from, to] window (paid + open), balance-forward feel.
  const lines: StatementLine[] =
    mode === 'open'
      ? allLines.filter((l) => l.balanceCents > 0)
      : allLines.filter(
          (l) =>
            (!opts.from || l.invoiceDate >= opts.from) && (!opts.to || l.invoiceDate <= opts.to),
        );

  // Aging + total due always reflect the WHOLE open book as-of (what's owed now),
  // independent of any activity window — a statement's aging strip isn't windowed.
  const openForAging = allLines
    .filter((l) => l.balanceCents > 0)
    .map((l) => ({ dueDate: l.dueDate, balanceCents: l.balanceCents }));
  const summary = summarizeStatement(openForAging, asOf);

  // Balance-forward ledger (ACTIVITY mode only): interleave invoice charges with
  // customer payments in date order and carry a running balance. WRITTEN_OFF
  // invoices are excluded — they were relieved by a write-off and no longer owed.
  let openingBalanceCents: number | undefined;
  let transactions: StatementTxn[] | undefined;
  if (mode === 'activity') {
    const { data: payRows } = await supabase
      .from('customer_payments')
      .select('payment_date, amount_cents, payment_method, reference_number')
      .eq('org_id', orgId)
      .eq('customer_id', customerId)
      .order('payment_date', { ascending: true });
    const payments = ((payRows ?? []) as Array<Record<string, unknown>>).map((p) => ({
      date: String(p.payment_date ?? ''),
      ref: String(p.reference_number ?? ''),
      amountCents: num(p.amount_cents),
      method: (p.payment_method as string | null) ?? null,
    }));
    const chargeInvoices = allLines
      .filter((l) => l.status !== 'WRITTEN_OFF')
      .map((l) => ({ date: l.invoiceDate, ref: l.invoiceNumber, amountCents: l.totalCents, status: l.status }));
    const ledger = buildActivityLedger(chargeInvoices, payments, {
      from: opts.from ?? null,
      to: opts.to ?? asOf,
    });
    openingBalanceCents = ledger.openingBalanceCents;
    transactions = ledger.transactions;
  }

  // Resolve the issuing entity + branding. A customer may have invoices across
  // several locations; pick the customer's home location, else the location that
  // issued the most statement invoices, else the first available.
  const locationId =
    (c.location_id as string | null) ?? mostCommonLocation(rows) ?? null;

  const [{ data: loc }, { data: tmpl }] = await Promise.all([
    locationId
      ? supabase.schema('core').from('locations').select('name').eq('id', locationId).maybeSingle()
      : Promise.resolve({ data: null }),
    locationId
      ? supabase
          .from('invoice_templates')
          .select('logo_url, accent_color, remit_to, footer_text')
          .eq('org_id', orgId)
          .eq('location_id', locationId)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  const t = (tmpl as Record<string, unknown> | null) ?? null;

  const addressLines = [
    c.address_line1,
    c.address_line2,
    [c.city, c.state, c.zip].filter(Boolean).join(', ') || null,
  ]
    .filter(Boolean)
    .map((s) => String(s));

  return {
    customer: {
      id: String(c.id),
      name: String(c.display_name || c.name || ''),
      email: (c.email as string) ?? null,
      addressLines,
    },
    entity: loc ? { name: String((loc as Record<string, unknown>).name ?? '') } : null,
    template: {
      logoUrl: (t?.logo_url as string) ?? null,
      accentColor: (t?.accent_color as string) || '#10b981',
      remitTo: (t?.remit_to as string) ?? null,
      footerText: (t?.footer_text as string) ?? null,
    },
    mode,
    asOf,
    periodFrom: mode === 'activity' ? opts.from ?? null : null,
    periodTo: mode === 'activity' ? opts.to ?? null : null,
    lines,
    aging: summary.aging,
    totalBalanceCents: summary.totalBalanceCents,
    openInvoiceCount: summary.openInvoiceCount,
    openingBalanceCents,
    transactions,
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

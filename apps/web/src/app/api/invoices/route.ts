export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/server';
import { requireAuth, requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { z } from 'zod';
import { createInvoice } from '@/lib/invoices/create-invoice';
import { getHomeCurrency, normalizeCurrency } from '@/lib/currency';
import { resolvePageParams, totalPages } from '@/lib/pagination';
import { fetchAll } from '@/lib/supabase/fetch-all';
import { getOrgToday } from '@/lib/dates/org-today';
import { resolvePayLinksBatch, type PayLinkState } from '@/lib/invoices/pay-link';
import { summarizeOnlineActivity, ONLINE_EVENT_TYPES, type OnlineEvent } from '@/lib/invoices/online-activity';
import { effectiveInvoiceStatus, invoiceTabOrFilter, isOpenInvoiceStatus } from '@/lib/ar/overdue';
import { deriveInvoiceStatus, hasReachedCustomer, DELIVERY_EVIDENCE_EVENTS } from '@/lib/invoices/display-status';

// ─── GET: List invoices ───────────────────────────────────────────────
const querySchema = z.object({
  location_id: z.string().uuid().optional(),
  customer_id: z.string().uuid().optional(),
  status: z.string().optional(),
  search: z.string().optional(),
  page: z.string().regex(/^\d+$/).optional(),
  per_page: z.string().regex(/^\d+$/).optional(),
});

export async function GET(request: Request) {
  // TENANT ISOLATION: resolve the caller's org and run every query through the
  // RLS-scoped (Clerk-token) client, then filter explicitly by org_id. The list
  // AND the status counts must share the same org + company scope, or the tab
  // counts diverge from the rows (and, on the admin client, leak other tenants).
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const { searchParams } = new URL(request.url);
  const raw = Object.fromEntries(searchParams.entries());
  const params = querySchema.parse(raw);

  // Hard-clamp the page size — an uncapped per_page let a caller pull the entire
  // (ledger-scale) invoices table in one request. Defaults unchanged (50/page).
  const { page, perPage, rangeFrom: from, rangeTo: to } = resolvePageParams(params);

  // Overdue is DERIVED (due_date < today in the ORG's timezone, open balance > 0)
  // — never trusted from the stored status (audit L4). One helper, lib/ar/overdue.
  const today = await getOrgToday(supabase, orgId);
  const searchOr = params.search ? `or(invoice_number.ilike.%${params.search}%,memo.ilike.%${params.search}%)` : null;
  const tabOr = params.status && params.status !== 'ALL' ? invoiceTabOrFilter(params.status, today) : null;

  // Base query.
  // NOTE: no PostgREST embeds on customers/locations/jobs here — those tables
  // now live in the `core` schema while invoices is in `public`, and PostgREST
  // cannot embed across schemas (it 500s with a schema-cache error). We fetch
  // each relation separately from `core` (below) and stitch them in JS.
  let query = supabase
    .from('invoices')
    .select(`
      id, invoice_number, invoice_date, due_date, subtotal_cents, tax_cents,
      retainage_cents, total_cents, amount_paid_cents, balance_cents,
      status, is_progress_bill, application_number, memo, sent_at, created_at,
      currency, customer_id, location_id, job_id,
      public_token, payment_methods_allowed, card_surcharge_enabled, ach_surcharge_enabled
    `, { count: 'exact' })
    .order('invoice_date', { ascending: false })
    .range(from, to);

  query = query.eq('org_id', orgId);
  if (params.location_id) query = query.eq('location_id', params.location_id);
  if (params.customer_id) query = query.eq('customer_id', params.customer_id);
  if (params.status && params.status !== 'ALL' && !tabOr) query = query.eq('status', params.status);
  // One `or` group: AND together the derived-status tab filter and the search.
  const groups = [tabOr, searchOr].filter((g): g is string => !!g);
  if (groups.length === 1) query = query.or(groups[0].startsWith('or(') ? groups[0].slice(3, -1) : groups[0]);
  else if (groups.length === 2) query = query.or(`and(${groups.join(',')})`);

  const { data, count, error } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Status counts — scoped to the SAME org + company as the list (but across all
  // statuses, so every tab shows its own total). Without matching the list scope
  // the tab counts and KPI cards disagree with the rows shown below them.
  // Paged — an unpaged read silently caps at 1,000 invoices and understates KPIs.
  const { data: allInvoices } = await fetchAll(
    () => {
      let countsQuery = supabase
        .from('invoices')
        .select('id, status, total_cents, balance_cents, amount_paid_cents, due_date')
        .eq('org_id', orgId);
      if (params.location_id) countsQuery = countsQuery.eq('location_id', params.location_id);
      if (params.customer_id) countsQuery = countsQuery.eq('customer_id', params.customer_id);
      if (params.search) countsQuery = countsQuery.or(`invoice_number.ilike.%${params.search}%,memo.ilike.%${params.search}%`);
      return countsQuery;
    },
    { label: 'invoices status counts' },
  );

  const counts: Record<string, { count: number; totalCents: number; balanceCents: number }> = {
    ALL: { count: 0, totalCents: 0, balanceCents: 0 },
    DRAFT: { count: 0, totalCents: 0, balanceCents: 0 },
    SENT: { count: 0, totalCents: 0, balanceCents: 0 },
    PARTIALLY_PAID: { count: 0, totalCents: 0, balanceCents: 0 },
    PAID: { count: 0, totalCents: 0, balanceCents: 0 },
    OVERDUE: { count: 0, totalCents: 0, balanceCents: 0 },
    /** Every collectible invoice (SENT + PARTIALLY_PAID + OVERDUE) — open AR. */
    OPEN: { count: 0, totalCents: 0, balanceCents: 0 },
  };

  for (const inv of (allInvoices ?? []) as Array<Record<string, unknown>>) {
    const total = Number(inv.total_cents ?? 0);
    const balance = Number(inv.balance_cents ?? 0);
    counts.ALL.count++;
    counts.ALL.totalCents += total;
    counts.ALL.balanceCents += balance;

    const ov = {
      status: inv.status as string,
      dueDate: (inv.due_date as string | null) ?? null,
      balanceCents: balance,
      amountPaidCents: Number(inv.amount_paid_cents ?? 0),
    };
    if (isOpenInvoiceStatus(ov.status) && balance > 0) {
      counts.OPEN.count++;
      counts.OPEN.totalCents += total;
      counts.OPEN.balanceCents += balance;
    }
    const status = effectiveInvoiceStatus(ov, today);
    if (counts[status]) {
      counts[status].count++;
      counts[status].totalCents += total;
      counts[status].balanceCents += balance;
    }
  }

  // Fetch the related core records for the invoices on this page and build
  // lookup maps (replaces the cross-schema PostgREST embeds removed above).
  const rows = data ?? [];
  const customerIds = [...new Set(rows.map((r) => r.customer_id).filter(Boolean))] as string[];
  const locationIds = [...new Set(rows.map((r) => r.location_id).filter(Boolean))] as string[];
  const jobIds = [...new Set(rows.map((r) => r.job_id).filter(Boolean))] as string[];

  const [custRes, locRes, jobRes] = await Promise.all([
    customerIds.length
      ? supabase.schema('core').from('customers').select('id, name, email, payment_terms_days').in('id', customerIds)
      : Promise.resolve({ data: [] as Record<string, unknown>[] }),
    locationIds.length
      ? supabase.schema('core').from('locations').select('id, name, short_code').in('id', locationIds)
      : Promise.resolve({ data: [] as Record<string, unknown>[] }),
    jobIds.length
      ? supabase.schema('core').from('jobs').select('id, job_number, name').in('id', jobIds)
      : Promise.resolve({ data: [] as Record<string, unknown>[] }),
  ]);

  // What customers did with the online link (viewed / paying / paid online), per row.
  const pageIds = rows.map((r) => r.id as string);
  const eventsByInvoice = new Map<string, OnlineEvent[]>();
  if (pageIds.length) {
    const { data: evRows } = await supabase
      .from('invoice_events')
      .select('invoice_id, event_type, created_at, meta')
      .eq('org_id', orgId)
      .in('invoice_id', pageIds)
      // Online activity + delivery evidence (did it ever reach the customer? — the same
      // fact the drawer's status uses, lib/invoices/display-status.ts).
      .in('event_type', Array.from(new Set([...ONLINE_EVENT_TYPES, ...DELIVERY_EVIDENCE_EVENTS])));
    for (const e of (evRows ?? []) as Array<OnlineEvent & { invoice_id: string }>) {
      const list = eventsByInvoice.get(e.invoice_id) ?? [];
      list.push(e);
      eventsByInvoice.set(e.invoice_id, list);
    }
  }

  // Can each row's customer actually pay online right now? THE pay-link decision
  // (lib/invoices/pay-link.ts) — the same one the PDF, email, drawer and pay page use.
  const payById = await resolvePayLinksBatch(
    supabase,
    orgId,
    rows.map((r) => ({
      id: r.id as string,
      public_token: String(r.public_token ?? ''),
      status: String(r.status ?? ''),
      balance_cents: Number(r.balance_cents ?? 0),
      location_id: (r.location_id as string | null) ?? null,
      customer_id: (r.customer_id as string | null) ?? null,
      job_id: (r.job_id as string | null) ?? null,
      payment_methods_allowed: (r.payment_methods_allowed as string[] | null) ?? null,
      card_surcharge_enabled: (r.card_surcharge_enabled as boolean | null) ?? null,
      ach_surcharge_enabled: (r.ach_surcharge_enabled as boolean | null) ?? null,
    })),
  ).catch((e: unknown) => {
    console.error('[invoices] pay-link batch failed', e);
    return new Map<string, PayLinkState>();
  });

  const customerById = new Map((custRes.data ?? []).map((c: Record<string, unknown>) => [c.id as string, c]));
  const locationById = new Map((locRes.data ?? []).map((l: Record<string, unknown>) => [l.id as string, l]));
  const jobById = new Map((jobRes.data ?? []).map((j: Record<string, unknown>) => [j.id as string, j]));

  // Map data with aging calculation
  const invoices = rows.map((inv) => {
    const customer = inv.customer_id ? customerById.get(inv.customer_id as string) ?? null : null;
    const location = inv.location_id ? locationById.get(inv.location_id as string) ?? null : null;
    const job = inv.job_id ? jobById.get(inv.job_id as string) ?? null : null;
    const ov = {
      status: inv.status as string,
      dueDate: (inv.due_date as string | null) ?? null,
      balanceCents: Number(inv.balance_cents ?? 0),
      amountPaidCents: Number(inv.amount_paid_cents ?? 0),
    };
    const evs = eventsByInvoice.get(inv.id as string) ?? [];
    // THE display status (list, drawer and peek share lib/invoices/display-status.ts).
    const display = deriveInvoiceStatus(
      { ...ov, sentToCustomer: hasReachedCustomer(evs, (inv.sent_at as string | null) ?? null) },
      today,
    );
    const isOverdue = display.key === 'OVERDUE';
    const daysOverdue = display.daysOverdue;

    return {
      id: inv.id,
      invoiceNumber: inv.invoice_number,
      invoiceDate: inv.invoice_date,
      dueDate: inv.due_date,
      currency: normalizeCurrency(inv.currency),
      subtotalCents: Number(inv.subtotal_cents),
      taxCents: Number(inv.tax_cents),
      retainageCents: Number(inv.retainage_cents),
      totalCents: Number(inv.total_cents),
      amountPaidCents: Number(inv.amount_paid_cents),
      balanceCents: Number(inv.balance_cents),
      // Display status is derived (OVERDUE when past due with a balance, ISSUED when
      // never delivered); the stored value is kept for workflows that act on it.
      status: display.key,
      statusLabel: display.label,
      statusHint: display.hint,
      storedStatus: inv.status,
      isOverdue,
      isProgressBill: inv.is_progress_bill,
      applicationNumber: inv.application_number,
      memo: inv.memo,
      sentAt: inv.sent_at,
      daysOverdue,
      customer: customer ? { id: customer.id, name: customer.name, email: customer.email, paymentTermsDays: customer.payment_terms_days } : null,
      location: location ? { id: location.id, name: location.name, shortCode: location.short_code } : null,
      job: job ? { id: job.id, jobNumber: job.job_number, name: job.name } : null,
      online: (() => {
        const a = summarizeOnlineActivity(evs);
        const pay = payById.get(inv.id as string);
        return {
          status: a.status, label: a.label, views: a.views, paidOnlineAt: a.paidOnlineAt,
          payable: pay ? pay.payable : null,
          payMethods: pay?.methods ?? [],
          payReason: pay?.reason ?? null,
          payCode: pay?.code ?? null,
        };
      })(),
    };
  });

  // Group reporting (home) currency, so the client can flag foreign-currency rows.
  const homeCurrency = await getHomeCurrency(supabase, orgId);

  return NextResponse.json({
    data: invoices,
    counts,
    homeCurrency,
    pagination: { page, per_page: perPage, total: count ?? 0, total_pages: totalPages(count ?? 0, perPage) },
  });
}

// ─── POST: Create invoice ─────────────────────────────────────────────
const createInvoiceSchema = z.object({
  location_id: z.string().uuid(),
  customer_id: z.string().uuid(),
  job_id: z.string().uuid().optional().nullable(),
  invoice_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  memo: z.string().max(1000).optional(),
  tax_cents: z.number().int().min(0).default(0),
  auto_tax: z.boolean().default(false),
  is_progress_bill: z.boolean().default(false),
  post_to_gl: z.boolean().default(false),
  retainage_pct: z.number().min(0).max(100).default(0),
  lines: z.array(z.object({
    description: z.string().min(1, 'Description required').max(500),
    account_id: z.string().uuid(),
    quantity: z.number().min(0).default(1),
    unit_price_cents: z.number().int(),
    job_phase_id: z.string().uuid().optional().nullable(),
    cost_code_id: z.string().uuid().optional().nullable(),
  })).min(1, 'At least one line item required'),
});

export async function POST(request: Request) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { userId } = authResult;
  const orgId = authResult.orgId ?? '';

  // Authorize — creating an invoice (optionally posting AR to the GL) requires
  // invoices:create (defense-in-depth on top of RLS).
  const guard = await requirePermission(userId, 'invoices', 'create');
  if (!guard.ok) return guard.response;

  try {
    const raw = await request.json();
    const result = createInvoiceSchema.safeParse(raw);

    if (!result.success) {
      const errors: Record<string, string[]> = {};
      for (const issue of result.error.issues) {
        const path = issue.path.join('.') || '_root';
        if (!errors[path]) errors[path] = [];
        errors[path].push(issue.message);
      }
      return NextResponse.json({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: errors }, { status: 422 });
    }

    const body = result.data;
    const supabase = createAdminSupabase();

    // Delegate to the shared invoice-create core — the same path the recurring
    // generator uses, so numbering, rev-rec treatment, and GL posting never fork.
    const outcome = await createInvoice(supabase, {
      orgId,
      actor: userId,
      input: {
        location_id: body.location_id,
        customer_id: body.customer_id,
        job_id: body.job_id ?? null,
        invoice_date: body.invoice_date,
        due_date: body.due_date,
        memo: body.memo,
        tax_cents: body.tax_cents,
        auto_tax: body.auto_tax,
        retainage_pct: body.retainage_pct,
        is_progress_bill: body.is_progress_bill,
        post_to_gl: body.post_to_gl,
        lines: body.lines,
      },
    });

    if (!outcome.ok) {
      return NextResponse.json({ error: outcome.error }, { status: outcome.status });
    }

    return NextResponse.json({
      invoice_id: outcome.result.invoice_id,
      invoice_number: outcome.result.invoice_number,
      total_cents: outcome.result.total_cents,
    }, { status: 201 });
  } catch (error) {
    console.error('[Invoice Create Error]', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Internal server error' }, { status: 500 });
  }
}

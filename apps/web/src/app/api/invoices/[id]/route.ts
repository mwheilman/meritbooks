export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { fetchCoreMap } from '@/lib/stitch-core';

/**
 * GET /api/invoices/[id]
 * Full invoice for the detail drawer: header + line items (account is public,
 * embed OK) with customer / location / job stitched from `core`.
 */
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const { data: inv, error } = await supabase
    .from('invoices')
    .select(`
      id, invoice_number, invoice_date, due_date, status, memo,
      subtotal_cents, tax_cents, total_cents, amount_paid_cents, balance_cents,
      is_progress_bill, customer_id, location_id, job_id, gl_entry_id, created_at, public_token
    `)
    .eq('org_id', orgId)
    .eq('id', params.id)
    .single();

  if (error || !inv) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });

  const { data: lineRows } = await supabase
    .from('invoice_lines')
    .select(`
      id, line_number, description, quantity, unit_price_cents, amount_cents,
      account:accounts!invoice_lines_account_id_fkey(account_number, name)
    `)
    .eq('invoice_id', params.id)
    .order('line_number', { ascending: true });

  const custMap = await fetchCoreMap<{ id: string; name: string; email: string | null }>(
    supabase, 'customers', 'id, name, email', [inv.customer_id]);
  const locMap = await fetchCoreMap<{ id: string; name: string; short_code: string }>(
    supabase, 'locations', 'id, name, short_code', [inv.location_id]);
  const jobMap = await fetchCoreMap<{ id: string; job_number: string; name: string }>(
    supabase, 'jobs', 'id, job_number, name', [inv.job_id]);

  const cust = inv.customer_id ? custMap.get(inv.customer_id) ?? null : null;
  const loc = inv.location_id ? locMap.get(inv.location_id) ?? null : null;
  const job = inv.job_id ? jobMap.get(inv.job_id) ?? null : null;

  // Delivery timeline. The invoice_events log is the ground truth for the "sent"
  // state the drawer shows — a record is only SENT after the email provider
  // confirmed acceptance with a message id, so this is a real signal, not a
  // hopeful status flip. We surface the last send, who it went to, delivery
  // confirmation (if a provider webhook ever records DELIVERED), and how many
  // times the customer opened the hosted page.
  const { data: eventRows } = await supabase
    .from('invoice_events')
    .select('event_type, actor, meta, created_at')
    .eq('invoice_id', params.id)
    .order('created_at', { ascending: true });

  const events = (eventRows ?? []) as Array<{
    event_type: string; actor: string | null; meta: Record<string, any> | null; created_at: string;
  }>;
  const lastAt = (type: string) =>
    events.filter((e) => e.event_type === type).map((e) => e.created_at).sort().at(-1) ?? null;
  const sentEvents = events.filter((e) => e.event_type === 'SENT');
  const viewEvents = events.filter((e) => e.event_type === 'VIEWED');
  const lastSent = sentEvents.at(-1) ?? null;

  const delivery = {
    sentAt: lastAt('SENT'),
    sentTo: (lastSent?.meta?.to as string | undefined) ?? null,
    sentCount: sentEvents.length,
    deliveredAt: lastAt('DELIVERED'),
    viewCount: viewEvents.length,
    lastViewedAt: viewEvents.map((e) => e.created_at).sort().at(-1) ?? null,
    lastReminderAt: lastAt('REMINDER_SENT'),
  };

  const lines = (lineRows ?? []).map((l: Record<string, any>) => {
    const acct = Array.isArray(l.account) ? l.account[0] : l.account;
    return {
      id: l.id,
      lineNumber: l.line_number,
      description: l.description,
      quantity: Number(l.quantity ?? 0),
      unitPriceCents: Number(l.unit_price_cents ?? 0),
      amountCents: Number(l.amount_cents ?? 0),
      accountNumber: (acct as { account_number?: string } | null)?.account_number ?? '',
      accountName: (acct as { name?: string } | null)?.name ?? '',
    };
  });

  return NextResponse.json({
    id: inv.id,
    invoiceNumber: inv.invoice_number,
    invoiceDate: inv.invoice_date,
    dueDate: inv.due_date,
    status: inv.status,
    memo: inv.memo,
    isProgressBill: inv.is_progress_bill,
    publicToken: inv.public_token,
    subtotalCents: Number(inv.subtotal_cents ?? 0),
    taxCents: Number(inv.tax_cents ?? 0),
    totalCents: Number(inv.total_cents ?? 0),
    amountPaidCents: Number(inv.amount_paid_cents ?? 0),
    balanceCents: Number(inv.balance_cents ?? 0),
    customerName: cust?.name ?? '',
    customerEmail: cust?.email ?? null,
    locationName: loc?.name ?? '',
    locationCode: loc?.short_code ?? '',
    jobLabel: job ? `${job.job_number} · ${job.name}` : null,
    lines,
    delivery,
  });
}

// ─── PATCH /api/invoices/[id] — state-aware edit with privileged override ───
//
// DRAFT invoices edit freely (no GL yet). A non-DRAFT invoice is part of the
// book of record — its issuance is posted (DR 1100 AR / CR revenue). Editing it
// requires a privileged override with a typed reason, which is written to
// audit_log. If the override changes the invoice's financial total, the existing
// GL entry is REVERSED and a fresh balanced entry is RE-POSTED, so the trial
// balance never drifts. Non-financial edits (memo, dates) under override just log.
//
// NOTE: role enforcement (true "admin only") attaches when the Core identity /
// RBAC tables land; today the override is gated by a required reason + full audit
// trail, and the actor is the Clerk user id recorded on each audit row.
import { z } from 'zod';
import { postJournalEntry, voidJournalEntry } from '@/lib/services/gl-posting';

const lineInput = z.object({
  description: z.string().min(1).max(500),
  account_id: z.string().uuid(),
  quantity: z.number().min(0).default(1),
  unit_price_cents: z.number().int(),
});

const patchSchema = z.object({
  memo: z.string().max(2000).nullable().optional(),
  invoice_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  lines: z.array(lineInput).min(1).optional(),
  override: z.object({ reason: z.string().min(3).max(500) }).optional(),
});

const AR_CONTROL_ACCOUNT_NUMBER = '1100';

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  let body: z.infer<typeof patchSchema>;
  try {
    const parsed = patchSchema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: 'Validation failed', details: parsed.error.issues }, { status: 422 });
    body = parsed.data;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { data: inv, error: invErr } = await supabase
    .from('invoices')
    .select('id, status, location_id, invoice_date, due_date, memo, subtotal_cents, tax_cents, total_cents, gl_entry_id, invoice_number')
    .eq('org_id', orgId).eq('id', params.id).single();
  if (invErr || !inv) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });

  const isDraft = inv.status === 'DRAFT';
  const financialChange = Array.isArray(body.lines);

  // Posted invoices require an override reason to edit anything.
  if (!isDraft && !body.override) {
    return NextResponse.json(
      { error: 'This invoice is posted. An override reason is required to edit it.', code: 'OVERRIDE_REQUIRED' },
      { status: 403 },
    );
  }

  // Build header changes + collect audited field diffs.
  const updates: Record<string, unknown> = {};
  const diffs: Array<{ field: string; oldVal: unknown; newVal: unknown }> = [];
  const consider = (field: string, newVal: unknown, oldVal: unknown) => {
    if (newVal !== undefined && newVal !== oldVal) { updates[field] = newVal; diffs.push({ field, oldVal, newVal }); }
  };
  consider('memo', body.memo, inv.memo);
  consider('invoice_date', body.invoice_date, inv.invoice_date);
  consider('due_date', body.due_date, inv.due_date);

  // Replace lines + recompute totals when lines are provided.
  let newSubtotal = inv.subtotal_cents as number;
  if (financialChange) {
    const lines = body.lines!.map((l, i) => ({
      org_id: orgId, invoice_id: inv.id, line_number: i + 1,
      description: l.description, account_id: l.account_id,
      quantity: l.quantity, unit_price_cents: l.unit_price_cents,
      amount_cents: Math.round(l.quantity * l.unit_price_cents),
    }));
    newSubtotal = lines.reduce((s, l) => s + l.amount_cents, 0);
    const newTotal = newSubtotal + Number(inv.tax_cents ?? 0);

    await supabase.from('invoice_lines').delete().eq('invoice_id', inv.id);
    const { error: lineErr } = await supabase.from('invoice_lines').insert(lines);
    if (lineErr) return NextResponse.json({ error: `Lines: ${lineErr.message}` }, { status: 500 });

    diffs.push({ field: 'subtotal_cents', oldVal: inv.subtotal_cents, newVal: newSubtotal });
    diffs.push({ field: 'total_cents', oldVal: inv.total_cents, newVal: newTotal });
    updates.subtotal_cents = newSubtotal;
    updates.total_cents = newTotal;

    // Keep the GL consistent: reverse the old issuance entry and re-post.
    if (inv.gl_entry_id) {
      const rev = await voidJournalEntry(supabase, orgId, inv.gl_entry_id as string, userId,
        `Invoice ${inv.invoice_number} edited via override: ${body.override?.reason ?? ''}`);
      if (!rev.success) return NextResponse.json({ error: `Reverse failed: ${rev.error}` }, { status: 500 });

      const { data: arAcct } = await supabase
        .from('accounts').select('id')
        .eq('org_id', orgId).eq('account_number', AR_CONTROL_ACCOUNT_NUMBER).maybeSingle();
      if (!arAcct) return NextResponse.json({ error: `AR control account ${AR_CONTROL_ACCOUNT_NUMBER} missing from COA` }, { status: 400 });

      const glLines = [
        { account_id: (arAcct as { id: string }).id, debit_cents: newTotal, credit_cents: 0, location_id: inv.location_id as string, memo: 'Accounts receivable' },
        ...lines.map((l) => ({ account_id: l.account_id, debit_cents: 0, credit_cents: l.amount_cents, location_id: inv.location_id as string, memo: 'Revenue' })),
      ];
      const reposted = await postJournalEntry(supabase, {
        org_id: orgId, location_id: inv.location_id as string,
        entry_date: (body.invoice_date ?? inv.invoice_date) as string,
        entry_type: 'STANDARD', source_module: 'AR', source_id: inv.id,
        memo: `AR invoice ${inv.invoice_number} (override re-post)`,
        created_by: null, lines: glLines,
      });
      if (!reposted.success) return NextResponse.json({ error: `Re-post failed: ${reposted.error}` }, { status: 500 });
      updates.gl_entry_id = reposted.entry_id;
      diffs.push({ field: 'gl_entry_id', oldVal: inv.gl_entry_id, newVal: reposted.entry_id });
    }
  }

  if (Object.keys(updates).length > 0) {
    const { error: upErr } = await supabase.from('invoices').update(updates).eq('id', inv.id).eq('org_id', orgId);
    if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });
  }

  // Audit trail: one row per changed field, plus the override reason.
  const auditRows = diffs.map((d) => ({
    org_id: orgId, table_name: 'invoices', record_id: inv.id, action: 'UPDATE' as const,
    field_name: d.field, old_value: d.oldVal != null ? String(d.oldVal) : null,
    new_value: d.newVal != null ? String(d.newVal) : null, user_id: userId,
  }));
  if (body.override) {
    auditRows.push({
      org_id: orgId, table_name: 'invoices', record_id: inv.id, action: 'UPDATE' as const,
      field_name: '_override_reason', old_value: inv.status as string, new_value: body.override.reason, user_id: userId,
    });
  }
  if (auditRows.length > 0) await supabase.from('audit_log').insert(auditRows);

  return NextResponse.json({ ok: true, id: inv.id, changedFields: diffs.map((d) => d.field), overridden: !!body.override });
}

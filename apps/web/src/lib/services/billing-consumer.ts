/**
 * JOB_BILLING consumer (Projects -> Books) — Event & Cost/Billing Contract (FROZEN v3) §4.
 *
 * Drains pending JOB_BILLING events from core.events. For each: create invoices +
 * invoice_lines, mint the invoice number, post AR + revenue/deferred per the
 * company's rev-rec config, write invoice_id + invoice_number + gl_entry_id back
 * onto the event (so Projects can show the number without reading invoices). Reject (do not post) on a HARD_CLOSE period. Books owns the
 * issued invoice; corrections are credit memo / adjustment / void-and-reissue
 * (not handled here — issuance only).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { shouldDeferAtBilling } from '@/lib/posting/rev-rec-method';
import { resolveRole } from '@/lib/posting/account-roles';
import { postJournalEntry } from '@/lib/services/gl-posting';

type DB = SupabaseClient;

interface BillingLine { description: string; amount_cents: number; item_id: string | null }
interface BillingPayload {
  event_id: string; job_id: string; location_id: string; billing_type: string;
  occurred_on: string; source_ref: string; memo: string | null; lines: BillingLine[];
}

export interface BillingDrainResult {
  processed: number;
  rejected: number;
  results: { event_id: string; status: 'processed' | 'rejected'; invoice_number?: string; error?: string }[];
}

/** Resolve a single account id by exact account_number for the org. */
async function acctByNumber(db: DB, orgId: string, number: string): Promise<string | null> {
  const { data } = await db.from('accounts').select('id').eq('org_id', orgId).eq('account_number', number).limit(1).maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

/** A revenue account: prefer a generic operating-revenue account, else the lowest-numbered REVENUE account. */
async function revenueAccount(db: DB, orgId: string): Promise<string | null> {
  const { data } = await db
    .from('accounts')
    .select('id, account_number, name')
    .eq('org_id', orgId)
    .eq('account_type', 'REVENUE')
    .eq('is_active', true)
    .order('account_number', { ascending: true });
  const rows = (data ?? []) as { id: string; name: string }[];
  if (rows.length === 0) return null;
  const preferred = rows.find((r) => /service|sales|contract|operating/i.test(r.name));
  return (preferred ?? rows[0]).id;
}

async function mintInvoiceNumber(db: DB, orgId: string, shortCode: string, isoDate: string): Promise<string> {
  const ym = isoDate.slice(0, 7).replace('-', '');
  const { count } = await db.from('invoices').select('id', { count: 'exact', head: true }).eq('org_id', orgId);
  let seq = (count ?? 0) + 1;
  // ensure uniqueness (defensive loop)
  for (let i = 0; i < 50; i++) {
    const candidate = `INV-${shortCode}-${ym}-${String(seq).padStart(4, '0')}`;
    const { data } = await db.from('invoices').select('id').eq('org_id', orgId).eq('invoice_number', candidate).maybeSingle();
    if (!data) return candidate;
    seq++;
  }
  return `INV-${shortCode}-${ym}-${Date.now()}`;
}

async function rejectEvent(db: DB, eventRowId: string, error: string) {
  await db.schema('core').from('events').update({ status: 'rejected', error, processed_at: new Date().toISOString() }).eq('id', eventRowId);
}

/** Process all pending JOB_BILLING events for an org. */
export async function processBillingEvents(db: DB, orgId: string): Promise<BillingDrainResult> {
  const { data: events } = await db
    .schema('core').from('events')
    .select('id, event_id, payload, occurred_on')
    .eq('org_id', orgId)
    .eq('event_type', 'JOB_BILLING')
    .eq('status', 'pending')
    .order('created_at', { ascending: true });

  const out: BillingDrainResult = { processed: 0, rejected: 0, results: [] };

  for (const ev of (events ?? []) as { id: string; event_id: string; payload: BillingPayload; occurred_on: string }[]) {
    const p = ev.payload;
    try {
      const lineTotal = (p.lines ?? []).reduce((s, l) => s + Math.round(Number(l.amount_cents ?? 0)), 0);
      if (!p.lines?.length || lineTotal <= 0) { await rejectEvent(db, ev.id, 'No billable lines'); out.rejected++; out.results.push({ event_id: ev.event_id, status: 'rejected', error: 'No billable lines' }); continue; }

      // Company (short_code mints the invoice #). Rev-rec method is resolved by
      // the canonical resolver below, not read here — it needs the per-job /
      // per-revenue-type tiers, not just the company default.
      const { data: loc } = await db.schema('core').from('locations').select('id, short_code').eq('id', p.location_id).eq('org_id', orgId).single();
      if (!loc) { await rejectEvent(db, ev.id, 'Company not found'); out.rejected++; out.results.push({ event_id: ev.event_id, status: 'rejected', error: 'Company not found' }); continue; }

      // Job + its customer (invoices.customer_id is NOT NULL).
      const { data: job } = await db.schema('core').from('jobs').select('id, customer_id').eq('id', p.job_id).eq('org_id', orgId).single();
      const customerId = (job as { customer_id: string | null } | null)?.customer_id ?? null;
      if (!job || !customerId) { await rejectEvent(db, ev.id, 'Job has no customer to bill'); out.rejected++; out.results.push({ event_id: ev.event_id, status: 'rejected', error: 'Job has no customer to bill' }); continue; }

      // Fiscal period gate.
      const { data: period } = await db.from('fiscal_periods').select('id, status').eq('org_id', orgId).eq('location_id', p.location_id).lte('start_date', p.occurred_on).gte('end_date', p.occurred_on).maybeSingle();
      if (!period) { await rejectEvent(db, ev.id, `No fiscal period for ${p.occurred_on}`); out.rejected++; out.results.push({ event_id: ev.event_id, status: 'rejected', error: `No fiscal period for ${p.occurred_on}` }); continue; }
      if ((period as { status: string }).status === 'HARD_CLOSE') { await rejectEvent(db, ev.id, 'Period is closed/locked'); out.rejected++; out.results.push({ event_id: ev.event_id, status: 'rejected', error: 'Period is closed/locked' }); continue; }

      // Accounts + rev-rec routing. Billing is decoupled from recognition: the
      // canonical resolver (posting/rev-rec-method.ts) decides defer-vs-recognize
      // for THIS job — per-job override → per-revenue-type → company default —
      // exactly as the manual-invoice path (invoices/rev-rec-credit.ts) does, so
      // both post identically. POINT_OF_SALE / AS_BILLED recognize at billing
      // (credit Revenue); the deferral methods (PCT_*, COMPLETED_CONTRACT,
      // MILESTONE, RATABLY, SUBSCRIPTION, CASH) credit Deferred Revenue (2410,
      // resolved by ROLE — never a hard-coded number) for the rev-rec engine to
      // earn out later.
      const arId = await acctByNumber(db, orgId, '1100');
      const revenueAcctId = await revenueAccount(db, orgId);
      if (!arId || !revenueAcctId) { await rejectEvent(db, ev.id, 'Required AR/revenue accounts missing from COA'); out.rejected++; out.results.push({ event_id: ev.event_id, status: 'rejected', error: 'Required AR/revenue accounts missing from COA' }); continue; }

      let deferred: boolean;
      let creditId: string;
      try {
        deferred = await shouldDeferAtBilling(db, { orgId, locationId: p.location_id, revenueAccountId: revenueAcctId, jobId: p.job_id });
        creditId = deferred ? (await resolveRole(db, orgId, 'DEFERRED_REVENUE')).id : revenueAcctId;
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Rev-rec resolution failed';
        await rejectEvent(db, ev.id, msg); out.rejected++; out.results.push({ event_id: ev.event_id, status: 'rejected', error: msg }); continue;
      }

      const invoiceNumber = await mintInvoiceNumber(db, orgId, (loc as { short_code: string }).short_code, p.occurred_on);
      const dueDate = new Date(new Date(p.occurred_on).getTime() + 30 * 86400000).toISOString().split('T')[0];

      // Invoice header.
      const { data: inv, error: invErr } = await db.from('invoices').insert({
        org_id: orgId, location_id: p.location_id, customer_id: customerId, job_id: p.job_id,
        invoice_number: invoiceNumber, invoice_date: p.occurred_on, due_date: dueDate,
        subtotal_cents: lineTotal, total_cents: lineTotal, status: 'SENT',
        is_progress_bill: p.billing_type === 'PROGRESS' || p.billing_type === 'MILESTONE',
        memo: p.memo ?? `Billing (${p.billing_type})`,
      }).select('id').single();
      if (invErr || !inv) { await rejectEvent(db, ev.id, `Invoice insert: ${invErr?.message}`); out.rejected++; out.results.push({ event_id: ev.event_id, status: 'rejected', error: invErr?.message }); continue; }
      const invoiceId = (inv as { id: string }).id;

      // Invoice lines reference the REVENUE account (what was sold); any deferral
      // is reflected only in the GL credit below — matching the manual-invoice
      // path, and so the rev-rec engine can read the revenue account to earn out.
      const lineRows = p.lines.map((l, i) => ({
        org_id: orgId, invoice_id: invoiceId, line_number: i + 1,
        description: l.description || 'Billing', account_id: revenueAcctId,
        quantity: 1, unit_price_cents: Math.round(Number(l.amount_cents)), amount_cents: Math.round(Number(l.amount_cents)),
      }));
      const { error: lineErr } = await db.from('invoice_lines').insert(lineRows);
      if (lineErr) { await db.from('invoices').delete().eq('id', invoiceId); await rejectEvent(db, ev.id, `Invoice lines: ${lineErr.message}`); out.rejected++; out.results.push({ event_id: ev.event_id, status: 'rejected', error: lineErr.message }); continue; }

      // GL: DR AR / CR Revenue|Deferred, job-dimensioned, balanced through the
      // canonical posting engine (postJournalEntry → check_journal_balance()) —
      // the same path the manual-invoice route posts on.
      const jeResult = await postJournalEntry(db, {
        org_id: orgId,
        location_id: p.location_id,
        entry_date: p.occurred_on,
        entry_type: 'STANDARD',
        memo: `AR invoice ${invoiceNumber}`,
        source_module: 'AR',
        source_id: invoiceId,
        created_by: null,
        lines: [
          { account_id: arId, debit_cents: lineTotal, credit_cents: 0, location_id: p.location_id, job_id: p.job_id, memo: 'Accounts receivable' },
          { account_id: creditId, debit_cents: 0, credit_cents: lineTotal, location_id: p.location_id, job_id: p.job_id, memo: deferred ? 'Deferred revenue' : 'Revenue' },
        ],
      });
      if (!jeResult.success || !jeResult.entry_id) {
        await db.from('invoices').delete().eq('id', invoiceId);
        await rejectEvent(db, ev.id, `GL post: ${jeResult.error ?? 'unknown'}`); out.rejected++; out.results.push({ event_id: ev.event_id, status: 'rejected', error: jeResult.error }); continue;
      }
      const entryId = jeResult.entry_id;

      await db.from('invoices').update({ gl_entry_id: entryId }).eq('id', invoiceId);
      await db.schema('core').from('events').update({ status: 'processed', invoice_id: invoiceId, invoice_number: invoiceNumber, gl_entry_id: entryId, processed_at: new Date().toISOString() }).eq('id', ev.id);

      out.processed++;
      out.results.push({ event_id: ev.event_id, status: 'processed', invoice_number: invoiceNumber });
    } catch (e) {
      await rejectEvent(db, ev.id, e instanceof Error ? e.message : 'consumer error');
      out.rejected++;
      out.results.push({ event_id: ev.event_id, status: 'rejected', error: e instanceof Error ? e.message : 'consumer error' });
    }
  }

  return out;
}

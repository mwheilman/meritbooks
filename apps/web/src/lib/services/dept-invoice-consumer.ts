/**
 * DEPT_INVOICE_ISSUE consumer (Projects -> Books) — Merit Suite arch spec §3.2.
 *
 * Books side of the internal-invoice seam. Books OWNS this event type's row
 * status. On a pending event, Books validates LEDGER preconditions only (open
 * period, eliminating accounts resolvable) — it never re-routes receiver
 * approval, which already happened in Projects. Books then:
 *   - resolves charge_method from its own per-company/per-department config
 *     (the payload never carries it),
 *   - mints the internal-invoice number,
 *   - posts the eliminating entries (provider internal revenue / receiver
 *     internal cost, netting to zero at the company roll-up),
 *   - writes the number onto the event's existing additive invoice_number column,
 *   - sets status = processed.
 *
 * Dedupe: (org_id, event_id) [enforced by core.events] + source_ref [an internal
 * invoice already booked for this source_ref is a no-op that still writes the
 * number back]. Rejection: an event whose occurred_on lands in a HARD_CLOSE
 * period is rejected with a reason (Rule F).
 *
 * The Books direct-create internal-invoice path (Projects-absent) is untouched;
 * no event flows there.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  bookInternalInvoice,
  resolveChargeMethod,
  nextInternalInvoiceNumber,
} from './internal-invoices';

type DB = SupabaseClient;

interface DeptInvoiceLine { description: string; amount_cents: number; item_id?: string | null }
interface DeptInvoicePayload {
  event_id: string;
  location_id: string;
  provider_department_id: string;
  receiver_department_id: string;
  source_ref: string;
  lines: DeptInvoiceLine[];
  memo: string | null;
  projects_document_id: string;
}

export interface DeptInvoiceDrainResult {
  processed: number;
  rejected: number;
  results: { event_id: string; status: 'processed' | 'rejected'; invoice_number?: string; error?: string }[];
}

async function rejectEvent(db: DB, eventRowId: string, error: string) {
  await db.schema('core').from('events').update({ status: 'rejected', error, processed_at: new Date().toISOString() }).eq('id', eventRowId);
}

async function processEvent(
  db: DB,
  orgId: string,
  ev: { id: string; event_id: string; payload: DeptInvoicePayload; occurred_on: string },
  out: DeptInvoiceDrainResult,
): Promise<void> {
  const p = ev.payload;
  const reject = async (msg: string) => {
    await rejectEvent(db, ev.id, msg);
    out.rejected++;
    out.results.push({ event_id: ev.event_id, status: 'rejected', error: msg });
  };

  // Validate lines.
  const lineTotal = (p.lines ?? []).reduce((s, l) => s + Math.round(Number(l.amount_cents ?? 0)), 0);
  if (!p.lines?.length || lineTotal <= 0) return reject('No billable lines');
  if (p.provider_department_id === p.receiver_department_id) return reject('Provider and receiver departments must differ');

  // source_ref dedupe — a prior delivery already booked this charge.
  if (p.source_ref) {
    const { data: existing } = await db
      .from('internal_invoices')
      .select('invoice_number')
      .eq('org_id', orgId)
      .eq('source_ref', p.source_ref)
      .maybeSingle();
    const num = (existing as { invoice_number: string } | null)?.invoice_number;
    if (num) {
      await db.schema('core').from('events').update({ status: 'processed', invoice_number: num, processed_at: new Date().toISOString() }).eq('id', ev.id);
      out.processed++;
      out.results.push({ event_id: ev.event_id, status: 'processed', invoice_number: num });
      return;
    }
  }

  // Both departments must belong to this company (location).
  const { data: depts } = await db
    .schema('core').from('departments')
    .select('id, location_id')
    .in('id', [p.provider_department_id, p.receiver_department_id]);
  const deptList = (depts ?? []) as { id: string; location_id: string | null }[];
  if (deptList.length !== 2 || deptList.some((d) => d.location_id !== p.location_id)) {
    return reject('Both departments must belong to the company on the event');
  }

  // Fiscal period gate (Rule F).
  const { data: period } = await db
    .from('fiscal_periods')
    .select('id, status')
    .eq('org_id', orgId)
    .eq('location_id', p.location_id)
    .lte('start_date', ev.occurred_on)
    .gte('end_date', ev.occurred_on)
    .maybeSingle();
  if (!period) return reject(`No fiscal period for ${ev.occurred_on}`);
  if ((period as { status: string }).status === 'HARD_CLOSE') return reject('Period is closed/locked');

  // Resolve charge method from Books config (payload never carries it).
  const chargeMethod = await resolveChargeMethod(db, p.location_id, p.provider_department_id);

  // Mint number; create the internal-invoice record (approved upstream in Projects).
  const invoiceNumber = await nextInternalInvoiceNumber(db, orgId);
  const now = new Date().toISOString();
  const { data: inv, error: invErr } = await db
    .from('internal_invoices')
    .insert({
      org_id: orgId,
      location_id: p.location_id,
      invoice_number: invoiceNumber,
      invoice_date: ev.occurred_on,
      memo: p.memo ?? 'Inter-department internal invoice',
      provider_department_id: p.provider_department_id,
      receiver_department_id: p.receiver_department_id,
      charge_method: chargeMethod,
      status: 'approved', // receiver approval already happened in Projects
      total_cents: lineTotal,
      source_ref: p.source_ref,
      approved_at: now,
    })
    .select('id, invoice_number')
    .single();
  if (invErr || !inv) return reject(`Internal invoice insert: ${invErr?.message}`);
  const invoiceId = (inv as { id: string }).id;

  // Lines.
  const lineRows = p.lines.map((l, i) => ({
    org_id: orgId,
    internal_invoice_id: invoiceId,
    line_number: i + 1,
    description: l.description || 'Internal services',
    amount_cents: Math.round(Number(l.amount_cents)),
  }));
  const { error: lineErr } = await db.from('internal_invoice_lines').insert(lineRows);
  if (lineErr) {
    await db.from('internal_invoices').delete().eq('id', invoiceId);
    return reject(`Internal invoice lines: ${lineErr.message}`);
  }

  // Post the eliminating GL entry via the shared booking path.
  let glEntryId: string;
  try {
    const r = await bookInternalInvoice(db, {
      orgId,
      locationId: p.location_id,
      invoiceDate: ev.occurred_on,
      totalCents: lineTotal,
      providerDepartmentId: p.provider_department_id,
      receiverDepartmentId: p.receiver_department_id,
      chargeMethod,
      memo: p.memo ?? null,
      postedBy: null,
    });
    glEntryId = r.glEntryId;
  } catch (e) {
    await db.from('internal_invoices').delete().eq('id', invoiceId); // lines cascade; frees source_ref for retry
    return reject(e instanceof Error ? e.message : 'Booking failed');
  }

  // Finalize the invoice + write the number back onto the event row.
  await db.from('internal_invoices').update({ status: 'booked', booked_at: now, booked_gl_entry_id: glEntryId }).eq('id', invoiceId);
  await db.schema('core').from('events').update({ status: 'processed', invoice_number: invoiceNumber, gl_entry_id: glEntryId, processed_at: now }).eq('id', ev.id);

  out.processed++;
  out.results.push({ event_id: ev.event_id, status: 'processed', invoice_number: invoiceNumber });
}

/**
 * Drain pending DEPT_INVOICE_ISSUE events (source_module='projects'). Each
 * core.events row carries its own org_id (FROZEN v3), and every eliminating entry
 * is booked under THAT event's org — no cross-tenant posting.
 *
 * `orgFilter` is optional: pass an org id to restrict the drain to one tenant;
 * omit it to drain all tenants. Per-event org is authoritative for the work.
 */
export async function processDeptInvoiceEvents(db: DB, orgFilter?: string | null): Promise<DeptInvoiceDrainResult> {
  let query = db
    .schema('core').from('events')
    .select('id, event_id, org_id, payload, occurred_on')
    .eq('event_type', 'DEPT_INVOICE_ISSUE')
    .eq('source_module', 'projects')
    .eq('status', 'pending');
  if (orgFilter) query = query.eq('org_id', orgFilter);
  const { data: events } = await query.order('created_at', { ascending: true });

  const out: DeptInvoiceDrainResult = { processed: 0, rejected: 0, results: [] };
  for (const ev of (events ?? []) as { id: string; event_id: string; org_id: string; payload: DeptInvoicePayload; occurred_on: string }[]) {
    try {
      // Per-event org — authoritative for validation, insert and GL booking.
      await processEvent(db, ev.org_id, ev, out);
    } catch (e) {
      await rejectEvent(db, ev.id, e instanceof Error ? e.message : 'consumer error');
      out.rejected++;
      out.results.push({ event_id: ev.event_id, status: 'rejected', error: e instanceof Error ? e.message : 'consumer error' });
    }
  }
  return out;
}

/**
 * `ar.late_fees` — propose late fees / finance charges (AR-08, FPB-invoices D6.3).
 *
 * Daily, per tenant: for every open invoice past due, the company's late-fee policy
 * (company row → tenant row → off) is applied with the pure `computeLateFee`. Each fee is
 * written as ONE PROPOSED row in public.late_fee_assessments — UNIQUE per invoice + period
 * (the month, or 'ONCE'), so reruns never double-assess. It never posts, never emails, never
 * touches the invoice: a person approves the proposals (Settings → Automation → Late fees),
 * which creates one finance-charge invoice per company + customer.
 *
 * Never compounding: the base is the original invoice's open balance; finance-charge
 * invoices are not assessed; disputed invoices are not assessed.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  computeLateFee,
  isFinanceChargeInvoice,
  resolveLateFeePolicy,
  type LateFeePolicyRow,
} from '@/lib/collections/late-fees';
import { daysPastDue } from '@/lib/collections/dunning-plan';
import { scopedWriter } from '@/lib/db/scoped-writer';
import type { CountValue, JobContext, JobResult } from '../types';
import { dollars, isoDate, notifyTenantAdmins, scopedOrFail } from './shared';

interface InvRow {
  id: string;
  location_id: string;
  customer_id: string | null;
  due_date: string;
  balance_cents: number | string;
  disputed_at: string | null;
  invoice_type: string | null;
  source_ref: string | null;
}

async function loadAssessed(db: SupabaseClient, orgId: string, invoiceIds: string[]) {
  const periods = new Map<string, Set<string>>();
  const totals = new Map<string, number>();
  for (let i = 0; i < invoiceIds.length; i += 200) {
    const { data, error } = await db
      .from('late_fee_assessments')
      .select('invoice_id, period_key, fee_cents, status')
      .eq('org_id', orgId)
      .in('invoice_id', invoiceIds.slice(i, i + 200));
    if (error) throw new Error(`Could not read late-fee history: ${error.message}`);
    for (const r of (data ?? []) as Array<{ invoice_id: string; period_key: string; fee_cents: number | string; status: string }>) {
      const set = periods.get(r.invoice_id) ?? new Set<string>();
      set.add(r.period_key);
      periods.set(r.invoice_id, set);
      if (r.status !== 'REJECTED') totals.set(r.invoice_id, (totals.get(r.invoice_id) ?? 0) + Number(r.fee_cents));
    }
  }
  return { periods, totals };
}

export async function runLateFeesJob(ctx: JobContext): Promise<JobResult> {
  const s = scopedOrFail(ctx);
  if (!s.ok) return s.result;
  const { db, orgId } = s;
  const asOf = isoDate(ctx.now);

  const { data: polData, error: polErr } = await db
    .from('late_fee_policies')
    .select('location_id, enabled, method, flat_fee_cents, rate_bps, grace_days, frequency, min_fee_cents, max_fee_cents, max_total_per_invoice_cents, min_balance_cents, apply_to, customer_ids, income_account_id')
    .eq('org_id', orgId);
  if (polErr) return { status: 'failed', error: `Could not read the late-fee policy: ${polErr.message}` };
  const policies = (polData ?? []) as LateFeePolicyRow[];
  if (!policies.some((p) => p.enabled)) {
    return { status: 'ok', itemsProcessed: 0, counts: { as_of: asOf, enabled: false }, summary: 'Late fees are switched off (Settings → Automation → Late fees).' };
  }

  const { data: invData, error: invErr } = await db
    .from('invoices')
    .select('id, location_id, customer_id, due_date, balance_cents, disputed_at, invoice_type, source_ref')
    .eq('org_id', orgId)
    .in('status', ['SENT', 'PARTIALLY_PAID', 'OVERDUE'])
    .gt('balance_cents', 0)
    .lt('due_date', asOf)
    .limit(5000);
  if (invErr) return { status: 'failed', error: `Could not read overdue invoices: ${invErr.message}` };
  const invoices = (invData ?? []) as InvRow[];
  const { periods, totals } = invoices.length ? await loadAssessed(db, orgId, invoices.map((i) => i.id)) : { periods: new Map<string, Set<string>>(), totals: new Map<string, number>() };

  let proposed = 0;
  let proposedCents = 0;
  let capped = 0;
  const skipped: Record<string, number> = {};
  const failures: string[] = [];
  const nowIso = ctx.now.toISOString();
  const noIncomeAccount = new Set<string>();

  for (const inv of invoices) {
    if (ctx.signal.aborted) break;
    const policy = resolveLateFeePolicy(policies, inv.location_id);
    const outcome = computeLateFee(
      policy,
      {
        customerId: inv.customer_id,
        balanceCents: Number(inv.balance_cents),
        daysPastDue: daysPastDue(inv.due_date, asOf),
        disputed: !!inv.disputed_at,
        isFinanceCharge: isFinanceChargeInvoice(inv),
        assessedToDateCents: totals.get(inv.id) ?? 0,
        assessedPeriods: periods.get(inv.id) ?? new Set<string>(),
      },
      asOf,
    );
    if (!outcome.fee) {
      skipped[outcome.reason] = (skipped[outcome.reason] ?? 0) + 1;
      continue;
    }
    if (!policy.incomeAccountId) noIncomeAccount.add(inv.location_id);
    try {
      const w = await scopedWriter(db, orgId, [inv.location_id]);
      const { error } = await w.from('late_fee_assessments').insert({
        org_id: orgId,
        location_id: inv.location_id,
        invoice_id: inv.id,
        customer_id: inv.customer_id,
        period_key: outcome.periodKey,
        as_of: asOf,
        days_past_due: Math.max(0, daysPastDue(inv.due_date, asOf)),
        base_cents: outcome.baseCents,
        fee_cents: outcome.feeCents,
        method: policy.method,
        rate_bps: policy.method === 'PERCENT_MONTHLY' ? policy.rateBps : null,
        status: 'PROPOSED',
        created_at: nowIso,
        updated_at: nowIso,
      });
      if (error) {
        if ((error as { code?: string }).code === '23505' || /duplicate key|unique/i.test(error.message)) {
          skipped.already_assessed = (skipped.already_assessed ?? 0) + 1;
          continue;
        }
        throw new Error(error.message);
      }
      proposed++;
      proposedCents += outcome.feeCents;
      if (outcome.capped) capped++;
    } catch (e) {
      failures.push(`${inv.id.slice(0, 8)}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const counts: Record<string, CountValue> = {
    as_of: asOf,
    overdue_invoices: invoices.length,
    proposed,
    proposed_cents: proposedCents,
    capped,
    failed: failures.length,
    companies_missing_income_account: noIncomeAccount.size,
  };
  for (const [k, v] of Object.entries(skipped)) counts[`skipped_${k}`] = v;

  if (proposed > 0) {
    await notifyTenantAdmins(ctx.admin, orgId, {
      kind: 'scheduler.late_fees',
      title: `${proposed} late fee${proposed === 1 ? '' : 's'} proposed (${dollars(proposedCents)})`,
      body: 'Nothing has been charged. Approve them to create finance-charge invoices, or reject them, in Settings → Automation → Late fees.',
      deepLink: '/settings/automation?tab=late_fees',
      dedupeKey: `late_fees:${asOf}`,
    });
  }

  const missing = noIncomeAccount.size > 0 ? ' Set the late-fee income account before approving.' : '';
  return {
    status: failures.length === 0 ? 'ok' : proposed > 0 ? 'partial' : 'failed',
    itemsProcessed: proposed,
    counts,
    summary: proposed > 0
      ? `Proposed ${proposed} late fee(s) totaling ${dollars(proposedCents)} for approval — nothing was charged.${missing}`
      : `Checked ${invoices.length} overdue invoice(s); no new late fees are due.`,
    error: failures.length ? failures.slice(0, 10).join('; ') : undefined,
  };
}

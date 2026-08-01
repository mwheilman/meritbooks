/**
 * Rev-rec-aware credit-account resolution for a manually-created invoice.
 *
 * Billing is decoupled from recognition. When an invoice line is tied to a job,
 * the resolved rev-rec method for that revenue stream decides whether issuing the
 * bill IS the recognition event (credit Revenue) or whether the revenue is
 * deferred (credit Deferred Revenue 2410, which the rev-rec engine earns out
 * later — CR Revenue / DR 2410, DR Unbilled 1180 where earned > billed).
 *
 *   POINT_OF_SALE / AS_BILLED            → recognize now → credit the line's revenue account
 *   PCT_*, COMPLETED_CONTRACT, MILESTONE,
 *   RATABLY, SUBSCRIPTION, CASH          → defer → credit Deferred Revenue (2410)
 *
 * This mirrors the Projects-driven JOB_BILLING consumer (services/billing-consumer.ts)
 * so the manual-create path and the event-driven path never disagree about a
 * stream's treatment. It REUSES the shared resolver (posting/rev-rec-method.ts) and
 * the shared account-role resolver (posting/account-roles.ts) — it does NOT
 * reimplement rev-rec timing.
 *
 * Ad-hoc invoices (no job) recognize at billing: each line credits its own revenue
 * account, exactly as before.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { shouldDeferAtBilling } from '@/lib/posting/rev-rec-method';
import { resolveRole } from '@/lib/posting/account-roles';

type DB = SupabaseClient;

export interface InvoiceCreditInput {
  /** The revenue account the user selected for this line. */
  account_id: string;
  /** Line extended amount, bigint cents. */
  amount_cents: number;
}

export interface InvoiceCreditLine {
  /** Where to credit: the line's revenue account, or Deferred Revenue when deferred. */
  account_id: string;
  amount_cents: number;
  /** True when this line was routed to Deferred Revenue rather than Revenue. */
  deferred: boolean;
}

/**
 * Resolve, per line, the account that a manual invoice's credit should land in.
 *
 * - No job → ad-hoc bill; every line credits its own revenue account.
 * - Job present → resolve the rev-rec method per line (per-job override →
 *   per-revenue-type → company default); deferral methods credit Deferred
 *   Revenue (2410, resolved by role), recognition-at-billing methods credit the
 *   line's revenue account.
 *
 * Throws PostingError only if a line needs Deferred Revenue but the tenant's COA
 * has no 2410 account and no DEFERRED_REVENUE role mapping — the caller decides
 * whether to skip GL posting or surface the error.
 */
export async function resolveInvoiceCreditAccounts(
  db: DB,
  args: { orgId: string; locationId: string; jobId?: string | null; lines: InvoiceCreditInput[] },
): Promise<InvoiceCreditLine[]> {
  // Ad-hoc (no job): billing is recognition — credit each line's revenue account.
  if (!args.jobId) {
    return args.lines.map((l) => ({ account_id: l.account_id, amount_cents: l.amount_cents, deferred: false }));
  }

  let deferredAccountId: string | null = null;
  const out: InvoiceCreditLine[] = [];

  for (const line of args.lines) {
    const defer = await shouldDeferAtBilling(db, {
      orgId: args.orgId,
      locationId: args.locationId,
      revenueAccountId: line.account_id,
      jobId: args.jobId,
    });

    if (defer) {
      // Resolve Deferred Revenue (2410) once, by role.
      if (!deferredAccountId) {
        deferredAccountId = (await resolveRole(db, args.orgId, 'DEFERRED_REVENUE')).id;
      }
      out.push({ account_id: deferredAccountId, amount_cents: line.amount_cents, deferred: true });
    } else {
      out.push({ account_id: line.account_id, amount_cents: line.amount_cents, deferred: false });
    }
  }

  return out;
}

/**
 * PAY-RUN recipe (M9) — the supervised disbursement loop.
 *
 * Assembles the approved, due bills into a proposed disbursement list and stops at the
 * human release gate. It NEVER disburses, releases, settles, or posts to the GL:
 *
 *   1. assemble (AUTO)       Find payable, due bills (status APPROVED, balance > 0, due on
 *                            or before the cutoff), skip any that already carry an open
 *                            disbursement approval, and build the proposed disbursement
 *                            list (vendor, bill, amount, due date). Pure read.
 *   2. release  (HUMAN_GATE) ALWAYS pauses. On the human's explicit APPROVE the agent
 *                            HANDS OFF to the EXISTING payment/checks path: it PREPARES a
 *                            disbursement approval per bill (DRAFT → PENDING_APPROVAL via
 *                            lib/money/approvals — the exact non-releasing prep the Check
 *                            Run uses) and stops. A separate authorized human then approves
 *                            and releases them on the Checks / Payments surface, where
 *                            separation of duties (approver ≠ preparer) is DB-enforced.
 *
 * SAFETY (canon §3): the agent produces a proposed list and, at most, queues PENDING
 * approvals — it NEVER approves, releases, disburses, or posts money. All money movement
 * happens through the pre-existing gated money-movement engine, driven by humans.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { formatMoney } from '@meritbooks/shared';
import type { AgentRecipe, AgentRunContext, AgentState, StepExecuteResult } from '../types';
import { createApproval, submitForApproval, type ApprovalStatus } from '@/lib/money/approvals';

const PAYMENTS_FEATURE = 'PAYMENTS';

// Statuses that mean a live disbursement approval is already in flight for a bill.
const OPEN_STATUSES: ReadonlyArray<ApprovalStatus> = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED'];

interface DueBill {
  id: string;
  balanceCents: number;
  dueDate: string;
  billNumber: string | null;
  vendorId: string | null;
  vendorName: string | null;
}

/** ISO yyyy-mm-dd for `today + days` (UTC). */
function isoDatePlusDays(days: number): string {
  const d = new Date();
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + days));
  return t.toISOString().slice(0, 10);
}

/** Bills with an OPEN disbursement approval already queued (skip these). */
async function billsWithOpenApproval(
  supabase: SupabaseClient,
  billIds: string[],
): Promise<Set<string>> {
  if (billIds.length === 0) return new Set();
  const { data } = await supabase
    .from('approvals')
    .select('subject_id, status')
    .eq('subject_table', 'bills')
    .in('subject_id', billIds);
  return new Set(
    ((data ?? []) as Array<{ subject_id: string; status: ApprovalStatus }>)
      .filter((r) => OPEN_STATUSES.includes(r.status))
      .map((r) => r.subject_id),
  );
}

/** Load payable, due bills for the org (RLS-scoped), newest-due first, with vendor names. */
async function loadDueBills(
  supabase: SupabaseClient,
  cutoff: string,
  locationId: string | null,
): Promise<DueBill[]> {
  let query = supabase
    .from('bills')
    .select('id, balance_cents, due_date, bill_number, vendor_id')
    .eq('status', 'APPROVED')
    .gt('balance_cents', 0)
    .lte('due_date', cutoff)
    .order('due_date', { ascending: true });
  if (locationId) query = query.eq('location_id', locationId);

  const { data } = await query;
  const rows = (data ?? []) as Array<{
    id: string;
    balance_cents: number | string;
    due_date: string;
    bill_number: string | null;
    vendor_id: string | null;
  }>;
  if (rows.length === 0) return [];

  // Resolve vendor display names (cross-schema, RLS-scoped).
  const vendorIds = Array.from(new Set(rows.map((r) => r.vendor_id).filter((v): v is string => !!v)));
  const nameById = new Map<string, string>();
  if (vendorIds.length > 0) {
    const { data: vendors } = await supabase
      .schema('core')
      .from('vendors')
      .select('id, name, display_name')
      .in('id', vendorIds);
    for (const v of (vendors ?? []) as Array<{ id: string; name: string; display_name: string | null }>) {
      nameById.set(v.id, v.display_name ?? v.name);
    }
  }

  return rows.map((r) => ({
    id: r.id,
    balanceCents: Number(r.balance_cents),
    dueDate: r.due_date,
    billNumber: r.bill_number,
    vendorId: r.vendor_id,
    vendorName: r.vendor_id ? nameById.get(r.vendor_id) ?? null : null,
  }));
}

export const payRunRecipe: AgentRecipe = {
  key: 'PAY_RUN',
  label: 'Pay Run',
  description:
    'Assembles the approved, due bills into a proposed disbursement list and pauses for a human to release it. On approval it queues each disbursement into the existing Checks / Payments approval path (separation of duties enforced) — the agent never disburses, releases, or posts money itself.',
  feature: PAYMENTS_FEATURE,

  async init(ctx, input) {
    const dueWithinRaw = Number(input.due_within_days ?? input.dueWithinDays ?? 7);
    const dueWithinDays = Number.isFinite(dueWithinRaw) && dueWithinRaw >= 0 ? Math.floor(dueWithinRaw) : 7;
    const locationId =
      typeof input.location_id === 'string' && input.location_id.trim() !== ''
        ? input.location_id.trim()
        : typeof input.locationId === 'string' && input.locationId.trim() !== ''
          ? input.locationId.trim()
          : null;

    const state: AgentState = { dueWithinDays, locationId };
    return {
      title: `Pay run · bills due ≤ ${dueWithinDays}d`,
      state,
    };
  },

  steps: [
    // ── 1. Assemble the proposed disbursement list (AUTO, read-only) ───────────
    {
      name: 'assemble',
      label: 'Assemble disbursement list',
      kind: 'AUTO',
      async execute(ctx, state): Promise<StepExecuteResult> {
        const dueWithinDays = Number(state.dueWithinDays ?? 7);
        const locationId = (state.locationId as string | null) ?? null;
        const cutoff = isoDatePlusDays(dueWithinDays);

        const bills = await loadDueBills(ctx.supabase, cutoff, locationId);
        if (bills.length === 0) {
          return {
            status: 'DONE',
            summary: `No approved bills are payable within ${dueWithinDays} day(s).`,
            statePatch: { proposedBillIds: [] },
            output: { count: 0, totalCents: 0, bills: [] },
          };
        }

        const openSubjects = await billsWithOpenApproval(ctx.supabase, bills.map((b) => b.id));
        const releasable = bills.filter((b) => !openSubjects.has(b.id));
        const alreadyQueued = bills.length - releasable.length;
        const totalCents = releasable.reduce((s, b) => s + b.balanceCents, 0);

        const list = releasable.map((b) => ({
          billId: b.id,
          vendor: b.vendorName ?? 'Unknown vendor',
          billNumber: b.billNumber,
          amountCents: b.balanceCents,
          dueDate: b.dueDate,
        }));

        return {
          status: 'DONE',
          summary:
            releasable.length === 0
              ? `${bills.length} due bill(s) found, but all already have a disbursement approval in flight — nothing new to release.`
              : `Assembled ${releasable.length} bill(s) totaling ${formatMoney(totalCents)} due within ${dueWithinDays} day(s)${alreadyQueued > 0 ? ` (${alreadyQueued} already queued, skipped)` : ''}.`,
          statePatch: { proposedBillIds: releasable.map((b) => b.id), proposedTotalCents: totalCents },
          output: { count: releasable.length, totalCents, alreadyQueued, bills: list },
        };
      },
    },

    // ── 2. Release gate — hand off to the existing checks/payments path ────────
    {
      name: 'release',
      label: 'Release to Checks / Payments',
      kind: 'HUMAN_GATE',
      async execute(ctx, state): Promise<StepExecuteResult> {
        const ids = (state.proposedBillIds as string[] | undefined) ?? [];
        const totalCents = Number(state.proposedTotalCents ?? 0);
        if (ids.length === 0) {
          return { status: 'DONE', summary: 'Nothing to release — the proposed disbursement list is empty.' };
        }
        return {
          status: 'WAITING',
          summary: `Awaiting release of ${ids.length} bill(s) (${formatMoney(totalCents)}).`,
          gatePrompt: `Approve to RELEASE this batch of ${ids.length} bill(s) totaling ${formatMoney(totalCents)} to the Checks / Payments path. The agent will only PREPARE the disbursement approvals (pending review) — it never disburses, releases, or posts money. A separate authorized person must approve and release each payment (separation of duties). Reject to stop.`,
        };
      },
      async onAdvance(ctx, state): Promise<StepExecuteResult> {
        const ids = (state.proposedBillIds as string[] | undefined) ?? [];
        const preparedBy = ctx.userId;

        // Without a real preparer we cannot queue into the SoD-gated approval chain —
        // hand off by pointing the human to the Check Run instead.
        if (!preparedBy) {
          return {
            status: 'DONE',
            summary: `Released ${ids.length} bill(s) to the Checks / Payments path. Run the Check Run there to queue and release the disbursements — the agent queues nothing without an actor.`,
            output: { handedOff: ids.length, queued: 0 },
          };
        }

        // Re-check open approvals at release time (the list may be stale) and PREPARE
        // a disbursement approval per still-releasable bill — DRAFT → PENDING_APPROVAL.
        // This is the exact non-releasing prep the Check Run performs; it moves no money.
        const openSubjects = await billsWithOpenApproval(ctx.supabase, ids);
        let queued = 0;
        let skipped = 0;
        const errors: Array<{ billId: string; error: string }> = [];

        // Amounts for each bill (re-read to avoid trusting stale state).
        const { data: billRows } = await ctx.supabase
          .from('bills')
          .select('id, balance_cents, status')
          .in('id', ids);
        const billById = new Map(
          ((billRows ?? []) as Array<{ id: string; balance_cents: number | string; status: string }>).map((b) => [b.id, b]),
        );

        for (const billId of ids) {
          if (openSubjects.has(billId)) {
            skipped += 1;
            continue;
          }
          const bill = billById.get(billId);
          if (!bill || bill.status !== 'APPROVED' || Number(bill.balance_cents) <= 0) {
            skipped += 1;
            continue;
          }
          try {
            const approval = await createApproval(ctx.supabase, ctx.orgId, {
              kind: 'AP_DISBURSEMENT',
              subjectTable: 'bills',
              subjectId: billId,
              amountCents: Number(bill.balance_cents),
              preparedBy,
            });
            await submitForApproval(ctx.supabase, ctx.orgId, approval.id, preparedBy);
            queued += 1;
          } catch (e) {
            // A stale (e.g. rejected) approval on the same subject trips the unique
            // index; treat as already-handled rather than failing the batch.
            errors.push({ billId, error: e instanceof Error ? e.message : 'queue failed' });
            skipped += 1;
          }
        }

        return {
          status: 'DONE',
          summary: `Released to the Checks / Payments path: queued ${queued} disbursement approval(s)${skipped > 0 ? `, skipped ${skipped}` : ''}. A separate authorized person must approve and release them — the agent moved no money.`,
          statePatch: { queuedCount: queued },
          output: { queued, skipped, errors },
        };
      },
    },
  ],
};

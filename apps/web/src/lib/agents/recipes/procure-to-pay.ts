/**
 * PROCURE-TO-PAY recipe (M9) — the supervised PO → receipt → bill → pay loop.
 *
 * Chains the pieces that ALREADY exist, stopping at every human gate before anything
 * hits the ledger or moves money. It NEVER reimplements the PO, goods-receipt,
 * 3-way-match, bill-posting or disbursement engines — it drives them in order:
 *
 *   1. observe_po      (AUTO)        Load an existing purchase order + its lines
 *                                    (public.purchase_orders / _lines, migration 080).
 *                                    Pure read — surfaces ordered / received / billed.
 *   2. match_receipt   (AUTO)        Run the EXISTING pure 3-way-match engine
 *                                    (lib/procurement/three-way-match → runThreeWayMatch)
 *                                    over the PO's received-vs-ordered position, surfacing
 *                                    matched lines and any over-receipt / variance. Pure
 *                                    read; posts nothing.
 *   3. propose_bill    (PROPOSE)     Build the proposed vendor bill from what has been
 *                                    RECEIVED but not yet billed (received_qty − billed_qty,
 *                                    priced at the PO unit cost) and write a PROPOSED
 *                                    public.ai_decisions row. The M10 dial (feature
 *                                    BILL_PARSE) decides: AUTO ⇒ create the PENDING bill
 *                                    (bills + bill_lines + bill_po_link — reversible DATA
 *                                    ENTRY, NO GL post); otherwise WAIT for a human. Kill
 *                                    switch ⇒ WAIT. Approving/creating a PENDING bill moves
 *                                    NO money and hits NO ledger — posting happens only at
 *                                    step 4.
 *   4. approve_bill    (HUMAN_GATE)  ALWAYS pauses. The human approves the bill through the
 *                                    EXISTING gated Bills / Approvals surface (POST
 *                                    /api/bills/[id] → approveBill), which runs the AP policy
 *                                    gate + SoD and POSTS the payable (DR expense / CR AP)
 *                                    through the deterministic posting engine. The runner only
 *                                    OBSERVES that the bill reached APPROVED — it never
 *                                    approves or posts on the human's behalf.
 *   5. release_pay_run (HUMAN_GATE)  ALWAYS pauses. On the human's explicit APPROVE the agent
 *                                    HANDS OFF to the EXISTING Checks / Payments path: it
 *                                    PREPARES a disbursement approval for the bill (DRAFT →
 *                                    PENDING_APPROVAL via lib/money/approvals — the exact
 *                                    non-releasing prep the Pay Run / Check Run use) and stops.
 *                                    A separate authorized person approves and releases the
 *                                    payment (separation of duties, DB-enforced). The agent
 *                                    NEVER disburses, releases, settles, or posts money.
 *
 * SAFETY (canon §3): AI/engine proposes facts; a HUMAN approves anything that moves money
 * or hits the GL. No step in this recipe posts money or touches the ledger without the
 * existing human gate: the only ledger effect (the AP post) is performed entirely by the
 * pre-existing, deterministic bill-approval engine after a human approves at step 4, and the
 * only money-movement effect (a disbursement) is a PENDING approval a second human must
 * release at step 5.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { formatMoney } from '@meritbooks/shared';
import type { AgentRecipe, AgentRunContext, AgentState, StepExecuteResult } from '../types';
import {
  runThreeWayMatch,
  toMatchConfidence,
  type PoLineInput,
  type BillLineInput,
  type ThreeWayMatchResult,
} from '@/lib/procurement/three-way-match';
import { getTierPolicy, scoreToTier } from '@/lib/trust/score-tier';
import { resolveDispositionDetailed } from '@/lib/autonomy/disposition';
import { resolveApprover } from '@/lib/services/cost-approval';
import { createApproval, submitForApproval, type ApprovalStatus } from '@/lib/money/approvals';

/** The M10 autonomy feature governing the bill-creation proposal in this loop. */
const BILL_FEATURE = 'BILL_PARSE';

/** Approval statuses that mean a live disbursement approval is already in flight. */
const OPEN_APPROVAL_STATUSES: ReadonlyArray<ApprovalStatus> = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED'];

// ── Row shapes (RLS-scoped reads) ─────────────────────────────────────────────

interface PoLineRow {
  id: string;
  line_number: number;
  description: string | null;
  account_id: string | null;
  item_id: string | null;
  quantity: number | string;
  unit_cost_cents: number | string;
  amount_cents: number | string;
  received_qty: number | string;
  billed_qty: number | string;
}

interface PoLine {
  id: string;
  lineNumber: number;
  description: string | null;
  accountId: string | null;
  itemId: string | null;
  orderedQty: number;
  unitCostCents: number;
  receivedQty: number;
  billedQty: number;
}

/** ISO yyyy-mm-dd for today + offset days (UTC). */
function isoDate(offsetDays = 0): string {
  const d = new Date();
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + offsetDays));
  return t.toISOString().slice(0, 10);
}

/** Load the PO's lines fresh (RLS-scoped), ordered by line number. */
async function loadPoLines(supabase: SupabaseClient, poId: string): Promise<PoLine[]> {
  const { data } = await supabase
    .from('purchase_order_lines')
    .select('id, line_number, description, account_id, item_id, quantity, unit_cost_cents, amount_cents, received_qty, billed_qty')
    .eq('po_id', poId)
    .order('line_number', { ascending: true });
  return ((data ?? []) as PoLineRow[]).map((l) => ({
    id: l.id,
    lineNumber: Number(l.line_number),
    description: l.description,
    accountId: l.account_id,
    itemId: l.item_id,
    orderedQty: Number(l.quantity),
    unitCostCents: Number(l.unit_cost_cents),
    receivedQty: Number(l.received_qty),
    billedQty: Number(l.billed_qty),
  }));
}

/** The received-but-not-yet-billed quantity for a PO line (never negative). */
function unbilledReceivedQty(l: PoLine): number {
  return Math.max(0, l.receivedQty - l.billedQty);
}

/** A proposed vendor-bill line derived from a PO line's un-billed received quantity. */
interface ProposedBillLine {
  poLineId: string;
  accountId: string;
  itemId: string | null;
  description: string | null;
  quantity: number;
  unitCostCents: number;
  amountCents: number;
}

/** Build the proposed bill lines from what has been received but not billed. Only lines
 *  with a resolvable GL account are billable; unaccounted lines are reported separately. */
function buildProposedLines(poLines: PoLine[]): { lines: ProposedBillLine[]; skippedUnaccounted: number } {
  const lines: ProposedBillLine[] = [];
  let skippedUnaccounted = 0;
  for (const l of poLines) {
    const qty = unbilledReceivedQty(l);
    if (qty <= 0.00001) continue;
    if (!l.accountId) {
      skippedUnaccounted += 1;
      continue;
    }
    lines.push({
      poLineId: l.id,
      accountId: l.accountId,
      itemId: l.itemId,
      description: l.description,
      quantity: qty,
      unitCostCents: l.unitCostCents,
      amountCents: Math.round(qty * l.unitCostCents),
    });
  }
  return { lines, skippedUnaccounted };
}

/** Run the EXISTING 3-way-match engine over the PO's received-vs-ordered position.
 *  With no bill yet, the "billed" leg is the received quantity so the read surfaces
 *  over-receipt and confirms received reconciles to ordered at the PO unit cost. */
function matchReceiptToPo(poLines: PoLine[]): ThreeWayMatchResult {
  const poInputs: PoLineInput[] = poLines.map((l) => ({
    id: l.id,
    description: l.description,
    accountId: l.accountId,
    itemId: l.itemId,
    orderedQty: l.orderedQty,
    unitCostCents: l.unitCostCents,
    receivedQty: l.receivedQty,
  }));
  const billInputs: BillLineInput[] = poLines
    .filter((l) => l.receivedQty > 0.00001)
    .map((l) => ({
      id: `recv-${l.id}`,
      description: l.description,
      accountId: l.accountId,
      itemId: l.itemId,
      billedQty: l.receivedQty,
      unitCostCents: l.unitCostCents,
      amountCents: Math.round(l.receivedQty * l.unitCostCents),
    }));
  return runThreeWayMatch({ poLines: poInputs, billLines: billInputs });
}

interface PoHeader {
  id: string;
  poNumber: string;
  status: string;
  vendorId: string;
  vendorName: string | null;
  locationId: string | null;
}

/** Load the PO header + its vendor display name (cross-schema, RLS-scoped). */
async function loadPoHeader(supabase: SupabaseClient, poId: string): Promise<PoHeader | null> {
  const { data: po } = await supabase
    .from('purchase_orders')
    .select('id, po_number, status, vendor_id, location_id')
    .eq('id', poId)
    .maybeSingle();
  if (!po) return null;
  const p = po as { id: string; po_number: string; status: string; vendor_id: string; location_id: string | null };

  let vendorName: string | null = null;
  if (p.vendor_id) {
    const { data: ven } = await supabase
      .schema('core')
      .from('vendors')
      .select('name, display_name')
      .eq('id', p.vendor_id)
      .maybeSingle();
    if (ven) {
      const v = ven as { name: string; display_name: string | null };
      vendorName = v.display_name ?? v.name;
    }
  }
  return {
    id: p.id,
    poNumber: p.po_number,
    status: p.status,
    vendorId: p.vendor_id,
    vendorName,
    locationId: p.location_id,
  };
}

interface BillSnapshot {
  id: string;
  status: string;
  totalCents: number;
  balanceCents: number;
  glEntryId: string | null;
}

async function loadBill(supabase: SupabaseClient, orgId: string, billId: string): Promise<BillSnapshot | null> {
  const { data } = await supabase
    .from('bills')
    .select('id, status, total_cents, balance_cents, gl_entry_id')
    .eq('org_id', orgId)
    .eq('id', billId)
    .maybeSingle();
  if (!data) return null;
  const b = data as { id: string; status: string; total_cents: number | string; balance_cents: number | string; gl_entry_id: string | null };
  return {
    id: b.id,
    status: b.status,
    totalCents: Number(b.total_cents),
    balanceCents: Number(b.balance_cents),
    glEntryId: b.gl_entry_id,
  };
}

/**
 * Create the PENDING bill from the proposal (DATA ENTRY — no GL post; posting happens
 * only when a human approves at step 4). Mirrors the gated /api/bills/create insert
 * shape (same columns, approver routing) and links the bill to the PO. Returns the new
 * bill id, or null on failure.
 */
async function createPendingBillFromProposal(
  ctx: AgentRunContext,
  po: PoHeader,
  lines: ProposedBillLine[],
  match: ThreeWayMatchResult | null,
): Promise<{ billId: string; totalCents: number } | { error: string }> {
  if (po.locationId == null) {
    return { error: 'The purchase order has no location — set one before creating a bill.' };
  }
  const subtotalCents = lines.reduce((s, l) => s + l.amountCents, 0);
  const totalCents = subtotalCents; // no tax on a PO-derived draft; the human can add it before approval

  // Route to an approver by vendor (falls back to ACCOUNTING) — same helper the
  // gated create route uses; keeps SoD routing consistent.
  const approver = await resolveApprover(ctx.supabase, ctx.orgId, { vendorId: po.vendorId, sourceType: 'BILL' });

  const billNumber = `PO-${po.poNumber}-${Date.now().toString().slice(-6)}`;
  const { data: bill, error: billErr } = await ctx.supabase
    .from('bills')
    .insert({
      org_id: ctx.orgId,
      location_id: po.locationId,
      vendor_id: po.vendorId,
      bill_number: billNumber,
      bill_date: isoDate(0),
      due_date: isoDate(30),
      subtotal_cents: subtotalCents,
      tax_cents: 0,
      total_cents: totalCents,
      retainage_pct: 0,
      retainage_cents: 0,
      status: 'PENDING',
      approver_type: approver.approver_type,
      approver_ref: approver.approver_ref,
      ai_extracted: false,
    })
    .select('id')
    .single();
  if (billErr || !bill) {
    return { error: billErr?.message ?? 'Failed to create the bill.' };
  }
  const billId = (bill as { id: string }).id;

  const lineInserts = lines.map((l, i) => ({
    org_id: ctx.orgId,
    bill_id: billId,
    line_number: i + 1,
    description: l.description,
    account_id: l.accountId,
    item_id: l.itemId,
    quantity: l.quantity,
    unit_cost_cents: l.unitCostCents,
    amount_cents: l.amountCents,
  }));
  const { error: linesErr } = await ctx.supabase.from('bill_lines').insert(lineInserts);
  if (linesErr) {
    await ctx.supabase.from('bills').delete().eq('id', billId);
    return { error: linesErr.message };
  }

  // Link the bill to the PO with the informational match verdict (the existing
  // /api/purchase-orders/[id]/match route owns the authoritative billed_qty meters
  // and any 3-way-match EXCEPTION rail — we do not touch those here).
  await ctx.supabase
    .from('bill_po_links')
    .upsert(
      {
        org_id: ctx.orgId,
        bill_id: billId,
        po_id: po.id,
        match_status: 'PENDING',
        match_result: match ?? null,
        matched_by_user: ctx.userId,
        matched_at: new Date().toISOString(),
      },
      { onConflict: 'org_id,bill_id,po_id' },
    );

  return { billId, totalCents };
}

/** Bills that already carry an OPEN disbursement approval (skip these at release). */
async function billsWithOpenApproval(supabase: SupabaseClient, billIds: string[]): Promise<Set<string>> {
  if (billIds.length === 0) return new Set();
  const { data } = await supabase
    .from('approvals')
    .select('subject_id, status')
    .eq('subject_table', 'bills')
    .in('subject_id', billIds);
  return new Set(
    ((data ?? []) as Array<{ subject_id: string; status: ApprovalStatus }>)
      .filter((r) => OPEN_APPROVAL_STATUSES.includes(r.status))
      .map((r) => r.subject_id),
  );
}

export const procureToPayRecipe: AgentRecipe = {
  key: 'PROCURE_TO_PAY',
  label: 'Procure-to-Pay',
  description:
    'Drives an existing purchase order through receipt matching, a proposed vendor bill, human approval (which posts the payable through the deterministic engine), and a release to the Checks / Payments path. Chains the PO, 3-way-match, bill-approval and disbursement engines — no step posts money or hits the GL without the existing human gate.',
  feature: BILL_FEATURE,

  async init(ctx, input) {
    const poId =
      typeof input.po_id === 'string' && input.po_id.trim() !== ''
        ? input.po_id.trim()
        : typeof input.purchase_order_id === 'string' && input.purchase_order_id.trim() !== ''
          ? input.purchase_order_id.trim()
          : '';
    if (!poId) return { error: 'A po_id (an existing purchase order) is required to start this agent.' };

    const po = await loadPoHeader(ctx.supabase, poId);
    if (!po) return { error: 'Purchase order not found (or not in your organization).' };
    if (po.status === 'CANCELLED') {
      return { error: 'This purchase order is cancelled — nothing for the agent to do.' };
    }

    const state: AgentState = {
      poId: po.id,
      poNumber: po.poNumber,
      vendorId: po.vendorId,
      vendorName: po.vendorName,
      locationId: po.locationId,
    };
    return {
      title: `Procure-to-pay · ${po.poNumber} · ${po.vendorName ?? 'vendor'}`,
      state,
      subject: { table: 'purchase_orders', id: po.id },
    };
  },

  steps: [
    // ── 1. Observe the PO + its lines (AUTO, read-only) ───────────────────────
    {
      name: 'observe_po',
      label: 'Read purchase order',
      kind: 'AUTO',
      async execute(ctx, state): Promise<StepExecuteResult> {
        const poId = String(state.poId ?? '');
        const poLines = await loadPoLines(ctx.supabase, poId);
        if (poLines.length === 0) {
          return { status: 'FAILED', summary: 'This purchase order has no lines to procure against.' };
        }
        const orderedCents = poLines.reduce((s, l) => s + Math.round(l.orderedQty * l.unitCostCents), 0);
        const receivedCents = poLines.reduce((s, l) => s + Math.round(l.receivedQty * l.unitCostCents), 0);
        const billedCents = poLines.reduce((s, l) => s + Math.round(l.billedQty * l.unitCostCents), 0);
        return {
          status: 'DONE',
          summary: `Read PO ${state.poNumber ?? poId}: ${poLines.length} line${poLines.length === 1 ? '' : 's'}, ${formatMoney(orderedCents)} ordered / ${formatMoney(receivedCents)} received / ${formatMoney(billedCents)} billed.`,
          output: {
            lineCount: poLines.length,
            orderedCents,
            receivedCents,
            billedCents,
            lines: poLines.map((l) => ({
              lineNumber: l.lineNumber,
              description: l.description,
              orderedQty: l.orderedQty,
              receivedQty: l.receivedQty,
              billedQty: l.billedQty,
              unitCostCents: l.unitCostCents,
            })),
          },
        };
      },
    },

    // ── 2. Match the goods receipt to the PO (AUTO, existing 3WM engine) ──────
    {
      name: 'match_receipt',
      label: 'Match goods receipt to PO',
      kind: 'AUTO',
      async execute(ctx, state): Promise<StepExecuteResult> {
        const poId = String(state.poId ?? '');
        const poLines = await loadPoLines(ctx.supabase, poId);
        const anyReceived = poLines.some((l) => l.receivedQty > 0.00001);
        if (!anyReceived) {
          return {
            status: 'DONE',
            summary: 'No goods have been received against this PO yet — record a goods receipt before there is anything to bill.',
            statePatch: { receiptMatched: false, matchVerdict: 'NONE' },
            output: { received: false },
          };
        }

        const match = matchReceiptToPo(poLines);
        const isException = match.verdict === 'EXCEPTION';
        return {
          status: 'DONE',
          summary: isException
            ? `3-way match variance on received-vs-ordered: ${match.summary}`
            : `Received goods reconcile to the PO: ${match.summary}`,
          statePatch: {
            receiptMatched: true,
            matchVerdict: match.verdict,
            matchFlags: match.flags,
            matchAmountAtRiskCents: match.amountAtRiskCents,
          },
          output: {
            verdict: match.verdict,
            flags: match.flags,
            amountAtRiskCents: match.amountAtRiskCents,
            totals: match.totals,
            reasons: match.reasons,
          },
        };
      },
    },

    // ── 3. Propose the bill from the matched receipt (PROPOSE, dial-governed) ──
    {
      name: 'propose_bill',
      label: 'Propose vendor bill',
      kind: 'PROPOSE',
      feature: BILL_FEATURE,
      async execute(ctx, state): Promise<StepExecuteResult> {
        const poId = String(state.poId ?? '');
        const poLines = await loadPoLines(ctx.supabase, poId);
        const { lines, skippedUnaccounted } = buildProposedLines(poLines);

        if (lines.length === 0) {
          const why =
            skippedUnaccounted > 0
              ? `${skippedUnaccounted} received line(s) have no GL account — code the PO before billing.`
              : 'Nothing has been received but not yet billed — there is nothing to bill.';
          return {
            status: 'DONE',
            summary: `No proposed bill: ${why}`,
            statePatch: { proposedBillCreated: false },
            output: { proposed: false, skippedUnaccounted },
          };
        }

        const match = matchReceiptToPo(poLines);
        const totalCents = lines.reduce((s, l) => s + l.amountCents, 0);
        const vendorName = (state.vendorName as string | null) ?? 'vendor';

        // Confidence: a clean 3-way match on the received leg is high; a variance lowers it.
        const confidence = match.verdict === 'EXCEPTION' ? 0.6 : 0.9;
        const reasoning = `Proposed bill for ${lines.length} received line(s) totaling ${formatMoney(totalCents)} from PO ${state.poNumber ?? poId}, priced at PO unit cost. ${match.summary}`;

        // Record the proposal as a PROPOSED ai_decisions row (no GL, no bill yet).
        const proposedOutput = {
          control: 'P2P',
          po_id: poId,
          po_number: state.poNumber ?? null,
          vendor_id: state.vendorId ?? null,
          total_cents: totalCents,
          match_verdict: match.verdict,
          match_flags: match.flags,
          lines: lines.map((l) => ({
            po_line_id: l.poLineId,
            account_id: l.accountId,
            description: l.description,
            quantity: l.quantity,
            unit_cost_cents: l.unitCostCents,
            amount_cents: l.amountCents,
          })),
        };
        let decisionId: string | null = null;
        const { data: inserted } = await ctx.supabase
          .from('ai_decisions')
          .insert({
            org_id: ctx.orgId,
            location_id: (state.locationId as string | null) ?? null,
            feature: BILL_FEATURE,
            input_summary: `Procure-to-pay bill proposal for PO ${state.poNumber ?? poId} (${vendorName})`,
            proposed_output: proposedOutput,
            confidence: toMatchConfidence(confidence),
            reasoning,
            clarifying_question: 'Create this PENDING vendor bill from the received goods? It posts nothing until you approve it.',
            status: 'PROPOSED',
            created_by_user: ctx.userId,
          })
          .select('id')
          .single();
        decisionId = (inserted?.id as string) ?? null;

        const statePatch: AgentState = {
          proposedTotalCents: totalCents,
          proposedLineCount: lines.length,
          codingDecisionId: decisionId,
        };

        // Consult the M10 dial. AUTO ⇒ create the PENDING bill now (reversible data
        // entry, NO GL). Anything else (or the kill switch) ⇒ WAIT for a human.
        const policy = await getTierPolicy(ctx.supabase, ctx.orgId);
        const { tier } = scoreToTier({ confidence, amountCents: totalCents }, policy);
        const disp = await resolveDispositionDetailed({
          orgId: ctx.orgId,
          feature: BILL_FEATURE,
          scoreTier: tier,
          amountCents: totalCents,
          supabase: ctx.supabase,
        });

        if (disp.disposition === 'AUTO') {
          const po = await loadPoHeader(ctx.supabase, poId);
          if (!po) return { status: 'FAILED', summary: 'The purchase order disappeared before the bill could be created.' };
          const created = await createPendingBillFromProposal(ctx, po, lines, match);
          if ('error' in created) {
            return {
              status: 'WAITING',
              summary: `Could not auto-create the bill (${created.error}) — a human should create/review it.`,
              disposition: disp.disposition,
              aiDecisionId: decisionId,
              statePatch,
              gatePrompt: `Automatic bill creation failed: ${created.error}. Create the bill manually from the PO, then approve to continue.`,
            };
          }
          if (decisionId) {
            await ctx.supabase.from('ai_decisions').update({ status: 'APPLIED' }).eq('id', decisionId);
          }
          return {
            status: 'DONE',
            summary: `Auto-created PENDING bill for ${vendorName} (${formatMoney(created.totalCents)}, ${lines.length} line${lines.length === 1 ? '' : 's'}) from received goods (dial: AUTO). ${disp.reason} No GL posted — approval posts the payable.`,
            disposition: 'AUTO',
            aiDecisionId: decisionId,
            statePatch: { ...statePatch, proposedBillCreated: true, billId: created.billId },
            subject: { table: 'bills', id: created.billId },
            output: { billId: created.billId, totalCents: created.totalCents, lineCount: lines.length, disposition: 'AUTO' },
          };
        }

        return {
          status: 'WAITING',
          summary: `Proposed a bill for ${vendorName} (${formatMoney(totalCents)}, ${lines.length} line${lines.length === 1 ? '' : 's'}) from received goods. ${disp.reason}`,
          disposition: disp.disposition,
          aiDecisionId: decisionId,
          statePatch,
          gatePrompt: `Create this PENDING vendor bill for ${vendorName} — ${formatMoney(totalCents)} across ${lines.length} line${lines.length === 1 ? '' : 's'} from the received goods? It is DATA ENTRY only — nothing posts to the ledger until you approve the bill at the next step. Reject to stop.`,
          output: { totalCents, lineCount: lines.length, disposition: disp.disposition, matchVerdict: match.verdict },
        };
      },
      async onAdvance(ctx, state): Promise<StepExecuteResult> {
        // Human approved the proposal → create the PENDING bill (data entry, no GL).
        const poId = String(state.poId ?? '');
        const poLines = await loadPoLines(ctx.supabase, poId);
        const { lines } = buildProposedLines(poLines);
        if (lines.length === 0) {
          return { status: 'DONE', summary: 'Nothing left to bill — the received goods have already been billed.' };
        }
        const match = matchReceiptToPo(poLines);
        const po = await loadPoHeader(ctx.supabase, poId);
        if (!po) return { status: 'FAILED', summary: 'The purchase order could not be re-read to create the bill.' };
        const created = await createPendingBillFromProposal(ctx, po, lines, match);
        if ('error' in created) {
          return { status: 'FAILED', summary: `Could not create the bill: ${created.error}` };
        }
        const decisionId = (state.codingDecisionId as string | null) ?? null;
        if (decisionId) {
          await ctx.supabase.from('ai_decisions').update({ status: 'APPLIED' }).eq('id', decisionId);
        }
        const vendorName = (state.vendorName as string | null) ?? 'vendor';
        return {
          status: 'DONE',
          summary: `Reviewer approved — created PENDING bill for ${vendorName} (${formatMoney(created.totalCents)}, ${lines.length} line${lines.length === 1 ? '' : 's'}). No GL posted; approval posts the payable.`,
          statePatch: { proposedBillCreated: true, billId: created.billId, proposedTotalCents: created.totalCents },
          subject: { table: 'bills', id: created.billId },
          output: { billId: created.billId, totalCents: created.totalCents, lineCount: lines.length },
        };
      },
    },

    // ── 4. Approve the bill (HUMAN_GATE — observes the deterministic AP post) ──
    {
      name: 'approve_bill',
      label: 'Approve & post bill',
      kind: 'HUMAN_GATE',
      async execute(ctx, state): Promise<StepExecuteResult> {
        const billId = (state.billId as string | undefined) ?? undefined;
        if (!billId) {
          return { status: 'DONE', summary: 'No bill was created — nothing to approve.' };
        }
        const bill = await loadBill(ctx.supabase, ctx.orgId, billId);
        if (!bill) return { status: 'FAILED', summary: 'The bill could not be read for approval.' };
        if (bill.status === 'APPROVED' || bill.status === 'PARTIALLY_PAID' || bill.status === 'PAID') {
          return {
            status: 'DONE',
            summary: `Bill already ${bill.status} through the gated approval path${bill.glEntryId ? ` (GL entry ${bill.glEntryId})` : ''}.`,
            statePatch: { billStatus: bill.status, glEntryId: bill.glEntryId },
          };
        }
        return {
          status: 'WAITING',
          summary: `Awaiting approval of the bill (${formatMoney(bill.totalCents)}).`,
          gatePrompt: `Approve this bill in Bills / Approvals. The existing gated approve path runs the AP policy gate + separation of duties and POSTS the payable (DR expense / CR Accounts Payable) through the deterministic posting engine. The agent will continue once the bill is APPROVED — it never approves or posts on your behalf. Reject to stop.`,
        };
      },
      async onAdvance(ctx, state): Promise<StepExecuteResult> {
        // OBSERVE only: proceed solely if the EXISTING gated approve path drove the
        // bill to APPROVED. The runner never approves or posts here.
        const billId = (state.billId as string | undefined) ?? undefined;
        if (!billId) return { status: 'DONE', summary: 'No bill to confirm.' };
        const bill = await loadBill(ctx.supabase, ctx.orgId, billId);
        if (!bill) return { status: 'FAILED', summary: 'The bill could not be re-read to confirm approval.' };
        if (bill.status === 'APPROVED' || bill.status === 'PARTIALLY_PAID' || bill.status === 'PAID') {
          return {
            status: 'DONE',
            summary: `Confirmed the bill reached ${bill.status} through the gated approval path${bill.glEntryId ? ` (posted GL entry ${bill.glEntryId})` : ''}. The agent posted nothing.`,
            statePatch: { billStatus: bill.status, glEntryId: bill.glEntryId },
            output: { billStatus: bill.status, glEntryId: bill.glEntryId },
          };
        }
        return {
          status: 'WAITING',
          summary: `Bill is still ${bill.status} — it has not been approved yet.`,
          gatePrompt: `The bill is still ${bill.status}. Approve it in Bills / Approvals first, then continue. The agent will not approve it for you.`,
        };
      },
    },

    // ── 5. Release to a pay run (HUMAN_GATE — prepares a PENDING disbursement) ─
    {
      name: 'release_pay_run',
      label: 'Release to Checks / Payments',
      kind: 'HUMAN_GATE',
      async execute(ctx, state): Promise<StepExecuteResult> {
        const billId = (state.billId as string | undefined) ?? undefined;
        if (!billId) {
          return { status: 'DONE', summary: 'No bill to release — nothing to pay.' };
        }
        const bill = await loadBill(ctx.supabase, ctx.orgId, billId);
        if (!bill) return { status: 'FAILED', summary: 'The bill could not be read for release.' };
        if (bill.status !== 'APPROVED' || bill.balanceCents <= 0) {
          return {
            status: 'DONE',
            summary: `Nothing to release — the bill is ${bill.status} with a ${formatMoney(bill.balanceCents)} balance.`,
          };
        }
        return {
          status: 'WAITING',
          summary: `Awaiting release of the bill (${formatMoney(bill.balanceCents)}) to the Checks / Payments path.`,
          gatePrompt: `Approve to RELEASE this bill (${formatMoney(bill.balanceCents)}) to the Checks / Payments path. The agent will only PREPARE a disbursement approval (pending review) — it never disburses, releases, or posts money. A separate authorized person must approve and release the payment (separation of duties). Reject to stop.`,
        };
      },
      async onAdvance(ctx, state): Promise<StepExecuteResult> {
        const billId = (state.billId as string | undefined) ?? undefined;
        if (!billId) return { status: 'DONE', summary: 'No bill to release.' };
        const preparedBy = ctx.userId;
        if (!preparedBy) {
          return {
            status: 'DONE',
            summary: 'Released to the Checks / Payments path. Run the Pay Run / Check Run there to queue and release the disbursement — the agent queues nothing without an actor.',
            output: { handedOff: true, queued: 0 },
          };
        }

        // Re-read the bill and re-check open approvals at release time (state may be stale).
        const bill = await loadBill(ctx.supabase, ctx.orgId, billId);
        if (!bill || bill.status !== 'APPROVED' || bill.balanceCents <= 0) {
          return {
            status: 'DONE',
            summary: `Nothing to release — the bill is ${bill?.status ?? 'gone'} with a ${formatMoney(bill?.balanceCents ?? 0)} balance.`,
            output: { queued: 0 },
          };
        }
        const open = await billsWithOpenApproval(ctx.supabase, [billId]);
        if (open.has(billId)) {
          return {
            status: 'DONE',
            summary: 'A disbursement approval is already in flight for this bill — nothing new to queue. A separate authorized person must approve and release it.',
            output: { queued: 0, alreadyQueued: 1 },
          };
        }

        // PREPARE the disbursement approval (DRAFT → PENDING_APPROVAL) — the exact
        // non-releasing prep the Pay Run / Check Run perform. Moves NO money.
        try {
          const approval = await createApproval(ctx.supabase, ctx.orgId, {
            kind: 'AP_DISBURSEMENT',
            subjectTable: 'bills',
            subjectId: billId,
            amountCents: bill.balanceCents,
            preparedBy,
          });
          await submitForApproval(ctx.supabase, ctx.orgId, approval.id, preparedBy);
        } catch (e) {
          return {
            status: 'FAILED',
            summary: `Could not queue the disbursement approval: ${e instanceof Error ? e.message : 'queue failed'}`,
          };
        }

        return {
          status: 'DONE',
          summary: `Released to the Checks / Payments path: queued a PENDING disbursement approval for ${formatMoney(bill.balanceCents)}. A separate authorized person must approve and release it — the agent moved no money.`,
          statePatch: { released: true },
          output: { queued: 1, amountCents: bill.balanceCents },
        };
      },
    },
  ],
};

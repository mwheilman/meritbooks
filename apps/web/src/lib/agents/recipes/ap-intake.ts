/**
 * AP INTAKE recipe (M9) — the first supervised agentic loop.
 *
 * Chains the pieces that ALREADY exist, stopping at the existing human gates:
 *
 *   1. extract        (AUTO)        Load the bill the AP intake parser already produced
 *                                   (lib/ap/intake → a PENDING/ON_HOLD draft). Pure read.
 *   2. propose_coding (PROPOSE)     Ask the existing categorizer (lib/services/categorization)
 *                                   for a GL account. Writes an ai_decisions row. The M10 dial
 *                                   (feature CATEGORIZATION) decides: AUTO ⇒ apply the coding to
 *                                   the bill's lines (reversible DATA ENTRY — never a GL post);
 *                                   otherwise WAIT for a human. Kill switch ⇒ WAIT.
 *   3. approval       (HUMAN_GATE)  Open the configured approval workflow (lib/approvals) for the
 *                                   bill and WAIT. The human approves through the EXISTING gated
 *                                   surface (Bills / Approvals) — which enforces SoD and POSTS the
 *                                   GL. The agent only OBSERVES that the bill reached APPROVED.
 *   4. handoff        (AUTO)        Record the outcome (the GL entry the existing approve path
 *                                   posted). The agent posts NOTHING here.
 *
 * SAFETY (canon §3): no step in this recipe posts money or hits the GL. The only ledger
 * effect — the approval → GL post — is performed entirely by the pre-existing, gated bill
 * approval engine when a human approves. The runner never approves on the human's behalf.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { formatMoney } from '@meritbooks/shared';
import type { AgentRecipe, AgentRunContext, AgentState, StepExecuteResult } from '../types';
import { getAnthropicApiKey } from '@/lib/ai/gateway';
import { suggestCategory } from '@/lib/services/categorization';
import { getTierPolicy, scoreToTier } from '@/lib/trust/score-tier';
import { resolveDispositionDetailed } from '@/lib/autonomy/disposition';
import { submitToWorkflow } from '@/lib/approvals/service';

const CATEGORIZE_FEATURE = 'CATEGORIZATION';

interface BillSnapshot {
  id: string;
  status: string;
  vendorId: string | null;
  vendorName: string | null;
  billNumber: string | null;
  totalCents: number;
  locationId: string | null;
  glEntryId: string | null;
}

/** Load a bill + its vendor name (cross-schema), scoped by the RLS client. */
async function loadBill(
  supabase: SupabaseClient,
  orgId: string,
  billId: string,
): Promise<BillSnapshot | null> {
  const { data: bill } = await supabase
    .from('bills')
    .select('id, status, vendor_id, bill_number, total_cents, location_id, gl_entry_id')
    .eq('org_id', orgId)
    .eq('id', billId)
    .maybeSingle();
  if (!bill) return null;
  const b = bill as {
    id: string;
    status: string;
    vendor_id: string | null;
    bill_number: string | null;
    total_cents: number | string;
    location_id: string | null;
    gl_entry_id: string | null;
  };

  let vendorName: string | null = null;
  if (b.vendor_id) {
    const { data: ven } = await supabase
      .schema('core')
      .from('vendors')
      .select('name, display_name')
      .eq('id', b.vendor_id)
      .maybeSingle();
    if (ven) {
      const v = ven as { name: string; display_name: string | null };
      vendorName = v.display_name ?? v.name;
    }
  }

  return {
    id: b.id,
    status: b.status,
    vendorId: b.vendor_id,
    vendorName,
    billNumber: b.bill_number,
    totalCents: Number(b.total_cents),
    locationId: b.location_id,
    glEntryId: b.gl_entry_id,
  };
}

/** Apply a proposed GL account to every line of a bill. DATA ENTRY, not a GL post. */
async function applyCodingToBill(
  supabase: SupabaseClient,
  orgId: string,
  billId: string,
  accountId: string,
): Promise<number> {
  const { data } = await supabase
    .from('bill_lines')
    .update({ account_id: accountId })
    .eq('org_id', orgId)
    .eq('bill_id', billId)
    .select('id');
  return (data as Array<{ id: string }> | null)?.length ?? 0;
}

export const apIntakeRecipe: AgentRecipe = {
  key: 'AP_INTAKE',
  label: 'AP Invoice Intake',
  description:
    'Reads an intaken vendor invoice, proposes its GL coding, routes it to the approval workflow, and hands the approved bill to the existing gated posting path. Pauses at every human gate.',
  feature: 'BILL_PARSE',

  async init(ctx, input) {
    const billId = typeof input.bill_id === 'string' ? input.bill_id.trim() : '';
    if (!billId) {
      return { error: 'A bill_id (from AP intake) is required to start this agent.' };
    }
    const bill = await loadBill(ctx.supabase, ctx.orgId, billId);
    if (!bill) return { error: 'Bill not found (or not in your organization).' };
    if (bill.status === 'PAID' || bill.status === 'VOIDED') {
      return { error: `This bill is already ${bill.status.toLowerCase()} — nothing for the agent to do.` };
    }

    const state: AgentState = {
      billId: bill.id,
      vendorId: bill.vendorId,
      vendorName: bill.vendorName,
      billNumber: bill.billNumber,
      totalCents: bill.totalCents,
      locationId: bill.locationId,
    };
    const who = bill.vendorName ?? 'vendor';
    return {
      title: `AP intake · ${who} · ${formatMoney(bill.totalCents)}`,
      state,
      subject: { table: 'bills', id: bill.id },
    };
  },

  steps: [
    // ── 1. Extract (AUTO) ─────────────────────────────────────────────────────
    {
      name: 'extract',
      label: 'Read intaken invoice',
      kind: 'AUTO',
      async execute(ctx, state): Promise<StepExecuteResult> {
        const billId = String(state.billId ?? '');
        const bill = await loadBill(ctx.supabase, ctx.orgId, billId);
        if (!bill) return { status: 'FAILED', summary: 'The bill disappeared before the agent could read it.' };

        const { count } = await ctx.supabase
          .from('bill_lines')
          .select('id', { count: 'exact', head: true })
          .eq('org_id', ctx.orgId)
          .eq('bill_id', billId);

        return {
          status: 'DONE',
          summary: `Read draft bill from ${bill.vendorName ?? 'unknown vendor'} for ${formatMoney(bill.totalCents)} (${count ?? 0} line${count === 1 ? '' : 's'}).`,
          statePatch: { status: bill.status, lineCount: count ?? 0 },
          output: {
            vendorName: bill.vendorName,
            billNumber: bill.billNumber,
            totalCents: bill.totalCents,
            status: bill.status,
            lineCount: count ?? 0,
          },
        };
      },
    },

    // ── 2. Propose coding (PROPOSE, dial-governed) ────────────────────────────
    {
      name: 'propose_coding',
      label: 'Propose GL coding',
      kind: 'PROPOSE',
      feature: CATEGORIZE_FEATURE,
      async execute(ctx, state): Promise<StepExecuteResult> {
        const billId = String(state.billId ?? '');
        const totalCents = Number(state.totalCents ?? 0);
        const vendorName = (state.vendorName as string | null) ?? null;
        const billNumber = (state.billNumber as string | null) ?? null;
        const locationId = (state.locationId as string | null) ?? ctx.locationId;

        const apiKey = getAnthropicApiKey();
        if (!apiKey) {
          return {
            status: 'WAITING',
            summary: 'AI categorization is unavailable (no API key) — a human should code this bill.',
            gatePrompt: 'AI categorization is unavailable. Review and code the bill manually, then approve to continue.',
          };
        }

        const description = [vendorName, billNumber ? `invoice ${billNumber}` : null]
          .filter(Boolean)
          .join(' ') || 'vendor invoice';

        const res = await suggestCategory(ctx.supabase, apiKey, {
          orgId: ctx.orgId,
          description,
          amountCents: totalCents,
          locationId,
        });
        if (!res.ok) {
          return {
            status: 'WAITING',
            summary: `Could not propose coding automatically (${res.error}) — a human should code this bill.`,
            gatePrompt: 'Automatic coding failed. Review and code the bill manually, then approve to continue.',
          };
        }

        const s = res.suggestion;
        const policy = await getTierPolicy(ctx.supabase, ctx.orgId);
        const { tier } = scoreToTier({ confidence: s.confidence, amountCents: totalCents }, policy);
        const disp = await resolveDispositionDetailed({
          orgId: ctx.orgId,
          feature: CATEGORIZE_FEATURE,
          scoreTier: tier,
          amountCents: totalCents,
          supabase: ctx.supabase,
        });

        const codeLabel = s.accountNumber
          ? `${s.accountNumber} ${s.accountName ?? ''}`.trim()
          : (s.accountName ?? 'an account');

        const statePatch: AgentState = {
          proposedAccountId: s.accountId,
          proposedAccountLabel: codeLabel,
          codingConfidence: s.confidence,
          codingDecisionId: s.decisionId,
        };

        // The dial permits auto-apply AND we have a resolvable account ⇒ apply the
        // coding (reversible data entry) and advance. Otherwise pause for a human.
        if (disp.disposition === 'AUTO' && s.accountId) {
          const n = await applyCodingToBill(ctx.supabase, ctx.orgId, billId, s.accountId);
          return {
            status: 'DONE',
            summary: `Auto-applied coding to ${codeLabel} on ${n} line${n === 1 ? '' : 's'} (dial: AUTO, ${Math.round(s.confidence * 100)}% conf). ${disp.reason}`,
            disposition: 'AUTO',
            aiDecisionId: s.decisionId,
            statePatch: { ...statePatch, codingApplied: true, linesCoded: n },
            output: { account: codeLabel, confidence: s.confidence, disposition: 'AUTO', reasoning: s.reasoning },
          };
        }

        return {
          status: 'WAITING',
          summary: `Proposed coding to ${codeLabel} (${Math.round(s.confidence * 100)}% conf). ${disp.reason}`,
          disposition: disp.disposition,
          aiDecisionId: s.decisionId,
          statePatch,
          gatePrompt: `Proposed GL account: ${codeLabel} (${Math.round(s.confidence * 100)}% confidence). Approve to apply this coding to the bill, or reject to stop and code it by hand.`,
          output: { account: codeLabel, confidence: s.confidence, disposition: disp.disposition, reasoning: s.reasoning },
        };
      },
      async onAdvance(ctx, state, action): Promise<StepExecuteResult> {
        // Human approved the proposed coding → apply it (data entry, not a GL post).
        const billId = String(state.billId ?? '');
        const accountId = (state.proposedAccountId as string | null) ?? null;
        const codeLabel = (state.proposedAccountLabel as string | null) ?? 'the proposed account';
        if (!accountId) {
          // No machine account to apply — treat approval as "coded manually elsewhere".
          return {
            status: 'DONE',
            summary: action.note ? `Coding confirmed by reviewer: ${action.note}` : 'Coding confirmed by the reviewer.',
          };
        }
        const n = await applyCodingToBill(ctx.supabase, ctx.orgId, billId, accountId);
        return {
          status: 'DONE',
          summary: `Reviewer approved — applied coding to ${codeLabel} on ${n} line${n === 1 ? '' : 's'}.`,
          statePatch: { codingApplied: true, linesCoded: n },
        };
      },
    },

    // ── 3. Approval (HUMAN_GATE — always pauses) ──────────────────────────────
    {
      name: 'approval',
      label: 'Route for approval',
      kind: 'HUMAN_GATE',
      async execute(ctx, state): Promise<StepExecuteResult> {
        const billId = String(state.billId ?? '');
        const totalCents = Number(state.totalCents ?? 0);

        // Open the configured multi-step approval workflow for this bill, if one
        // exists. Degrade-safe: no active workflow ⇒ the human approves the bill the
        // normal way and we still observe the APPROVED status.
        let workflowNote = 'No multi-step workflow configured — approve the bill in Bills.';
        try {
          const sub = await submitToWorkflow(ctx.supabase, ctx.orgId, {
            docType: 'BILL',
            docId: billId,
            amountCents: totalCents,
            preparedBy: ctx.userId ?? 'agent',
          });
          if (sub.entered && sub.request) {
            workflowNote = `Opened approval request at step ${sub.request.currentStep}. Approve it in Approvals.`;
          }
        } catch {
          /* degrade-safe — fall back to the plain bill approval */
        }

        return {
          status: 'WAITING',
          summary: `Awaiting human approval. ${workflowNote}`,
          gatePrompt: `${workflowNote} The agent will continue once the bill is APPROVED. The agent never approves on your behalf.`,
          statePatch: { workflowNote },
        };
      },
      async onAdvance(ctx, state): Promise<StepExecuteResult> {
        // OBSERVE only: proceed solely if the EXISTING gated approve path has driven
        // the bill to APPROVED. The runner never approves or posts here.
        const billId = String(state.billId ?? '');
        const bill = await loadBill(ctx.supabase, ctx.orgId, billId);
        if (!bill) return { status: 'FAILED', summary: 'The bill could not be re-read to confirm approval.' };
        if (bill.status === 'APPROVED' || bill.status === 'SCHEDULED' || bill.status === 'PARTIALLY_PAID' || bill.status === 'PAID') {
          return {
            status: 'DONE',
            summary: `Confirmed the bill reached ${bill.status} through the gated approval path.`,
            statePatch: { billStatus: bill.status, glEntryId: bill.glEntryId },
          };
        }
        return {
          status: 'WAITING',
          summary: `Bill is still ${bill.status} — it has not been approved yet.`,
          gatePrompt: `The bill is still ${bill.status}. Approve it in Bills / Approvals first, then continue. The agent will not approve it for you.`,
        };
      },
    },

    // ── 4. Handoff (AUTO — records the outcome; posts nothing) ─────────────────
    {
      name: 'handoff',
      label: 'Confirm posting',
      kind: 'AUTO',
      async execute(ctx, state): Promise<StepExecuteResult> {
        const billId = String(state.billId ?? '');
        const bill = await loadBill(ctx.supabase, ctx.orgId, billId);
        if (!bill) return { status: 'FAILED', summary: 'The bill could not be re-read at handoff.' };
        return {
          status: 'DONE',
          summary: bill.glEntryId
            ? `Done. The gated approval path posted GL entry ${bill.glEntryId}. The agent posted nothing.`
            : `Done. Bill is ${bill.status}; the gated approval path owns any GL posting. The agent posted nothing.`,
          statePatch: { billStatus: bill.status, glEntryId: bill.glEntryId },
          output: { billStatus: bill.status, glEntryId: bill.glEntryId },
        };
      },
    },
  ],
};

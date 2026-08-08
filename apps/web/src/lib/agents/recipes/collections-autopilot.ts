/**
 * COLLECTIONS AUTOPILOT recipe (M9) — the supervised AR-dunning loop.
 *
 * Chains the pieces that the collections engine ALREADY ships (lib/collections/*)
 * and the existing gated send route (app/api/collections/send), stopping at the
 * human gate before anything leaves the building. It NEVER sends an email itself:
 *
 *   1. assess   (AUTO)        Pull the invoice's aging, the customer's predicted pay
 *                             date, and the next scheduled dunning step — reusing the
 *                             SAME deterministic prediction + cadence authority the
 *                             worklist uses (lib/collections: loadWorklist →
 *                             predictPayDate / nextCadenceStep). Pure read.
 *   2. draft    (PROPOSE)     Generate the tone-matched dunning message for that cadence
 *                             stage through the EXISTING draft path (deterministicDunningDraft
 *                             + the DUNNING_DRAFT gateway phrasing, degrade-safe). Writes an
 *                             ai_decisions row (via the runner's per-step Decision Log) and
 *                             consults the M10 dial (feature DUNNING_DRAFT): AUTO ⇒ the draft
 *                             auto-advances to the send gate; anything else ⇒ it WAITS for a
 *                             human to review/edit the draft first. Either way it NEVER sends.
 *   3. approve_and_send (HUMAN_GATE)  ALWAYS pauses. The human reviews the draft and sends it
 *                             through the EXISTING gated collections send path
 *                             (POST /api/collections/send) — which enforces AR permission,
 *                             refuses when email is unconfigured, and records REMINDER_SENT
 *                             ONLY after the provider accepts. The agent then OBSERVES that a
 *                             new REMINDER_SENT landed; it never sends on the human's behalf.
 *   4. record   (AUTO)        Log the confirmed send outcome and compute the NEXT cadence
 *                             checkpoint (nextCadenceStep, now that this stage has been sent).
 *                             No side effects.
 *
 * SAFETY (canon §3): the cadence LADDER (deterministic) decides the stage; the model only
 * phrases the letter; and the SEND is a separate, human-approved action performed by the
 * pre-existing gated route. This recipe calls no send/provider API and moves no money — it
 * cannot send without the human clearing the gated surface (mirrors the AP-intake approval
 * step's observe-only contract).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { formatMoney } from '@meritbooks/shared';
import { runAiGateway } from '@meritbooks/core-ai';
import type { AgentRecipe, AgentRunContext, AgentState, StepExecuteResult } from '../types';
import { getAnthropicApiKey } from '@/lib/ai/gateway';
import { createAdminSupabase } from '@/lib/supabase/server';
import { loadInvoiceDocById } from '@/lib/invoices/invoice-doc';
import { getTierPolicy, scoreToTier } from '@/lib/trust/score-tier';
import { resolveDispositionDetailed } from '@/lib/autonomy/disposition';
import { loadWorklist } from '@/lib/collections/data';
import {
  cadenceStageForDays,
  getDunningStage,
  nextCadenceStep,
  deterministicDunningDraft,
  dunningSystemPrompt,
  dunningUserPrompt,
  parseDunningReply,
  DUNNING_DRAFT_FEATURE,
  DUNNING_DRAFT_MODEL,
  type DunningFacts,
  type DunningStageKey,
  type PayPrediction,
  type NextCadenceStep,
  type WorklistAccount,
  type WorklistInvoice,
} from '@/lib/collections';

const CLOSED_STATUSES = new Set(['PAID', 'VOIDED', 'WRITTEN_OFF', 'DRAFT']);

// ── small helpers ─────────────────────────────────────────────────────────────

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}
function isoDate(v: unknown): string | null {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
function daysOverdue(dueDate: string, asOf: string): number {
  const due = Date.parse(`${dueDate.slice(0, 10)}T00:00:00Z`);
  const at = Date.parse(`${asOf.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(due) || Number.isNaN(at)) return 0;
  return Math.max(0, Math.floor((at - due) / 86_400_000));
}
function extractText(result: unknown): string | null {
  if (!Array.isArray(result)) return null;
  const b = (result as Array<{ type?: string; text?: string }>).find((c) => c?.type === 'text');
  return b?.text ?? null;
}

/** Minimal identity (customer/location) for an invoice — the doc interface hides these. */
interface InvoiceIdentity {
  customerId: string | null;
  locationId: string | null;
  balanceCents: number;
  status: string;
}
async function loadInvoiceIdentity(
  supabase: SupabaseClient,
  orgId: string,
  invoiceId: string,
): Promise<InvoiceIdentity | null> {
  const { data } = await supabase
    .from('invoices')
    .select('customer_id, location_id, balance_cents, status')
    .eq('org_id', orgId)
    .eq('id', invoiceId)
    .maybeSingle();
  if (!data) return null;
  const r = data as { customer_id: string | null; location_id: string | null; balance_cents: number | string; status: string };
  return {
    customerId: r.customer_id,
    locationId: r.location_id,
    balanceCents: Number(r.balance_cents ?? 0),
    status: r.status,
  };
}

/** Timestamp of the most-recent REMINDER_SENT for an invoice (baseline / observe). */
async function latestReminderAt(
  supabase: SupabaseClient,
  orgId: string,
  invoiceId: string,
): Promise<{ at: string | null; stage: string | null; to: string | null; messageId: string | null }> {
  const { data } = await supabase
    .from('invoice_events')
    .select('created_at, meta')
    .eq('org_id', orgId)
    .eq('event_type', 'REMINDER_SENT')
    .eq('invoice_id', invoiceId)
    .order('created_at', { ascending: false })
    .limit(1);
  const row = (data as Array<{ created_at: string; meta: Record<string, unknown> | null }> | null)?.[0];
  if (!row) return { at: null, stage: null, to: null, messageId: null };
  const meta = row.meta ?? {};
  return {
    at: row.created_at,
    stage: (meta.stage as string) ?? (meta.tier as string) ?? null,
    to: (meta.to as string) ?? null,
    messageId: (meta.message_id as string) ?? null,
  };
}

/** Find the worklist account + specific invoice for a target, from the shared ranker. */
function locateInWorklist(
  accounts: WorklistAccount[],
  invoiceId: string,
  customerId: string | null,
): { account: WorklistAccount; invoice: WorklistInvoice | null } | null {
  for (const acc of accounts) {
    const inv = acc.invoices.find((i) => i.id === invoiceId) ?? null;
    if (inv) return { account: acc, invoice: inv };
  }
  if (customerId) {
    const acc = accounts.find((a) => a.customerId === customerId);
    if (acc) return { account: acc, invoice: acc.invoices.find((i) => i.id === (acc.focusInvoiceId ?? '')) ?? acc.invoices[0] ?? null };
  }
  return null;
}

// ── input parsing ──────────────────────────────────────────────────────────────

interface AutopilotInput {
  invoiceId: string | null;
  customerId: string | null;
  asOf: string;
  locationId: string | null;
}
function parseInput(input: Record<string, unknown>): AutopilotInput {
  return {
    invoiceId: asString(input.invoiceId) ?? asString(input.invoice_id),
    customerId: asString(input.customerId) ?? asString(input.customer_id),
    asOf: isoDate(input.asOf) ?? isoDate(input.as_of) ?? todayIso(),
    locationId: asString(input.locationId) ?? asString(input.location_id),
  };
}

// ── recipe ───────────────────────────────────────────────────────────────────

export const collectionsAutopilotRecipe: AgentRecipe = {
  key: 'COLLECTIONS_AUTOPILOT',
  label: 'Collections Autopilot',
  description:
    "Chases an overdue invoice the safe way: reads its aging, predicted pay date, and next scheduled dunning step; drafts the tone-matched reminder for that cadence stage; pauses for a human to review and send it through the gated collections send path; then logs the outcome and the next checkpoint. The agent never sends an email or moves money on its own.",
  feature: DUNNING_DRAFT_FEATURE,

  async init(ctx, input) {
    const parsed = parseInput(input);
    let invoiceId = parsed.invoiceId;

    // Customer-only start → resolve the account's focus (worst) overdue invoice.
    if (!invoiceId && parsed.customerId) {
      const wl = await loadWorklist(ctx.supabase, ctx.orgId, { asOf: parsed.asOf, locationId: parsed.locationId });
      const acc = wl.accounts.find((a) => a.customerId === parsed.customerId);
      if (!acc) return { error: 'No open or overdue invoices found for that customer.' };
      invoiceId = acc.focusInvoiceId ?? acc.invoices[0]?.id ?? null;
      if (!invoiceId) return { error: 'That customer has no open invoice to chase.' };
    }
    if (!invoiceId) {
      return { error: 'An invoiceId (or a customerId with an overdue balance) is required to start collections autopilot.' };
    }

    const identity = await loadInvoiceIdentity(ctx.supabase, ctx.orgId, invoiceId);
    if (!identity) return { error: 'Invoice not found (or not in your organization).' };
    if (CLOSED_STATUSES.has(identity.status) || identity.balanceCents <= 0) {
      return { error: `This invoice is ${identity.status.toLowerCase()} with no open balance — nothing to chase.` };
    }

    const doc = await loadInvoiceDocById(ctx.supabase, ctx.orgId, invoiceId);
    if (!doc) return { error: 'Invoice could not be loaded.' };

    const customerName = doc.customer?.name ?? 'the customer';
    const state: AgentState = {
      invoiceId,
      invoiceNumber: doc.invoice_number,
      customerId: identity.customerId ?? parsed.customerId,
      customerName,
      customerEmail: doc.customer?.email ?? null,
      supplierName: doc.entity?.name ?? 'Your supplier',
      balanceCents: doc.balance_cents,
      dueDate: doc.due_date,
      invoiceDate: doc.invoice_date,
      asOf: parsed.asOf,
      locationId: identity.locationId ?? parsed.locationId,
      publicToken: doc.public_token || null,
      runStartedAt: new Date().toISOString(),
    };

    return {
      title: `Collections · ${customerName} · Inv ${doc.invoice_number} · ${formatMoney(doc.balance_cents)}`,
      state,
      subject: { table: 'invoices', id: invoiceId },
    };
  },

  steps: [
    // ── 1. Assess: aging + predicted pay date + next cadence step (AUTO) ────────
    {
      name: 'assess',
      label: 'Assess aging, pay-date & next step',
      kind: 'AUTO',
      async execute(ctx, state): Promise<StepExecuteResult> {
        const invoiceId = String(state.invoiceId ?? '');
        const customerId = (state.customerId as string | null) ?? null;
        const asOf = String(state.asOf ?? todayIso());
        const locationId = (state.locationId as string | null) ?? null;
        const dueDate = String(state.dueDate ?? '');
        const customerName = (state.customerName as string | null) ?? 'the customer';
        const balanceCents = Number(state.balanceCents ?? 0);

        const overdue = daysOverdue(dueDate, asOf);

        // Reuse the SAME deterministic ranker the worklist uses: it hands back the
        // per-invoice pay-date prediction, the next scheduled cadence step, and the
        // recommended action. The agent never re-derives any of this.
        let prediction: PayPrediction | null = null;
        let nextStep: NextCadenceStep | null = null;
        let recommendedActionKind: string | null = null;
        let stageKey: DunningStageKey;
        try {
          const wl = await loadWorklist(ctx.supabase, ctx.orgId, { asOf, locationId });
          const located = locateInWorklist(wl.accounts, invoiceId, customerId);
          if (located?.invoice) {
            prediction = located.invoice.prediction;
            nextStep = located.invoice.nextStep;
            recommendedActionKind = located.account.recommendedAction.kind;
          }
        } catch {
          /* degrade-safe — fall back to a pure cadence read below */
        }
        // Target stage: the cadence authority's next step if it names one, else the
        // stage the invoice qualifies for at its current aging, else a first notice.
        stageKey =
          nextStep?.stage.key ?? cadenceStageForDays(overdue)?.key ?? 'FIRST_NOTICE';
        const stage = getDunningStage(stageKey);

        // Snapshot the current reminder history so the send gate can detect a NEW send.
        const baseline = await latestReminderAt(ctx.supabase, ctx.orgId, invoiceId);

        const predictionBit = prediction
          ? ` Predicted pay date ${prediction.predictedPayDate} (${prediction.predictedDaysLate > 0 ? `~${prediction.predictedDaysLate}d late` : 'on/before due'}, ${prediction.confidence} confidence).`
          : ' No pay-date prediction (insufficient history).';
        const nextBit = nextStep
          ? ` Next scheduled step: ${nextStep.reason}`
          : ` Cadence stage: ${stage.label}.`;

        return {
          status: 'DONE',
          summary: `Invoice ${state.invoiceNumber ?? ''} for ${customerName}: ${formatMoney(balanceCents)}, ${overdue}d overdue.${predictionBit}${nextBit}`,
          statePatch: {
            daysOverdue: overdue,
            stageKey,
            stageLabel: stage.label,
            tone: stage.tone,
            predictedPayDate: prediction?.predictedPayDate ?? null,
            predictedDaysLate: prediction?.predictedDaysLate ?? null,
            predictionRationale: prediction?.rationale ?? null,
            predictionConfidence: prediction?.confidenceScore ?? null,
            nextStepReason: nextStep?.reason ?? null,
            recommendedActionKind,
            reminderBaselineAt: baseline.at,
          },
          output: {
            daysOverdue: overdue,
            stage: stageKey,
            stageLabel: stage.label,
            predictedPayDate: prediction?.predictedPayDate ?? null,
            predictedDaysLate: prediction?.predictedDaysLate ?? null,
            predictionConfidence: prediction?.confidenceScore ?? null,
            recommendedAction: recommendedActionKind,
            nextStep: nextStep?.reason ?? null,
          },
        };
      },
    },

    // ── 2. Draft the reminder for the cadence stage (PROPOSE, dial-governed) ────
    {
      name: 'draft',
      label: 'Draft dunning reminder',
      kind: 'PROPOSE',
      feature: DUNNING_DRAFT_FEATURE,
      async execute(ctx, state): Promise<StepExecuteResult> {
        const invoiceId = String(state.invoiceId ?? '');
        const stageKey = (state.stageKey as DunningStageKey | undefined) ?? 'FIRST_NOTICE';
        const stage = getDunningStage(stageKey);

        // Re-read the invoice so we never draft against a stale balance/status.
        const doc = await loadInvoiceDocById(ctx.supabase, ctx.orgId, invoiceId);
        if (!doc) return { status: 'FAILED', summary: 'The invoice could not be re-read to draft a reminder.' };
        if (CLOSED_STATUSES.has(doc.status) || doc.balance_cents <= 0) {
          return { status: 'FAILED', summary: `Invoice is ${doc.status.toLowerCase()} with no open balance — nothing to remind on.` };
        }

        const overdue = daysOverdue(doc.due_date, String(state.asOf ?? todayIso()));
        const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '') ?? 'https://meritbooks-web.vercel.app';
        const facts: DunningFacts = {
          customerName: doc.customer?.name ?? 'Valued customer',
          supplierName: doc.entity?.name ?? (state.supplierName as string | null) ?? 'Your supplier',
          invoiceNumber: doc.invoice_number,
          invoiceDate: doc.invoice_date,
          dueDate: doc.due_date,
          balanceCents: doc.balance_cents,
          daysOverdue: overdue,
          payUrl: doc.public_token ? `${base}/pay/${doc.public_token}` : null,
        };

        // Deterministic letter first (always available); AI only re-phrases it.
        const deterministic = deterministicDunningDraft(stageKey, facts);
        let draft = deterministic;
        let aiUsed = false;
        const apiKey = getAnthropicApiKey();
        if (apiKey) {
          try {
            const admin = createAdminSupabase();
            const gw = await runAiGateway(
              { supabase: admin, anthropicApiKey: apiKey },
              {
                tenant_id: ctx.orgId,
                user_id: ctx.userId,
                module: 'BOOKS',
                feature: DUNNING_DRAFT_FEATURE,
                model: DUNNING_DRAFT_MODEL,
                system: dunningSystemPrompt(),
                messages: [{ role: 'user', content: [{ type: 'text', text: dunningUserPrompt(stageKey, facts) }] }],
                max_tokens: 500,
              },
            );
            if (gw.status !== 'blocked' && gw.result != null) {
              const text = extractText(gw.result);
              const parsed = text ? parseDunningReply(text, stageKey, stage.tone) : null;
              if (parsed) { draft = parsed; aiUsed = true; }
            }
          } catch (e) {
            console.error('[collections-autopilot draft] gateway failed, using deterministic', e);
          }
        }

        // Consult the M10 dial (feature DUNNING_DRAFT). The cadence stage is
        // deterministic, so confidence rides the pay-date prediction (default high);
        // materiality is the open balance. AUTO here only auto-ADVANCES the draft to
        // the human send gate — it can never auto-send.
        const confidence = typeof state.predictionConfidence === 'number' ? state.predictionConfidence : 0.9;
        const policy = await getTierPolicy(ctx.supabase, ctx.orgId);
        const { tier } = scoreToTier({ confidence, amountCents: doc.balance_cents }, policy);
        const disp = await resolveDispositionDetailed({
          orgId: ctx.orgId,
          feature: DUNNING_DRAFT_FEATURE,
          scoreTier: tier,
          amountCents: doc.balance_cents,
          supabase: ctx.supabase,
        });

        const statePatch: AgentState = {
          draftSubject: draft.subject,
          draftBody: draft.body,
          draftAiUsed: aiUsed,
          stageKey,
        };
        const outputBase = {
          stage: stageKey,
          stageLabel: stage.label,
          tone: stage.tone,
          subject: draft.subject,
          aiUsed,
          disposition: disp.disposition,
        };

        if (disp.disposition === 'AUTO') {
          return {
            status: 'DONE',
            summary: `Drafted the ${stage.label} reminder${aiUsed ? ' (AI-phrased)' : ' (template)'} — dial AUTO, advancing to the human send gate. ${disp.reason}`,
            disposition: 'AUTO',
            statePatch,
            output: outputBase,
          };
        }
        return {
          status: 'WAITING',
          summary: `Drafted the ${stage.label} reminder${aiUsed ? ' (AI-phrased)' : ' (template)'}. ${disp.reason}`,
          disposition: disp.disposition,
          statePatch,
          gatePrompt: `Review the drafted ${stage.label} reminder — "${draft.subject}". Approve to carry it to the send gate, or reject to stop. Nothing is sent by approving here.`,
          output: outputBase,
        };
      },
      async onAdvance(ctx, state, action): Promise<StepExecuteResult> {
        // Human reviewed the draft. If they left an edited body in the note, keep it.
        const editedBody = asString(action.note);
        const stageLabel = (state.stageLabel as string | null) ?? 'reminder';
        return {
          status: 'DONE',
          summary: `Reviewer approved the ${stageLabel} draft${editedBody ? ' (edited)' : ''} — proceeding to the human send gate.`,
          statePatch: editedBody ? { draftBody: editedBody, draftEdited: true } : {},
        };
      },
    },

    // ── 3. Approve & send via the gated collections path (HUMAN_GATE) ──────────
    {
      name: 'approve_and_send',
      label: 'Approve & send reminder',
      kind: 'HUMAN_GATE',
      async execute(ctx, state): Promise<StepExecuteResult> {
        const stageLabel = (state.stageLabel as string | null) ?? 'reminder';
        const subject = (state.draftSubject as string | null) ?? `${stageLabel}`;
        const email = (state.customerEmail as string | null) ?? null;
        const balanceCents = Number(state.balanceCents ?? 0);
        const emailBit = email
          ? `It will be emailed to ${email}.`
          : 'No customer email is on file — add one before sending.';
        return {
          status: 'WAITING',
          summary: `Awaiting human approval to send the ${stageLabel} reminder (${formatMoney(balanceCents)}).`,
          gatePrompt: `Send the ${stageLabel} reminder "${subject}" from Collections — the gated send path checks your AR permission, verifies email is configured, and records it only after the provider accepts. ${emailBit} Once you send it there, approve here to confirm; reject to stop. The agent never sends on your behalf.`,
        };
      },
      async onAdvance(ctx, state): Promise<StepExecuteResult> {
        // OBSERVE only: proceed solely once the EXISTING gated send route has recorded
        // a NEW REMINDER_SENT for this invoice. The agent sends nothing itself.
        const invoiceId = String(state.invoiceId ?? '');
        const baselineAt = (state.reminderBaselineAt as string | null) ?? null;
        const latest = await latestReminderAt(ctx.supabase, ctx.orgId, invoiceId);
        const isNew = latest.at != null && (baselineAt == null || latest.at > baselineAt);

        if (!isNew) {
          return {
            status: 'WAITING',
            summary: 'No reminder send has been recorded yet for this invoice.',
            gatePrompt: 'The reminder has not been sent through the gated Collections send path yet. Send it there first, then approve here to confirm. The agent will not send it for you.',
          };
        }

        return {
          status: 'DONE',
          summary: `Confirmed a reminder was sent${latest.to ? ` to ${latest.to}` : ''}${latest.stage ? ` (${latest.stage})` : ''} through the gated Collections send path.`,
          statePatch: {
            sentAt: latest.at,
            sentStage: latest.stage,
            sentTo: latest.to,
            sentMessageId: latest.messageId,
          },
          output: { sentAt: latest.at, stage: latest.stage, to: latest.to, messageId: latest.messageId },
        };
      },
    },

    // ── 4. Record outcome + compute the next cadence checkpoint (AUTO) ──────────
    {
      name: 'record',
      label: 'Record outcome & next checkpoint',
      kind: 'AUTO',
      async execute(ctx, state): Promise<StepExecuteResult> {
        const invoiceId = String(state.invoiceId ?? '');
        const asOf = String(state.asOf ?? todayIso());
        const dueDate = String(state.dueDate ?? '');
        const sentAt = (state.sentAt as string | null) ?? null;
        const sentStageRaw = (state.sentStage as string | null) ?? (state.stageKey as string | null) ?? null;
        const stageKey = (sentStageRaw as DunningStageKey | null) ?? null;

        const overdue = daysOverdue(dueDate, asOf);

        // Now that this stage has been sent, project the NEXT scheduled checkpoint
        // through the SAME cadence authority (re-nudge or the next escalation rung).
        const next = dueDate
          ? nextCadenceStep({
              dueDate,
              daysOverdue: overdue,
              lastStageSent: stageKey,
              lastReminderAt: sentAt,
              asOf,
            })
          : null;

        const nextBit = next
          ? `Next checkpoint: ${next.stage.label} on ${next.scheduledDate} (${next.isDueNow ? 'due now' : `in ${next.daysUntil}d`}).`
          : 'No further cadence step projected.';

        return {
          status: 'DONE',
          summary: `Logged the ${stageKey ? getDunningStage(stageKey).label : 'reminder'} for invoice ${state.invoiceNumber ?? ''}. ${nextBit}`,
          statePatch: {
            nextCheckpointStage: next?.stage.key ?? null,
            nextCheckpointDate: next?.scheduledDate ?? null,
            nextCheckpointReason: next?.reason ?? null,
          },
          output: {
            sentStage: stageKey,
            sentAt,
            nextCheckpointStage: next?.stage.key ?? null,
            nextCheckpointDate: next?.scheduledDate ?? null,
            nextCheckpointDueNow: next?.isDueNow ?? null,
            nextCheckpointReason: next?.reason ?? null,
          },
        };
      },
    },
  ],
};

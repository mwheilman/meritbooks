/**
 * `ar.recurring` — generate every recurring invoice that has come due (AR-07, FPB-invoices D6.1).
 *
 * Calls the SAME engine the Invoices → Recurring "Generate now" button uses
 * (lib/invoices/recurring-invoices.ts → createInvoice), so numbering, rev-rec treatment and
 * GL posting never fork. What the scheduled run may do per template is the STRICTER of:
 *
 *   • the template's own setting (generate_mode: DRAFT · POST · POST_AND_SEND), and
 *   • the tenant's "Scheduled recurring invoices" autonomy dial, asked with that template's
 *     due total: PROPOSE / OFF / kill switch / over the cap → DRAFT (an invoice for a person
 *     to review, post and send — no GL effect); AUTO_UNDER_LIMIT within the cap → the
 *     template's own mode (post, or post and email).
 *
 * IDEMPOTENT per template + period: `next_run_date` advances past the run, and every
 * generated invoice carries source_ref `recurring:<template>:<date>` (unique per org), so a
 * retry after a crash adopts the invoice instead of creating a second one.
 *
 * The cap is PER RUN, not per template: the gate is asked with the RUNNING total this run
 * would post (everything already auto-posted + this template), so ten templates each just
 * under the cap can't together post ten times it. Once the running total would exceed the
 * cap, every remaining template goes to DRAFT.
 *
 * Period locks: a period whose month is HARD_CLOSE makes createInvoice's AR post fail; the
 * invoice is then left DRAFT (best-effort GL, the interactive behaviour) and reported.
 */

import { generateDueRecurringInvoices, type RecurringDueTemplate, type RecurringGenerateMode } from '@/lib/invoices/recurring-invoices';
import { postingGate, SCHEDULED_RECURRING_INVOICES_FEATURE, type PostingGateResult } from '../posting-gate';
import type { CountValue, JobContext, JobResult } from '../types';
import { isoDate, scopedOrFail } from './shared';

export interface CumulativeDecider {
  decideMode: (t: RecurringDueTemplate) => Promise<RecurringGenerateMode>;
  /** Cents this run has auto-posted so far (the running total the cap is compared to). */
  postedCents: () => number;
  draftedByDial: () => number;
  gates: Record<string, CountValue>;
}

/**
 * Per-run cap tracker (pure apart from the injected gate; exported for tests). Templates
 * are decided one at a time (the engine awaits each); the gate sees the RUNNING total.
 */
export function cumulativeDecider(gate: (amountCents: number) => Promise<Pick<PostingGateResult, 'allowed' | 'disposition'>>): CumulativeDecider {
  let posted = 0;
  let drafted = 0;
  const gates: Record<string, CountValue> = {};
  return {
    gates,
    postedCents: () => posted,
    draftedByDial: () => drafted,
    decideMode: async (t) => {
      if (t.mode === 'DRAFT') return 'DRAFT';
      const amount = Math.max(0, Math.round(t.amountCents));
      const g = await gate(posted + amount);
      gates[`gate_${t.id.slice(0, 8)}`] = g.disposition;
      if (!g.allowed) {
        drafted += t.runs;
        return 'DRAFT';
      }
      posted += amount;
      return t.mode;
    },
  };
}

export async function runRecurringInvoicesJob(ctx: JobContext): Promise<JobResult> {
  const s = scopedOrFail(ctx);
  if (!s.ok) return s.result;
  const asOf = isoDate(ctx.now);
  const decider = cumulativeDecider((amountCents) => postingGate(ctx.admin, s.orgId, SCHEDULED_RECURRING_INVOICES_FEATURE, amountCents));
  const gates = decider.gates;

  const res = await generateDueRecurringInvoices(s.db, s.orgId, asOf, {
    signal: ctx.signal,
    decideMode: decider.decideMode,
  });
  const draftedByDial = decider.draftedByDial();

  const created = res.invoices_created;
  const drafted = res.invoices_drafted;
  const posted = created - drafted;
  const failed = res.errors.length;

  const counts: Record<string, CountValue> = {
    as_of: asOf,
    templates: res.templates_processed,
    created,
    posted,
    drafted,
    drafted_by_dial: draftedByDial,
    auto_posted_cents: decider.postedCents(),
    emailed: res.invoices_sent,
    already_generated: res.already_generated,
    errors: failed,
    ...gates,
  };

  if (res.templates_processed === 0 && failed === 0) {
    return { status: 'ok', itemsProcessed: 0, counts, summary: 'No recurring invoices are due.' };
  }

  const parts: string[] = [];
  if (posted > 0) parts.push(`Posted ${posted} recurring invoice(s)${res.invoices_sent ? ` and emailed ${res.invoices_sent}` : ''}.`);
  if (drafted > 0) {
    parts.push(
      `Created ${drafted} draft invoice(s) for review${draftedByDial > 0 ? ' (your autonomy dial keeps scheduled invoices as drafts)' : ''} — post and send them from Invoices → Drafts.`,
    );
  }
  if (res.already_generated > 0) parts.push(`${res.already_generated} period(s) were already invoiced (not duplicated).`);
  if (failed > 0) parts.push(`${failed} template(s) need attention.`);

  return {
    status: failed === 0 ? 'ok' : created > 0 ? 'partial' : 'failed',
    itemsProcessed: created,
    counts,
    summary: parts.join(' ') || `Checked ${res.templates_processed} template(s); nothing new to invoice.`,
    error: failed ? res.errors.map((e) => `${e.template_id} ${e.run_date}: ${e.error}`).slice(0, 10).join('; ') : undefined,
  };
}

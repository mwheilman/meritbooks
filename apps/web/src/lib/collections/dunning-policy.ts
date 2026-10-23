/**
 * The dunning POLICY (migration 184 public.dunning_policies) — the ladder a tenant or a
 * company runs: which reminders go out how many days from the due date, what each says,
 * draft-or-send, and when to stop. Pure: types, defaults, validation, merge, rendering.
 *
 * The stage keys extend the existing collections ladder (cadence.ts DUNNING_LADDER:
 * FIRST / SECOND / THIRD / FINAL notice) with a pre-due COURTESY reminder (FPB-invoices
 * D6.2: "3 days before due, on due, +7, +14, +30"). Stages recorded on invoice_events
 * REMINDER_SENT keep driving the Collections worklist exactly as before.
 *
 * A blank subject / body uses the built-in copy (dunning-copy.ts deterministicDunningDraft —
 * every figure authored in code, never by a model).
 */

import { z } from 'zod';
import { deterministicDunningDraft, type DunningFacts } from './dunning-copy';
import type { DunningStageKey } from './cadence';

export const DUNNING_STEP_STAGES = ['COURTESY', 'FIRST_NOTICE', 'SECOND_NOTICE', 'THIRD_NOTICE', 'FINAL_NOTICE'] as const;
export type DunningStepStage = (typeof DUNNING_STEP_STAGES)[number];

export const STAGE_LABEL: Record<DunningStepStage, string> = {
  COURTESY: 'Courtesy reminder',
  FIRST_NOTICE: 'First notice',
  SECOND_NOTICE: 'Second notice',
  THIRD_NOTICE: 'Third notice',
  FINAL_NOTICE: 'Final notice',
};

export interface DunningStep {
  stage: DunningStepStage;
  /** Days from the due date (negative = before it is due). */
  days: number;
  /** Template; blank = built-in copy for the stage. */
  subject: string;
  body: string;
}

export type DunningSendMode = 'DRAFT' | 'AUTO';

export interface DunningPolicy {
  enabled: boolean;
  sendMode: DunningSendMode;
  steps: DunningStep[];
  stopOnPromise: boolean;
  stopOnDispute: boolean;
  excludedCustomerIds: string[];
  minBalanceCents: number;
}

/** The out-of-the-box ladder (off until a person turns it on). */
export const DEFAULT_DUNNING_STEPS: readonly DunningStep[] = [
  { stage: 'COURTESY', days: -3, subject: '', body: '' },
  { stage: 'FIRST_NOTICE', days: 7, subject: '', body: '' },
  { stage: 'SECOND_NOTICE', days: 30, subject: '', body: '' },
  { stage: 'THIRD_NOTICE', days: 60, subject: '', body: '' },
  { stage: 'FINAL_NOTICE', days: 90, subject: '', body: '' },
];

export const DEFAULT_DUNNING_POLICY: DunningPolicy = {
  enabled: false,
  sendMode: 'DRAFT',
  steps: [...DEFAULT_DUNNING_STEPS],
  stopOnPromise: true,
  stopOnDispute: true,
  excludedCustomerIds: [],
  minBalanceCents: 0,
};

export const dunningStepSchema = z.object({
  stage: z.enum(DUNNING_STEP_STAGES),
  days: z.number().int().min(-60).max(365),
  subject: z.string().max(200).default(''),
  body: z.string().max(4000).default(''),
});

export const dunningPolicyInputSchema = z
  .object({
    location_id: z.string().uuid().nullable().default(null),
    enabled: z.boolean(),
    send_mode: z.enum(['DRAFT', 'AUTO']),
    steps: z.array(dunningStepSchema).min(1).max(8),
    stop_on_promise: z.boolean().default(true),
    stop_on_dispute: z.boolean().default(true),
    excluded_customer_ids: z.array(z.string().uuid()).max(500).default([]),
    min_balance_cents: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  })
  .strict()
  .superRefine((v, ctx) => {
    const stages = new Set<string>();
    const days = new Set<number>();
    for (const [i, s] of v.steps.entries()) {
      if (stages.has(s.stage)) ctx.addIssue({ code: 'custom', path: ['steps', i, 'stage'], message: `${STAGE_LABEL[s.stage]} is used twice.` });
      if (days.has(s.days)) ctx.addIssue({ code: 'custom', path: ['steps', i, 'days'], message: 'Two reminders on the same day.' });
      stages.add(s.stage);
      days.add(s.days);
    }
    const ordered = [...v.steps].sort((a, b) => a.days - b.days);
    for (let i = 1; i < ordered.length; i++) {
      if (DUNNING_STEP_STAGES.indexOf(ordered[i].stage) < DUNNING_STEP_STAGES.indexOf(ordered[i - 1].stage)) {
        ctx.addIssue({ code: 'custom', path: ['steps'], message: 'Reminders must get firmer as the invoice ages (courtesy → first → second → third → final).' });
        break;
      }
    }
  });

export type DunningPolicyInput = z.infer<typeof dunningPolicyInputSchema>;

/** The stored row shape. */
export interface DunningPolicyRow {
  location_id: string | null;
  enabled: boolean;
  send_mode: string;
  steps: unknown;
  stop_on_promise: boolean;
  stop_on_dispute: boolean;
  excluded_customer_ids: string[] | null;
  min_balance_cents: number | string;
}

function parseSteps(raw: unknown): DunningStep[] {
  if (!Array.isArray(raw)) return [];
  const out: DunningStep[] = [];
  for (const r of raw) {
    const p = dunningStepSchema.safeParse(r);
    if (p.success) out.push(p.data);
  }
  return out.sort((a, b) => a.days - b.days);
}

/** Row → policy (a row with no valid steps falls back to the default ladder). */
export function policyFromRow(row: DunningPolicyRow): DunningPolicy {
  const steps = parseSteps(row.steps);
  return {
    enabled: !!row.enabled,
    sendMode: row.send_mode === 'AUTO' ? 'AUTO' : 'DRAFT',
    steps: steps.length ? steps : [...DEFAULT_DUNNING_STEPS],
    stopOnPromise: row.stop_on_promise !== false,
    stopOnDispute: row.stop_on_dispute !== false,
    excludedCustomerIds: row.excluded_customer_ids ?? [],
    minBalanceCents: Math.max(0, Number(row.min_balance_cents ?? 0)),
  };
}

/** The policy for one company: its own row, else the tenant row, else the (off) default. */
export function resolveDunningPolicy(rows: ReadonlyArray<DunningPolicyRow>, locationId: string | null): DunningPolicy & { source: 'company' | 'tenant' | 'default' } {
  const own = locationId ? rows.find((r) => r.location_id === locationId) : undefined;
  if (own) return { ...policyFromRow(own), source: 'company' };
  const tenant = rows.find((r) => r.location_id === null);
  if (tenant) return { ...policyFromRow(tenant), source: 'tenant' };
  return { ...DEFAULT_DUNNING_POLICY, steps: [...DEFAULT_DUNNING_STEPS], source: 'default' };
}

// ── rendering ────────────────────────────────────────────────────────────────

export interface DunningTemplateFacts extends DunningFacts {
  /** The hosted invoice page (always viewable) — used when it can't be paid online. */
  viewUrl: string | null;
}

function money(cents: number): string {
  const abs = Math.abs(Math.trunc(cents));
  return `${cents < 0 ? '-' : ''}$${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`;
}

/** The placeholders a template may use (documented in the policy editor). */
export const TEMPLATE_TOKENS = ['customer', 'company', 'invoice_number', 'amount', 'invoice_date', 'due_date', 'days_overdue', 'pay_link'] as const;

export function renderTemplate(tpl: string, f: DunningTemplateFacts): string {
  const values: Record<(typeof TEMPLATE_TOKENS)[number], string> = {
    customer: f.customerName,
    company: f.supplierName,
    invoice_number: f.invoiceNumber,
    amount: money(f.balanceCents),
    invoice_date: f.invoiceDate,
    due_date: f.dueDate,
    days_overdue: String(Math.max(0, f.daysOverdue)),
    pay_link: f.payUrl ?? f.viewUrl ?? '',
  };
  return tpl.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (m, k: string) => (k in values ? values[k as keyof typeof values] : m));
}

function courtesyDraft(f: DunningTemplateFacts): { subject: string; body: string } {
  const link = f.payUrl ? `\n\nYou can pay online here: ${f.payUrl}` : f.viewUrl ? `\n\nYou can view the invoice here: ${f.viewUrl}` : '';
  return {
    subject: `Coming due: Invoice ${f.invoiceNumber} (${money(f.balanceCents)})`,
    body: `Dear ${f.customerName},\n\nA quick heads-up that invoice ${f.invoiceNumber} for ${money(f.balanceCents)} is due on ${f.dueDate}. If it's already scheduled, thank you — no need to reply.${link}\n\nThank you,\n${f.supplierName}`,
  };
}

/** Subject + body for one step: the step's template, else the built-in copy. */
export function renderDunningStep(step: DunningStep, f: DunningTemplateFacts): { subject: string; body: string } {
  let base: { subject: string; body: string };
  if (step.stage === 'COURTESY') base = courtesyDraft(f);
  else {
    const d = deterministicDunningDraft(step.stage as DunningStageKey, { ...f, payUrl: f.payUrl ?? f.viewUrl });
    base = { subject: d.subject, body: d.body };
  }
  const subject = step.subject.trim() ? renderTemplate(step.subject, f).trim() : base.subject;
  const body = step.body.trim() ? renderTemplate(step.body, f).trim() : base.body;
  return { subject: subject.slice(0, 200), body: body.slice(0, 4000) };
}

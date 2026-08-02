/**
 * Dunning letter copy — the deterministic draft + the AI prompt that phrases it.
 *
 * Canon boundary (§3): the cadence LADDER (cadence.ts) decides the stage; the AI
 * only writes prose for that stage from already-computed facts, and the send is a
 * separate human-approved action. If the gateway is unavailable or budget-blocked
 * the caller falls back to `deterministicDunningDraft` here, so a reminder can
 * ALWAYS be produced without the model — graceful degrade, never a dead end.
 *
 * Pure: no I/O. `formatMoney`-style rendering is done with cents→dollars locally
 * so this stays unit-friendly and independent of the shared package's options.
 */

import { getDunningStage, type DunningStageKey, type DunningTone } from './cadence';

export interface DunningFacts {
  customerName: string;
  supplierName: string;
  invoiceNumber: string;
  invoiceDate: string; // YYYY-MM-DD
  dueDate: string; // YYYY-MM-DD
  balanceCents: number;
  daysOverdue: number;
  /** Optional hosted pay link. */
  payUrl: string | null;
}

export interface DunningDraft {
  stage: DunningStageKey;
  tone: DunningTone;
  subject: string;
  body: string;
}

function dollars(cents: number): string {
  return `$${(Math.round(cents) / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

const SUBJECT: Record<DunningStageKey, (f: DunningFacts) => string> = {
  FIRST_NOTICE: (f) => `Payment reminder: Invoice ${f.invoiceNumber}`,
  SECOND_NOTICE: (f) => `Second notice — Invoice ${f.invoiceNumber} is past due`,
  THIRD_NOTICE: (f) => `Urgent: Invoice ${f.invoiceNumber} is ${f.daysOverdue} days overdue`,
  FINAL_NOTICE: (f) => `Final notice — Invoice ${f.invoiceNumber} (${dollars(f.balanceCents)} due)`,
};

/**
 * The deterministic letter for a stage. Also the model's fallback AND the factual
 * basis it is allowed to rephrase — every number is authored here in code so the
 * model can never invent one.
 */
export function deterministicDunningDraft(stageKey: DunningStageKey, f: DunningFacts): DunningDraft {
  const stage = getDunningStage(stageKey);
  const pay = f.payUrl ? `\n\nYou can pay online here: ${f.payUrl}` : '';
  const amt = dollars(f.balanceCents);
  const greeting = `Dear ${f.customerName},`;
  const sign = `\n\nThank you,\n${f.supplierName}`;

  let mid: string;
  switch (stageKey) {
    case 'FIRST_NOTICE':
      mid = `This is a friendly reminder that invoice ${f.invoiceNumber} for ${amt}, dated ${f.invoiceDate}, became due on ${f.dueDate} and is now ${f.daysOverdue} days past due. If payment is already on its way, please disregard this note. Otherwise, we'd appreciate it being settled at your earliest convenience.`;
      break;
    case 'SECOND_NOTICE':
      mid = `Our records show invoice ${f.invoiceNumber} for ${amt} is now ${f.daysOverdue} days past due (due ${f.dueDate}). We have not yet received payment. Please arrange to bring this balance current, or reply to let us know when we can expect it.`;
      break;
    case 'THIRD_NOTICE':
      mid = `Invoice ${f.invoiceNumber} for ${amt} is now seriously overdue at ${f.daysOverdue} days past the ${f.dueDate} due date. This balance requires your immediate attention. Please remit payment promptly or contact us today to resolve it.`;
      break;
    case 'FINAL_NOTICE':
    default:
      mid = `This is a final notice regarding invoice ${f.invoiceNumber} for ${amt}, now ${f.daysOverdue} days past due (due ${f.dueDate}). If we do not receive payment or hear from you, the account may be escalated for collection and services may be placed on hold. Please treat this as urgent.`;
      break;
  }

  return {
    stage: stageKey,
    tone: stage.tone,
    subject: SUBJECT[stageKey](f),
    body: `${greeting}\n\n${mid}${pay}${sign}`,
  };
}

/**
 * System + user prompt for the gateway. The model must return ONLY JSON with a
 * subject + body, must use only the provided figures, and must match the stage's
 * tone. Feature bucket DUNNING_DRAFT.
 */
export const DUNNING_DRAFT_FEATURE = 'DUNNING_DRAFT';
export const DUNNING_DRAFT_MODEL = 'claude-sonnet-4-20250514';

export function dunningSystemPrompt(): string {
  return (
    'You are an accounts-receivable specialist drafting a collections email. You are given a target ' +
    'TONE and a set of ALREADY-COMPUTED facts (customer, supplier, invoice number, amount, dates, days ' +
    'overdue). Write a short, professional dunning email in that tone. RULES: use ONLY the figures given ' +
    '— never invent, estimate, or alter a number, date, or invoice reference; do not threaten legal action ' +
    'unless the tone is "final" (then you may mention escalation to collections / service hold); keep it to ' +
    '2–4 short paragraphs; address the customer by name and sign as the supplier. Respond with ONLY this ' +
    'JSON, no markdown: {"subject":"...","body":"..."}'
  );
}

export function dunningUserPrompt(stageKey: DunningStageKey, f: DunningFacts): string {
  const stage = getDunningStage(stageKey);
  const facts = {
    tone: stage.tone,
    stageIntent: stage.intent,
    customerName: f.customerName,
    supplierName: f.supplierName,
    invoiceNumber: f.invoiceNumber,
    invoiceDate: f.invoiceDate,
    dueDate: f.dueDate,
    amountDue: dollars(f.balanceCents),
    daysOverdue: f.daysOverdue,
    payUrl: f.payUrl ?? undefined,
  };
  return JSON.stringify(facts);
}

/** Parse the model's JSON reply into a draft, or null if it doesn't conform. */
export function parseDunningReply(
  text: string,
  stageKey: DunningStageKey,
  tone: DunningTone,
): DunningDraft | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim());
  } catch {
    return null;
  }
  const subject = typeof parsed.subject === 'string' ? parsed.subject.trim() : '';
  const body = typeof parsed.body === 'string' ? parsed.body.trim() : '';
  if (!subject || !body) return null;
  return { stage: stageKey, tone, subject, body };
}

/**
 * Document intelligence — the AI read (feature DOCUMENT_CLASSIFY) through the Core AI
 * gateway. One call answers: what is this, how sure, who is the other party, which of
 * the tenant's companies it belongs to, its key dates and headline amount, and a
 * one-paragraph summary. It does NOT extract module fields — the module's existing
 * extractor (LEASE_EXTRACT, DEBT_EXTRACT, …) does that next.
 *
 * Canon: AI proposes facts only; nothing here writes. Never throws for the expected
 * failure cases — it returns a typed outcome the service turns into a retry.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { runAiGateway } from '@meritbooks/core-ai';
import { isAiUnavailableError } from '@/lib/ai/gateway';
import { DOC_CLASSES, mapDocClass, type DocClass } from './types';
import { parseLooseDate } from './rules';
import { redactTin } from './redact';

export const DOCUMENT_CLASSIFY_FEATURE = 'DOCUMENT_CLASSIFY';
export const DOCUMENT_CLASSIFY_MODEL = 'claude-sonnet-4-6';

export interface AiClassification {
  docClass: DocClass;
  confidence: number;
  summary: string | null;
  counterparty: string | null;
  companyName: string | null;
  keyDates: Record<string, string>;
  amountCents: number | null;
  note: string | null;
}

export type AiClassifyOutcome =
  | { ok: true; classification: AiClassification; model: string; correlationId: string | null }
  | { ok: false; kind: 'unavailable' | 'budget_blocked' | 'failed'; error: string };

function clamp01(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

function str(v: unknown, max = 500): string | null {
  if (typeof v !== 'string') return null;
  // The model is told never to repeat a taxpayer ID; redact anyway (security review H4).
  const t = redactTin(v.trim());
  return t ? t.slice(0, max) : null;
}

/** Whole dollars or "1,234.56" → integer cents (never floats in storage). */
export function dollarsToCentsLoose(v: unknown): number | null {
  if (v == null || v === '') return null;
  // A number from the model is dollars: round once at the boundary to whole cents.
  if (typeof v === 'number') return Number.isFinite(v) && Math.abs(v) < 1e11 ? Math.round(v * 100) : null;
  const s = String(v).replace(/[$,\s]/g, '');
  if (!/^-?\d+(\.\d{1,4})?$/.test(s)) return null;
  const [whole, frac = ''] = s.replace('-', '').split('.');
  const cents = Number(whole) * 100 + Number((frac + '00').slice(0, 2));
  if (!Number.isSafeInteger(cents)) return null;
  return s.startsWith('-') ? -cents : cents;
}

/** Pure: the model's loose JSON → a validated classification. Unsure (< 0.4) → 'other'. */
export function normalizeAiClassification(raw: unknown): AiClassification {
  const r = (raw ?? {}) as Record<string, unknown>;
  let docClass = mapDocClass(r.doc_class ?? r.type ?? r.docType);
  const confidence = clamp01(r.confidence);
  if (docClass !== 'other' && confidence < 0.4) docClass = 'other';
  const datesIn = (r.key_dates && typeof r.key_dates === 'object' ? r.key_dates : {}) as Record<string, unknown>;
  const keyDates: Record<string, string> = {};
  for (const k of ['effective_date', 'expiration_date', 'maturity_date', 'due_date', 'period_start', 'period_end', 'document_date']) {
    const v = datesIn[k];
    const d = typeof v === 'string' ? parseLooseDate(v) : null;
    if (d) keyDates[k] = d;
  }
  return {
    docClass,
    confidence,
    summary: str(r.summary, 1200),
    counterparty: str(r.counterparty, 160),
    companyName: str(r.company_name, 160),
    keyDates,
    amountCents: dollarsToCentsLoose(r.amount),
    note: str(r.note, 400),
  };
}

function prompt(companies: string[]): string {
  return `You are the document intake specialist for an accounting book-of-record system. A user stored this document in the company's document center. Read it and decide WHAT it is so it can be routed to the right part of the books. A dedicated parser extracts detailed fields later — you only identify and summarize.

Allowed doc_class values (choose exactly one):
${DOC_CLASSES.map((c) => `- ${c}`).join('\n')}

Meanings: lease = real-estate or equipment lease; loan = loan agreement, promissory note, credit agreement, line of credit; insurance_policy = the business's own policy / declarations; coi = certificate of insurance (ACORD) evidencing someone's coverage; w9 = IRS Form W-9; vendor_bill = a bill / invoice the business RECEIVED and must pay; customer_contract = an agreement / MSA / SOW / proposal under which the business bills a customer; purchase_order = a PO; bank_statement / card_statement = an account statement; payroll_register = payroll register or summary; fixed_asset_invoice = an invoice for buying equipment / vehicles / machinery / computers (capital purchase); subscription = SaaS / software / recurring service agreement or order form; formation = articles, certificate of formation, operating agreement, bylaws, cap table, EIN letter; tax_document = a tax return or tax notice; form_1099 = a Form 1099; budget = an operating budget / forecast; prepaid = support for an expense paid in advance (annual maintenance, retainer); ledger_report = trial balance, general ledger, A/R or A/P aging; other = none of these.

The tenant's companies: ${companies.length ? companies.map((c) => `"${c}"`).join(', ') : '(none listed)'}.

Return ONLY valid JSON (no markdown, no prose):
{
  "doc_class": "one value from the list",
  "confidence": number 0-1,
  "summary": "2-3 plain sentences: what this document is, between whom, the key terms",
  "counterparty": "the OTHER party (lessor, lender, vendor, insurer, customer) or null",
  "company_name": "which of the tenant's companies above this document belongs to (verbatim from the list), or null",
  "key_dates": { "effective_date": "YYYY-MM-DD or null", "expiration_date": "...", "maturity_date": "...", "due_date": "...", "period_start": "...", "period_end": "...", "document_date": "..." },
  "amount": "the headline dollar amount (rent per period, principal, premium, invoice total) as a number, or null",
  "note": "one short sentence on what led to the classification"
}

Rules: if you are not reasonably sure, use "other" with a low confidence — a wrong type sends the document to the wrong place. Never invent values; use null. Do not repeat taxpayer identification numbers, account numbers, or other sensitive identifiers anywhere in your answer.`;
}

function firstText(result: unknown): string | null {
  if (!Array.isArray(result)) return null;
  const b = (result as Array<{ type?: string; text?: string }>).find((c) => c?.type === 'text');
  return b?.text ?? null;
}

export interface AiClassifyInput {
  orgId: string;
  userId: string | null;
  base64: string | null;
  mediaType: string;
  /** For sheets / text: a text sample sent instead of the binary. */
  textSample?: string | null;
  companies: string[];
}

export type ClassifyFn = (deps: { supabase: SupabaseClient; anthropicApiKey: string }, input: AiClassifyInput) => Promise<AiClassifyOutcome>;

export const classifyWithAi: ClassifyFn = async (deps, input) => {
  const isPdf = input.mediaType === 'application/pdf';
  const isImage = /^image\/(png|jpeg|gif|webp)$/.test(input.mediaType);
  // Defense in depth (H4): the service already redacts and never sends a TIN form here.
  const text = input.textSample?.trim() ? redactTin(input.textSample.trim()).slice(0, 8000) : null;
  if (!text && !(input.base64 && (isPdf || isImage))) {
    return { ok: false, kind: 'failed', error: `Not readable by AI: ${input.mediaType}` };
  }
  const block = text
    ? { type: 'text' as const, text: `The document's text (first portion):\n\n${text}` }
    : isPdf
      ? { type: 'document' as const, source: { type: 'base64' as const, media_type: 'application/pdf' as const, data: input.base64 as string } }
      : { type: 'image' as const, source: { type: 'base64' as const, media_type: input.mediaType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp', data: input.base64 as string } };

  let gw;
  try {
    gw = await runAiGateway(
      { supabase: deps.supabase, anthropicApiKey: deps.anthropicApiKey },
      {
        tenant_id: input.orgId,
        user_id: input.userId,
        module: 'BOOKS',
        feature: DOCUMENT_CLASSIFY_FEATURE,
        model: DOCUMENT_CLASSIFY_MODEL,
        messages: [{ role: 'user', content: [block, { type: 'text', text: prompt(input.companies) }] }],
        max_tokens: 900,
      },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Gateway error';
    return { ok: false, kind: isAiUnavailableError(e) ? 'unavailable' : 'failed', error: msg };
  }
  if (gw.status === 'blocked' || gw.result == null) {
    const msg = gw.message ?? 'AI request blocked';
    return { ok: false, kind: gw.status === 'blocked' ? 'budget_blocked' : isAiUnavailableError(msg) ? 'unavailable' : 'failed', error: msg };
  }
  const out = firstText(gw.result);
  if (!out) return { ok: false, kind: 'failed', error: 'Empty AI response' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(out.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim());
  } catch {
    return { ok: false, kind: 'failed', error: 'AI response was not JSON' };
  }
  return { ok: true, classification: normalizeAiClassification(parsed), model: gw.model_used ?? DOCUMENT_CLASSIFY_MODEL, correlationId: gw.correlation_id ?? null };
};

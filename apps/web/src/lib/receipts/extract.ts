/**
 * Receipt reading (FPB-workforce-app §15.2): merchant, date, total, subtotal, tax, tip,
 * card last 4.
 *
 *   AI     images / PDFs (or the text of an e-receipt) THROUGH the Core AI gateway
 *          (`@meritbooks/core-ai`, feature RECEIPT_EXTRACT, metered to core.ai_usage_log,
 *          tenant budget enforced). The model PROPOSES facts; nothing is posted. Unknown
 *          → blank, never guessed.
 *   rules  when AI is off, over budget or fails: a deterministic read of the text we have
 *          (email subject / body, the file name): "Total $68.42", ISO / US dates, the
 *          sender name as the merchant. Pure — unit-tested.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { runAiGateway } from '@meritbooks/core-ai';
import { dollarsToCents } from '@meritbooks/shared';

export const RECEIPT_EXTRACT_FEATURE = 'RECEIPT_EXTRACT';
export const RECEIPT_EXTRACT_MODEL = 'claude-sonnet-4-6';

export interface ReceiptFacts {
  merchant: string | null;
  date: string | null;
  totalCents: number | null;
  subtotalCents: number | null;
  taxCents: number | null;
  tipCents: number | null;
  cardLast4: string | null;
  currency: string | null;
  /** 0..1 — the model's (or the rules') overall confidence. */
  confidence: number;
  source: 'ai' | 'rules' | 'none';
  model?: string | null;
  note?: string | null;
}

export const EMPTY_FACTS: ReceiptFacts = {
  merchant: null,
  date: null,
  totalCents: null,
  subtotalCents: null,
  taxCents: null,
  tipCents: null,
  cardLast4: null,
  currency: null,
  confidence: 0,
  source: 'none',
};

function cents(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.replace(/[$,\s]/g, '') : '';
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) return null;
  const c = dollarsToCents(s);
  return Number.isFinite(c) && Math.abs(c) < 10_000_000_000 ? Math.abs(c) : null;
}

function isoDate(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(`${s}T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? null : s;
  }
  return null;
}

function str(v: unknown, max = 120): string | null {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
}

/** Normalize the model's JSON (or anything shaped like it). Pure. */
export function normalizeReceiptExtraction(raw: unknown): ReceiptFacts {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_FACTS };
  const o = raw as Record<string, unknown>;
  const last4 = typeof o.card_last4 === 'string' && /^\d{4}$/.test(o.card_last4.trim()) ? o.card_last4.trim() : null;
  const conf = typeof o.confidence === 'number' && o.confidence >= 0 && o.confidence <= 1 ? o.confidence : 0.5;
  const facts: ReceiptFacts = {
    merchant: str(o.merchant),
    date: isoDate(o.date),
    totalCents: cents(o.total),
    subtotalCents: cents(o.subtotal),
    taxCents: cents(o.tax),
    tipCents: cents(o.tip),
    cardLast4: last4,
    currency: typeof o.currency === 'string' && /^[A-Z]{3}$/.test(o.currency) ? o.currency : null,
    confidence: conf,
    source: 'ai',
    note: str(o.note, 300),
  };
  // A total that disagrees with subtotal + tax + tip by more than a cent is suspect: keep it, lower confidence.
  if (facts.totalCents != null && facts.subtotalCents != null) {
    const sum = facts.subtotalCents + (facts.taxCents ?? 0) + (facts.tipCents ?? 0);
    if (Math.abs(sum - facts.totalCents) > 1) facts.confidence = Math.min(facts.confidence, 0.6);
  }
  return facts;
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function validYmd(y: number, m: number, d: number): string | null {
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** First date in free text: 2026-10-21 · 10/21/2026 · 10/21/26 · Oct 21, 2026 · 21 Oct 2026. Pure. */
export function findDate(text: string): string | null {
  let m = text.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (m) return validYmd(+m[1], +m[2], +m[3]);
  m = text.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\b/);
  if (m) {
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    return validYmd(y, +m[1], +m[2]);
  }
  m = text.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s+(20\d{2})\b/i);
  if (m) return validYmd(+m[3], MONTHS[m[1].toLowerCase()], +m[2]);
  m = text.match(/\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?,?\s+(20\d{2})\b/i);
  if (m) return validYmd(+m[3], MONTHS[m[2].toLowerCase()], +m[1]);
  return null;
}

/** The receipt total from free text: prefers "total / amount paid / charged" lines, else the largest $ amount. Pure. */
export function findTotal(text: string): number | null {
  const labelled = Array.from(
    text.matchAll(/\b(grand total|order total|total charged|amount charged|amount paid|total paid|total due|total)\b[^0-9$\n]{0,20}\$?\s*(\d{1,3}(?:,\d{3})*(?:\.\d{2})|\d+\.\d{2})/gi),
  );
  // "subtotal" also contains "total": skip matches preceded by "sub".
  const good = labelled.filter((m) => !/sub\s*$/i.test(text.slice(Math.max(0, (m.index ?? 0) - 4), m.index ?? 0)));
  const pick = good.length ? good[good.length - 1] : null;
  if (pick) return cents(pick[2]);
  const amounts = Array.from(text.matchAll(/\$\s?(\d{1,3}(?:,\d{3})*\.\d{2}|\d+\.\d{2})/g)).map((m) => cents(m[1])).filter((n): n is number => n != null);
  return amounts.length ? Math.max(...amounts) : null;
}

/** Card last 4 in free text ("Visa ending in 5512", "**** 5512", "x5512"). Pure. */
export function findLast4(text: string): string | null {
  const m = text.match(/(?:ending(?:\s+in)?|x{2,}|\*{2,}|card\s*#?)\s*[-:]?\s*(\d{4})\b/i);
  return m ? m[1] : null;
}

/**
 * Deterministic read of whatever text we have (no AI). Merchant comes from the caller's
 * hint (email sender name, typed merchant) when the text has no "from" line. Pure.
 */
export function parseReceiptText(text: string, hints: { merchant?: string | null } = {}): ReceiptFacts {
  const t = text.replace(/ /g, ' ');
  const total = findTotal(t);
  const date = findDate(t);
  const last4 = findLast4(t);
  const merchant = hints.merchant?.trim() ? hints.merchant.trim().slice(0, 120) : null;
  const found = [total, date, merchant].filter((x) => x != null).length;
  return {
    ...EMPTY_FACTS,
    merchant,
    date,
    totalCents: total,
    cardLast4: last4,
    confidence: found === 3 ? 0.7 : found === 2 ? 0.5 : found === 1 ? 0.3 : 0,
    source: found ? 'rules' : 'none',
  };
}

/** Strip HTML to readable text for the rules / the text prompt. Pure. */
export function htmlToText(html: string): string {
  // cap the input (~512 KB): a pathological body must not stall the request
  return (html.length > 512 * 1024 ? html.slice(0, 512 * 1024) : html)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#36;|&dollar;/gi, '$')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

const PROMPT = `You read purchase receipts for a bookkeeper. Return ONLY a JSON object:
{"merchant": string|null, "date": "YYYY-MM-DD"|null, "total": number|null, "subtotal": number|null,
 "tax": number|null, "tip": number|null, "card_last4": "1234"|null, "currency": "USD"|null,
 "confidence": number between 0 and 1, "note": string|null}
Rules: amounts in dollars with two decimals (no symbols); "total" is what was charged including tax and tip;
leave any field you cannot read as null — never guess; "merchant" is the business name as printed;
if this is not a receipt or invoice, set confidence to 0 and explain in note.`;

export type ExtractInput =
  | { kind: 'file'; base64: string; mediaType: string }
  | { kind: 'text'; text: string };

function extractText(result: unknown): string | null {
  if (!Array.isArray(result)) return null;
  const b = (result as Array<{ type?: string; text?: string }>).find((c) => c?.type === 'text');
  return b?.text ?? null;
}

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;
type ImageType = (typeof IMAGE_TYPES)[number];

/**
 * Ask the gateway to read a receipt. Never throws for expected failures: returns
 * `{ ok: false }` and the caller falls back to the rules.
 */
export async function extractReceiptWithAi(
  deps: { supabase: SupabaseClient; anthropicApiKey: string },
  args: { orgId: string; userId?: string | null; input: ExtractInput },
): Promise<{ ok: true; facts: ReceiptFacts } | { ok: false; error: string; budgetBlocked?: boolean }> {
  const { input } = args;
  type Block =
    | { type: 'text'; text: string }
    | { type: 'document'; source: { type: 'base64'; media_type: 'application/pdf'; data: string } }
    | { type: 'image'; source: { type: 'base64'; media_type: ImageType; data: string } };
  let block: Block;
  if (input.kind === 'text') {
    block = { type: 'text', text: `Receipt text:\n${input.text.slice(0, 20_000)}` };
  } else if (input.mediaType === 'application/pdf') {
    block = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: input.base64 } };
  } else if ((IMAGE_TYPES as readonly string[]).includes(input.mediaType)) {
    block = { type: 'image', source: { type: 'base64', media_type: input.mediaType as ImageType, data: input.base64 } };
  } else {
    return { ok: false, error: `Cannot read ${input.mediaType} files.` };
  }
  let gw;
  try {
    gw = await runAiGateway(
      { supabase: deps.supabase, anthropicApiKey: deps.anthropicApiKey },
      {
        tenant_id: args.orgId,
        user_id: args.userId ?? null,
        module: 'BOOKS',
        feature: RECEIPT_EXTRACT_FEATURE,
        model: RECEIPT_EXTRACT_MODEL,
        messages: [{ role: 'user', content: [block, { type: 'text', text: PROMPT }] }],
        max_tokens: 800,
      },
    );
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Gateway error' };
  }
  if (gw.status === 'blocked' || gw.result == null) return { ok: false, error: gw.message ?? 'AI request blocked', budgetBlocked: gw.status === 'blocked' };
  const text = extractText(gw.result);
  if (!text) return { ok: false, error: 'Empty AI response' };
  try {
    const json = JSON.parse(text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim()) as unknown;
    return { ok: true, facts: { ...normalizeReceiptExtraction(json), model: gw.model_used ?? RECEIPT_EXTRACT_MODEL } };
  } catch {
    return { ok: false, error: 'The AI answer was not readable.' };
  }
}

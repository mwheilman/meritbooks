/**
 * AI-drafted flux explanation (FPB-financial-reports §5 A-3E.3) — the gateway seam.
 *
 * Canon §3: AI proposes facts, a person decides. The model is handed ONLY the
 * deterministic fact sheet (the line's figures + its ranked drivers, each with a ref
 * "L1".."Ln") and asked to PHRASE an explanation that cites refs. Before anything reaches
 * the person:
 *   • every cited ref must be in the fact sheet, and the draft must cite at least one;
 *   • every $ amount and % in the text must equal a figure in the fact sheet (to the cent,
 *     or to the whole dollar / one decimal of a percent) — otherwise the draft is REFUSED
 *     and the deterministic driver summary is returned instead.
 * Every tenant-controlled string in the fact sheet (account / dimension names, counterparty
 * names, memos, source module) passes through `promptSafe`: control characters (CR/LF/TAB,
 * C0/C1, Unicode line/paragraph separators, bidi overrides, zero-width) become spaces,
 * quotes/backticks are neutralised and each value is length-capped — so a memo can't open a
 * new line that reads as a fact, a ref ("L9: …") or an instruction block.
 * The result is never stored by this module; it becomes an explanation only when a person
 * edits/accepts and submits it. AI down (no key, org disabled, budget blocked) ⇒ the caller
 * gets `{ kind: 'unavailable' }` plus the same driver summary to write from.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { formatMoney } from '@meritbooks/shared';
import { runAiGateway } from '@meritbooks/core-ai';
import { isAiUnavailableError } from '@/lib/ai/gateway';
import { BASIS_LABEL, CATEGORY_LABEL, EXPLANATION_CATEGORIES, type ExplanationCategory, type FluxDrivers, type FluxLine } from './types';
import { isCategory } from './explanations';
import { periodLabel } from './compute';

export const FLUX_EXPLAIN_FEATURE = 'FLUX_EXPLAIN';
export const FLUX_EXPLAIN_MODEL = 'claude-sonnet-4-6';

const TAG_WORD: Record<string, string> = {
  LARGEST: 'largest',
  NEW_COUNTERPARTY: 'new counterparty',
  ONE_OFF: 'one-off',
  RECLASS: 'reclass',
};

// C0 + DEL + C1 controls, Unicode line/paragraph separators, bidi embeddings/overrides/isolates,
// zero-width chars and the BOM.
// eslint-disable-next-line no-control-regex
const PROMPT_CONTROL_RE = /[\u0000-\u001F\u007F-\u009F\u2028\u2029\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

/** Caps for each interpolated field (characters, after cleaning). */
export const PROMPT_CAPS = { name: 120, label: 80, counterparty: 80, memo: 120, source: 40 } as const;

/**
 * Make a tenant/DB string safe to interpolate into ONE line of the fact sheet: no control or
 * line-breaking characters, no quote/backtick/brace delimiters, whitespace collapsed, capped.
 */
export function promptSafe(v: string | null | undefined, max: number): string {
  if (v == null) return '';
  const cleaned = String(v)
    .replace(PROMPT_CONTROL_RE, ' ')
    .replace(/["`]/g, "'")
    .replace(/[{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > max ? `${cleaned.slice(0, Math.max(0, max - 1)).trimEnd()}…` : cleaned;
}

export function pctLabel(bps: number | null): string {
  if (bps === null) return 'new (no comparison base)';
  return `${(bps / 100).toFixed(1)}%`;
}

export interface FactSheet {
  text: string;
  /** Every cent figure the draft may quote. */
  allowedCents: number[];
  /** Every percent (in bps) the draft may quote. */
  allowedPctBps: number[];
  refs: string[];
}

/** The deterministic fact sheet the model phrases from (and the verifier checks against). */
export function buildFactSheet(line: FluxLine, drivers: FluxDrivers, periodKey: string): FactSheet {
  const allowedCents = new Set<number>([line.currentCents, line.comparisonCents, line.changeCents, line.threshold.absThresholdCents]);
  const allowedPct = new Set<number>([line.threshold.pctThresholdBps]);
  if (line.changePctBps !== null) allowedPct.add(line.changePctBps);
  const out: string[] = [];
  const dim = promptSafe(line.dimensionLabel, PROMPT_CAPS.label);
  const name = `${promptSafe(line.accountNumber, 40)} ${promptSafe(line.accountName, PROMPT_CAPS.name)}${dim ? ` — ${dim}` : ''}`;
  out.push(`Account: ${name} (${line.statement === 'BS' ? 'balance sheet, ending balance' : 'P&L, period activity'})`);
  out.push(`Month: ${periodLabel(periodKey)}; comparison: ${BASIS_LABEL[line.basisUsed]}`);
  out.push(`Current: ${formatMoney(line.currentCents)}; comparison: ${formatMoney(line.comparisonCents)}; change: ${formatMoney(line.changeCents)} (${pctLabel(line.changePctBps)})`);
  out.push('Driving lines (cite by ref):');
  for (const d of drivers.lines) {
    allowedCents.add(d.amountCents);
    const tags = d.tags.map((t) => TAG_WORD[t]).join(', ');
    const cp = promptSafe(d.counterparty, PROMPT_CAPS.counterparty);
    const memo = promptSafe(d.memo, PROMPT_CAPS.memo);
    const src = promptSafe(d.sourceModule, PROMPT_CAPS.source);
    out.push(`  ${d.ref}: ${promptSafe(d.entryDate, 10)} ${formatMoney(d.amountCents)}${cp ? ` — ${cp}` : ''}${memo ? ` — "${memo}"` : ''}${src ? ` [${src}]` : ''}${tags ? ` {${tags}}` : ''}`);
  }
  if (drivers.counterparties.length) {
    out.push('Change by counterparty:');
    for (const c of drivers.counterparties) {
      allowedCents.add(c.currentCents);
      allowedCents.add(c.comparisonCents);
      allowedCents.add(c.changeCents);
      out.push(`  ${promptSafe(c.counterparty, PROMPT_CAPS.counterparty) || '(none)'}: ${formatMoney(c.comparisonCents)} → ${formatMoney(c.currentCents)} (${formatMoney(c.changeCents)})${c.isNew ? ' — new' : ''}`);
    }
  }
  out.push(`Lines this month: ${drivers.lineCount}`);
  return { text: out.join('\n'), allowedCents: [...allowedCents], allowedPctBps: [...allowedPct], refs: drivers.lines.map((d) => d.ref) };
}

/** Plain driver summary — the AI-down starting point, and the refusal fallback. */
export function driverSummary(line: FluxLine, drivers: FluxDrivers): string {
  const dir = line.changeCents > 0 ? 'up' : 'down';
  const parts: string[] = [
    `${line.accountName} is ${dir} ${formatMoney(Math.abs(line.changeCents))} (${pctLabel(line.changePctBps)}) vs ${BASIS_LABEL[line.basisUsed].toLowerCase()}: ${formatMoney(line.comparisonCents)} → ${formatMoney(line.currentCents)}.`,
  ];
  const top = drivers.counterparties.slice(0, 3).map((c) => `${c.counterparty} ${c.changeCents > 0 ? '+' : ''}${formatMoney(c.changeCents)}${c.isNew ? ' (new)' : ''}`);
  if (top.length) parts.push(`Biggest movers: ${top.join('; ')}.`);
  const flagged = drivers.lines.filter((d) => d.tags.includes('ONE_OFF') || d.tags.includes('RECLASS')).slice(0, 2);
  for (const d of flagged) {
    parts.push(`${d.tags.includes('RECLASS') ? 'Reclass' : 'One-off'}: ${formatMoney(d.amountCents)} on ${d.entryDate}${d.memo ? ` — ${d.memo.slice(0, 80)}` : ''}.`);
  }
  return parts.join(' ');
}

// ── verification ───────────────────────────────────────────────────────────────

const MONEY_RE = /\(?-?\$\s?-?[\d,]+(?:\.\d{1,2})?\)?/g;
const PCT_RE = /-?\d+(?:\.\d+)?\s?%/g;

function parseMoneyToken(tok: string): number | null {
  const neg = tok.includes('(') || tok.includes('-');
  const digits = tok.replace(/[^\d.]/g, '');
  if (!digits) return null;
  const v = Math.round(Number(digits) * 100);
  if (!Number.isFinite(v)) return null;
  return neg ? -v : v;
}

export interface DraftVerification {
  ok: boolean;
  problems: string[];
}

/** Every $ / % in the text must trace to the fact sheet; every citation must be a known ref. */
export function verifyDraft(text: string, citations: string[], sheet: FactSheet): DraftVerification {
  const problems: string[] = [];
  const known = new Set(sheet.refs);
  if (citations.length === 0 && sheet.refs.length > 0) problems.push('The draft cites no driving lines.');
  for (const c of citations) if (!known.has(c)) problems.push(`Unknown citation ${c}.`);

  const absAllowed = sheet.allowedCents.map((c) => Math.abs(c));
  for (const tok of text.match(MONEY_RE) ?? []) {
    const v = parseMoneyToken(tok);
    if (v === null) continue;
    const a = Math.abs(v);
    const ok = absAllowed.some((x) => x === a || Math.round(x / 100) * 100 === a);
    if (!ok) problems.push(`${tok.trim()} does not match any figure in the ledger facts.`);
  }
  for (const tok of text.match(PCT_RE) ?? []) {
    const bps = Math.round(Math.abs(Number(tok.replace(/[^\d.]/g, ''))) * 100);
    const ok = sheet.allowedPctBps.some((x) => Math.abs(Math.abs(x) - bps) <= 5 || Math.round(Math.abs(x) / 100) * 100 === bps);
    if (!ok) problems.push(`${tok.trim()} does not match the computed change.`);
  }
  return { ok: problems.length === 0, problems };
}

export interface ParsedDraft {
  explanation: string;
  category: ExplanationCategory | null;
  citations: string[];
}

/** Parse the model's JSON reply (tolerates ```json fences). */
export function parseDraftReply(text: string | null): ParsedDraft | null {
  if (!text) return null;
  const json = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  const explanation = typeof o.explanation === 'string' ? o.explanation.trim() : '';
  if (!explanation) return null;
  const citations = Array.isArray(o.citations) ? o.citations.filter((c): c is string => typeof c === 'string').slice(0, 20) : [];
  return { explanation: explanation.slice(0, 4000), category: isCategory(o.category) ? o.category : null, citations };
}

export const FLUX_SYSTEM_PROMPT = [
  'You are a careful controller drafting a month-end flux (variance) explanation for a colleague to review.',
  'Use ONLY the facts provided. Never invent a number, vendor, customer, or reason that is not in the facts.',
  'Quote dollar amounts and percentages EXACTLY as written in the facts, or not at all.',
  'Cite the driving lines you rely on by their ref (L1, L2, ...).',
  'Write 1-3 plain sentences a business owner understands. If the facts do not show why, say what moved and that the cause needs confirming.',
  `Reply with JSON only: {"explanation": string, "category": one of ${EXPLANATION_CATEGORIES.map((c) => `"${c}"`).join(', ')}, "citations": string[]}.`,
  `Categories: ${EXPLANATION_CATEGORIES.map((c) => `${c} = ${CATEGORY_LABEL[c]}`).join('; ')}.`,
].join('\n');

export type FluxDraftResult =
  | {
      kind: 'draft';
      explanation: string;
      category: ExplanationCategory | null;
      citations: string[];
      model: string | null;
      correlationId: string;
      tokens: { input: number; output: number };
      costCents: number;
    }
  | { kind: 'unavailable'; message: string }
  | { kind: 'refused'; problems: string[] };

function extractText(result: unknown): string | null {
  if (!Array.isArray(result)) return null;
  const b = (result as Array<{ type?: string; text?: string }>).find((c) => c?.type === 'text');
  return b?.text ?? null;
}

/** Ask the Core AI gateway for a draft. Never throws for expected failures. */
export async function draftFluxExplanation(
  deps: { supabase: SupabaseClient; anthropicApiKey: string | null },
  args: { orgId: string; userId: string | null; sheet: FactSheet },
): Promise<FluxDraftResult> {
  if (!deps.anthropicApiKey) return { kind: 'unavailable', message: 'AI is not configured.' };
  let gw;
  try {
    gw = await runAiGateway(
      { supabase: deps.supabase, anthropicApiKey: deps.anthropicApiKey },
      {
        tenant_id: args.orgId,
        user_id: args.userId,
        module: 'BOOKS',
        feature: FLUX_EXPLAIN_FEATURE,
        model: FLUX_EXPLAIN_MODEL,
        system: FLUX_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: [{ type: 'text', text: `Facts:\n${args.sheet.text}` }] }],
        max_tokens: 600,
      },
    );
  } catch (e) {
    if (isAiUnavailableError(e)) return { kind: 'unavailable', message: 'AI is temporarily unavailable.' };
    return { kind: 'unavailable', message: e instanceof Error ? e.message.slice(0, 200) : 'AI request failed.' };
  }
  if (gw.status === 'blocked' || gw.result == null) {
    return { kind: 'unavailable', message: gw.message ?? 'AI request blocked by the usage budget.' };
  }
  const parsed = parseDraftReply(extractText(gw.result));
  if (!parsed) return { kind: 'refused', problems: ['The AI reply could not be read.'] };
  const check = verifyDraft(parsed.explanation, parsed.citations, args.sheet);
  if (!check.ok) return { kind: 'refused', problems: check.problems };
  return {
    kind: 'draft',
    explanation: parsed.explanation,
    category: parsed.category,
    citations: parsed.citations,
    model: gw.model_used,
    correlationId: gw.correlation_id,
    tokens: gw.tokens,
    costCents: gw.cost_cents,
  };
}

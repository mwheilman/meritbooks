/**
 * "Summarize this view" — an AI DRAFT over the computed view (AC-W10). The Core AI gateway
 * (feature FPNA_SUMMARY, metered, tenant budget enforced) phrases 3–6 bullets from the fact
 * sheet; the flux verifier refuses anything that does not trace to it. Never stored as
 * commentary: the route logs a PROPOSED ai_decisions row and returns the draft for a person.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { runAiGateway } from '@meritbooks/core-ai';
import { isAiUnavailableError } from '@/lib/ai/gateway';
import { verifyDraft, type FactSheet } from '@/lib/close/flux/ai-draft';

export const FPNA_SUMMARY_FEATURE = 'FPNA_SUMMARY';
export const FPNA_SUMMARY_MODEL = 'claude-sonnet-4-6';

export const FPNA_SYSTEM_PROMPT = [
  'You are a careful CFO writing a short summary of a financial dashboard for a business owner.',
  'Use ONLY the facts provided. Never invent a number, customer, company, cause or forecast that is not in the facts.',
  'Quote dollar amounts and percentages EXACTLY as written in the facts (same digits, same decimals), or not at all. Do not compute new figures.',
  'Cite the facts you rely on by their ref (F1, F2, ...). Every bullet must cite at least one ref.',
  'Write 3 to 6 bullets: what happened, what moved it, and what to look at next. Plain words; no jargon; no hype.',
  'If the facts say figures are preliminary or cannot be computed, say so plainly.',
  'Reply with JSON only: {"bullets": [{"text": string, "citations": string[]}]}.',
].join('\n');

export interface SummaryBullet {
  text: string;
  citations: string[];
}

export type SummaryDraftResult =
  | { kind: 'draft'; bullets: SummaryBullet[]; model: string | null; correlationId: string; tokens: { input: number; output: number }; costCents: number }
  | { kind: 'unavailable'; message: string }
  | { kind: 'refused'; problems: string[] };

/** Parse the model's JSON reply (tolerates ```json fences). PURE. */
export function parseSummaryReply(text: string | null): SummaryBullet[] | null {
  if (!text) return null;
  const json = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch {
    return null;
  }
  const raw = (obj as { bullets?: unknown } | null)?.bullets;
  if (!Array.isArray(raw)) return null;
  const out: SummaryBullet[] = [];
  for (const b of raw.slice(0, 8)) {
    const t = typeof (b as { text?: unknown })?.text === 'string' ? ((b as { text: string }).text.trim().slice(0, 600)) : '';
    if (!t) continue;
    const c = (b as { citations?: unknown }).citations;
    out.push({ text: t, citations: Array.isArray(c) ? c.filter((x): x is string => typeof x === 'string').slice(0, 12) : [] });
  }
  return out.length ? out : null;
}

/** Every bullet must cite a known ref; every $ / % must be a fact figure. PURE. */
export function verifySummary(bullets: readonly SummaryBullet[], sheet: FactSheet): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  bullets.forEach((b, i) => {
    if (b.citations.length === 0) problems.push(`Bullet ${i + 1} cites no facts.`);
    const v = verifyDraft(b.text, b.citations.length ? b.citations : ['__none__'], sheet);
    for (const p of v.problems) if (!p.startsWith('Unknown citation __none__')) problems.push(`Bullet ${i + 1}: ${p}`);
  });
  return { ok: problems.length === 0, problems };
}

function extractText(result: unknown): string | null {
  if (!Array.isArray(result)) return null;
  const b = (result as Array<{ type?: string; text?: string }>).find((c) => c?.type === 'text');
  return b?.text ?? null;
}

export async function draftViewSummary(
  deps: { supabase: SupabaseClient; anthropicApiKey: string | null },
  args: { orgId: string; userId: string | null; sheet: FactSheet },
): Promise<SummaryDraftResult> {
  if (!deps.anthropicApiKey) return { kind: 'unavailable', message: 'AI is not configured.' };
  if (args.sheet.refs.length === 0) return { kind: 'refused', problems: ['There are no computed figures in this view to summarize.'] };
  let gw;
  try {
    gw = await runAiGateway(
      { supabase: deps.supabase, anthropicApiKey: deps.anthropicApiKey },
      {
        tenant_id: args.orgId,
        user_id: args.userId,
        module: 'BOOKS',
        feature: FPNA_SUMMARY_FEATURE,
        model: FPNA_SUMMARY_MODEL,
        system: FPNA_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: [{ type: 'text', text: `Facts:\n${args.sheet.text}` }] }],
        max_tokens: 900,
      },
    );
  } catch (e) {
    if (isAiUnavailableError(e)) return { kind: 'unavailable', message: 'AI is temporarily unavailable.' };
    return { kind: 'unavailable', message: e instanceof Error ? e.message.slice(0, 200) : 'AI request failed.' };
  }
  if (gw.status === 'blocked' || gw.result == null) return { kind: 'unavailable', message: gw.message ?? 'AI request blocked by the usage budget.' };
  const bullets = parseSummaryReply(extractText(gw.result));
  if (!bullets) return { kind: 'refused', problems: ['The AI reply could not be read.'] };
  const check = verifySummary(bullets, args.sheet);
  if (!check.ok) return { kind: 'refused', problems: check.problems };
  return { kind: 'draft', bullets, model: gw.model_used, correlationId: gw.correlation_id, tokens: gw.tokens, costCents: gw.cost_cents };
}

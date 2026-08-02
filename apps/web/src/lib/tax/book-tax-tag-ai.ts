/**
 * Book-to-tax TAG proposal (feature 'BOOK_TAX_TAG') — TX-C1 AI seam.
 *
 * Canon §3, verbatim: "AI proposes FACTS; the deterministic engine does the accounting; a
 * human approves." Here the AI proposes only WHICH standard M-1/M-3 line an untagged
 * account belongs to (meals → MEALS_50, penalties → PENALTIES_FINES, depreciation →
 * BOOK_DEPR_EXCESS, …). It NEVER proposes a number: the add-back amount is later computed
 * deterministically by `book-tax.ts` from the account's real GL activity × the line's
 * cited disallowance percentage. Every proposal is written PROPOSED to `public.ai_decisions`
 * (the same rail the exception library and JE composer use) for a human to confirm; only on
 * confirmation does a `book_tax_account_tags` row get written.
 *
 * The classifier degrades safe: it first runs a deterministic keyword heuristic over the
 * account name/number (no key, no cost, fully explainable), and — when an Anthropic key is
 * present — routes the ambiguous remainder through the Core AI gateway (`@meritbooks/core-ai`,
 * metered, budget-capped). The model is constrained to return ONE code from the standard
 * catalog or `null`; anything off-catalog is rejected. All I/O-free logic
 * (`heuristicTagForAccount`) is unit-testable.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { runAiGateway } from '@meritbooks/core-ai';
import { STANDARD_M_LINES, findMLine, type MLineDef } from './book-tax';

export const BOOK_TAX_TAG_FEATURE = 'BOOK_TAX_TAG';
const TAG_MODEL = 'claude-3-5-haiku-latest';

export interface CandidateAccount {
  id: string;
  accountNumber: string;
  name: string;
  accountType: string; // REVENUE | COGS | OPEX | OTHER
}

export interface ProposedTag {
  accountId: string;
  accountNumber: string;
  accountName: string;
  code: string;
  label: string;
  differenceType: MLineDef['differenceType'];
  taxableEffect: MLineDef['taxableEffect'];
  m1Line: string;
  codeSection: string;
  confidence: number;
  reasoning: string;
  method: 'heuristic' | 'ai';
}

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic keyword heuristic (pure). Ordered: first match wins.
// ─────────────────────────────────────────────────────────────────────────────
interface HeuristicRule {
  code: string;
  /** all-lowercase substrings; ANY match triggers the rule. */
  keywords: string[];
  confidence: number;
}

const HEURISTIC_RULES: readonly HeuristicRule[] = [
  { code: 'MEALS_50',            keywords: ['meals', 'meal ', 'dining', 'restaurant'], confidence: 0.85 },
  { code: 'ENTERTAINMENT',       keywords: ['entertainment', 'tickets', 'sporting event'], confidence: 0.85 },
  { code: 'PENALTIES_FINES',     keywords: ['penalt', 'fine', 'late fee', 'citation'], confidence: 0.9 },
  { code: 'FED_INCOME_TAX',      keywords: ['federal income tax', 'federal tax', 'fed income tax'], confidence: 0.88 },
  { code: 'POLITICAL_LOBBYING',  keywords: ['political', 'lobby', 'campaign contribution'], confidence: 0.85 },
  { code: 'CLUB_DUES',           keywords: ['club dues', 'country club', 'membership dues'], confidence: 0.8 },
  { code: 'OFFICER_LIFE_INS',    keywords: ['officer life', 'life insurance', 'key man', 'key-man'], confidence: 0.75 },
  { code: 'TAX_EXEMPT_INTEREST', keywords: ['tax-exempt interest', 'tax exempt interest', 'municipal interest', 'muni interest'], confidence: 0.85 },
  { code: 'BOOK_DEPR_EXCESS',    keywords: ['depreciation', 'amortization'], confidence: 0.55 },
  { code: 'BAD_DEBT_RESERVE',    keywords: ['bad debt', 'allowance for doubtful', 'doubtful accounts'], confidence: 0.7 },
  { code: 'WARRANTY_RESERVE',    keywords: ['warranty', 'reserve for'], confidence: 0.6 },
  { code: 'ACCRUED_BONUS',       keywords: ['accrued bonus', 'accrued vacation', 'accrued pto', 'accrued comp'], confidence: 0.7 },
  { code: 'ACCRUED_EXPENSE',     keywords: ['accrued'], confidence: 0.5 },
  { code: 'PREPAID_EXPENSE',     keywords: ['prepaid'], confidence: 0.5 },
  { code: 'SEC_174_RD',          keywords: ['research', 'r&d', 'r & d', 'development cost'], confidence: 0.55 },
  { code: 'CHARITABLE_CARRY',    keywords: ['charitable', 'donation', 'contribution to'], confidence: 0.6 },
  { code: 'DEFERRED_REVENUE',    keywords: ['deferred revenue', 'unearned revenue'], confidence: 0.6 },
] as const;

/** Propose a book-tax code for an account from its name/number alone. Null = no signal. */
export function heuristicTagForAccount(
  account: Pick<CandidateAccount, 'name' | 'accountNumber'>,
): { code: string; confidence: number; reasoning: string } | null {
  const hay = `${account.name} ${account.accountNumber}`.toLowerCase();
  for (const rule of HEURISTIC_RULES) {
    const hit = rule.keywords.find((k) => hay.includes(k));
    if (hit) {
      return {
        code: rule.code,
        confidence: rule.confidence,
        reasoning: `Account name matched "${hit.trim()}" → ${findMLine(rule.code)?.label ?? rule.code}.`,
      };
    }
  }
  return null;
}

function toProposedTag(
  account: CandidateAccount,
  code: string,
  confidence: number,
  reasoning: string,
  method: 'heuristic' | 'ai',
): ProposedTag | null {
  const def = findMLine(code);
  if (!def) return null; // reject any off-catalog code (the model cannot invent lines)
  return {
    accountId: account.id,
    accountNumber: account.accountNumber,
    accountName: account.name,
    code: def.code,
    label: def.label,
    differenceType: def.differenceType,
    taxableEffect: def.taxableEffect,
    m1Line: def.m1Line,
    codeSection: def.codeSection,
    confidence,
    reasoning,
    method,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// AI classification via the Core gateway (metered). Returns a catalog code or null.
// ─────────────────────────────────────────────────────────────────────────────
function buildTagPrompt(account: CandidateAccount): string {
  const catalog = STANDARD_M_LINES.map(
    (l) => `- ${l.code}: ${l.label} (${l.differenceType}, ${l.codeSection})`,
  ).join('\n');
  return [
    'You are a US corporate tax analyst classifying a general-ledger account for its Schedule M-1 / M-3 book-to-tax treatment.',
    'Choose the SINGLE best-fitting code from this fixed catalog, or "NONE" if the account has no book-tax difference (a fully-deductible ordinary expense or fully-taxable ordinary revenue).',
    'You are classifying the TAX CHARACTER only. Do NOT output any dollar amount — amounts are computed deterministically elsewhere.',
    '',
    'Catalog:',
    catalog,
    '',
    `Account: number "${account.accountNumber}", name "${account.name}", type ${account.accountType}.`,
    '',
    'Respond with ONLY a compact JSON object: {"code": "<CODE or NONE>", "confidence": <0..1>, "reason": "<one sentence>"}.',
  ].join('\n');
}

function extractText(result: unknown): string | null {
  if (!Array.isArray(result)) return null;
  const block = (result as Array<{ type?: string; text?: string }>).find((c) => c?.type === 'text');
  return block?.text ?? null;
}

function parseTagResponse(text: string): { code: string; confidence: number; reason: string } | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const raw = JSON.parse(match[0]) as { code?: unknown; confidence?: unknown; reason?: unknown };
    const code = typeof raw.code === 'string' ? raw.code.trim().toUpperCase() : '';
    if (!code || code === 'NONE') return null;
    const confidence = typeof raw.confidence === 'number' ? Math.max(0, Math.min(1, raw.confidence)) : 0.6;
    const reason = typeof raw.reason === 'string' ? raw.reason : '';
    return { code, confidence, reason };
  } catch {
    return null;
  }
}

/**
 * Propose tags for a batch of untagged candidate accounts. The heuristic runs first (free,
 * explainable); accounts it can't classify are sent to the gateway only when a key is
 * provided. Never throws — a null/absent result simply means "no proposal for that account".
 */
export async function proposeAccountTags(
  deps: { supabase: SupabaseClient; anthropicApiKey: string | null },
  args: { orgId: string; userId: string | null; accounts: CandidateAccount[] },
): Promise<ProposedTag[]> {
  const { supabase, anthropicApiKey } = deps;
  const { orgId, userId, accounts } = args;
  const proposals: ProposedTag[] = [];
  const needsAi: CandidateAccount[] = [];

  for (const account of accounts) {
    const h = heuristicTagForAccount(account);
    if (h && h.confidence >= 0.7) {
      const p = toProposedTag(account, h.code, h.confidence, h.reasoning, 'heuristic');
      if (p) proposals.push(p);
    } else {
      needsAi.push(account);
    }
  }

  if (anthropicApiKey) {
    for (const account of needsAi) {
      try {
        const gw = await runAiGateway(
          { supabase, anthropicApiKey },
          {
            tenant_id: orgId,
            user_id: userId,
            module: 'BOOKS',
            feature: BOOK_TAX_TAG_FEATURE,
            model: TAG_MODEL,
            messages: [{ role: 'user', content: [{ type: 'text', text: buildTagPrompt(account) }] }],
            max_tokens: 200,
          },
        );
        if (gw.status === 'blocked' || gw.result == null) continue;
        const text = extractText(gw.result);
        if (!text) continue;
        const parsed = parseTagResponse(text);
        if (!parsed) continue;
        const p = toProposedTag(account, parsed.code, parsed.confidence, parsed.reason || 'AI classification.', 'ai');
        if (p) proposals.push(p);
      } catch {
        // a control/proposal must never break the pass it rides on
      }
    }
  } else {
    // No key: still surface low-confidence heuristic hits so the human has a starting point.
    for (const account of needsAi) {
      const h = heuristicTagForAccount(account);
      if (h) {
        const p = toProposedTag(account, h.code, h.confidence, h.reasoning, 'heuristic');
        if (p) proposals.push(p);
      }
    }
  }

  return proposals;
}

/**
 * Persist proposals as PROPOSED rows in public.ai_decisions (feature 'BOOK_TAX_TAG'),
 * idempotent per account via a stable dedup_key. Returns the number of open proposals.
 * RLS-scoped: the caller's client enforces org isolation; org_id is never hand-filtered.
 */
export async function persistTagProposals(
  supabase: SupabaseClient,
  args: { orgId: string; userId: string | null; proposals: ProposedTag[] },
): Promise<{ inserted: number; refreshed: number }> {
  const { orgId, userId, proposals } = args;
  if (proposals.length === 0) return { inserted: 0, refreshed: 0 };

  const { data: existing } = await supabase
    .from('ai_decisions')
    .select('id, status, proposed_output')
    .eq('feature', BOOK_TAX_TAG_FEATURE);

  const openByKey = new Map<string, string>();
  for (const row of (existing ?? []) as Array<{ id: string; status: string; proposed_output?: { dedup_key?: string } }>) {
    if (row.status === 'PROPOSED' && row.proposed_output?.dedup_key) {
      openByKey.set(row.proposed_output.dedup_key, row.id);
    }
  }

  let inserted = 0;
  let refreshed = 0;
  for (const p of proposals) {
    const dedupKey = `booktax:${p.accountId}`;
    const proposedOutput = {
      dedup_key: dedupKey,
      kind: 'account_tag',
      account_id: p.accountId,
      account_number: p.accountNumber,
      account_name: p.accountName,
      code: p.code,
      label: p.label,
      difference_type: p.differenceType,
      taxable_effect: p.taxableEffect,
      m1_line: p.m1Line,
      code_section: p.codeSection,
      method: p.method,
    };
    const existingId = openByKey.get(dedupKey);
    if (existingId) {
      const { error } = await supabase
        .from('ai_decisions')
        .update({ proposed_output: proposedOutput, confidence: p.confidence, reasoning: p.reasoning })
        .eq('id', existingId);
      if (!error) refreshed += 1;
    } else {
      const { error } = await supabase.from('ai_decisions').insert({
        org_id: orgId,
        feature: BOOK_TAX_TAG_FEATURE,
        input_summary: `Book-tax tag for account ${p.accountNumber} · ${p.accountName}`,
        proposed_output: proposedOutput,
        confidence: p.confidence,
        reasoning: p.reasoning,
        status: 'PROPOSED',
        created_by_user: userId,
      });
      if (!error) inserted += 1;
    }
  }
  return { inserted, refreshed };
}

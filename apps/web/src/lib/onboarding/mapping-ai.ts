/**
 * Onboarding conversion — AI-proposed account MAPPING.
 *
 * Canon §3: "AI proposes FACTS; the deterministic engine does the accounting; a
 * human approves." Here the only fact the AI proposes is which tenant account a
 * prior-system account maps to. It is handed ONLY the source account identifiers
 * (number + name) and the tenant chart of accounts — never a dollar amount. It
 * cannot, therefore, invent, move, or recompute a balance: every cent is
 * aggregated in code (lib/onboarding/conversion.ts) from the uploaded numbers.
 *
 * Resolution order per source account:
 *   1. Deterministic heuristic — exact account-number match, else exact/contained
 *      normalized-name match. High confidence, no model cost.
 *   2. AI proposal (Core AI gateway, feature CONVERSION_MAP) for whatever the
 *      heuristic could not resolve. STRICT: JSON only, target must be a real
 *      tenant account number, no amounts in or out.
 *   3. Left unmapped — the human maps it on the review screen. Unmapped accounts
 *      with a balance BLOCK the tie-out.
 */

import { runAiGateway } from '@meritbooks/core-ai';
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  AccountMapping,
  MappingTable,
  SourceAccountRef,
  TargetAccount,
} from './conversion';

const CONVERSION_MAP_MODEL = 'claude-sonnet-4-20250514';

const SYSTEM_MAP =
  'You are an accounting-systems migration assistant. You are mapping a company\'s ' +
  'OLD chart of accounts (from QuickBooks/Sage/etc.) onto a NEW target chart of ' +
  'accounts. For each source account you are given its code and name; for the target ' +
  'you are given the full chart (number, name, type). ' +
  'STRICT RULES: (1) You map accounts ONLY — you are never given and must never output ' +
  'any dollar amount, balance, debit, or credit. (2) Choose the single BEST target ' +
  'account by meaning and account type (an asset maps to an asset, revenue to revenue, ' +
  'etc.). (3) The target_account_number MUST be one of the provided target numbers ' +
  'verbatim — never invent one. (4) If you are not reasonably sure, return null for ' +
  'target_account_number rather than guessing. (5) Output ONLY valid JSON of the form ' +
  '{"mappings":[{"source_account":"...","target_account_number":"..."|null,' +
  '"confidence":0.0-1.0,"reasoning":"short"}]} — no prose, no markdown.';

interface AiMappingItem {
  source_account: string;
  target_account_number: string | null;
  confidence: number | null;
  reasoning: string | null;
}

const norm = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();

/** Deterministic first pass: exact number, then exact/contained name. */
function heuristicMap(
  source: SourceAccountRef,
  targets: TargetAccount[],
  targetByNumber: Map<string, TargetAccount>,
): AccountMapping | null {
  // 1. Exact account-number match (most reliable when both systems share numbers).
  const codeTrim = source.sourceAccount.trim();
  if (targetByNumber.has(codeTrim)) {
    return { targetAccountNumber: codeTrim, confidence: 0.99, source: 'heuristic', reasoning: 'Exact account-number match.' };
  }
  // 2. Name match.
  const srcName = source.sourceName ? norm(source.sourceName) : '';
  if (srcName.length >= 3) {
    const exact = targets.find((t) => norm(t.name) === srcName);
    if (exact) return { targetAccountNumber: exact.accountNumber, confidence: 0.9, source: 'heuristic', reasoning: `Exact name match to "${exact.name}".` };
    const contained = targets.find((t) => { const tn = norm(t.name); return tn.length >= 4 && (tn.includes(srcName) || srcName.includes(tn)); });
    if (contained) return { targetAccountNumber: contained.accountNumber, confidence: 0.7, source: 'heuristic', reasoning: `Name similar to "${contained.name}".` };
  }
  return null;
}

export interface ProposeMappingResult {
  mapping: MappingTable;
  aiUsed: boolean;
  aiError: string | null;
  correlationId: string | null;
}

/**
 * Propose a mapping for every distinct source account. Heuristics first, the Core
 * AI gateway for the remainder. Never sees balances (see the SourceAccountRef type).
 */
export async function proposeMapping(
  adminSupabase: SupabaseClient,
  opts: {
    orgId: string;
    userId: string | null;
    apiKey: string | null;
    sourceAccounts: SourceAccountRef[];
    targets: TargetAccount[];
  },
): Promise<ProposeMappingResult> {
  const { orgId, userId, apiKey, sourceAccounts, targets } = opts;
  const targetByNumber = new Map(targets.map((t) => [t.accountNumber, t]));
  const mapping: MappingTable = {};
  const needAi: SourceAccountRef[] = [];

  for (const src of sourceAccounts) {
    const h = heuristicMap(src, targets, targetByNumber);
    if (h) mapping[src.sourceAccount] = h;
    else {
      mapping[src.sourceAccount] = { targetAccountNumber: null, confidence: null, source: 'unmapped' };
      needAi.push(src);
    }
  }

  if (needAi.length === 0 || !apiKey) {
    return { mapping, aiUsed: false, aiError: apiKey ? null : 'AI unavailable — mapped by exact match only; map the rest manually.', correlationId: null };
  }

  try {
    const targetCatalog = targets
      .map((t) => `${t.accountNumber} | ${t.name}`)
      .join('\n');
    const sourceList = needAi
      .map((s) => `${s.sourceAccount}${s.sourceName ? ` | ${s.sourceName}` : ''}`)
      .join('\n');

    const gw = await runAiGateway(
      { supabase: adminSupabase, anthropicApiKey: apiKey },
      {
        tenant_id: orgId,
        user_id: userId,
        module: 'BOOKS',
        feature: 'CONVERSION_MAP',
        model: CONVERSION_MAP_MODEL,
        system: SYSTEM_MAP,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text:
                  `TARGET CHART OF ACCOUNTS (number | name):\n${targetCatalog}\n\n` +
                  `SOURCE ACCOUNTS TO MAP (code | name):\n${sourceList}\n\n` +
                  'Return the JSON mapping now. No amounts.',
              },
            ],
          },
        ],
        max_tokens: 1500,
      },
    );

    if (gw.status === 'blocked' || gw.result == null) {
      return { mapping, aiUsed: false, aiError: gw.message ?? 'AI mapping unavailable.', correlationId: gw.correlation_id };
    }

    const text = extractText(gw.result);
    const items = parseMappingJson(text);
    for (const item of items) {
      const src = item.source_account;
      if (!src || !(src in mapping)) continue;
      const target = item.target_account_number;
      if (target && targetByNumber.has(target)) {
        mapping[src] = {
          targetAccountNumber: target,
          confidence: clampConfidence(item.confidence),
          source: 'ai',
          reasoning: (item.reasoning ?? '').slice(0, 300) || 'AI-proposed mapping.',
        };
      }
      // target missing/unknown → leave as unmapped for the human.
    }

    return { mapping, aiUsed: true, aiError: null, correlationId: gw.correlation_id };
  } catch (e) {
    return { mapping, aiUsed: false, aiError: e instanceof Error ? e.message : 'AI mapping failed.', correlationId: null };
  }
}

function clampConfidence(c: number | null): number | null {
  if (c == null || !Number.isFinite(c)) return null;
  return Math.max(0, Math.min(1, c));
}

function extractText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (Array.isArray(result)) {
    const block = (result as Array<{ type?: string; text?: string }>).find((c) => c?.type === 'text');
    return block?.text ?? '';
  }
  return '';
}

function parseMappingJson(text: string): AiMappingItem[] {
  const trimmed = text.trim();
  // Tolerate a fenced block or leading prose by grabbing the first {...} object.
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(trimmed.slice(start, end + 1)) as { mappings?: unknown };
    const list = Array.isArray(parsed.mappings) ? parsed.mappings : [];
    return list
      .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
      .map((x) => ({
        source_account: String((x as Record<string, unknown>).source_account ?? ''),
        target_account_number:
          (x as Record<string, unknown>).target_account_number == null
            ? null
            : String((x as Record<string, unknown>).target_account_number),
        confidence:
          typeof (x as Record<string, unknown>).confidence === 'number'
            ? ((x as Record<string, unknown>).confidence as number)
            : null,
        reasoning:
          (x as Record<string, unknown>).reasoning == null
            ? null
            : String((x as Record<string, unknown>).reasoning),
      }));
  } catch {
    return [];
  }
}

/**
 * Optional AI intent extraction for the SEARCH lane.
 *
 * Canon-critical boundary: the model is used ONLY to turn an ambiguous natural-
 * language question into the SAME structured intent shape the deterministic
 * parser produces (types, amount, date-range, entity/text). It NEVER writes SQL
 * and NEVER returns result rows. Every DB query downstream is still built by the
 * deterministic retrieval layer from this structure. If the gateway is
 * unavailable or budget-blocked, we return null and the caller degrades to the
 * pure deterministic parse.
 *
 * Routed through the Core AI gateway (module BOOKS, feature SEARCH_PARSE) so the
 * call is entitled, rate-limited, budget-capped, and metered like every other AI
 * seam — no direct Anthropic call, no module-held key.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { runAiGateway } from '@meritbooks/core-ai';
import { ALL_SEARCH_TYPES, type SearchType } from './types';

export const SEARCH_PARSE_FEATURE = 'SEARCH_PARSE';
export const SEARCH_PARSE_MODEL = 'claude-sonnet-4-20250514';

export interface AiSearchIntent {
  /** Object types the question is about, or null if unspecified. */
  types: SearchType[] | null;
  /** Entity / free-text terms to match (names, keywords). */
  terms: string[];
  /** Exact dollar amounts (as written by the user), in dollars. */
  amountsDollars: number[];
  /** ISO yyyy-mm-dd date window, or null. */
  dateFrom: string | null;
  dateTo: string | null;
}

interface AiParseArgs {
  supabase: SupabaseClient;
  anthropicApiKey: string | null;
  orgId: string;
  userId: string | null;
  query: string;
}

function extractText(result: unknown): string | null {
  if (!Array.isArray(result)) return null;
  const b = (result as Array<{ type?: string; text?: string }>).find((c) => c?.type === 'text');
  return b?.text ?? null;
}

const TYPE_SET = new Set<string>(ALL_SEARCH_TYPES);

const PROMPT = (query: string) => `You extract structured search intent from a bookkeeping/accounting search query. You NEVER answer the question or invent data — you ONLY classify the query into filters.

Query: "${query}"

Valid object types: ${ALL_SEARCH_TYPES.join(', ')}

Respond with ONLY this JSON, no markdown:
{"types":["invoice"]|null,"terms":["acme"],"amounts_dollars":[1500.00],"date_from":"2026-07-01"|null,"date_to":"2026-07-31"|null}

Rules:
- "types": array of the valid types the query is about, or null if not specified.
- "terms": vendor/customer/account/keyword names to match; [] if none.
- "amounts_dollars": specific dollar amounts mentioned; [] if none.
- "date_from"/"date_to": inclusive ISO window if a date/period is implied, else null.`;

/**
 * Ask the gateway to structure an ambiguous query. Returns null on any failure,
 * block, or parse error so the caller can degrade to deterministic-only.
 */
export async function aiParseIntent(args: AiParseArgs): Promise<AiSearchIntent | null> {
  if (!args.anthropicApiKey) return null;

  let gw;
  try {
    gw = await runAiGateway(
      { supabase: args.supabase, anthropicApiKey: args.anthropicApiKey },
      {
        tenant_id: args.orgId,
        user_id: args.userId,
        module: 'BOOKS',
        feature: SEARCH_PARSE_FEATURE,
        model: SEARCH_PARSE_MODEL,
        messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT(args.query) }] }],
        max_tokens: 300,
      },
    );
  } catch {
    return null;
  }

  if (gw.status === 'blocked' || gw.result == null) return null;

  const text = extractText(gw.result);
  if (!text) return null;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim());
  } catch {
    return null;
  }

  const rawTypes = Array.isArray(parsed.types) ? parsed.types : null;
  const types: SearchType[] | null = rawTypes
    ? (rawTypes
        .map((t) => String(t).toLowerCase())
        .filter((t): t is SearchType => TYPE_SET.has(t)))
    : null;

  const terms = Array.isArray(parsed.terms)
    ? parsed.terms.map((t) => String(t).trim().toLowerCase()).filter((t) => t.length >= 2).slice(0, 8)
    : [];

  const amountsDollars = Array.isArray(parsed.amounts_dollars)
    ? parsed.amounts_dollars
        .map((n) => Number(n))
        .filter((n) => Number.isFinite(n) && n > 0)
        .slice(0, 8)
    : [];

  const dateFrom = typeof parsed.date_from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(parsed.date_from)
    ? parsed.date_from
    : null;
  const dateTo = typeof parsed.date_to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(parsed.date_to)
    ? parsed.date_to
    : null;

  return {
    types: types && types.length > 0 ? types : null,
    terms,
    amountsDollars,
    dateFrom,
    dateTo,
  };
}

/**
 * P2 categorize/code — NL → a search + a proposed GL coding for bank-feed lines.
 *
 * The extractor only turns "code the Home Depot charge to job supplies" into a
 * {vendorQuery, accountHint, limit}. The route then finds the matching feed
 * transactions, proposes a GL account (the named account resolved against COA, or
 * the existing AI categorizer's suggestion on the row), shows them for review, and
 * approval routes through the EXISTING gated /api/bank-feed/approve (which posts
 * the balanced JE with all period/balance/COA gates). Nothing posts here.
 *
 * If the prompt names no vendor/merchant to match, we clarify rather than scan the
 * whole feed blindly.
 */

import {
  type LaneModelCall,
  type LaneExtraction,
  parseLooseJson,
  str,
  conf,
} from './extract';

export interface CategorizeExtract {
  /** The merchant/vendor text to match against bank-feed descriptions. */
  vendorQuery: string;
  /** A free-text GL account hint ("job supplies") the route resolves against COA. */
  accountHint: string | null;
  /** How many matching transactions to act on (1..50). */
  limit: number;
}

const DEFAULT_LIMIT = 10;

export function buildCategorizeExtractPrompt(prompt: string): string {
  return `You interpret a bank-feed CODING instruction for MeritBooks (e.g. "code the last 5 Home Depot charges to job materials"). You do NOT categorize anything; you only extract the search + target.

Return ONLY this JSON (no prose, no markdown):
{
  "vendorQuery": "string or null — the merchant/vendor text to find in the feed ('Home Depot')",
  "accountHint": "string or null — the GL account to code them to ('job materials'), if named",
  "limit": number or null — how many transactions the user meant (e.g. 'last 5' => 5; a single 'the charge' => 1; unspecified => null),
  "clarifyingQuestion": "string or null — if no merchant/vendor is identifiable, ONE specific question; else null",
  "confidence": number 0-1
}

INSTRUCTION:
"""${prompt}"""`;
}

/** Pure: validate the parsed extract or ask to clarify. */
export function validateCategorizeExtract(
  parsed: Record<string, unknown> | null,
): LaneExtraction<CategorizeExtract> {
  if (!parsed) {
    return { draft: null, clarifyingQuestion: 'Which merchant or vendor should I code — e.g. "code the Home Depot charges"?', confidence: 0, raw: null };
  }

  const vendorQuery = str(parsed.vendorQuery);
  const modelClarify = str(parsed.clarifyingQuestion);
  const confidence = conf(parsed.confidence);

  if (!vendorQuery) {
    return {
      draft: null,
      clarifyingQuestion:
        modelClarify ?? 'Which merchant or vendor should I look for in the bank feed?',
      confidence,
      raw: parsed,
    };
  }

  const rawLimit = Number(parsed.limit);
  const limit = Number.isFinite(rawLimit) && rawLimit >= 1 ? Math.min(50, Math.floor(rawLimit)) : DEFAULT_LIMIT;

  const draft: CategorizeExtract = {
    vendorQuery,
    accountHint: str(parsed.accountHint),
    limit,
  };
  return { draft, clarifyingQuestion: modelClarify, confidence, raw: parsed };
}

export async function extractCategorize(
  prompt: string,
  call: LaneModelCall,
): Promise<LaneExtraction<CategorizeExtract>> {
  const text = await call(buildCategorizeExtractPrompt(prompt));
  return validateCategorizeExtract(parseLooseJson(text));
}

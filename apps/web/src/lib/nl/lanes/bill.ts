/**
 * P3 create-bill — NL → structured DRAFT bill extract.
 *
 * The extractor never books anything. It returns a proposed vendor/amount/dates
 * that the route resolves to real ids and renders as an EDITABLE draft; the human
 * confirms and the draft is created through the EXISTING gated /api/bills/create
 * route (which keeps its own validation, compliance holds, and committed-cost
 * attribution). If the vendor or amount is missing we clarify, never guess.
 */

import {
  type LaneModelCall,
  type LaneExtraction,
  parseLooseJson,
  toCents,
  str,
  isoDate,
  conf,
} from './extract';

export interface BillDraft {
  vendorName: string;
  amountCents: number;
  billDate: string | null;
  dueDate: string | null;
  lineDescription: string;
  /** A free-text GL account hint ("job supplies") the route resolves against COA. */
  accountHint: string | null;
  memo: string | null;
}

/** Build the extraction prompt. `today` (YYYY-MM-DD) anchors relative dates. */
export function buildBillExtractPrompt(prompt: string, today: string): string {
  return `You extract a vendor BILL (accounts payable — money WE owe a vendor) from a user's instruction for MeritBooks. Do NOT create anything; only extract fields. Today is ${today}.

Return ONLY this JSON (no prose, no markdown):
{
  "vendorName": "string or null — the payee/vendor exactly as named",
  "amountCents": number or null — total owed IN CENTS ($1,200 => 120000),
  "billDate": "YYYY-MM-DD or null — the bill/invoice date; default to today if only a due date is given",
  "dueDate": "YYYY-MM-DD or null — resolve relative dates like 'next Friday' or 'net 30' against today",
  "lineDescription": "string — a short description of what the bill is for",
  "accountHint": "string or null — any expense/GL account the user named ('job supplies', 'utilities')",
  "memo": "string or null — any note",
  "clarifyingQuestion": "string or null — if the vendor or amount is missing/ambiguous, ONE specific question; else null",
  "confidence": number 0-1
}

Rules:
- All money in CENTS.
- Never invent a vendor or amount. If either is absent, set it null AND set clarifyingQuestion.
- Dates must be YYYY-MM-DD.

INSTRUCTION:
"""${prompt}"""`;
}

/** Pure: turn parsed model JSON into a validated draft or a clarify. */
export function validateBillExtract(
  parsed: Record<string, unknown> | null,
  today: string,
): LaneExtraction<BillDraft> {
  if (!parsed) {
    return { draft: null, clarifyingQuestion: 'I could not read that as a bill — can you restate the vendor and amount?', confidence: 0, raw: null };
  }

  const vendorName = str(parsed.vendorName);
  const amountCents = toCents(parsed.amountCents);
  const modelClarify = str(parsed.clarifyingQuestion);
  const confidence = conf(parsed.confidence);

  // Clarify-before-book: vendor and amount are both required to draft a payable.
  if (!vendorName || amountCents == null || amountCents <= 0) {
    const missing: string[] = [];
    if (!vendorName) missing.push('which vendor');
    if (amountCents == null || amountCents <= 0) missing.push('the amount');
    const question =
      modelClarify ??
      `Before I draft this bill, I need ${missing.join(' and ')}. Can you add that?`;
    return { draft: null, clarifyingQuestion: question, confidence, raw: parsed };
  }

  const billDate = isoDate(parsed.billDate) ?? today;
  const draft: BillDraft = {
    vendorName,
    amountCents,
    billDate,
    dueDate: isoDate(parsed.dueDate),
    lineDescription: str(parsed.lineDescription) ?? `Bill from ${vendorName}`,
    accountHint: str(parsed.accountHint),
    memo: str(parsed.memo),
  };
  // A genuinely ambiguous but non-empty extract can still carry the model's question.
  return { draft, clarifyingQuestion: modelClarify, confidence, raw: parsed };
}

/** Full extract: call the injected model, parse, validate. */
export async function extractBillDraft(
  prompt: string,
  today: string,
  call: LaneModelCall,
): Promise<LaneExtraction<BillDraft>> {
  const text = await call(buildBillExtractPrompt(prompt, today));
  return validateBillExtract(parseLooseJson(text), today);
}

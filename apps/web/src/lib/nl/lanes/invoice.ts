/**
 * P4 create-invoice — NL → structured DRAFT invoice extract.
 *
 * Never posts. The route resolves the customer/account and renders an EDITABLE
 * draft; the human confirms and it is created through the EXISTING shared
 * invoice-create core (`/api/invoices`, rev-rec-aware: a managed job routes
 * revenue to Deferred Revenue 2410). We draft as a DRAFT (post_to_gl:false) — the
 * copilot forks neither numbering nor rev-rec treatment. Missing customer or
 * amount → clarify, never guess.
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

export interface InvoiceDraft {
  customerName: string;
  amountCents: number;
  invoiceDate: string | null;
  dueDate: string | null;
  lineDescription: string;
  /** A free-text revenue-account hint the route resolves against COA. */
  accountHint: string | null;
  memo: string | null;
}

/** Build the extraction prompt. `today` (YYYY-MM-DD) anchors relative dates. */
export function buildInvoiceExtractPrompt(prompt: string, today: string): string {
  return `You extract a customer INVOICE (accounts receivable — money a CUSTOMER owes US) from a user's instruction for MeritBooks. Do NOT create anything; only extract fields. Today is ${today}.

Return ONLY this JSON (no prose, no markdown):
{
  "customerName": "string or null — the customer/payer exactly as named",
  "amountCents": number or null — invoice total IN CENTS ($5,000 => 500000; '5k' => 500000),
  "invoiceDate": "YYYY-MM-DD or null — default to today if not stated",
  "dueDate": "YYYY-MM-DD or null — resolve 'net 30' / 'due next month' against today",
  "lineDescription": "string — what the invoice is for ('June retainer')",
  "accountHint": "string or null — any revenue/GL account the user named",
  "memo": "string or null — any note",
  "clarifyingQuestion": "string or null — if the customer or amount is missing/ambiguous, ONE specific question; else null",
  "confidence": number 0-1
}

Rules:
- All money in CENTS. Interpret 'k' as thousands.
- Never invent a customer or amount. If either is absent, set it null AND set clarifyingQuestion.
- Dates must be YYYY-MM-DD.

INSTRUCTION:
"""${prompt}"""`;
}

/** Pure: turn parsed model JSON into a validated draft or a clarify. */
export function validateInvoiceExtract(
  parsed: Record<string, unknown> | null,
  today: string,
): LaneExtraction<InvoiceDraft> {
  if (!parsed) {
    return { draft: null, clarifyingQuestion: 'I could not read that as an invoice — can you restate the customer and amount?', confidence: 0, raw: null };
  }

  const customerName = str(parsed.customerName);
  const amountCents = toCents(parsed.amountCents);
  const modelClarify = str(parsed.clarifyingQuestion);
  const confidence = conf(parsed.confidence);

  if (!customerName || amountCents == null || amountCents <= 0) {
    const missing: string[] = [];
    if (!customerName) missing.push('which customer');
    if (amountCents == null || amountCents <= 0) missing.push('the amount');
    const question =
      modelClarify ??
      `Before I draft this invoice, I need ${missing.join(' and ')}. Can you add that?`;
    return { draft: null, clarifyingQuestion: question, confidence, raw: parsed };
  }

  const invoiceDate = isoDate(parsed.invoiceDate) ?? today;
  const draft: InvoiceDraft = {
    customerName,
    amountCents,
    invoiceDate,
    dueDate: isoDate(parsed.dueDate),
    lineDescription: str(parsed.lineDescription) ?? `Invoice for ${customerName}`,
    accountHint: str(parsed.accountHint),
    memo: str(parsed.memo),
  };
  return { draft, clarifyingQuestion: modelClarify, confidence, raw: parsed };
}

/** Full extract: call the injected model, parse, validate. */
export async function extractInvoiceDraft(
  prompt: string,
  today: string,
  call: LaneModelCall,
): Promise<LaneExtraction<InvoiceDraft>> {
  const text = await call(buildInvoiceExtractPrompt(prompt, today));
  return validateInvoiceExtract(parseLooseJson(text), today);
}

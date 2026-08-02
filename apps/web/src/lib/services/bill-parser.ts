/**
 * AI Bill Parsing Service
 * Sends invoice documents (PDF or image) through the Core AI gateway for
 * extraction. Returns structured bill data with confidence scores per field.
 *
 * Canon §2: the model call routes through `runAiGateway` (metered to
 * core.ai_usage_log, tenant budget enforced across the combined suite) — never a
 * direct Anthropic call. The gateway is org-scoped via `tenant_id = orgId`.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { runAiGateway } from '@meritbooks/core-ai';

export const BILL_PARSE_MODEL = 'claude-sonnet-4-20250514';
export const BILL_PARSE_FEATURE = 'BILL_PARSE';

interface ParsedBillLine {
  description: string;
  quantity: number;
  unitCostCents: number;
  amountCents: number;
  suggestedAccountNumber: string | null;
  confidence: number;
}

export interface ParsedBill {
  vendorName: string;
  vendorNameConfidence: number;
  billNumber: string | null;
  billNumberConfidence: number;
  billDate: string | null;
  billDateConfidence: number;
  dueDate: string | null;
  dueDateConfidence: number;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  totalConfidence: number;
  currency: string;
  lines: ParsedBillLine[];
  rawText: string;
  aiModel: string;
  parseTimeMs: number;
}

export interface ParseResult {
  success: boolean;
  data?: ParsedBill;
  error?: string;
  /** True when the gateway blocked the call for budget/entitlement reasons. */
  budgetBlocked?: boolean;
}

/** Pull the first text block out of the gateway result (Anthropic content array). */
function extractText(result: unknown): string | null {
  if (!Array.isArray(result)) return null;
  const b = (result as Array<{ type?: string; text?: string }>).find((c) => c?.type === 'text');
  return b?.text ?? null;
}

const EXTRACTION_PROMPT = `You are an expert accounting clerk. Extract all data from this vendor invoice/bill.

Return ONLY valid JSON with this exact structure (no markdown, no explanation):
{
  "vendorName": "string — exact vendor/company name from the invoice",
  "billNumber": "string or null — invoice number, PO number, or reference number",
  "billDate": "YYYY-MM-DD or null — invoice date",
  "dueDate": "YYYY-MM-DD or null — payment due date (calculate from terms if shown)",
  "subtotalCents": number — subtotal in cents (multiply dollars by 100),
  "taxCents": number — tax amount in cents (0 if none),
  "totalCents": number — total amount due in cents,
  "currency": "USD",
  "paymentTerms": "string or null — e.g. Net 30, Due on Receipt",
  "vendorAddress": "string or null",
  "vendorPhone": "string or null",
  "vendorEmail": "string or null",
  "lines": [
    {
      "description": "string — line item description",
      "quantity": number,
      "unitCostCents": number — unit price in cents,
      "amountCents": number — line total in cents,
      "category": "string or null — your best guess: MATERIALS, LABOR, SUBCONTRACTOR, EQUIPMENT, SUPPLIES, UTILITIES, RENT, INSURANCE, PROFESSIONAL_SERVICES, OTHER"
    }
  ],
  "confidence": {
    "vendorName": number 0-1,
    "billNumber": number 0-1,
    "billDate": number 0-1,
    "dueDate": number 0-1,
    "total": number 0-1,
    "lines": number 0-1
  },
  "notes": "string or null — anything unusual about this invoice (handwritten, partial, unclear amounts)"
}

Rules:
- All monetary values in CENTS (e.g. $1,234.56 = 123456)
- If a field is not visible or unclear, use null and set confidence to 0
- If there are no distinct line items, create one line with the total
- Dates must be YYYY-MM-DD format
- If payment terms say "Net 30" and bill date is visible, calculate the due date`;

/**
 * Parse an invoice document through the Core AI gateway.
 * Accepts base64-encoded PDF or image data. The model call is metered and budget-
 * capped per tenant; `orgId` scopes it (gateway `tenant_id`), `userId` attributes it.
 */
export async function parseInvoiceWithAI(
  supabase: SupabaseClient,
  apiKey: string,
  args: {
    orgId: string;
    userId?: string | null;
    base64Data: string;
    mediaType: string;
  },
): Promise<ParseResult> {
  const { orgId, userId, base64Data, mediaType } = args;
  const startTime = Date.now();

  const isPdf = mediaType === 'application/pdf';
  const isImage = mediaType.startsWith('image/');

  if (!isPdf && !isImage) {
    return { success: false, error: `Unsupported file type: ${mediaType}. Must be PDF or image.` };
  }

  const contentBlock = isPdf
    ? { type: 'document' as const, source: { type: 'base64' as const, media_type: 'application/pdf' as const, data: base64Data } }
    : { type: 'image' as const, source: { type: 'base64' as const, media_type: mediaType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp', data: base64Data } };

  try {
    let gw;
    try {
      gw = await runAiGateway(
        { supabase, anthropicApiKey: apiKey },
        {
          tenant_id: orgId,
          user_id: userId ?? null,
          module: 'BOOKS',
          feature: BILL_PARSE_FEATURE,
          model: BILL_PARSE_MODEL,
          messages: [
            { role: 'user', content: [contentBlock, { type: 'text', text: EXTRACTION_PROMPT }] },
          ],
          max_tokens: 4000,
        },
      );
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : 'Gateway error' };
    }

    if (gw.status === 'blocked' || gw.result == null) {
      return { success: false, error: gw.message ?? 'AI request blocked', budgetBlocked: gw.status === 'blocked' };
    }

    const text = extractText(gw.result);
    if (!text) {
      return { success: false, error: 'Claude returned empty response' };
    }

    // Parse JSON — strip any markdown fencing
    const jsonStr = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      console.error('[bill-parse] Failed to parse Claude JSON:', jsonStr.slice(0, 500));
      return { success: false, error: 'Failed to parse AI response as JSON' };
    }

    const confidence = (parsed.confidence as Record<string, number>) ?? {};
    const rawLines = (parsed.lines as Array<Record<string, unknown>>) ?? [];

    const lines: ParsedBillLine[] = rawLines.map((line) => ({
      description: String(line.description ?? ''),
      quantity: Number(line.quantity ?? 1),
      unitCostCents: Number(line.unitCostCents ?? 0),
      amountCents: Number(line.amountCents ?? 0),
      suggestedAccountNumber: null, // Will be enriched by vendor matching
      confidence: Number(confidence.lines ?? 0.7),
    }));

    const bill: ParsedBill = {
      vendorName: String(parsed.vendorName ?? ''),
      vendorNameConfidence: Number(confidence.vendorName ?? 0),
      billNumber: parsed.billNumber ? String(parsed.billNumber) : null,
      billNumberConfidence: Number(confidence.billNumber ?? 0),
      billDate: parsed.billDate ? String(parsed.billDate) : null,
      billDateConfidence: Number(confidence.billDate ?? 0),
      dueDate: parsed.dueDate ? String(parsed.dueDate) : null,
      dueDateConfidence: Number(confidence.dueDate ?? 0),
      subtotalCents: Number(parsed.subtotalCents ?? 0),
      taxCents: Number(parsed.taxCents ?? 0),
      totalCents: Number(parsed.totalCents ?? 0),
      totalConfidence: Number(confidence.total ?? 0),
      currency: String(parsed.currency ?? 'USD'),
      lines,
      rawText: String(parsed.notes ?? ''),
      aiModel: gw.model_used ?? BILL_PARSE_MODEL,
      parseTimeMs: Date.now() - startTime,
    };

    return { success: true, data: bill };
  } catch (err) {
    console.error('[bill-parse] Unexpected error:', err);
    return { success: false, error: err instanceof Error ? err.message : 'Unexpected error during parsing' };
  }
}

/**
 * Match extracted vendor name against existing vendors using fuzzy matching.
 * Returns the best match or null if no match above threshold.
 */
export async function matchVendor(
  vendorName: string,
  supabase: { schema: (s: string) => { from: (table: string) => { select: (cols: string) => { ilike: (col: string, val: string) => { limit: (n: number) => Promise<{ data: unknown[] | null }> } } } } }
): Promise<{ id: string; name: string; confidence: number } | null> {
  if (!vendorName) return null;

  // Try exact match first
  const { data: exact } = await (supabase.schema('core').from('vendors').select('id, name, display_name') as unknown as { ilike: (col: string, val: string) => { limit: (n: number) => Promise<{ data: Array<{ id: string; name: string; display_name: string | null }> | null }> } }).ilike('name', vendorName).limit(1);

  if (exact && exact.length > 0) {
    return { id: exact[0].id, name: exact[0].display_name ?? exact[0].name, confidence: 1.0 };
  }

  // Try fuzzy match — first 3 words
  const words = vendorName.split(/\s+/).slice(0, 3);
  for (const word of words) {
    if (word.length < 3) continue;
    const { data: fuzzy } = await (supabase.schema('core').from('vendors').select('id, name, display_name') as unknown as { ilike: (col: string, val: string) => { limit: (n: number) => Promise<{ data: Array<{ id: string; name: string; display_name: string | null }> | null }> } }).ilike('name', `%${word}%`).limit(5);

    if (fuzzy && fuzzy.length > 0) {
      // Return the first fuzzy match with reduced confidence
      return { id: fuzzy[0].id, name: fuzzy[0].display_name ?? fuzzy[0].name, confidence: 0.6 };
    }
  }

  return null;
}

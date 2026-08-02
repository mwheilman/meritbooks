/**
 * LlmVisionProvider — the working default extraction engine.
 *
 * Thin adapter over the existing, gateway-routed bill-parse
 * (`parseInvoiceWithAI` → `runAiGateway`, metered to core.ai_usage_log, tenant
 * budget enforced across the combined suite). It does NOT re-implement the model
 * call — it wraps it and maps the result onto the provider-agnostic ExtractedBill
 * contract. This keeps a single Anthropic path (canon §2) and one extraction
 * prompt, while giving the intake queue a stable, provider-shaped interface.
 */

import { parseInvoiceWithAI, type ParsedBill } from '@/lib/services/bill-parser';
import type {
  DocIntelligenceProvider,
  DocumentInput,
  DocExtractionResult,
  DocProviderDeps,
  ExtractedBill,
  ExtractedBillLine,
} from './types';

export const LLM_VISION_PROVIDER_NAME = 'llm-vision';

/** Map the legacy ParsedBill shape onto the provider-agnostic ExtractedBill. */
function toExtractedBill(parsed: ParsedBill): ExtractedBill {
  const lines: ExtractedBillLine[] = parsed.lines.map((l) => ({
    description: l.description,
    quantity: l.quantity,
    unitCostCents: l.unitCostCents,
    amountCents: l.amountCents,
    categoryHint: null,
    confidence: l.confidence,
  }));

  return {
    vendorName: parsed.vendorName,
    vendorNameConfidence: parsed.vendorNameConfidence,
    invoiceNumber: parsed.billNumber,
    invoiceNumberConfidence: parsed.billNumberConfidence,
    invoiceDate: parsed.billDate,
    invoiceDateConfidence: parsed.billDateConfidence,
    dueDate: parsed.dueDate,
    dueDateConfidence: parsed.dueDateConfidence,
    subtotalCents: parsed.subtotalCents,
    taxCents: parsed.taxCents,
    totalCents: parsed.totalCents,
    totalConfidence: parsed.totalConfidence,
    currency: parsed.currency,
    lines,
    notes: parsed.rawText,
    providerName: LLM_VISION_PROVIDER_NAME,
    engineVersion: parsed.aiModel,
    extractionMs: parsed.parseTimeMs,
  };
}

export class LlmVisionProvider implements DocIntelligenceProvider {
  readonly name = LLM_VISION_PROVIDER_NAME;

  constructor(private readonly deps: DocProviderDeps) {}

  /** Configured as long as we have an Anthropic key to inject into the gateway. */
  isConfigured(): boolean {
    return Boolean(this.deps.anthropicApiKey);
  }

  async extractBill(document: DocumentInput): Promise<DocExtractionResult> {
    const result = await parseInvoiceWithAI(this.deps.supabase, this.deps.anthropicApiKey, {
      orgId: document.orgId,
      userId: document.userId ?? null,
      base64Data: document.base64,
      mediaType: document.mediaType,
    });

    if (!result.success || !result.data) {
      return {
        ok: false,
        error: result.error ?? 'Failed to extract invoice',
        budgetBlocked: result.budgetBlocked,
      };
    }

    return { ok: true, bill: toExtractedBill(result.data) };
  }
}

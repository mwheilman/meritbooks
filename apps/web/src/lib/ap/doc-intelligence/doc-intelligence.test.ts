import { describe, it, expect } from 'vitest';
import { resolveDocProvider } from './resolve';
import {
  AzureDocIntelligenceProvider,
  AZURE_DOC_INTELLIGENCE_PROVIDER_NAME,
} from './azure-provider';
import { LLM_VISION_PROVIDER_NAME } from './llm-vision-provider';
import { assembleCreateBillPayload } from './intake-queue';
import type {
  DocIntelligenceProvider,
  DocProviderDeps,
  DocumentInput,
  DocExtractionResult,
  ExtractedBill,
} from './types';

const deps: DocProviderDeps = { supabase: {}, anthropicApiKey: 'test-key' };

const doc: DocumentInput = {
  base64: 'ZmFrZQ==',
  mediaType: 'application/pdf',
  fileName: 'invoice.pdf',
  orgId: 'org-1',
  userId: 'user-1',
};

function makeExtracted(overrides: Partial<ExtractedBill> = {}): ExtractedBill {
  return {
    vendorName: 'Acme Supply Co',
    vendorNameConfidence: 0.95,
    invoiceNumber: 'INV-1001',
    invoiceNumberConfidence: 0.9,
    invoiceDate: '2026-07-15',
    invoiceDateConfidence: 0.9,
    dueDate: '2026-08-14',
    dueDateConfidence: 0.8,
    subtotalCents: 100_00,
    taxCents: 7_00,
    totalCents: 107_00,
    totalConfidence: 0.92,
    currency: 'USD',
    lines: [
      { description: 'Widgets', quantity: 2, unitCostCents: 50_00, amountCents: 100_00, categoryHint: 'MATERIALS', confidence: 0.9 },
    ],
    notes: '',
    providerName: 'test',
    engineVersion: 'test-model',
    extractionMs: 12,
    ...overrides,
  };
}

/** A stub provider used to prove degrade delegation. */
class StubProvider implements DocIntelligenceProvider {
  readonly name = 'stub-fallback';
  constructor(private readonly bill: ExtractedBill) {}
  isConfigured(): boolean {
    return true;
  }
  async extractBill(_document: DocumentInput): Promise<DocExtractionResult> {
    return { ok: true, bill: this.bill };
  }
}

describe('resolveDocProvider', () => {
  it('picks Azure when Azure is configured (endpoint + key present)', () => {
    const provider = resolveDocProvider(deps, {
      azureConfig: { endpoint: 'https://x.cognitiveservices.azure.com', apiKey: 'azure-key' },
    });
    expect(provider.name).toBe(AZURE_DOC_INTELLIGENCE_PROVIDER_NAME);
    expect(provider.isConfigured()).toBe(true);
  });

  it('degrades to the LLM provider when Azure is unconfigured', () => {
    const provider = resolveDocProvider(deps, {
      azureConfig: { endpoint: null, apiKey: null },
    });
    expect(provider.name).toBe(LLM_VISION_PROVIDER_NAME);
  });

  it('degrades to the LLM provider when Azure has only a partial config', () => {
    const provider = resolveDocProvider(deps, {
      azureConfig: { endpoint: 'https://x.cognitiveservices.azure.com', apiKey: null },
    });
    expect(provider.name).toBe(LLM_VISION_PROVIDER_NAME);
  });
});

describe('AzureDocIntelligenceProvider degrade behavior', () => {
  it('delegates to its fallback when unconfigured', async () => {
    const bill = makeExtracted({ vendorName: 'From Fallback' });
    const azure = new AzureDocIntelligenceProvider({ endpoint: null, apiKey: null }, new StubProvider(bill));
    const result = await azure.extractBill(doc);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.bill.vendorName).toBe('From Fallback');
  });

  it('throws when unconfigured AND given no fallback', async () => {
    const azure = new AzureDocIntelligenceProvider({ endpoint: null, apiKey: null }, null);
    await expect(azure.extractBill(doc)).rejects.toThrow(/not configured/i);
  });

  it('reports configured only when both endpoint and key are present', () => {
    expect(new AzureDocIntelligenceProvider({ endpoint: 'e', apiKey: 'k' }).isConfigured()).toBe(true);
    expect(new AzureDocIntelligenceProvider({ endpoint: 'e', apiKey: null }).isConfigured()).toBe(false);
    expect(new AzureDocIntelligenceProvider({ endpoint: null, apiKey: 'k' }).isConfigured()).toBe(false);
  });
});

describe('assembleCreateBillPayload (draft assembly)', () => {
  it('maps extracted lines and totals onto a valid createBill body', () => {
    const payload = assembleCreateBillPayload(makeExtracted(), {
      vendorId: 'vendor-1',
      locationId: 'loc-1',
      defaultAccountId: 'acct-1',
    });
    expect(payload.vendor_id).toBe('vendor-1');
    expect(payload.location_id).toBe('loc-1');
    expect(payload.bill_number).toBe('INV-1001');
    expect(payload.bill_date).toBe('2026-07-15');
    expect(payload.due_date).toBe('2026-08-14');
    expect(payload.tax_cents).toBe(7_00);
    expect(payload.lines).toHaveLength(1);
    expect(payload.lines[0]).toMatchObject({
      account_id: 'acct-1',
      quantity: 2,
      unit_cost_cents: 50_00,
      amount_cents: 100_00,
      description: 'Widgets',
    });
  });

  it('synthesizes a single total line when the extraction has no lines', () => {
    const payload = assembleCreateBillPayload(makeExtracted({ lines: [] }), {
      vendorId: 'vendor-1',
      locationId: 'loc-1',
      defaultAccountId: 'acct-1',
    });
    expect(payload.lines).toHaveLength(1);
    expect(payload.lines[0].amount_cents).toBe(107_00);
    expect(payload.lines[0].account_id).toBe('acct-1');
  });

  it('defaults bill/due dates when the extraction lacks them', () => {
    const payload = assembleCreateBillPayload(
      makeExtracted({ invoiceDate: null, dueDate: null }),
      { vendorId: 'v', locationId: 'l', defaultAccountId: 'a' },
    );
    expect(payload.bill_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(payload.due_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // due date is 30 days after bill date
    expect(new Date(payload.due_date).getTime()).toBeGreaterThan(new Date(payload.bill_date).getTime());
  });

  it('applies per-line account overrides and a tax override', () => {
    const extracted = makeExtracted({
      lines: [
        { description: 'A', quantity: 1, unitCostCents: 10_00, amountCents: 10_00, categoryHint: null, confidence: 0.8 },
        { description: 'B', quantity: 1, unitCostCents: 20_00, amountCents: 20_00, categoryHint: null, confidence: 0.8 },
      ],
    });
    const payload = assembleCreateBillPayload(extracted, {
      vendorId: 'v',
      locationId: 'l',
      defaultAccountId: 'default-acct',
      lineAccountIds: ['acct-A', null],
      taxCentsOverride: 3_00,
    });
    expect(payload.lines[0].account_id).toBe('acct-A');
    expect(payload.lines[1].account_id).toBe('default-acct');
    expect(payload.tax_cents).toBe(3_00);
  });
});

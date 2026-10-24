/**
 * Document intelligence — the ROUTER to the modules' EXISTING extractors.
 *
 * No new extraction prompts live here: each staged target calls the module's own parser
 * (LEASE_EXTRACT, DEBT_EXTRACT, INSURANCE_EXTRACT, PREPAID_EXTRACT, SUBSCRIPTION_EXTRACT,
 * ASSET_EXTRACT, CONTRACT_EXTRACT — all through the Core AI gateway) and stores its
 * output in the SAME shape that module's `/api/<module>/parse` route returns, so the
 * module's review form can be opened pre-filled with no translation layer.
 *
 * Every adapter returns a typed outcome and never throws; AI-account failures are
 * classified (unavailable / budget_blocked) so the service can schedule a retry.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { isAiUnavailableError } from '@/lib/ai/gateway';
import { parseLeaseDocument } from '@/lib/leases/parse-lease';
import { parseLoanDocument } from '@/lib/debt/parse-loan';
import { parsePolicyDocument } from '@/lib/insurance/parse-policy';
import { parsePrepaidDocument } from '@/lib/prepaid/extract';
import { parseAgreementDocument } from '@/lib/subscriptions/parse-agreement';
import { parseAssetInvoice } from '@/lib/fixed-assets/asset-parse';
import { parseContractDocument } from '@/lib/invoices/contract-parse';
import type { TargetKind } from './types';

export type StagedKind = 'lease' | 'debt_instrument' | 'insurance_policy' | 'prepaid' | 'subscription' | 'fixed_asset' | 'customer_contract';
export const STAGED_KINDS: readonly StagedKind[] = ['lease', 'debt_instrument', 'insurance_policy', 'prepaid', 'subscription', 'fixed_asset', 'customer_contract'];
export function isStagedKind(k: TargetKind): k is StagedKind {
  return (STAGED_KINDS as readonly string[]).includes(k);
}

export interface ExtractArgs {
  orgId: string;
  userId: string | null;
  base64: string;
  mediaType: string;
  fileName: string;
  documentId: string;
}

export interface ExtractDeps {
  supabase: SupabaseClient;
  anthropicApiKey: string;
}

export type ExtractOutcome =
  | {
      ok: true;
      /** The module parse-route response shape ({ lease, meta } …). */
      payload: Record<string, unknown>;
      title: string;
      summary: string;
      confidence: number | null;
      model: string;
      correlationId: string | null;
      feature: string;
    }
  | { ok: false; kind: 'unavailable' | 'budget_blocked' | 'failed'; error: string };

export type ExtractImpl = (kind: StagedKind, deps: ExtractDeps, args: ExtractArgs) => Promise<ExtractOutcome>;

/** Only PDFs and images go to the vision extractors. */
export function extractable(mediaType: string): boolean {
  return mediaType === 'application/pdf' || /^image\/(png|jpeg|gif|webp)$/.test(mediaType);
}

const usd = (dollars: number | null | undefined): string =>
  dollars == null || !Number.isFinite(dollars) ? '' : `$${dollars.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const usdCents = (cents: number | null | undefined): string => (cents == null ? '' : usd(cents / 100));
const range = (a: string | null | undefined, b: string | null | undefined): string => (a && b ? `${a} to ${b}` : a ? `from ${a}` : b ? `until ${b}` : '');
const parts = (...p: Array<string | null | undefined | false>): string => p.filter((x): x is string => !!x && x.trim() !== '').join(' · ');
const avg = (conf: Record<string, number> | undefined): number | null => {
  const v = Object.values(conf ?? {}).filter((n) => typeof n === 'number' && Number.isFinite(n));
  return v.length ? Number((v.reduce((s, n) => s + n, 0) / v.length).toFixed(3)) : null;
};

function failure(error: string, budgetBlocked?: boolean): ExtractOutcome {
  if (budgetBlocked) return { ok: false, kind: 'budget_blocked', error };
  return { ok: false, kind: isAiUnavailableError(error) ? 'unavailable' : 'failed', error };
}

function meta(args: ExtractArgs, r: { model: string; documentNote?: string | null; extractionMs: number }, extra: Record<string, unknown> = {}) {
  return { fileName: args.fileName, model: r.model, decisionId: null, documentNote: r.documentNote ?? null, extractionMs: r.extractionMs, sourceDocumentId: args.documentId, ...extra };
}

/** The default implementation: the modules' own extractors. */
export const runModuleExtractor: ExtractImpl = async (kind, deps, args) => {
  const a = { orgId: args.orgId, userId: args.userId, base64Data: args.base64, mediaType: args.mediaType };
  try {
    switch (kind) {
      case 'lease': {
        const r = await parseLeaseDocument(deps, a);
        if (!r.ok) return failure(r.error, r.budgetBlocked);
        const l = r.lease;
        return {
          ok: true,
          payload: { lease: l, meta: meta(args, r) },
          title: parts(l.lessor ?? 'Lease', l.description),
          summary: parts(l.payment_dollars != null ? `${usd(l.payment_dollars)} ${(l.payment_frequency ?? 'MONTHLY').toLowerCase()}` : null, range(l.commencement_date, l.end_date), l.classification === 'FINANCE' ? 'Finance lease' : 'Operating lease'),
          confidence: avg(l.confidence),
          model: r.model,
          correlationId: r.correlationId,
          feature: 'LEASE_EXTRACT',
        };
      }
      case 'debt_instrument': {
        const r = await parseLoanDocument(deps, a);
        if (!r.ok) return failure(r.error, r.budgetBlocked);
        const l = r.loan;
        return {
          ok: true,
          payload: { loan: l, meta: meta(args, r) },
          title: parts(l.loan_name || 'Loan', l.lender),
          summary: parts(l.principal != null ? `${usd(l.principal)} principal` : null, l.interest_rate != null ? `${l.interest_rate}% ${l.rate_type.toLowerCase()}` : null, l.maturity_date ? `matures ${l.maturity_date}` : null, l.covenants.length ? `${l.covenants.length} covenant${l.covenants.length === 1 ? '' : 's'}` : null),
          confidence: avg(l.confidence),
          model: r.model,
          correlationId: r.correlationId,
          feature: 'DEBT_EXTRACT',
        };
      }
      case 'insurance_policy': {
        const r = await parsePolicyDocument(deps, a);
        if (!r.ok) return failure(r.error, r.budgetBlocked);
        const p = r.policies[0];
        return {
          ok: true,
          payload: { policies: r.policies, meta: meta(args, r, { policyCount: r.policies.length }) },
          title: p ? parts(p.carrier ?? 'Insurance policy', p.coverage_type.replace(/_/g, ' ').toLowerCase()) : 'Insurance policy',
          summary: p ? parts(p.premium_cents != null ? `${usdCents(p.premium_cents)} premium` : null, range(p.effective_date, p.expiration_date), r.policies.length > 1 ? `${r.policies.length} policies` : null) : 'No policy lines found',
          confidence: p ? avg(p.confidence) : null,
          model: r.model,
          correlationId: r.correlationId,
          feature: 'INSURANCE_EXTRACT',
        };
      }
      case 'prepaid': {
        const r = await parsePrepaidDocument(deps, a);
        if (!r.ok) return failure(r.error, r.budgetBlocked);
        const p = r.prepaid;
        return {
          ok: true,
          payload: { prepaid: p, suggestedPrepaidAccount: null, meta: meta(args, r) },
          title: parts(p.vendor_name ?? 'Prepaid expense', p.description),
          summary: parts(p.total_cents != null ? usdCents(p.total_cents) : null, p.term_months ? `${p.term_months} months` : null, range(p.start_date, p.end_date)),
          confidence: avg(p.confidence),
          model: r.model,
          correlationId: r.correlationId,
          feature: 'PREPAID_EXTRACT',
        };
      }
      case 'subscription': {
        const r = await parseAgreementDocument(deps, a);
        if (!r.ok) return failure(r.error, r.budgetBlocked);
        const t = r.terms;
        return {
          ok: true,
          payload: { terms: t, meta: meta(args, r) },
          title: parts(t.vendor_name ?? 'Subscription', t.product),
          summary: parts(t.amount_cents != null ? `${usdCents(t.amount_cents)} ${String(t.billing_cadence).toLowerCase()}` : null, t.next_renewal_date ? `renews ${t.next_renewal_date}` : null, t.auto_renews ? 'auto-renews' : null),
          confidence: avg(t.confidence),
          model: r.model,
          correlationId: r.correlationId,
          feature: 'SUBSCRIPTION_EXTRACT',
        };
      }
      case 'fixed_asset': {
        const r = await parseAssetInvoice(deps, a);
        if (!r.ok) return failure(r.error, r.budgetBlocked);
        const first = r.assets[0];
        const total = r.assets.reduce((s, x) => s + (x.costCents ?? 0), 0);
        return {
          ok: true,
          payload: { assets: r.assets, meta: meta(args, r, { assetCount: r.assets.length }) },
          title: first ? parts(first.name, first.vendorName) : 'Equipment purchase',
          summary: parts(total > 0 ? usdCents(total) : null, `${r.assets.length} asset${r.assets.length === 1 ? '' : 's'}`, first?.proposedClassLabel ?? null),
          confidence: first ? avg(first.confidence) : null,
          model: r.model,
          correlationId: r.correlationId,
          feature: 'ASSET_EXTRACT',
        };
      }
      case 'customer_contract': {
        const r = await parseContractDocument(deps, a);
        if (!r.ok) return failure(r.error, r.budgetBlocked);
        const c = r.contract;
        return {
          ok: true,
          payload: { contract: c, customerMatch: null, meta: meta(args, r) },
          title: parts(c.contract_title ?? 'Customer contract', c.customer.name),
          summary: parts(c.total_contract_value_cents != null ? usdCents(c.total_contract_value_cents) : null, c.billing_kind.toLowerCase().replace('_', '-'), range(c.start_date, c.end_date)),
          confidence: avg(c.confidence),
          model: r.model,
          correlationId: r.correlationId,
          feature: 'CONTRACT_EXTRACT',
        };
      }
    }
  } catch (e) {
    return failure(e instanceof Error ? e.message : String(e));
  }
};

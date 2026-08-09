/**
 * AP document-reading intake queue.
 *
 * Pipeline: uploaded/received document → provider extract → a DRAFT proposal that
 * a human reviews and approves into a bill.
 *
 * WHERE DRAFTS LIVE (no new table): the extracted draft is stored as a row in
 * `public.ai_decisions` (migration 039) with `feature = 'AP_DOC_INTAKE'` and
 * `status = 'PROPOSED'`. This is the canonical "AI proposes FACTS → a human
 * approves" ledger (canon §3): the extraction is a proposal, not a posting.
 * Approving a draft does NOT mutate the GL here — the review UI calls the EXISTING
 * gated `/api/bills/create` (its Zod validation, vendor-compliance holds, approver
 * routing, and GL-on-approval all intact), then this module marks the draft
 * APPROVED and links the created bill. Rejecting sets status REJECTED. Nothing in
 * this file posts a debit/credit or creates a payable.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { formatMoney } from '@meritbooks/shared';
import { logAction } from '@/lib/trust/action-log';
import type { CreateBillInput } from '@/lib/validations/transactions';
import { resolveDocProvider, type ResolveDocProviderOptions } from './resolve';
import type { DocProviderDeps, ExtractedBill } from './types';

/** The feature tag that scopes AP intake drafts within ai_decisions. */
export const AP_DOC_INTAKE_FEATURE = 'AP_DOC_INTAKE';

/** Same fallback account intake.ts uses — 6660 Miscellaneous (OPEX), a seed account. */
const FALLBACK_EXPENSE_ACCOUNT_NUMBER = '6660';

/** Where a draft entered the queue. 'upload' = a human dropped a file; 'email' =
 *  it arrived at the tenant's inbound AP address via the inbound-email webhook. */
export type DocIntakeSource = 'upload' | 'email';

/** Whether the document has been read yet. PENDING_PARSE means it was accepted and
 *  stored but not extracted (AI disabled / parse failed) — a human can process it
 *  now (fields blank) or wait for the machine to read it once AI returns. */
export type DocIntakeParseState = 'PARSED' | 'PENDING_PARSE';

/** Metadata about an inbound (email) intake, surfaced in the queue. */
export interface DocIntakeInbound {
  from: string;
  subject: string | null;
  receivedAt: string;
  /** Provider message id (for de-dup / trace); null when the provider omits it. */
  messageId: string | null;
}

/** The JSON we persist in ai_decisions.proposed_output for a draft. */
export interface DocIntakeProposal {
  extracted: ExtractedBill;
  fileName: string;
  locationId: string;
  /** Best-effort vendor match (exact/fuzzy) so the reviewer can confirm, not retype. */
  suggestedVendorId: string | null;
  suggestedVendorName: string | null;
  vendorMatchConfidence: number | null;
  /** Fallback GL account the reviewer can accept per line (6660 or vendor default). */
  suggestedAccountId: string | null;
  suggestedAccountLabel: string | null;
  /** Non-null when a same-vendor bill with this number/amount already exists. */
  duplicateWarning: string | null;
  /** How this draft entered the queue. Absent (legacy rows) implies 'upload'. */
  source?: DocIntakeSource;
  /** Whether the document was actually read. Absent implies 'PARSED'. */
  parseState?: DocIntakeParseState;
  /** The retained source document (documents bucket) so the reviewer can open the
   *  original invoice — critical when parseState is PENDING_PARSE. */
  sourceDocumentId?: string | null;
  /** Present only for email-sourced drafts. */
  inbound?: DocIntakeInbound | null;
}

/** A draft as returned to the queue UI. */
export interface DocIntakeDraft {
  id: string;
  status: 'PROPOSED' | 'APPROVED' | 'REJECTED' | 'EXPIRED';
  confidence: number | null;
  createdAt: string;
  proposal: DocIntakeProposal;
  dispositionBy: string | null;
  dispositionAt: string | null;
  dispositionNote: string | null;
  postedBillId: string | null;
}

export interface CreateDraftArgs {
  orgId: string;
  userId?: string | null;
  base64: string;
  mediaType: string;
  fileName: string;
  locationId: string;
}

export type CreateDraftResult =
  | { ok: false; error: string; budgetBlocked?: boolean }
  | { ok: true; draftId: string; providerName: string; confidence: number; proposal: DocIntakeProposal };

/** Case-insensitive vendor match (exact on name/display_name, then fuzzy on words). */
async function suggestVendor(
  supabase: SupabaseClient,
  orgId: string,
  vendorName: string,
): Promise<{ id: string; name: string; confidence: number; defaultAccountId: string | null } | null> {
  const name = vendorName.trim();
  if (!name) return null;

  for (const col of ['name', 'display_name'] as const) {
    const { data } = await supabase
      .schema('core')
      .from('vendors')
      .select('id, name, display_name, default_account_id')
      .eq('org_id', orgId)
      .is('deleted_at', null)
      .ilike(col, name)
      .limit(1);
    const row = (data as Array<{ id: string; name: string; display_name: string | null; default_account_id: string | null }> | null)?.[0];
    if (row) return { id: row.id, name: row.display_name ?? row.name, confidence: 1.0, defaultAccountId: row.default_account_id };
  }

  const words = name.split(/\s+/).filter((w) => w.length >= 3);
  for (const word of words) {
    const { data } = await supabase
      .schema('core')
      .from('vendors')
      .select('id, name, display_name, default_account_id')
      .eq('org_id', orgId)
      .is('deleted_at', null)
      .ilike('name', `%${word}%`)
      .limit(1);
    const row = (data as Array<{ id: string; name: string; display_name: string | null; default_account_id: string | null }> | null)?.[0];
    if (row) return { id: row.id, name: row.display_name ?? row.name, confidence: 0.6, defaultAccountId: row.default_account_id };
  }
  return null;
}

/** Resolve an account id + label to suggest (vendor default, else 6660 fallback). */
async function suggestAccount(
  supabase: SupabaseClient,
  orgId: string,
  vendorDefaultAccountId: string | null,
): Promise<{ id: string; label: string } | null> {
  if (vendorDefaultAccountId) {
    const { data } = await supabase
      .from('accounts')
      .select('id, account_number, name')
      .eq('id', vendorDefaultAccountId)
      .maybeSingle();
    const a = data as { id: string; account_number: string; name: string } | null;
    if (a) return { id: a.id, label: `${a.account_number} · ${a.name}` };
  }
  const { data } = await supabase
    .from('accounts')
    .select('id, account_number, name')
    .eq('org_id', orgId)
    .eq('account_number', FALLBACK_EXPENSE_ACCOUNT_NUMBER)
    .eq('is_active', true)
    .limit(1);
  const a = (data as Array<{ id: string; account_number: string; name: string }> | null)?.[0];
  return a ? { id: a.id, label: `${a.account_number} · ${a.name}` } : null;
}

/** Duplicate check: same vendor + same bill number, or same vendor + amount + date. */
async function detectDuplicate(
  supabase: SupabaseClient,
  vendorId: string | null,
  extracted: ExtractedBill,
): Promise<string | null> {
  if (!vendorId) return null;

  if (extracted.invoiceNumber) {
    const { data } = await supabase
      .from('bills')
      .select('id, bill_number, total_cents, bill_date')
      .eq('vendor_id', vendorId)
      .eq('bill_number', extracted.invoiceNumber)
      .limit(1);
    const dupe = (data as Array<{ bill_number: string; total_cents: number; bill_date: string }> | null)?.[0];
    if (dupe) {
      return `Possible duplicate: bill #${dupe.bill_number} from this vendor already exists (${dupe.bill_date}, ${formatMoney(dupe.total_cents)}).`;
    }
  }

  if (extracted.totalCents > 0 && extracted.invoiceDate) {
    const { data } = await supabase
      .from('bills')
      .select('id')
      .eq('vendor_id', vendorId)
      .eq('total_cents', extracted.totalCents)
      .eq('bill_date', extracted.invoiceDate)
      .limit(1);
    if ((data as unknown[] | null)?.length) {
      return 'Possible duplicate: a bill from this vendor for the same amount on the same date already exists.';
    }
  }
  return null;
}

/** Clamp a confidence-ish number into [0,1]; NaN → 0. */
function clamp01(n: number): number {
  if (!Number.isFinite(n) || n < 0) return 0;
  return n > 1 ? 1 : n;
}

/**
 * Extract a document and persist a PROPOSED draft in ai_decisions. Never posts.
 */
export async function createDocIntakeDraft(
  supabase: SupabaseClient,
  deps: DocProviderDeps,
  args: CreateDraftArgs,
  options: ResolveDocProviderOptions = {},
): Promise<CreateDraftResult> {
  const provider = resolveDocProvider(deps, options);

  const result = await provider.extractBill({
    base64: args.base64,
    mediaType: args.mediaType,
    fileName: args.fileName,
    orgId: args.orgId,
    userId: args.userId ?? null,
  });

  if (!result.ok) {
    return { ok: false, error: result.error, budgetBlocked: result.budgetBlocked };
  }
  const extracted = result.bill;

  if (!extracted.vendorName.trim()) {
    return { ok: false, error: 'Could not read a vendor name from the document.' };
  }

  const vendorMatch = await suggestVendor(supabase, args.orgId, extracted.vendorName);
  const account = await suggestAccount(supabase, args.orgId, vendorMatch?.defaultAccountId ?? null);
  const duplicateWarning = await detectDuplicate(supabase, vendorMatch?.id ?? null, extracted);

  const proposal: DocIntakeProposal = {
    extracted,
    fileName: args.fileName,
    locationId: args.locationId,
    suggestedVendorId: vendorMatch?.id ?? null,
    suggestedVendorName: vendorMatch?.name ?? null,
    vendorMatchConfidence: vendorMatch?.confidence ?? null,
    suggestedAccountId: account?.id ?? null,
    suggestedAccountLabel: account?.label ?? null,
    duplicateWarning,
  };

  const confidence = clamp01(extracted.totalConfidence);

  const { data: inserted, error } = await supabase
    .from('ai_decisions')
    .insert({
      org_id: args.orgId,
      location_id: args.locationId,
      feature: AP_DOC_INTAKE_FEATURE,
      model_used: extracted.engineVersion,
      input_summary: `AP intake: ${args.fileName}`,
      proposed_output: proposal,
      confidence,
      reasoning: extracted.notes || null,
      status: 'PROPOSED',
      created_by_user: args.userId ?? null,
    })
    .select('id')
    .single();

  if (error || !inserted) {
    return { ok: false, error: error?.message ?? 'Failed to save intake draft' };
  }
  const draftId = (inserted as { id: string }).id;

  await logAction(supabase, {
    orgId: args.orgId,
    actorType: 'AI',
    action: 'ap.doc.extracted',
    subjectTable: 'ai_decisions',
    subjectId: draftId,
    summary: `Extracted draft bill from ${extracted.vendorName} for ${formatMoney(extracted.totalCents)} via ${provider.name}`,
    confidence,
    metadata: {
      provider: provider.name,
      fileName: args.fileName,
      vendorMatched: Boolean(vendorMatch),
      duplicate: Boolean(duplicateWarning),
    },
  });

  return { ok: true, draftId, providerName: provider.name, confidence, proposal };
}

/**
 * A minimal, honest placeholder for an unread document. Zeroed amounts and empty
 * fields (NOT invented values) so the reviewer starts from a blank, trustworthy
 * form — the source PDF is attached for them to read from. `notes` records why it
 * wasn't machine-read.
 */
function pendingExtractedBill(reason: string): ExtractedBill {
  return {
    vendorName: '',
    vendorNameConfidence: 0,
    invoiceNumber: null,
    invoiceNumberConfidence: 0,
    invoiceDate: null,
    invoiceDateConfidence: 0,
    dueDate: null,
    dueDateConfidence: 0,
    subtotalCents: 0,
    taxCents: 0,
    totalCents: 0,
    totalConfidence: 0,
    currency: 'USD',
    lines: [],
    notes: reason,
    providerName: 'pending',
    engineVersion: 'pending',
    extractionMs: 0,
  };
}

export interface CreateInboundDraftArgs extends CreateDraftArgs {
  /** The retained source document id (documents bucket). */
  sourceDocumentId: string | null;
  /** Inbound-email envelope metadata to surface in the queue. */
  inbound: DocIntakeInbound;
}

export type CreateInboundDraftResult =
  | { ok: false; error: string }
  | {
      ok: true;
      draftId: string;
      parseState: DocIntakeParseState;
      providerName: string;
      confidence: number;
    };

/**
 * INBOUND (email-to-bill) intake — DEGRADE-SAFE.
 *
 * Lands a PROPOSED draft in the SAME queue as an upload, but NEVER drops the
 * document when the read fails. If `deps` is provided (an Anthropic key is
 * available) we try to extract; on ANY failure — no key, budget block, unreadable
 * doc, no vendor name — we still persist a PENDING_PARSE draft carrying the source
 * document + envelope, so a human can process it now or the machine can re-read it
 * once AI returns. Only a genuine DB insert failure returns `ok: false`.
 *
 * NOTE: writes through the caller's client (the webhook uses the admin client
 * because there is no session), but every row is org_id-stamped and feature-tagged.
 */
export async function createInboundIntakeDraft(
  supabase: SupabaseClient,
  deps: DocProviderDeps | null,
  args: CreateInboundDraftArgs,
  options: ResolveDocProviderOptions = {},
): Promise<CreateInboundDraftResult> {
  let extracted: ExtractedBill | null = null;
  let parseState: DocIntakeParseState = 'PENDING_PARSE';
  let providerName = 'pending';
  let pendingReason = 'Awaiting AI parse — the machine could not read this document yet.';

  if (deps && deps.anthropicApiKey) {
    try {
      const provider = resolveDocProvider(deps, options);
      const result = await provider.extractBill({
        base64: args.base64,
        mediaType: args.mediaType,
        fileName: args.fileName,
        orgId: args.orgId,
        userId: args.userId ?? null,
      });
      if (result.ok && result.bill.vendorName.trim()) {
        extracted = result.bill;
        parseState = 'PARSED';
        providerName = provider.name;
      } else if (result.ok) {
        pendingReason = 'Read the document but could not identify a vendor — needs a human.';
      } else {
        pendingReason = result.budgetBlocked
          ? 'AI budget/entitlement blocked the read — held for a human or a later retry.'
          : `Could not read the document (${result.error}). Held for a human or a later retry.`;
      }
    } catch (e) {
      pendingReason = `Extraction error (${e instanceof Error ? e.message : 'unknown'}). Held for a human or a later retry.`;
    }
  } else {
    pendingReason = 'AI is not configured — document received and stored for a human to process.';
  }

  const bill = extracted ?? pendingExtractedBill(pendingReason);

  // Best-effort enrichment (only meaningful when we actually parsed a vendor).
  const vendorMatch = extracted ? await suggestVendor(supabase, args.orgId, extracted.vendorName) : null;
  const account = await suggestAccount(supabase, args.orgId, vendorMatch?.defaultAccountId ?? null);
  const duplicateWarning = extracted ? await detectDuplicate(supabase, vendorMatch?.id ?? null, extracted) : null;

  const proposal: DocIntakeProposal = {
    extracted: bill,
    fileName: args.fileName,
    locationId: args.locationId,
    suggestedVendorId: vendorMatch?.id ?? null,
    suggestedVendorName: vendorMatch?.name ?? null,
    vendorMatchConfidence: vendorMatch?.confidence ?? null,
    suggestedAccountId: account?.id ?? null,
    suggestedAccountLabel: account?.label ?? null,
    duplicateWarning,
    source: 'email',
    parseState,
    sourceDocumentId: args.sourceDocumentId,
    inbound: args.inbound,
  };

  const confidence = clamp01(bill.totalConfidence);

  const { data: inserted, error } = await supabase
    .from('ai_decisions')
    .insert({
      org_id: args.orgId,
      location_id: args.locationId || null,
      feature: AP_DOC_INTAKE_FEATURE,
      model_used: bill.engineVersion,
      input_summary: `AP intake (email from ${args.inbound.from}): ${args.fileName}`,
      proposed_output: proposal,
      confidence,
      reasoning: bill.notes || null,
      status: 'PROPOSED',
      created_by_user: args.userId ?? null,
    })
    .select('id')
    .single();

  if (error || !inserted) {
    return { ok: false, error: error?.message ?? 'Failed to save inbound intake draft' };
  }
  const draftId = (inserted as { id: string }).id;

  await logAction(supabase, {
    orgId: args.orgId,
    locationId: args.locationId || undefined,
    actorType: 'AI',
    action: parseState === 'PARSED' ? 'ap.doc.extracted' : 'ap.doc.received',
    subjectTable: 'ai_decisions',
    subjectId: draftId,
    summary:
      parseState === 'PARSED'
        ? `Email invoice from ${bill.vendorName} extracted for ${formatMoney(bill.totalCents)}`
        : `Email invoice received from ${args.inbound.from} — stored pending AI parse (${args.fileName})`,
    confidence,
    metadata: {
      source: 'email',
      parseState,
      provider: providerName,
      fileName: args.fileName,
      inboundFrom: args.inbound.from,
      sourceDocumentId: args.sourceDocumentId,
    },
  });

  return { ok: true, draftId, parseState, providerName, confidence };
}

/** Map an ai_decisions row into a DocIntakeDraft. */
function rowToDraft(row: {
  id: string;
  status: string;
  confidence: number | null;
  created_at: string;
  proposed_output: unknown;
  disposition_by_user: string | null;
  disposition_at: string | null;
  disposition_note: string | null;
  posted_gl_entry_id: string | null;
  posted_bill_id?: string | null;
}): DocIntakeDraft {
  const proposal = row.proposed_output as DocIntakeProposal;
  return {
    id: row.id,
    status: row.status as DocIntakeDraft['status'],
    confidence: row.confidence,
    createdAt: row.created_at,
    proposal,
    dispositionBy: row.disposition_by_user,
    dispositionAt: row.disposition_at,
    dispositionNote: row.disposition_note,
    // The created bill id is stashed in the disposition note payload (see disposeDraft).
    postedBillId: (proposal as unknown as { postedBillId?: string })?.postedBillId ?? null,
  };
}

/** List drafts for the queue. Defaults to PROPOSED (the review inbox). */
export async function listDocIntakeDrafts(
  supabase: SupabaseClient,
  orgId: string,
  status: 'PROPOSED' | 'APPROVED' | 'REJECTED' | 'ALL' = 'PROPOSED',
): Promise<DocIntakeDraft[]> {
  let q = supabase
    .from('ai_decisions')
    .select(
      'id, status, confidence, created_at, proposed_output, disposition_by_user, disposition_at, disposition_note, posted_gl_entry_id',
    )
    .eq('org_id', orgId)
    .eq('feature', AP_DOC_INTAKE_FEATURE)
    .order('created_at', { ascending: false })
    .limit(200);

  if (status !== 'ALL') q = q.eq('status', status);

  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data as Parameters<typeof rowToDraft>[0][] | null ?? []).map(rowToDraft);
}

/** Fetch one draft by id (org-scoped via RLS). */
export async function getDocIntakeDraft(
  supabase: SupabaseClient,
  orgId: string,
  id: string,
): Promise<DocIntakeDraft | null> {
  const { data, error } = await supabase
    .from('ai_decisions')
    .select(
      'id, status, confidence, created_at, proposed_output, disposition_by_user, disposition_at, disposition_note, posted_gl_entry_id',
    )
    .eq('org_id', orgId)
    .eq('feature', AP_DOC_INTAKE_FEATURE)
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  return rowToDraft(data as Parameters<typeof rowToDraft>[0]);
}

export type DisposeAction =
  | { action: 'approve'; billId: string; userId?: string | null }
  | { action: 'reject'; note?: string | null; userId?: string | null };

/**
 * Transition a PROPOSED draft. `approve` records the bill the caller already
 * created via the gated `/api/bills/create`; `reject` closes it out. Only a
 * PROPOSED draft can be disposed.
 */
export async function disposeDocIntakeDraft(
  supabase: SupabaseClient,
  orgId: string,
  id: string,
  disposition: DisposeAction,
): Promise<{ ok: false; error: string } | { ok: true; status: 'APPROVED' | 'REJECTED' }> {
  const draft = await getDocIntakeDraft(supabase, orgId, id);
  if (!draft) return { ok: false, error: 'Draft not found' };
  if (draft.status !== 'PROPOSED') {
    return { ok: false, error: `Draft is ${draft.status}; only PROPOSED drafts can be dispositioned.` };
  }

  const isApprove = disposition.action === 'approve';
  const newStatus: 'APPROVED' | 'REJECTED' = isApprove ? 'APPROVED' : 'REJECTED';

  // Stash the created bill id inside proposed_output (no schema column for it here).
  const nextProposal = isApprove
    ? { ...draft.proposal, postedBillId: disposition.billId }
    : draft.proposal;

  const { error } = await supabase
    .from('ai_decisions')
    .update({
      status: newStatus,
      proposed_output: nextProposal,
      disposition_by_user: disposition.userId ?? null,
      disposition_at: new Date().toISOString(),
      disposition_note: isApprove
        ? `Approved into bill ${disposition.billId}`
        : disposition.note ?? 'Rejected',
    })
    .eq('org_id', orgId)
    .eq('feature', AP_DOC_INTAKE_FEATURE)
    .eq('id', id)
    .eq('status', 'PROPOSED');

  if (error) return { ok: false, error: error.message };

  await logAction(supabase, {
    orgId,
    actorType: 'HUMAN',
    action: isApprove ? 'ap.doc.approved' : 'ap.doc.rejected',
    subjectTable: 'ai_decisions',
    subjectId: id,
    summary: isApprove
      ? `Approved extracted draft into bill ${disposition.billId}`
      : `Rejected extracted draft`,
    metadata: isApprove ? { billId: disposition.billId } : {},
  });

  return { ok: true, status: newStatus };
}

/** Per-line GL account resolution for assembly (index-aligned overrides + a default). */
export interface DraftResolution {
  vendorId: string;
  locationId: string;
  /** Applied to any line without a specific account. */
  defaultAccountId: string;
  /** Optional per-line account overrides, index-aligned to the extracted lines. */
  lineAccountIds?: Array<string | null>;
  /** Override the extracted tax if the reviewer corrected it. */
  taxCentsOverride?: number;
  retainagePct?: number;
}

/** Today as YYYY-MM-DD (UTC). */
function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Add days to a YYYY-MM-DD string, UTC-safe. */
function addDaysISO(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map((p) => parseInt(p, 10));
  const base = Date.UTC(y, (m || 1) - 1, d || 1);
  return new Date(base + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * DRAFT ASSEMBLY (pure, unit-tested): turn an ExtractedBill + the reviewer's
 * resolutions into a body that satisfies `createBillSchema`. When the extraction
 * has no distinct lines, one line is synthesized for the total so the payload is
 * always valid (createBillSchema requires >= 1 line).
 */
export function assembleCreateBillPayload(
  extracted: ExtractedBill,
  resolution: DraftResolution,
): CreateBillInput {
  const billDate = extracted.invoiceDate ?? todayISO();
  const dueDate = extracted.dueDate ?? addDaysISO(billDate, 30);

  const sourceLines =
    extracted.lines.length > 0
      ? extracted.lines
      : [
          {
            description: extracted.invoiceNumber ? `Invoice ${extracted.invoiceNumber}` : 'Invoice total',
            quantity: 1,
            unitCostCents: extracted.totalCents,
            amountCents: extracted.totalCents,
            categoryHint: null,
            confidence: extracted.totalConfidence,
          },
        ];

  const lines = sourceLines.map((line, i) => ({
    description: line.description || undefined,
    account_id: resolution.lineAccountIds?.[i] ?? resolution.defaultAccountId,
    quantity: line.quantity > 0 ? line.quantity : 1,
    unit_cost_cents: Math.max(0, Math.round(line.unitCostCents)),
    amount_cents: Math.round(line.amountCents),
  }));

  return {
    location_id: resolution.locationId,
    vendor_id: resolution.vendorId,
    bill_number: extracted.invoiceNumber ?? undefined,
    bill_date: billDate,
    due_date: dueDate,
    lines,
    tax_cents: resolution.taxCentsOverride ?? Math.max(0, Math.round(extracted.taxCents)),
    retainage_pct: resolution.retainagePct ?? 0,
  };
}

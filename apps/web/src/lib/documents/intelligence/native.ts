/**
 * Document intelligence — NATIVE routes: modules that already have their own staging
 * queue get the draft there (FPB §5), and the proposal only tracks it.
 *
 *   bill        → AP intake queue draft (`ai_decisions` feature AP_DOC_INTAKE, PROPOSED)
 *                 via `createDocIntakeDraft` — the queue's own approve creates the bill
 *                 through the gated /api/bills/create (vendor holds, approvals, GL on
 *                 approval all unchanged).
 *   vendor_coi  → `vendor_document_submissions` (staff_upload) via `recordSubmission`,
 *   vendor_w9     then `runAiCheck` (W-9 images are NOT sent to AI — decision D6).
 *
 * Nothing here posts or creates a payable. Never throws for expected failures.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { isAiUnavailableError } from '@/lib/ai/gateway';
import { serviceWriter } from '@/lib/db/scoped-writer';
import { AP_DOC_INTAKE_FEATURE, createDocIntakeDraft } from '@/lib/ap/doc-intelligence/intake-queue';
import { OPEN_SUBMISSION, recordSubmission, runAiCheck } from '@/lib/vendor-compliance/review';

export type NativeOutcome =
  | { ok: true; nativeTable: 'ai_decisions' | 'vendor_document_submissions'; nativeId: string; title: string; summary: string; confidence: number | null; extracted: boolean }
  | { ok: false; kind: 'unavailable' | 'budget_blocked' | 'failed' | 'needs_input'; error: string };

export interface NativeImpl {
  createBillDraft(
    db: SupabaseClient,
    args: { orgId: string; userId: string | null; base64: string; mediaType: string; fileName: string; locationId: string; documentId: string; anthropicApiKey: string | null },
  ): Promise<NativeOutcome>;
  createVendorSubmission(
    db: SupabaseClient,
    args: { orgId: string; userId: string | null; vendorId: string; docKind: 'W9' | 'COI'; documentId: string; base64: string | null; mediaType: string; anthropicApiKey: string | null },
  ): Promise<NativeOutcome>;
}

const usdCents = (c: number): string => `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const defaultNative: NativeImpl = {
  async createBillDraft(db, args) {
    if (!args.anthropicApiKey) return { ok: false, kind: 'unavailable', error: 'AI is not configured.' };
    try {
      const r = await createDocIntakeDraft(
        db,
        { supabase: db, anthropicApiKey: args.anthropicApiKey },
        { orgId: args.orgId, userId: args.userId, base64: args.base64, mediaType: args.mediaType, fileName: args.fileName, locationId: args.locationId },
      );
      if (!r.ok) {
        if (r.budgetBlocked) return { ok: false, kind: 'budget_blocked', error: r.error };
        return { ok: false, kind: isAiUnavailableError(r.error) ? 'unavailable' : 'failed', error: r.error };
      }
      // The queue opens the original from proposal.sourceDocumentId; tag it as an upload.
      await serviceWriter(db)
        .from('ai_decisions')
        .update({ proposed_output: { ...r.proposal, source: 'upload', parseState: 'PARSED', sourceDocumentId: args.documentId } })
        .eq('org_id', args.orgId)
        .eq('id', r.draftId)
        .eq('feature', AP_DOC_INTAKE_FEATURE);
      const b = r.proposal.extracted;
      return {
        ok: true,
        nativeTable: 'ai_decisions',
        nativeId: r.draftId,
        title: b.vendorName || 'Vendor bill',
        summary: [b.totalCents ? usdCents(b.totalCents) : null, b.invoiceNumber ? `#${b.invoiceNumber}` : null, b.dueDate ? `due ${b.dueDate}` : null, r.proposal.duplicateWarning].filter(Boolean).join(' · '),
        confidence: r.confidence,
        extracted: true,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, kind: isAiUnavailableError(msg) ? 'unavailable' : 'failed', error: msg };
    }
  },

  async createVendorSubmission(db, args) {
    try {
      // recordSubmission supersedes every open submission of the kind. Never let a stored
      // document knock out what the VENDOR sent (portal upload / W-9 form) or a person
      // lodged by hand — only drafts this feature lodged itself (security review M).
      const foreign = await genuineOpenSubmission(db, args.orgId, args.vendorId, args.docKind);
      if (foreign) {
        const label = args.docKind === 'W9' ? 'W-9' : 'certificate of insurance';
        return { ok: false, kind: 'needs_input', error: `This vendor already has a ${label} waiting for review in Vendor compliance — review that one first.` };
      }
      const sub = await recordSubmission(db, {
        orgId: args.orgId,
        vendorId: args.vendorId,
        docKind: args.docKind,
        source: 'staff_upload',
        documentId: args.documentId,
        actor: args.userId ?? 'system:document-intelligence',
      });
      let checked = sub;
      if (args.docKind === 'COI' && args.base64) {
        checked = await runAiCheck(db, sub, { base64: args.base64, mediaType: args.mediaType }, { anthropicApiKey: args.anthropicApiKey });
      }
      const label = args.docKind === 'W9' ? 'W-9' : 'Certificate of insurance';
      return {
        ok: true,
        nativeTable: 'vendor_document_submissions',
        nativeId: sub.id,
        title: label,
        summary: checked.ai_note ?? `${label} waiting for review in Vendor compliance.`,
        confidence: null,
        extracted: checked.ai_status === 'done',
      };
    } catch (e) {
      return { ok: false, kind: 'failed', error: e instanceof Error ? e.message : String(e) };
    }
  },
};

/**
 * An open (received / ai_checked) submission for the vendor + kind that document
 * intelligence did NOT lodge — i.e. no document_proposals row points at it. Org-pinned.
 */
export async function genuineOpenSubmission(db: SupabaseClient, orgId: string, vendorId: string, docKind: 'W9' | 'COI'): Promise<string | null> {
  const { data, error } = await db
    .from('vendor_document_submissions')
    .select('id')
    .eq('org_id', orgId)
    .eq('vendor_id', vendorId)
    .eq('doc_kind', docKind)
    .in('status', OPEN_SUBMISSION);
  if (error) throw new Error(`Could not check the vendor's open submissions: ${error.message}`);
  const open = ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
  if (open.length === 0) return null;
  const { data: ours, error: e2 } = await db
    .from('document_proposals')
    .select('native_id')
    .eq('org_id', orgId)
    .eq('native_table', 'vendor_document_submissions')
    .in('native_id', open);
  if (e2) throw new Error(`Could not check the vendor's open submissions: ${e2.message}`);
  const mine = new Set(((ours ?? []) as Array<{ native_id: string | null }>).map((r) => r.native_id));
  return open.find((id) => !mine.has(id)) ?? null;
}

/** Best-effort vendor match on a counterparty name (exact, then a distinctive word). */
export async function matchVendor(db: SupabaseClient, orgId: string, name: string | null): Promise<{ id: string; name: string } | null> {
  const n = (name ?? '').trim();
  if (n.length < 3) return null;
  for (const col of ['name', 'display_name'] as const) {
    const { data } = await db.schema('core').from('vendors').select('id, name, display_name').eq('org_id', orgId).is('deleted_at', null).ilike(col, n).limit(1);
    const row = (data as Array<{ id: string; name: string; display_name: string | null }> | null)?.[0];
    if (row) return { id: row.id, name: row.display_name ?? row.name };
  }
  const STOP = new Set(['inc', 'llc', 'corp', 'company', 'the', 'and', 'services', 'group', 'insurance']);
  const words = n.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length >= 4 && !STOP.has(w));
  for (const w of words.slice(0, 3)) {
    const { data } = await db.schema('core').from('vendors').select('id, name, display_name').eq('org_id', orgId).is('deleted_at', null).ilike('name', `%${w}%`).limit(2);
    const rows = (data as Array<{ id: string; name: string; display_name: string | null }> | null) ?? [];
    if (rows.length === 1) return { id: rows[0].id, name: rows[0].display_name ?? rows[0].name };
  }
  return null;
}

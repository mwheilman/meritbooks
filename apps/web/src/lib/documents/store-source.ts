/**
 * store-source — retain the SOURCE DOCUMENT of a drop-and-parse upload.
 *
 * The drop-and-parse flows (covenants, leases, AP bill intake, bank-statement import,
 * W-9/COI, insurance, debt, prepaid, payroll register, capex invoice…) historically
 * decoded the uploaded file in-request and THREW IT AWAY once the AI had proposed its
 * facts. This helper closes that gap: it persists the file to the private `documents`
 * bucket (migration 090 + 112) and records the metadata row, returning a handle the
 * caller surfaces to the client and later LINKS to the record the upload produced.
 *
 * TWO HARD GUARANTEES the callers depend on:
 *   1. Retention is INDEPENDENT of the AI parse. Call `storeSourceDocument` BEFORE the
 *      Anthropic-key check / extraction. Even with AI disabled (no key) or a parse
 *      failure, the file lands in the Documents center so the source is never lost.
 *   2. Retention NEVER breaks the primary flow. Every function here is best-effort and
 *      returns null / false on failure (logging), rather than throwing into a route
 *      whose job is to parse a document — a storage hiccup must not 500 the upload.
 *
 * Object I/O uses the service role (via uploadDocument); the metadata row is written
 * through the caller's RLS-scoped client, so the DATABASE enforces tenant isolation.
 * Org isolation: every object key is namespaced by orgId (buildStoragePath) and every
 * row is org_id-stamped + RLS-filtered. There is no location column on `documents`;
 * location/company scoping is carried by the LINKED record (entity_type, entity_id).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { uploadDocument } from './store';
import { inferDocType, type DocType } from './schema';

export interface StoreSourceArgs {
  /** RLS-scoped client (ctx.supabase) — writes the metadata row as the caller. */
  supabase: SupabaseClient;
  orgId: string;
  userId: string | null;
  /** Provide EITHER a File (from formData) OR base64 + fileName + mimeType. */
  file?: File | null;
  base64?: string | null;
  fileName?: string | null;
  mimeType?: string | null;
  /** Coarse retention bucket; inferred from the filename/mime when omitted. */
  docType?: DocType;
  /**
   * The kind of record this document supports (e.g. 'covenant', 'lease', 'bill',
   * 'bank_account'). Matches the AttachmentsPanel `entityType` on the record page.
   */
  entityType?: string | null;
  /** The record's id when it already exists (immediate link); null → unfiled. */
  entityId?: string | null;
  notes?: string | null;
}

export interface StoredSource {
  documentId: string;
  storagePath: string;
  fileName: string;
}

/** Build a File from base64 so we can reuse the single uploadDocument I/O path. */
function base64ToFile(base64: string, fileName: string, mimeType: string): File {
  const buffer = Buffer.from(base64, 'base64');
  // Buffer is a Uint8Array — a valid BlobPart. Node 18+/Next runtime has global File.
  return new File([buffer], fileName, { type: mimeType });
}

/**
 * Persist the uploaded source file and its metadata row. Best-effort: returns a handle
 * on success, or null (logged) on any failure — the caller keeps parsing regardless.
 * When `entityId` is provided the document is linked to that record immediately;
 * otherwise it is retained UNFILED (but tagged with `entityType`/`docType`) and can be
 * linked later via `linkSourceDocument` once the record is created.
 */
export async function storeSourceDocument(args: StoreSourceArgs): Promise<StoredSource | null> {
  try {
    let file = args.file ?? null;
    if (!file && typeof args.base64 === 'string' && args.base64.length > 0) {
      file = base64ToFile(
        args.base64,
        args.fileName?.trim() || 'document',
        args.mimeType?.trim() || 'application/octet-stream',
      );
    }
    if (!file) return null;

    const docType: DocType = args.docType ?? inferDocType(file.name, file.type || null);

    const { document } = await uploadDocument({
      supabase: args.supabase,
      orgId: args.orgId,
      userId: args.userId,
      file,
      docType,
      entityType: args.entityType ?? null,
      entityId: args.entityId ?? null,
      notes: args.notes ?? null,
    });

    return {
      documentId: document.id,
      storagePath: document.storage_path,
      fileName: document.file_name,
    };
  } catch (e) {
    console.error('[store-source] retention failed (non-fatal):', e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * Link a previously-retained (unfiled) source document to the record it produced, so it
 * surfaces in that record's Documents/Attachments panel. Called on the confirm/create
 * path once the record's id is known. Best-effort + RLS-scoped: a wrong-tenant or unknown
 * documentId updates nothing and returns false; it never throws into the create flow.
 *
 * `entityType` should match the record page's AttachmentsPanel entityType
 * (e.g. 'covenant', 'lease', 'bill').
 */
export async function linkSourceDocument(
  supabase: SupabaseClient,
  documentId: string | null | undefined,
  entityType: string,
  entityId: string,
): Promise<boolean> {
  if (!documentId) return false;
  try {
    const { data, error } = await supabase
      .from('documents')
      .update({ entity_type: entityType, entity_id: entityId })
      .eq('id', documentId)
      .select('id')
      .maybeSingle();
    if (error) {
      console.error('[store-source] link failed (non-fatal):', error.message);
      return false;
    }
    return !!data;
  } catch (e) {
    console.error('[store-source] link threw (non-fatal):', e instanceof Error ? e.message : e);
    return false;
  }
}

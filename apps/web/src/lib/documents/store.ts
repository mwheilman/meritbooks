/**
 * Document store — the I/O layer for the Document Management Center (migration 090).
 *
 * File BYTES live in the private Supabase Storage bucket `documents`; the METADATA
 * ROW lives in `public.documents` and is org-isolated by RLS. Two clients are used,
 * matching the existing `branding` upload pattern (see settings/invoice-branding/logo):
 *
 *   • metadata (rls) — an RLS-scoped user client (from ctx.supabase) writes/reads the
 *     `documents` rows, so the DATABASE guarantees tenant isolation (not this code).
 *   • storage (admin) — the service-role client performs bucket object ops, because
 *     the bucket's object policies are a separate surface not configured for the
 *     authenticated role. Every object key is namespaced by orgId, and every
 *     sign/delete first re-fetches the row through the RLS client, so a caller can
 *     only ever touch objects for a row THEY can see.
 *
 * Degrades safe: if the bucket does not exist yet, uploads fail cleanly with the
 * Storage error surfaced to the route; reads simply return empty.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminSupabase } from '@/lib/supabase/server';
import { resolvePageParams } from '@/lib/pagination';
import {
  DOCUMENT_SELECT,
  buildStoragePath,
  shapeDocumentRow,
  type DocType,
  type DocumentRow,
} from './schema';

export const DOCUMENTS_BUCKET = 'documents';

export interface UploadArgs {
  /** RLS-scoped client (ctx.supabase) — writes the metadata row as the user. */
  supabase: SupabaseClient;
  orgId: string;
  userId: string | null;
  file: File;
  docType: DocType;
  entityType?: string | null;
  entityId?: string | null;
  notes?: string | null;
}

export interface UploadResult {
  document: DocumentRow;
}

/**
 * Upload a file to the `documents` bucket and record its metadata row. The row is
 * the durable, linkable record; the object is the bytes. If the metadata insert
 * fails after the object lands, the orphaned object is best-effort removed so we
 * don't leak storage.
 */
export async function uploadDocument(args: UploadArgs): Promise<UploadResult> {
  const { supabase, orgId, userId, file, docType, entityType, entityId, notes } = args;
  const admin = createAdminSupabase();

  // Deterministic, org-namespaced, collision-free key.
  const id = crypto.randomUUID();
  const storagePath = buildStoragePath(orgId, entityType, file.name, id);
  const bytes = new Uint8Array(await file.arrayBuffer());

  const { error: upErr } = await admin.storage
    .from(DOCUMENTS_BUCKET)
    .upload(storagePath, bytes, {
      contentType: file.type || 'application/octet-stream',
      upsert: false,
    });
  if (upErr) {
    throw new Error(`Storage upload failed: ${upErr.message}`);
  }

  const row = shapeDocumentRow({
    orgId,
    storagePath,
    fileName: file.name,
    mimeType: file.type || null,
    sizeBytes: file.size,
    docType,
    entityType: entityType ?? null,
    entityId: entityId ?? null,
    uploadedByUser: userId ?? null,
    notes: notes ?? null,
  });

  const { data, error } = await supabase
    .from('documents')
    .insert(row)
    .select(DOCUMENT_SELECT)
    .single();

  if (error || !data) {
    // Roll back the orphaned object so a failed insert doesn't leak storage.
    await admin.storage.from(DOCUMENTS_BUCKET).remove([storagePath]).catch(() => {});
    throw new Error(`Failed to record document: ${error?.message ?? 'unknown error'}`);
  }

  return { document: data as unknown as DocumentRow };
}

export interface ListArgs {
  supabase: SupabaseClient;
  entityType?: string | null;
  entityId?: string | null;
  docType?: DocType | null;
  search?: string | null;
  /** 'unfiled' → only rows not linked to a record; 'linked' → only linked; else all. */
  linked?: 'all' | 'linked' | 'unfiled' | null;
  /** Inclusive created_at lower/upper bounds (YYYY-MM-DD or ISO). */
  dateFrom?: string | null;
  dateTo?: string | null;
  /** Raw 1-based page number (string, from the query). Defaults to page 1. */
  page?: string | null;
  /** Raw rows-per-page (string, from the query). Hard-capped to MAX_PAGE_SIZE. */
  perPage?: string | null;
}

export interface ListDocumentsResult {
  documents: DocumentRow[];
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
}

/**
 * List documents (RLS-scoped — only the caller's org), newest first. Optionally filter
 * to a single record's attachments (entityType [+ entityId]), to a doc_type, a filename
 * search, a link state (linked / unfiled), and/or a created_at date range.
 *
 * SERVER-SIDE PAGINATED + HARD-CAPPED: the center is a ledger-scale list (every retained
 * source file + attachment), so this never returns an unbounded row set. `count: 'exact'`
 * gives the client a real total so it can page.
 */
export async function listDocuments(args: ListArgs): Promise<ListDocumentsResult> {
  const { supabase, entityType, entityId, docType, search, linked, dateFrom, dateTo } = args;
  const { page, perPage, rangeFrom, rangeTo } = resolvePageParams({
    page: args.page ?? null,
    per_page: args.perPage ?? null,
  });

  let q = supabase
    .from('documents')
    .select(DOCUMENT_SELECT, { count: 'exact' })
    .order('created_at', { ascending: false });

  if (entityType) q = q.eq('entity_type', entityType);
  if (entityId) q = q.eq('entity_id', entityId);
  if (docType) q = q.eq('doc_type', docType);
  if (search && search.trim()) q = q.ilike('file_name', `%${search.trim()}%`);
  if (linked === 'unfiled') q = q.is('entity_type', null);
  else if (linked === 'linked') q = q.not('entity_type', 'is', null);
  if (dateFrom && dateFrom.trim()) q = q.gte('created_at', dateFrom.trim());
  if (dateTo && dateTo.trim()) q = q.lte('created_at', dateTo.trim());

  const { data, error, count } = await q.range(rangeFrom, rangeTo);
  if (error) throw new Error(`Failed to list documents: ${error.message}`);
  const total = count ?? 0;
  return {
    documents: (data ?? []) as unknown as DocumentRow[],
    page,
    perPage,
    total,
    totalPages: Math.max(1, Math.ceil(total / perPage)),
  };
}

/**
 * Create a short-lived signed URL for a document. Ownership is enforced by first
 * re-fetching the row through the RLS client — a caller who can't SELECT the row
 * (wrong tenant) gets NOT_FOUND and never reaches the object.
 */
export async function getSignedUrl(
  supabase: SupabaseClient,
  documentId: string,
  expiresIn = 300,
  opts?: { download?: boolean },
): Promise<{ url: string; fileName: string } | null> {
  const { data: row, error } = await supabase
    .from('documents')
    .select('storage_path, file_name')
    .eq('id', documentId)
    .maybeSingle();
  if (error) throw new Error(`Lookup failed: ${error.message}`);
  if (!row) return null;

  const fileName = (row as { file_name: string }).file_name;
  // download !== false → force a download (attachment) with the original filename;
  // download === false → sign a plain URL so the object opens INLINE (view in tab).
  const signOptions = opts?.download === false ? undefined : { download: fileName };

  const admin = createAdminSupabase();
  const { data: signed, error: signErr } = await admin.storage
    .from(DOCUMENTS_BUCKET)
    .createSignedUrl((row as { storage_path: string }).storage_path, expiresIn, signOptions);
  if (signErr || !signed) throw new Error(`Failed to sign URL: ${signErr?.message ?? 'unknown error'}`);
  return { url: signed.signedUrl, fileName };
}

/**
 * Delete a document: remove the object, then the metadata row. Ownership is enforced
 * by the RLS row read/delete — a wrong-tenant caller gets NOT_FOUND. Returns false if
 * the row wasn't visible (nothing deleted).
 */
export async function deleteDocument(
  supabase: SupabaseClient,
  documentId: string,
): Promise<boolean> {
  const { data: row, error } = await supabase
    .from('documents')
    .select('storage_path')
    .eq('id', documentId)
    .maybeSingle();
  if (error) throw new Error(`Lookup failed: ${error.message}`);
  if (!row) return false;

  const admin = createAdminSupabase();
  await admin.storage
    .from(DOCUMENTS_BUCKET)
    .remove([(row as { storage_path: string }).storage_path])
    .catch(() => {}); // object may already be gone; still clear the row

  const { error: delErr } = await supabase.from('documents').delete().eq('id', documentId);
  if (delErr) throw new Error(`Failed to delete document: ${delErr.message}`);
  return true;
}

/**
 * attachDocument — the one-call helper any feature/route uses to retain a source file
 * AND link it to the record it supports. Thin wrapper over uploadDocument that makes
 * the (entityType, entityId) link required, so drop-and-parse flows can persist their
 * source in one line instead of throwing it away (task #71).
 */
export async function attachDocument(
  args: {
    supabase: SupabaseClient;
    orgId: string;
    userId: string | null;
    file: File;
    docType: DocType;
    notes?: string | null;
  },
  entityType: string,
  entityId: string,
): Promise<DocumentRow> {
  const { document } = await uploadDocument({
    ...args,
    entityType,
    entityId,
  });
  return document;
}

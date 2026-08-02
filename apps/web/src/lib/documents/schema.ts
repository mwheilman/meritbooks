/**
 * Document Management Center — types, validation, and PURE metadata shaping.
 *
 * The document store keeps FILE BYTES in Supabase Storage (private `documents`
 * bucket) and a METADATA ROW (migration 090) that points at the object via
 * `storage_path` and optionally LINKS to the record it supports via a polymorphic
 * (`entity_type`, `entity_id`) pair.
 *
 * Everything in this file is pure and deterministic (no I/O) so it can be unit
 * tested with no Storage / Postgres dependency: the insert-row shaping, the storage
 * path builder + filename sanitizer, the doc-type inference, and the entity-link
 * filter. The I/O (upload / list / sign / delete) lives in `store.ts`.
 */

import { z } from 'zod';

// ---- Controlled vocabulary (mirrors the migration 090 CHECK exactly) ----
export const DOC_TYPES = [
  'BILL',
  'RECEIPT',
  'CONTRACT',
  'LEASE',
  'LOAN',
  'POLICY',
  'W9',
  'COI',
  'STATEMENT',
  'OTHER',
] as const;
export type DocType = (typeof DOC_TYPES)[number];

export const DOC_TYPE_LABEL: Record<DocType, string> = {
  BILL: 'Bill',
  RECEIPT: 'Receipt',
  CONTRACT: 'Contract',
  LEASE: 'Lease',
  LOAN: 'Loan',
  POLICY: 'Policy',
  W9: 'W-9',
  COI: 'Insurance COI',
  STATEMENT: 'Statement',
  OTHER: 'Other',
};

/** Guard-list of accepted mime types. Broad but not "anything". */
export const ALLOWED_MIME = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/heic',
  'text/csv',
  'text/plain',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
] as const;

export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024; // 25 MB

// ---- Row / DTO shapes ----
export interface DocumentRow {
  id: string;
  org_id: string;
  storage_path: string;
  file_name: string;
  mime_type: string | null;
  size_bytes: number | null;
  doc_type: DocType;
  entity_type: string | null;
  entity_id: string | null;
  uploaded_by_user: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

/** The exact columns a route/store selects for a document. */
export const DOCUMENT_SELECT =
  'id, org_id, storage_path, file_name, mime_type, size_bytes, doc_type, ' +
  'entity_type, entity_id, uploaded_by_user, notes, created_at, updated_at';

// ---- Zod: query params for listing ----
export const listDocumentsQuery = z.object({
  entity_type: z.string().trim().min(1).max(64).optional(),
  entity_id: z.string().uuid().optional(),
  doc_type: z.enum(DOC_TYPES).optional(),
  search: z.string().trim().max(200).optional(),
});
export type ListDocumentsQuery = z.infer<typeof listDocumentsQuery>;

// ---- Zod: multipart upload metadata (the file itself is validated separately) ----
export const uploadMetaSchema = z.object({
  doc_type: z.enum(DOC_TYPES).default('OTHER'),
  entity_type: z.string().trim().min(1).max(64).optional(),
  entity_id: z.string().uuid().optional(),
  notes: z.string().trim().max(2000).optional(),
});
export type UploadMeta = z.infer<typeof uploadMetaSchema>;

// ---- Zod: signed-url request ----
export const signedUrlQuery = z.object({
  expires_in: z.coerce.number().int().min(30).max(3600).default(300),
});

// =============================================================================
// PURE HELPERS (unit tested)
// =============================================================================

/**
 * Sanitize a user filename into a storage-safe segment: keep the extension, strip
 * path separators and anything that isn't a safe char, collapse repeats, and cap
 * length. Never returns an empty string.
 */
export function sanitizeFileName(name: string): string {
  const base = (name || 'file').split(/[\\/]/).pop() || 'file';
  const cleaned = base
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+/, '')
    .replace(/[-.]+$/, '')
    .slice(0, 120);
  return cleaned.length > 0 ? cleaned : 'file';
}

/**
 * Deterministic object key inside the private `documents` bucket. Always namespaced
 * by orgId (defense in depth alongside RLS on the metadata row) and prefixed with a
 * unique id so two identical filenames never collide.
 *
 *   <orgId>/<entityType|unfiled>/<id>-<safeName>
 */
export function buildStoragePath(
  orgId: string,
  entityType: string | null | undefined,
  fileName: string,
  id: string,
): string {
  const bucketFolder = (entityType && entityType.trim() ? entityType.trim() : 'unfiled')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '') || 'unfiled';
  return `${orgId}/${bucketFolder}/${id}-${sanitizeFileName(fileName)}`;
}

/** Best-effort doc-type inference from filename + mime when the caller didn't pick. */
export function inferDocType(fileName: string, mimeType: string | null): DocType {
  const n = (fileName || '').toLowerCase();
  if (/\bw-?9\b/.test(n)) return 'W9';
  if (/\bcoi\b|certificate.*insurance|insurance.*cert/.test(n)) return 'COI';
  if (/policy|coverage/.test(n)) return 'POLICY';
  if (/lease/.test(n)) return 'LEASE';
  if (/loan|promissory|note|credit.?agreement/.test(n)) return 'LOAN';
  if (/statement|stmt/.test(n)) return 'STATEMENT';
  if (/receipt/.test(n)) return 'RECEIPT';
  if (/invoice|bill/.test(n)) return 'BILL';
  if (/contract|agreement|sow|msa/.test(n)) return 'CONTRACT';
  void mimeType;
  return 'OTHER';
}

export interface ShapeDocumentInput {
  orgId: string;
  storagePath: string;
  fileName: string;
  mimeType?: string | null;
  sizeBytes?: number | null;
  docType?: DocType;
  entityType?: string | null;
  entityId?: string | null;
  uploadedByUser?: string | null;
  notes?: string | null;
}

/** The exact INSERT payload for a `public.documents` row, normalized (blank → null). */
export function shapeDocumentRow(input: ShapeDocumentInput): {
  org_id: string;
  storage_path: string;
  file_name: string;
  mime_type: string | null;
  size_bytes: number | null;
  doc_type: DocType;
  entity_type: string | null;
  entity_id: string | null;
  uploaded_by_user: string | null;
  notes: string | null;
} {
  const norm = (v: string | null | undefined): string | null => {
    if (typeof v !== 'string') return null;
    const t = v.trim();
    return t.length > 0 ? t : null;
  };
  return {
    org_id: input.orgId,
    storage_path: input.storagePath,
    file_name: norm(input.fileName) ?? 'file',
    mime_type: norm(input.mimeType),
    size_bytes:
      typeof input.sizeBytes === 'number' && Number.isFinite(input.sizeBytes) && input.sizeBytes >= 0
        ? Math.trunc(input.sizeBytes)
        : null,
    doc_type: input.docType ?? 'OTHER',
    entity_type: norm(input.entityType),
    entity_id: norm(input.entityId),
    uploaded_by_user: norm(input.uploadedByUser),
    notes: norm(input.notes),
  };
}

/**
 * Entity-link filter: return only the documents attached to (entityType, entityId).
 * Pure — used to shape the attachments panel and to unit-test the link semantics.
 * A blank/absent entityId matches only rows whose entity_id is also null (unfiled).
 */
export function filterByEntity<T extends Pick<DocumentRow, 'entity_type' | 'entity_id'>>(
  docs: readonly T[],
  entityType: string | null | undefined,
  entityId: string | null | undefined,
): T[] {
  const et = entityType && entityType.trim() ? entityType.trim() : null;
  const eid = entityId && entityId.trim() ? entityId.trim() : null;
  return docs.filter((d) => (d.entity_type ?? null) === et && (d.entity_id ?? null) === eid);
}

/** Human-readable file size (KB/MB) for the UI. */
export function formatBytes(bytes: number | null | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

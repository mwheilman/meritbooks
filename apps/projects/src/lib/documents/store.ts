import 'server-only';
/**
 * Documents on the RLS client (never service role): bytes into the private `documents` bucket
 * under `<org>/pm/…` (storage policy: first folder = the caller's org, mig 112), one
 * public.documents row per version (mig 090), and the versioning / retention RPCs (mig 1115).
 */
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { HttpError } from '@/lib/api-errors';
import { documentsError, unwrap } from './errors';
import { sha256Hex } from './pdf';
import { readJpegExif } from './exif';
import type { DocKind, FileRow, FolderRow, MoneyCap, PhotoMetaRow, VersionRow } from './types';
import type { EnvelopeRow, EventRow, SignerRow } from '@/lib/esign/types';

export const BUCKET = 'documents';
export const MAX_FILE_BYTES = 75 * 1024 * 1024;
export const MAX_SET_BYTES = 250 * 1024 * 1024;

const pm = (db: SupabaseClient) => db.schema('pm');

export function safeFileName(name: string): string {
  const base = name.replace(/[/\\]/g, '_').replace(/[^\w.\- ()]+/g, '').replace(/\s+/g, ' ').trim();
  return (base || 'file').slice(0, 120);
}

/** public.documents.doc_type (Books' coarse vocabulary). */
export function booksDocType(kind: DocKind): string {
  return ['contract', 'proposal', 'change_order', 'subcontract', 'buyers_order'].includes(kind) ? 'CONTRACT' : 'OTHER';
}

export interface StoredObject {
  documentId: string;
  storagePath: string;
  sha256: string;
  sizeBytes: number;
  fileName: string;
  mimeType: string;
}

/**
 * Record the public.documents row FIRST, then upload the bytes: the storage policies of 1115 let a
 * member write (and read) a <org>/pm/ object only for their own pending row, and never overwrite.
 * A failed upload discards the row through pm.doc_discard_upload.
 */
export async function storeObject(db: SupabaseClient, who: { orgId: string; userId: string }, input: {
  area: 'docs' | 'drawings' | 'esign' | 'photos'; fileName: string; mimeType: string; bytes: Uint8Array; kind: DocKind; notes?: string;
}): Promise<StoredObject> {
  const fileName = safeFileName(input.fileName);
  const path = `${who.orgId}/pm/${input.area}/${randomUUID()}-${fileName}`;
  const row = await db.from('documents').insert({
    org_id: who.orgId, storage_path: path, file_name: fileName, mime_type: input.mimeType, size_bytes: input.bytes.byteLength,
    doc_type: booksDocType(input.kind), entity_type: 'pm.doc_files', uploaded_by_user: who.userId, notes: input.notes ?? null,
  }).select('id').single();
  if (row.error || !row.data) throw row.error ? documentsError(row.error) : new HttpError(500, 'The file was not recorded.', 'CREATE_FAILED');
  const stored: StoredObject = { documentId: (row.data as { id: string }).id, storagePath: path, sha256: sha256Hex(input.bytes), sizeBytes: input.bytes.byteLength, fileName, mimeType: input.mimeType };
  const up = await db.storage.from(BUCKET).upload(path, input.bytes, { contentType: input.mimeType, upsert: false });
  if (up.error) {
    await discardObject(db, stored);
    throw new HttpError(503, 'The file did not upload. Check your connection and try again.', 'UPLOAD_FAILED');
  }
  return stored;
}

/**
 * Remove an upload that never became a version (best effort): pm.doc_discard_upload checks it is the
 * caller's own, never-filed upload, deletes the row and grants 10 minutes to remove the bytes.
 */
export async function discardObject(db: SupabaseClient, o: StoredObject): Promise<void> {
  const r = await db.schema('pm').rpc('doc_discard_upload', { p_document: o.documentId });
  if (!r.error) await db.storage.from(BUCKET).remove([o.storagePath]);
}

export async function signedUrl(db: SupabaseClient, path: string, seconds = 3600): Promise<string | null> {
  const r = await db.storage.from(BUCKET).createSignedUrl(path, seconds);
  return r.error ? null : r.data.signedUrl;
}

export async function signedUrls(db: SupabaseClient, paths: string[], seconds = 3600): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const list = [...new Set(paths)].filter(Boolean);
  if (!list.length) return out;
  const r = await db.storage.from(BUCKET).createSignedUrls(list, seconds);
  for (const s of r.data ?? []) if (s.path && s.signedUrl) out.set(s.path, s.signedUrl);
  return out;
}

export async function downloadObject(db: SupabaseClient, path: string): Promise<Uint8Array> {
  const r = await db.storage.from(BUCKET).download(path);
  if (r.error || !r.data) throw new HttpError(503, 'The stored file could not be read. Try again.', 'DOWNLOAD_FAILED');
  return new Uint8Array(await r.data.arrayBuffer());
}

export interface CreateAttrs {
  title?: string;
  kind?: DocKind;
  folderId?: string | null;
  moneyCap?: MoneyCap | null;
  description?: string | null;
  tags?: string[];
  subjectTable?: string | null;
  subjectId?: string | null;
  label?: string | null;
  note?: string | null;
  pageCount?: number | null;
  source?: 'upload' | 'template' | 'import';
  meta?: Record<string, unknown>;
}

function rpcAttrs(o: StoredObject, a: CreateAttrs): Record<string, unknown> {
  return {
    title: a.title, kind: a.kind, folder_id: a.folderId ?? undefined, money_cap: a.moneyCap ?? undefined, description: a.description ?? undefined,
    tags: a.tags, subject_table: a.subjectTable ?? undefined, subject_id: a.subjectId ?? undefined, label: a.label ?? undefined, note: a.note ?? undefined,
    page_count: a.pageCount ?? undefined, source: a.source, meta: a.meta,
    file_name: o.fileName, mime_type: o.mimeType, size_bytes: o.sizeBytes, content_sha256: o.sha256,
  };
}

export interface Created { file_id: string; version_id: string; version_no: number; folder_id?: string | null; money_cap?: MoneyCap | null }

export async function createDocument(db: SupabaseClient, o: StoredObject, where: { jobId: string | null; companyId: string | null }, a: CreateAttrs): Promise<Created> {
  const r = await pm(db).rpc('doc_create', { p_job: where.jobId, p_location: where.jobId ? null : where.companyId, p_document: o.documentId, p_attrs: rpcAttrs(o, a) });
  if (r.error) { await discardObject(db, o); throw documentsError(r.error); }
  return r.data as Created;
}

export async function addVersion(db: SupabaseClient, fileId: string, o: StoredObject, a: CreateAttrs): Promise<Created> {
  const r = await pm(db).rpc('doc_add_version', { p_file: fileId, p_document: o.documentId, p_attrs: rpcAttrs(o, a) });
  if (r.error) { await discardObject(db, o); throw documentsError(r.error); }
  return r.data as Created;
}

/** EXIF + server time for a photo upload (JPEG only; other images get the server time alone). */
export async function recordPhotoMeta(db: SupabaseClient, o: StoredObject, bytes: Uint8Array, where: { jobId: string | null; companyId: string | null }, opts: { tzOffsetMinutes?: number; area?: string | null; deviceTakenAt?: string | null } = {}): Promise<void> {
  const exif = o.mimeType === 'image/jpeg' ? readJpegExif(bytes, opts.tzOffsetMinutes ?? 0) : null;
  const takenAt = exif?.takenAt ?? opts.deviceTakenAt ?? null;
  const res = await pm(db).from('doc_photo_meta').insert({
    document_id: o.documentId, job_id: where.jobId, location_id: where.jobId ? null : where.companyId,
    taken_at: takenAt, taken_at_source: exif?.takenAt ? 'exif' : takenAt ? 'device' : 'none',
    gps_lat: exif?.gpsLat ?? null, gps_lng: exif?.gpsLng ?? null, gps_alt_m: exif?.gpsAltM ?? null,
    device_make: exif?.make ?? null, device_model: exif?.model ?? null, width_px: exif?.width ?? null, height_px: exif?.height ?? null,
    area: opts.area ?? null,
  });
  if (res.error && res.error.code !== '23505') throw documentsError(res.error);
}

// ------------------------------------------------------------------ reads

const FILE_COLS = 'id, location_id, job_id, folder_id, title, kind, money_cap, description, tags, subject_table, subject_id, current_version_id, version_count, retention_class, retain_until, legal_hold, legal_hold_reason, legal_hold_at, status, created_by, created_at, updated_at, portal_audiences';
const VERSION_COLS = 'id, file_id, version_no, document_id, file_name, mime_type, size_bytes, content_sha256, page_count, label, note, source, is_current, superseded_at, locked, meta, created_by, created_at';

export interface FileListItem extends FileRow {
  current: Pick<VersionRow, 'id' | 'file_name' | 'mime_type' | 'size_bytes' | 'version_no' | 'locked' | 'created_at'> | null;
  signature: 'sent' | 'completed' | 'declined' | null;
}

export interface ListFilter {
  companyIds: string[];
  jobId?: string | null;
  folderId?: string | null;
  kind?: DocKind | null;
  q?: string | null;
  status?: 'active' | 'archived' | 'deleted';
  limit?: number;
}

export async function listFiles(db: SupabaseClient, f: ListFilter): Promise<FileListItem[]> {
  let q = pm(db).from('doc_files').select(FILE_COLS).eq('status', f.status ?? 'active').order('updated_at', { ascending: false }).limit(Math.min(f.limit ?? 300, 500));
  if (f.companyIds.length) q = q.in('location_id', f.companyIds);
  if (f.jobId) q = q.eq('job_id', f.jobId);
  if (f.folderId) q = q.eq('folder_id', f.folderId);
  if (f.kind) q = q.eq('kind', f.kind);
  if (f.q) q = q.ilike('title', `%${f.q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`);
  const files = unwrap<FileRow[]>(await q) ?? [];
  if (!files.length) return [];
  const vids = files.map((x) => x.current_version_id).filter((x): x is string => !!x);
  const [vers, envs] = await Promise.all([
    vids.length ? pm(db).from('doc_versions').select('id, file_name, mime_type, size_bytes, version_no, locked, created_at').in('id', vids) : Promise.resolve({ data: [], error: null }),
    pm(db).from('esign_envelopes').select('file_id, status, created_at').in('file_id', files.map((x) => x.id)).order('created_at', { ascending: false }),
  ]);
  const vmap = new Map(((vers.data ?? []) as FileListItem['current'][]).filter((v): v is NonNullable<FileListItem['current']> => !!v).map((v) => [v.id, v]));
  const emap = new Map<string, string>();
  for (const e of (envs.data ?? []) as Array<{ file_id: string; status: string }>) if (!emap.has(e.file_id)) emap.set(e.file_id, e.status);
  return files.map((x) => {
    const s = emap.get(x.id);
    return { ...x, current: x.current_version_id ? vmap.get(x.current_version_id) ?? null : null, signature: s === 'sent' || s === 'completed' || s === 'declined' ? s : null };
  });
}

export async function listFolders(db: SupabaseClient, jobId: string): Promise<FolderRow[]> {
  return unwrap<FolderRow[]>(await pm(db).from('doc_folders').select('id, job_id, parent_id, key, name, sort, money_cap, kinds').eq('job_id', jobId).order('sort').order('name')) ?? [];
}

export async function folderCounts(db: SupabaseClient, jobId: string): Promise<Record<string, number>> {
  const r = unwrap<Array<{ folder_id: string | null }>>(await pm(db).from('doc_files').select('folder_id').eq('job_id', jobId).eq('status', 'active').limit(5000)) ?? [];
  const out: Record<string, number> = {};
  for (const x of r) { const k = x.folder_id ?? 'none'; out[k] = (out[k] ?? 0) + 1; }
  return out;
}

export async function ensureFolders(db: SupabaseClient, jobId: string): Promise<number> {
  return unwrap<number>(await pm(db).rpc('doc_ensure_job_folders', { p_job: jobId })) ?? 0;
}

export interface FileDetail {
  file: FileRow;
  versions: Array<VersionRow & { url: string | null }>;
  photo: PhotoMetaRow | null;
  envelopes: Array<EnvelopeRow & { signers: SignerRow[]; events: EventRow[]; pendingEvents: number }>;
}

export async function fileDetail(db: SupabaseClient, fileId: string): Promise<FileDetail> {
  const f = unwrap<FileRow | null>(await pm(db).from('doc_files').select(FILE_COLS).eq('id', fileId).maybeSingle());
  if (!f) throw new HttpError(404, 'That document was not found, or it is not on one of your jobs.', 'NOT_FOUND');
  const versions = unwrap<VersionRow[]>(await pm(db).from('doc_versions').select(VERSION_COLS).eq('file_id', fileId).order('version_no', { ascending: false })) ?? [];
  const docs = versions.length
    ? unwrap<Array<{ id: string; storage_path: string }>>(await db.from('documents').select('id, storage_path').in('id', versions.map((v) => v.document_id))) ?? []
    : [];
  const pathOf = new Map(docs.map((d) => [d.id, d.storage_path]));
  const urls = await signedUrls(db, docs.map((d) => d.storage_path), 900);
  const cur = versions.find((v) => v.is_current);
  const [photo, envs] = await Promise.all([
    cur && f.kind === 'photo' ? pm(db).from('doc_photo_meta').select('document_id, taken_at, taken_at_source, gps_lat, gps_lng, device_make, device_model, received_at, area').eq('document_id', cur.document_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
    pm(db).from('esign_envelopes').select('*').eq('file_id', fileId).order('created_at', { ascending: false }).limit(20),
  ]);
  const envelopes = ((envs.data ?? []) as EnvelopeRow[]);
  const ids = envelopes.map((e) => e.id);
  const [signers, events] = ids.length ? await Promise.all([
    pm(db).from('esign_signers').select('id, envelope_id, routing_order, position, name, email, phone, role_label, channel, status, sent_at, viewed_at, consented_at, consent_version, signed_at, typed_name, signature_png, sign_ip, sign_user_agent, declined_at, decline_reason').in('envelope_id', ids).order('position'),
    pm(db).from('esign_events').select('id, envelope_id, signer_id, event, at, ip, user_agent, actor_user, detail').in('envelope_id', ids).order('seq'),
  ]) : [{ data: [] }, { data: [] }];
  const pend = ids.length ? (await pm(db).from('esign_outbox').select('envelope_id').in('envelope_id', ids).eq('status', 'pending')).data ?? [] : [];
  const pendBy = new Map<string, number>();
  for (const x of pend as Array<{ envelope_id: string }>) pendBy.set(x.envelope_id, (pendBy.get(x.envelope_id) ?? 0) + 1);
  const sBy = new Map<string, SignerRow[]>();
  for (const s of (signers.data ?? []) as SignerRow[]) sBy.set(s.envelope_id, [...(sBy.get(s.envelope_id) ?? []), { ...s, signature_png: null }]);
  const eBy = new Map<string, EventRow[]>();
  for (const e of (events.data ?? []) as EventRow[]) eBy.set(e.envelope_id, [...(eBy.get(e.envelope_id) ?? []), e]);
  return {
    file: f,
    versions: versions.map((v) => ({ ...v, url: urls.get(pathOf.get(v.document_id) ?? '') ?? null })),
    photo: (photo.data as PhotoMetaRow | null) ?? null,
    envelopes: envelopes.map((e) => ({ ...e, signers: sBy.get(e.id) ?? [], events: eBy.get(e.id) ?? [], pendingEvents: pendBy.get(e.id) ?? 0 })),
  };
}

export async function storagePathOf(db: SupabaseClient, documentId: string): Promise<string> {
  const r = unwrap<{ storage_path: string } | null>(await db.from('documents').select('storage_path').eq('id', documentId).maybeSingle());
  if (!r) throw new HttpError(404, 'The stored file was not found.', 'NOT_FOUND');
  return r.storage_path;
}

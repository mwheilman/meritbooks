import 'server-only';
/**
 * Drawing sets (CGC-60 / PLT-50): upload a PDF set, split it into one single-page PDF per
 * sheet, record each page as a revision of its sheet (number / title from the browser's text
 * layer, corrected by hand), publish to make it the current set; markups per revision.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { HttpError } from '@/lib/api-errors';
import { documentsError, unwrap } from './errors';
import { splitPdf } from './pdf';
import { normalizeSheetNumber, placeholderNumber, disciplineOf } from './sheets';
import { createDocument, discardObject, signedUrls, storeObject } from './store';
import type { DrawingRevisionRow, DrawingSetRow, DrawingSheetRow, MarkupInputT, MarkupRow, SetKind } from './types';

const pm = (db: SupabaseClient) => db.schema('pm');

export interface PageMeta {
  index: number;
  sheetNumber?: string | null;
  title?: string | null;
  discipline?: string | null;
  revision?: string | null;
  extraction?: 'text' | 'manual' | 'none';
  confidence?: number | null;
}

export interface SetUploadResult {
  setId: string;
  sourceFileId: string;
  pages: number;
  added: Array<{ index: number; sheetId: string; revisionId: string; sheetNumber: string }>;
  failed: Array<{ index: number; sheetNumber: string; error: string }>;
}

export async function uploadSet(db: SupabaseClient, who: { orgId: string; userId: string }, input: {
  jobId: string; name: string; setKind: SetKind; issuedOn: string | null; fileName: string; bytes: Uint8Array; pages: PageMeta[];
}): Promise<SetUploadResult> {
  let parts;
  try {
    parts = await splitPdf(input.bytes, { title: input.name });
  } catch (e) {
    throw new HttpError(422, e instanceof Error && /pages/.test(e.message) ? e.message : 'That file is not a PDF we can read. Export the set to PDF and try again.', 'BAD_PDF');
  }
  const src = await storeObject(db, who, { area: 'drawings', fileName: input.fileName, mimeType: 'application/pdf', bytes: input.bytes, kind: 'drawing_set' });
  const created = await createDocument(db, src, { jobId: input.jobId, companyId: null }, { title: input.name, kind: 'drawing_set', pageCount: parts.length, label: input.setKind.toUpperCase() });
  const setId = unwrap<string>(await pm(db).rpc('drawing_set_create', {
    p_job: input.jobId,
    p_attrs: { name: input.name, set_kind: input.setKind, issued_on: input.issuedOn, source_file_id: created.file_id, page_count: parts.length },
  }));
  const byIndex = new Map(input.pages.map((p) => [p.index, p]));
  const used = new Set<string>();
  const added: SetUploadResult['added'] = [];
  const failed: SetUploadResult['failed'] = [];
  for (const part of parts) {
    const meta = byIndex.get(part.index);
    let num = normalizeSheetNumber(meta?.sheetNumber ?? '') ?? placeholderNumber(part.index);
    if (used.has(num)) num = placeholderNumber(part.index);
    used.add(num);
    const obj = await storeObject(db, who, { area: 'drawings', fileName: `${num}.pdf`, mimeType: 'application/pdf', bytes: part.bytes, kind: 'drawing_set' });
    const r = await pm(db).rpc('drawing_add_sheet', {
      p_set: setId, p_document: obj.documentId,
      p_attrs: {
        page_index: part.index, sheet_number: num, title: meta?.title ?? null, discipline: meta?.discipline ?? disciplineOf(num),
        revision_label: meta?.revision ?? null, extraction: meta?.extraction ?? 'none', confidence: meta?.confidence ?? null,
        width_pt: Math.round(part.width * 100) / 100, height_pt: Math.round(part.height * 100) / 100, content_sha256: part.sha256,
      },
    });
    if (r.error) {
      await discardObject(db, obj);
      failed.push({ index: part.index, sheetNumber: num, error: documentsError(r.error).message });
      continue;
    }
    const d = r.data as { sheet_id: string; revision_id: string; sheet_number: string };
    added.push({ index: part.index, sheetId: d.sheet_id, revisionId: d.revision_id, sheetNumber: d.sheet_number });
  }
  return { setId, sourceFileId: created.file_id, pages: parts.length, added, failed };
}

export interface SheetListItem extends DrawingSheetRow {
  current: (Pick<DrawingRevisionRow, 'id' | 'revision_label' | 'set_id' | 'created_at'> & { set_name: string; issued_on: string | null }) | null;
}

export async function listSets(db: SupabaseClient, jobId: string): Promise<DrawingSetRow[]> {
  return unwrap<DrawingSetRow[]>(await pm(db).from('drawing_sets').select('id, job_id, name, set_kind, issued_on, source_file_id, page_count, sheet_count, status, published_at, created_at').eq('job_id', jobId).order('issued_on', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false })) ?? [];
}

export async function listSheets(db: SupabaseClient, jobId: string): Promise<SheetListItem[]> {
  const sheets = unwrap<DrawingSheetRow[]>(await pm(db).from('drawing_sheets').select('id, job_id, sheet_number, title, discipline, current_revision_id, revision_count, updated_at').eq('job_id', jobId).order('sheet_number')) ?? [];
  const revIds = sheets.map((s) => s.current_revision_id).filter((x): x is string => !!x);
  const revs = revIds.length ? unwrap<Array<Pick<DrawingRevisionRow, 'id' | 'revision_label' | 'set_id' | 'created_at'>>>(await pm(db).from('drawing_revisions').select('id, revision_label, set_id, created_at').in('id', revIds)) ?? [] : [];
  const sets = new Map((await listSets(db, jobId)).map((s) => [s.id, s]));
  const rmap = new Map(revs.map((r) => [r.id, r]));
  return sheets.map((s) => {
    const r = s.current_revision_id ? rmap.get(s.current_revision_id) : undefined;
    const set = r ? sets.get(r.set_id) : undefined;
    return { ...s, current: r ? { ...r, set_name: set?.name ?? 'Set', issued_on: set?.issued_on ?? null } : null };
  });
}

/** Revisions of a set (review screen). */
export async function setRevisions(db: SupabaseClient, setId: string): Promise<Array<DrawingRevisionRow & { sheet_number: string; discipline: string | null }>> {
  const revs = unwrap<DrawingRevisionRow[]>(await pm(db).from('drawing_revisions').select('id, job_id, sheet_id, set_id, document_id, page_index, title, revision_label, width_pt, height_pt, extraction, confidence, status, is_current, created_at').eq('set_id', setId).order('page_index')) ?? [];
  const ids = [...new Set(revs.map((r) => r.sheet_id))];
  const sheets = ids.length ? unwrap<Array<{ id: string; sheet_number: string; discipline: string | null }>>(await pm(db).from('drawing_sheets').select('id, sheet_number, discipline').in('id', ids)) ?? [] : [];
  const sm = new Map(sheets.map((s) => [s.id, s]));
  return revs.map((r) => ({ ...r, sheet_number: sm.get(r.sheet_id)?.sheet_number ?? '?', discipline: sm.get(r.sheet_id)?.discipline ?? null }));
}

export interface SheetDetail {
  sheet: DrawingSheetRow;
  revisions: Array<DrawingRevisionRow & { set_name: string; set_kind: SetKind; issued_on: string | null; url: string | null }>;
}

export async function sheetDetail(db: SupabaseClient, sheetId: string): Promise<SheetDetail> {
  const sheet = unwrap<DrawingSheetRow | null>(await pm(db).from('drawing_sheets').select('id, job_id, sheet_number, title, discipline, current_revision_id, revision_count, updated_at').eq('id', sheetId).maybeSingle());
  if (!sheet) throw new HttpError(404, 'That sheet was not found, or it is not on one of your jobs.', 'NOT_FOUND');
  const revs = unwrap<DrawingRevisionRow[]>(await pm(db).from('drawing_revisions').select('id, job_id, sheet_id, set_id, document_id, page_index, title, revision_label, width_pt, height_pt, extraction, confidence, status, is_current, created_at').eq('sheet_id', sheetId).order('created_at', { ascending: false })) ?? [];
  const sets = new Map((await listSets(db, sheet.job_id)).map((s) => [s.id, s]));
  const docs = revs.length ? unwrap<Array<{ id: string; storage_path: string }>>(await db.from('documents').select('id, storage_path').in('id', revs.map((r) => r.document_id))) ?? [] : [];
  const urls = await signedUrls(db, docs.map((d) => d.storage_path), 3600);
  const pathOf = new Map(docs.map((d) => [d.id, d.storage_path]));
  return {
    sheet,
    revisions: revs.map((r) => {
      const s = sets.get(r.set_id);
      return { ...r, set_name: s?.name ?? 'Set', set_kind: s?.set_kind ?? 'other', issued_on: s?.issued_on ?? null, url: urls.get(pathOf.get(r.document_id) ?? '') ?? null };
    }).sort((a, b) => (b.issued_on ?? '').localeCompare(a.issued_on ?? '') || b.created_at.localeCompare(a.created_at)),
  };
}

const MARKUP_COLS = 'id, revision_id, sheet_id, author_user, visibility, kind, geometry, style, body, link_table, link_id, published_at, created_at, updated_at';

export async function listMarkups(db: SupabaseClient, revisionId: string): Promise<MarkupRow[]> {
  return unwrap<MarkupRow[]>(await pm(db).from('drawing_markups').select(MARKUP_COLS).eq('revision_id', revisionId).order('created_at')) ?? [];
}

export async function createMarkup(db: SupabaseClient, revisionId: string, m: MarkupInputT): Promise<MarkupRow> {
  const r = await pm(db).from('drawing_markups').insert({
    revision_id: revisionId, visibility: m.visibility, kind: m.kind, geometry: m.geometry, style: m.style ?? {}, body: m.body ?? null,
    link_table: m.linkTable ?? null, link_id: m.linkId ?? null,
  }).select(MARKUP_COLS).single();
  if (r.error) {
    if (/row-level security/.test(r.error.message ?? '')) {
      throw new HttpError(403, m.visibility === 'published' ? 'Publishing markups needs edit rights on this job’s documents. Save it as personal.' : 'You can’t mark up this sheet.', 'FORBIDDEN');
    }
    throw documentsError(r.error);
  }
  return r.data as MarkupRow;
}

export async function updateMarkup(db: SupabaseClient, id: string, patch: Partial<Pick<MarkupInputT, 'geometry' | 'style' | 'body'>>): Promise<MarkupRow> {
  const r = await pm(db).from('drawing_markups').update({
    ...(patch.geometry !== undefined ? { geometry: patch.geometry } : {}),
    ...(patch.style !== undefined ? { style: patch.style } : {}),
    ...(patch.body !== undefined ? { body: patch.body } : {}),
  }).eq('id', id).select(MARKUP_COLS).maybeSingle();
  if (r.error) throw documentsError(r.error);
  if (!r.data) throw new HttpError(403, 'Only the author can change a personal markup; published markups need edit rights.', 'FORBIDDEN');
  return r.data as MarkupRow;
}

export async function deleteMarkup(db: SupabaseClient, id: string): Promise<void> {
  const r = await pm(db).from('drawing_markups').delete().eq('id', id).select('id');
  if (r.error) throw documentsError(r.error);
  if (!r.data?.length) throw new HttpError(403, 'Only the author can remove a personal markup; published markups need edit rights.', 'FORBIDDEN');
}

export async function publishMarkup(db: SupabaseClient, id: string, publish: boolean): Promise<void> {
  unwrap(await pm(db).rpc('drawing_markup_publish', { p_markup: id, p_publish: publish }));
}

import 'server-only';
/**
 * Generate a document from a template for a record: load the record (as the caller), render the
 * branded PDF, store it, and file it — as a new version when the record already has an open,
 * unsigned document of that kind, otherwise as a new document linked to the record.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { addVersion, createDocument, storeObject } from '@/lib/documents/store';
import type { DocKind } from '@/lib/documents/types';
import { templateContext } from './context';
import { loadTemplateData, type LoadOptions } from './loaders';
import { renderTemplate } from './render';
import { TEMPLATE_DOC_KIND, type TemplateKey } from './types';

export interface Generated {
  fileId: string;
  versionId: string;
  versionNo: number;
  title: string;
  pageCount: number;
  anchors: number;
  newDocument: boolean;
}

export async function generateDocument(db: SupabaseClient, who: { orgId: string; userId: string }, input: {
  template: TemplateKey; sourceId: string; options?: LoadOptions; title?: string;
}): Promise<Generated> {
  const loaded = await loadTemplateData(db, input.template, input.sourceId, input.options ?? {});
  const ctx = await templateContext(db, who.orgId, loaded.companyId, input.template);
  const rendered = await renderTemplate(input.template, loaded.data, ctx);
  const kind = TEMPLATE_DOC_KIND[input.template] as DocKind;
  const title = input.title?.trim() || loaded.title;
  const obj = await storeObject(db, who, { area: 'docs', fileName: rendered.fileName, mimeType: 'application/pdf', bytes: rendered.bytes, kind });
  const attrs = {
    title, kind, subjectTable: loaded.subject.table, subjectId: loaded.subject.id, pageCount: rendered.pageCount, source: 'template' as const,
    meta: { template: input.template, anchors: rendered.anchors },
  };
  // an existing open document for this record + kind gets a new version (unless it is signed or out for signature)
  const existing = await db.schema('pm').from('doc_files').select('id, current_version_id')
    .eq('subject_table', loaded.subject.table).eq('subject_id', loaded.subject.id).eq('kind', kind).eq('status', 'active')
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  const prior = existing.data as { id: string; current_version_id: string | null } | null;
  if (prior) {
    const [locked, open] = await Promise.all([
      prior.current_version_id ? db.schema('pm').from('doc_versions').select('locked').eq('id', prior.current_version_id).maybeSingle() : Promise.resolve({ data: null }),
      db.schema('pm').from('esign_envelopes').select('id').eq('file_id', prior.id).in('status', ['draft', 'sent']).limit(1),
    ]);
    if (!(locked.data as { locked?: boolean } | null)?.locked && !((open.data as unknown[] | null)?.length)) {
      const v = await addVersion(db, prior.id, obj, { ...attrs, note: 'Regenerated from the record' });
      return { fileId: prior.id, versionId: v.version_id, versionNo: v.version_no, title, pageCount: rendered.pageCount, anchors: rendered.anchors.length, newDocument: false };
    }
  }
  const c = await createDocument(db, obj, { jobId: loaded.jobId, companyId: loaded.companyId }, attrs);
  return { fileId: c.file_id, versionId: c.version_id, versionNo: c.version_no, title, pageCount: rendered.pageCount, anchors: rendered.anchors.length, newDocument: true };
}

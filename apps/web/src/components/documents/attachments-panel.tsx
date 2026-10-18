'use client';

/**
 * AttachmentsPanel — a reusable "documents on this record" panel.
 *
 * Drop it onto ANY record page (a bill, invoice, lease, loan, policy, journal entry,
 * vendor, customer, job, …) to show that record's retained source documents and add
 * more. It talks only to /api/documents, scoped by (entityType, entityId), so it needs
 * no per-page wiring beyond those two props.
 *
 *   <AttachmentsPanel entityType="BILL" entityId={bill.id} defaultDocType="BILL" />
 *
 * States: loading, empty, error, populated. Upload is multipart (FormData → POST).
 * Download opens a short-lived signed URL. Delete confirms first.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { clsx } from 'clsx';
import {
  Loader2,
  AlertCircle,
  Paperclip,
  Upload,
  Download,
  Trash2,
  FileText,
} from 'lucide-react';
import { addToast } from '@/hooks/use-toast';
import {
  DOC_TYPE_LABEL,
  formatBytes,
  MAX_DOCUMENT_BYTES,
  type DocType,
  type DocumentRow,
} from '@/lib/documents/schema';

interface AttachmentsPanelProps {
  entityType: string;
  entityId: string;
  /** Doc type assigned to uploads from this panel. Defaults to OTHER. */
  defaultDocType?: DocType;
  /** Panel heading. Defaults to "Attachments". */
  title?: string;
  className?: string;
}

export function AttachmentsPanel({
  entityType,
  entityId,
  defaultDocType = 'OTHER',
  title = 'Attachments',
  className,
}: AttachmentsPanelProps) {
  const [docs, setDocs] = useState<DocumentRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const params = new URLSearchParams({ entity_type: entityType, entity_id: entityId });
      const res = await fetch(`/api/documents?${params.toString()}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? 'Failed to load');
      setDocs((body.data ?? []) as DocumentRow[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load attachments');
      setDocs([]);
    }
  }, [entityType, entityId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function onFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true);
    let ok = 0;
    for (const file of Array.from(files)) {
      if (file.size > MAX_DOCUMENT_BYTES) {
        addToast('error', `${file.name} exceeds the 25 MB limit`);
        continue;
      }
      const fd = new FormData();
      fd.append('file', file);
      fd.append('doc_type', defaultDocType);
      fd.append('entity_type', entityType);
      fd.append('entity_id', entityId);
      const res = await fetch('/api/documents', { method: 'POST', body: fd });
      if (res.ok) ok += 1;
      else {
        const b = await res.json().catch(() => null);
        addToast('error', b?.error ?? `Failed to upload ${file.name}`);
      }
    }
    setUploading(false);
    if (inputRef.current) inputRef.current.value = '';
    if (ok > 0) {
      addToast('success', `${ok} document${ok === 1 ? '' : 's'} attached`);
      void load();
    }
  }

  async function download(doc: DocumentRow) {
    try {
      const res = await fetch(`/api/documents/${doc.id}/signed-url`);
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? 'Failed');
      window.open(body.url as string, '_blank', 'noopener,noreferrer');
    } catch (err) {
      addToast('error', err instanceof Error ? err.message : 'Could not open document');
    }
  }

  async function remove(doc: DocumentRow) {
    if (!confirm(`Remove "${doc.file_name}"? This deletes the stored file.`)) return;
    const res = await fetch(`/api/documents/${doc.id}`, { method: 'DELETE' });
    if (res.ok) {
      addToast('success', 'Document removed');
      void load();
    } else {
      const b = await res.json().catch(() => null);
      addToast('error', b?.error ?? 'Failed to remove document');
    }
  }

  return (
    <div className={clsx('card p-4', className)}>
      <div className="flex items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2">
          <Paperclip size={15} className="text-slate-400" />
          <h3 className="text-sm font-semibold text-white">{title}</h3>
          {docs && docs.length > 0 && (
            <span className="text-[11px] text-slate-500">{docs.length}</span>
          )}
        </div>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
          className="px-3 py-1.5 text-xs font-medium bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded-lg inline-flex items-center gap-1.5"
        >
          {uploading ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
          {uploading ? 'Uploading…' : 'Attach'}
        </button>
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => onFiles(e.target.files)}
        />
      </div>

      {docs === null ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="w-5 h-5 text-emerald-400 animate-spin" />
        </div>
      ) : error ? (
        <div className="py-6 text-center">
          <AlertCircle className="w-5 h-5 mx-auto text-red-400 mb-1" />
          <p className="text-xs text-red-400">{error}</p>
        </div>
      ) : docs.length === 0 ? (
        <div className="py-8 text-center">
          <FileText className="w-7 h-7 mx-auto text-slate-600 mb-2" />
          <p className="text-xs text-slate-400 mb-0.5">No documents attached</p>
          <p className="text-[11px] text-slate-600">Attach the bill, contract, or supporting file for this record.</p>
        </div>
      ) : (
        <div className="space-y-1.5">
          {docs.map((doc) => (
            <div
              key={doc.id}
              className="flex items-center justify-between gap-3 rounded-lg bg-slate-950/40 px-3 py-2"
            >
              <button
                type="button"
                onClick={() => download(doc)}
                className="flex items-center gap-2 min-w-0 text-left group"
              >
                <FileText size={14} className="text-slate-500 shrink-0" />
                <span className="text-xs text-white truncate group-hover:text-emerald-300">{doc.file_name}</span>
                <span className="text-[10px] text-slate-600 shrink-0">{DOC_TYPE_LABEL[doc.doc_type]}</span>
                <span className="text-[10px] text-slate-600 shrink-0 font-mono">{formatBytes(doc.size_bytes)}</span>
              </button>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  onClick={() => download(doc)}
                  title="Download"
                  className="p-1.5 text-slate-500 hover:text-emerald-300 rounded"
                >
                  <Download size={13} />
                </button>
                <button
                  type="button"
                  onClick={() => remove(doc)}
                  title="Remove"
                  className="p-1.5 text-slate-500 hover:text-red-400 rounded"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

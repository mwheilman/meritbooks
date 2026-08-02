'use client';

/**
 * Documents center — browse, filter, upload, preview/download, and delete every
 * retained document in the tenant. File bytes live in the private `documents` Storage
 * bucket; this reads/writes the metadata rows via /api/documents (RLS-scoped).
 *
 * Filter by doc type and a debounced filename search; each row shows the record it's
 * linked to (entity_type · entity_id) so a source document is traceable back to the
 * bill/lease/policy it supports. States: loading, empty, error, populated.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { clsx } from 'clsx';
import {
  Loader2,
  AlertCircle,
  Upload,
  Download,
  Trash2,
  FileText,
  Search,
  Link2,
  FolderOpen,
} from 'lucide-react';
import { useDebounce } from '@/hooks';
import { addToast } from '@/hooks/use-toast';
import {
  DOC_TYPES,
  DOC_TYPE_LABEL,
  formatBytes,
  MAX_DOCUMENT_BYTES,
  type DocType,
  type DocumentRow,
} from '@/lib/documents/schema';

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function DocumentsCenter() {
  const [docs, setDocs] = useState<DocumentRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<DocType | 'ALL'>('ALL');
  const [rawSearch, setRawSearch] = useState('');
  const [uploadType, setUploadType] = useState<DocType>('OTHER');
  const [uploading, setUploading] = useState(false);
  const search = useDebounce(rawSearch, 300);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const params = new URLSearchParams();
      if (typeFilter !== 'ALL') params.set('doc_type', typeFilter);
      if (search.trim()) params.set('search', search.trim());
      const res = await fetch(`/api/documents?${params.toString()}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? 'Failed to load');
      setDocs((body.data ?? []) as DocumentRow[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load documents');
      setDocs([]);
    }
  }, [typeFilter, search]);

  useEffect(() => {
    void load();
  }, [load]);

  const counts = useMemo(() => {
    const total = docs?.length ?? 0;
    const bytes = (docs ?? []).reduce((s, d) => s + (d.size_bytes ?? 0), 0);
    const linked = (docs ?? []).filter((d) => d.entity_type).length;
    return { total, bytes, linked };
  }, [docs]);

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
      fd.append('doc_type', uploadType);
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
      addToast('success', `${ok} document${ok === 1 ? '' : 's'} uploaded`);
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
    if (!confirm(`Delete "${doc.file_name}"? This removes the stored file.`)) return;
    const res = await fetch(`/api/documents/${doc.id}`, { method: 'DELETE' });
    if (res.ok) {
      addToast('success', 'Document deleted');
      void load();
    } else {
      const b = await res.json().catch(() => null);
      addToast('error', b?.error ?? 'Failed to delete document');
    }
  }

  return (
    <div className="space-y-5">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-4 text-xs">
          <span className="text-slate-500">{counts.total} document{counts.total === 1 ? '' : 's'}</span>
          {counts.linked > 0 && <span className="text-emerald-400">{counts.linked} linked to records</span>}
          <span className="text-slate-500">Stored <span className="font-mono text-slate-300">{formatBytes(counts.bytes)}</span></span>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={uploadType}
            onChange={(e) => setUploadType(e.target.value as DocType)}
            className="bg-slate-900 border border-slate-700 rounded-lg text-xs text-slate-200 px-2 py-1.5"
            title="Type assigned to uploads"
          >
            {DOC_TYPES.map((t) => (
              <option key={t} value={t}>{DOC_TYPE_LABEL[t]}</option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={uploading}
            className="px-3 py-1.5 text-xs font-medium bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded-lg inline-flex items-center gap-1.5"
          >
            {uploading ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
            {uploading ? 'Uploading…' : 'Upload'}
          </button>
          <input ref={inputRef} type="file" multiple className="hidden" onChange={(e) => onFiles(e.target.files)} />
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            value={rawSearch}
            onChange={(e) => setRawSearch(e.target.value)}
            placeholder="Search file names…"
            className="bg-slate-900 border border-slate-700 rounded-lg text-xs text-slate-200 pl-8 pr-3 py-1.5 w-64"
          />
        </div>
        <div className="flex items-center gap-1 flex-wrap">
          <FilterChip active={typeFilter === 'ALL'} onClick={() => setTypeFilter('ALL')}>All</FilterChip>
          {DOC_TYPES.map((t) => (
            <FilterChip key={t} active={typeFilter === t} onClick={() => setTypeFilter(t)}>
              {DOC_TYPE_LABEL[t]}
            </FilterChip>
          ))}
        </div>
      </div>

      {/* List */}
      {docs === null ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-6 h-6 text-emerald-400 animate-spin" />
        </div>
      ) : error ? (
        <div className="card p-10 text-center">
          <AlertCircle className="w-8 h-8 mx-auto text-red-400 mb-2" />
          <p className="text-sm text-red-400">{error}</p>
        </div>
      ) : docs.length === 0 ? (
        <div className="card p-12 text-center">
          <FolderOpen className="w-10 h-10 mx-auto text-slate-600 mb-3" />
          <p className="text-sm text-slate-300 mb-1">
            {typeFilter !== 'ALL' || search ? 'No documents match your filter' : 'No documents yet'}
          </p>
          <p className="text-xs text-slate-500 max-w-md mx-auto mb-4">
            Upload contracts, bills, statements, policies, W-9s, and COIs. Source documents from
            drop-and-parse features are retained here and linked to the record they created.
          </p>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="px-4 py-2 text-sm font-medium bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg inline-flex items-center gap-1.5"
          >
            <Upload size={14} /> Upload a document
          </button>
        </div>
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-slate-800 text-[10px] uppercase tracking-wider text-slate-500">
                  <th className="px-4 py-2.5 font-medium">Document</th>
                  <th className="px-4 py-2.5 font-medium">Type</th>
                  <th className="px-4 py-2.5 font-medium">Linked to</th>
                  <th className="px-4 py-2.5 font-medium text-right">Size</th>
                  <th className="px-4 py-2.5 font-medium">Uploaded</th>
                  <th className="px-4 py-2.5 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {docs.map((doc) => (
                  <tr key={doc.id} className="border-b border-slate-800/60 hover:bg-slate-900/40">
                    <td className="px-4 py-2.5">
                      <button
                        type="button"
                        onClick={() => download(doc)}
                        className="flex items-center gap-2 min-w-0 text-left group"
                      >
                        <FileText size={14} className="text-slate-500 shrink-0" />
                        <span className="text-xs text-white truncate group-hover:text-emerald-300 max-w-xs">{doc.file_name}</span>
                      </button>
                      {doc.notes && <p className="text-[10px] text-slate-600 mt-0.5 truncate max-w-xs">{doc.notes}</p>}
                    </td>
                    <td className="px-4 py-2.5">
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-800 text-slate-300">{DOC_TYPE_LABEL[doc.doc_type]}</span>
                    </td>
                    <td className="px-4 py-2.5">
                      {doc.entity_type ? (
                        <span className="inline-flex items-center gap-1 text-[11px] text-slate-400">
                          <Link2 size={11} className="text-emerald-500" />
                          <span className="font-medium text-slate-300">{doc.entity_type}</span>
                          {doc.entity_id && <span className="font-mono text-slate-600 truncate max-w-[8rem]">{doc.entity_id.slice(0, 8)}</span>}
                        </span>
                      ) : (
                        <span className="text-[11px] text-slate-600">Unfiled</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right text-[11px] font-mono text-slate-400">{formatBytes(doc.size_bytes)}</td>
                    <td className="px-4 py-2.5 text-[11px] text-slate-500">{fmtDate(doc.created_at)}</td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center justify-end gap-1">
                        <button type="button" onClick={() => download(doc)} title="Download" className="p-1.5 text-slate-500 hover:text-emerald-300 rounded">
                          <Download size={13} />
                        </button>
                        <button type="button" onClick={() => remove(doc)} title="Delete" className="p-1.5 text-slate-500 hover:text-red-400 rounded">
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'px-2.5 py-1 text-[11px] font-medium rounded-lg border transition-colors',
        active
          ? 'bg-emerald-600/20 text-emerald-300 border-emerald-500/40'
          : 'bg-slate-900 text-slate-400 border-slate-700 hover:text-slate-200',
      )}
    >
      {children}
    </button>
  );
}

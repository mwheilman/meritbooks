'use client';

/**
 * Documents center — browse, search, filter, preview/download, and manage every
 * retained document in the tenant. File bytes live in the private `documents` Storage
 * bucket; this reads/writes the metadata rows via /api/documents (RLS-scoped, org-isolated).
 *
 * Depth:
 *  - Search by filename (debounced, server ilike).
 *  - Filters: doc type, linked-record type, an "Unfiled" view for inbound/retained docs
 *    not yet linked to a record, and a created-date range preset.
 *  - A "Linked to" column that click-throughs to the SOURCE record (bill/lease/covenant/…).
 *  - Per-document View (inline signed URL) and Download (attachment signed URL).
 *  - Client-side sortable columns (name / type / linked / size / date).
 *  - Safe bulk-select: download selected. No hard-delete in bulk.
 *  - States: loading, empty, filtered-empty, error, populated.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
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
  Eye,
  ArrowUpDown,
  X,
  Inbox,
} from 'lucide-react';
import { useDebounce } from '@/hooks';
import { addToast } from '@/hooks/use-toast';
import {
  DOC_TYPES,
  DOC_TYPE_LABEL,
  LINKABLE_ENTITY_TYPES,
  entityTypeLabel,
  entityRecordHref,
  formatBytes,
  MAX_DOCUMENT_BYTES,
  type DocType,
  type DocumentRow,
} from '@/lib/documents/schema';

type LinkFilter = 'ALL' | 'UNFILED' | 'LINKED' | string; // string = specific entity_type
type DatePreset = 'ALL' | '7D' | '30D' | '90D' | 'YTD';
type SortKey = 'file_name' | 'doc_type' | 'entity_type' | 'size_bytes' | 'created_at';
type SortDir = 'asc' | 'desc';

const DATE_PRESETS: { value: DatePreset; label: string }[] = [
  { value: 'ALL', label: 'Any date' },
  { value: '7D', label: 'Last 7 days' },
  { value: '30D', label: 'Last 30 days' },
  { value: '90D', label: 'Last 90 days' },
  { value: 'YTD', label: 'This year' },
];

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Compute the ISO lower-bound for a date preset (or null for "any"). */
function presetToDateFrom(preset: DatePreset): string | null {
  if (preset === 'ALL') return null;
  const now = new Date();
  if (preset === 'YTD') return new Date(now.getFullYear(), 0, 1).toISOString();
  const days = preset === '7D' ? 7 : preset === '30D' ? 30 : 90;
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

export function DocumentsCenter() {
  const [docs, setDocs] = useState<DocumentRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<DocType | 'ALL'>('ALL');
  const [linkFilter, setLinkFilter] = useState<LinkFilter>('ALL');
  const [datePreset, setDatePreset] = useState<DatePreset>('ALL');
  const [rawSearch, setRawSearch] = useState('');
  const [uploadType, setUploadType] = useState<DocType>('OTHER');
  const [uploading, setUploading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>('created_at');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const search = useDebounce(rawSearch, 300);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const params = new URLSearchParams();
      if (typeFilter !== 'ALL') params.set('doc_type', typeFilter);
      if (search.trim()) params.set('search', search.trim());
      if (linkFilter === 'UNFILED') params.set('linked', 'unfiled');
      else if (linkFilter === 'LINKED') params.set('linked', 'linked');
      else if (linkFilter !== 'ALL') params.set('entity_type', linkFilter);
      const dateFrom = presetToDateFrom(datePreset);
      if (dateFrom) params.set('date_from', dateFrom);
      const res = await fetch(`/api/documents?${params.toString()}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? 'Failed to load');
      setDocs((body.data ?? []) as DocumentRow[]);
      setSelected(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load documents');
      setDocs([]);
    }
  }, [typeFilter, search, linkFilter, datePreset]);

  useEffect(() => {
    void load();
  }, [load]);

  const counts = useMemo(() => {
    const total = docs?.length ?? 0;
    const bytes = (docs ?? []).reduce((s, d) => s + (d.size_bytes ?? 0), 0);
    const linked = (docs ?? []).filter((d) => d.entity_type).length;
    const unfiled = total - linked;
    return { total, bytes, linked, unfiled };
  }, [docs]);

  const sorted = useMemo(() => {
    const rows = [...(docs ?? [])];
    const dir = sortDir === 'asc' ? 1 : -1;
    rows.sort((a, b) => {
      let av: string | number = '';
      let bv: string | number = '';
      switch (sortKey) {
        case 'size_bytes':
          av = a.size_bytes ?? 0;
          bv = b.size_bytes ?? 0;
          break;
        case 'created_at':
          av = a.created_at ?? '';
          bv = b.created_at ?? '';
          break;
        case 'doc_type':
          av = DOC_TYPE_LABEL[a.doc_type] ?? a.doc_type;
          bv = DOC_TYPE_LABEL[b.doc_type] ?? b.doc_type;
          break;
        case 'entity_type':
          av = entityTypeLabel(a.entity_type);
          bv = entityTypeLabel(b.entity_type);
          break;
        default:
          av = (a.file_name ?? '').toLowerCase();
          bv = (b.file_name ?? '').toLowerCase();
      }
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
    return rows;
  }, [docs, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(key);
      setSortDir(key === 'file_name' || key === 'doc_type' || key === 'entity_type' ? 'asc' : 'desc');
    }
  }

  const allSelected = sorted.length > 0 && sorted.every((d) => selected.has(d.id));
  function toggleSelectAll() {
    setSelected(allSelected ? new Set() : new Set(sorted.map((d) => d.id)));
  }
  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

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

  /** Open a signed URL — inline for viewing, attachment for downloading. */
  async function openDoc(doc: DocumentRow, mode: 'view' | 'download') {
    try {
      const q = mode === 'view' ? '?download=0' : '';
      const res = await fetch(`/api/documents/${doc.id}/signed-url${q}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? 'Failed');
      window.open(body.url as string, '_blank', 'noopener,noreferrer');
    } catch (err) {
      addToast('error', err instanceof Error ? err.message : 'Could not open document');
    }
  }

  /** Bulk-download the selected documents (SAFE — no destructive bulk action). */
  async function downloadSelected() {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    setBulkBusy(true);
    let ok = 0;
    for (const id of ids) {
      try {
        const res = await fetch(`/api/documents/${id}/signed-url`);
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error ?? 'Failed');
        // Trigger a real download via a transient anchor (the signed URL already carries
        // Content-Disposition: attachment). Spaced slightly so the browser queues each.
        const a = document.createElement('a');
        a.href = body.url as string;
        a.rel = 'noopener noreferrer';
        a.download = (body.fileName as string) ?? '';
        document.body.appendChild(a);
        a.click();
        a.remove();
        ok += 1;
        await new Promise((r) => setTimeout(r, 350));
      } catch {
        /* keep going; report the shortfall below */
      }
    }
    setBulkBusy(false);
    if (ok > 0) addToast('success', `Downloading ${ok} document${ok === 1 ? '' : 's'}`);
    if (ok < ids.length) addToast('error', `${ids.length - ok} could not be downloaded`);
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

  const hasFilters = typeFilter !== 'ALL' || linkFilter !== 'ALL' || datePreset !== 'ALL' || !!search;
  function clearFilters() {
    setTypeFilter('ALL');
    setLinkFilter('ALL');
    setDatePreset('ALL');
    setRawSearch('');
  }

  return (
    <div className="space-y-5">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-4 text-xs">
          <span className="text-slate-500">{counts.total} document{counts.total === 1 ? '' : 's'}</span>
          {counts.linked > 0 && <span className="text-emerald-400">{counts.linked} linked</span>}
          {counts.unfiled > 0 && (
            <button
              type="button"
              onClick={() => setLinkFilter('UNFILED')}
              className="text-amber-400 hover:text-amber-300 inline-flex items-center gap-1"
              title="Show only unfiled documents"
            >
              <Inbox size={12} /> {counts.unfiled} unfiled
            </button>
          )}
          <span className="text-slate-500">
            Stored <span className="font-mono text-slate-300">{formatBytes(counts.bytes)}</span>
          </span>
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
            className="bg-slate-900 border border-slate-700 rounded-lg text-xs text-slate-200 pl-8 pr-3 py-1.5 w-56"
          />
        </div>

        {/* Linked-record type / unfiled */}
        <select
          value={linkFilter}
          onChange={(e) => setLinkFilter(e.target.value)}
          className="bg-slate-900 border border-slate-700 rounded-lg text-xs text-slate-200 px-2 py-1.5"
          title="Filter by the record a document is linked to"
        >
          <option value="ALL">All records</option>
          <option value="LINKED">Linked only</option>
          <option value="UNFILED">Unfiled only</option>
          <optgroup label="Linked record type">
            {LINKABLE_ENTITY_TYPES.map((et) => (
              <option key={et} value={et}>{entityTypeLabel(et)}</option>
            ))}
          </optgroup>
        </select>

        {/* Date range preset */}
        <select
          value={datePreset}
          onChange={(e) => setDatePreset(e.target.value as DatePreset)}
          className="bg-slate-900 border border-slate-700 rounded-lg text-xs text-slate-200 px-2 py-1.5"
          title="Filter by upload date"
        >
          {DATE_PRESETS.map((p) => (
            <option key={p.value} value={p.value}>{p.label}</option>
          ))}
        </select>

        <div className="flex items-center gap-1 flex-wrap">
          <FilterChip active={typeFilter === 'ALL'} onClick={() => setTypeFilter('ALL')}>All types</FilterChip>
          {DOC_TYPES.map((t) => (
            <FilterChip key={t} active={typeFilter === t} onClick={() => setTypeFilter(t)}>
              {DOC_TYPE_LABEL[t]}
            </FilterChip>
          ))}
        </div>

        {hasFilters && (
          <button
            type="button"
            onClick={clearFilters}
            className="text-[11px] text-slate-500 hover:text-slate-300 inline-flex items-center gap-1"
          >
            <X size={12} /> Clear
          </button>
        )}
      </div>

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-emerald-500/30 bg-emerald-600/10 px-4 py-2">
          <span className="text-xs text-emerald-300">{selected.size} selected</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={downloadSelected}
              disabled={bulkBusy}
              className="px-3 py-1.5 text-xs font-medium bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded-lg inline-flex items-center gap-1.5"
            >
              {bulkBusy ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
              Download selected
            </button>
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              className="px-3 py-1.5 text-xs font-medium text-slate-400 hover:text-slate-200 rounded-lg"
            >
              Clear
            </button>
          </div>
        </div>
      )}

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
      ) : sorted.length === 0 ? (
        <div className="card p-12 text-center">
          <FolderOpen className="w-10 h-10 mx-auto text-slate-600 mb-3" />
          <p className="text-sm text-slate-300 mb-1">
            {hasFilters ? 'No documents match your filter' : 'No documents yet'}
          </p>
          <p className="text-xs text-slate-500 max-w-md mx-auto mb-4">
            Upload contracts, bills, statements, policies, W-9s, and COIs. Source documents from
            drop-and-parse features are retained here and linked to the record they created.
          </p>
          {hasFilters ? (
            <button
              type="button"
              onClick={clearFilters}
              className="px-4 py-2 text-sm font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg inline-flex items-center gap-1.5"
            >
              <X size={14} /> Clear filters
            </button>
          ) : (
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="px-4 py-2 text-sm font-medium bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg inline-flex items-center gap-1.5"
            >
              <Upload size={14} /> Upload a document
            </button>
          )}
        </div>
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-slate-800 text-[10px] uppercase tracking-wider text-slate-500">
                  <th className="px-3 py-2.5 w-8">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleSelectAll}
                      className="accent-emerald-500 cursor-pointer"
                      aria-label="Select all"
                    />
                  </th>
                  <SortHeader label="Document" col="file_name" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                  <SortHeader label="Type" col="doc_type" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                  <SortHeader label="Linked to" col="entity_type" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                  <SortHeader label="Size" col="size_bytes" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} align="right" />
                  <SortHeader label="Uploaded" col="created_at" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                  <th className="px-4 py-2.5 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((doc) => {
                  const href = entityRecordHref(doc.entity_type, doc.entity_id);
                  const isSel = selected.has(doc.id);
                  return (
                    <tr key={doc.id} className={clsx('border-b border-slate-800/60 hover:bg-slate-900/40', isSel && 'bg-emerald-600/5')}>
                      <td className="px-3 py-2.5">
                        <input
                          type="checkbox"
                          checked={isSel}
                          onChange={() => toggleOne(doc.id)}
                          className="accent-emerald-500 cursor-pointer"
                          aria-label={`Select ${doc.file_name}`}
                        />
                      </td>
                      <td className="px-4 py-2.5">
                        <button
                          type="button"
                          onClick={() => openDoc(doc, 'view')}
                          className="flex items-center gap-2 min-w-0 text-left group"
                          title="View"
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
                          href ? (
                            <Link
                              href={href}
                              className="inline-flex items-center gap-1 text-[11px] text-slate-300 hover:text-emerald-300 group"
                              title={`Open ${entityTypeLabel(doc.entity_type)} record`}
                            >
                              <Link2 size={11} className="text-emerald-500" />
                              <span className="font-medium group-hover:underline">{entityTypeLabel(doc.entity_type)}</span>
                              {doc.entity_id && (
                                <span className="font-mono text-slate-600 truncate max-w-[7rem]">{doc.entity_id.slice(0, 8)}</span>
                              )}
                            </Link>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-[11px] text-slate-400">
                              <Link2 size={11} className="text-emerald-500" />
                              <span className="font-medium text-slate-300">{entityTypeLabel(doc.entity_type)}</span>
                            </span>
                          )
                        ) : (
                          <span className="inline-flex items-center gap-1 text-[11px] text-amber-500/80">
                            <Inbox size={11} /> Unfiled
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right text-[11px] font-mono text-slate-400">{formatBytes(doc.size_bytes)}</td>
                      <td className="px-4 py-2.5 text-[11px] text-slate-500">{fmtDate(doc.created_at)}</td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center justify-end gap-1">
                          <button type="button" onClick={() => openDoc(doc, 'view')} title="View" className="p-1.5 text-slate-500 hover:text-blue-300 rounded">
                            <Eye size={13} />
                          </button>
                          <button type="button" onClick={() => openDoc(doc, 'download')} title="Download" className="p-1.5 text-slate-500 hover:text-emerald-300 rounded">
                            <Download size={13} />
                          </button>
                          <button type="button" onClick={() => remove(doc)} title="Delete" className="p-1.5 text-slate-500 hover:text-red-400 rounded">
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function SortHeader({
  label,
  col,
  sortKey,
  sortDir,
  onSort,
  align = 'left',
}: {
  label: string;
  col: SortKey;
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (k: SortKey) => void;
  align?: 'left' | 'right';
}) {
  const active = sortKey === col;
  return (
    <th className={clsx('px-4 py-2.5 font-medium', align === 'right' && 'text-right')}>
      <button
        type="button"
        onClick={() => onSort(col)}
        className={clsx(
          'inline-flex items-center gap-1 uppercase tracking-wider hover:text-slate-300',
          active ? 'text-slate-300' : 'text-slate-500',
        )}
      >
        {label}
        <ArrowUpDown size={10} className={clsx(active ? 'opacity-100' : 'opacity-40')} />
        {active && <span className="text-[8px]">{sortDir === 'asc' ? '▲' : '▼'}</span>}
      </button>
    </th>
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

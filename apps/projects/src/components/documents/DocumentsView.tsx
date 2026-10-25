'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  Button, Dialog, Field, InlineNotice, Input, QueueTable, Search, Select, Tag, WidgetState, count, toast, useDebounce, type QueueColumn,
} from '@meritbooks/merit-ui';
import { DOC_KINDS, KIND_LABEL, type DocKind, type FolderRow } from '@/lib/documents/types';
import type { FileListItem } from '@/lib/documents/store';
import type { JobOption } from '@/lib/pm/ops/scope';
import { JobSelect } from '@/components/ops/common/bits';
import { useShell } from '@/components/shell/ShellContext';
import { FilePanel, type FilePerms } from './FilePanel';
import { bytesLabel, postForm, when } from './client';

export interface DocumentsViewProps {
  jobs: JobOption[];
  jobId: string | null;
  folderId: string | null;
  kind: DocKind | null;
  q: string;
  folders: FolderRow[];
  counts: Record<string, number>;
  files: FileListItem[];
  perms: FilePerms;
  readOnly: boolean;
  /** Folder names shown for money folders the caller cannot open. */
  jobLabel: string;
  /** The signed-in user (the sender finishes their own signature requests). */
  userId: string;
}

/** Documents of a job: folders from the pack, versioned files, upload (drag and drop), the file panel. */
export function DocumentsView(p: DocumentsViewProps) {
  const shell = useShell();
  const readOnly = p.readOnly || shell.readOnly;
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [cursor, setCursor] = useState<string | null>(sp.get('file'));
  const [query, setQuery] = useState(p.q);
  const debounced = useDebounce(query, 300);
  const [uploading, setUploading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [folderOpen, setFolderOpen] = useState(false);
  const input = useRef<HTMLInputElement | null>(null);
  const folders = useMemo(() => new Map(p.folders.map((f) => [f.id, f])), [p.folders]);

  const go = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(patch)) { if (v) next.set(k, v); else next.delete(k); }
    router.push(`${pathname}?${next.toString()}`);
  };

  useEffect(() => { if (debounced !== p.q) go({ q: debounced || null }); }, [debounced]); // eslint-disable-line react-hooks/exhaustive-deps

  const upload = async (files: FileList | File[]) => {
    if (!p.jobId) return;
    setError(null);
    const list = [...files].slice(0, 20);
    let ok = 0;
    for (const file of list) {
      setUploading(`${ok + 1} of ${list.length}: ${file.name}`);
      const form = new FormData();
      form.set('file', file);
      form.set('jobId', p.jobId);
      if (p.folderId) form.set('folderId', p.folderId);
      if (p.kind) form.set('kind', p.kind);
      form.set('tzOffset', String(new Date().getTimezoneOffset()));
      if (file.lastModified) form.set('takenAt', new Date(file.lastModified).toISOString());
      const r = await postForm<{ file_id: string }>('/api/documents', form);
      if (r.error) { setError(`${file.name}: ${r.error}`); break; }
      ok += 1;
      if (list.length === 1 && r.data) setCursor(r.data.file_id);
    }
    setUploading(null);
    if (ok) { toast(`Uploaded ${count(ok)} file${ok === 1 ? '' : 's'}`); router.refresh(); }
  };

  const columns: QueueColumn<FileListItem>[] = [
    { id: 't', header: 'Document', cell: (f) => (
      <>
        <span className="l1">{f.title}
          <span className="docs-row-tags">
            {f.current?.locked && <Tag tone="pos">Signed</Tag>}
            {f.signature === 'sent' && <Tag tone="ai">Out for signature</Tag>}
            {f.signature === 'declined' && <Tag tone="neg">Declined</Tag>}
            {f.legal_hold && <Tag tone="warn">Hold</Tag>}
          </span>
        </span>
        <span className="l2">{[KIND_LABEL[f.kind], f.current?.file_name, bytesLabel(f.current?.size_bytes)].filter(Boolean).join(' · ')}</span>
      </>
    ) },
    { id: 'folder', header: 'Folder', width: 180, cell: (f) => <span className="l2">{f.folder_id ? folders.get(f.folder_id)?.name ?? '—' : '—'}</span> },
    { id: 'v', header: 'Version', width: 80, numeric: true, cell: (f) => <span className="ops-num">v{f.current?.version_no ?? f.version_count}</span> },
    { id: 'u', header: 'Updated', width: 150, cell: (f) => <span className="l2">{when(f.updated_at)}</span> },
  ];

  if (!p.jobId) {
    return (
      <div className="stack">
        <div className="ops-toolbar">
          <Field label="Job"><JobSelect jobs={p.jobs} value="" onChange={(id) => go({ job: id, folder: null, file: null })} /></Field>
        </div>
        <WidgetState state={{ kind: 'empty', title: 'Pick a job to see its documents', body: 'Each job gets folders from its industry template: contract, drawings, change orders, photos and closeout.' }} />
      </div>
    );
  }

  const total = Object.values(p.counts).reduce((s, n) => s + n, 0);
  return (
    <div className="stack">
      <div className="ops-toolbar">
        <Field label="Job"><JobSelect jobs={p.jobs} value={p.jobId} onChange={(id) => go({ job: id || null, folder: null, file: null })} /></Field>
        <Field label="Kind">
          <Select value={p.kind ?? ''} onChange={(e) => go({ kind: e.target.value || null })}>
            <option value="">Every kind</option>
            {DOC_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
          </Select>
        </Field>
        <Search aria-label="Search titles" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search titles" slashToFocus />
        <span className="sp" />
        {!readOnly && p.perms.create && (
          <>
            <Button variant="quiet" icon="plus" onClick={() => setFolderOpen(true)}>Folder</Button>
            <Button variant="primary" icon="upload" chord="u" bindChord disabled={!!uploading} onClick={() => input.current?.click()}>Upload</Button>
            <input ref={input} type="file" multiple className="sr" aria-hidden="true" tabIndex={-1} onChange={(e) => { if (e.target.files) void upload(e.target.files); e.target.value = ''; }} />
          </>
        )}
      </div>
      {uploading && <InlineNotice title="Uploading">{uploading}</InlineNotice>}
      {error && <InlineNotice tone="neg" title="Upload stopped.">{error}</InlineNotice>}
      <div className={cursor ? 'docs has-panel' : 'docs'}>
        <nav className="docs-tree" aria-label="Folders">
          <h3 className="t-cap">{p.jobLabel}</h3>
          <ul>
            <li><button type="button" aria-current={!p.folderId} onClick={() => go({ folder: null })}>All documents <span className="n">{count(total)}</span></button></li>
            {p.folders.filter((f) => !f.parent_id).map((f) => (
              <li key={f.id}>
                <button type="button" aria-current={p.folderId === f.id} onClick={() => go({ folder: f.id })} title={f.money_cap ? 'Money folder: only people with access to job dollars see its documents' : undefined}>
                  {f.name}{f.money_cap ? <span className="lock" aria-label="money folder"> $</span> : null}
                  <span className="n">{p.counts[f.id] ? count(p.counts[f.id]) : ''}</span>
                </button>
              </li>
            ))}
            {p.counts.none ? <li><button type="button" aria-current={false} onClick={() => go({ folder: null })}>No folder <span className="n">{count(p.counts.none)}</span></button></li> : null}
          </ul>
        </nav>
        <div
          className="mp-table" style={{ minWidth: 0 }}
          onDragOver={(e) => { if (!readOnly && p.perms.create) { e.preventDefault(); setOver(true); } }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); if (!readOnly && p.perms.create && e.dataTransfer.files.length) void upload(e.dataTransfer.files); }}
        >
          {p.files.length === 0 ? (
            <div className={over ? 'docs-drop over' : 'docs-drop'}>
              <WidgetState state={{ kind: 'empty', title: p.q || p.kind ? 'Nothing matches' : p.folderId ? 'This folder is empty' : 'No documents on this job yet',
                body: readOnly || !p.perms.create ? 'Documents added to this job appear here.' : 'Drop files here, or upload. Photos keep their camera time and location.',
                action: readOnly || !p.perms.create ? undefined : <Button variant="primary" icon="upload" onClick={() => input.current?.click()}>Upload</Button> }} />
            </div>
          ) : (
            <>
              <QueueTable aria-label="Documents" columns={columns} rows={p.files} getRowId={(f) => f.id} cursorId={cursor}
                onCursorChange={setCursor} onOpen={(f) => setCursor(f.id)} rowState={(f) => ({ done: f.status === 'archived' })} />
              <p className="t-cap" style={{ padding: 12 }}>{count(p.files.length)} shown{over ? ' · drop to upload' : ' · drag files here to upload into this folder'}</p>
            </>
          )}
        </div>
        {cursor && <FilePanel key={cursor} fileId={cursor} userId={p.userId} folders={p.folders} perms={p.perms} readOnly={readOnly} onClose={() => setCursor(null)} onChanged={() => router.refresh()} />}
      </div>
      <NewFolder open={folderOpen} onClose={() => setFolderOpen(false)} jobId={p.jobId} onDone={() => router.refresh()} />
    </div>
  );
}

function NewFolder({ open, onClose, jobId, onDone }: { open: boolean; onClose: () => void; jobId: string; onDone: () => void }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const res = await fetch('/api/documents/folders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId, name: name.trim() }) });
    setBusy(false);
    if (!res.ok) { toast.error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? 'Not added.'); return; }
    toast('Added the folder');
    setName('');
    onClose();
    onDone();
  };
  return (
    <Dialog open={open} onClose={onClose} title="New folder" width={420}
      actions={<><Button variant="quiet" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy || !name.trim()} onClick={() => void save()}>Add folder</Button></>}>
      <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) void save(); }} /></Field>
    </Dialog>
  );
}

'use client';

/**
 * AttachmentsPanel — a reusable "documents on this record" panel (merit-ui).
 *
 * Drop it onto ANY record page (a bill, invoice, lease, loan, policy, journal entry,
 * vendor, customer, job, …) to show that record's retained source documents and add
 * more. It talks only to /api/documents, scoped by (entityType, entityId), so it needs
 * no per-page wiring beyond those two props.
 *
 *   <AttachmentsPanel entityType="BILL" entityId={bill.id} defaultDocType="BILL" />
 *
 * States: loading, empty, error (with Try again), populated. Upload is multipart
 * (FormData → POST) from the Attach button or by dropping files on the panel.
 * Open uses a short-lived signed URL. Remove asks first (inline, so it never fights
 * the drawer it sits in for Escape or focus).
 *
 * Kit classes + a CSS module only — it renders the same inside a bridged (legacy)
 * page and a ported one.
 */

import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { Button, Tag, cx } from '@meritbooks/merit-ui';
import { addToast } from '@/hooks/use-toast';
import {
  DOC_TYPE_LABEL,
  formatBytes,
  MAX_DOCUMENT_BYTES,
  type DocType,
  type DocumentRow,
} from '@/lib/documents/schema';
import s from './attachments-panel.module.css';

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
  const [over, setOver] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
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
    setRemoving(true);
    const res = await fetch(`/api/documents/${doc.id}`, { method: 'DELETE' });
    setRemoving(false);
    setConfirmId(null);
    if (res.ok) {
      addToast('success', 'Document removed');
      void load();
    } else {
      const b = await res.json().catch(() => null);
      addToast('error', b?.error ?? 'Failed to remove document');
    }
  }

  const onDrop = (e: DragEvent<HTMLElement>) => {
    e.preventDefault();
    setOver(false);
    if (!uploading && e.dataTransfer.files?.length) void onFiles(e.dataTransfer.files);
  };

  return (
    <section
      className={cx(s.panel, over && s.over, className)}
      aria-label={title}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
    >
      <div className={s.head}>
        <div className={s.title}>
          <h3 className="t-head">{title}</h3>
          {docs && docs.length > 0 && <span className="tag tnum">{docs.length}</span>}
        </div>
        <Button icon="upload" onClick={() => inputRef.current?.click()} disabled={uploading} aria-busy={uploading || undefined}>
          {uploading ? 'Uploading…' : 'Attach'}
        </Button>
        <input
          ref={inputRef}
          type="file"
          multiple
          className="sr"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(e) => onFiles(e.target.files)}
        />
      </div>

      {docs === null ? (
        <div className={cx('wg-loading', s.skel)} aria-busy="true">
          <span className="bar-l" style={{ width: '70%' }} aria-hidden="true" />
          <span className="bar-l" style={{ width: '45%' }} aria-hidden="true" />
          <span className="t-cap" role="status">Loading documents…</span>
        </div>
      ) : error ? (
        <div className={s.state} role="alert">
          <Tag tone="neg">Not loaded</Tag>
          <p className="ink-2">Couldn&apos;t load the documents: {error}</p>
          <Button variant="quiet" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      ) : docs.length === 0 ? (
        <div className={s.state}>
          <span className="t-head">No documents yet</span>
          <p className="t-cap">Attach the bill, contract or supporting file for this record — or drop it here.</p>
        </div>
      ) : (
        <ul className={s.list}>
          {docs.map((doc) => (
            <li key={doc.id}>
              <div className={s.item}>
                <button type="button" onClick={() => download(doc)} className={s.file} title={`Open ${doc.file_name}`}>
                  <span className={s.name}>{doc.file_name}</span>
                  <span className={cx('t-cap', s.meta)}>{DOC_TYPE_LABEL[doc.doc_type]}</span>
                  <span className={cx('t-cap tnum', s.meta)}>{formatBytes(doc.size_bytes)}</span>
                </button>
                <span className={s.acts}>
                  <Button variant="quiet" onClick={() => download(doc)}>
                    Open
                  </Button>
                  <Button variant="quiet" onClick={() => setConfirmId(doc.id)} disabled={removing}>
                    Remove
                  </Button>
                </span>
              </div>
              {confirmId === doc.id && (
                <div className={s.confirm} role="alertdialog" aria-label={`Remove ${doc.file_name}`}>
                  <span className="ink-2">Remove &ldquo;{doc.file_name}&rdquo;? This deletes the stored file.</span>
                  <span className={s.acts}>
                    <Button onClick={() => setConfirmId(null)} disabled={removing}>
                      Keep it
                    </Button>
                    <Button variant="danger" onClick={() => void remove(doc)} disabled={removing} aria-busy={removing || undefined}>
                      {removing ? 'Removing…' : 'Remove file'}
                    </Button>
                  </span>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

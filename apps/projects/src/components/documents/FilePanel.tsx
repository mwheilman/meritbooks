'use client';

import { useRef, useState } from 'react';
import {
  Button, Check, ConfirmDialog, Field, InlineNotice, Input, Panel, PanelSection, Select, Status, Tag, Textarea, WidgetState, api, toast,
} from '@meritbooks/merit-ui';
import { KIND_LABEL, RETENTION_CLASSES, RETENTION_LABEL, type FolderRow, type RetentionClass } from '@/lib/documents/types';
import type { FileDetail } from '@/lib/documents/store';
import { useDetail } from '@/components/ops/common/useOps';
import { EnvelopeCard } from '@/components/esign/EnvelopeCard';
import { SendForSignature } from '@/components/esign/SendForSignature';
import { bytesLabel, day, postForm, when } from './client';

const SOURCE_WORD: Record<string, string> = { upload: 'Uploaded', template: 'Generated', esign: 'Signed copy', drawing_split: 'From a set', restore: 'Restored', import: 'Imported' };

export interface FilePerms { create: boolean; edit: boolean; delete: boolean }

/** One document: current version, history, signature requests, retention / legal hold, details. */
export function FilePanel({ fileId, userId, folders, perms, readOnly, onClose, onChanged }: {
  fileId: string; userId: string; folders: FolderRow[]; perms: FilePerms; readOnly: boolean; onClose: () => void; onChanged: () => void;
}) {
  const [version, setVersion] = useState(0);
  const { data, error, isLoading, refetch } = useDetail<FileDetail>(`/api/documents/${fileId}`, version);
  const bump = () => { setVersion((v) => v + 1); onChanged(); };
  const [sendOpen, setSendOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [holdOpen, setHoldOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  if (!data) {
    return (
      <Panel title="Document" onClose={onClose}>
        <PanelSection>
          {error ? <WidgetState state={{ kind: 'error', title: 'The document did not load', body: error, onRetry: () => void refetch(), retryLabel: 'Try again' }} />
            : <WidgetState state={{ kind: 'loading', label: isLoading ? 'Loading the document…' : 'Opening…', lines: 5 }} />}
        </PanelSection>
      </Panel>
    );
  }

  const f = data.file;
  const cur = data.versions.find((v) => v.is_current) ?? null;
  const openEnv = data.envelopes.find((e) => e.status === 'sent' || e.status === 'draft');
  const locked = !!cur?.locked;
  const canSend = !readOnly && perms.create && !!cur && cur.mime_type === 'application/pdf' && !locked && !openEnv && f.status === 'active';
  const canVersion = !readOnly && perms.create && f.status === 'active' && !f.legal_hold && !locked && !openEnv;

  const call = async (key: string, method: 'post' | 'patch' | 'delete', url: string, body: unknown, ok: string): Promise<boolean> => {
    setBusy(key);
    const r = method === 'patch' ? await api.patch(url, body) : method === 'delete' ? await api.delete(url) : await api.post(url, body);
    setBusy(null);
    if (r.error) { setFailure(r.error.error); toast.error(r.error.error); return false; }
    setFailure(null);
    toast(ok);
    bump();
    return true;
  };

  const uploadVersion = async (file: File) => {
    const form = new FormData();
    form.set('file', file);
    setBusy('version');
    const r = await postForm<{ version_no: number }>(`/api/documents/${fileId}/versions`, form);
    setBusy(null);
    if (r.error) { setFailure(r.error); toast.error(r.error); return; }
    toast(`Uploaded version ${r.data?.version_no ?? ''}`.trim());
    bump();
  };

  return (
    <Panel eyebrow={[KIND_LABEL[f.kind], f.money_cap ? 'Money document' : null].filter(Boolean)} title={f.title}
      meta={[cur ? `Version ${cur.version_no}` : null, cur ? bytesLabel(cur.size_bytes) : null, `updated ${when(f.updated_at)}`].filter(Boolean).join(' · ')}
      onClose={onClose}
      foot={readOnly ? undefined : (
        <div className="btn-row" style={{ width: '100%' }}>
          {perms.delete && <Button variant="quiet" onClick={() => setRemoveOpen(true)} disabled={f.legal_hold || locked}>Remove</Button>}
          <span className="sp" style={{ flex: 1 }} />
          {canVersion && <Button icon="upload" disabled={busy === 'version'} onClick={() => fileInput.current?.click()}>New version</Button>}
          {canSend && <Button variant="primary" onClick={() => setSendOpen(true)}>Send for signature</Button>}
          <input ref={fileInput} type="file" className="sr" aria-hidden="true" tabIndex={-1} onChange={(e) => { const x = e.target.files?.[0]; e.target.value = ''; if (x) void uploadVersion(x); }} />
        </div>
      )}>
      <PanelSection>
        <div className="btn-row">
          {locked && <Tag tone="pos">Signed</Tag>}
          {f.legal_hold && <Tag tone="warn">Legal hold</Tag>}
          {openEnv && <Tag tone="ai">Out for signature</Tag>}
          {f.status === 'archived' && <Tag>Archived</Tag>}
          {f.retain_until && <span className="t-cap">Keep until {day(f.retain_until)}</span>}
        </div>
        {cur?.url && (
          <p style={{ marginTop: 8 }}>
            <a className="btn" href={cur.url} target="_blank" rel="noreferrer">Open {cur.file_name}</a>
          </p>
        )}
        {f.kind === 'photo' && cur?.url && <img className="docs-photo" style={{ marginTop: 8 }} src={cur.url} alt={f.title} />}
        {data.photo && (
          <p className="t-cap" style={{ marginTop: 8 }}>
            {data.photo.taken_at ? `Taken ${when(data.photo.taken_at)} (${data.photo.taken_at_source === 'exif' ? 'camera' : 'device'} time)` : 'No capture time in the photo'}
            {' · '}received {when(data.photo.received_at)}
            {data.photo.gps_lat !== null && data.photo.gps_lng !== null ? <> · <a href={`https://www.openstreetmap.org/?mlat=${data.photo.gps_lat}&mlon=${data.photo.gps_lng}#map=18/${data.photo.gps_lat}/${data.photo.gps_lng}`} target="_blank" rel="noreferrer">{Number(data.photo.gps_lat).toFixed(5)}, {Number(data.photo.gps_lng).toFixed(5)}</a></> : null}
            {data.photo.device_make ? ` · ${[data.photo.device_make, data.photo.device_model].filter(Boolean).join(' ')}` : ''}
          </p>
        )}
        {cur?.content_sha256 && <p className="docs-hash" style={{ marginTop: 6 }}>SHA-256 {cur.content_sha256}</p>}
        {failure && <div style={{ marginTop: 8 }}><InlineNotice tone="neg" title="Not changed.">{failure}</InlineNotice></div>}
      </PanelSection>

      {(data.envelopes.length > 0) && (
        <PanelSection title="Signatures">
          <div className="stack">
            {data.envelopes.map((e) => <EnvelopeCard key={e.id} env={e} signers={e.signers} events={e.events} pendingEvents={e.pendingEvents} isSender={e.sender_user === userId} canEdit={!readOnly && perms.edit} subjectTable={f.subject_table} onChanged={bump} />)}
          </div>
        </PanelSection>
      )}

      <PanelSection title={`Versions (${data.versions.length})`}>
        <ol className="docs-versions">
          {data.versions.map((v) => (
            <li key={v.id} className={v.is_current ? undefined : 'old'}>
              <span className="vno">v{v.version_no}</span>
              <span>
                {v.url ? <a href={v.url} target="_blank" rel="noreferrer">{v.file_name}</a> : v.file_name}
                <span className="t-cap" style={{ display: 'block' }}>{[SOURCE_WORD[v.source], v.label, when(v.created_at), bytesLabel(v.size_bytes), v.note].filter(Boolean).join(' · ')}</span>
              </span>
              <span>
                {v.is_current ? <Status kind="ready" pip="closed">{v.locked ? 'Current · signed' : 'Current'}</Status>
                  : !readOnly && perms.edit && canVersion ? <Button variant="quiet" disabled={busy === v.id} onClick={() => void call(v.id, 'post', `/api/documents/${fileId}/versions/${v.id}`, {}, `Restored version ${v.version_no}`)}>Restore</Button>
                    : <span className="t-cap">Superseded</span>}
              </span>
            </li>
          ))}
        </ol>
      </PanelSection>

      {f.job_id && <PortalShare key={`${f.id}:${(f.portal_audiences ?? []).join(',')}`} fileId={f.id} initial={f.portal_audiences ?? []} costDoc={f.money_cap === 'projects.financials'} canEdit={!readOnly && perms.edit && f.status === 'active'} onSaved={bump} />}

      {!readOnly && perms.edit && <Details key={`${f.id}:${f.updated_at}`} fileId={fileId} title={f.title} folderId={f.folder_id} description={f.description} tags={f.tags} folders={folders} archived={f.status === 'archived'} onSaved={bump} hold={f.legal_hold} />}

      <PanelSection title="Records">
        <Records key={`${f.retention_class}:${f.retain_until}`} fileId={fileId} retentionClass={f.retention_class} retainUntil={f.retain_until} canEdit={!readOnly && perms.edit} onSaved={bump} />
        <div style={{ marginTop: 12 }}>
          {f.legal_hold ? (
            <InlineNotice tone="warn" title="On legal hold">{f.legal_hold_reason} {f.legal_hold_at ? `(since ${when(f.legal_hold_at)})` : ''}</InlineNotice>
          ) : <p className="t-cap">Not on legal hold.</p>}
          {!readOnly && perms.delete && (
            f.legal_hold
              ? <Button variant="quiet" disabled={busy === 'hold'} onClick={() => void call('hold', 'post', `/api/documents/${fileId}/records`, { op: 'release' }, 'Released the legal hold')}>Release hold</Button>
              : <Button variant="quiet" onClick={() => setHoldOpen(true)}>Place on legal hold</Button>
          )}
        </div>
      </PanelSection>

      <SendForSignature open={sendOpen} onClose={() => setSendOpen(false)} fileId={fileId} title={f.title} subjectTable={f.subject_table} subjectId={f.subject_id} onSent={bump} />
      <ConfirmDialog open={removeOpen} onClose={() => setRemoveOpen(false)} tone="danger" title="Remove this document" confirmLabel="Remove"
        reason={{ label: 'Why', minLength: 3 }}
        onConfirm={async (reason) => {
          const res = await fetch(`/api/documents/${fileId}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }) });
          if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? 'Not removed.');
          toast('Removed the document');
          onChanged();
          onClose();
        }}>
        {f.title}. It stays in the audit record and Books&apos; document center keeps the file; it leaves this list.
      </ConfirmDialog>
      <ConfirmDialog open={holdOpen} onClose={() => setHoldOpen(false)} title="Place on legal hold" confirmLabel="Place hold"
        reason={{ label: 'Reason (claim, dispute, audit)', minLength: 3 }}
        onConfirm={async (reason) => { if (!(await call('hold', 'post', `/api/documents/${fileId}/records`, { op: 'hold', reason }, 'Placed on legal hold'))) throw new Error('Not placed.'); }}>
        While on hold nobody can remove the document, replace its version or shorten how long it is kept.
      </ConfirmDialog>
    </Panel>
  );
}

function Details({ fileId, title, folderId, description, tags, folders, archived, hold, onSaved }: {
  fileId: string; title: string; folderId: string | null; description: string | null; tags: string[]; folders: FolderRow[]; archived: boolean; hold: boolean; onSaved: () => void;
}) {
  const [t, setT] = useState(title);
  const [fo, setFo] = useState(folderId ?? '');
  const [d, setD] = useState(description ?? '');
  const [tg, setTg] = useState(tags.join(', '));
  const [busy, setBusy] = useState(false);
  const save = async (extra: Record<string, unknown> = {}) => {
    setBusy(true);
    const r = await api.patch(`/api/documents/${fileId}`, { title: hold ? undefined : t.trim() || undefined, folderId: fo || null, description: d.trim() || null, tags: tg.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 20), ...extra });
    setBusy(false);
    if (r.error) { toast.error(r.error.error); return; }
    toast('Saved');
    onSaved();
  };
  return (
    <PanelSection title="Details">
      <form className="mp-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <Field label="Title"><Input value={t} onChange={(e) => setT(e.target.value)} maxLength={200} disabled={hold} /></Field>
        <Field label="Folder">
          <Select value={fo} onChange={(e) => setFo(e.target.value)}>
            <option value="">No folder</option>
            {folders.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </Select>
        </Field>
        <Field label="Notes"><Textarea value={d} onChange={(e) => setD(e.target.value)} maxLength={2000} rows={2} /></Field>
        <Field label="Tags" help="Comma separated: room, phase, trade"><Input value={tg} onChange={(e) => setTg(e.target.value)} maxLength={400} /></Field>
        <div className="btn-row">
          <Button type="submit" disabled={busy}>Save</Button>
          <Button variant="quiet" disabled={busy} onClick={() => void save({ status: archived ? 'active' : 'archived' })}>{archived ? 'Unarchive' : 'Archive'}</Button>
        </div>
      </form>
    </PanelSection>
  );
}

function Records({ fileId, retentionClass, retainUntil, canEdit, onSaved }: { fileId: string; retentionClass: RetentionClass; retainUntil: string | null; canEdit: boolean; onSaved: () => void }) {
  const [rc, setRc] = useState<RetentionClass>(retentionClass);
  const [until, setUntil] = useState(retainUntil ?? '');
  const [busy, setBusy] = useState(false);
  if (!canEdit) return <p>{RETENTION_LABEL[retentionClass]}{retainUntil ? ` · keep until ${day(retainUntil)}` : ' · clock starts when the record is final'}</p>;
  return (
    <form className="mp-form-2" onSubmit={async (e) => {
      e.preventDefault();
      setBusy(true);
      const r = await api.post(`/api/documents/${fileId}/records`, { op: 'retention', retentionClass: rc, retainUntil: until || null });
      setBusy(false);
      if (r.error) { toast.error(r.error.error); return; }
      toast('Saved retention');
      onSaved();
    }}>
      <Field label="Retention">
        <Select value={rc} onChange={(e) => setRc(e.target.value as RetentionClass)}>
          {RETENTION_CLASSES.map((c) => <option key={c} value={c}>{RETENTION_LABEL[c]}</option>)}
        </Select>
      </Field>
      <Field label="Keep until" help="Set automatically when signed">
        <Input type="date" value={until} onChange={(e) => setUntil(e.target.value)} />
      </Field>
      <div><Button type="submit" disabled={busy}>Save retention</Button></div>
    </form>
  );
}

type PortalAudience = 'customer' | 'vendor' | 'lender' | 'investor';
const PORTAL_WORD: Record<PortalAudience, string> = { customer: 'Customer', vendor: 'Subs and vendors', lender: 'Lender', investor: 'Investors' };

/** "Share to portal" (1118): which portal audiences see this document. Cost documents never reach customers or investors. */
function PortalShare({ fileId, initial, costDoc, canEdit, onSaved }: { fileId: string; initial: PortalAudience[]; costDoc: boolean; canEdit: boolean; onSaved: () => void }) {
  const [on, setOn] = useState<ReadonlySet<PortalAudience>>(new Set(initial));
  const [busy, setBusy] = useState(false);
  const toggle = async (a: PortalAudience, next: boolean) => {
    const set = new Set(on);
    if (next) set.add(a); else set.delete(a);
    setBusy(true);
    const r = await api.post<{ audiences: PortalAudience[] }>('/api/portal/staff/share', { fileId, audiences: [...set] });
    setBusy(false);
    if (r.error) return void toast.error(r.error.error);
    setOn(new Set(r.data?.audiences ?? [...set]));
    toast(next ? `Shared with the ${PORTAL_WORD[a].toLowerCase()} portal` : `No longer on the ${PORTAL_WORD[a].toLowerCase()} portal`);
    onSaved();
  };
  return (
    <PanelSection title="Share to portal">
      <div className="stack" style={{ gap: 6 }}>
        {(Object.keys(PORTAL_WORD) as PortalAudience[]).map((a) => {
          const blocked = costDoc && (a === 'customer' || a === 'investor');
          return (
            <Check key={a} label={blocked ? `${PORTAL_WORD[a]} (cost documents are never shared here)` : PORTAL_WORD[a]} checked={on.has(a)} disabled={!canEdit || busy || blocked} onChange={(e) => void toggle(a, e.target.checked)} />
          );
        })}
      </div>
      <p className="t-cap" style={{ marginTop: 8 }}>Shared documents show on the job in each portal once the company is live.</p>
    </PanelSection>
  );
}

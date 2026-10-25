'use client';

import { useState } from 'react';
import { Button, InlineNotice, Input, Textarea } from '@meritbooks/merit-ui';
import { portalPost } from '@/lib/portal/client';
import { date } from '@/lib/portal/format';
import { t } from '@/lib/portal/i18n';
import type { Locale, TaskResponse } from '@/lib/portal/types';
import { UploadField } from './UploadField';

/** Confirm / can't make it / propose a date on one assignment. */
export function AssignmentActions({ orgId, taskId, response, locale }: { orgId: string; taskId: string; response: TaskResponse | null; locale: Locale }) {
  const [mode, setMode] = useState<'idle' | 'decline' | 'propose'>('idle');
  const [note, setNote] = useState('');
  const [day, setDay] = useState('');
  const [state, setState] = useState<TaskResponse | null>(response);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async (r: 'confirmed' | 'declined' | 'proposed') => {
    setBusy(true); setError(null);
    const res = await portalPost('/api/portal/actions', { op: 'task', orgId, taskId, response: r, proposedStart: r === 'proposed' ? day : null, note: note.trim() || null });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    setState({ response: r, proposed_start: r === 'proposed' ? day : null, resolution: null });
    setMode('idle');
  };
  const word = state?.response === 'confirmed' ? t(locale, 'work.confirmed')
    : state?.response === 'proposed' ? t(locale, 'work.proposed', { date: date(state.proposed_start, locale) })
    : state?.response === 'declined' ? t(locale, 'work.declined') : null;
  return (
    <div>
      {word && <p className="pt-cap" role="status">{word}</p>}
      {mode === 'idle' ? (
        <div className="pt-actions">
          <Button variant="primary" disabled={busy} onClick={() => void send('confirmed')}>{t(locale, 'work.confirm')}</Button>
          <Button disabled={busy} onClick={() => setMode('propose')}>{t(locale, 'work.propose')}</Button>
          <Button variant="quiet" disabled={busy} onClick={() => setMode('decline')}>{t(locale, 'work.decline')}</Button>
        </div>
      ) : (
        <form className="pt-form" onSubmit={(e) => { e.preventDefault(); void send(mode === 'propose' ? 'proposed' : 'declined'); }}>
          {mode === 'propose' && <Input type="date" value={day} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setDay(e.target.value)} required aria-label={t(locale, 'work.propose')} />}
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={2000} aria-label={t(locale, 'req.details')} required={mode === 'decline'} />
          <div className="pt-actions">
            <Button type="submit" variant="primary" disabled={busy || (mode === 'propose' ? !day : note.trim().length < 2)}>{t(locale, 'msg.send')}</Button>
            <Button variant="quiet" onClick={() => setMode('idle')}>{t(locale, 'common.back')}</Button>
          </div>
        </form>
      )}
      {error && <InlineNotice tone="neg" title={error} />}
    </div>
  );
}

/** Punch item finished → ready for review, with photos. */
export function PunchDone({ orgId, itemId, locale }: { orgId: string; itemId: string; locale: Locale }) {
  const [docs, setDocs] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (done) return <p className="pt-cap" role="status">{t(locale, 'item.sent')}</p>;
  return (
    <div className="pt-actions">
      <UploadField orgId={orgId} purpose="photo" locale={locale} label={t(locale, 'req.photos')} accept="image/*" multiple onUploaded={(f) => setDocs((d) => [...d, f.documentId])} />
      <Button variant="primary" disabled={busy} onClick={async () => {
        setBusy(true); setError(null);
        const r = await portalPost('/api/portal/actions', { op: 'punch', orgId, itemId, documents: docs });
        setBusy(false);
        if (!r.ok) return setError(r.error);
        setDone(true);
      }}>{t(locale, 'action.complete')}</Button>
      {error && <InlineNotice tone="neg" title={error} />}
    </div>
  );
}

/** W-9 / COI → Books' review queue; a job's lien waiver or certificate → that job's paperwork. */
export function ComplianceUpload({ orgId, kind, complianceDocId, locale, label }: {
  orgId: string; kind: 'W9' | 'COI' | 'LIEN_WAIVER' | 'OTHER'; complianceDocId?: string | null; locale: Locale; label: string;
}) {
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (done) return <p className="pt-cap" role="status">{t(locale, 'item.sent')}</p>;
  return (
    <div>
      <UploadField orgId={orgId} purpose="compliance" locale={locale} label={label} accept="application/pdf,image/*" onUploaded={async (f) => {
        const r = await portalPost('/api/portal/actions', { op: 'compliance', orgId, kind, documentId: f.documentId, complianceDocId: complianceDocId ?? null });
        if (!r.ok) return setError(r.error);
        setDone(true);
      }} />
      {error && <InlineNotice tone="neg" title={error} />}
    </div>
  );
}

'use client';

import { useState } from 'react';
import { Button, Field, InlineNotice, Input, Radio, Textarea } from '@meritbooks/merit-ui';
import { portalPost } from '@/lib/portal/client';
import { t } from '@/lib/portal/i18n';
import type { Locale } from '@/lib/portal/types';
import { UploadField } from './UploadField';

/** Warranty / service request with photos and a preferred visit window. */
export function RequestForm({ orgId, jobId, locale }: { orgId: string; jobId: string; locale: Locale }) {
  const [kind, setKind] = useState<'warranty' | 'service'>('warranty');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [visitWindow, setVisitWindow] = useState('');
  const [docs, setDocs] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  if (sent) return <InlineNotice title={t(locale, 'req.sent')} />;
  return (
    <form className="pt-form" onSubmit={async (e) => {
      e.preventDefault();
      setBusy(true); setError(null);
      const r = await portalPost('/api/portal/actions', { op: 'request', orgId, jobId, kind, title: title.trim(), description: description.trim() || null, window: visitWindow.trim() || null, documents: docs });
      setBusy(false);
      if (!r.ok) return setError(r.error);
      setSent(true);
    }}>
      <div className="btn-row" role="radiogroup" aria-label={t(locale, 'req.title')}>
        <Radio name="kind" label={t(locale, 'req.kind_warranty')} checked={kind === 'warranty'} onChange={() => setKind('warranty')} />
        <Radio name="kind" label={t(locale, 'req.kind_service')} checked={kind === 'service'} onChange={() => setKind('service')} />
      </div>
      <Field label={t(locale, 'req.what')}><Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} required /></Field>
      <Field label={t(locale, 'req.details')}><Textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={4000} rows={3} /></Field>
      <Field label={t(locale, 'req.window')}><Input value={visitWindow} onChange={(e) => setVisitWindow(e.target.value)} maxLength={200} /></Field>
      <UploadField orgId={orgId} purpose="request" locale={locale} label={t(locale, 'req.photos')} accept="image/*" multiple onUploaded={(f) => setDocs((d) => [...d, f.documentId])} />
      {error && <InlineNotice tone="neg" title={error} />}
      <div><Button type="submit" variant="primary" disabled={busy || title.trim().length < 2}>{t(locale, 'req.submit')}</Button></div>
    </form>
  );
}

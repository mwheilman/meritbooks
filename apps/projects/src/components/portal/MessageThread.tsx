'use client';

import { useEffect, useState } from 'react';
import { Button, InlineNotice, Textarea, WidgetState } from '@meritbooks/merit-ui';
import { portalPost } from '@/lib/portal/client';
import { dateTime } from '@/lib/portal/format';
import { t } from '@/lib/portal/i18n';
import type { Audience, Locale, PortalMessage } from '@/lib/portal/types';

/** The job thread with the team (threaded into the job and the customer 360 on the staff side). */
export function MessageThread({ orgId, jobId, audience, locale }: { orgId: string; jobId: string; audience: Audience; locale: Locale }) {
  const [rows, setRows] = useState<PortalMessage[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const res = await fetch(`/api/portal/messages?orgId=${orgId}&jobId=${jobId}&audience=${audience}`, { credentials: 'same-origin', cache: 'no-store' });
      const data = (await res.json()) as { messages?: PortalMessage[]; error?: string };
      if (!res.ok) { setLoadError(data.error ?? t(locale, 'err.generic')); return; }
      setRows(data.messages ?? []);
    } catch {
      setLoadError(t(locale, 'err.offline'));
    }
  };
  useEffect(() => { void load(); }, [orgId, jobId, audience]); // eslint-disable-line react-hooks/exhaustive-deps

  const send = async () => {
    setBusy(true); setError(null);
    const r = await portalPost('/api/portal/actions', { op: 'message', orgId, jobId, audience, body: text.trim() });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setText('');
    void load();
  };

  return (
    <div>
      {loadError ? <InlineNotice tone="neg" title={loadError} />
        : rows === null ? <WidgetState state={{ kind: 'loading', label: t(locale, 'state.loading'), lines: 3 }} />
        : rows.length === 0 ? <p className="pt-empty">{t(locale, 'msg.empty')}</p>
        : (
          <div className="pt-thread" aria-live="polite">
            {rows.map((m) => (
              <div key={m.id} className="pt-msg" data-mine={m.mine}>
                <div className="who">{m.from_team ? `${m.author} · ${t(locale, 'msg.team')}` : m.author} · {dateTime(m.at, locale)}</div>
                <div style={{ whiteSpace: 'pre-wrap' }}>{m.body}</div>
              </div>
            ))}
          </div>
        )}
      <form className="pt-form" onSubmit={(e) => { e.preventDefault(); if (text.trim()) void send(); }}>
        <Textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={4000} rows={3} placeholder={t(locale, 'msg.placeholder')} aria-label={t(locale, 'msg.placeholder')} />
        {error && <InlineNotice tone="neg" title={error} />}
        <div><Button type="submit" variant="primary" disabled={busy || !text.trim()}>{t(locale, 'msg.send')}</Button></div>
      </form>
    </div>
  );
}

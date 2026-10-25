'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Button, Field, InlineNotice, Select, Tag, Textarea, WidgetState, count, useQuery } from '@meritbooks/merit-ui';
import { useShell } from '@/components/shell/ShellContext';
import type { MessageTemplateRow, ThreadMessageRow, ThreadRow } from '@/lib/fieldservice/completion-types';
import { fmtPhone, fmtWhen, useAction, words } from '../common/useAction';

export interface MessageCenterProps {
  companyId: string;
  threads: ThreadRow[];
  error: string | null;
  templates: MessageTemplateRow[];
  customers: Record<string, string>;
  initialThread: string | null;
  status: 'OPEN' | 'CLOSED';
  canSend: boolean;
}

const STATUS_WORD: Record<string, string> = {
  QUEUED: 'Sending', HELD: 'Held until go-live', SENT: 'Sent', SUPPRESSED: 'Not sent', SKIPPED: 'Not sent', FAILED: 'Failed', RECEIVED: 'Received', NOTE: 'Note',
};

/**
 * Customer conversations (FS-12): one thread per customer and job; texts the customer sends land
 * here (reminder replies are marked Confirmed / Reschedule); every reply goes through the
 * notifications service, so consent, STOP and quiet hours always apply and the reason shows when
 * a message is held or not sent.
 */
export function MessageCenter(p: MessageCenterProps) {
  const { readOnly } = useShell();
  const { run, busy, error } = useAction();
  const [threadId, setThreadId] = useState<string | null>(p.initialThread ?? p.threads[0]?.id ?? null);
  const thread = p.threads.find((t) => t.id === threadId) ?? null;
  const msgs = useQuery<{ messages: ThreadMessageRow[]; error: string | null }>(threadId ? '/api/fieldservice/messages' : null, { threadId: threadId ?? undefined }, { scope: false });
  const [body, setBody] = useState('');
  const [template, setTemplate] = useState('');
  const [channel, setChannel] = useState<'SMS' | 'EMAIL'>('SMS');
  const [note, setNote] = useState(false);

  useEffect(() => {
    if (thread && thread.unread_count > 0 && !readOnly) void run(`read:${thread.id}`, '/api/fieldservice/messages', { op: 'mark', threadId: thread.id, action: 'READ' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread?.id]);

  const who = (t: ThreadRow) => (t.customer_id ? p.customers[t.customer_id] ?? 'Customer' : `Unknown ${fmtPhone(t.unknown_from)}`);

  async function send() {
    if (!thread) return;
    if (note) {
      const ok = await run('note', '/api/fieldservice/messages', { op: 'note', threadId: thread.id, body }, 'Note added');
      if (ok) { setBody(''); void msgs.refetch(); }
      return;
    }
    if (!thread.customer_id) return;
    const r = await run<{ status: string; reason: string | null }>('send', '/api/fieldservice/messages', {
      op: 'send', companyId: p.companyId, customerId: thread.customer_id, jobId: thread.job_id, workOrderId: thread.work_order_id, channel,
      body, template: template || null, commandId: crypto.randomUUID(),
    }, (d) => (d.status === 'QUEUED' ? 'Sent' : `Not sent: ${d.reason ?? STATUS_WORD[d.status] ?? d.status}`));
    if (r) { setBody(''); setTemplate(''); void msgs.refetch(); }
  }

  if (p.error) return <WidgetState state={{ kind: 'error', title: 'Conversations did not load', body: p.error }} />;
  return (
    <div className="fs-grid">
      <section className="fs-card" aria-label="Conversations">
        <div className="fs-card-h">
          <h2 className="t-section">01 // Conversations</h2><span className="sp" />
          <Link className="btn btn--quiet" href={`/calls/messages?status=${p.status === 'OPEN' ? 'CLOSED' : 'OPEN'}`}>{p.status === 'OPEN' ? 'Closed' : 'Open'}</Link>
        </div>
        {p.threads.length === 0 ? <div className="fs-card-b"><WidgetState state={{ kind: 'empty', title: 'No conversations', body: 'Texts customers send to the company number, and messages sent from a call or visit, appear here.' }} /></div> : (
          <ul className="fs-list" role="listbox" aria-label="Threads">
            {p.threads.map((t) => (
              <li key={t.id} role="option" aria-selected={t.id === threadId} data-click onClick={() => setThreadId(t.id)} style={{ cursor: 'pointer', background: t.id === threadId ? 'var(--sky)' : undefined }}>
                <span className="l1">{who(t)}</span>
                {t.subject && <span className="fs-muted">{t.subject}</span>}
                <span className="sp" />
                {t.unread_count > 0 && <Tag tone="ai">{count(t.unread_count)} new</Tag>}
                <span className="t-cap">{fmtWhen(t.last_message_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="fs-card" aria-label="Thread">
        {!thread ? <div className="fs-card-b"><WidgetState state={{ kind: 'empty', title: 'Pick a conversation', body: 'Its texts, emails and notes show here.' }} /></div> : (
          <>
            <div className="fs-card-h">
              <h2 className="t-section">{who(thread)}</h2><span className="sp" />
              {thread.work_order_id && <Link className="btn btn--quiet" href={`/dispatch/visit/${thread.work_order_id}`}>Visit</Link>}
              {!readOnly && <Button variant="quiet" disabled={!!busy} onClick={() => void run('close', '/api/fieldservice/messages', { op: 'mark', threadId: thread.id, action: thread.status === 'OPEN' ? 'CLOSE' : 'REOPEN' }, thread.status === 'OPEN' ? 'Closed' : 'Reopened')}>
                {thread.status === 'OPEN' ? 'Close' : 'Reopen'}</Button>}
            </div>
            <div className="fs-card-b fs-scroll" style={{ maxHeight: 420 }}>
              {msgs.isLoading ? <WidgetState state={{ kind: 'loading', label: 'Loading messages' }} />
                : msgs.error ? <WidgetState state={{ kind: 'error', title: 'Messages did not load', body: msgs.error }} />
                : (msgs.data?.messages ?? []).length === 0 ? <WidgetState state={{ kind: 'empty', title: 'No messages yet' }} />
                : (msgs.data?.messages ?? []).map((m) => (
                  <div key={m.id} style={{ marginLeft: m.direction === 'OUT' ? 48 : 0, marginRight: m.direction === 'IN' ? 48 : 0, padding: '8px 12px',
                    background: m.direction === 'IN' ? 'var(--canvas)' : m.direction === 'NOTE' ? 'var(--warn-wash)' : 'var(--sky)', border: '1px solid var(--line)' }}>
                    <div className="fs-pre">{m.body}</div>
                    <div className="t-cap">
                      {m.direction === 'IN' ? 'Customer' : m.author_name ?? 'Office'} · {words(m.channel)} · {fmtWhen(m.created_at)} · {STATUS_WORD[m.status] ?? m.status}
                      {m.status_reason ? ` — ${m.status_reason}` : ''}
                      {m.intent && m.intent !== 'OTHER' && <> · <Tag tone={m.intent === 'CONFIRM' ? 'pos' : 'warn'}>{words(m.intent)}</Tag></>}
                    </div>
                  </div>
                ))}
            </div>
            {p.canSend && !readOnly && (
              <div className="fs-card-b" style={{ borderTop: '1px solid var(--line)' }}>
                {error && <InlineNotice tone="neg" title="Not sent.">{error}</InlineNotice>}
                <div className="fs-form">
                  <Field label="Send as">
                    <Select value={note ? 'NOTE' : channel} onChange={(e) => { const v = e.target.value; setNote(v === 'NOTE'); if (v !== 'NOTE') setChannel(v as 'SMS' | 'EMAIL'); }}>
                      <option value="SMS" disabled={!thread.customer_id}>Text</option>
                      <option value="EMAIL" disabled={!thread.customer_id}>Email</option>
                      <option value="NOTE">Internal note</option>
                    </Select>
                  </Field>
                  {!note && (
                    <Field label="Template">
                      <Select value={template} onChange={(e) => setTemplate(e.target.value)}>
                        <option value="">Type a message</option>
                        {p.templates.filter((t) => t.channel === channel).map((t) => <option key={t.id} value={t.key}>{t.label}</option>)}
                      </Select>
                    </Field>
                  )}
                  <Field label={template ? 'Template text (filled in when sent)' : 'Message'} className="fs-span">
                    <Textarea rows={3} value={template ? p.templates.find((t) => t.key === template)?.body ?? '' : body} readOnly={!!template}
                      onChange={(e) => setBody(e.target.value)} maxLength={note ? 4000 : 640} />
                  </Field>
                </div>
                <div className="fs-toolbar" style={{ marginTop: 8, marginBottom: 0 }}>
                  <span className="t-cap">{note ? 'Only staff see notes.' : 'Consent, STOP and quiet hours are checked before it goes.'}</span><span className="sp" />
                  <Button variant="primary" disabled={(!body.trim() && !template) || busy === 'send' || busy === 'note'} onClick={() => void send()}>{note ? 'Add note' : 'Send'}</Button>
                </div>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}

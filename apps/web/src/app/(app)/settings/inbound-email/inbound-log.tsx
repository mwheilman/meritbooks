'use client';

import { useMemo, useState } from 'react';
import { Button, ButtonLink, Eyebrow, QueueTable, Seg, Select, Tag, type QueueColumn } from '@meritbooks/merit-ui';
import { addToast, useQuery } from '@/hooks';
import { api } from '@/lib/api-client';
import {
  OUTCOME_LABEL,
  OUTCOME_TONE,
  PURPOSE_LABEL,
  openDocument,
  whenText,
  type InboxAlias,
  type InboxMessage,
  type InboxMessagesResponse,
} from '@/components/inbound-email/types';

type Filter = 'all' | 'problems' | 'bill_drafted' | 'ignored_duplicate';
const FILTERS: Array<{ value: Filter; label: string }> = [
  { value: 'all', label: 'Everything' },
  { value: 'problems', label: 'Needs a look' },
  { value: 'bill_drafted', label: 'Draft bills' },
  { value: 'ignored_duplicate', label: 'Duplicates' },
];
const PER_PAGE = 25;

/** 04 // Inbound log — every message, which company address it reached, and what happened. */
export function InboundLog({
  aliases,
  initialCompany,
  canManage,
  onAliasChanged,
}: {
  aliases: InboxAlias[];
  initialCompany: string | null;
  canManage: boolean;
  onAliasChanged: () => void;
}) {
  const [company, setCompany] = useState<string>(initialCompany ?? '');
  const [filter, setFilter] = useState<Filter>('all');
  const [page, setPage] = useState(1);
  const [cursor, setCursor] = useState<string | null>(null);

  const params = useMemo(() => {
    const p: Record<string, string> = { page: String(page), per_page: String(PER_PAGE) };
    if (company) p.location_id = company;
    if (filter !== 'all') p.outcome = filter;
    return p;
  }, [company, filter, page]);
  const { data, isLoading, error, refetch } = useQuery<InboxMessagesResponse>('/api/inbound-email/messages', params, { scope: false });

  const companies = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of aliases) m.set(a.locationId, a.companyName);
    return Array.from(m.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  }, [aliases]);
  const companyName = (id: string | null) => (id ? companies.find(([cid]) => cid === id)?.[1] ?? '—' : '—');

  async function allowSender(m: InboxMessage) {
    if (!m.aliasId) return;
    const res = await api.patch<{ alias: InboxAlias }>('/api/inbound-email/aliases', { alias_id: m.aliasId, allow_sender: m.fromAddress });
    if (res.data) {
      addToast('success', `${m.fromAddress} can now send to ${m.toAddress}. Ask them to resend.`);
      onAliasChanged();
    } else {
      addToast('error', res.error?.error ?? 'Could not allow the sender.');
    }
  }

  async function open(docId: string) {
    const err = await openDocument(docId);
    if (err) addToast('error', err);
  }

  const columns: QueueColumn<InboxMessage>[] = [
      { id: 'when', header: 'Received', width: 120, cell: (m) => <><span className="l1">{whenText(m.receivedAt)}</span><span className="l2">{PURPOSE_LABEL[m.purpose]}</span></> },
      {
        id: 'from',
        header: 'From',
        width: 220,
        cell: (m) => (
          <>
            <span className="l1">{m.fromName ?? m.fromAddress}</span>
            <span className="l2">
              {m.fromName ? m.fromAddress : ''}
              {m.senderVerified === false && (
                <span title={`${m.senderAuth ?? 'The sending mail server did not pass SPF, DKIM or DMARC.'} The From address may be forged.`}>
                  {' '}<Tag tone="warn">Sender not verified</Tag>
                </span>
              )}
            </span>
          </>
        ),
      },
      {
        id: 'subject',
        header: 'Email',
        cell: (m) => (
          <>
            <span className="l1">{m.subject ?? '(no subject)'}</span>
            <span className="l2">
              to {m.toAddress} · {companyName(m.locationId)} · {m.attachmentsCount} file{m.attachmentsCount === 1 ? '' : 's'}
              {m.duplicateDeliveries > 0 ? ` · redelivered ${m.duplicateDeliveries}×` : ''}
            </span>
          </>
        ),
      },
      {
        id: 'outcome',
        header: 'What happened',
        width: 300,
        cell: (m) => (
          <>
            <span className="l1"><Tag tone={OUTCOME_TONE[m.outcome]}>{OUTCOME_LABEL[m.outcome]}</Tag></span>
            <span className="l2" style={{ whiteSpace: 'normal' }}>{m.detail ?? ''}</span>
          </>
        ),
      },
      {
        id: 'act',
        header: <span className="sr">Actions</span>,
        width: 200,
        cell: (m) => (
          <div className="row" style={{ gap: 4, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            {m.intakeDraftIds[0] && (
              <ButtonLink variant="quiet" href={`/bills/intake-queue?draft=${m.intakeDraftIds[0]}`}>
                {m.intakeDraftIds.length > 1 ? `Open ${m.intakeDraftIds.length} drafts` : 'Open draft'}
              </ButtonLink>
            )}
            {m.emailDocumentId && <Button variant="quiet" onClick={(e) => { e.stopPropagation(); void open(m.emailDocumentId as string); }}>Email</Button>}
            {canManage && m.aliasId && (m.outcome === 'rejected_sender' || m.outcome === 'rejected_spam') && (
              <Button variant="quiet" onClick={(e) => { e.stopPropagation(); void allowSender(m); }}>Allow sender</Button>
            )}
          </div>
        ),
      },
  ];

  const total = data?.total ?? 0;
  const messages = data?.messages ?? [];
  const lastPage = Math.max(1, Math.ceil(total / PER_PAGE));

  return (
    <section aria-labelledby="ibx-log-h">
      <div className="row row--between" style={{ flexWrap: 'wrap', gap: 8 }}>
        <Eyebrow>{['04', 'Inbound log']}</Eyebrow>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <Seg aria-label="Filter the log" items={FILTERS} value={filter} onChange={(v) => { setFilter(v); setPage(1); }} />
          <Select aria-label="Company" value={company} onChange={(e) => { setCompany(e.currentTarget.value); setPage(1); }}>
            <option value="">All companies</option>
            {companies.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </Select>
        </div>
      </div>
      <h2 id="ibx-log-h" className="sr">Inbound log</h2>
      {isLoading && !data ? (
        <div className="surface wg-loading mb-state-block" aria-busy="true" style={{ marginTop: 8 }}>
          <span className="bar-l" style={{ width: '70%' }} aria-hidden="true" />
          <span className="bar-l" style={{ width: '50%' }} aria-hidden="true" />
          <span className="t-cap" role="status">Loading the inbound log…</span>
        </div>
      ) : error ? (
        <div className="surface wg-state mb-state-block" role="alert" style={{ marginTop: 8 }}>
          <span className="t-head">The log didn’t load</span>
          <p>{error}</p>
          <Button onClick={() => void refetch()}>Try again</Button>
        </div>
      ) : messages.length === 0 ? (
        <div className="surface wg-state mb-state-block" style={{ marginTop: 8 }}>
          <span className="t-head">{filter === 'all' ? 'No email has arrived yet' : 'Nothing here'}</span>
          <p>{filter === 'all' ? 'Once a vendor emails a company address, every message shows here with what happened to it.' : 'Try “Everything”.'}</p>
        </div>
      ) : (
        <>
          <div className="surface mb-queue" style={{ marginTop: 8 }}>
            <QueueTable
              aria-label="Inbound email log"
              columns={columns}
              rows={messages}
              getRowId={(m) => m.id}
              rowState={(m) => ({ attn: OUTCOME_TONE[m.outcome] === 'warn' || OUTCOME_TONE[m.outcome] === 'neg' })}
              cursorId={cursor}
              onCursorChange={(id) => setCursor(id)}
              flush
            />
          </div>
          <div className="row row--between" style={{ marginTop: 8 }}>
            <span className="t-cap">{total} message{total === 1 ? '' : 's'} · page {page} of {lastPage}</span>
            <div className="row" style={{ gap: 8 }}>
              <Button variant="quiet" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>Newer</Button>
              <Button variant="quiet" disabled={page >= lastPage} onClick={() => setPage((p) => p + 1)}>Older</Button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}

'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Bands, Button, InlineNotice, Keybar, Panel, PanelSection, QueueTable, Tag, WidgetState, api, count, money, shortDate, toast, type QueueColumn,
} from '@meritbooks/merit-ui';
import type { BillingStatus, SuppressedReason } from '@/lib/pm/money/types';
import type { BillingBand } from '@/lib/pm/money/summaries';
import { billingMark, unissuedSentence } from '@/lib/pm/money/status';
import { useShell } from '@/components/shell/ShellContext';
import { BooksNote, MarkStatus, PreconditionNotices, m } from './common';

export interface BillingQueueRowView {
  id: string;
  kind: 'BILLING' | 'DEPOSIT';
  band: BillingBand;
  jobId: string;
  jobLabel: string;
  company: string | null;
  customer: string | null;
  label: string;
  status: BillingStatus;
  suppressed: SuppressedReason | null;
  date: string;
  gross: number;
  retainage: number;
  net: number;
  invoice: string | null;
  error: string | null;
  failing: string[];
  createdBy: string | null;
  ageDays: number | null;
}

interface BulkResult { id: string; ok: boolean; status?: 'EMITTED' | 'UNISSUED'; error?: string; code?: string; preconditions?: string[] }

const BANDS: Array<{ value: BillingBand; label: string; caption: string }> = [
  { value: 'draft', label: 'Draft', caption: 'A check is not met yet' },
  { value: 'ready', label: 'Ready to send', caption: 'Approve to send to Merit Books' },
  { value: 'sent', label: 'Sent', caption: 'Waiting on Merit Books' },
  { value: 'issued', label: 'Issued', caption: 'Numbered and posted, last 90 days' },
  { value: 'rejected', label: 'Rejected', caption: 'Fix and send again' },
  { value: 'unissued', label: 'Approved here', caption: 'Not sent to Merit Books' },
];

export function BillingQueue({ rows, currentUserId, booksPresent, showCompany, only, label = 'Billing' }: {
  rows: BillingQueueRowView[]; currentUserId: string; booksPresent: boolean; showCompany: boolean;
  /** Limit the bands (To review shows Ready / Rejected for billing, Rejected / Sent for deposits). */
  only?: ReadonlyArray<BillingBand>;
  label?: string;
}) {
  const router = useRouter();
  const { readOnly } = useShell();
  const by = useMemo(() => {
    const out = new Map<BillingBand, BillingQueueRowView[]>();
    for (const r of rows) out.set(r.band, [...(out.get(r.band) ?? []), r]);
    return out;
  }, [rows]);
  const order = (['ready', 'rejected', 'draft', 'sent', 'issued', 'unissued'] as BillingBand[]).filter((b) => !only || only.includes(b));
  const first = order.find((b) => (by.get(b)?.length ?? 0) > 0) ?? order[0] ?? 'ready';
  const [band, setBand] = useState<BillingBand>(first);
  const [cursorId, setCursorId] = useState<string | null>(by.get(first)?.[0]?.id ?? null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<Record<string, BulkResult>>({});
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const visible = by.get(band) ?? [];
  const cursor = rows.find((r) => r.id === cursorId) ?? null;
  const sendable = (r: BillingQueueRowView) => !readOnly && (r.kind === 'BILLING' ? r.band === 'ready' || r.band === 'rejected' : r.band === 'rejected');
  const bands = BANDS.filter((b) => (only ? only.includes(b.value) : b.value !== 'unissued' || (by.get('unissued')?.length ?? 0) > 0 || !booksPresent));

  const approve = async (list: BillingQueueRowView[]) => {
    const ok = list.filter(sendable);
    const ids = ok.filter((r) => r.kind === 'BILLING').map((r) => r.id);
    const deps = ok.filter((r) => r.kind === 'DEPOSIT').map((r) => r.id);
    if (!ids.length && !deps.length) return;
    setBusy(true);
    const out: BulkResult[] = [];
    if (ids.length) {
      const r = await api.post<{ results: BulkResult[] }>('/api/billing/bulk', { ids });
      if (r.error || !r.data) {
        setBusy(false);
        return void toast.error(r.error?.error ?? 'Nothing was approved. Try again.');
      }
      out.push(...r.data.results);
    }
    for (const id of deps) {
      const r = await api.post<{ status: 'EMITTED' | 'UNISSUED' }>(`/api/deposits/${id}`, { op: 'resend' });
      out.push(r.error ? { id, ok: false, error: r.error.error, code: r.error.code } : { id, ok: true, status: r.data?.status });
    }
    setBusy(false);
    setResults((prev) => ({ ...prev, ...Object.fromEntries(out.map((x) => [x.id, x])) }));
    setSelected(new Set());
    const approved = out.filter((x) => x.ok).length;
    const refused = out.length - approved;
    const text = `${approved ? `Approved ${count(approved)}${booksPresent ? ' and sent to Merit Books' : ''}` : 'None approved'}${refused ? ` · ${count(refused)} refused, see each row` : ''}`;
    if (refused) toast.error(text);
    else toast(text);
    router.refresh();
  };

  const checkNow = async () => {
    setChecking(true);
    const r = await api.post<{ reconcile: { billing_issued: number; billing_rejected: number; deposits_issued: number; deposits_rejected: number } }>('/api/seam', {});
    setChecking(false);
    if (r.error || !r.data) return void toast.error(r.error?.error ?? 'Merit Books did not answer. Try again.');
    const c = r.data.reconcile;
    const issued = c.billing_issued + c.deposits_issued;
    const rejected = c.billing_rejected + c.deposits_rejected;
    toast(issued || rejected ? `Merit Books: ${count(issued)} issued, ${count(rejected)} rejected` : 'Nothing new from Merit Books');
    router.refresh();
  };

  const columns: QueueColumn<BillingQueueRowView>[] = [
    { id: 'job', header: 'Job', cell: (r) => <><Link className="nlink l1" href={`/jobs/${r.jobId}?tab=billing&request=${r.id}`}>{r.jobLabel}</Link><span className="l2">{[r.label, r.customer, showCompany ? r.company : null].filter(Boolean).join(' · ')}</span></> },
    { id: 'date', header: 'Date', width: 88, cell: (r) => <span className="l2">{shortDate(r.date)}</span> },
    { id: 'st', header: 'Status', width: 196, cell: (r) => <MarkStatus mark={billingMark(r.status, r.suppressed)} /> },
    { id: 'net', header: 'Due', numeric: true, width: 128, cell: (r) => <b>{m(r.net)}</b> },
    { id: 'ret', header: 'Retainage', numeric: true, width: 112, cell: (r) => m(r.retainage) },
    {
      id: 'note', header: band === 'issued' ? 'Invoice' : band === 'sent' ? 'Waiting' : 'Result', width: 220,
      cell: (r) => {
        const res = results[r.id];
        if (res) return res.ok ? <Tag tone="pos">{res.status === 'EMITTED' ? 'Sent' : 'Approved, not sent'}</Tag> : <span className="neg" style={{ whiteSpace: 'normal' }}>{res.error}</span>;
        if (r.invoice) return <span className="code">{r.invoice}</span>;
        if (r.band === 'sent') return <span className={r.ageDays != null && r.ageDays >= 1 ? 'neg' : 'l2'}>{r.ageDays != null ? `${count(r.ageDays)} d` : '—'}</span>;
        if (r.kind === 'BILLING' && r.createdBy === currentUserId && sendable(r)) return <Tag>You prepared it</Tag>;
        if (r.band === 'draft') return <span className="l2">{count(r.failing.length)} {r.failing.length === 1 ? 'check' : 'checks'} not met</span>;
        return null;
      },
    },
  ];

  if (rows.length === 0 && only) {
    return <div className="surface"><WidgetState state={{ kind: 'done', title: `No ${label.toLowerCase()} waiting`, body: label === 'Deposit requests' ? 'Deposit requests Merit Books rejects, or has not picked up, land here.' : 'Drafts with every check met, and requests Merit Books rejected, land here for someone other than the preparer to send.' }} /></div>;
  }
  if (rows.length === 0) {
    return (
      <div className="stack">
        <BooksNote booksPresent={booksPresent} />
        <div className="surface"><WidgetState state={{ kind: 'empty', title: 'No billing in the last 90 days', body: 'Draft billing from a job’s Billing tab: progress, pay applications, milestones, time and materials or deposits.', action: <Button onClick={() => router.push('/jobs')}>Open jobs</Button> }} /></div>
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="row row--between" style={{ alignItems: 'flex-end' }}>
        <div style={{ flex: 1, maxWidth: 1040 }}>
          <Bands<BillingBand>
            aria-label="Billing by status"
            value={band}
            onChange={(b) => { setBand(b); setSelected(new Set()); setCursorId(by.get(b)?.[0]?.id ?? null); }}
            items={bands.map((b) => ({ value: b.value, label: b.label, count: count(by.get(b.value)?.length ?? 0), caption: `${b.caption} · ${money((by.get(b.value) ?? []).reduce((s, r) => s + r.net, 0), { decimals: 0 })}` }))}
          />
        </div>
        {booksPresent && <Button icon="history" disabled={checking} aria-busy={checking || undefined} onClick={() => void checkNow()}>Check Merit Books now</Button>}
      </div>
      {band === 'ready' || band === 'rejected' ? <BooksNote booksPresent={booksPresent} /> : null}
      {band === 'unissued' && <InlineNotice title="Approved, not sent.">{unissuedSentence(booksPresent ? 'SAMPLE' : 'STANDALONE')}</InlineNotice>}

      <div className={cursor ? 'mp-split has-panel' : 'mp-split'}>
        <div className="mp-table" style={{ minWidth: 0 }}>
          {visible.length === 0 ? (
            <WidgetState state={{ kind: 'done', title: band === 'ready' ? 'Nothing is ready to send' : band === 'rejected' ? 'Merit Books has rejected nothing' : band === 'sent' ? 'Nothing is waiting on Merit Books' : 'Nothing here', body: 'Switch the band above to see the others.' }} />
          ) : (
            <QueueTable
              aria-label={`${label}, ${BANDS.find((b) => b.value === band)?.label ?? ''}`}
              columns={columns}
              rows={visible}
              getRowId={(r) => r.id}
              selectable={!readOnly && (band === 'ready' || band === 'rejected')}
              selected={selected}
              onSelectedChange={setSelected}
              cursorId={cursorId}
              onCursorChange={(id) => setCursorId(id)}
              onOpen={(r) => router.push(`/jobs/${r.jobId}?tab=billing&request=${r.id}`)}
              rowState={(r) => ({ done: results[r.id]?.ok === true, attn: r.band === 'rejected' || (results[r.id] != null && !results[r.id]!.ok) })}
              actions={readOnly ? [] : [{ key: 'a', label: 'approve and send', run: (rs) => void approve(rs) }]}
              bulkSummary={(rs) => [`${count(rs.length)} selected`, BANDS.find((b) => b.value === band)?.label ?? '', money(rs.reduce((s, r) => s + r.net, 0))]}
              bulkActions={(rs) => <Button variant="primary" disabled={busy} onClick={() => void approve(rs)}>Approve &amp; send {count(rs.length)}</Button>}
            />
          )}
        </div>
        {cursor && (
          <Panel eyebrow={[cursor.label, billingMark(cursor.status, cursor.suppressed).word]} title={cursor.jobLabel} meta={`${money(cursor.net)} due · ${shortDate(cursor.date)}`} onClose={() => setCursorId(null)}
            foot={<div className="btn-row" style={{ width: '100%' }}><Link className="link" href={`/jobs/${cursor.jobId}?tab=billing&request=${cursor.id}`}>Open on the job</Link><span className="sp" />
              {sendable(cursor) && <Button variant="primary" chord="a" disabled={busy || (cursor.kind === 'BILLING' && cursor.createdBy === currentUserId)} title={cursor.kind === 'BILLING' && cursor.createdBy === currentUserId ? 'You prepared this request' : undefined} onClick={() => void approve([cursor])}>{cursor.band === 'rejected' ? 'Send again' : 'Approve & send'}</Button>}</div>}>
            {cursor.failing.length > 0 && <PanelSection><PreconditionNotices codes={cursor.failing} jobId={cursor.jobId} /></PanelSection>}
            {results[cursor.id] && !results[cursor.id]!.ok && <PanelSection><InlineNotice tone="neg" title="Not sent." role="alert">{results[cursor.id]!.error}</InlineNotice></PanelSection>}
            {cursor.band === 'rejected' && <PanelSection><InlineNotice tone="neg" title="Merit Books did not issue it.">{cursor.error ?? 'No reason was given.'}</InlineNotice></PanelSection>}
            {cursor.kind === 'BILLING' && cursor.createdBy === currentUserId && sendable(cursor) && <PanelSection><InlineNotice tone="info" title="You prepared this one.">Someone else approves and sends it.</InlineNotice></PanelSection>}
            <PanelSection title="Amounts">
              <ul className="ev">
                <li>Billed<span className="dl" /><span className="v tnum">{money(cursor.gross)}</span></li>
                <li>Retainage held<span className="dl" /><span className="v tnum">{money(cursor.retainage)}</span></li>
                <li>Due on the invoice<span className="dl" /><span className="v tnum b">{money(cursor.net)}</span></li>
              </ul>
            </PanelSection>
          </Panel>
        )}
      </div>
      {visible.length > 0 && (
        <Keybar hints={[{ chord: 'j k', label: 'move' }, { chord: 'x', label: 'select' }, ...(!readOnly ? [{ chord: 'a', label: 'approve and send' }] : []), { chord: 'enter', label: 'open the job' }]} note="Each request is approved on its own; a refusal never blocks the rest" />
      )}
    </div>
  );
}

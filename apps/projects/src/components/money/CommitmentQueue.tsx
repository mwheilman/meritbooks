'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Button, Field, InlineNotice, KV, Keybar, Panel, PanelSection, QueueTable, Search, Seg, Select, WidgetState, count, money, shortDate, useDebounce,
  type QueueColumn,
} from '@meritbooks/merit-ui';
import type { CommitmentStatus, CommitmentType } from '@/lib/pm/money/types';
import type { CommitmentTotals } from '@/lib/pm/money/summaries';
import { commitmentMark } from '@/lib/pm/money/status';
import { useShell, useVocab } from '@/components/shell/ShellContext';
import { useAction } from '@/components/job/useAction';
import { lower } from '@/lib/pm/vocab';
import { MarkStatus, m, p } from './common';

export interface CommitmentQueueRow {
  id: string;
  number: string;
  type: CommitmentType;
  title: string | null;
  status: CommitmentStatus;
  vendorName: string | null;
  jobId: string;
  jobLabel: string;
  company: string | null;
  retainagePct: number;
  createdBy: string | null;
  approvedAt: string | null;
  holdReason: string | null;
  t: CommitmentTotals;
}

type Show = 'open' | 'draft' | 'hold' | 'closed' | 'all';

const TYPE_WORDS: Record<CommitmentType, string> = { PO: 'Purchase order', SUBCONTRACT: 'Subcontract' };

export function CommitmentQueue({ rows, currentUserId, showCompany, mode = 'all' }: { rows: CommitmentQueueRow[]; currentUserId: string; showCompany: boolean; mode?: 'all' | 'review' }) {
  const v = useVocab();
  const { readOnly } = useShell();
  const { run, busy } = useAction();
  const [show, setShow] = useState<Show>(mode === 'review' ? 'draft' : 'open');
  const [type, setType] = useState<'' | CommitmentType>('');
  const [job, setJob] = useState('');
  const [q, setQ] = useState('');
  const term = useDebounce(q.trim().toLowerCase(), 150);
  const [cursorId, setCursorId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ id: string; text: string } | null>(null);

  const jobs = useMemo(() => [...new Map(rows.map((r) => [r.jobId, r.jobLabel])).entries()].sort((a, b) => a[1].localeCompare(b[1])), [rows]);
  const isOpen = (r: CommitmentQueueRow) => r.status === 'APPROVED' || r.status === 'EXECUTED';
  const filtered = rows.filter((r) => {
    if (show === 'open' && !(isOpen(r) || r.status === 'DRAFT')) return false;
    if (show === 'draft' && r.status !== 'DRAFT') return false;
    if (show === 'hold' && !(isOpen(r) && r.t.holdEffective)) return false;
    if (show === 'closed' && !(r.status === 'CLOSED' || r.status === 'VOID')) return false;
    if (type && r.type !== type) return false;
    if (job && r.jobId !== job) return false;
    if (term && ![r.number, r.vendorName ?? '', r.title ?? '', r.jobLabel].some((s) => s.toLowerCase().includes(term))) return false;
    return true;
  });
  const cursor = rows.find((r) => r.id === cursorId) ?? null;

  const approve = async (r: CommitmentQueueRow) => {
    if (r.status !== 'DRAFT') return;
    const res = await run(`a:${r.id}`, 'post', `/api/commitments/${r.id}`, { op: 'approve' }, `Approved ${r.number}`, { quietError: true });
    setNotice(res.error ? { id: r.id, text: res.error.error } : null);
    if (res.error) setCursorId(r.id);
  };

  const columns: QueueColumn<CommitmentQueueRow>[] = [
    { id: 'num', header: 'Number', width: 156, cell: (r) => <span className="code">{r.number}</span> },
    { id: 'who', header: 'Vendor', cell: (r) => <><span className="l1">{r.vendorName ?? 'No vendor yet'}</span><span className="l2">{[TYPE_WORDS[r.type], r.title].filter(Boolean).join(' · ')}</span></> },
    { id: 'job', header: v.job, width: 220, cell: (r) => <><span className="l1">{r.jobLabel}</span>{showCompany && <span className="l2">{r.company}</span>}</> },
    { id: 'st', header: 'Status', width: 152, cell: (r) => <MarkStatus mark={commitmentMark(r.status, r.t.holdEffective)} /> },
    { id: 'com', header: 'Committed', numeric: true, width: 120, cell: (r) => m(r.t.committed) },
    { id: 'rec', header: 'Received', numeric: true, width: 112, cell: (r) => m(r.t.received) },
    { id: 'bil', header: 'Billed', numeric: true, width: 112, cell: (r) => m(r.t.billed) },
    { id: 'open', header: 'Open', numeric: true, width: 112, cell: (r) => (r.t.overBilled > 0 ? <span className="neg b">({money(r.t.overBilled)})</span> : m(r.t.open)) },
  ];

  const totals = filtered.filter(isOpen).reduce((s, r) => ({ c: s.c + r.t.committed, b: s.b + r.t.billed, o: s.o + r.t.open }), { c: 0, b: 0, o: 0 });

  if (rows.length === 0) {
    return (
      <div className="surface">
        <WidgetState state={mode === 'review'
          ? { kind: 'done', title: `No ${lower(v.commitments)} are waiting for approval`, body: 'Draft purchase orders and subcontracts land here for someone other than the preparer to approve.' }
          : { kind: 'empty', title: `No ${lower(v.commitments)} yet`, body: `Create purchase orders and subcontracts from a job’s ${v.commitments} tab, by cost code.`, action: <Link className="link" href="/jobs">Open {lower(v.jobs)}</Link> }} />
      </div>
    );
  }

  return (
    <div className="stack">
      {mode === 'all' && (
        <div className="mp-tools">
          <Search aria-label="Search commitments" placeholder="Number, vendor or job" value={q} onChange={(e) => setQ(e.target.value)} slashToFocus />
          <Seg<Show> aria-label="Show" value={show} onChange={setShow} items={[
            { value: 'open', label: 'Open', count: rows.filter((r) => isOpen(r) || r.status === 'DRAFT').length },
            { value: 'draft', label: 'To approve', count: rows.filter((r) => r.status === 'DRAFT').length },
            { value: 'hold', label: 'On hold', count: rows.filter((r) => isOpen(r) && r.t.holdEffective).length },
            { value: 'closed', label: 'Closed', count: rows.filter((r) => r.status === 'CLOSED' || r.status === 'VOID').length },
            { value: 'all', label: 'All', count: rows.length },
          ]} />
          <Field label="Kind"><Select value={type} onChange={(e) => setType(e.target.value as '' | CommitmentType)}><option value="">All</option><option value="SUBCONTRACT">Subcontracts</option><option value="PO">Purchase orders</option></Select></Field>
          <Field label={v.job}><Select value={job} onChange={(e) => setJob(e.target.value)} style={{ maxWidth: 240 }}><option value="">All {lower(v.jobs)}</option>{jobs.map(([id, l]) => <option key={id} value={id}>{l}</option>)}</Select></Field>
          <span className="t-cap tnum" style={{ marginLeft: 'auto' }}>Approved in view: {money(totals.c)} committed · {money(totals.b)} billed · {money(totals.o)} open</span>
        </div>
      )}
      <div className={cursor ? 'mp-split has-panel' : 'mp-split'}>
        <div className="mp-table" style={{ minWidth: 0 }}>
          {filtered.length === 0 ? (
            <WidgetState state={{ kind: 'done', title: 'Nothing matches', body: 'Clear the search or change the filters.' }} />
          ) : (
            <QueueTable
              aria-label={mode === 'review' ? `${v.commitments} waiting for approval` : `All ${lower(v.commitments)}`}
              columns={columns}
              rows={filtered}
              getRowId={(r) => r.id}
              cursorId={cursorId}
              onCursorChange={(id) => setCursorId(id)}
              openOnClick
              onOpen={(r) => setCursorId(r.id)}
              rowState={(r) => ({ done: r.status === 'VOID' || r.status === 'CLOSED', attn: (isOpen(r) && r.t.holdEffective) || r.t.overBilled > 0 })}
              actions={readOnly ? [] : [{ key: 'a', label: 'approve', run: (rs) => rs.forEach((r) => void approve(r)) }]}
            />
          )}
        </div>
        {cursor && (
          <Panel
            eyebrow={[cursor.number, commitmentMark(cursor.status, cursor.t.holdEffective).word]}
            title={cursor.vendorName ?? 'No vendor yet'}
            meta={[money(cursor.t.committed), cursor.jobLabel, cursor.company].filter(Boolean).join(' · ')}
            onClose={() => setCursorId(null)}
            foot={
              <div className="btn-row" style={{ width: '100%' }}>
                <Link className="link" href={`/jobs/${cursor.jobId}?tab=commitments`}>Open on the {lower(v.job)}</Link>
                <span className="sp" />
                {!readOnly && cursor.status === 'DRAFT' && (
                  <Button variant="primary" chord="a" disabled={busy === `a:${cursor.id}` || cursor.createdBy === currentUserId} title={cursor.createdBy === currentUserId ? 'You prepared this commitment' : undefined} onClick={() => void approve(cursor)}>Approve</Button>
                )}
              </div>
            }
          >
            {notice?.id === cursor.id && <PanelSection><InlineNotice tone="neg" title="Not approved." role="alert">{notice.text}</InlineNotice></PanelSection>}
            {cursor.status === 'DRAFT' && cursor.createdBy === currentUserId && <PanelSection><InlineNotice tone="info" title="You prepared this one.">Someone else approves it; that keeps preparer and approver apart.</InlineNotice></PanelSection>}
            {cursor.t.holdEffective && isOpen(cursor) && <PanelSection><InlineNotice tone="warn" title="Payment held in Merit Books.">{cursor.holdReason ?? (cursor.t.complianceOk ? 'Manual hold.' : 'A required certificate or lien waiver is not current.')}</InlineNotice></PanelSection>}
            <PanelSection title="Amounts">
              <KV items={[
                { term: 'Kind', value: TYPE_WORDS[cursor.type] },
                { term: 'Original', value: m(cursor.t.original || cursor.t.committed) },
                { term: 'Approved changes', value: m(cursor.t.changes) },
                { term: 'Committed', value: m(cursor.t.committed) },
                { term: 'Received', value: m(cursor.t.received) },
                { term: 'Billed in Merit Books', value: m(cursor.t.billed) },
                { term: 'Open', value: m(cursor.t.open) },
                { term: 'Retainage', value: p(cursor.retainagePct) },
                ...(cursor.approvedAt ? [{ term: 'Approved', value: shortDate(cursor.approvedAt.slice(0, 10)) }] : []),
              ]} />
            </PanelSection>
          </Panel>
        )}
      </div>
      {filtered.length > 0 && <Keybar hints={[{ chord: 'j k', label: 'move' }, ...(!readOnly ? [{ chord: 'a', label: 'approve' }] : []), ...(mode === 'all' ? [{ chord: '/', label: 'search' }] : [])]} note={`${count(filtered.length)} shown · approving sends the commitment to Merit Books`} />}
    </div>
  );
}

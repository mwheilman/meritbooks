'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Bands, Keybar, QueueTable, WidgetState, count, money, shortDate, type QueueColumn } from '@meritbooks/merit-ui';
import type { EstimateStatus } from '@/lib/pm/money/types';
import { estimateMark } from '@/lib/pm/money/status';
import { useMoneyVis, useVocab } from '@/components/shell/ShellContext';
import { seesMargin, when } from '@/components/money/visibility';
import { lower } from '@/lib/pm/vocab';
import { MarkStatus, m, p } from './common';

export interface EstimateListRow {
  id: string;
  number: string;
  version: number;
  title: string;
  status: EstimateStatus;
  jobId: string;
  jobLabel: string;
  company: string | null;
  total: number;
  cost: number;
  date: string;
  validUntil: string | null;
}

type Band = 'DRAFT' | 'SENT' | 'ACCEPTED' | 'DECLINED';

export function EstimatesList({ rows, today, showCompany }: { rows: EstimateListRow[]; today: string; showCompany: boolean }) {
  const v = useVocab();
  const router = useRouter();
  const mv = useMoneyVis();
  const by = (b: Band) => rows.filter((r) => r.status === b);
  const [band, setBand] = useState<Band>(by('SENT').length ? 'SENT' : by('DRAFT').length ? 'DRAFT' : 'ACCEPTED');
  const visible = by(band);
  const lapsed = (r: EstimateListRow) => r.status === 'SENT' && r.validUntil != null && r.validUntil < today;

  const columns: QueueColumn<EstimateListRow>[] = [
    { id: 'num', header: 'Number', width: 196, cell: (r) => <><span className="code">{r.number}</span> <span className="l2">v{r.version}</span></> },
    { id: 'what', header: v.estimate, cell: (r) => <><span className="l1">{r.title}</span><span className="l2">{[r.jobLabel, showCompany ? r.company : null].filter(Boolean).join(' · ')}</span></> },
    { id: 'st', header: 'Status', width: 168, cell: (r) => <MarkStatus mark={estimateMark(r.status)} /> },
    ...when<QueueColumn<EstimateListRow>>(mv.contract, { id: 'price', header: 'Price', numeric: true, width: 128, cell: (r) => m(r.total) }),
    ...when<QueueColumn<EstimateListRow>>(mv.cost, { id: 'cost', header: 'Cost', numeric: true, width: 128, cell: (r) => m(r.cost) }),
    ...when<QueueColumn<EstimateListRow>>(seesMargin(mv), { id: 'mg', header: 'Margin', numeric: true, width: 80, cell: (r) => p(r.total > 0 ? (r.total - r.cost) / r.total : null) }),
    { id: 'date', header: band === 'SENT' ? 'Valid until' : 'Date', width: 104, cell: (r) => (band === 'SENT' && r.validUntil ? <span className={lapsed(r) ? 'neg b' : 'l2'}>{shortDate(r.validUntil)}</span> : <span className="l2">{shortDate(r.date)}</span>) },
  ];

  if (rows.length === 0) {
    return <div className="surface"><WidgetState state={{ kind: 'empty', title: `No ${lower(v.estimates)} yet`, body: `Price a job from its ${v.estimate} tab, by cost code. Accepting it writes the original budget and the contract.`, action: <a className="link" href="/jobs">Open {lower(v.jobs)}</a> }} /></div>;
  }
  const sum = (rs: EstimateListRow[]) => (mv.contract ? money(rs.reduce((s, r) => s + r.total, 0), { decimals: 0 }) : `${count(rs.length)} ${rs.length === 1 ? 'estimate' : 'estimates'}`);
  return (
    <div className="stack">
      <div style={{ maxWidth: 880 }}>
        <Bands<Band> aria-label={`${v.estimates} by status`} value={band} onChange={setBand} items={[
          { value: 'DRAFT', label: 'Draft', count: count(by('DRAFT').length), caption: `Being priced · ${sum(by('DRAFT'))}` },
          { value: 'SENT', label: 'With the customer', count: count(by('SENT').length), caption: `${count(by('SENT').filter(lapsed).length)} past valid date · ${sum(by('SENT'))}` },
          { value: 'ACCEPTED', label: 'Accepted', count: count(by('ACCEPTED').length), caption: `Now budgets and contracts · ${sum(by('ACCEPTED'))}` },
          { value: 'DECLINED', label: 'Declined', count: count(by('DECLINED').length), caption: sum(by('DECLINED')) },
        ]} />
      </div>
      <div className="mp-table">
        {visible.length === 0 ? (
          <WidgetState state={{ kind: 'done', title: band === 'SENT' ? 'Nothing is with a customer' : band === 'DRAFT' ? 'No drafts' : 'Nothing here', body: 'Switch the band above to see the others.' }} />
        ) : (
          <QueueTable aria-label={`${v.estimates}, ${band.toLowerCase()}`} columns={columns} rows={visible} getRowId={(r) => r.id}
            rowState={(r) => ({ attn: lapsed(r), done: r.status === 'DECLINED' })} openOnClick onOpen={(r) => router.push(`/jobs/${r.jobId}?tab=estimates`)} />
        )}
      </div>
      {visible.length > 0 && <Keybar hints={[{ chord: 'j k', label: 'move' }, { chord: 'enter', label: 'open on the job' }]} note="Superseded versions are kept on the job’s tab" />}
    </div>
  );
}

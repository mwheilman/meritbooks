'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Drawer, Field, Figure, Input, KV, Seg, Tag, WidgetState, money } from '@meritbooks/merit-ui';
import { COST_SOURCE_WORDS, costSource, groupCosts, type CostDetailRow, type CostGroupBy } from '@/lib/commercial/screen-logic';
import type { CommitmentMoney, CostCodeLite } from '@/lib/commercial/screen-types';
import type { JobOption } from '@/lib/pm/ops/scope';
import { booksUrl } from '@/lib/books-url';
import { JobSelect } from '@/components/ops/common/bits';
import { DSection, cm, day } from './common';
import { CmTable, TableKeys, words, type Col } from './kit';

const PAGE = 50;

/**
 * Job cost detail with drill-down (CGC-55): every cost line Merit Books sent for the job, grouped
 * by cost code, cost type, month or source, each line opening to what produced it (AP bill,
 * payroll run, bank or card charge, equipment charge, journal entry) and its reference in Books.
 * Below: committed vs invoiced vs paid per commitment.
 */
export function CostDetailView({ jobId, jobs, rows, codes, commitments, vendors, from, to, today, booksPresent }: {
  jobId: string | null; jobs: JobOption[]; rows: CostDetailRow[]; codes: CostCodeLite[]; commitments: CommitmentMoney[]; vendors: Readonly<Record<string, string>>;
  from: string | null; to: string | null; today: string; booksPresent: boolean;
}) {
  const router = useRouter();
  const [by, setBy] = useState<CostGroupBy>('code');
  const [f, setF] = useState(from ?? '');
  const [t, setT] = useState(to ?? '');
  const [expanded, setExpanded] = useState<Record<string, number>>({});
  const [openId, setOpenId] = useState<string | null>(null);
  const codeName = useMemo(() => new Map(codes.map((c) => [c.id, c.name])), [codes]);
  const groups = useMemo(() => groupCosts(rows, by, (id) => (id ? codeName.get(id) ?? null : null)), [rows, by, codeName]);
  const total = rows.reduce((s, r) => s + Number(r.amount_cents ?? 0), 0);
  const pending = rows.filter((r) => r.lifecycle === 'PENDING').reduce((s, r) => s + Number(r.amount_cents ?? 0), 0);
  const open = rows.find((r) => r.id === openId) ?? null;
  const go = (job: string, ff: string, tt: string) => router.push(`/cost-detail?job=${job}${ff ? `&from=${ff}` : ''}${tt ? `&to=${tt}` : ''}`);
  const flat = groups.flatMap((g) => g.rows.slice(0, expanded[g.key] ?? PAGE));

  const lineCols: Col<CostDetailRow>[] = [
    { key: 'd', head: 'Date', width: 100, cell: (r) => day(r.occurred_on, today) },
    { key: 'src', head: 'Source', width: 140, cell: (r) => COST_SOURCE_WORDS[costSource(r)].word },
    { key: 'desc', head: 'Description', cell: (r) => <>{r.description ?? '—'}<span className="ops-sub" style={{ display: 'block' }}>{[r.vendor_id ? vendors[r.vendor_id] : null, r.commitment_number].filter(Boolean).join(' · ')}</span></> },
    { key: 'code', head: 'Cost code', width: 120, cell: (r) => (r.cost_code ? <span className="code">{r.cost_code}</span> : '—') },
    { key: 'type', head: 'Type', width: 110, cell: (r) => words(r.cost_type) },
    { key: 'st', head: '', width: 90, cell: (r) => (r.lifecycle === 'PENDING' ? <Tag tone="warn">Pending</Tag> : null) },
    { key: 'amt', head: 'Amount', n: true, width: 130, cell: (r) => cm(r.amount_cents) },
  ];
  const cmCols: Col<CommitmentMoney>[] = [
    { key: 'n', head: 'Commitment', cell: (c) => <><span className="code">{c.number}</span> {c.vendor_name ?? ''}</> },
    { key: 'c', head: 'Committed', n: true, width: 130, cell: (c) => cm(c.committed, 0), foot: money(commitments.reduce((s, c) => s + Number(c.committed ?? 0), 0), { decimals: 0 }) },
    { key: 'i', head: 'Invoiced', n: true, width: 130, cell: (c) => cm(c.invoiced, 0), foot: money(commitments.reduce((s, c) => s + Number(c.invoiced ?? 0), 0), { decimals: 0 }) },
    { key: 'p', head: 'Paid', n: true, width: 130, cell: (c) => cm(c.paid, 0), foot: money(commitments.reduce((s, c) => s + Number(c.paid ?? 0), 0), { decimals: 0 }) },
    { key: 'o', head: 'Open to invoice', n: true, width: 140, cell: (c) => cm(c.open, 0), foot: money(commitments.reduce((s, c) => s + Number(c.open ?? 0), 0), { decimals: 0 }) },
  ];

  return (
    <div className="stack" style={{ gap: 20 }}>
      <form className="ops-toolbar" onSubmit={(e) => { e.preventDefault(); if (jobId) go(jobId, f, t); }}>
        <Field label="Job"><JobSelect jobs={jobs} value={jobId ?? ''} onChange={(id) => id && go(id, f, t)} /></Field>
        <Field label="From"><Input type="date" value={f} onChange={(e) => setF(e.target.value)} /></Field>
        <Field label="To"><Input type="date" value={t} onChange={(e) => setT(e.target.value)} /></Field>
        <Button type="submit" disabled={!jobId}>Apply</Button>
        <span className="sp" />
        <Seg aria-label="Group by" value={by} onChange={setBy} items={[{ value: 'code', label: 'Cost code' }, { value: 'type', label: 'Type' }, { value: 'month', label: 'Month' }, { value: 'source', label: 'Source' }]} />
      </form>
      {!jobId ? <div className="mp-table"><WidgetState state={{ kind: 'empty', title: 'Pick a job', body: 'Its cost lines from Merit Books show here, grouped and drillable to the bill, payroll run or entry that made them.' }} /></div> : (
        <>
          <div className="cm-figs">
            <Figure dense label="Cost in the period" value={money(total, { decimals: 0 })} vs={[`${money(pending, { decimals: 0 })} pending approval in Books`, `${rows.length} lines`]} href={`/jobs/${jobId}?tab=job-cost`} linkLabel="Cost by cost code" />
            <Figure dense label="Committed, not yet invoiced" value={money(commitments.reduce((s, c) => s + Number(c.open ?? 0), 0), { decimals: 0 })} vs={[`${commitments.length} commitments`]} href={`/jobs/${jobId}?tab=commitments`} linkLabel="Commitments" />
          </div>
          {groups.length === 0 ? <div className="mp-table"><WidgetState state={{ kind: 'empty', title: 'No cost in this period', body: 'Widen the dates, or check that Merit Books has posted the job’s bills, payroll and charges.' }} /></div> : (
            <div className="mp-table" style={{ overflowX: 'auto' }}>
              <table className="tbl tbl-q tbl-q--compact" aria-label="Cost groups">
                <thead><tr><th>{by === 'code' ? 'Cost code' : by === 'type' ? 'Cost type' : by === 'month' ? 'Month' : 'Source'}</th><th className="n" style={{ width: 90 }}>Lines</th><th className="n" style={{ width: 140 }}>Pending</th><th className="n" style={{ width: 140 }}>Total</th><th className="n" style={{ width: 90 }}>Share</th></tr></thead>
                <tbody>{groups.map((g) => (
                  <tr key={g.key} className="q-row"><td className="b">{g.label}</td><td className="n tnum">{g.rows.length}</td><td className="n tnum">{g.pending ? money(g.pending) : '—'}</td><td className="n tnum">{money(g.total)}</td><td className="n tnum">{total ? `${Math.round((g.total / total) * 100)}%` : '—'}</td></tr>
                ))}</tbody>
                <tfoot><tr className="q-row b"><td>Total</td><td className="n tnum">{rows.length}</td><td className="n tnum">{money(pending)}</td><td className="n tnum">{money(total)}</td><td /></tr></tfoot>
              </table>
            </div>
          )}
          <section className="sec" aria-label="Cost lines">
            <div className="sec-h"><h2 className="t-section">Cost lines</h2><span className="t-cap ink-3">Open a line for its source</span></div>
            <CmTable label="Cost lines" keys rows={flat} cols={lineCols} rowKey={(r) => r.id} onOpen={(r) => setOpenId(r.id)} activeId={openId}
              empty={{ title: 'No cost lines', body: 'Nothing posted to this job in the period.' }} />
            {groups.some((g) => g.rows.length > (expanded[g.key] ?? PAGE)) && (
              <div style={{ marginTop: 8 }}><Button variant="quiet" onClick={() => setExpanded(Object.fromEntries(groups.map((g) => [g.key, g.rows.length])))}>Show all {rows.length} lines</Button></div>
            )}
            <TableKeys />
          </section>
          <section className="sec" aria-label="Commitments">
            <div className="sec-h"><h2 className="t-section">Committed, invoiced and paid</h2></div>
            <CmTable label="Commitments" rows={commitments} cols={cmCols} rowKey={(c) => c.commitment_id} foot onOpen={() => router.push(`/jobs/${jobId}?tab=commitments`)}
              empty={{ title: 'No commitments on this job', body: 'Subcontracts and purchase orders appear here with what has been invoiced and paid against them.' }} />
            <p className="t-cap" style={{ marginTop: 8 }}>Paid is from the payments recorded against each commitment (the lien waivers they request).</p>
          </section>
        </>
      )}
      <Drawer open={!!open} onClose={() => setOpenId(null)} width={460} title={open?.description ?? 'Cost line'} eyebrow={open ? COST_SOURCE_WORDS[costSource(open)].word : undefined}>
        {open && (
          <div className="stack" style={{ gap: 20 }}>
            <KV items={[
              { term: 'Amount', value: cm(open.amount_cents) }, { term: 'Date', value: day(open.occurred_on, today) },
              { term: 'Cost code', value: [open.cost_code, open.cost_code_id ? codeName.get(open.cost_code_id) : null].filter(Boolean).join(' ') || '—' },
              { term: 'Cost type', value: words(open.cost_type) }, { term: 'Vendor', value: open.vendor_id ? vendors[open.vendor_id] ?? '—' : '—' },
              { term: 'Commitment', value: open.commitment_number ?? '—' }, { term: 'Status in Books', value: open.lifecycle === 'PENDING' ? 'Pending approval' : 'Posted' },
              { term: 'Gate', value: words(open.gate) }, { term: 'Source reference', value: <span className="code">{open.source_ref}</span> },
              { term: 'GL entry', value: open.gl_entry_id ? <span className="code">{open.gl_entry_id.slice(0, 8)}</span> : 'Not posted yet' },
            ]} />
            {booksPresent && (
              <DSection title="In Merit Books">
                <p className="t-cap" style={{ marginBottom: 8 }}>Find it by the source reference above.</p>
                <a className="btn" href={`${booksUrl()}${COST_SOURCE_WORDS[costSource(open)].books}`} target="_blank" rel="noreferrer">Open {COST_SOURCE_WORDS[costSource(open)].word.toLowerCase()}s in Merit Books</a>
              </DSection>
            )}
          </div>
        )}
      </Drawer>
    </div>
  );
}

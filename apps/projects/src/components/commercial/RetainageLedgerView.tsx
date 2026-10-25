'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Button, Drawer, Figure, KV, Tabs, Tag, money } from '@meritbooks/merit-ui';
import { payableReleaseState, receivableByCustomer, type PayableRetainageRow, type RetainageBothRow, type RetainageByParty } from '@/lib/commercial/screen-logic';
import type { JobOption } from '@/lib/pm/ops/scope';
import { useShell } from '@/components/shell/ShellContext';
import { useOps } from '@/components/ops/common/useOps';
import { DSection, Failure, cm, day } from './common';
import { CmTable, TableKeys, type Col } from './kit';

type Tab = 'receivable' | 'payable' | 'by-customer';
type Open = { kind: 'job'; row: RetainageBothRow } | { kind: 'sub'; row: PayableRetainageRow } | null;

const RELEASE_WORDS = { RELEASED: 'Released', READY: 'Ready to release', NEEDS_FINAL_WAIVER: 'Needs final waiver', NONE_HELD: 'None held' } as const;

/**
 * Retainage, both sides (CGC-49): what the owner (or, for a sub, each GC) holds from us, with
 * release eligibility at substantial completion and the release billing; and what we hold from
 * each sub, released only once their final lien waiver is verified.
 */
export function RetainageLedgerView({ both, payable, vendors, jobs, today, initialTab = 'receivable', canBill, canRelease }: {
  both: RetainageBothRow[]; payable: PayableRetainageRow[]; vendors: Readonly<Record<string, string>>; jobs: JobOption[]; today: string;
  initialTab?: Tab; canBill: boolean; canRelease: boolean;
}) {
  const { readOnly } = useShell();
  const { act, busy, error } = useOps();
  const [tab, setTab] = useState<Tab>(initialTab);
  const [open, setOpen] = useState<Open>(null);
  const byJob = useMemo(() => new Map(jobs.map((j) => [j.id, j])), [jobs]);
  const label = (id: string) => byJob.get(id)?.label ?? 'Job';
  const rec = both.filter((r) => Number(r.receivable_held_cents ?? 0) !== 0);
  const recOut = rec.reduce((s, r) => s + Number(r.receivable_outstanding_cents ?? 0), 0);
  const eligible = rec.filter((r) => r.receivable_release_eligible);
  const payOut = payable.reduce((s, r) => s + Number(r.outstanding_cents ?? 0), 0);
  const ready = payable.filter((p) => payableReleaseState(p) === 'READY');
  const groups = receivableByCustomer(rec, (id) => ({ id: byJob.get(id)?.customerId ?? null, name: byJob.get(id)?.customer ?? null }));

  const billRelease = (jobId: string) => void act<{ id: string }>('bill:' + jobId, 'post', `/api/jobs/${jobId}/billing`, { mode: 'retainage' }, 'Drafted the retainage release billing');
  const releaseSub = (commitmentId: string) => void act('rel:' + commitmentId, 'post', `/api/commercial/subcontracts/${commitmentId}`, { op: 'release_retainage', amountCents: null }, 'Released the sub’s retainage to Merit Books for payment');

  const recCols: Col<RetainageBothRow>[] = [
    { key: 'job', head: 'Job', cell: (r) => <><span className="b">{label(r.job_id)}</span>{byJob.get(r.job_id)?.customer && <span className="ops-sub" style={{ display: 'block' }}>{byJob.get(r.job_id)!.customer}</span>}</> },
    { key: 'held', head: 'Held', n: true, width: 130, cell: (r) => cm(r.receivable_held_cents, 0), foot: money(rec.reduce((s, r) => s + Number(r.receivable_held_cents ?? 0), 0), { decimals: 0 }) },
    { key: 'rel', head: 'Released', n: true, width: 130, cell: (r) => cm(r.receivable_released_cents, 0), foot: money(rec.reduce((s, r) => s + Number(r.receivable_released_cents ?? 0), 0), { decimals: 0 }) },
    { key: 'out', head: 'Outstanding', n: true, width: 140, cell: (r) => cm(r.receivable_outstanding_cents, 0), foot: money(recOut, { decimals: 0 }) },
    { key: 'sc', head: 'Substantial completion', width: 170, cell: (r) => day(r.substantial_completion_on, today) },
    { key: 'state', head: 'Release', width: 170, cell: (r) => (r.receivable_release_eligible ? <Tag tone="pos">Billable now</Tag> : Number(r.receivable_outstanding_cents ?? 0) <= 0 ? <Tag>Released</Tag> : <span className="t-cap">At substantial completion</span>) },
  ];
  const payCols: Col<PayableRetainageRow>[] = [
    { key: 'sub', head: 'Subcontract', cell: (r) => <><span className="b">{r.vendor_id ? vendors[r.vendor_id] ?? 'Subcontractor' : 'Subcontractor'}</span><span className="ops-sub" style={{ display: 'block' }}>{[r.number, label(r.job_id)].filter(Boolean).join(' · ')}</span></> },
    { key: 'held', head: 'Held', n: true, width: 130, cell: (r) => cm(r.held_cents, 0), foot: money(payable.reduce((s, r) => s + Number(r.held_cents ?? 0), 0), { decimals: 0 }) },
    { key: 'rel', head: 'Released', n: true, width: 130, cell: (r) => cm(r.released_cents, 0), foot: money(payable.reduce((s, r) => s + Number(r.released_cents ?? 0), 0), { decimals: 0 }) },
    { key: 'out', head: 'Outstanding', n: true, width: 140, cell: (r) => cm(r.outstanding_cents, 0), foot: money(payOut, { decimals: 0 }) },
    { key: 'state', head: 'Release', width: 180, cell: (r) => { const s = payableReleaseState(r); return <Tag tone={s === 'READY' ? 'pos' : s === 'NEEDS_FINAL_WAIVER' ? 'warn' : undefined}>{RELEASE_WORDS[s]}</Tag>; } },
  ];
  const custCols: Col<RetainageByParty>[] = [
    { key: 'who', head: 'Held by', cell: (g) => <span className="b">{g.label}</span> },
    { key: 'jobs', head: 'Jobs', n: true, width: 80, cell: (g) => g.jobs },
    { key: 'held', head: 'Held', n: true, width: 130, cell: (g) => money(g.held, { decimals: 0 }) },
    { key: 'out', head: 'Outstanding', n: true, width: 140, cell: (g) => money(g.outstanding, { decimals: 0 }) },
    { key: 'elig', head: 'Billable now', n: true, width: 140, cell: (g) => (g.eligible ? money(g.eligible, { decimals: 0 }) : '—') },
  ];

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="cm-figs">
        <Figure dense label="Retainage receivable" value={money(recOut, { decimals: 0 })} vs={[`${eligible.length} jobs billable now`, `${money(eligible.reduce((s, r) => s + Number(r.receivable_outstanding_cents ?? 0), 0), { decimals: 0 })} eligible`]} href="/retainage-ledger?tab=receivable" linkLabel="Receivable" />
        <Figure dense label="Retainage payable to subs" value={money(payOut, { decimals: 0 })} vs={[`${ready.length} ready to release`, `${payable.filter((p) => payableReleaseState(p) === 'NEEDS_FINAL_WAIVER').length} waiting on a final waiver`]} href="/compliance?tab=waivers" linkLabel="Lien waivers" />
      </div>
      <Tabs aria-label="Retainage side" value={tab} onChange={setTab} items={[
        { value: 'receivable', label: 'Receivable', count: rec.length },
        { value: 'by-customer', label: 'By owner or GC', count: groups.length },
        { value: 'payable', label: 'Payable to subs', count: payable.length },
      ]} />
      <Failure text={error} />
      {tab === 'receivable' && <CmTable label="Retainage receivable" keys rows={rec} cols={recCols} rowKey={(r) => r.job_id} onOpen={(r) => setOpen({ kind: 'job', row: r })} foot
        activeId={open?.kind === 'job' ? open.row.job_id : null} rowTone={(r) => (r.receivable_release_eligible ? 'warn' : null)}
        empty={{ title: 'No retainage held from you', body: 'Retainage appears here as pay applications are billed with a retainage rate.' }} />}
      {tab === 'by-customer' && <CmTable label="Retainage by owner or GC" keys rows={groups} cols={custCols} rowKey={(g) => g.key}
        empty={{ title: 'No retainage held from you', body: 'Each owner or GC holding retainage is listed with what is billable now.' }} />}
      {tab === 'payable' && <CmTable label="Retainage payable" keys rows={payable} cols={payCols} rowKey={(r) => r.commitment_id} onOpen={(r) => setOpen({ kind: 'sub', row: r })} foot
        activeId={open?.kind === 'sub' ? open.row.commitment_id : null} rowTone={(r) => (payableReleaseState(r) === 'READY' ? 'warn' : null)}
        empty={{ title: 'No retainage held from subs', body: 'Approving a sub pay application with a retainage rate holds it here until their final waiver is verified.' }} />}
      <TableKeys />

      <Drawer open={!!open} onClose={() => setOpen(null)} width={480} title={open?.kind === 'job' ? label(open.row.job_id) : open ? (open.row.vendor_id ? vendors[open.row.vendor_id] ?? 'Subcontractor' : 'Subcontractor') : ''} eyebrow={open?.kind === 'job' ? 'Retainage receivable' : 'Retainage payable'}>
        {open?.kind === 'job' && (
          <div className="stack" style={{ gap: 20 }}>
            <KV items={[
              { term: 'Held to date', value: cm(open.row.receivable_held_cents) }, { term: 'Released', value: cm(open.row.receivable_released_cents) },
              { term: 'Outstanding', value: cm(open.row.receivable_outstanding_cents) }, { term: 'Substantial completion', value: day(open.row.substantial_completion_on, today) },
              { term: 'We hold from subs on this job', value: cm(open.row.payable_outstanding_cents) },
            ]} />
            <DSection title="Release">
              {open.row.receivable_release_eligible
                ? <p className="t-cap" style={{ marginBottom: 8 }}>Substantial completion has passed. Bill the release; Merit Books invoices it and clears the retainage receivable.</p>
                : <p className="t-cap" style={{ marginBottom: 8 }}>Becomes billable at substantial completion (set it on the job’s contract settings), or earlier for early-release trades.</p>}
              {!readOnly && canBill && Number(open.row.receivable_outstanding_cents ?? 0) > 0 && (
                <Button variant={open.row.receivable_release_eligible ? 'primary' : 'default'} disabled={busy !== null} onClick={() => billRelease(open.row.job_id)}>{busy === 'bill:' + open.row.job_id ? 'Drafting…' : 'Draft the release billing'}</Button>
              )}
              <p className="t-cap" style={{ marginTop: 8 }}><Link className="link" href={`/jobs/${open.row.job_id}?tab=billing`}>Open the job’s billing</Link></p>
            </DSection>
          </div>
        )}
        {open?.kind === 'sub' && (
          <div className="stack" style={{ gap: 20 }}>
            <KV items={[
              { term: 'Subcontract', value: open.row.number ?? '—' }, { term: 'Job', value: label(open.row.job_id) },
              { term: 'Held', value: cm(open.row.held_cents) }, { term: 'Released', value: cm(open.row.released_cents) }, { term: 'Outstanding', value: cm(open.row.outstanding_cents) },
              { term: 'Final lien waiver', value: open.row.final_waiver_verified ? 'Verified' : 'Not verified yet' },
            ]} />
            <DSection title="Release">
              {payableReleaseState(open.row) === 'NEEDS_FINAL_WAIVER' && <p className="t-cap" style={{ marginBottom: 8 }}>Request and verify the sub’s final lien waiver first. <Link className="link" href="/compliance?tab=waivers">Lien waivers</Link></p>}
              {!readOnly && canRelease && payableReleaseState(open.row) === 'READY' && (
                <Button variant="primary" disabled={busy !== null} onClick={() => releaseSub(open.row.commitment_id)}>{busy === 'rel:' + open.row.commitment_id ? 'Releasing…' : `Release ${cm(open.row.outstanding_cents)}`}</Button>
              )}
            </DSection>
          </div>
        )}
      </Drawer>
    </div>
  );
}

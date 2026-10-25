'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Button, Drawer, Field, Figure, Input, KV, Seg, Tag, Textarea, money, pct } from '@meritbooks/merit-ui';
import { buyoutRisk, buyoutSummary, type BuyoutPackage } from '@/lib/commercial/screen-logic';
import { useMoneyVis } from '@/components/shell/ShellContext';
import { useOps } from '@/components/ops/common/useOps';
import { JobSelect } from '@/components/ops/common/bits';
import { DSection, Failure, cm, day } from './common';
import { CmTable, TableKeys, words, type Col } from './kit';

type Status = 'OPEN' | 'BIDDING' | 'AWARDED' | 'NOT_NEEDED';
const STATUS_WORD: Readonly<Record<Status, string>> = { OPEN: 'Not bought', BIDDING: 'Bidding', AWARDED: 'Bought', NOT_NEEDED: 'Not needed' };

/**
 * The buyout log (CGC-30): budget against what each trade package was bought for, buyout
 * percent, savings or loss, and the packages not bought yet with their need-by dates from the
 * schedule — at risk inside two weeks, late past it.
 */
export function BuyoutView({ packages, jobLabel, today, canEdit, onSeed, onChanged, keys = true }: {
  packages: BuyoutPackage[]; jobLabel?: (jobId: string) => string; today: string; canEdit: boolean; onSeed?: () => void; onChanged?: () => void; keys?: boolean;
}) {
  const mv = useMoneyVis();
  const { act, busy, error } = useOps();
  const [filter, setFilter] = useState<'open' | 'all'>('all');
  const [openId, setOpenId] = useState<string | null>(null);
  const s = buyoutSummary(packages);
  const shown = filter === 'open' ? packages.filter((p) => p.status === 'OPEN' || p.status === 'BIDDING') : packages;
  const open = packages.find((p) => p.package_id === openId) ?? null;
  const save = async (id: string, body: Record<string, unknown>, ok: string) => {
    const r = await act(`p:${id}`, 'patch', `/api/commercial/buyout/${id}`, body, ok);
    if (r) onChanged?.();
  };

  const cols: Col<BuyoutPackage>[] = [
    { key: 'pkg', head: 'Package', cell: (p) => <><span className="b">{p.name}</span>{jobLabel && <span className="ops-sub" style={{ display: 'block' }}>{jobLabel(p.job_id)}</span>}</> },
    { key: 'status', head: 'Status', width: 130, cell: (p) => (p.status === 'AWARDED' ? <Tag tone="pos">Bought</Tag> : <Tag>{STATUS_WORD[p.status as Status] ?? words(p.status)}</Tag>) },
    { key: 'need', head: 'Need by', width: 150, cell: (p) => { const r = buyoutRisk(p); return <>{day(p.need_by, today)}{r && <span style={{ display: 'block' }}><Tag tone={r === 'LATE' ? 'neg' : 'warn'}>{r === 'LATE' ? `${-Number(p.days_to_need)} days late` : `${p.days_to_need} days left`}</Tag></span>}</>; } },
    { key: 'budget', head: 'Budget', n: true, width: 130, hidden: !mv.cost, cell: (p) => cm(p.budget_cents, 0), foot: money(s.budget, { decimals: 0 }) },
    { key: 'bought', head: 'Bought for', n: true, width: 130, hidden: !mv.cost, cell: (p) => (Number(p.committed_cents ?? 0) > 0 ? cm(p.committed_cents, 0) : '—'), foot: money(s.committed, { decimals: 0 }) },
    { key: 'diff', head: 'Savings / (loss)', n: true, width: 140, hidden: !mv.cost, cell: (p) => (p.status === 'AWARDED' && p.budget_cents != null && p.committed_cents != null ? money(Number(p.budget_cents) - Number(p.committed_cents), { decimals: 0 }) : '—'), foot: money(s.savings, { decimals: 0 }) },
  ];

  return (
    <div className="stack" style={{ gap: 16 }}>
      {mv.cost && (
        <div className="cm-figs">
          <Figure dense label="Bought out" value={s.pctBought == null ? '—' : pct(s.pctBought)} vs={[`${s.bought} of ${s.bought + s.open} packages`, `${money(s.committed, { decimals: 0 })} committed`]} href="/commitments" linkLabel="Commitments" />
          <Figure dense label="Buyout savings" value={money(s.savings, { decimals: 0 })} vs={['against the budget of the packages bought']} href="/job-cost" linkLabel="Job cost" />
          <Figure dense label="Not bought, need date close" value={String(s.atRisk + s.late)} vs={[`${s.late} past the need date`, `${s.atRisk} inside two weeks`]} href="/schedule" linkLabel="Schedule" />
        </div>
      )}
      <div className="ops-toolbar">
        <Seg aria-label="Which packages" value={filter} onChange={setFilter} items={[{ value: 'all', label: 'All', count: packages.length }, { value: 'open', label: 'Not bought', count: s.open }]} />
        <span className="sp" />
        {onSeed && canEdit && <Button disabled={busy !== null} onClick={onSeed}>Seed from the budget</Button>}
      </div>
      <Failure text={error} />
      <CmTable label="Buyout log" keys={keys} rows={shown} cols={cols} rowKey={(p) => p.package_id} onOpen={(p) => setOpenId(p.package_id)} activeId={openId} foot={mv.cost}
        rowTone={(p) => (buyoutRisk(p) === 'LATE' ? 'neg' : buyoutRisk(p) === 'AT_RISK' ? 'warn' : null)}
        empty={{ title: filter === 'open' ? 'Everything is bought' : 'No buyout packages yet', body: 'Seed one package per CSI division from the budget’s cost codes, then buy each out: bid, award the subcontract, mark it bought.' }} />
      <TableKeys />
      <Drawer open={!!open} onClose={() => setOpenId(null)} width={460} title={open?.name ?? ''} eyebrow={open && jobLabel ? jobLabel(open.job_id) : 'Buyout package'}>
        {open && <PackageDetail key={open.package_id} p={open} today={today} canEdit={canEdit} busy={busy} save={save} showMoney={mv.cost} />}
      </Drawer>
    </div>
  );
}

function PackageDetail({ p, today, canEdit, busy, save, showMoney }: { p: BuyoutPackage; today: string; canEdit: boolean; busy: string | null; save: (id: string, body: Record<string, unknown>, ok: string) => Promise<void>; showMoney: boolean }) {
  const [needBy, setNeedBy] = useState(p.need_by ?? '');
  const [lead, setLead] = useState(String(p.lead_time_days ?? 30));
  const [notes, setNotes] = useState('');
  const k = `p:${p.package_id}`;
  return (
    <div className="stack" style={{ gap: 20 }}>
      <KV items={[
        { term: 'Division', value: p.csi_division ?? '—' },
        { term: 'Status', value: STATUS_WORD[p.status as Status] ?? words(p.status) },
        { term: 'Need by', value: day(p.need_by, today) },
        ...(showMoney ? [{ term: 'Budget', value: cm(p.budget_cents) }, { term: 'Bought for', value: cm(p.committed_cents) }] : []),
      ]} />
      {canEdit && (
        <>
          <DSection title="Status">
            <Seg aria-label="Package status" value={p.status as Status} onChange={(v) => void save(p.package_id, { status: v }, `${p.name}: ${STATUS_WORD[v].toLowerCase()}`)}
              items={(['OPEN', 'BIDDING', 'AWARDED', 'NOT_NEEDED'] as const).map((v) => ({ value: v, label: STATUS_WORD[v] }))} />
            <p className="t-cap" style={{ marginTop: 8 }}>“Bought for” is the approved subcontracts and POs on the package’s cost codes. <Link className="link" href={`/jobs/${p.job_id}?tab=commitments`}>Open the job’s commitments</Link></p>
          </DSection>
          <DSection title="Need date">
            <form className="stack" style={{ gap: 8 }} onSubmit={(e) => { e.preventDefault(); void save(p.package_id, { needBy: needBy || null, leadTimeDays: Math.max(0, Math.round(Number(lead) || 0)), ...(notes.trim() ? { notes: notes.trim() } : {}) }, 'Saved the package'); }}>
              <div className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
                <Field label="Need by" help="Blank: the linked schedule activity's start less the lead time."><Input type="date" value={needBy} onChange={(e) => setNeedBy(e.target.value)} /></Field>
                <Field label="Lead time (days)"><Input inputMode="numeric" value={lead} onChange={(e) => setLead(e.target.value.replace(/[^0-9]/g, ''))} style={{ width: 90 }} /></Field>
              </div>
              <Field label="Notes"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} placeholder="Bidders, scope gaps, leveling notes" /></Field>
              <div><Button type="submit" disabled={busy !== null}>{busy === k ? 'Saving…' : 'Save'}</Button></div>
            </form>
          </DSection>
        </>
      )}
    </div>
  );
}

/** Buyout across jobs: pick a job (or every job) and seed its packages from the budget. */
export function BuyoutBoard({ packages, jobs, today, canEdit }: { packages: BuyoutPackage[]; jobs: ReadonlyArray<{ id: string; label: string; open: boolean; customer: string | null; company: string | null; companyId: string; customerId: string | null; jobTypeKey: string }>; today: string; canEdit: boolean }) {
  const { act } = useOps();
  const [jobId, setJobId] = useState('');
  const label = new Map(jobs.map((j) => [j.id, j.label]));
  const rows = packages.filter((p) => !jobId || p.job_id === jobId);
  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="ops-toolbar">
        <Field label="Job"><JobSelect jobs={jobs.filter((j) => j.open || packages.some((p) => p.job_id === j.id))} value={jobId} onChange={setJobId} placeholder="Every job" /></Field>
      </div>
      <BuyoutView packages={rows} jobLabel={jobId ? undefined : (id) => label.get(id) ?? 'Job'} today={today} canEdit={canEdit}
        onSeed={jobId ? () => void act<{ seeded: number }>('seed', 'post', '/api/commercial/buyout', { jobId }, (d) => `Added ${d.seeded} buyout ${d.seeded === 1 ? 'package' : 'packages'} from the budget`) : undefined} />
    </div>
  );
}

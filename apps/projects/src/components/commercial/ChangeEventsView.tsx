'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Button, Check, Drawer, Field, Figure, Input, Seg, Select, Tag, Textarea, WidgetState, count, money } from '@meritbooks/merit-ui';
import { CHANGE_EVENT_STATUS, PCO_STATUS, RFQ_STATUS } from '@/lib/commercial/labels';
import { CHANGE_SOURCES, SOURCE_WORDS, type ChangeEventRow, type ChangeSource, type ExposureRow, type PcoRow, type RfqRow } from '@/lib/commercial/types';
import type { JobOption } from '@/lib/pm/ops/scope';
import { useMoneyVis, useShell } from '@/components/shell/ShellContext';
import { JobSelect } from '@/components/ops/common/bits';
import { useDetail, useOps } from '@/components/ops/common/useOps';
import { Actions, DSection, Failure, Mk, cm, day, daysSince, parseDollars } from './common';

export interface ChangeEventsViewProps {
  events: ChangeEventRow[];
  pcos: PcoRow[];
  rfqs: RfqRow[];
  exposure: ExposureRow[];
  jobs: JobOption[];
  vendors: Array<{ id: string; name: string }>;
  commitments: Array<{ id: string; number: string | null; vendorId: string | null; jobId: string }>;
  today: string;
}

type Tab = 'open' | 'with_owner' | 'decided' | 'all';
const OPEN: ReadonlySet<string> = new Set(['OPEN', 'PRICING', 'PRICED']);

/**
 * The change chain (CGC-32..37): every change event from the field or the design team, priced
 * by the subs (RFQ), rolled into a PCO with the contract markups, sent to the owner as a COR,
 * and carried back to the subs' commitment changes once the owner approves. The exposure line
 * on top is what is at risk right now: pending with the owner, unpriced, and work proceeding
 * without a price.
 */
export function ChangeEventsView(p: ChangeEventsViewProps) {
  const vis = useMoneyVis();
  const { readOnly } = useShell();
  const { act, busy, version, error } = useOps();
  const [jobId, setJobId] = useState('');
  const [tab, setTab] = useState<Tab>('open');
  const [open, setOpen] = useState<ChangeEventRow | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const jobs = useMemo(() => new Map(p.jobs.map((j) => [j.id, j])), [p.jobs]);

  const inJob = <T extends { job_id: string }>(xs: T[]) => xs.filter((x) => !jobId || x.job_id === jobId);
  const events = inJob(p.events);
  const shown = events.filter((e) => tab === 'all' || (tab === 'open' ? OPEN.has(e.status) : tab === 'with_owner' ? e.status === 'SUBMITTED' : !OPEN.has(e.status) && e.status !== 'SUBMITTED'));
  const ex = inJob(p.exposure);
  const sum = (k: keyof ExposureRow) => ex.reduce((s, r) => s + Number(r[k] ?? 0), 0);
  const pickedEvents = p.events.filter((e) => picked.has(e.id));
  const pickJob = pickedEvents[0]?.job_id ?? null;
  const pickable = (e: ChangeEventRow) => OPEN.has(e.status) && !e.pco_id && (!pickJob || e.job_id === pickJob);

  return (
    <div className="stack" style={{ gap: 24 }}>
      <div className="row" style={{ gap: 32, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        {vis.contract && <Figure dense label="With the owner" value={money(sum('pending_cents'), { decimals: 0 })} vs={[`${count(sum('pending_count'))} pending`, `${money(sum('pending_over_30_cents'), { decimals: 0 })} over 30 days`]} href="/change-orders" linkLabel="Change orders" />}
        {vis.contract && <Figure dense label="Approved changes" value={money(sum('approved_cents'), { decimals: 0 })} vs={[`${money(sum('rejected_cents'), { decimals: 0 })} rejected`]} href="/change-orders" linkLabel="Change orders" />}
        <Figure dense label="Not priced yet" value={count(sum('unpriced_count'))} vs={[vis.contract ? `${money(sum('unpriced_rom_cents'), { decimals: 0 })} rough order` : 'changes to price', `${count(sum('proceeding_count'))} proceeding without a price`]} href="/change-events" linkLabel="Change events" />
        {vis.cost && vis.contract && <Figure dense label="Owner changes without a sub change" value={money(sum('owner_co_without_sub_co_cents'), { decimals: 0 })} vs={[`${money(sum('sub_co_without_owner_co_cents'), { decimals: 0 })} sub changes with no owner change`]} href="/commitments" linkLabel="Commitments" />}
      </div>

      <div className="ops-toolbar">
        <Field label="Job"><JobSelect jobs={p.jobs.filter((j) => p.events.some((e) => e.job_id === j.id) || j.open)} value={jobId} onChange={setJobId} placeholder="Every job" /></Field>
        <Seg aria-label="Which changes" value={tab} onChange={setTab} items={[
          { value: 'open', label: 'Open', count: events.filter((e) => OPEN.has(e.status)).length },
          { value: 'with_owner', label: 'With the owner', count: events.filter((e) => e.status === 'SUBMITTED').length },
          { value: 'decided', label: 'Decided' },
          { value: 'all', label: 'All' },
        ]} />
        <span className="sp" />
        {!readOnly && picked.size > 0 && vis.contract && (
          <Button variant="primary" disabled={busy !== null} onClick={async () => {
            const r = await act<{ id: string }>('pco', 'post', '/api/commercial/pcos', { op: 'build', jobId: pickJob, changeEventIds: [...picked], title: null }, 'Built the PCO with the contract markups');
            if (r) setPicked(new Set());
          }}>{busy === 'pco' ? 'Building…' : `Build PCO from ${count(picked.size)}`}</Button>
        )}
        {!readOnly && <Button icon="plus" onClick={() => setAdding((v) => !v)}>New change event</Button>}
      </div>
      <Failure text={error} />
      {adding && !readOnly && <NewChangeEvent jobs={p.jobs.filter((j) => j.open)} defaultJobId={jobId} busy={busy === 'add'} money={vis.contract} cost={vis.cost}
        onSave={async (b) => { const r = await act<{ number: string }>('add', 'post', '/api/commercial/change-events', b, (d) => `Logged ${d.number}`); if (r) setAdding(false); return !!r; }} />}

      <div className="mp-table">
        {shown.length === 0 ? (
          <WidgetState state={{ kind: 'empty', title: tab === 'open' ? 'No open changes' : 'Nothing here', body: 'A change event is anything that may change the price or the schedule: a field condition, an RFI answer, an ASI, an owner request. Log it the day it happens; price it later.' }} />
        ) : (
          <table className="tbl tbl-q tbl-q--compact">
            <thead><tr>
              {!readOnly && vis.contract && <th style={{ width: 36 }}><span className="sr-only">Pick</span></th>}
              <th style={{ width: 88 }}>Number</th><th>Change</th><th style={{ width: 150 }}>Source</th><th style={{ width: 140 }}>Status</th>
              {vis.contract && <th className="n" style={{ width: 120 }}>Rough sell</th>}
              {vis.cost && <th className="n" style={{ width: 120 }}>Rough cost</th>}
              <th style={{ width: 100 }}>Age</th>
            </tr></thead>
            <tbody>
              {shown.map((e) => (
                <tr key={e.id} className="q-row" onClick={() => setOpen(e)} style={{ cursor: 'pointer' }}>
                  {!readOnly && vis.contract && (
                    <td onClick={(x) => x.stopPropagation()}>
                      <Check aria-label={`Pick ${e.number}`} disabled={!pickable(e)} checked={picked.has(e.id)} onChange={(x) => {
                        const n = new Set(picked);
                        if (x.target.checked) n.add(e.id); else n.delete(e.id);
                        setPicked(n);
                      }} />
                    </td>
                  )}
                  <td><span className="code">{e.number}</span></td>
                  <td>
                    <span className="b">{e.title}</span>
                    {e.proceeding && <> <Tag tone="warn">Proceeding{e.directive_ref ? ` · ${e.directive_ref}` : ''}</Tag></>}
                    {!jobId && <span className="ops-sub" style={{ display: 'block' }}>{jobs.get(e.job_id)?.label ?? 'Job'}</span>}
                  </td>
                  <td>{SOURCE_WORDS[e.source_type] ?? e.source_type}</td>
                  <td><Mk map={CHANGE_EVENT_STATUS} status={e.status} /></td>
                  {vis.contract && <td className="n">{cm(e.rom_revenue_cents, 0)}</td>}
                  {vis.cost && <td className="n">{cm(e.rom_cost_cents, 0)}</td>}
                  <td>{(() => { const d = daysSince(e.created_at.slice(0, 10), p.today) ?? 0; return d === 0 ? 'Today' : `${d} ${d === 1 ? 'day' : 'days'}`; })()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {vis.contract && <PcoTable pcos={inJob(p.pcos)} jobs={jobs} showJob={!jobId} readOnly={readOnly} busy={busy} act={act} today={p.today} />}

      <Drawer open={!!open} onClose={() => setOpen(null)} width={520} title={open ? `${open.number} · ${open.title}` : ''} eyebrow={open ? jobs.get(open.job_id)?.label ?? 'Change event' : undefined}>
        {open && <EventDetail ev={open} version={version} readOnly={readOnly} busy={busy} act={act} vendors={p.vendors}
          commitments={p.commitments.filter((c) => c.jobId === open.job_id)} rfqs={p.rfqs.filter((r) => r.change_event_id === open.id)} today={p.today} />}
      </Drawer>
    </div>
  );
}

type Act = ReturnType<typeof useOps>['act'];

function NewChangeEvent({ jobs, defaultJobId, busy, money: showSell, cost, onSave }: { jobs: JobOption[]; defaultJobId: string; busy: boolean; money: boolean; cost: boolean; onSave: (b: Record<string, unknown>) => Promise<boolean> }) {
  const [jobId, setJobId] = useState(defaultJobId);
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [source, setSource] = useState<ChangeSource>('FIELD');
  const [scope, setScope] = useState<'IN' | 'OUT' | 'TBD'>('TBD');
  const [sell, setSell] = useState('');
  const [costText, setCost] = useState('');
  const [days, setDays] = useState('');
  const [err, setErr] = useState<string | null>(null);
  return (
    <form className="mp-table mp-add" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 12 }} onSubmit={(e) => {
      e.preventDefault();
      if (!jobId) return setErr('Pick the job.');
      if (!title.trim()) return setErr('Give the change a title.');
      const s = sell.trim() ? parseDollars(sell) : null;
      const c = costText.trim() ? parseDollars(costText) : null;
      if ((sell.trim() && s === null) || (costText.trim() && c === null)) return setErr('Enter amounts like 12,500 or 12500.50.');
      setErr(null);
      void onSave({ jobId, title: title.trim(), description: desc.trim() || null, sourceType: source, scope, romRevenueCents: s, romCostCents: c, scheduleDays: days.trim() ? Number(days) : null })
        .then((ok) => { if (ok) { setTitle(''); setDesc(''); setSell(''); setCost(''); } });
    }}>
      <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <Field label="Job" error={err ?? undefined}><JobSelect jobs={jobs} value={jobId} onChange={setJobId} /></Field>
        <Field label="Title"><Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder="Reroute conduit around new duct" style={{ width: 320 }} /></Field>
        <Field label="Source"><Select value={source} onChange={(e) => setSource(e.target.value as ChangeSource)}>{CHANGE_SOURCES.map((s) => <option key={s} value={s}>{SOURCE_WORDS[s]}</option>)}</Select></Field>
        <Field label="In contract scope"><Select value={scope} onChange={(e) => setScope(e.target.value as 'IN' | 'OUT' | 'TBD')}><option value="TBD">Not decided</option><option value="OUT">Out of scope</option><option value="IN">In scope</option></Select></Field>
      </div>
      <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        {showSell && <Field label="Rough sell ($)"><Input inputMode="decimal" value={sell} onChange={(e) => setSell(e.target.value)} placeholder="optional" style={{ width: 140 }} /></Field>}
        {cost && <Field label="Rough cost ($)"><Input inputMode="decimal" value={costText} onChange={(e) => setCost(e.target.value)} placeholder="optional" style={{ width: 140 }} /></Field>}
        <Field label="Schedule days"><Input inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value.replace(/[^\d-]/g, ''))} placeholder="0" style={{ width: 90 }} /></Field>
      </div>
      <Field label="What changed"><Textarea value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={2000} placeholder="Where, what drawing or RFI, who asked." /></Field>
      <div><Button type="submit" variant="primary" disabled={busy}>{busy ? 'Saving…' : 'Log change event'}</Button></div>
    </form>
  );
}

interface EventDetailData {
  event: ChangeEventRow;
  lines: Array<{ id: string; line_no: number; description: string; cost_type: string | null; rom_cost_cents: number | null; rom_revenue_cents: number | null }>;
  rfqs: RfqRow[];
}

function EventDetail({ ev, version, readOnly, busy, act, vendors, commitments, rfqs: rfqsIn, today }: {
  ev: ChangeEventRow; version: number; readOnly: boolean; busy: string | null; act: Act; vendors: Array<{ id: string; name: string }>;
  commitments: Array<{ id: string; number: string | null; vendorId: string | null }>; rfqs: RfqRow[]; today: string;
}) {
  const vis = useMoneyVis();
  const d = useDetail<EventDetailData>(`/api/commercial/change-events/${ev.id}`, version);
  const live = d.data?.event ?? ev;
  const rfqs = d.data?.rfqs ?? rfqsIn;
  const [vendor, setVendor] = useState('');
  const [due, setDue] = useState('');
  const [directive, setDirective] = useState(ev.directive_ref ?? '');
  const vname = (id: string) => vendors.find((v) => v.id === id)?.name ?? 'Subcontractor';
  const url = `/api/commercial/change-events/${ev.id}`;
  const open = OPEN.has(live.status);
  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="ops-facts">
        <span><Mk map={CHANGE_EVENT_STATUS} status={live.status} /></span>
        <span>{SOURCE_WORDS[live.source_type]}</span>
        <span>Scope <b>{live.scope === 'OUT' ? 'out' : live.scope === 'IN' ? 'in' : 'not decided'}</b></span>
        {vis.contract && <span>Rough sell <b>{cm(live.rom_revenue_cents, 0)}</b></span>}
        {vis.cost && <span>Rough cost <b>{cm(live.rom_cost_cents, 0)}</b></span>}
        {live.schedule_days != null && <span><b>{live.schedule_days}</b> schedule days</span>}
      </div>
      {live.description && <p style={{ whiteSpace: 'pre-wrap' }}>{live.description}</p>}
      <Failure text={d.error} title="Details did not load." />

      {(d.data?.lines.length ?? 0) > 0 && (
        <DSection title="Lines">
          <table className="ops-mini">
            <thead><tr><th>#</th><th>Line</th>{vis.cost && <th className="n">Cost</th>}{vis.contract && <th className="n">Sell</th>}</tr></thead>
            <tbody>{d.data!.lines.map((l) => <tr key={l.id}><td>{l.line_no}</td><td>{l.description}</td>{vis.cost && <td className="n">{cm(l.rom_cost_cents, 0)}</td>}{vis.contract && <td className="n">{cm(l.rom_revenue_cents, 0)}</td>}</tr>)}</tbody>
          </table>
        </DSection>
      )}

      {!readOnly && (
        <DSection title="Proceeding without a price">
          <p className="t-cap">When the owner directs the work before it is priced (a CCD), flag it: the days it runs unpriced show on the exposure line until the PCO is approved.</p>
          <div className="row" style={{ gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <Field label="Directive"><Input value={directive} onChange={(e) => setDirective(e.target.value)} placeholder="CCD-03" maxLength={60} style={{ width: 140 }} /></Field>
            <Button disabled={busy !== null} onClick={() => void act('proceed', 'post', url, { op: 'proceed', proceeding: !live.proceeding, directive: directive.trim() || null, since: live.proceeding ? null : today }, live.proceeding ? 'No longer flagged as proceeding' : 'Flagged: work proceeding without a price')}>
              {live.proceeding ? 'Clear the flag' : 'Work is proceeding'}
            </Button>
          </div>
        </DSection>
      )}

      {vis.cost && (
        <DSection title="Pricing from subcontractors">
          {rfqs.length === 0 ? <p className="t-cap">No requests for pricing yet.</p> : (
            <table className="ops-mini">
              <thead><tr><th>RFQ</th><th>Sub</th><th>Status</th><th className="n">Price</th><th /></tr></thead>
              <tbody>{rfqs.map((r) => (
                <tr key={r.id}>
                  <td><span className="code">{r.number}</span></td><td>{vname(r.vendor_id)}</td><td><Mk map={RFQ_STATUS} status={r.status} /></td><td className="n">{cm(r.total_cents, 0)}</td>
                  <td>{!readOnly && r.status === 'RESPONDED' && <Actions busy={busy} items={[
                    { key: `acc${r.id}`, label: 'Accept', onClick: () => void act(`acc${r.id}`, 'post', `/api/commercial/rfqs/${r.id}`, { op: 'decide', accept: true }, 'Accepted the price; it goes into the PCO') },
                    { key: `dec${r.id}`, label: 'Decline', onClick: () => void act(`dec${r.id}`, 'post', `/api/commercial/rfqs/${r.id}`, { op: 'decide', accept: false }, 'Declined') },
                  ]} />}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
          {!readOnly && open && (
            <div className="row" style={{ gap: 8, alignItems: 'flex-end', flexWrap: 'wrap', marginTop: 12 }}>
              <Field label="Ask a sub to price it"><Select value={vendor} onChange={(e) => setVendor(e.target.value)}>
                <option value="">Pick a subcontractor</option>
                {commitments.filter((c) => c.vendorId).map((c) => <option key={c.id} value={`${c.vendorId}|${c.id}`}>{vname(c.vendorId!)} · {c.number ?? 'subcontract'}</option>)}
                {vendors.filter((v) => !commitments.some((c) => c.vendorId === v.id)).slice(0, 200).map((v) => <option key={v.id} value={`${v.id}|`}>{v.name}</option>)}
              </Select></Field>
              <Field label="Price by"><Input type="date" value={due} min={today} onChange={(e) => setDue(e.target.value)} /></Field>
              <Button disabled={!vendor || busy !== null} onClick={async () => {
                const [v, c] = vendor.split('|');
                const r = await act('rfq', 'post', url, { op: 'rfq', vendorId: v, commitmentId: c || null, dueOn: due || null, scope: live.description }, 'Sent the request for pricing');
                if (r) setVendor('');
              }}>{busy === 'rfq' ? 'Sending…' : 'Send request'}</Button>
            </div>
          )}
        </DSection>
      )}

      {!readOnly && (
        <DSection title="Status">
          <Actions busy={busy} items={[
            { key: 'pricing', label: 'Pricing it', onClick: () => void act('pricing', 'post', url, { op: 'status', status: 'PRICING', note: null }, 'Marked as being priced'), hidden: live.status !== 'OPEN' },
            { key: 'nocost', label: 'No cost', onClick: () => void act('nocost', 'post', url, { op: 'status', status: 'NO_COST', note: null }, 'Closed with no cost'), hidden: !open },
            { key: 'reopen', label: 'Reopen', onClick: () => void act('reopen', 'post', url, { op: 'status', status: 'OPEN', note: null }, 'Reopened'), hidden: live.status !== 'NO_COST' },
            { key: 'void', label: 'Void', danger: true, onClick: () => void act('void', 'post', url, { op: 'status', status: 'VOID', note: null }, 'Voided'), hidden: !open },
          ]} />
          {live.pco_id && <p className="t-cap" style={{ marginTop: 8 }}>In a PCO; it moves with the PCO from here.</p>}
          {live.change_order_id && <p className="t-cap"><Link className="link" href={`/jobs/${live.job_id}?tab=changes`}>Open the owner change order</Link></p>}
        </DSection>
      )}
    </div>
  );
}

function PcoTable({ pcos, jobs, showJob, readOnly, busy, act, today }: { pcos: PcoRow[]; jobs: Map<string, JobOption>; showJob: boolean; readOnly: boolean; busy: string | null; act: Act; today: string }) {
  const vis = useMoneyVis();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const list = pcos.filter((x) => x.status !== 'ROLLED_UP' || x.tier === 'COR');
  const draft = pcos.filter((x) => picked.has(x.id));
  return (
    <section className="sec" aria-label="PCOs and CORs">
      <div className="sec-h" style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
        <h2 className="t-section">PCOs and change order requests</h2><span className="sp" style={{ flex: 1 }} />
        {!readOnly && draft.length > 1 && (
          <Button disabled={busy !== null || new Set(draft.map((d) => d.job_id)).size > 1} onClick={async () => {
            const r = await act('cor', 'post', '/api/commercial/pcos', { op: 'roll', pcoIds: [...picked], title: null }, 'Rolled into one change order request');
            if (r) setPicked(new Set());
          }}>Roll {count(draft.length)} into a COR</Button>
        )}
      </div>
      {list.length === 0 ? <p className="t-cap">Pick open change events above and build a PCO; the contract markups apply.</p> : (
        <div className="mp-table">
          <table className="tbl tbl-q tbl-q--compact">
            <thead><tr>
              {!readOnly && <th style={{ width: 36 }}><span className="sr-only">Pick</span></th>}
              <th style={{ width: 96 }}>Number</th><th>Title</th><th style={{ width: 130 }}>Status</th>
              {vis.cost && <th className="n" style={{ width: 120 }}>Cost</th>}
              {vis.cost && <th className="n" style={{ width: 110 }}>Markup</th>}
              <th className="n" style={{ width: 120 }}>Amount</th><th style={{ width: 110 }}>Owner due</th><th style={{ width: 240 }} />
            </tr></thead>
            <tbody>
              {list.map((x) => {
                const url = `/api/commercial/pcos/${x.id}`;
                const late = x.status === 'SUBMITTED' && x.due_on && x.due_on < today;
                return (
                  <tr key={x.id} className="q-row">
                    {!readOnly && <td><Check aria-label={`Pick ${x.number}`} disabled={x.status !== 'DRAFT' || x.tier !== 'PCO'} checked={picked.has(x.id)} onChange={(e) => {
                      const n = new Set(picked); if (e.target.checked) n.add(x.id); else n.delete(x.id); setPicked(n);
                    }} /></td>}
                    <td><span className="code">{x.number}</span>{x.tier === 'COR' && <> <Tag>COR</Tag></>}</td>
                    <td>{x.title}{showJob && <span className="ops-sub" style={{ display: 'block' }}>{jobs.get(x.job_id)?.label ?? 'Job'}</span>}</td>
                    <td><Mk map={PCO_STATUS} status={x.status} /></td>
                    {vis.cost && <td className="n">{cm(x.cost_cents)}</td>}
                    {vis.cost && <td className="n">{cm(x.markup_cents)}</td>}
                    <td className="n b">{cm(x.amount_cents)}</td>
                    <td>{x.due_on ? <>{day(x.due_on, today)}{late && <> <Tag tone="neg">Late</Tag></>}</> : '—'}</td>
                    <td>{!readOnly && <Actions busy={busy} items={[
                      { key: `sub${x.id}`, label: 'Send to owner', primary: true, onClick: () => void act(`sub${x.id}`, 'post', url, { op: 'submit', dueOn: null }, 'Sent to the owner as a change order request'), hidden: !(x.status === 'DRAFT' || x.status === 'REVISE') || (x.status === 'DRAFT' && x.tier === 'PCO' && !!x.parent_cor_id) },
                      { key: `rep${x.id}`, label: 'Reprice', onClick: () => void act(`rep${x.id}`, 'post', url, { op: 'reprice' }, 'Repriced with the current markups'), hidden: x.status !== 'DRAFT' && x.status !== 'REVISE' },
                      { key: `rev${x.id}`, label: 'Revise', onClick: () => void act(`rev${x.id}`, 'post', url, { op: 'revise', note: null }, 'Back to draft for revision'), hidden: x.status !== 'SUBMITTED' && x.status !== 'REJECTED' },
                      { key: `cco${x.id}`, label: 'Draft sub changes', onClick: () => void act<{ drafted: number }>(`cco${x.id}`, 'post', url, { op: 'propose_ccos' }, (r) => r.drafted ? `Drafted ${r.drafted} subcontract ${r.drafted === 1 ? 'change' : 'changes'}` : 'Every sub change is already drafted'), hidden: x.status !== 'APPROVED' },
                    ]} />}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

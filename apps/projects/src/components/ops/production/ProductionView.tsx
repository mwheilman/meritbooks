'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Button, Field, Input, Meter, Panel, PanelSection, Seg, Select, WidgetState, count, countStrokes, shortDate, useEscapeKey,
} from '@meritbooks/merit-ui';
import { PRODUCTION_STATUS_WORDS } from '@/lib/pm/ops/labels';
import { centerSentence, shopLoad } from '@/lib/pm/ops/shop-math';
import type { OperationRow, ProductionStatusRow, RoutingRow, RoutingStepRow, WorkCenterLoadRow, WorkCenterRow, WoStatus } from '@/lib/pm/ops/types';
import type { JobOption } from '@/lib/pm/ops/scope';
import { useShell, useVocab } from '@/components/shell/ShellContext';
import { lower } from '@/lib/pm/vocab';
import { Failure, JobSelect, Section, parseNum } from '../common/bits';
import { useOps } from '../common/useOps';
import { ProductionPanel } from './ProductionPanel';
import { ShopFloor } from './ShopFloor';
import { ShopSetup } from './ShopSetup';

export type ProductionTab = 'board' | 'floor' | 'setup';

export interface ProductionViewProps {
  orders: ProductionStatusRow[];
  load: WorkCenterLoadRow[];
  floor: OperationRow[];
  centers: WorkCenterRow[];
  routings: RoutingRow[];
  steps: RoutingStepRow[];
  jobs: JobOption[];
  jobLabels: Record<string, string>;
  companyId: string | null;
  today: string;
  initialTab: ProductionTab;
  focusId: string | null;
  /** Job tab: only this job's orders; new orders go on it. */
  fixedJobId?: string | null;
}

const COLS: Array<{ id: string; title: string; statuses: WoStatus[]; caption: string }> = [
  { id: 'eng', title: 'Engineering', statuses: ['NEW'], caption: 'Drawings, cut list, routing' },
  { id: 'rel', title: 'Released', statuses: ['RELEASED'], caption: 'In the shop queue' },
  { id: 'run', title: 'In the shop', statuses: ['IN_PROGRESS'], caption: 'Operations running' },
  { id: 'hold', title: 'On hold', statuses: ['ON_HOLD'], caption: 'Waiting on something' },
  { id: 'done', title: 'Complete', statuses: ['COMPLETE', 'CLOSED'], caption: 'Last 30 days' },
];

export function ProductionView(p: ProductionViewProps) {
  const router = useRouter();
  const v = useVocab();
  const { readOnly } = useShell();
  const [tab, setTab] = useState<ProductionTab>(p.initialTab);
  const [cursor, setCursor] = useState<string | null>(p.focusId);
  const [creating, setCreating] = useState(false);
  const load = useMemo(() => shopLoad(p.load), [p.load]);
  const maxWeeks = Math.max(4, ...p.load.map((l) => (l.capacity_minutes_per_week > 0 ? l.open_std_minutes / l.capacity_minutes_per_week : 0)));
  const late = p.orders.filter((o) => o.is_late).length;
  const pickTab = (t: ProductionTab) => {
    setTab(t);
    if (!p.fixedJobId) router.replace(t === 'board' ? '/production' : `/production?view=${t}`, { scroll: false });
  };

  return (
    <div className="stack">
      <div className="ops-toolbar">
        <Seg<ProductionTab> aria-label="View" value={tab} onChange={pickTab} items={[
          { value: 'board', label: 'Orders', count: p.orders.filter((o) => o.status !== 'COMPLETE' && o.status !== 'CLOSED').length },
          { value: 'floor', label: 'Shop floor', count: p.floor.filter((f) => f.status !== 'PENDING').length },
          ...(p.fixedJobId ? [] : [{ value: 'setup' as const, label: 'Work centers and routings' }]),
        ]} />
        <span className="sp" />
        {tab === 'board' && !readOnly && <Button variant="primary" icon="plus" chord="n" bindChord={!creating} onClick={() => { setCreating(true); setCursor(null); }}>New production order</Button>}
      </div>

      {tab === 'floor' ? (
        <ShopFloor ops={p.floor} orders={p.orders} centers={p.centers} jobLabels={p.jobLabels} />
      ) : tab === 'setup' ? (
        <ShopSetup centers={p.centers} routings={p.routings} steps={p.steps} companyId={p.companyId} />
      ) : (
        <>
          {!p.fixedJobId && (
            <Section title="Shop load" meta={load.weeks != null ? `${(Math.round(load.weeks * 10) / 10).toLocaleString('en-US')} weeks of backlog` : undefined}>
              <p style={{ marginBottom: 12 }}>{load.sentence}{late ? ` ${count(late)} order${late === 1 ? ' is' : 's are'} past the promised date.` : ''}</p>
              {p.load.length > 0 && (
                <div className="mp-table" id="load">
                  {p.load.filter((l) => l.status !== 'INACTIVE').map((l) => {
                    const w = l.capacity_minutes_per_week > 0 ? l.open_std_minutes / l.capacity_minutes_per_week : 0;
                    return (
                      <div className="load-row" key={l.work_center_id}>
                        <span className="b">{l.name}</span>
                        <div className={w > 2 ? 'load-bar over' : 'load-bar'} role="img" aria-label={centerSentence(l)}>
                          <i style={{ width: `${Math.min(100, (w / maxWeeks) * 100)}%` }} />
                          <b style={{ left: `${(1 / maxWeeks) * 100}%` }} title="One week" />
                        </div>
                        <span className="t-cap">{centerSentence(l).replace(`${l.name}: `, '')}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </Section>
          )}

          <div className={creating || cursor ? 'ops-split has-panel' : 'ops-split'}>
            <div style={{ minWidth: 0 }}>
              {p.orders.length === 0 ? (
                <div className="surface">
                  <WidgetState state={{ kind: 'empty', title: 'No production orders yet', body: `Open one on a sold ${lower(v.job)}: what the shop builds, how many, and when it is promised. Add the cut list and routing, approve drawings, then release it.`, action: readOnly ? undefined : <Button variant="primary" onClick={() => setCreating(true)}>New production order</Button> }} />
                </div>
              ) : (
                <div className="prod-cols" role="list" aria-label="Production orders by status">
                  {COLS.map((c) => {
                    const rows = p.orders.filter((o) => c.statuses.includes(o.status));
                    return (
                      <section className="prod-col" key={c.id} role="listitem" aria-label={c.title}>
                        <div className="prod-col-h"><span className="t-section">{c.title}</span><span className="tnum b">{count(rows.length)}</span></div>
                        {rows.length === 0 ? <p className="t-cap" style={{ padding: 12 }}>{c.caption}</p> : rows.map((o) => (
                          <button key={o.work_order_id} type="button" className={o.is_late ? 'prod-card late' : 'prod-card'} aria-current={cursor === o.work_order_id} onClick={() => { setCursor(o.work_order_id); setCreating(false); }}>
                            <span className="code">{o.number}</span>
                            <span className="l1" style={{ display: 'block' }}>{o.summary}</span>
                            <span className="l2" style={{ display: 'block' }}>{p.jobLabels[o.job_id] ?? ''}</span>
                            {o.ops_total > 0 && (
                              <span className="row" style={{ gap: 8, marginTop: 6 }}>
                                <Meter strokes={countStrokes(Math.min(o.ops_total, 12), Math.round((o.ops_done / o.ops_total) * Math.min(o.ops_total, 12)))} label={`${o.ops_done} of ${o.ops_total} operations done`} />
                                <span className="t-cap">{o.current_operation ?? (o.status === 'COMPLETE' ? 'Done' : '')}</span>
                              </span>
                            )}
                            <span className="l2" style={{ display: 'block', marginTop: 4 }}>
                              {[o.promised_on ? `${o.is_late ? 'late, promised' : 'promised'} ${shortDate(o.promised_on, p.today)}` : 'No promise date', o.status === 'NEW' && !o.drawings_approved_at ? 'drawings open' : null].filter(Boolean).join(' · ')}
                            </span>
                          </button>
                        ))}
                      </section>
                    );
                  })}
                </div>
              )}
            </div>
            {creating ? (
              <NewProductionPanel jobs={p.jobs} routings={p.routings} fixedJobId={p.fixedJobId} today={p.today} onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); setCursor(id); }} />
            ) : cursor ? (
              <ProductionPanel key={cursor} id={cursor} jobLabel={(() => { const o = p.orders.find((x) => x.work_order_id === cursor); return o ? p.jobLabels[o.job_id] ?? null : null; })()} centers={p.centers} routings={p.routings} today={p.today} onClose={() => setCursor(null)} />
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}

function NewProductionPanel({ jobs, routings, fixedJobId, today, onClose, onCreated }: { jobs: JobOption[]; routings: RoutingRow[]; fixedJobId?: string | null; today: string; onClose: () => void; onCreated: (id: string) => void }) {
  const v = useVocab();
  const { act, busy, error } = useOps();
  const [jobId, setJobId] = useState(fixedJobId ?? '');
  const [summary, setSummary] = useState('');
  const [qty, setQty] = useState('1');
  const [routingId, setRoutingId] = useState('');
  const [promised, setPromised] = useState('');
  const [err, setErr] = useState<string | null>(null);
  useEscapeKey(onClose, busy !== 'create', 'New production order');
  const submit = async () => {
    const q = parseNum(qty);
    if (!jobId) return setErr(`Pick the ${lower(v.job)}.`);
    if (!summary.trim()) return setErr('Say what the shop is building.');
    if (q == null || q <= 0) return setErr('Quantity must be more than 0.');
    setErr(null);
    const r = await act<{ workOrderId: string }>('create', 'post', '/api/ops/production', { jobId, summary: summary.trim(), quantity: q, routingId: routingId || null, promisedOn: promised || null }, 'Created the production order');
    if (r) onCreated(r.workOrderId);
  };
  return (
    <Panel eyebrow={['New', 'Production order']} title={summary.trim() || 'New production order'} meta="Starts in engineering; the number is assigned when you create it" onClose={onClose}
      foot={<div className="btn-row" style={{ justifyContent: 'flex-end', width: '100%' }}><Button onClick={onClose}>Cancel</Button><Button variant="primary" chord="mod+enter" bindChord disabled={busy === 'create'} onClick={() => void submit()}>Create</Button></div>}>
      <PanelSection>
        <form className="mp-form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          {!fixedJobId && <Field label={v.job}><JobSelect jobs={jobs.filter((j) => j.open)} value={jobId} onChange={setJobId} /></Field>}
          <Field label="What the shop builds" error={err ?? undefined}><Input autoFocus value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="Kitchen perimeter cabinets" maxLength={200} /></Field>
          <div className="mp-form-2">
            <Field label="Quantity"><Input inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} /></Field>
            <Field label="Promised"><Input type="date" value={promised} min={today} onChange={(e) => setPromised(e.target.value)} /></Field>
          </div>
          <Field label="Routing" help="Optional now; it can be applied while in engineering">
            <Select value={routingId} onChange={(e) => setRoutingId(e.target.value)}>
              <option value="">Apply later</option>
              {routings.filter((r) => r.is_active).map((r) => <option key={r.id} value={r.id}>{r.code} · {r.name}</option>)}
            </Select>
          </Field>
          <p className="t-cap">{PRODUCTION_STATUS_WORDS.NEW}: release checks run when you send it to the shop.</p>
          <Failure text={error} />
          <button type="submit" hidden />
        </form>
      </PanelSection>
    </Panel>
  );
}

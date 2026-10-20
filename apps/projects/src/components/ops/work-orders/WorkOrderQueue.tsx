'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Bands, Button, Keybar, QueueTable, Search, Seg, Status, WidgetState, count, money, shortDate,
  type QueueColumn,
} from '@meritbooks/merit-ui';
import { clockOf, localParts } from '@/lib/pm/ops/dispatch-math';
import { CLAIM_STATUS, WO_STATUS, claimOutstanding, priorityWord, woBand, woKindLabel, woVocab, type WoBand } from '@/lib/pm/ops/labels';
import type { AssetRow, AssignmentRow, SkillRow, WarrantyClaimRow, WorkOrderRow } from '@/lib/pm/ops/types';
import type { JobOption } from '@/lib/pm/ops/scope';
import { useShell, useVocab } from '@/components/shell/ShellContext';
import { lower } from '@/lib/pm/vocab';
import { StatusMark } from '../common/bits';
import { NewWorkOrderPanel } from './NewWorkOrderPanel';
import { WorkOrderPanel } from './WorkOrderPanel';

export interface WorkOrderQueueProps {
  orders: WorkOrderRow[];
  assignments: AssignmentRow[];
  claims: WarrantyClaimRow[];
  assets: AssetRow[];
  employees: Record<string, string>;
  jobs: JobOption[];
  jobTypes: Array<{ companyId: string; key: string; label: string }>;
  companies: Array<{ id: string; name: string }>;
  defaultCompanyId: string | null;
  packKey: string | null;
  skills: SkillRow[];
  customers: Record<string, string>;
  tz: string;
  today: string;
  capped: boolean;
  focusId: string | null;
  openNew: boolean;
  initialBand: WoBand | 'all' | null;
  initialView: 'orders' | 'claims';
  /** Job tab: rows are this job's; create fixes the job. */
  fixedJobId?: string | null;
}

const BANDS: Array<{ value: WoBand; label: string; caption: string }> = [
  { value: 'new', label: 'New', caption: 'Not on the board yet' },
  { value: 'scheduled', label: 'Scheduled', caption: 'Booked or dispatched' },
  { value: 'progress', label: 'In progress', caption: 'On site or on hold' },
  { value: 'complete', label: 'Complete', caption: 'Ready to close' },
  { value: 'closed', label: 'Closed', caption: 'Closed or cancelled' },
];

export function WorkOrderQueue(p: WorkOrderQueueProps) {
  const v = useVocab();
  const wv = woVocab(v);
  const router = useRouter();
  const { readOnly } = useShell();
  const focused = p.focusId ? p.orders.find((o) => o.id === p.focusId) : null;
  const [band, setBand] = useState<WoBand | 'all'>(p.initialBand ?? (focused ? woBand(focused.status) : p.orders.some((o) => o.status === 'NEW') ? 'new' : 'scheduled'));
  const [view, setView] = useState<'orders' | 'claims'>(p.initialView);
  const [cursor, setCursor] = useState<string | null>(p.focusId);
  const [creating, setCreating] = useState(p.openNew && !readOnly);
  const [q, setQ] = useState('');
  const jobs = useMemo(() => new Map(p.jobs.map((j) => [j.id, j])), [p.jobs]);
  const assets = useMemo(() => new Map(p.assets.map((a) => [a.id, a])), [p.assets]);
  const skillNames = useMemo(() => Object.fromEntries(p.skills.map((s) => [s.code, s.name])), [p.skills]);
  const techsOf = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const a of p.assignments) {
      if (!a.employee_id) continue;
      const n = p.employees[a.employee_id];
      if (n) m.set(a.work_order_id, [...new Set([...(m.get(a.work_order_id) ?? []), n])]);
    }
    return m;
  }, [p.assignments, p.employees]);
  const dealer = wv.dealer || p.packKey === 'equipment_dealer';

  const searched = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return p.orders;
    return p.orders.filter((o) => {
      const a = o.asset_id ? assets.get(o.asset_id) : null;
      return [o.number, o.summary, o.complaint, jobs.get(o.job_id)?.label, jobs.get(o.job_id)?.customer, a?.serial_number].filter(Boolean).join(' ').toLowerCase().includes(t);
    });
  }, [p.orders, q, jobs, assets]);
  const byBand = (b: WoBand) => searched.filter((o) => woBand(o.status) === b);
  const visible = band === 'all' ? searched : byBand(band);
  const cursorOrder = p.orders.find((o) => o.id === cursor) ?? null;

  const whenCell = (o: WorkOrderRow) => {
    const iso = o.scheduled_start ?? o.requested_start;
    if (iso) {
      const l = localParts(iso, p.tz);
      return <><span className="l1">{l.day === p.today ? 'Today' : shortDate(l.day, p.today)} {clockOf(l.minutes)}</span><span className="l2">{o.scheduled_start ? 'scheduled' : 'customer window'}</span></>;
    }
    if (o.due_on) return <><span className={o.due_by && o.due_by < p.today && o.status === 'NEW' ? 'l1 neg b' : 'l1'}>{shortDate(o.due_on, p.today)}</span><span className="l2">due</span></>;
    if (o.promised_on) return <><span className="l1">{shortDate(o.promised_on, p.today)}</span><span className="l2">promised</span></>;
    return <span className="l2">Not set</span>;
  };

  const columns: QueueColumn<WorkOrderRow>[] = [
    { id: 'num', header: 'Number', width: 136, cell: (o) => <span className="code">{o.number}</span> },
    {
      id: 'work',
      header: 'Work',
      cell: (o) => {
        const j = jobs.get(o.job_id);
        const a = o.asset_id ? assets.get(o.asset_id) : null;
        return (
          <>
            <span className="l1">{o.summary}{o.is_callback ? ' · callback' : ''}</span>
            <span className="l2">{[!p.fixedJobId ? j?.customer ?? j?.label : null, a ? [a.make, a.model, a.serial_number ? `#${a.serial_number}` : null].filter(Boolean).join(' ') : null, j?.company].filter(Boolean).join(' · ') || ' '}</span>
          </>
        );
      },
    },
    { id: 'kind', header: 'Kind', width: 150, cell: (o) => <><span className="l1">{woKindLabel(o.kind, v)}</span><span className="l2">{priorityWord(o.priority)}</span></> },
    { id: 'when', header: 'When', width: 132, cell: whenCell },
    { id: 'tech', header: 'Technician', width: 150, cell: (o) => <span className="l2">{techsOf.get(o.id)?.join(', ') ?? '—'}</span> },
    { id: 'st', header: 'Status', width: 130, cell: (o) => <StatusMark mark={WO_STATUS[o.status]} /> },
  ];

  const openClaims = p.claims.filter((c) => claimOutstanding(c) > 0);
  const outstanding = openClaims.reduce((s, c) => s + claimOutstanding(c), 0);
  const panel = creating || !!cursorOrder || !!(cursor && !cursorOrder);

  return (
    <div className="stack">
      <div className="ops-toolbar">
        {dealer && (
          <Seg<'orders' | 'claims'> aria-label="Show" value={view} onChange={setView} items={[{ value: 'orders', label: wv.many, count: p.orders.length }, { value: 'claims', label: 'Warranty claims', count: p.claims.length }]} />
        )}
        {view === 'orders' && (
          <div style={{ width: 300 }}><Search aria-label={`Find a ${lower(wv.one)}`} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Number, customer, serial" slashToFocus /></div>
        )}
        <span className="sp" />
        {!readOnly && (
          <Button variant="primary" icon="plus" chord="n" bindChord={!creating} onClick={() => { setCreating(true); setCursor(null); }}>New {lower(wv.one)}</Button>
        )}
      </div>

      {view === 'claims' ? (
        <ClaimsTable claims={p.claims} orders={p.orders} customers={p.customers} outstanding={outstanding} onOpen={(id) => { setView('orders'); setCursor(id); const o = p.orders.find((x) => x.id === id); if (o) setBand(woBand(o.status)); }} today={p.today} />
      ) : (
        <>
          <Bands<WoBand | 'all'>
            aria-label={`${wv.many} by status`}
            value={band}
            onChange={setBand}
            items={BANDS.map((b) => ({ value: b.value, label: b.label, count: count(byBand(b.value).length), caption: b.caption }))}
          />
          <div className={panel ? 'ops-split has-panel' : 'ops-split'}>
            <div className="mp-table" style={{ minWidth: 0 }}>
              {visible.length === 0 ? (
                <WidgetState
                  state={
                    p.orders.length === 0
                      ? { kind: 'empty', title: `No ${lower(wv.many)} yet`, body: `Create one for a call: the customer, what is wrong, how urgent. Then put it on the dispatch board.`, action: readOnly ? undefined : <Button variant="primary" onClick={() => setCreating(true)}>New {lower(wv.one)}</Button> }
                      : q ? { kind: 'done', title: `Nothing matches “${q}”`, body: 'Search covers number, customer, summary and serial.' }
                      : { kind: 'done', title: `Nothing ${BANDS.find((b) => b.value === band)?.label.toLowerCase() ?? 'here'}`, body: 'Switch the band above to see the others.' }
                  }
                />
              ) : (
                <QueueTable
                  aria-label={wv.many}
                  columns={columns}
                  rows={visible}
                  getRowId={(o) => o.id}
                  cursorId={cursor}
                  onCursorChange={(id) => { setCursor(id); setCreating(false); }}
                  onOpen={(o) => { setCursor(o.id); setCreating(false); }}
                  rowState={(o) => ({ done: o.status === 'CLOSED' || o.status === 'CANCELLED', attn: o.priority <= 1 && o.status === 'NEW' })}
                  actions={readOnly ? [] : [{ key: 'd', label: 'dispatch', run: (rs) => { const o = rs[0]; if (o && (o.status === 'NEW' || o.status === 'ON_HOLD' || o.status === 'SCHEDULED')) router.push(`/dispatch?wo=${o.id}`); } }]}
                />
              )}
              {p.capped && <p className="t-cap" style={{ padding: 12 }}>Showing the newest 500. Search narrows it.</p>}
            </div>
            {creating ? (
              <NewWorkOrderPanel
                jobs={p.jobs.filter((j) => j.open)}
                jobTypes={p.jobTypes}
                companies={p.companies}
                defaultCompanyId={p.defaultCompanyId}
                packKey={p.packKey}
                skills={p.skills}
                tz={p.tz}
                today={p.today}
                fixedJobId={p.fixedJobId}
                onClose={() => setCreating(false)}
                onCreated={(id) => { setCreating(false); setCursor(id); setBand('new'); }}
              />
            ) : cursor ? (
              <WorkOrderPanel
                key={cursor}
                id={cursor}
                jobLabel={cursorOrder ? jobs.get(cursorOrder.job_id)?.label ?? null : null}
                customerName={cursorOrder ? jobs.get(cursorOrder.job_id)?.customer ?? null : null}
                tz={p.tz}
                today={p.today}
                skillNames={skillNames}
                dealer={dealer}
                onClose={() => setCursor(null)}
              />
            ) : null}
          </div>
          {visible.length > 0 && (
            <Keybar hints={[{ chord: 'j k', label: 'move' }, { chord: 'enter', label: 'open' }, ...(readOnly ? [] : [{ chord: 'd', label: 'dispatch' }, { chord: 'n', label: `new ${lower(wv.one)}` }])]} note="Prices on lines are pinned from the price book; Merit Books invoices the job" />
          )}
        </>
      )}
    </div>
  );
}

function ClaimsTable({ claims, orders, customers, outstanding, onOpen, today }: { claims: WarrantyClaimRow[]; orders: WorkOrderRow[]; customers: Record<string, string>; outstanding: number; onOpen: (woId: string) => void; today: string }) {
  const byWo = new Map(orders.map((o) => [o.id, o]));
  const cols: QueueColumn<WarrantyClaimRow>[] = [
    { id: 'n', header: 'Claim', width: 140, cell: (c) => <span className="code">{c.claim_number ?? 'Draft'}</span> },
    { id: 'ro', header: 'Repair order', cell: (c) => { const o = byWo.get(c.work_order_id); return <><span className="l1">{o?.number} {o?.summary}</span><span className="l2">{customers[c.payer_customer_id] ?? 'Manufacturer'}{c.failure_code ? ` · ${c.failure_code}` : ''}</span></>; } },
    { id: 'st', header: 'Status', width: 170, cell: (c) => <Status kind={CLAIM_STATUS[c.status].kind} pip={CLAIM_STATUS[c.status].pip}>{CLAIM_STATUS[c.status].word}</Status> },
    { id: 'cl', header: 'Claimed', numeric: true, width: 120, cell: (c) => money(c.claimed_cents) },
    { id: 'ap', header: 'Approved', numeric: true, width: 120, cell: (c) => (c.approved_cents == null ? '—' : money(c.approved_cents)) },
    { id: 'pd', header: 'Paid', numeric: true, width: 110, cell: (c) => (c.paid_cents ? money(c.paid_cents) : '—') },
    { id: 'os', header: 'Outstanding', numeric: true, width: 130, cell: (c) => { const x = claimOutstanding(c); return x ? <b>{money(x)}</b> : '—'; } },
    { id: 'd', header: 'File by', width: 96, cell: (c) => (c.filing_deadline ? <span className={c.status === 'DRAFT' && c.filing_deadline < today ? 'neg b' : undefined}>{shortDate(c.filing_deadline, today)}</span> : '—') },
  ];
  return (
    <div className="mp-table">
      {claims.length === 0 ? (
        <WidgetState state={{ kind: 'empty', title: 'No warranty claims yet', body: 'Open a repair order with warranty lines and start a claim from its panel. Outstanding amounts show here until the manufacturer pays.' }} />
      ) : (
        <>
          <div className="row" style={{ padding: '12px 16px', borderBottom: '1px solid var(--line)', gap: 16 }}>
            <span className="t-section">Outstanding</span><span className="tnum b">{money(outstanding)}</span>
            <span className="t-cap">Submitted, returned or approved and not yet paid. Merit Books carries the receivable from the manufacturer.</span>
          </div>
          <QueueTable aria-label="Warranty claims" columns={cols} rows={claims} getRowId={(c) => c.id} onOpen={(c) => onOpen(c.work_order_id)} hotkeys={false}
            rowState={(c) => ({ done: c.status === 'PAID' || c.status === 'WRITTEN_OFF', attn: c.status === 'RETURNED' })} />
        </>
      )}
    </div>
  );
}

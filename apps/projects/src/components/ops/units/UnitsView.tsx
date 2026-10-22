'use client';

import { useMemo, useState } from 'react';
import {
  Button, Field, Input, KV, MoneyInput, Panel, PanelSection, QueueTable, Seg, Select, Tag, Textarea, WidgetState, count, shortDate, useEscapeKey, type QueueColumn, type QueueGroup,
} from '@meritbooks/merit-ui';
import { useMoneyText } from '@/components/money/useMoneyText';
import { useMoneyVis } from '@/components/shell/ShellContext';
import { when } from '@/components/money/visibility';
import { ENTITLEMENT_KIND_WORDS, ENTITLEMENT_NEXT, ENTITLEMENT_STATUS, UNIT_KIND_WORDS, UNIT_NEXT, UNIT_STATUS } from '@/lib/pm/ops/labels';
import type { EntitlementKind, EntitlementRow, EntitlementStatus, LookupItem, UnitKind, UnitRow, UnitStatus } from '@/lib/pm/ops/types';
import type { JobOption } from '@/lib/pm/ops/scope';
import { useShell, useVocab } from '@/components/shell/ShellContext';
import { lower } from '@/lib/pm/vocab';
import { Failure, JobSelect, StatusMark, parseNum } from '../common/bits';
import { Lookup } from '../common/Lookup';
import { useOps } from '../common/useOps';

type Ent = EntitlementRow & { reference_number: string | null; conditions: string | null };
type Filter = 'all' | 'available' | 'contract' | 'closed';

export interface UnitsViewProps {
  units: UnitRow[];
  entitlements: Ent[];
  buyers: Record<string, string>;
  jobs: JobOption[];
  today: string;
  initialTab: 'units' | 'entitlements';
  fixedJobId?: string | null;
}

function plusDays(iso: string, d: number): string {
  const x = new Date(`${iso}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + d);
  return x.toISOString().slice(0, 10);
}

export function UnitsView(p: UnitsViewProps) {
  const [tab, setTab] = useState(p.initialTab);
  return (
    <div className="stack">
      <Seg<'units' | 'entitlements'> aria-label="Show" value={tab} onChange={setTab} items={[
        { value: 'units', label: 'Lots and units', count: p.units.length },
        { value: 'entitlements', label: 'Entitlements and permits', count: p.entitlements.filter((e) => !['APPROVED', 'APPROVED_WITH_CONDITIONS', 'WITHDRAWN', 'EXPIRED'].includes(e.status)).length },
      ]} />
      {tab === 'units' ? <Units {...p} /> : <Entitlements {...p} />}
    </div>
  );
}

function Units(p: UnitsViewProps) {
  const money = useMoneyText('contract');
  const mv = useMoneyVis();
  const v = useVocab();
  const { readOnly } = useShell();
  const [filter, setFilter] = useState<Filter>('all');
  const [cursor, setCursor] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const jobs = useMemo(() => new Map(p.jobs.map((j) => [j.id, j])), [p.jobs]);
  const soon = plusDays(p.today, 30);
  const rows = p.units.filter((u) => filter === 'all' || (filter === 'available' ? ['AVAILABLE', 'COMPLETE', 'UNDER_CONSTRUCTION'].includes(u.status) : filter === 'contract' ? u.status === 'UNDER_CONTRACT' : u.status === 'CLOSED'));
  const groups: QueueGroup<UnitRow>[] = useMemo(() => {
    const m = new Map<string, UnitRow[]>();
    for (const u of rows) m.set(u.job_id, [...(m.get(u.job_id) ?? []), u]);
    return [...m.entries()].map(([id, us]) => ({
      id, title: jobs.get(id)?.label ?? v.job, rows: us,
      caption: mv.contract
        ? `${count(us.filter((u) => u.status === 'CLOSED').length)} closed · ${money(us.filter((u) => u.status === 'UNDER_CONTRACT').reduce((s, u) => s + (u.contract_price_cents ?? 0), 0))} under contract`
        : `${count(us.filter((u) => u.status === 'CLOSED').length)} closed · ${count(us.filter((u) => u.status === 'UNDER_CONTRACT').length)} under contract`,
    }));
  }, [rows, jobs, v.job]);
  const cur = p.units.find((u) => u.id === cursor) ?? null;
  const contract = p.units.filter((u) => u.status === 'UNDER_CONTRACT');
  const closing = contract.filter((u) => u.est_close_on && u.est_close_on <= soon);

  const columns: QueueColumn<UnitRow>[] = [
    { id: 'n', header: 'Unit', width: 120, cell: (u) => <><span className="l1 b">{u.unit_number}</span><span className="l2">{UNIT_KIND_WORDS[u.unit_kind]}</span></> },
    { id: 'plan', header: 'Plan', cell: (u) => <><span className="l1">{u.plan_name ?? '—'}</span><span className="l2">{[u.phase ? `Phase ${u.phase}` : null, u.sqft ? `${count(Number(u.sqft))} sq ft` : null].filter(Boolean).join(' · ') || ' '}</span></> },
    { id: 'st', header: 'Status', width: 170, cell: (u) => <StatusMark mark={UNIT_STATUS[u.status]} /> },
    ...when<QueueColumn<UnitRow>>(mv.contract,
      { id: 'lp', header: 'List', numeric: true, width: 120, cell: (u) => (u.list_price_cents == null ? '—' : money(u.list_price_cents, { decimals: 0 })) },
      { id: 'cp', header: 'Contract', numeric: true, width: 120, cell: (u) => (u.contract_price_cents == null ? '—' : money(u.contract_price_cents, { decimals: 0 })) },
      { id: 'rp', header: 'Lender release', numeric: true, width: 130, cell: (u) => (u.lender_release_price_cents == null ? '—' : money(u.lender_release_price_cents, { decimals: 0 })) }),
    { id: 'buyer', header: 'Buyer', width: 150, cell: (u) => <span className="l2">{u.buyer_customer_id ? p.buyers[u.buyer_customer_id] ?? 'Buyer' : '—'}</span> },
    { id: 'close', header: 'Closing', width: 110, cell: (u) => (u.closed_on ? <><span className="l1">{shortDate(u.closed_on, p.today)}</span><span className="l2">closed</span></> : u.est_close_on ? <><span className={u.status === 'UNDER_CONTRACT' && u.est_close_on < p.today ? 'l1 neg b' : 'l1'}>{shortDate(u.est_close_on, p.today)}</span><span className="l2">estimated</span></> : '—') },
  ];

  return (
    <div className="stack">
      <div className="ops-toolbar">
        <Seg<Filter> aria-label="Filter" value={filter} onChange={setFilter} items={[
          { value: 'all', label: 'All', count: p.units.length },
          { value: 'available', label: 'For sale or building' },
          { value: 'contract', label: 'Under contract', count: contract.length },
          { value: 'closed', label: 'Closed', count: p.units.filter((u) => u.status === 'CLOSED').length },
        ]} />
        <span className="sp" />
        {closing.length > 0 && <span className="t-cap">{count(closing.length)} closing in 30 days{mv.contract ? ` · ${money(closing.reduce((s, u) => s + (u.contract_price_cents ?? 0), 0), { decimals: 0 })}` : ''}</span>}
        {!readOnly && <Button variant="primary" icon="plus" onClick={() => { setCreating(true); setCursor(null); }}>Add lots or units</Button>}
      </div>
      <div className={creating || cur ? 'ops-split has-panel' : 'ops-split'}>
        <div className="mp-table" style={{ minWidth: 0 }}>
          {rows.length === 0 ? (
            <WidgetState state={p.units.length === 0
              ? { kind: 'empty', title: 'No lots or units yet', body: `Add them to the development ${lower(v.job)}, one at a time or a numbered run (Lot 1 to Lot 24), with list and lender release prices.`, action: readOnly ? undefined : <Button variant="primary" onClick={() => setCreating(true)}>Add lots or units</Button> }
              : { kind: 'done', title: 'Nothing in this view', body: 'Switch the filter above to see the others.' }} />
          ) : (
            <QueueTable aria-label="Lots and units" columns={columns} groups={groups} getRowId={(u) => u.id} cursorId={cursor} onCursorChange={(id) => { setCursor(id); setCreating(false); }} onOpen={(u) => setCursor(u.id)}
              rowState={(u) => ({ done: u.status === 'CLOSED', attn: u.status === 'UNDER_CONTRACT' && !!u.est_close_on && u.est_close_on < p.today })} />
          )}
        </div>
        {creating ? <NewUnitsPanel jobs={p.jobs.filter((j) => j.open)} fixedJobId={p.fixedJobId} onClose={() => setCreating(false)} /> : cur ? <UnitPanel key={cur.id} unit={cur} buyer={cur.buyer_customer_id ? p.buyers[cur.buyer_customer_id] ?? null : null} jobLabel={jobs.get(cur.job_id)?.label ?? null} today={p.today} onClose={() => setCursor(null)} /> : null}
      </div>
    </div>
  );
}

function UnitPanel({ unit: u, buyer, jobLabel, today, onClose }: { unit: UnitRow; buyer: string | null; jobLabel: string | null; today: string; onClose: () => void }) {
  const money = useMoneyText('contract');
  const { readOnly } = useShell();
  const v = useVocab();
  const { act, busy, error } = useOps();
  const url = `/api/ops/units/${u.id}`;
  const [to, setTo] = useState<UnitStatus | null>(null);
  const [on, setOn] = useState(today);
  const [who, setWho] = useState<LookupItem | null>(null);
  const [price, setPrice] = useState<number | null>(u.list_price_cents);
  const [list, setList] = useState<number | null>(u.list_price_cents);
  const [release, setRelease] = useState<number | null>(u.lender_release_price_cents);
  const [est, setEst] = useState(u.est_close_on ?? '');
  return (
    <Panel eyebrow={[UNIT_KIND_WORDS[u.unit_kind], UNIT_STATUS[u.status].word]} title={u.unit_number} meta={[jobLabel, u.plan_name].filter(Boolean).join(' · ')} onClose={onClose}>
      <PanelSection>
        <StatusMark mark={UNIT_STATUS[u.status]} />
        <div style={{ marginTop: 12 }}>
          <KV items={[
            ...(u.phase ? [{ term: 'Phase', value: u.phase }] : []),
            ...(u.sqft ? [{ term: 'Size', value: `${count(Number(u.sqft))} sq ft` }] : []),
            { term: 'List', value: u.list_price_cents == null ? '—' : money(u.list_price_cents) },
            ...(u.contract_price_cents != null ? [{ term: 'Contract', value: money(u.contract_price_cents) }] : []),
            { term: 'Lender release', value: u.lender_release_price_cents == null ? '—' : money(u.lender_release_price_cents) },
            ...(buyer ? [{ term: 'Buyer', value: buyer }] : []),
            ...(u.contract_on ? [{ term: 'Under contract since', value: shortDate(u.contract_on, today) }] : []),
            ...(u.est_close_on ? [{ term: 'Estimated close', value: shortDate(u.est_close_on, today) }] : []),
            ...(u.closed_on ? [{ term: 'Closed', value: shortDate(u.closed_on, today) }] : []),
          ]} />
        </div>
        {u.status === 'UNDER_CONTRACT' && u.lender_release_price_cents != null && <p className="t-cap" style={{ marginTop: 8 }}>At closing the lender is owed {money(u.lender_release_price_cents)} to release this {lower(UNIT_KIND_WORDS[u.unit_kind])}.</p>}
        {error && <div style={{ marginTop: 8 }}><Failure text={error} /></div>}
      </PanelSection>
      {!readOnly && UNIT_NEXT[u.status].length > 0 && (
        <PanelSection title="Move to">
          <div className="btn-row" style={{ flexWrap: 'wrap' }}>
            {UNIT_NEXT[u.status].map((s) => <Button key={s} aria-pressed={to === s} variant={to === s ? 'primary' : 'default'} onClick={() => setTo(to === s ? null : s)}>{UNIT_STATUS[s].word}</Button>)}
          </div>
          {to && (
            <form className="mp-form" style={{ marginTop: 12 }} onSubmit={(e) => {
              e.preventDefault();
              void act('st', 'post', url, { op: 'status', status: to, on: on || null, buyerId: to === 'UNDER_CONTRACT' ? who?.id ?? null : null, contractPriceCents: to === 'UNDER_CONTRACT' ? price : null }, `${u.unit_number}: ${UNIT_STATUS[to].word.toLowerCase()}`).then((r) => { if (r) setTo(null); });
            }}>
              {to === 'UNDER_CONTRACT' && (
                <>
                  <Field label="Buyer"><Lookup kind="customers" value={who ? { id: who.id, label: who.label } : null} onChange={setWho} placeholder={`Search ${lower(v.customers)}`} /></Field>
                  <Field label="Contract price"><MoneyInput valueCents={price} onChangeCents={setPrice} /></Field>
                </>
              )}
              {(to === 'UNDER_CONTRACT' || to === 'CLOSED') && <Field label={to === 'CLOSED' ? 'Closed on' : 'Contract date'}><Input type="date" value={on} onChange={(e) => setOn(e.target.value)} /></Field>}
              {u.status === 'UNDER_CONTRACT' && to !== 'CLOSED' && <p className="t-cap">Leaving contract clears the buyer, price and contract date.</p>}
              <div className="btn-row"><Button onClick={() => setTo(null)}>Back</Button><Button type="submit" variant="primary" disabled={busy === 'st' || (to === 'UNDER_CONTRACT' && (!who || price == null))}>Save</Button></div>
            </form>
          )}
        </PanelSection>
      )}
      {!readOnly && u.status !== 'CLOSED' && (
        <PanelSection title="Prices and closing">
          <form className="mp-form" onSubmit={(e) => { e.preventDefault(); void act('upd', 'post', url, { op: 'update', listPriceCents: list, lenderReleasePriceCents: release, estCloseOn: est || null }, 'Saved'); }}>
            <div className="mp-form-2">
              <Field label="List price"><MoneyInput valueCents={list} onChangeCents={setList} /></Field>
              <Field label="Lender release price"><MoneyInput valueCents={release} onChangeCents={setRelease} /></Field>
            </div>
            <Field label="Estimated close"><Input type="date" value={est} onChange={(e) => setEst(e.target.value)} /></Field>
            <div><Button type="submit" disabled={busy === 'upd'}>Save</Button></div>
          </form>
        </PanelSection>
      )}
    </Panel>
  );
}

function NewUnitsPanel({ jobs, fixedJobId, onClose }: { jobs: JobOption[]; fixedJobId?: string | null; onClose: () => void }) {
  const v = useVocab();
  const { act, busy, error } = useOps();
  const [jobId, setJobId] = useState(fixedJobId ?? '');
  const [num, setNum] = useState('Lot 1');
  const [howMany, setHowMany] = useState('1');
  const [kind, setKind] = useState<UnitKind>('LOT');
  const [phase, setPhase] = useState('');
  const [plan, setPlan] = useState('');
  const [sqft, setSqft] = useState('');
  const [list, setList] = useState<number | null>(null);
  const [release, setRelease] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEscapeKey(onClose, busy !== 'create', 'Add units');
  const n = parseNum(howMany) ?? 1;
  const submit = async () => {
    if (!jobId) return setErr(`Pick the development ${lower(v.job)}.`);
    if (!num.trim()) return setErr('Number the first lot or unit.');
    if (n < 1 || n > 500 || !Number.isInteger(n)) return setErr('Add 1 to 500 at a time.');
    setErr(null);
    const r = await act<{ created: number }>('create', 'post', '/api/ops/units', { jobId, unitNumber: num.trim(), count: n, unitKind: kind, phase: phase.trim() || null, planName: plan.trim() || null, sqft: parseNum(sqft), listPriceCents: list, lenderReleasePriceCents: release }, (d) => `Added ${d.created} ${d.created === 1 ? 'unit' : 'units'}`);
    if (r) onClose();
  };
  const last = /^(.*?)(\d+)$/.exec(num.trim());
  return (
    <Panel eyebrow={['New', 'Lots and units']} title={n > 1 && last ? `${num.trim()} to ${last[1]}${Number(last[2]) + n - 1}` : num.trim() || 'New unit'} meta="Starts planned; sales move through the statuses" onClose={onClose}
      foot={<div className="btn-row" style={{ justifyContent: 'flex-end', width: '100%' }}><Button onClick={onClose}>Cancel</Button><Button variant="primary" chord="mod+enter" bindChord disabled={busy === 'create'} onClick={() => void submit()}>Add</Button></div>}>
      <PanelSection>
        <form className="mp-form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          {!fixedJobId && <Field label={v.job}><JobSelect jobs={jobs} value={jobId} onChange={setJobId} /></Field>}
          <div className="mp-form-2">
            <Field label="First number" error={err ?? undefined}><Input autoFocus value={num} onChange={(e) => setNum(e.target.value)} maxLength={40} /></Field>
            <Field label="How many" help="A run numbers up from the first"><Input inputMode="numeric" value={howMany} onChange={(e) => setHowMany(e.target.value)} /></Field>
          </div>
          <div className="mp-form-2">
            <Field label="Kind"><Select value={kind} onChange={(e) => setKind(e.target.value as UnitKind)}>{(Object.keys(UNIT_KIND_WORDS) as UnitKind[]).map((k) => <option key={k} value={k}>{UNIT_KIND_WORDS[k]}</option>)}</Select></Field>
            <Field label="Phase"><Input value={phase} onChange={(e) => setPhase(e.target.value)} maxLength={60} /></Field>
          </div>
          <div className="mp-form-2">
            <Field label="Plan"><Input value={plan} onChange={(e) => setPlan(e.target.value)} placeholder="The Ashford" maxLength={80} /></Field>
            <Field label="Sq ft"><Input inputMode="decimal" value={sqft} onChange={(e) => setSqft(e.target.value)} /></Field>
          </div>
          <div className="mp-form-2">
            <Field label="List price"><MoneyInput valueCents={list} onChangeCents={setList} /></Field>
            <Field label="Lender release price"><MoneyInput valueCents={release} onChangeCents={setRelease} /></Field>
          </div>
          <Failure text={error} />
          <button type="submit" hidden />
        </form>
      </PanelSection>
    </Panel>
  );
}

function Entitlements(p: UnitsViewProps) {
  const v = useVocab();
  const { readOnly } = useShell();
  const [cursor, setCursor] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const jobs = useMemo(() => new Map(p.jobs.map((j) => [j.id, j])), [p.jobs]);
  const unitName = useMemo(() => new Map(p.units.map((u) => [u.id, u.unit_number])), [p.units]);
  const groups: QueueGroup<Ent>[] = useMemo(() => {
    const m = new Map<string, Ent[]>();
    for (const e of p.entitlements) m.set(e.job_id, [...(m.get(e.job_id) ?? []), e]);
    return [...m.entries()].map(([id, es]) => ({ id, title: jobs.get(id)?.label ?? v.job, rows: es, caption: `${count(es.filter((e) => e.is_late).length)} late · ${count(es.filter((e) => e.expiring_soon).length)} expiring in 60 days` }));
  }, [p.entitlements, jobs, v.job]);
  const cur = p.entitlements.find((e) => e.entitlement_id === cursor) ?? null;
  const columns: QueueColumn<Ent>[] = [
    { id: 'n', header: 'Approval', cell: (e) => <><span className="l1">{e.name}</span><span className="l2">{[ENTITLEMENT_KIND_WORDS[e.kind], e.authority, e.unit_id ? unitName.get(e.unit_id) : null].filter(Boolean).join(' · ')}</span></> },
    { id: 'st', header: 'Status', width: 190, cell: (e) => <StatusMark mark={ENTITLEMENT_STATUS[e.status]} /> },
    { id: 'tg', header: 'Target', width: 100, cell: (e) => (e.target_on ? <span className={e.is_late ? 'neg b' : undefined}>{shortDate(e.target_on, p.today)}</span> : '—') },
    { id: 'sb', header: 'Submitted', width: 100, cell: (e) => (e.submitted_on ? shortDate(e.submitted_on, p.today) : '—') },
    { id: 'hr', header: 'Hearing', width: 100, cell: (e) => (e.hearing_on ? shortDate(e.hearing_on, p.today) : '—') },
    { id: 'ap', header: 'Approved', width: 100, cell: (e) => (e.approved_on ? shortDate(e.approved_on, p.today) : '—') },
    { id: 'ex', header: 'Expires', width: 100, cell: (e) => (e.expires_on ? <span className={e.expiring_soon ? 'b' : undefined}>{shortDate(e.expires_on, p.today)}</span> : '—') },
  ];
  return (
    <div className="stack">
      <div className="ops-toolbar"><span className="sp" />{!readOnly && <Button variant="primary" icon="plus" onClick={() => { setCreating(true); setCursor(null); }}>Add approval</Button>}</div>
      <div className={creating || cur ? 'ops-split has-panel' : 'ops-split'}>
        <div className="mp-table" style={{ minWidth: 0 }}>
          {p.entitlements.length === 0 ? (
            <WidgetState state={{ kind: 'empty', title: 'No entitlements tracked yet', body: 'List the approvals the project needs (zoning, plats, permits, certificate of occupancy) with target dates; late ones and those expiring within 60 days stand out.', action: readOnly ? undefined : <Button variant="primary" onClick={() => setCreating(true)}>Add approval</Button> }} />
          ) : (
            <QueueTable aria-label="Entitlements" columns={columns} groups={groups} getRowId={(e) => e.entitlement_id} cursorId={cursor} onCursorChange={(id) => { setCursor(id); setCreating(false); }} onOpen={(e) => setCursor(e.entitlement_id)}
              rowState={(e) => ({ done: e.status === 'WITHDRAWN', attn: !!e.is_late || !!e.expiring_soon })} />
          )}
        </div>
        {creating ? <NewEntitlementPanel jobs={p.jobs.filter((j) => j.open)} units={p.units} fixedJobId={p.fixedJobId} onClose={() => setCreating(false)} /> : cur ? <EntitlementPanel key={cur.entitlement_id} e={cur} today={p.today} jobLabel={jobs.get(cur.job_id)?.label ?? null} onClose={() => setCursor(null)} /> : null}
      </div>
    </div>
  );
}

function EntitlementPanel({ e, today, jobLabel, onClose }: { e: Ent; today: string; jobLabel: string | null; onClose: () => void }) {
  const { readOnly } = useShell();
  const { act, busy, error } = useOps();
  const [to, setTo] = useState<EntitlementStatus | null>(null);
  const [on, setOn] = useState(today);
  const [ref, setRef] = useState(e.reference_number ?? '');
  const [cond, setCond] = useState(e.conditions ?? '');
  const [exp, setExp] = useState(e.expires_on ?? '');
  const url = `/api/ops/entitlements/${e.entitlement_id}`;
  return (
    <Panel eyebrow={[ENTITLEMENT_KIND_WORDS[e.kind], ENTITLEMENT_STATUS[e.status].word]} title={e.name} meta={[jobLabel, e.authority].filter(Boolean).join(' · ')} onClose={onClose}>
      <PanelSection>
        <div className="row" style={{ gap: 8 }}><StatusMark mark={ENTITLEMENT_STATUS[e.status]} />{e.is_late && <Tag tone="neg">Past target</Tag>}{e.expiring_soon && <Tag tone="warn">Expires soon</Tag>}</div>
        <div style={{ marginTop: 12 }}>
          <KV items={[
            ...(e.reference_number ? [{ term: 'Reference', value: e.reference_number }] : []),
            ...(e.target_on ? [{ term: 'Target', value: shortDate(e.target_on, today) }] : []),
            ...(e.submitted_on ? [{ term: 'Submitted', value: shortDate(e.submitted_on, today) }] : []),
            ...(e.hearing_on ? [{ term: 'Hearing', value: shortDate(e.hearing_on, today) }] : []),
            ...(e.approved_on ? [{ term: 'Approved', value: shortDate(e.approved_on, today) }] : []),
            ...(e.expires_on ? [{ term: 'Expires', value: shortDate(e.expires_on, today) }] : []),
          ]} />
        </div>
        {e.conditions && <p style={{ marginTop: 8 }}><span className="t-cap">Conditions</span><br />{e.conditions}</p>}
        {error && <div style={{ marginTop: 8 }}><Failure text={error} /></div>}
      </PanelSection>
      {!readOnly && ENTITLEMENT_NEXT[e.status].length > 0 && (
        <PanelSection title="Record">
          <div className="btn-row" style={{ flexWrap: 'wrap' }}>{ENTITLEMENT_NEXT[e.status].map((s) => <Button key={s} aria-pressed={to === s} variant={to === s ? 'primary' : 'default'} onClick={() => setTo(to === s ? null : s)}>{ENTITLEMENT_STATUS[s].word}</Button>)}</div>
          {to && (
            <form className="mp-form" style={{ marginTop: 12 }} onSubmit={(ev) => { ev.preventDefault(); void act('st', 'post', url, { op: 'status', status: to, on: on || null, reference: ref.trim() || null, conditions: cond.trim() || null, expiresOn: exp || null }, `${e.name}: ${ENTITLEMENT_STATUS[to].word.toLowerCase()}`).then((r) => { if (r) setTo(null); }); }}>
              <div className="mp-form-2">
                <Field label="On"><Input type="date" value={on} onChange={(ev) => setOn(ev.target.value)} /></Field>
                <Field label="Reference"><Input value={ref} onChange={(ev) => setRef(ev.target.value)} placeholder="Case PZ-2026-118" maxLength={80} /></Field>
              </div>
              {(to === 'APPROVED' || to === 'APPROVED_WITH_CONDITIONS') && <Field label="Expires"><Input type="date" value={exp} onChange={(ev) => setExp(ev.target.value)} /></Field>}
              {to === 'APPROVED_WITH_CONDITIONS' && <Field label="Conditions of approval"><Textarea value={cond} onChange={(ev) => setCond(ev.target.value)} maxLength={4000} /></Field>}
              <div className="btn-row"><Button onClick={() => setTo(null)}>Back</Button><Button type="submit" variant="primary" disabled={busy === 'st' || (to === 'APPROVED_WITH_CONDITIONS' && !cond.trim())}>Record</Button></div>
            </form>
          )}
        </PanelSection>
      )}
    </Panel>
  );
}

function NewEntitlementPanel({ jobs, units, fixedJobId, onClose }: { jobs: JobOption[]; units: UnitRow[]; fixedJobId?: string | null; onClose: () => void }) {
  const v = useVocab();
  const { act, busy, error } = useOps();
  const [jobId, setJobId] = useState(fixedJobId ?? '');
  const [kind, setKind] = useState<EntitlementKind>('ZONING');
  const [name, setName] = useState('');
  const [authority, setAuthority] = useState('');
  const [target, setTarget] = useState('');
  const [unitId, setUnitId] = useState('');
  const [err, setErr] = useState<string | null>(null);
  useEscapeKey(onClose, busy !== 'create', 'Add approval');
  const submit = async () => {
    if (!jobId) return setErr(`Pick the ${lower(v.job)}.`);
    if (!name.trim()) return setErr('Name the approval.');
    setErr(null);
    const r = await act('create', 'post', '/api/ops/entitlements', { jobId, unitId: unitId || null, kind, name: name.trim(), authority: authority.trim() || null, targetOn: target || null }, `Added ${name.trim()}`);
    if (r) onClose();
  };
  return (
    <Panel eyebrow={['New', 'Approval']} title={name.trim() || 'New approval'} meta="Starts not started" onClose={onClose}
      foot={<div className="btn-row" style={{ justifyContent: 'flex-end', width: '100%' }}><Button onClick={onClose}>Cancel</Button><Button variant="primary" chord="mod+enter" bindChord disabled={busy === 'create'} onClick={() => void submit()}>Add</Button></div>}>
      <PanelSection>
        <form className="mp-form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          {!fixedJobId && <Field label={v.job}><JobSelect jobs={jobs} value={jobId} onChange={setJobId} /></Field>}
          <Field label="Kind"><Select value={kind} onChange={(e) => setKind(e.target.value as EntitlementKind)}>{(Object.keys(ENTITLEMENT_KIND_WORDS) as EntitlementKind[]).map((k) => <option key={k} value={k}>{ENTITLEMENT_KIND_WORDS[k]}</option>)}</Select></Field>
          <Field label="Name" error={err ?? undefined}><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Rezoning to R-3" maxLength={160} /></Field>
          <div className="mp-form-2">
            <Field label="Authority"><Input value={authority} onChange={(e) => setAuthority(e.target.value)} placeholder="City of Ankeny P&Z" maxLength={160} /></Field>
            <Field label="Target date"><Input type="date" value={target} onChange={(e) => setTarget(e.target.value)} /></Field>
          </div>
          {units.some((u) => u.job_id === jobId) && <Field label="For one unit"><Select value={unitId} onChange={(e) => setUnitId(e.target.value)}><option value="">The whole project</option>{units.filter((u) => u.job_id === jobId).map((u) => <option key={u.id} value={u.id}>{u.unit_number}</option>)}</Select></Field>}
          <Failure text={error} />
          <button type="submit" hidden />
        </form>
      </PanelSection>
    </Panel>
  );
}

'use client';

import { useMemo, useState } from 'react';
import { Button, Check, Drawer, Field, Figure, Input, KV, Select, Tag, WidgetState, pct, useQuery } from '@meritbooks/merit-ui';
import { fadeSeverity } from '@/lib/commercial/field';
import { mondayOf, addDaysIso } from '@/lib/commercial/screen-logic';
import type { CostCodeLite, CostCodeUnit, FadeAlert, InstalledQty, ProductivityRow } from '@/lib/commercial/screen-types';
import { useShell } from '@/components/shell/ShellContext';
import { PctInput } from '@/components/ops/common/bits';
import { useOps } from '@/components/ops/common/useOps';
import { DSection, Failure, day } from './common';
import { CmTable, TableKeys, qty, words, type Col } from './kit';

type Act = ReturnType<typeof useOps>['act'];
export interface ProductivityData { rows: ProductivityRow[]; units: CostCodeUnit[]; codes: CostCodeLite[]; quantities: InstalledQty[]; alerts: FadeAlert[] }

export interface ProductivityTotals { budget: number; earned: number; actual: number; factor: number | null; pctUsed: number | null; pctComplete: number | null; projected: number | null }

/** Job-level earned vs actual hours (CGC-90). % complete is earned ÷ budget hours. Pure. */
export function productivityTotals(rows: ReadonlyArray<ProductivityRow>): ProductivityTotals {
  const s = (f: (r: ProductivityRow) => number | null) => rows.reduce((a, r) => a + Number(f(r) ?? 0), 0);
  const budget = s((r) => r.budget_hours), earned = s((r) => r.earned_hours), actual = s((r) => r.actual_hours);
  const pctComplete = budget > 0 ? earned / budget : null;
  return { budget, earned, actual, factor: actual > 0 ? earned / actual : null, pctUsed: budget > 0 ? actual / budget : null, pctComplete, projected: pctComplete ? actual / pctComplete : null };
}

/** Productivity for a job fetched from the board route (job page tab and the productivity screen). */
export function ProductivityBoard({ jobId, canLog, canSetUnits, canFade, today }: { jobId: string; canLog: boolean; canSetUnits: boolean; canFade: boolean; today: string }) {
  const [bump, setBump] = useState(0);
  const q = useQuery<ProductivityData>('/api/commercial/productivity/board', { jobId }, { scope: false, key: String(bump) });
  if (q.isLoading && !q.data) return <WidgetState state={{ kind: 'loading', label: 'Loading productivity…', lines: 5 }} />;
  if (q.error) return <WidgetState state={{ kind: 'error', title: 'Productivity did not load', body: q.error, onRetry: () => void q.refetch(), retryLabel: 'Try again' }} />;
  if (!q.data) return null;
  return <ProductivityView jobId={jobId} data={q.data} today={today} canLog={canLog} canSetUnits={canSetUnits} canFade={canFade} onChanged={() => setBump((b) => b + 1)} />;
}

/**
 * Installed quantities and labor productivity (CGC-89 / CGC-90): the foreman logs units installed
 * per cost code per day (or percent complete where units don't fit); earned hours = installed ×
 * budget unit hours; productivity factor, % hours used against % complete, projected hours at
 * completion, and the weekly fade alerts with the likely cause. Hours only — never dollars.
 */
export function ProductivityView({ jobId, data, today, canLog, canSetUnits, canFade, onChanged }: {
  jobId: string; data: ProductivityData; today: string; canLog: boolean; canSetUnits: boolean; canFade: boolean; onChanged?: () => void;
}) {
  const { readOnly } = useShell();
  const { act, busy, error } = useOps();
  const [openId, setOpenId] = useState<string | null>(null);
  const t = productivityTotals(data.rows);
  const codeOf = useMemo(() => new Map(data.codes.map((c) => [c.id, c])), [data.codes]);
  const unitOf = useMemo(() => new Map(data.units.map((u) => [u.cost_code_id, u])), [data.units]);
  const openAlerts = data.alerts.filter((a) => a.status === 'OPEN');
  const open = data.rows.find((r) => r.cost_code_id === openId) ?? null;
  const done = async <T,>(p: Promise<T | null>) => { const r = await p; if (r) onChanged?.(); return r; };
  const actR = (async (...a: Parameters<Act>) => done(act(...a))) as Act;

  const cols: Col<ProductivityRow>[] = [
    { key: 'cc', head: 'Cost code', cell: (r) => <><span className="code">{r.cost_code}</span> {r.cost_code_name}</> },
    { key: 'q', head: 'Installed', n: true, width: 140, cell: (r) => (r.budget_qty ? <>{qty(r.installed_qty)} / {qty(r.budget_qty)} <span className="ops-sub">{r.uom ?? ''}</span></> : '% entry') },
    { key: 'pc', head: 'Complete', n: true, width: 90, cell: (r) => (r.pct_complete == null ? '—' : pct(Number(r.pct_complete))) },
    { key: 'pu', head: 'Hours used', n: true, width: 100, cell: (r) => (r.pct_hours_used == null ? '—' : pct(Number(r.pct_hours_used))) },
    { key: 'b', head: 'Budget h', n: true, width: 90, cell: (r) => qty(r.budget_hours, 0) },
    { key: 'e', head: 'Earned h', n: true, width: 90, cell: (r) => qty(r.earned_hours, 0) },
    { key: 'a', head: 'Actual h', n: true, width: 90, cell: (r) => qty(r.actual_hours, 0) },
    { key: 'f', head: 'Factor', n: true, width: 80, cell: (r) => (r.productivity_factor == null ? '—' : <span className={Number(r.productivity_factor) < 0.95 ? 'neg' : undefined}>{Number(r.productivity_factor).toFixed(2)}</span>) },
    { key: 'p', head: 'Projected h', n: true, width: 100, cell: (r) => qty(r.projected_hours, 0) },
    { key: 'v', head: 'Over / (under)', n: true, width: 110, cell: (r) => (r.variance_hours == null ? '—' : <span className={Number(r.variance_hours) > 0 ? 'neg' : undefined}>{Number(r.variance_hours) > 0 ? '+' : ''}{qty(r.variance_hours, 0)}</span>) },
    { key: 's', head: '', width: 90, cell: (r) => { const s = fadeSeverity(r.pct_hours_used == null ? null : Number(r.pct_hours_used), Number(r.pct_complete ?? 0), 0, 0); return s ? <Tag tone={s === 'CRITICAL' ? 'neg' : 'warn'}>{words(s)}</Tag> : null; } },
  ];

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="cm-figs">
        <Figure dense label="Productivity factor" value={t.factor == null ? '—' : t.factor.toFixed(2)} vs={[`${qty(t.earned, 0)} earned of ${qty(t.actual, 0)} hours used`, '1.00 = on the estimate']} href={`/jobs/${jobId}?tab=time`} linkLabel="Time" />
        <Figure dense label="Hours used vs complete" value={t.pctUsed == null ? '—' : pct(t.pctUsed)} vs={[`${t.pctComplete == null ? '—' : pct(t.pctComplete)} complete by earned hours`, `${qty(t.budget, 0)} budget hours`]} href={`/jobs/${jobId}?tab=budget`} linkLabel="Budget" />
        <Figure dense label="Projected hours at completion" value={t.projected == null ? '—' : qty(t.projected, 0)} vs={[t.projected == null ? 'No progress logged yet' : `${t.projected > t.budget ? '+' : ''}${qty(t.projected - t.budget, 0)} against budget`]} href="#fade" linkLabel="Fade alerts" />
      </div>
      <Failure text={error} />
      {!readOnly && canLog && <QuantityForm jobId={jobId} codes={data.codes} units={data.units} today={today} busy={busy} act={actR} />}
      <CmTable label="Productivity by cost code" keys rows={data.rows} cols={cols} rowKey={(r) => r.cost_code_id} onOpen={(r) => setOpenId(r.cost_code_id)} activeId={openId}
        rowTone={(r) => { const s = fadeSeverity(r.pct_hours_used == null ? null : Number(r.pct_hours_used), Number(r.pct_complete ?? 0), 0, 0); return s === 'CRITICAL' ? 'neg' : s === 'FADE' ? 'warn' : null; }}
        empty={{ title: 'No cost codes measured yet', body: 'Give each labor cost code its budget quantity, unit and hours; then the foreman’s installed quantities and the crew’s time turn into earned hours here.' }} />
      <TableKeys />
      {!readOnly && canSetUnits && <UnitsForm jobId={jobId} codes={data.codes} units={data.units} busy={busy} act={actR} />}

      <section className="sec" id="fade" aria-label="Fade alerts">
        <div className="sec-h">
          <h2 className="t-section">Fade alerts</h2><span className="t-cap ink-3">{openAlerts.length} open</span><span className="sp" />
          {!readOnly && canFade && <Button disabled={busy !== null} onClick={() => void done(act<{ alerts: number }>('fade', 'post', '/api/commercial/productivity', { op: 'fade', jobId, weekStart: addDaysIso(mondayOf(today), -7) }, (d) => (d.alerts ? `${d.alerts} cost codes fading last week` : 'Nothing fading last week')))}>{busy === 'fade' ? 'Checking…' : 'Check last week'}</Button>}
        </div>
        <CmTable label="Fade alerts" rows={data.alerts} rowKey={(a) => a.id} cols={[
          { key: 'w', head: 'Week of', width: 110, cell: (a) => day(a.week_start, today) },
          { key: 'c', head: 'Cost code', cell: (a) => { const c = codeOf.get(a.cost_code_id); return c ? <><span className="code">{c.code}</span> {c.name}</> : '—'; } },
          { key: 's', head: 'Severity', width: 110, cell: (a) => <Tag tone={a.severity === 'CRITICAL' ? 'neg' : 'warn'}>{words(a.severity)}</Tag> },
          { key: 'g', head: 'Used vs complete', n: true, width: 150, cell: (a) => `${a.pct_hours_used == null ? '—' : pct(Number(a.pct_hours_used))} / ${a.pct_complete == null ? '—' : pct(Number(a.pct_complete))}` },
          { key: 'wk', head: 'Week earned / actual h', n: true, width: 170, cell: (a) => `${qty(a.week_earned_hours, 0)} / ${qty(a.week_actual_hours, 0)}` },
          { key: 'h', head: 'Likely cause', width: 260, cell: (a) => a.cause_hint ?? '—' },
          { key: 'st', head: 'Status', width: 190, cell: (a) => (a.status === 'OPEN' && !readOnly && canFade ? (
            <span className="row" style={{ gap: 4 }}>
              <Button variant="quiet" disabled={busy !== null} onClick={(e) => { e.stopPropagation(); void done(act(`a:${a.id}`, 'post', `/api/commercial/productivity/alerts/${a.id}`, { status: 'ACKNOWLEDGED' }, 'Acknowledged')); }}>Acknowledge</Button>
              <Button variant="quiet" disabled={busy !== null} onClick={(e) => { e.stopPropagation(); void done(act(`r:${a.id}`, 'post', `/api/commercial/productivity/alerts/${a.id}`, { status: 'RESOLVED' }, 'Resolved')); }}>Resolve</Button>
            </span>) : words(a.status)) },
        ]} rowTone={(a) => (a.status === 'OPEN' && a.severity === 'CRITICAL' ? 'neg' : null)}
          empty={{ title: 'No fade alerts', body: 'Each week the check compares earned hours with hours used per cost code and names the likely cause — overtime, hours with no installed quantity, delays on the daily log.' }} />
      </section>

      <Drawer open={!!open} onClose={() => setOpenId(null)} width={480} title={open ? `${open.cost_code ?? ''} ${open.cost_code_name ?? ''}` : ''} eyebrow="Cost code productivity">
        {open && (
          <div className="stack" style={{ gap: 20 }}>
            <KV items={[
              { term: 'Budget', value: `${qty(open.budget_qty)} ${open.uom ?? ''} · ${qty(open.budget_hours, 0)} hours` },
              { term: 'Unit hours', value: open.unit_hours == null ? '—' : `${qty(open.unit_hours, 3)} h per ${open.uom ?? 'unit'}` },
              { term: 'Installed', value: `${qty(open.installed_qty)} ${open.uom ?? ''}` },
              { term: 'Earned / actual', value: `${qty(open.earned_hours, 0)} / ${qty(open.actual_hours, 0)} hours` },
              { term: 'Entry', value: unitOf.get(open.cost_code_id)?.pct_complete_entry ? 'Percent complete' : 'Installed quantity' },
            ]} />
            <DSection title="Recent entries">
              {data.quantities.filter((x) => x.cost_code_id === open.cost_code_id).length === 0 ? <p className="t-cap">Nothing logged yet.</p> : (
                <ul className="feed">{data.quantities.filter((x) => x.cost_code_id === open.cost_code_id).slice(0, 15).map((x) => (
                  <li key={x.id}><span><span className="l1">{x.qty != null ? `${qty(x.qty)} ${x.uom ?? open.uom ?? ''}` : `${pct(Number(x.pct_complete ?? 0))} complete`}</span>{(x.area || x.note) && <span style={{ display: 'block' }}>{[x.area, x.note].filter(Boolean).join(' · ')}</span>}</span><span className="t">{day(x.work_date, today)}</span></li>
                ))}</ul>
              )}
            </DSection>
          </div>
        )}
      </Drawer>
    </div>
  );
}

export function QuantityForm({ jobId, codes, units, today, busy, act }: { jobId: string; codes: CostCodeLite[]; units: CostCodeUnit[]; today: string; busy: string | null; act: Act }) {
  const measured = codes.filter((c) => units.some((u) => u.cost_code_id === c.id));
  const list = measured.length ? measured : codes;
  const [code, setCode] = useState(list[0]?.id ?? '');
  const [date, setDate] = useState(today);
  const [q, setQ] = useState('');
  const [p, setP] = useState<number | null>(null);
  const [area, setArea] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const unit = units.find((u) => u.cost_code_id === code);
  const pctMode = !!unit?.pct_complete_entry || !unit?.budget_qty;
  return (
    <form className="mp-table mp-add" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }} onSubmit={async (e) => {
      e.preventDefault();
      const n = q.trim() ? Number(q.replace(/,/g, '')) : null;
      if (!code) return setErr('Pick the cost code.');
      if (pctMode ? p == null : n == null || !Number.isFinite(n) || n < 0) return setErr(pctMode ? 'Enter the percent complete.' : 'Enter the quantity installed.');
      setErr(null);
      const r = await act('qty', 'post', '/api/commercial/productivity/quantities', { jobId, costCodeId: code, workDate: date, qty: pctMode ? null : n, pctComplete: pctMode ? p : null, uom: unit?.uom ?? null, area: area.trim() || null, note: null }, 'Logged the installed quantity');
      if (r) { setQ(''); setP(null); }
    }}>
      <Field label="Cost code" error={err ?? undefined}><Select value={code} onChange={(e) => setCode(e.target.value)}>{list.map((c) => <option key={c.id} value={c.id}>{c.code} {c.name}</option>)}</Select></Field>
      <Field label="Work date"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} max={today} /></Field>
      {pctMode
        ? <Field label="Percent complete to date"><PctInput value={p} onChange={setP} /></Field>
        : <Field label={`Installed today${unit?.uom ? ` (${unit.uom})` : ''}`}><Input inputMode="decimal" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 120 }} placeholder="240" /></Field>}
      <Field label="Area"><Input value={area} onChange={(e) => setArea(e.target.value)} maxLength={200} placeholder="L2 east" /></Field>
      <Button type="submit" variant="primary" chord="mod+enter" bindChord disabled={busy !== null || list.length === 0}>{busy === 'qty' ? 'Logging…' : 'Log it'}</Button>
    </form>
  );
}

function UnitsForm({ jobId, codes, units, busy, act }: { jobId: string; codes: CostCodeLite[]; units: CostCodeUnit[]; busy: string | null; act: Act }) {
  const [code, setCode] = useState(codes[0]?.id ?? '');
  const u = units.find((x) => x.cost_code_id === code);
  const [bq, setBq] = useState(u?.budget_qty == null ? '' : String(u.budget_qty));
  const [uom, setUom] = useState(u?.uom ?? '');
  const [bh, setBh] = useState(u ? String(u.budget_hours) : '');
  const [pctEntry, setPctEntry] = useState(u?.pct_complete_entry ?? false);
  const pick = (id: string) => { setCode(id); const x = units.find((y) => y.cost_code_id === id); setBq(x?.budget_qty == null ? '' : String(x.budget_qty)); setUom(x?.uom ?? ''); setBh(x ? String(x.budget_hours) : ''); setPctEntry(x?.pct_complete_entry ?? false); };
  return (
    <DSection title="Budget units and hours">
      <form className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }} onSubmit={(e) => {
        e.preventDefault();
        const hours = Number(bh);
        if (!code || !Number.isFinite(hours) || hours < 0) return;
        void act('units', 'post', '/api/commercial/productivity/units', { jobId, costCodeId: code, budgetQty: bq.trim() ? Number(bq) : null, uom: uom.trim() || null, budgetHours: hours, pctCompleteEntry: pctEntry }, 'Saved the budget units');
      }}>
        <Field label="Cost code"><Select value={code} onChange={(e) => pick(e.target.value)}>{codes.map((c) => <option key={c.id} value={c.id}>{c.code} {c.name}{units.some((x) => x.cost_code_id === c.id) ? ' ·' : ''}</option>)}</Select></Field>
        <Field label="Budget quantity"><Input inputMode="decimal" value={bq} onChange={(e) => setBq(e.target.value)} style={{ width: 110 }} disabled={pctEntry} /></Field>
        <Field label="Unit"><Input value={uom} onChange={(e) => setUom(e.target.value)} maxLength={20} style={{ width: 70 }} placeholder="LF" /></Field>
        <Field label="Budget hours"><Input inputMode="decimal" value={bh} onChange={(e) => setBh(e.target.value)} style={{ width: 110 }} /></Field>
        <Check label="Percent-complete entry" checked={pctEntry} onChange={(e) => setPctEntry(e.target.checked)} />
        <Button type="submit" disabled={busy !== null || !code || !bh.trim()}>{busy === 'units' ? 'Saving…' : 'Save'}</Button>
      </form>
      <p className="t-cap" style={{ marginTop: 8 }}>Earned hours = installed ÷ budget quantity × budget hours (or % complete × budget hours).</p>
    </DSection>
  );
}

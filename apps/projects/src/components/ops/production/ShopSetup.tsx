'use client';

import { useState } from 'react';
import { Button, Field, Input, Select, Tag } from '@meritbooks/merit-ui';
import { durationText } from '@/lib/pm/ops/dispatch-math';
import type { RoutingRow, RoutingStepRow, WorkCenterRow } from '@/lib/pm/ops/types';
import { useShell } from '@/components/shell/ShellContext';
import { Failure, PickCompanyNote, Section, parseNum } from '../common/bits';
import { slugCode } from '../dispatch/TechSetup';
import { useOps } from '../common/useOps';

/** Work centers (with weekly capacity) and routings (ordered steps at those centers). */
export function ShopSetup({ centers, routings, steps, companyId }: { centers: WorkCenterRow[]; routings: RoutingRow[]; steps: RoutingStepRow[]; companyId: string | null }) {
  const { readOnly } = useShell();
  const { act, busy, error } = useOps();
  const url = '/api/ops/shop/setup';
  const [wcName, setWcName] = useState('');
  const [wcHours, setWcHours] = useState('40');
  const [rCode, setRCode] = useState('');
  const [rName, setRName] = useState('');
  const [step, setStep] = useState<Record<string, { wc: string; name: string; setup: string; run: string }>>({});
  const name = new Map(centers.map((c) => [c.id, c.name]));
  if (!companyId) return <PickCompanyNote what="Work centers and routings" />;

  return (
    <div className="stack">
      <Failure text={error} />
      <Section title="Work centers" meta="Weekly capacity drives the shop-load statement and the backlog in weeks">
        <div className="mp-table">
          <table className="ops-mini">
            <thead><tr><th>Work center</th><th className="n">Hours a week</th><th>Status</th></tr></thead>
            <tbody>
              {centers.length === 0 && <tr><td colSpan={3} className="t-cap">No work centers yet.</td></tr>}
              {centers.map((c) => (
                <tr key={c.id}>
                  <td><span className="l1">{c.name}</span><span className="l2"><span className="code">{c.code}</span>{c.kind ? ` · ${c.kind}` : ''}</span></td>
                  <td className="n">
                    {readOnly ? durationText(c.capacity_minutes_per_week) : (
                      <Input aria-label={`Hours a week at ${c.name}`} inputMode="decimal" defaultValue={String(c.capacity_minutes_per_week / 60)} style={{ width: 88, textAlign: 'right' }}
                        onBlur={(e) => { const h = parseNum(e.target.value); if (h != null && h >= 0 && Math.round(h * 60) !== c.capacity_minutes_per_week) void act('wc', 'post', url, { op: 'update_center', centerId: c.id, capacityMinutesPerWeek: Math.round(h * 60) }, `${c.name}: ${h} hours a week`); }} />
                    )}
                  </td>
                  <td>
                    {readOnly ? <Tag>{c.status}</Tag> : (
                      <Select aria-label={`Status of ${c.name}`} value={c.status} onChange={(e) => void act('wc', 'post', url, { op: 'update_center', centerId: c.id, status: e.target.value }, `${c.name} is ${e.target.value.toLowerCase()}`)}>
                        <option value="ACTIVE">Running</option><option value="DOWN">Down for maintenance</option><option value="INACTIVE">Not used</option>
                      </Select>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!readOnly && (
            <form className="mp-add" onSubmit={(e) => { e.preventDefault(); const h = parseNum(wcHours); if (wcName.trim() && h != null) void act('wc', 'post', url, { op: 'add_center', companyId, code: slugCode(wcName), name: wcName.trim(), capacityMinutesPerWeek: Math.round(h * 60) }, `Added ${wcName.trim()}`).then((r) => { if (r) setWcName(''); }); }}>
              <Field label="New work center"><Input value={wcName} onChange={(e) => setWcName(e.target.value)} placeholder="CNC router" maxLength={80} /></Field>
              <Field label="Hours a week"><Input inputMode="decimal" value={wcHours} onChange={(e) => setWcHours(e.target.value)} style={{ width: 96 }} /></Field>
              <Button type="submit" icon="plus" disabled={!wcName.trim() || busy === 'wc'}>Add</Button>
            </form>
          )}
        </div>
      </Section>

      <Section title="Routings" meta="Applied to a production order, each step becomes an operation; standard = setup + run × quantity">
        {routings.length === 0 && <p className="t-cap">No routings yet.</p>}
        {routings.map((r) => {
          const ss = steps.filter((s) => s.routing_id === r.id);
          const f = step[r.id] ?? { wc: '', name: '', setup: '0', run: '0' };
          return (
            <div key={r.id} className="mp-table" style={{ marginBottom: 12 }}>
              <div className="row row--between" style={{ padding: '10px 12px', borderBottom: '1px solid var(--line)' }}>
                <span className="b"><span className="code">{r.code}</span> {r.name}{r.version > 1 ? ` · v${r.version}` : ''} {!r.is_active && <Tag>Retired</Tag>}</span>
                {!readOnly && r.is_active && <Button variant="quiet" onClick={() => void act('rt', 'post', url, { op: 'deactivate_routing', routingId: r.id }, `Retired ${r.code}`)}>Retire</Button>}
              </div>
              <table className="ops-mini">
                <thead><tr><th>#</th><th>Step</th><th>Work center</th><th className="n">Setup min</th><th className="n">Run min / unit</th>{!readOnly && <th />}</tr></thead>
                <tbody>
                  {ss.length === 0 && <tr><td colSpan={6} className="t-cap">No steps yet.</td></tr>}
                  {ss.map((s) => (
                    <tr key={s.id}>
                      <td className="ops-num">{s.seq}</td><td>{s.name}</td><td>{name.get(s.work_center_id) ?? '—'}</td><td className="n">{s.setup_minutes}</td><td className="n">{s.run_minutes_per_unit}</td>
                      {!readOnly && <td><Button variant="quiet" iconOnly icon="x" aria-label={`Remove ${s.name}`} onClick={() => void act('rt', 'post', url, { op: 'remove_step', stepId: s.id }, 'Removed the step')} /></td>}
                    </tr>
                  ))}
                </tbody>
              </table>
              {!readOnly && r.is_active && (
                <form className="mp-add" onSubmit={(e) => {
                  e.preventDefault();
                  const su = parseNum(f.setup) ?? 0;
                  const run = parseNum(f.run) ?? 0;
                  if (f.wc && f.name.trim()) void act('rt', 'post', url, { op: 'add_step', routingId: r.id, workCenterId: f.wc, name: f.name.trim(), setupMinutes: Math.round(su), runMinutesPerUnit: run }, `Added ${f.name.trim()}`).then((ok) => { if (ok) setStep({ ...step, [r.id]: { ...f, name: '' } }); });
                }}>
                  <Field label="Work center"><Select value={f.wc} onChange={(e) => setStep({ ...step, [r.id]: { ...f, wc: e.target.value } })}><option value="">Pick</option>{centers.filter((c) => c.status !== 'INACTIVE').map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
                  <Field label="Step"><Input value={f.name} onChange={(e) => setStep({ ...step, [r.id]: { ...f, name: e.target.value } })} placeholder="Cut parts" maxLength={120} /></Field>
                  <Field label="Setup min"><Input inputMode="numeric" value={f.setup} onChange={(e) => setStep({ ...step, [r.id]: { ...f, setup: e.target.value } })} style={{ width: 80 }} /></Field>
                  <Field label="Run / unit"><Input inputMode="decimal" value={f.run} onChange={(e) => setStep({ ...step, [r.id]: { ...f, run: e.target.value } })} style={{ width: 80 }} /></Field>
                  <Button type="submit" icon="plus" disabled={!f.wc || !f.name.trim() || busy === 'rt'}>Add step</Button>
                </form>
              )}
            </div>
          );
        })}
        {!readOnly && (
          <form className="mp-add" style={{ border: '1px solid var(--line)' }} onSubmit={(e) => { e.preventDefault(); if (rCode.trim() && rName.trim()) void act('rt', 'post', url, { op: 'add_routing', companyId, code: rCode.trim(), name: rName.trim() }, `Added routing ${rCode.trim()}`).then((ok) => { if (ok) { setRCode(''); setRName(''); } }); }}>
            <Field label="Code"><Input value={rCode} onChange={(e) => setRCode(e.target.value)} placeholder="BASE-CAB" maxLength={24} style={{ width: 140 }} /></Field>
            <Field label="New routing"><Input value={rName} onChange={(e) => setRName(e.target.value)} placeholder="Base cabinet, frameless" maxLength={120} /></Field>
            <Button type="submit" icon="plus" disabled={!rCode.trim() || !rName.trim() || busy === 'rt'}>Add routing</Button>
          </form>
        )}
      </Section>
    </div>
  );
}

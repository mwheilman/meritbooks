'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Button, Drawer, Field, InlineNotice, Input, Select, Status, Tabs, Tag, WidgetState, count, money, pct, useQuery } from '@meritbooks/merit-ui';
import { useShell } from '@/components/shell/ShellContext';
import type { InstallBoardRow, InstallCosting, InstallItemRow, InstallReadiness } from '@/lib/fieldservice/completion-types';
import { useAction, words } from '../common/useAction';

export interface InstallDrawerContext {
  vendors: Array<{ id: string; name: string }>;
  techs: Array<{ id: string; name: string }>;
  permitTemplates: Array<{ id: string; jurisdiction: string; permit_kind: string }>;
  can: { edit: boolean; dispatch: boolean; purchase: boolean; bill: boolean; finance: boolean };
}

interface Detail {
  items: InstallItemRow[];
  earliest: { date: string; reasons: string[]; readiness: InstallReadiness[] } | null;
  pos: Array<{ commitment_id: string; fulfillment: string; expected_on: string | null; picked_up_at: string | null }>;
  commitments: Array<{ id: string; number: string; status: string; vendor_id: string | null }>;
  permits: Array<{ id: string; kind: string; number: string | null; authority: string | null; status: string; applied_on: string | null; issued_on: string | null }>;
  inspections: Array<{ id: string; permit_id: string | null; kind: string; scheduled_on: string | null; result: string; result_on: string | null }>;
  error: string | null;
}

type Tab = 'overview' | 'equipment' | 'permits' | 'crew' | 'billing';
const NEXT: Record<string, string | null> = { SOLD: 'ORDERED', ORDERED: 'PERMITTED', PERMITTED: 'SCHEDULED', SCHEDULED: 'INSTALLED', INSTALLED: 'INSPECTED', INSPECTED: 'CLOSED', CLOSED: null };

/** One install project: brief, readiness, POs and receiving, permits and inspections, crew days, billing and costing. */
export function InstallDrawer(p: InstallDrawerContext & { project: InstallBoardRow; onClose: () => void }) {
  const { readOnly } = useShell();
  const x = p.project;
  const [tab, setTab] = useState<Tab>('overview');
  const d = useQuery<Detail>('/api/fieldservice/installs', { projectId: x.id }, { scope: false });
  const { run, busy, error } = useAction();
  const act = async (key: string, body: Record<string, unknown>, done: string) => {
    const r = await run(key, '/api/fieldservice/installs', body, done);
    if (r) void d.refetch();
    return r;
  };
  const next = NEXT[x.stage];
  return (
    <Drawer open onClose={p.onClose} width={720} eyebrow={['Install', x.number]} title={x.title} aria-label={`Install ${x.number}`}>
      <div className="stack">
        <div className="fs-toolbar">
          <Status kind={x.stuck ? 'risk' : 'track'}>{words(x.stage)}</Status>
          {x.customer && <span>{x.customer}</span>}
          {x.contract_cents != null && <span className="fs-mono">{money(x.contract_cents)}</span>}
          <span className="sp" />
          <Link className="btn btn--quiet" href={`/jobs/${x.job_id}`}>Job</Link>
          {x.install_work_order_id && <Link className="btn btn--quiet" href={`/dispatch/visit/${x.install_work_order_id}`}>Install visit</Link>}
          {next && p.can.edit && !readOnly && <Button variant="primary" disabled={!!busy} onClick={() => void act('stage', { op: 'stage', projectId: x.id, stage: next }, `Moved to ${words(next)}`)}>{`Mark ${words(next).toLowerCase()}`}</Button>}
        </div>
        {error && <InlineNotice tone="neg" title="That did not go through.">{error}</InlineNotice>}
        <Tabs aria-label="Install" value={tab} onChange={setTab} items={[
          { value: 'overview', label: 'Overview' }, { value: 'equipment', label: 'Equipment & POs' }, { value: 'permits', label: 'Permits' },
          { value: 'crew', label: 'Crew' }, { value: 'billing', label: 'Billing & cost' },
        ]} />
        {d.isLoading ? <WidgetState state={{ kind: 'loading', label: 'Loading the install' }} />
          : d.error || !d.data ? <WidgetState state={{ kind: 'error', title: 'The install did not load', body: d.error ?? '', onRetry: () => void d.refetch() }} />
          : tab === 'overview' ? <Overview x={x} d={d.data} />
          : tab === 'equipment' ? <Equipment x={x} d={d.data} p={p} act={act} busy={busy} readOnly={readOnly} />
          : tab === 'permits' ? <Permits x={x} d={d.data} p={p} act={act} busy={busy} readOnly={readOnly} />
          : tab === 'crew' ? <Crew x={x} d={d.data} p={p} act={act} busy={busy} readOnly={readOnly} />
          : <Billing x={x} p={p} act={act} busy={busy} readOnly={readOnly} />}
      </div>
    </Drawer>
  );
}

type Act = (key: string, body: Record<string, unknown>, done: string) => Promise<unknown>;
interface TabProps { x: InstallBoardRow; d: Detail; p: InstallDrawerContext; act: Act; busy: string | null; readOnly: boolean }

function Overview({ x, d }: { x: InstallBoardRow; d: Detail }) {
  return (
    <div className="stack">
      {x.readiness.length === 0 ? <InlineNotice tone="info" title="Ready to install.">Equipment is in and the permit (if any) is issued.</InlineNotice>
        : x.readiness.map((r) => <InlineNotice key={r.code} tone="warn" title={r.message} />)}
      {d.earliest && (
        <div className="fs-card"><div className="fs-card-b">
          <div className="l1">Earliest install date: {d.earliest.date}</div>
          {d.earliest.reasons.length > 0 && <ul className="t-cap">{d.earliest.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
        </div></div>
      )}
      <dl className="fs-form">
        <div><dt className="t-cap">Install days</dt><dd>{x.install_days}</dd></div>
        <div><dt className="t-cap">Crew size</dt><dd>{x.crew_size}</dd></div>
        <div><dt className="t-cap">Permit</dt><dd>{x.permit_required ? words(x.permit_status ?? 'required') : 'Not required'}</dd></div>
        <div><dt className="t-cap">Final invoice</dt><dd>{x.final_billed ? 'Requested' : 'Not yet'}</dd></div>
      </dl>
    </div>
  );
}

function Equipment({ x, d, p, act, busy, readOnly }: TabProps) {
  const [vendor, setVendor] = useState('');
  const [ful, setFul] = useState<'WILL_CALL' | 'DELIVERY'>('DELIVERY');
  const [expected, setExpected] = useState('');
  const [serials, setSerials] = useState<Record<string, string>>({});
  const unordered = d.items.filter((i) => (i.kind === 'EQUIPMENT' || i.kind === 'PART') && !i.commitment_line_id);
  const byLine = new Map(d.items.filter((i) => i.commitment_line_id).map((i) => [i.commitment_line_id!, i]));
  return (
    <div className="stack">
      <table className="fs-table">
        <thead><tr><th>Item</th><th className="n">Qty</th><th className="n">Received</th>{p.can.finance && <th className="n">Cost</th>}<th>PO</th></tr></thead>
        <tbody>{d.items.map((i) => (
          <tr key={i.id}><td><span className="l1">{i.description}</span><span className="l2">{words(i.kind)}</span></td><td className="n">{i.qty}</td>
            <td className="n">{i.kind === 'EQUIPMENT' || i.kind === 'PART' ? i.received_qty : '—'}</td>
            {p.can.finance && <td className="n">{i.unit_cost_cents == null ? '—' : money(Math.round(i.unit_cost_cents * i.qty))}</td>}
            <td>{i.commitment_line_id ? <Tag tone="pos">On PO</Tag> : i.kind === 'EQUIPMENT' || i.kind === 'PART' ? <Tag tone="warn">Not ordered</Tag> : '—'}</td></tr>
        ))}</tbody>
      </table>
      {unordered.length > 0 && p.can.purchase && !readOnly && (
        <div className="fs-card"><div className="fs-card-b fs-form">
          <Field label="Distributor"><Select value={vendor} onChange={(e) => setVendor(e.target.value)}><option value="">Pick the supply house</option>{p.vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</Select></Field>
          <Field label="Fulfillment"><Select value={ful} onChange={(e) => setFul(e.target.value as 'WILL_CALL' | 'DELIVERY')}><option value="DELIVERY">Delivery</option><option value="WILL_CALL">Will-call (tech picks up)</option></Select></Field>
          <Field label="Expected"><Input type="date" value={expected} onChange={(e) => setExpected(e.target.value)} /></Field>
          <div className="fs-toolbar" style={{ alignItems: 'end', marginBottom: 0 }}><span className="sp" />
            <Button variant="primary" disabled={!vendor || !!busy} onClick={() => void act('po', { op: 'po', projectId: x.id, vendorId: vendor, fulfillment: ful, expectedOn: expected || null }, 'PO drafted and sent for approval')}>
              {`Order ${count(unordered.length)} item(s)`}</Button></div>
        </div></div>
      )}
      {d.commitments.map((c) => {
        const det = d.pos.find((x2) => x2.commitment_id === c.id);
        return (
          <div key={c.id} className="fs-card"><div className="fs-card-h"><span className="l1">{c.number}</span><Tag>{words(c.status)}</Tag>{det && <Tag>{words(det.fulfillment)}</Tag>}<span className="sp" />
            {det?.expected_on && <span className="t-cap">Expected {det.expected_on}</span>}</div>
            {(c.status === 'APPROVED' || c.status === 'EXECUTED') && p.can.purchase && !readOnly && (
              <div className="fs-card-b">
                {[...byLine.entries()].filter(([, it]) => it.received_qty < it.qty).map(([lineId, it]) => (
                  <div key={lineId} className="fs-toolbar" style={{ marginBottom: 6 }}>
                    <span>{it.description}</span><span className="sp" />
                    <Input placeholder="Serial numbers, comma-separated" value={serials[lineId] ?? ''} onChange={(e) => setSerials({ ...serials, [lineId]: e.target.value })} aria-label="Serials" />
                    <Button disabled={!!busy} onClick={() => void act(`rcv:${lineId}`, { op: 'receive', commitmentId: c.id, lines: [{ line_id: lineId, qty: it.qty - it.received_qty,
                      serials: (serials[lineId] ?? '').split(',').map((s) => s.trim()).filter(Boolean) }] }, 'Received')}>Receive</Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Permits({ x, d, p, act, busy, readOnly }: TabProps) {
  const [tpl, setTpl] = useState(p.permitTemplates[0]?.id ?? '');
  const [num, setNum] = useState('');
  return (
    <div className="stack">
      {d.permits.length === 0 ? <WidgetState state={{ kind: 'empty', title: 'No permit yet', body: x.permit_required ? 'This install needs a permit.' : 'Add one if the jurisdiction requires it.' }} /> : (
        <table className="fs-table">
          <thead><tr><th>Permit</th><th>Status</th><th>Inspections</th><th aria-label="Actions" /></tr></thead>
          <tbody>{d.permits.map((r) => (
            <tr key={r.id}>
              <td><span className="l1">{words(r.kind)} {r.number ? `#${r.number}` : ''}</span><span className="l2">{r.authority}</span></td>
              <td>{words(r.status)}{r.issued_on && <span className="l2">Issued {r.issued_on}</span>}</td>
              <td>{d.inspections.filter((i) => i.permit_id === r.id).map((i) => (
                <div key={i.id} className="fs-flags"><span>{words(i.kind)}: {words(i.result)}</span>
                  {i.result === 'PENDING' && p.can.edit && !readOnly && <>
                    <Button variant="quiet" disabled={!!busy} onClick={() => void act(`i:${i.id}`, { op: 'inspection', inspectionId: i.id, result: 'PASS' }, 'Inspection passed')}>Pass</Button>
                    <Button variant="quiet" disabled={!!busy} onClick={() => void act(`i:${i.id}`, { op: 'inspection', inspectionId: i.id, result: 'FAIL' }, 'Re-inspection added')}>Fail</Button>
                  </>}
                </div>
              ))}</td>
              <td>{p.can.edit && !readOnly && r.status !== 'ISSUED' && r.status !== 'APPROVED' && (
                <div className="fs-flags">
                  {r.status === 'NOT_STARTED' && <Button variant="quiet" disabled={!!busy} onClick={() => void act(`p:${r.id}`, { op: 'permit_status', permitId: r.id, status: 'APPLIED' }, 'Applied')}>Applied</Button>}
                  <Button variant="quiet" disabled={!!busy} onClick={() => void act(`p:${r.id}`, { op: 'permit_status', permitId: r.id, status: 'ISSUED' }, 'Permit issued')}>Issued</Button>
                </div>
              )}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
      {p.can.edit && !readOnly && (
        <div className="fs-card"><div className="fs-card-b fs-form">
          <Field label="Jurisdiction template">
            <Select value={tpl} onChange={(e) => setTpl(e.target.value)}>
              {p.permitTemplates.length === 0 && <option value="">No templates — load the starter setup</option>}
              {p.permitTemplates.map((t) => <option key={t.id} value={t.id}>{t.jurisdiction} · {words(t.permit_kind)}</option>)}
            </Select>
          </Field>
          <Field label="Permit number (when applied)"><Input value={num} onChange={(e) => setNum(e.target.value)} /></Field>
          <div className="fs-span fs-toolbar" style={{ marginBottom: 0 }}><span className="sp" />
            <Button variant="primary" disabled={!tpl || !!busy} onClick={() => void act('permit', { op: 'permit', projectId: x.id, templateId: tpl, number: num || null, appliedOn: num ? new Date().toISOString().slice(0, 10) : null }, 'Permit added with its inspections')}>Add permit</Button></div>
        </div></div>
      )}
    </div>
  );
}

function Crew({ x, d, p, act, busy, readOnly }: TabProps) {
  const [start, setStart] = useState(d.earliest?.date ?? '');
  const [days, setDays] = useState(String(x.install_days));
  const [lead, setLead] = useState('');
  const [helpers, setHelpers] = useState<string[]>([]);
  const [override, setOverride] = useState('');
  if (!p.can.dispatch || readOnly) return <WidgetState state={{ kind: 'empty', title: x.install_on ? `Installing from ${x.install_on}` : 'Not scheduled yet', body: 'Dispatch schedules install crews.' }} />;
  return (
    <div className="fs-form">
      <Field label="Start" help={d.earliest ? `Earliest ${d.earliest.date}` : undefined}><Input type="date" value={start} onChange={(e) => setStart(e.target.value)} /></Field>
      <Field label="Install days"><Input inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value.replace(/\D/g, ''))} /></Field>
      <Field label="Crew lead"><Select value={lead} onChange={(e) => setLead(e.target.value)}><option value="">Pick the lead</option>{p.techs.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></Field>
      <Field label="Helpers">
        <Select multiple value={helpers} onChange={(e) => setHelpers([...e.target.selectedOptions].map((o) => o.value))} aria-label="Helpers">
          {p.techs.filter((t) => t.id !== lead).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </Select>
      </Field>
      <Field label="Over capacity? Say why" className="fs-span" help="Only needed when the week's install crew-days are full"><Input value={override} onChange={(e) => setOverride(e.target.value)} /></Field>
      <div className="fs-span fs-toolbar" style={{ marginBottom: 0 }}><span className="sp" />
        <Button variant="primary" disabled={!start || !lead || !Number(days) || !!busy}
          onClick={() => void act('sched', { op: 'schedule', projectId: x.id, start, days: Number(days), leadId: lead, helperIds: helpers, overrideReason: override || null }, 'Install scheduled — it is on the crew’s phones')}>Schedule crew</Button></div>
    </div>
  );
}

function Billing({ x, p, act, busy, readOnly }: Omit<TabProps, 'd'>) {
  const cost = useQuery<InstallCosting>(p.can.finance ? '/api/fieldservice/installs/costing' : null, { projectId: x.id }, { scope: false });
  const [amount, setAmount] = useState('');
  const cents = amount ? Math.round(Number(amount.replace(/[$,]/g, '')) * 100) : 0;
  return (
    <div className="stack">
      {p.can.bill && !readOnly && (
        <div className="fs-card"><div className="fs-card-b">
          <div className="fs-toolbar" style={{ marginBottom: 0 }}>
            <Input inputMode="decimal" placeholder="Amount" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Amount" />
            <Button disabled={!cents || !!busy} onClick={() => void act('dep', { op: 'bill', projectId: x.id, kind: 'DEPOSIT', amountCents: cents }, 'Deposit invoice requested')}>Deposit</Button>
            <Button disabled={!cents || !!busy} onClick={() => void act('prog', { op: 'bill', projectId: x.id, kind: 'PROGRESS', amountCents: cents }, 'Progress invoice sent for approval')}>Progress</Button>
            <span className="sp" />
            <Button variant="primary" disabled={x.final_billed || !!busy} onClick={() => void act('final', { op: 'bill', projectId: x.id, kind: 'FINAL' }, 'Final invoice sent for approval')}>Final invoice for the rest</Button>
          </div>
          <p className="t-cap">Invoices are minted by Books after approval. Financed installs: record the lender funding under Invoice review → Financing.</p>
        </div></div>
      )}
      {!p.can.finance ? <WidgetState state={{ kind: 'empty', title: 'Job costing needs job financials', body: 'Ask the owner if you need estimated vs actual cost.' }} />
        : cost.isLoading ? <WidgetState state={{ kind: 'loading', label: 'Loading job cost' }} />
        : cost.error || !cost.data ? <WidgetState state={{ kind: 'error', title: 'Job cost did not load', body: cost.error ?? '' }} />
        : (
          <section className="fs-card" aria-label="Estimated vs actual">
            <div className="fs-card-h"><h2 className="t-section">Estimated vs actual</h2><span className="sp" />
              {cost.data.actual_margin_pct != null && <span className="t-cap">Margin {pct(cost.data.actual_margin_pct)} actual · {cost.data.estimated_margin_pct == null ? '—' : pct(cost.data.estimated_margin_pct)} estimated</span>}</div>
            <table className="fs-table">
              <thead><tr><th>Category</th><th className="n">Estimated</th><th className="n">Actual (Books)</th><th className="n">Variance</th></tr></thead>
              <tbody>{['equipment', 'materials', 'labor', 'subs', 'permits', 'commissions', 'other'].map((k) => {
                const e = cost.data!.estimated[k]; const a = cost.data!.actual[k];
                return <tr key={k}><td>{words(k)}</td><td className="n">{e == null ? '—' : money(e)}</td><td className="n">{a == null ? '—' : money(a)}</td>
                  <td className={`n ${(a ?? 0) - (e ?? 0) > 0 ? 'neg' : ''}`}>{e == null || a == null ? '—' : money(a - e)}</td></tr>;
              })}</tbody>
            </table>
            {cost.data.variances.length > 0 && <div className="fs-card-b">{cost.data.variances.map((v) => <p key={v.category}>{v.explanation}</p>)}</div>}
          </section>
        )}
    </div>
  );
}

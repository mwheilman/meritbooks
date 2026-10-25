'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button, Check, Field, InlineNotice, Input, Select, Status, Tabs, Tag, WidgetState, api, count, money, pct, shortDate, toast } from '@meritbooks/merit-ui';
import { useShell } from '@/components/shell/ShellContext';
import { parseCsv } from '@/lib/fieldservice/csv';
import type { AgreementsWorkspaceData } from '@/lib/fieldservice/queries';
import type { AgreementImportReport, BusinessUnitRow, WindowRow, ZoneRow } from '@/lib/fieldservice/types';

type Tab = 'due' | 'billing' | 'renewals' | 'deferred' | 'import';

export interface AgreementsWorkspaceProps {
  companyId: string | null;
  today: string;
  data: AgreementsWorkspaceData;
  customers: Record<string, string>;
  techs: Record<string, string>;
  zones: ZoneRow[];
  windows: WindowRow[];
  businessUnits: BusinessUnitRow[];
  jobTypeKeys: string[];
  can: { dispatch: boolean; bill: boolean; finance: boolean; importer: boolean; renew: boolean; contract: boolean };
}

/**
 * The agreements workspace (FS-61–65): owed visits to book in bulk, the recurring billing run and
 * dunning read-back, the 30 / 60 / 90-day renewal pipeline, the deferred-revenue roll-forward and
 * the import with a reconciliation report. Every action is re-checked by its definer RPC.
 */
export function AgreementsWorkspace(p: AgreementsWorkspaceProps) {
  const { readOnly } = useShell();
  const tabs: Array<{ value: Tab; label: string; count?: string }> = [
    { value: 'due', label: 'Visits due', count: count(p.data.visitsDue.length) },
    ...(p.can.bill || p.can.finance ? [{ value: 'billing' as const, label: 'Billing' }] : []),
    { value: 'renewals', label: 'Renewals', count: count(p.data.renewals.length) },
    ...(p.can.finance ? [{ value: 'deferred' as const, label: 'Deferred revenue' }] : []),
    ...(p.can.importer ? [{ value: 'import' as const, label: 'Import' }] : []),
  ];
  const [tab, setTab] = useState<Tab>('due');
  if (!p.companyId) {
    return <InlineNotice tone="info" title="Switch to one company to run visits, billing and imports.">The lists below the tabs cover the company in view.</InlineNotice>;
  }
  return (
    <section className="stack" aria-label="Agreements workspace">
      <Tabs aria-label="Agreements workspace" items={tabs} value={tab} onChange={setTab} />
      {tab === 'due' && <VisitsDue {...p} companyId={p.companyId} readOnly={readOnly || !p.can.dispatch} />}
      {tab === 'billing' && <Billing {...p} companyId={p.companyId} readOnly={readOnly} />}
      {tab === 'renewals' && <Renewals {...p} readOnly={readOnly || !p.can.renew} />}
      {tab === 'deferred' && <Deferred {...p} companyId={p.companyId} readOnly={readOnly} />}
      {tab === 'import' && <ImportAgreements {...p} companyId={p.companyId} readOnly={readOnly} />}
    </section>
  );
}

function VisitsDue(p: AgreementsWorkspaceProps & { companyId: string; readOnly: boolean }) {
  const router = useRouter();
  const months = [...new Set(p.data.visitsDue.map((v) => v.due_month))].sort();
  const [month, setMonth] = useState('');
  const [zone, setZone] = useState('');
  const [tech, setTech] = useState('');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [day, setDay] = useState(p.today);
  const [win, setWin] = useState(p.windows.find((w) => w.is_active && !w.is_after_hours)?.id ?? '');
  const [bu, setBu] = useState(p.businessUnits.find((b) => b.kind === 'MAINTENANCE')?.id ?? p.businessUnits[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const rows = useMemo(() => p.data.visitsDue.filter((v) => (!month || v.due_month === month) && (!zone || v.zone_id === zone) && (!tech || v.last_tech_id === tech)), [p.data.visitsDue, month, zone, tech]);
  async function book() {
    setBusy(true); setErr(null);
    const r = await api.post<{ booked: number; failed: Array<{ number: string; error: string }> }>('/api/fieldservice/agreements', {
      op: 'book_visits', workOrderIds: [...sel], serviceDay: day, arrivalWindowId: win, businessUnitId: bu,
    });
    setBusy(false);
    if (r.error) { setErr(r.error.error); return; }
    toast(`Booked ${count(r.data?.booked ?? 0)} visit(s) into ${day}`);
    if (r.data?.failed.length) setErr(r.data.failed.map((f) => `${f.number}: ${f.error}`).join(' · '));
    setSel(new Set());
    router.refresh();
  }
  return (
    <div className="stack">
      <div className="fs-toolbar">
        <Field label="Due month"><Select value={month} onChange={(e) => setMonth(e.target.value)}><option value="">Every month</option>{months.map((m) => <option key={m} value={m}>{m}</option>)}</Select></Field>
        <Field label="Zone"><Select value={zone} onChange={(e) => setZone(e.target.value)}><option value="">Every zone</option>{p.zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}</Select></Field>
        <Field label="Last technician"><Select value={tech} onChange={(e) => setTech(e.target.value)}><option value="">Anyone</option>{Object.entries(p.techs).map(([id, n]) => <option key={id} value={id}>{n}</option>)}</Select></Field>
        <span className="sp" />
        {!p.readOnly && (
          <>
            <Field label="Day"><Input type="date" value={day} min={p.today} onChange={(e) => setDay(e.target.value)} /></Field>
            <Field label="Window"><Select value={win} onChange={(e) => setWin(e.target.value)}>{p.windows.filter((w) => w.is_active).map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}</Select></Field>
            <Field label="Business unit"><Select value={bu} onChange={(e) => setBu(e.target.value)}>{p.businessUnits.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>
            <Button variant="primary" disabled={busy || sel.size === 0 || !win || !bu} onClick={() => void book()} count={sel.size ? count(sel.size) : undefined}>Book</Button>
          </>
        )}
      </div>
      {err && <InlineNotice tone="warn" title="Some visits did not book.">{err}</InlineNotice>}
      {rows.length === 0 ? <WidgetState state={{ kind: 'empty', title: 'No owed visits match', body: 'Generate visits on an agreement (or import agreements) and the owed tune-ups queue here by season window.' }} /> : (
        <section className="fs-card fs-scroll">
          <table className="fs-table">
            <thead><tr>{!p.readOnly && <th><Check aria-label="Select all" checked={rows.every((r) => sel.has(r.work_order_id))} onChange={(e) => setSel(e.target.checked ? new Set(rows.map((r) => r.work_order_id)) : new Set())} /></th>}<th>Visit</th><th>Customer</th><th>Plan</th><th>Window</th><th>Booked for</th><th>Last tech</th></tr></thead>
            <tbody>
              {rows.slice(0, 500).map((v) => (
                <tr key={v.work_order_id} aria-selected={sel.has(v.work_order_id)}>
                  {!p.readOnly && <td><Check aria-label={`Select ${v.number}`} checked={sel.has(v.work_order_id)} onChange={(e) => { const n = new Set(sel); if (e.target.checked) n.add(v.work_order_id); else n.delete(v.work_order_id); setSel(n); }} /></td>}
                  <td><Link className="link" href={`/dispatch/visit/${v.work_order_id}`}><span className="code">{v.number}</span></Link><span className="l2">{v.summary}</span></td>
                  <td>{p.customers[v.customer_id] ?? 'Customer'}{v.entitlements_suspended && <> <Tag tone="warn">Payments failing</Tag></>}</td>
                  <td>{v.plan_name}{v.tier ? ` · ${v.tier}` : ''}<span className="l2">{v.agreement_number}</span></td>
                  <td>{v.due_on ? shortDate(v.due_on, p.today) : '—'}–{v.due_by ? shortDate(v.due_by, p.today) : '—'}{v.is_overdue && <> <Status kind="overdue">Past window</Status></>}</td>
                  <td>{v.service_day ? shortDate(v.service_day, p.today) : <span className="fs-muted">Not booked</span>}</td>
                  <td>{v.last_tech_id ? p.techs[v.last_tech_id] ?? '—' : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

function Billing(p: AgreementsWorkspaceProps & { companyId: string; readOnly: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const failed = p.data.schedule.filter((s) => s.status === 'FAILED');
  async function run(op: 'billing_all' | 'dunning') {
    setBusy(op); setErr(null); setMsg(null);
    const r = await api.post<{ requested?: number; failed?: number; result?: { paid: number; failed: number; suspended: number } }>('/api/fieldservice/agreements', { op, companyId: p.companyId });
    setBusy(null);
    if (r.error) { setErr(r.error.error); return; }
    if (op === 'billing_all') setMsg(`Drafted ${count(r.data?.requested ?? 0)} billing request(s) for periods due today. Approve them in Billing to send to Books.`);
    else setMsg(`Payments read back: ${count(r.data?.result?.paid ?? 0)} paid, ${count(r.data?.result?.failed ?? 0)} newly failed (customer texted), ${count(r.data?.result?.suspended ?? 0)} membership(s) suspended.`);
    router.refresh();
  }
  return (
    <div className="stack">
      <div className="row" style={{ gap: 8 }}>
        {p.can.bill && !p.readOnly && <Button variant="primary" disabled={!!busy} onClick={() => void run('billing_all')}>Draft bills due today</Button>}
        {p.can.bill && !p.readOnly && <Button disabled={!!busy} onClick={() => void run('dunning')}>Read back payments</Button>}
        <span className="sp" /><Link className="link t-cap" href="/billing">Billing queue</Link>
      </div>
      {msg && <InlineNotice tone="info" title="Done.">{msg}</InlineNotice>}
      {err && <InlineNotice tone="neg" title="Not run.">{err}</InlineNotice>}
      {failed.length > 0 && <InlineNotice tone="warn" title={`${count(failed.length)} membership payment(s) failed.`}>Books retries the card; the customer got a text. Memberships suspend after the plan’s limit.</InlineNotice>}
      {p.data.schedule.length === 0 ? <WidgetState state={{ kind: 'empty', title: 'No billing periods yet', body: 'Draft bills builds each agreement’s schedule (monthly, quarterly, annual) and requests the periods that are due.' }} /> : (
        <section className="fs-card fs-scroll">
          <table className="fs-table">
            <thead><tr><th>Period</th><th>Bill on</th><th className="n">Amount</th><th>Status</th><th className="n">Attempts</th></tr></thead>
            <tbody>{p.data.schedule.slice(0, 300).map((s) => (
              <tr key={s.id}>
                <td>#{s.period_no} · {shortDate(s.period_start, p.today)} – {shortDate(s.period_end, p.today)}</td>
                <td>{shortDate(s.bill_on, p.today)}</td>
                <td className="n">{s.amount_cents == null ? '—' : money(Number(s.amount_cents))}</td>
                <td><Status kind={s.status === 'PAID' ? 'ready' : s.status === 'FAILED' ? 'overdue' : s.status === 'REQUESTED' ? 'track' : 'risk'}>{s.status === 'PAID' ? 'Paid' : s.status === 'FAILED' ? 'Failed' : s.status === 'REQUESTED' ? 'Requested' : s.status === 'VOID' ? 'Void' : 'Scheduled'}</Status></td>
                <td className="n">{count(s.attempts)}</td>
              </tr>
            ))}</tbody>
          </table>
        </section>
      )}
    </div>
  );
}

function Renewals(p: AgreementsWorkspaceProps & { readOnly: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const buckets = [30, 60, 90] as const;
  async function renew(id: string, price: number) {
    setBusy(id); setErr(null);
    const r = await api.post('/api/fieldservice/agreements', { op: 'renew', agreementId: id, priceCents: price });
    setBusy(null);
    if (r.error) { setErr(r.error.error); return; }
    toast('Renewed — the next term starts the day this one ends');
    router.refresh();
  }
  if (!p.data.renewals.length) return <WidgetState state={{ kind: 'empty', title: 'Nothing ends in the next 90 days', body: 'Active agreements ending soon list here by 30, 60 and 90 days with the renewal price.' }} />;
  return (
    <div className="stack">
      {err && <InlineNotice tone="neg" title="Not renewed.">{err}</InlineNotice>}
      {buckets.map((bk) => {
        const rows = p.data.renewals.filter((r) => r.bucket === bk);
        if (!rows.length) return null;
        return (
          <section key={bk} className="fs-card">
            <div className="fs-card-h"><h2 className="t-section">Ending in {bk} days</h2><span className="tnum b">{count(rows.length)}</span><span className="sp" /><span className="t-cap">{count(rows.filter((r) => r.auto_renew).length)} renew automatically</span></div>
            <table className="fs-table">
              <thead><tr><th>Agreement</th><th>Customer</th><th>Ends</th>{p.can.contract && <><th className="n">Price now</th><th className="n">Renewal price</th></>}<th /></tr></thead>
              <tbody>{rows.map((r) => (
                <tr key={r.agreement_id}>
                  <td><span className="code">{r.number}</span><span className="l2">{r.plan_name}{r.tier ? ` · ${r.tier}` : ''}</span></td>
                  <td>{p.customers[r.customer_id] ?? 'Customer'}{r.failed_payment_count > 0 && <> <Tag tone="warn">{count(r.failed_payment_count)} failed payment(s)</Tag></>}</td>
                  <td>{shortDate(r.ends_on, p.today)} · {count(r.days_left)} days{r.auto_renew ? '' : ' · manual'}</td>
                  {p.can.contract && <td className="n">{r.price_cents == null ? '—' : money(Number(r.price_cents))}</td>}
                  {p.can.contract && <td className="n">{r.renewal_price_cents == null ? '—' : money(Number(r.renewal_price_cents))}{Number(r.renewal_uplift_pct) > 0 && <span className="l2">+{pct(Number(r.renewal_uplift_pct))}</span>}</td>}
                  <td>{!p.readOnly && <Button disabled={busy === r.agreement_id || r.renewal_price_cents == null} onClick={() => void renew(r.agreement_id, Number(r.renewal_price_cents))}>Renew</Button>}</td>
                </tr>
              ))}</tbody>
            </table>
          </section>
        );
      })}
    </div>
  );
}

function Deferred(p: AgreementsWorkspaceProps & { companyId: string; readOnly: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const t = p.data.deferred.reduce((s, r) => ({ opening: s.opening + Number(r.opening_cents), billed: s.billed + Number(r.billed_cents), rec: s.rec + Number(r.recognized_cents), rel: s.rel + Number(r.released_cents), def: s.def + Number(r.deferred_cents), owed: s.owed + Math.max(0, r.visits_included - r.visits_delivered) }), { opening: 0, billed: 0, rec: 0, rel: 0, def: 0, owed: 0 });
  async function recognize() {
    setBusy(true);
    const r = await api.post<{ facts: number }>('/api/fieldservice/agreements', { op: 'recognize', companyId: p.companyId });
    setBusy(false);
    if (r.error) { setMsg(r.error.error); return; }
    setMsg(`Recorded ${count(r.data?.facts ?? 0)} straight-line recognition fact(s) for Books.`);
    router.refresh();
  }
  return (
    <div className="stack">
      <InlineNotice tone="info" title="Books keeps the ledger.">Projects records what was billed, which visits were delivered and what was released; Books recognizes the revenue from these facts (pending ones are waiting for Books).</InlineNotice>
      <div className="row" style={{ gap: 8 }}>{!p.readOnly && <Button disabled={busy} onClick={() => void recognize()}>Record straight-line recognition through today</Button>}{msg && <span className="t-cap">{msg}</span>}</div>
      {p.data.deferred.length === 0 ? <WidgetState state={{ kind: 'empty', title: 'No agreement revenue yet', body: 'Billing requests and completed visits add up here.' }} /> : (
        <section className="fs-card fs-scroll">
          <table className="fs-table">
            <thead><tr><th>Agreement</th><th>Policy</th><th className="n">Opening</th><th className="n">Billed</th><th className="n">Recognized</th><th className="n">Released</th><th className="n">Deferred</th><th className="n">Visits</th><th className="n">Pending</th></tr></thead>
            <tbody>
              {p.data.deferred.map((r) => (
                <tr key={r.agreement_id}>
                  <td><span className="code">{r.number}</span><span className="l2">{r.plan_name}{r.tier ? ` · ${r.tier}` : ''} · {r.status.toLowerCase()}</span></td>
                  <td>{r.revenue_policy === 'PER_VISIT' ? 'Per visit' : 'Straight line'}</td>
                  <td className="n">{money(Number(r.opening_cents))}</td><td className="n">{money(Number(r.billed_cents))}</td><td className="n">{money(Number(r.recognized_cents))}</td>
                  <td className="n">{money(Number(r.released_cents))}</td><td className="n b">{money(Number(r.deferred_cents))}</td>
                  <td className="n">{count(r.visits_delivered)} of {count(r.visits_included)}</td><td className="n">{count(r.facts_pending)}</td>
                </tr>
              ))}
              <tr><td className="b">Total</td><td /><td className="n b">{money(t.opening)}</td><td className="n b">{money(t.billed)}</td><td className="n b">{money(t.rec)}</td><td className="n b">{money(t.rel)}</td><td className="n b">{money(t.def)}</td><td className="n b">{count(t.owed)} owed</td><td /></tr>
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

const IMPORT_COLS = ['customer_id', 'customer_name', 'plan_name', 'tier', 'starts_on', 'ends_on', 'price_cents', 'billing_frequency', 'visits_per_term', 'visits_remaining', 'deferred_cents', 'external_ref', 'revenue_policy'] as const;

function ImportAgreements(p: AgreementsWorkspaceProps & { companyId: string; readOnly: boolean }) {
  const [rows, setRows] = useState<Array<Record<string, string>>>([]);
  const [source, setSource] = useState<'FIELDEDGE' | 'SIMPRO' | 'SERVICETITAN' | 'HOUSECALL_PRO' | 'JOBBER' | 'CSV'>('CSV');
  const [jobType, setJobType] = useState(p.jobTypeKeys[0] ?? '');
  const [report, setReport] = useState<AgreementImportReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function read(f: File) {
    setErr(null); setReport(null);
    if (f.size > 8_000_000) { setErr('That file is over 8 MB.'); return; }
    const all = parseCsv(await f.text());
    const head = (all[0] ?? []).map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
    if (!head.includes('plan_name') || !head.includes('starts_on') || !head.includes('ends_on')) { setErr(`The sheet needs columns ${IMPORT_COLS.join(', ')}.`); return; }
    setRows(all.slice(1).filter((r) => r.some((c) => c.trim())).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()]).filter(([h, v]) => (IMPORT_COLS as readonly string[]).includes(h) && v !== ''))));
  }
  async function run(dryRun: boolean) {
    setBusy(true); setErr(null);
    const r = await api.post<{ report: AgreementImportReport }>('/api/fieldservice/agreements', { op: 'import', companyId: p.companyId, jobTypeKey: jobType, rows, dryRun, sourceSystem: source });
    setBusy(false);
    if (r.error) { setErr(r.error.error); return; }
    setReport(r.data?.report ?? null);
    if (!dryRun) toast(`Imported ${count(r.data?.report.ok ?? 0)} agreement(s)`);
  }
  return (
    <div className="stack" style={{ maxWidth: 900 }}>
      <p className="t-ui">Bring agreements over with their billing cadence, visits still owed and the deferred balance. Check first: the report prints the count, deferred dollars and visits owed to tie out before go-live.</p>
      <div className="fs-form">
        <Field label="From"><Select value={source} onChange={(e) => setSource(e.target.value as typeof source)}><option value="CSV">Spreadsheet</option><option value="FIELDEDGE">FieldEdge</option><option value="SIMPRO">simPRO</option><option value="SERVICETITAN">ServiceTitan</option><option value="HOUSECALL_PRO">Housecall Pro</option><option value="JOBBER">Jobber</option></Select></Field>
        <Field label="Job type for the agreement jobs"><Select value={jobType} onChange={(e) => setJobType(e.target.value)}>{p.jobTypeKeys.map((k) => <option key={k} value={k}>{k}</option>)}</Select></Field>
        <div className="fs-span"><Field label="CSV file" help={`Columns: ${IMPORT_COLS.join(', ')}`}><input type="file" accept=".csv,text/csv" onChange={(e) => { const f = e.target.files?.[0]; if (f) void read(f); }} /></Field></div>
      </div>
      {rows.length > 0 && <p className="t-cap">{count(rows.length)} row(s) read.</p>}
      <div className="row" style={{ gap: 8 }}>
        <Button disabled={busy || !rows.length || !jobType} onClick={() => void run(true)}>Check</Button>
        <Button variant="primary" disabled={busy || p.readOnly || !report?.dry_run || report.ok === 0} onClick={() => void run(false)}>Import {report?.dry_run ? count(report.ok) : ''}</Button>
      </div>
      {err && <InlineNotice tone="neg" title="Not imported.">{err}</InlineNotice>}
      {report && (
        <section className="fs-card">
          <div className="fs-card-h"><h2 className="t-section">{report.dry_run ? 'Reconciliation (nothing saved yet)' : 'Imported'}</h2></div>
          <div className="fs-card-b">
            <dl className="kv">
              <dt>Agreements</dt><dd className="tnum">{count(report.ok)} of {count(report.rows)}</dd>
              <dt>Deferred balance</dt><dd className="tnum">{money(Number(report.deferred_cents))}</dd>
              <dt>Visits owed</dt><dd className="tnum">{count(report.visits_owed)}</dd>
              <dt>Errors</dt><dd className="tnum">{count(report.error_count)}</dd>
            </dl>
            {Object.entries(report.by_tier).length > 0 && (
              <table className="fs-table"><thead><tr><th>Tier</th><th className="n">Count</th><th className="n">Deferred</th><th className="n">Visits owed</th></tr></thead>
                <tbody>{Object.entries(report.by_tier).map(([k, v]) => <tr key={k}><td>{k}</td><td className="n">{count(v.count)}</td><td className="n">{money(Number(v.deferred_cents))}</td><td className="n">{count(v.visits_owed)}</td></tr>)}</tbody></table>
            )}
            {report.no_billing.length > 0 && <InlineNotice tone="warn" title={`${count(report.no_billing.length)} agreement(s) have no billing.`}>Rows {report.no_billing.map((x) => x.row).join(', ')}.</InlineNotice>}
            {report.no_visits.length > 0 && <InlineNotice tone="warn" title={`${count(report.no_visits.length)} agreement(s) include no visits.`}>Rows {report.no_visits.map((x) => x.row).join(', ')}.</InlineNotice>}
            {report.errors.slice(0, 30).map((x) => <p key={x.row} className="t-cap">Row {x.row}{x.ref ? ` (${x.ref})` : ''}: {x.error}</p>)}
          </div>
        </section>
      )}
      {p.data.imports.length > 0 && (
        <section className="fs-card">
          <div className="fs-card-h"><h2 className="t-section">Earlier runs</h2></div>
          <ul className="fs-list">{p.data.imports.map((i) => <li key={i.id}><span>{shortDate(i.created_at, p.today)} · {i.source_system.toLowerCase()} · {i.dry_run ? 'check' : 'import'}</span><span className="sp" /><span className="t-cap tnum">{count(i.ok_count)} ok · {count(i.error_count)} errors · {money(Number(i.deferred_cents))} deferred · {count(i.visits_owed)} visits owed</span></li>)}</ul>
        </section>
      )}
    </div>
  );
}

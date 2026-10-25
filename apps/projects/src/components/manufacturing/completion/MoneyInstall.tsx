'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Button, ButtonRow, Field, InlineNotice, Input, QueueTable, Select, Status, Tabs, Textarea, count, type QueueColumn } from '@meritbooks/merit-ui';
import { useShell } from '@/components/shell/ShellContext';
import { Failure, Section } from '@/components/ops/common/bits';
import { BoardState, Empty, centsFrom, day, pctText, qty, useBoard, useDo } from '@/components/dealer/common/depth';
import { PhotoButton, SignaturePad, m, type Opt } from '@/components/dealer/completion/kit';

const MONEY = '/api/mfg/money';

interface Dash { weeks_of_backlog: number | null; on_time_pct: number | null; throughput_per_week_cents: number | null; margin_fade_pct: number | null; loss_jobs: number | null; deposits_held_cents: number | null; cost_of_quality_share: number | null; cost_of_quality_material_cents: number | null; win_rate: number | null; quote_to_ship_days: number | null; actions: Array<{ kind: string; count: number }> }
interface WipRow { job_id: string; job: string; job_name: string; contract_cents: number; eac_cents: number; cost_to_date_cents: number; pct_complete: number; earned_cents: number; billed_cents: number; over_under_cents: number; margin_pct: number | null; fade_pct: number | null; loss_job: boolean; last_pinned: string | null }
interface JobCost { rows: Array<{ wbs_id: string | null; area: string; bucket: string; estimate_cents: number; committed_cents: number; actual_cents: number; variance_cents: number }>; totals: { estimate_cents: number; committed_cents: number; actual_cents: number }; cost_of_quality_cents: number; note: string }
interface Billing { proposal: { id: string; version: number; status: string; deposit_schedule: Array<{ label: string; pct: number }>; deposit_request_id: string | null } | null; stored: Array<{ id: string; description: string; stored_at: string; status: string; stored_on: string; insured: boolean; area: string | null; value_cents: number | null }>; deliveries: Array<{ id: string; number: string; status: string; delivered_at: string | null; billing_request_id: string | null }>; requests: Array<{ id: string; billing_type: string; status: string; memo: string | null; occurred_on: string; invoice_number: string | null; net_cents: number | null }>; deposits: Array<{ id: string; memo: string | null; status: string; invoice_number: string | null; amount_cents: number | null }> }
const ACTION_WORDS: Record<string, string> = { late_outside: 'outside-processing jobs are late', eng_at_risk: 'drafting tasks are at risk', loss_jobs: 'jobs are forecast at a loss' };
type Tab = 'dash' | 'wip' | 'job';

/** The owner's numbers, WIP by job, and one job's cost by area and bucket with its billing (stored materials, deliveries, deposits). */
export function MoneyView({ companyId, today, jobs, areas }: { companyId: string; today: string; jobs: Opt[]; areas: Array<Opt & { jobId: string }> }) {
  const { readOnly } = useShell();
  const [tab, setTab] = useState<Tab>('dash');
  const [job, setJob] = useState(jobs[0]?.id ?? '');
  const dash = useBoard<Dash>(tab === 'dash' ? `${MONEY}?view=dashboard&company=${companyId}` : null);
  const wip = useBoard<WipRow[]>(tab === 'wip' ? `${MONEY}?view=wip&company=${companyId}` : null);
  const jc = useBoard<JobCost>(tab === 'job' && job ? `${MONEY}?view=job_cost&job=${job}` : null);
  const bill = useBoard<Billing>(tab === 'job' && job ? `${MONEY}?view=billing&job=${job}` : null);
  const { run, busy, error } = useDo(() => { wip.reload(); jc.reload(); bill.reload(); });
  const [stored, setStored] = useState({ description: '', at: 'Shop', value: '', wbsId: '', insured: true, photos: [] as string[] });
  const [pick, setPick] = useState<string[]>([]);
  const wipCols: QueueColumn<WipRow>[] = [
    { id: 'j', header: 'Job', cell: (r) => <><span className="l1">{r.job} · {r.job_name}</span><span className="l2">{pctText(r.pct_complete, 0)} complete{r.last_pinned ? ` · pinned ${day(r.last_pinned, today)}` : ''}</span></> },
    { id: 'c', header: 'Contract', numeric: true, width: 120, cell: (r) => m(r.contract_cents) },
    { id: 'e', header: 'Earned', numeric: true, width: 120, cell: (r) => m(r.earned_cents) },
    { id: 'b', header: 'Billed', numeric: true, width: 120, cell: (r) => m(r.billed_cents) },
    { id: 'o', header: 'Over / under', numeric: true, width: 120, cell: (r) => <Status kind={r.over_under_cents < 0 ? 'risk' : 'track'} pip="open">{m(r.over_under_cents)}</Status> },
    { id: 'mg', header: 'Margin', numeric: true, width: 120, cell: (r) => <>{r.margin_pct == null ? '—' : pctText(r.margin_pct)}{r.fade_pct != null && Number(r.fade_pct) > 0 && <div className="neg t-cap">faded {pctText(r.fade_pct)}</div>}{r.loss_job && <div className="neg t-cap">loss job</div>}</> },
  ];
  return (
    <div className="stack">
      {error && <Failure text={error} />}
      <Tabs aria-label="Shop money" value={tab} onChange={setTab} items={[{ value: 'dash', label: 'Owner view' }, { value: 'wip', label: 'WIP' }, { value: 'job', label: 'Job cost and billing' }]} />
      {tab === 'dash' && <>
        <BoardState b={dash} what="The owner view" />
        {dash.data && (
          <>
            <div className="ops-toolbar">
              {[['Weeks of backlog', dash.data.weeks_of_backlog == null ? '—' : qty(dash.data.weeks_of_backlog)], ['On-time delivery', pctText(dash.data.on_time_pct, 0)], ['Shipped per week', m(dash.data.throughput_per_week_cents)],
                ['Margin fade', pctText(dash.data.margin_fade_pct)], ['Deposits held', m(dash.data.deposits_held_cents)], ['Remake share', pctText(dash.data.cost_of_quality_share)], ['Win rate', pctText(dash.data.win_rate, 0)],
                ['Award to first delivery', dash.data.quote_to_ship_days == null ? '—' : `${qty(dash.data.quote_to_ship_days)} days`]].map(([l, v]) => <Section key={l} title={v}><span className="t-cap">{l}</span></Section>)}
            </div>
            {dash.data.actions.length > 0 && dash.data.actions.map((a) => <InlineNotice key={a.kind} tone="warn" title={`${count(a.count)} ${ACTION_WORDS[a.kind] ?? a.kind}.`}>{a.kind === 'late_outside' ? <Link className="nlink" href="/production/shop">Outside processing</Link> : a.kind === 'eng_at_risk' ? <Link className="nlink" href="/production/engineering">Drafting queue</Link> : null}</InlineNotice>)}
          </>
        )}
      </>}
      {tab === 'wip' && <>
        <BoardState b={wip} what="WIP" />
        {wip.data && (wip.data.length === 0 ? <Empty title="No open shop jobs" body="Jobs with production orders and Job financials show here: cost-to-cost percent complete, earned, billed, over / under." /> : (
          <>
            <div className="mp-table"><QueueTable aria-label="Shop WIP" columns={wipCols} rows={wip.data} getRowId={(r) => r.job_id} onOpen={(r) => { setJob(r.job_id); setTab('job'); }} openOnClick rowState={(r) => ({ attn: r.loss_job || (r.fade_pct != null && Number(r.fade_pct) > 0.02) })} /></div>
            {!readOnly && <Button disabled={busy === 'pin'} onClick={() => { const end = window.prompt('Pin WIP for the period ending (YYYY-MM-DD)', today); if (end) void run('pin', MONEY, { op: 'pin_wip', companyId, periodEnd: end }, (n: number) => `${n} job(s) pinned`); }}>Pin this month&apos;s WIP</Button>}
            <p className="t-cap">The shop&apos;s working view of WIP; Books books the WIP schedule from the same job cost.</p>
          </>
        ))}
      </>}
      {tab === 'job' && <>
        <Field label="Job"><Select value={job} onChange={(e) => setJob(e.target.value)}>{jobs.map((j) => <option key={j.id} value={j.id}>{j.label}</option>)}</Select></Field>
        <BoardState b={jc} what="Job cost" />
        {jc.data && (
          <Section title="Estimate vs committed vs actual" meta={`${m(jc.data.totals.estimate_cents)} estimate · ${m(jc.data.totals.committed_cents)} committed · ${m(jc.data.totals.actual_cents)} actual · remakes ${m(jc.data.cost_of_quality_cents)}`}>
            {jc.data.rows.length === 0 ? <p className="t-cap">No cost yet.</p> : <table className="ops-mini" aria-label="Job cost by area and bucket"><thead><tr><th>Area</th><th>Bucket</th><th className="n">Estimate</th><th className="n">Committed</th><th className="n">Actual</th><th className="n">Left</th></tr></thead>
              <tbody>{jc.data.rows.map((r, i) => <tr key={i}><td>{r.area}</td><td>{r.bucket.toLowerCase().replace(/_/g, ' ')}</td><td className="n">{m(r.estimate_cents)}</td><td className="n">{m(r.committed_cents)}</td><td className="n">{m(r.actual_cents)}</td><td className={Number(r.variance_cents) < 0 ? 'n neg' : 'n'}>{m(r.variance_cents)}</td></tr>)}</tbody></table>}
            <p className="t-cap">{jc.data.note}</p>
          </Section>
        )}
        <BoardState b={bill} what="Billing" />
        {bill.data && (
          <>
            <Section title="Stored materials" meta="Finished millwork stored off site bills in the stored-materials column; the delivery bills the rest">
              {bill.data.stored.length === 0 ? <p className="t-cap">Nothing stored.</p> : <table className="ops-mini" aria-label="Stored materials"><thead><tr><th><span className="sr">Pick</span></th><th>Stored</th><th>Where</th><th className="n">Value</th><th>Status</th></tr></thead>
                <tbody>{bill.data.stored.map((s) => <tr key={s.id}><td>{s.status === 'STORED' && !readOnly && <input type="checkbox" aria-label={`Bill ${s.description}`} checked={pick.includes(s.id)} onChange={(e) => setPick(e.target.checked ? [...pick, s.id] : pick.filter((x) => x !== s.id))} />}</td><td>{s.description}<div className="t-cap">{s.area ?? 'Job'} · {day(s.stored_on, today)}{s.insured ? ' · insured' : ''}</div></td><td>{s.stored_at}</td><td className="n">{m(s.value_cents)}</td><td>{s.status.toLowerCase()}</td></tr>)}</tbody></table>}
              {!readOnly && <>
                {pick.length > 0 && <Button variant="primary" disabled={busy === 'bs'} onClick={() => void run<{ amount_cents: number }>('bs', MONEY, { op: 'bill_stored', jobId: job, ids: pick }, (r) => `${m(r.amount_cents)} drafted for Books`).then(() => setPick([]))}>Bill {count(pick.length)} stored</Button>}
                <div className="ops-toolbar">
                  <Field label="What is stored"><Input value={stored.description} onChange={(e) => setStored({ ...stored, description: e.target.value })} /></Field>
                  <Field label="Where"><Input value={stored.at} onChange={(e) => setStored({ ...stored, at: e.target.value })} style={{ width: 140 }} /></Field>
                  <Field label="Value ($)"><Input inputMode="decimal" value={stored.value} onChange={(e) => setStored({ ...stored, value: e.target.value })} style={{ width: 110 }} /></Field>
                  <Field label="Area"><Select value={stored.wbsId} onChange={(e) => setStored({ ...stored, wbsId: e.target.value })}><option value="">Whole job</option>{areas.filter((a) => a.jobId === job).map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}</Select></Field>
                  <PhotoButton url="/api/mfg/uploads" label={`Photo${stored.photos.length ? ` (${stored.photos.length})` : ''}`} onFiled={(p) => setStored({ ...stored, photos: [...stored.photos, p] })} />
                  <Button disabled={!stored.description.trim() || !(centsFrom(stored.value) ?? 0) || busy === 'st'} onClick={() => void run('st', MONEY, { op: 'add_stored', jobId: job, description: stored.description.trim(), storedAt: stored.at || 'Shop', valueCents: centsFrom(stored.value), wbsId: stored.wbsId || null, insured: stored.insured, photoIds: stored.photos }, 'Stored material recorded').then(() => setStored({ ...stored, description: '', value: '', photos: [] }))}>Record</Button>
                </div>
              </>}
            </Section>
            <Section title="Billing on this job">
              {bill.data.requests.length + bill.data.deposits.length === 0 ? <p className="t-cap">No billing yet.</p> : <ul>
                {bill.data.deposits.map((d) => <li key={d.id}>Deposit · {d.memo} · {m(d.amount_cents)} · <span className="t-cap">{d.status.toLowerCase()}{d.invoice_number ? ` · ${d.invoice_number}` : ''}</span></li>)}
                {bill.data.requests.map((r) => <li key={r.id}>{r.memo ?? r.billing_type.toLowerCase()} · {m(r.net_cents)} · <span className="t-cap">{r.status.toLowerCase()} {day(r.occurred_on, today)}{r.invoice_number ? ` · ${r.invoice_number}` : ''}</span></li>)}
              </ul>}
              {bill.data.deliveries.filter((d) => d.status === 'DELIVERED' && !d.billing_request_id).map((d) => !readOnly && <Button key={d.id} disabled={busy === d.id} onClick={() => void run<{ amount_cents: number }>(d.id, MONEY, { op: 'bill_shipment', shipmentId: d.id }, (r) => `Delivery ${d.number}: ${m(r.amount_cents)} drafted`)}>Bill delivery {d.number}</Button>)}
            </Section>
          </>
        )}
      </>}
    </div>
  );
}

// ── installer phone (MFG-46 / MFG-47) ─────────────────────────────────────────────────────────────
interface Install { install_id: string; job_id: string; job: string; job_name: string; area: string | null; wbs_id: string | null; starts_on: string; ends_on: string; status: string; crew: string | null; site: string | null; open_punch: number; signed_off: boolean }
interface Punch { id: string; kind: string; title: string; status: string; room: string | null; area: string | null; responsible: string | null; photos: number; remake_id: string | null; backcharge_to: string | null; backcharge_status: string | null; backcharge_cents: number | null }

/** Today's installs on the phone: the job's current drawings, time by room, punch with photos and who is responsible, and the customer's sign-off. */
export function InstallerView({ companyId, today, orders }: { companyId: string; today: string; orders: Array<Opt & { jobId: string }> }) {
  const { readOnly } = useShell();
  const [d, setD] = useState(today);
  const h = useBoard<{ installs: Install[] }>(`/api/mfg/installer?view=home&company=${companyId}&day=${d}`);
  const [cur, setCur] = useState<Install | null>(null);
  return (
    <div className="stack">
      <div className="ops-toolbar"><Field label="Day"><Input type="date" value={d} onChange={(e) => setD(e.target.value)} /></Field></div>
      <BoardState b={h} what="Installs" />
      {h.data && !cur && (h.data.installs.length === 0 ? <Empty title="No installs today" body="Installs your crew is booked on show here around their dates." /> : h.data.installs.map((i) => (
        <button key={i.install_id} type="button" className="ops-card" onClick={() => setCur(i)} style={{ textAlign: 'left', width: '100%' }}>
          <span className="l1">{i.job} · {i.job_name}{i.area ? ` · ${i.area}` : ''}</span>
          <span className="l2">{i.site ?? 'Site address on the job'} · {day(i.starts_on, today)}–{day(i.ends_on, today)} · {i.crew ?? ''} · {count(i.open_punch)} open punch{i.signed_off ? ' · signed off' : ''}</span>
        </button>
      )))}
      {cur && <InstallCard install={cur} today={today} readOnly={readOnly} orders={orders.filter((o) => o.jobId === cur.job_id)} onBack={() => { setCur(null); h.reload(); }} />}
    </div>
  );
}

function InstallCard({ install, today, readOnly, orders, onBack }: { install: Install; today: string; readOnly: boolean; orders: Opt[]; onBack: () => void }) {
  const punch = useBoard<Punch[]>(`/api/mfg/installer?view=punch&job=${install.job_id}`);
  const sheets = useBoard<Array<{ sheet_id: string; sheet_number: string; title: string | null; revision_label: string | null }>>(`/api/mfg/installer?view=sheets&job=${install.job_id}`);
  const { run, busy, error } = useDo(punch.reload);
  const [time, setTime] = useState({ hours: '', room: '' });
  const [p, setP] = useState({ title: '', room: '', responsible: 'INSTALL', partIssue: '', woId: orders[0]?.id ?? '', photos: [] as string[] });
  const [bc, setBc] = useState<{ id: string; amount: string } | null>(null);
  const [so, setSo] = useState({ signer: '', sig: '', photos: [] as string[], notes: '' });
  return (
    <div className="stack">
      {error && <Failure text={error} />}
      <ButtonRow><Button variant="quiet" onClick={onBack}>All installs</Button></ButtonRow>
      <Section title={`${install.job} · ${install.area ?? install.job_name}`} meta={install.site ?? undefined}>
        <BoardState b={sheets} what="Drawings" />
        {sheets.data && (sheets.data.length === 0 ? <p className="t-cap">No drawings on the job.</p> : <ul>{sheets.data.map((s) => <li key={s.sheet_id}><Link className="nlink" href={`/documents/drawings/${s.sheet_id}`}>{s.sheet_number} rev {s.revision_label ?? '—'}</Link> {s.title}</li>)}</ul>)}
        <p className="t-cap">Only the current revision of each sheet is shown.</p>
      </Section>
      {!readOnly && (
        <Section title="Time">
          <ButtonRow>
            <Field label="Hours"><Input inputMode="decimal" value={time.hours} onChange={(e) => setTime({ ...time, hours: e.target.value })} style={{ width: 80 }} /></Field>
            <Field label="Room"><Input value={time.room} onChange={(e) => setTime({ ...time, room: e.target.value })} style={{ width: 140 }} /></Field>
            <Button disabled={!(Number(time.hours) > 0) || busy === 't'} onClick={() => void run('t', '/api/mfg/installer', { op: 'log_time', installId: install.install_id, hours: Number(time.hours), room: time.room || null }, 'Time submitted').then(() => setTime({ hours: '', room: time.room }))}>Log</Button>
          </ButtonRow>
        </Section>
      )}
      <Section title="Punch" meta={punch.data ? `${count(punch.data.filter((x) => x.status === 'OPEN' || x.status === 'IN_PROGRESS').length)} open` : undefined}>
        <BoardState b={punch} what="Punch" />
        {punch.data && punch.data.length > 0 && <ul>{punch.data.map((x) => <li key={x.id}>{x.title} · <span className="t-cap">{[x.room ?? x.area, x.responsible?.toLowerCase(), x.status.toLowerCase(), x.photos ? `${x.photos} photos` : null, x.remake_id ? 'remake requested' : null, x.backcharge_status ? `back-charge ${x.backcharge_status.toLowerCase()} ${m(x.backcharge_cents)}` : null].filter(Boolean).join(' · ')}</span>
          {!readOnly && (x.responsible === 'GC' || x.responsible === 'VENDOR') && !x.backcharge_status && <Button variant="quiet" onClick={() => setBc({ id: x.id, amount: '' })}>Back-charge</Button>}</li>)}</ul>}
        {bc && (
          <ButtonRow>
            <Field label="Back-charge ($)"><Input inputMode="decimal" value={bc.amount} onChange={(e) => setBc({ ...bc, amount: e.target.value })} style={{ width: 110 }} /></Field>
            <Button disabled={!(centsFrom(bc.amount) ?? 0) || busy === 'bc'} onClick={() => void run('bc', '/api/mfg/installer', { op: 'backcharge', punchId: bc.id, to: 'GC', amountCents: centsFrom(bc.amount) }, 'Back-charge drafted for Books').then(() => setBc(null))}>Bill the GC</Button>
            <Button variant="quiet" onClick={() => setBc(null)}>Cancel</Button>
          </ButtonRow>
        )}
        {!readOnly && (
          <div className="stack">
            <div className="ops-toolbar">
              <Field label="Punch item"><Input value={p.title} onChange={(e) => setP({ ...p, title: e.target.value })} /></Field>
              <Field label="Room"><Input value={p.room} onChange={(e) => setP({ ...p, room: e.target.value })} style={{ width: 120 }} /></Field>
              <Field label="Responsible"><Select value={p.responsible} onChange={(e) => setP({ ...p, responsible: e.target.value })}><option value="INSTALL">Install crew</option><option value="SHOP">Shop</option><option value="GC">GC / other trade</option><option value="VENDOR">Vendor</option><option value="DESIGN">Design</option><option value="CUSTOMER">Customer</option></Select></Field>
              <Field label="Part"><Select value={p.partIssue} onChange={(e) => setP({ ...p, partIssue: e.target.value })}><option value="">No part issue</option><option value="MISSING">Missing part</option><option value="DAMAGED">Damaged part</option></Select></Field>
              {p.partIssue && <Field label="Order"><Select value={p.woId} onChange={(e) => setP({ ...p, woId: e.target.value })}>{orders.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</Select></Field>}
              <PhotoButton url="/api/mfg/uploads" label={`Photo${p.photos.length ? ` (${p.photos.length})` : ''}`} onFiled={(x) => setP({ ...p, photos: [...p.photos, x] })} />
            </div>
            <Button disabled={!p.title.trim() || busy === 'p'} onClick={() => void run('p', '/api/mfg/installer', { op: 'add_punch', jobId: install.job_id, wbsId: install.wbs_id, title: p.title.trim(), room: p.room || null, responsible: p.responsible, partIssue: p.partIssue || null, workOrderId: p.partIssue ? p.woId || null : null, photoIds: p.photos }, p.partIssue ? 'Punch added; a remake is requested' : 'Punch added').then(() => setP({ ...p, title: '', photos: [], partIssue: '' }))}>Add to punch</Button>
          </div>
        )}
      </Section>
      {!readOnly && !install.signed_off && (
        <Section title="Customer sign-off">
          <Field label="Customer name"><Input value={so.signer} onChange={(e) => setSo({ ...so, signer: e.target.value })} /></Field>
          <SignaturePad url="/api/mfg/uploads" onFiled={(sig) => setSo({ ...so, sig })} />
          <PhotoButton url="/api/mfg/uploads" label={`Finished photo${so.photos.length ? ` (${so.photos.length})` : ''}`} onFiled={(x) => setSo({ ...so, photos: [...so.photos, x] })} />
          <Field label="Notes"><Textarea rows={2} value={so.notes} onChange={(e) => setSo({ ...so, notes: e.target.value })} /></Field>
          <Button variant="primary" disabled={!so.signer.trim() || busy === 'so'} onClick={() => void run<{ open_punch: number }>('so', '/api/mfg/installer', { op: 'signoff', installId: install.install_id, signer: so.signer.trim(), signatureDocumentId: so.sig || null, photoIds: so.photos, notes: so.notes || null }, (r) => `Signed off${r.open_punch ? ` with ${r.open_punch} open punch item(s)` : ''}`).then(onBack)}>Signed off</Button>
          <p className="t-cap">Warranty calls later open against this job from the punch list (kind warranty).</p>
        </Section>
      )}
    </div>
  );
}

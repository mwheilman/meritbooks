'use client';

import { useState } from 'react';
import { Button, Field, Figure, InlineNotice, Input, Select, Status, money, type StatusKind } from '@meritbooks/merit-ui';
import { useShell } from '@/components/shell/ShellContext';
import { Failure, Section, parseNum } from '@/components/ops/common/bits';
import { BoardState, Empty, FilePick, centsFrom, day, pctText, qty, useBoard, useDo } from '@/components/dealer/common/depth';
import { DEV_IMPORT_KINDS, type DevImportKind } from '@/lib/development/import';

interface Condition { id: string; condition: string; due_on: string | null; status: 'OPEN' | 'MET' | 'WAIVED'; owner: string | null }
interface Entitlement { id: string; kind: string; name: string; authority: string | null; reference: string | null; status: string; target_on: string | null; hearing_on: string | null; approved_on: string | null; expires_on: string | null; conditions: Condition[] }
interface Incentive { id: string; kind: string; name: string; authority: string | null; amount_cents?: number | null; term_years: number | null; status: string; approved_on: string | null }
interface Interest { reserve_cents: number; used_cents: number; remaining_cents: number; projected_monthly_cents: number | null; months_to_completion: number | null; shortfall_cents: number | null; runway_months: number | null; capitalized_total_cents: number; completion_basis_on: string | null }
interface Fee { fee_id: string; kind: string; earn_basis: string; total_cents: number; earned_pct: number | null; earned_cents: number; drawn_cents: number; available_cents: number; remaining_cents: number }
interface DrawTrack { draw_id: string; draw_number: number; status: string; period_end: string; requested_cents: number | null; approved_cents: number | null; funded_cents: number | null; disbursed_cents: number; direct_via_title_cents: number; cycle_days: number | null; first_pass: boolean;
  by_source: Array<{ source: string; approved_cents: number | null; funded_cents: number | null; adjustment_reason: string | null; title_date_down_on: string | null }> }
interface Covenant { id: string; kind: string; name: string; party: string; frequency: string; comparator: string | null; threshold: number | null; next_due_on: string; last_value: number | null; last_tested_on: string | null; status: string }
interface Vendor { vendor_id: string; vendor: string; commitments: number; coi: { status: string; expires_on: string | null; additional_insured: boolean } | null; w9: boolean; hold: boolean; expiring_in_30: boolean }
interface Tieout { available: boolean; reason?: string; projects_cost_cents: number; projects_drawn_cents: number; books_cip_cents?: number; difference_cents?: number; ties?: boolean }
interface Imp { id: string; kind: string; file_name: string | null; status: string; result: Record<string, unknown> | null; created_at: string }
interface Data {
  money: boolean;
  entitlements: { entitlements: Entitlement[]; incentives: Incentive[]; open_conditions: number };
  statusEvents: Array<{ id: string; kind: string; effective_on: string; note: string | null }>;
  folders: Array<{ id: string; key: string | null; name: string }>;
  interest?: Interest; fees?: { fees: Fee[] }; tracking?: { draws: DrawTrack[]; avg_cycle_days: number | null; first_pass_rate: number | null }; tieout?: Tieout;
  compliance?: { vendors: Vendor[]; on_hold: number } | null; covenants?: Covenant[]; affiliate?: Array<{ id: string; amount_cents: number; memo: string | null; status: string; approved_at: string | null }>; imports?: Imp[];
}

const STATUS_EVENTS = [['START', 'Construction started'], ['SUSPEND', 'Work suspended'], ['RESUME', 'Work resumed'], ['SUBSTANTIAL_COMPLETION', 'Substantial completion'], ['FINAL_COMPLETION', 'Final completion']] as const;
const COV_KINDS = ['DSCR', 'LTV', 'DEBT_YIELD', 'MIN_LIQUIDITY', 'NET_WORTH', 'REPORTING', 'INSURANCE', 'OTHER'] as const;
const IMPORT_LABEL: Record<DevImportKind, string> = { PRO_FORMA: 'Pro forma', BUDGET: 'Budget', DRAWS: 'Draw history', WAIVERS: 'Lien waivers' };

/** One SPE's oversight: entitlements and incentives (RED-05), status (RED-31), document room, then — with job financials — interest reserve (RED-15), fees (RED-16), covenants (RED-06), vendor compliance (RED-20), draws (RED-29), affiliate bills (RED-42), migration and the Books tie-out (RED-44). */
export function Oversight({ jobId, today }: { jobId: string; today: string }) {
  const { readOnly } = useShell();
  const url = `/api/development/jobs/${jobId}/oversight`;
  const b = useBoard<Data>(url);
  const { run, busy, error } = useDo(b.reload);
  const [cond, setCond] = useState<Record<string, string>>({});
  const [ev, setEv] = useState<{ kind: string; on: string; note: string }>({ kind: 'START', on: today, note: '' });
  const [inc, setInc] = useState({ kind: 'TIF', name: '', authority: '', amount: '' });
  const [cov, setCov] = useState({ kind: 'DSCR', name: '', comparator: '>=', threshold: '', due: '' });
  const [test, setTest] = useState<Record<string, string>>({});
  const [interest, setInterest] = useState({ month: `${today.slice(0, 7)}-01`, amount: '' });
  const [feeAmt, setFeeAmt] = useState<Record<string, string>>({});
  const [impKind, setImpKind] = useState<DevImportKind>('BUDGET');
  const state = <BoardState b={b} what="Oversight" />;
  if (!b.data) return state;
  const d = b.data;
  const post = (key: string, body: Record<string, unknown>, ok: string | null) => run(key, url, body, ok);
  return (
    <div className="stack">
      {error && <Failure text={error} />}
      {d.money && d.tieout && d.tieout.available && d.tieout.ties === false && <InlineNotice tone="warn" title="Projects and Books do not tie.">Paid cost {money(d.tieout.projects_cost_cents)} vs. construction in progress {money(d.tieout.books_cip_cents ?? 0)} — off by {money(d.tieout.difference_cents ?? 0)}.</InlineNotice>}
      {d.money && d.interest && (d.interest.shortfall_cents ?? 0) > 0 && <InlineNotice tone="warn" title="The interest reserve runs out before completion.">Short {money(d.interest.shortfall_cents ?? 0, { decimals: 0 })} at the current monthly interest.</InlineNotice>}

      <Section title="Entitlements and permits" meta={`${d.entitlements.open_conditions} open condition(s)`}>
        {d.entitlements.entitlements.length === 0 ? <Empty title="No entitlements yet" body="Add zoning, site plan and permit applications on the project; their conditions of approval are tracked here." /> :
          <ul className="ops-agenda">{d.entitlements.entitlements.map((e) => (
            <li key={e.id}><span className="d">{day(e.hearing_on ?? e.target_on, today)}</span>
              <div className="stack">
                <span><b>{e.name}</b> · {e.authority ?? e.kind.toLowerCase()} {e.reference ? `#${e.reference}` : ''} · <Status kind={e.status === 'APPROVED' ? 'ready' : 'track'} pip="open">{e.status.toLowerCase().replace(/_/g, ' ')}</Status>{e.expires_on && <span className="l2"> · expires {day(e.expires_on, today)}</span>}</span>
                {e.conditions.map((c) => <span key={c.id} className="l2">{c.condition} · {c.owner ?? 'no owner'} · due {day(c.due_on, today)} · {readOnly ? c.status.toLowerCase() :
                  <Select aria-label="Condition status" value={c.status} onChange={(x) => post(`c${c.id}`, { op: 'condition_status', conditionId: c.id, status: x.target.value }, null)}>{['OPEN', 'MET', 'WAIVED'].map((s) => <option key={s} value={s}>{s.toLowerCase()}</option>)}</Select>}</span>)}
                {!readOnly && <span className="btn-row"><Input aria-label="New condition" placeholder="Condition of approval" value={cond[e.id] ?? ''} onChange={(x) => setCond({ ...cond, [e.id]: x.target.value })} />
                  <Button disabled={!(cond[e.id] ?? '').trim() || busy === `n${e.id}`} onClick={async () => { const r = await post(`n${e.id}`, { op: 'condition', entitlementId: e.id, condition: cond[e.id] }, 'Condition added'); if (r) setCond({ ...cond, [e.id]: '' }); }}>Add condition</Button></span>}
              </div></li>))}</ul>}
        <h4 className="l1">Incentives</h4>
        {d.entitlements.incentives.length === 0 ? <p className="l2">No TIF, abatement, grant or tax-credit agreements.</p> :
          <table className="ops-mini" aria-label="Incentives"><tbody>{d.entitlements.incentives.map((i) => <tr key={i.id}><td>{i.kind}</td><td>{i.name}</td><td>{i.authority ?? '—'}</td>
            <td className="n">{i.amount_cents == null ? '—' : money(i.amount_cents, { decimals: 0 })}</td><td>{i.term_years ? `${i.term_years} yr` : ''}</td>
            <td>{readOnly || !d.money ? i.status.toLowerCase() : <Select aria-label="Incentive status" value={i.status} onChange={(x) => post(`i${i.id}`, { op: 'incentive', incentiveId: i.id, fields: { status: x.target.value } }, null)}>
              {['PURSUING', 'APPLIED', 'APPROVED', 'EXECUTED', 'DENIED', 'EXPIRED'].map((s) => <option key={s} value={s}>{s.toLowerCase()}</option>)}</Select>}</td></tr>)}</tbody></table>}
        {!readOnly && d.money && <div className="ops-toolbar">
          <Field label="Kind"><Select value={inc.kind} onChange={(x) => setInc({ ...inc, kind: x.target.value })}>{['TIF', 'ABATEMENT', 'GRANT', 'TAX_CREDIT', 'OTHER'].map((k) => <option key={k} value={k}>{k.replace('_', ' ')}</option>)}</Select></Field>
          <Field label="Name"><Input value={inc.name} onChange={(x) => setInc({ ...inc, name: x.target.value })} /></Field>
          <Field label="Authority"><Input value={inc.authority} onChange={(x) => setInc({ ...inc, authority: x.target.value })} /></Field>
          <Field label="Amount" error={inc.amount && centsFrom(inc.amount) == null ? 'Dollars' : undefined}><Input value={inc.amount} style={{ width: 120 }} onChange={(x) => setInc({ ...inc, amount: x.target.value })} /></Field>
          <Button disabled={!inc.name.trim() || (!!inc.amount && centsFrom(inc.amount) == null) || busy === 'inc'} onClick={async () => {
            const r = await post('inc', { op: 'incentive', fields: { kind: inc.kind, name: inc.name.trim(), authority: inc.authority || null, amount_cents: inc.amount ? centsFrom(inc.amount) : null } }, 'Incentive added');
            if (r) setInc({ kind: 'TIF', name: '', authority: '', amount: '' });
          }}>Add incentive</Button></div>}
      </Section>

      <Section title="Construction status" meta="Start, suspension and completion — they drive interest capitalization and the lender report">
        {d.statusEvents.length > 0 && <ul className="ops-agenda">{d.statusEvents.map((s) => <li key={s.id}><span className="d">{day(s.effective_on, today)}</span><span>{STATUS_EVENTS.find((x) => x[0] === s.kind)?.[1] ?? s.kind}{s.note ? ` — ${s.note}` : ''}</span></li>)}</ul>}
        {!readOnly && <div className="ops-toolbar">
          <Field label="What happened"><Select value={ev.kind} onChange={(x) => setEv({ ...ev, kind: x.target.value })}>{STATUS_EVENTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
          <Field label="Effective"><Input type="date" value={ev.on} onChange={(x) => setEv({ ...ev, on: x.target.value })} /></Field>
          <Field label="Note"><Input value={ev.note} onChange={(x) => setEv({ ...ev, note: x.target.value })} /></Field>
          <Button disabled={!/^\d{4}-\d{2}-\d{2}$/.test(ev.on) || busy === 'ev'} onClick={() => post('ev', { op: 'status_event', kind: ev.kind, effectiveOn: ev.on, note: ev.note || null }, 'Recorded')}>Record</Button></div>}
      </Section>

      <Section title="Document room" meta="One set of folders per SPE; share a folder with the lender or investors"
        actions={readOnly ? null : <Button disabled={busy === 'dr'} onClick={() => post('dr', { op: 'doc_room' }, null)}>Add the standard folders</Button>}>
        {d.folders.length === 0 ? <Empty title="No folders yet" body="Add the standard set: PSA, operating agreement, loan documents, title, survey, contracts, permits, plans, insurance, investor reports." /> :
          <table className="ops-mini" aria-label="Folders"><tbody>{d.folders.map((f) => <tr key={f.id}><td>{f.name}</td><td>{readOnly ? null : <span className="btn-row">
            <Button disabled={busy === `l${f.id}`} onClick={() => run(`l${f.id}`, url, { op: 'share_folder', folderId: f.id, audiences: ['lender'] }, (r: { shared: number; skipped: number }) => `${r.shared} shared with the lender${r.skipped ? `, ${r.skipped} held back` : ''}`)}>Share with lender</Button>
            <Button disabled={busy === `v${f.id}`} onClick={() => run(`v${f.id}`, url, { op: 'share_folder', folderId: f.id, audiences: ['investor'] }, (r: { shared: number; skipped: number }) => `${r.shared} shared with investors${r.skipped ? `, ${r.skipped} held back (cost documents)` : ''}`)}>Share with investors</Button></span>}</td></tr>)}</tbody></table>}
      </Section>

      {!d.money ? <InlineNotice tone="info" title="Money sections need job financials.">Interest, fees, covenants, draws and the Books tie-out show to people who can see this project’s financials.</InlineNotice> : <>
        {d.interest && <Section title="Interest reserve" meta={d.interest.completion_basis_on ? `To completion ${day(d.interest.completion_basis_on, today)}` : 'No completion date yet'}>
          <div className="dl-strip">
            <Figure dense label="Reserve left" value={money(d.interest.remaining_cents, { decimals: 0 })} vs={[`of ${money(d.interest.reserve_cents, { decimals: 0 })}`, `used ${money(d.interest.used_cents, { decimals: 0 })}`]} href={`/development/${jobId}`} linkLabel="Budget" />
            <Figure dense label="Runway" value={d.interest.runway_months == null ? '—' : `${qty(d.interest.runway_months)} mo`} vs={[`${d.interest.months_to_completion ?? '—'} mo to completion`, d.interest.projected_monthly_cents == null ? 'no monthly yet' : `${money(d.interest.projected_monthly_cents, { decimals: 0 })} / mo`]} href={`/development/${jobId}`} linkLabel="Project" />
            <Figure dense label="Capitalized" value={money(d.interest.capitalized_total_cents, { decimals: 0 })} vs={['to date', 'by month below']} href={`/development/${jobId}`} linkLabel="Project" />
          </div>
          {!readOnly && <div className="ops-toolbar">
            <Field label="Month"><Input type="date" value={interest.month} onChange={(x) => setInterest({ ...interest, month: x.target.value })} /></Field>
            <Field label="Interest (lender statement)" error={interest.amount && centsFrom(interest.amount) == null ? 'Dollars' : undefined}><Input value={interest.amount} style={{ width: 120 }} onChange={(x) => setInterest({ ...interest, amount: x.target.value })} /></Field>
            <Button disabled={centsFrom(interest.amount) == null || busy === 'int'} onClick={async () => { const r = await post('int', { op: 'interest', month: interest.month, interestCents: centsFrom(interest.amount) }, 'Recorded'); if (r) setInterest({ ...interest, amount: '' }); }}>Record interest</Button></div>}
        </Section>}

        {d.fees && <Section title="Developer and CM fees" meta="Earned vs. drawn; a draw becomes an intercompany fee invoice in Books">
          {d.fees.fees.length === 0 ? <Empty title="No fee schedules" body="Set the developer fee, CM fee or asset-management fee and how it is earned." /> :
            <table className="ops-mini" aria-label="Fees"><thead><tr><th>Fee</th><th className="n">Total</th><th className="n">Earned</th><th className="n">Drawn</th><th className="n">Available</th><th /></tr></thead>
              <tbody>{d.fees.fees.map((f) => <tr key={f.fee_id}><td>{f.kind.toLowerCase().replace(/_/g, ' ')} · {f.earn_basis.toLowerCase().replace(/_/g, ' ')}</td><td className="n">{money(f.total_cents, { decimals: 0 })}</td>
                <td className="n">{money(f.earned_cents, { decimals: 0 })} {f.earned_pct != null && <span className="l2">{pctText(f.earned_pct, 0)}</span>}</td><td className="n">{money(f.drawn_cents, { decimals: 0 })}</td><td className="n">{money(f.available_cents, { decimals: 0 })}</td>
                <td>{!readOnly && f.available_cents > 0 && <span className="btn-row"><Input aria-label="Draw amount" style={{ width: 100 }} value={feeAmt[f.fee_id] ?? ''} onChange={(x) => setFeeAmt({ ...feeAmt, [f.fee_id]: x.target.value })} />
                  <Button disabled={centsFrom(feeAmt[f.fee_id] ?? '') == null || (centsFrom(feeAmt[f.fee_id] ?? '') ?? 0) > f.available_cents || busy === `f${f.fee_id}`} onClick={() => post(`f${f.fee_id}`, { op: 'fee_draw', feeId: f.fee_id, amountCents: centsFrom(feeAmt[f.fee_id] ?? '') }, 'Fee draw requested')}>Draw</Button></span>}</td></tr>)}</tbody></table>}
        </Section>}

        <Section title="Covenants" meta="Lender and investor tests with reminders ahead of each due date">
          {(d.covenants ?? []).length === 0 ? <Empty title="No covenants" body="Add DSCR, LTV, liquidity, reporting and insurance covenants from the loan and operating agreements." /> :
            <table className="ops-mini" aria-label="Covenants"><thead><tr><th>Covenant</th><th>Test</th><th>Next due</th><th>Last</th><th>Status</th><th /></tr></thead>
              <tbody>{(d.covenants ?? []).map((c) => { const k: StatusKind = c.status === 'BREACH' ? 'overdue' : c.next_due_on < today ? 'risk' : 'ready'; return <tr key={c.id}><td>{c.name} <span className="l2">{c.party.toLowerCase()}</span></td>
                <td>{c.comparator && c.threshold != null ? `${c.kind} ${c.comparator} ${c.threshold}` : c.kind.toLowerCase()}</td><td>{day(c.next_due_on, today)}</td><td>{c.last_value ?? '—'} {c.last_tested_on && <span className="l2">{day(c.last_tested_on, today)}</span>}</td>
                <td><Status kind={k} pip="open">{c.status.toLowerCase()}</Status></td>
                <td>{!readOnly && <span className="btn-row"><Input aria-label="Tested value" style={{ width: 80 }} value={test[c.id] ?? ''} onChange={(x) => setTest({ ...test, [c.id]: x.target.value })} />
                  <Button disabled={busy === `t${c.id}` || (!!(test[c.id] ?? '') && parseNum(test[c.id] ?? '') == null)} onClick={() => post(`t${c.id}`, { op: 'covenant_test', covenantId: c.id, value: parseNum(test[c.id] ?? '') }, 'Tested')}>Test</Button></span>}</td></tr>; })}</tbody></table>}
          {!readOnly && <div className="ops-toolbar">
            <Field label="Kind"><Select value={cov.kind} onChange={(x) => setCov({ ...cov, kind: x.target.value })}>{COV_KINDS.map((k) => <option key={k} value={k}>{k.replace('_', ' ')}</option>)}</Select></Field>
            <Field label="Name"><Input value={cov.name} onChange={(x) => setCov({ ...cov, name: x.target.value })} placeholder="Minimum DSCR" /></Field>
            <Field label="Test"><span className="btn-row"><Select aria-label="Comparator" value={cov.comparator} onChange={(x) => setCov({ ...cov, comparator: x.target.value })}><option value=">=">at least</option><option value="<=">at most</option></Select>
              <Input aria-label="Threshold" style={{ width: 80 }} value={cov.threshold} onChange={(x) => setCov({ ...cov, threshold: x.target.value })} /></span></Field>
            <Field label="First due"><Input type="date" value={cov.due} onChange={(x) => setCov({ ...cov, due: x.target.value })} /></Field>
            <Button disabled={!cov.name.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(cov.due) || (!!cov.threshold && parseNum(cov.threshold) == null) || busy === 'cov'} onClick={async () => {
              const r = await post('cov', { op: 'covenant', fields: { kind: cov.kind, name: cov.name.trim(), party: 'LENDER', frequency: 'QUARTERLY', comparator: cov.threshold ? cov.comparator : null, threshold: parseNum(cov.threshold), next_due_on: cov.due } }, 'Covenant added');
              if (r) setCov({ kind: 'DSCR', name: '', comparator: '>=', threshold: '', due: '' });
            }}>Add covenant</Button></div>}
        </Section>

        {d.compliance && <Section title="Vendor compliance" meta={`${d.compliance.on_hold} on payment hold`}>
          {d.compliance.vendors.length === 0 ? <p className="l2">No vendors on this project yet.</p> :
            <table className="ops-mini" aria-label="Vendor compliance"><thead><tr><th>Vendor</th><th>COI</th><th>W-9</th><th>Pay</th></tr></thead>
              <tbody>{d.compliance.vendors.map((v) => <tr key={v.vendor_id}><td>{v.vendor}</td><td>{v.coi ? `${v.coi.status.toLowerCase()} · ${day(v.coi.expires_on, today)}${v.coi.additional_insured ? ' · AI' : ''}` : 'missing'}{v.expiring_in_30 && <span className="l2 neg"> expiring</span>}</td>
                <td>{v.w9 ? 'on file' : 'missing'}</td><td>{v.hold ? <Status kind="blocked" pip="closed">Hold</Status> : <Status kind="ready" pip="ready">OK</Status>}</td></tr>)}</tbody></table>}
        </Section>}

        {d.tracking && <Section title="Draws" meta={`${d.tracking.avg_cycle_days == null ? '—' : `${d.tracking.avg_cycle_days} d`} average cycle · ${pctText(d.tracking.first_pass_rate, 0)} approved first pass`}>
          {d.tracking.draws.length === 0 ? <p className="l2">No draws yet.</p> :
            <table className="ops-mini" aria-label="Draw tracking"><thead><tr><th>Draw</th><th>Status</th><th className="n">Requested</th><th className="n">Approved</th><th className="n">Funded</th><th className="n">Disbursed</th><th>Cycle</th></tr></thead>
              <tbody>{d.tracking.draws.map((r) => <tr key={r.draw_id}><td><a href={`/development/draws/${r.draw_id}`}>#{r.draw_number}</a> <span className="l2">{day(r.period_end, today)}</span></td><td>{r.status.toLowerCase()}</td>
                <td className="n">{r.requested_cents == null ? '—' : money(r.requested_cents, { decimals: 0 })}</td><td className="n">{r.approved_cents == null ? '—' : money(r.approved_cents, { decimals: 0 })}</td>
                <td className="n">{r.funded_cents == null ? '—' : money(r.funded_cents, { decimals: 0 })}</td><td className="n">{money(r.disbursed_cents, { decimals: 0 })}</td><td>{r.cycle_days == null ? '—' : `${r.cycle_days} d`}{!r.first_pass && <span className="l2"> returned</span>}</td></tr>)}</tbody></table>}
        </Section>}

        {(d.affiliate ?? []).length > 0 && <Section title="Affiliated GC bills" meta="The related GC bills the SPE; approval is never by the preparer">
          <table className="ops-mini" aria-label="Affiliate bills"><tbody>{(d.affiliate ?? []).map((a) => <tr key={a.id}><td>{a.memo ?? 'GC bill'}</td><td className="n">{money(a.amount_cents)}</td><td>{a.status.toLowerCase()}</td>
            <td>{!readOnly && a.status === 'DRAFT' && <Button disabled={busy === `af${a.id}`} onClick={() => post(`af${a.id}`, { op: 'affiliate_approve', billId: a.id }, 'Approved')}>Approve</Button>}</td></tr>)}</tbody></table>
        </Section>}

        <Section title="Bring in history" meta="Pro forma, budget, draw history or lien waivers from a spreadsheet">
          {!readOnly && <div className="ops-toolbar">
            <Field label="What it is"><Select value={impKind} onChange={(x) => setImpKind(x.target.value as DevImportKind)}>{DEV_IMPORT_KINDS.map((k) => <option key={k} value={k}>{IMPORT_LABEL[k]}</option>)}</Select></Field>
            <FilePick label="Choose a CSV" accept=".csv,.txt,.tsv" disabled={busy === 'imp'} onText={(name, text) => { void run('imp', url, { op: 'import_stage', kind: impKind, fileName: name, text }, (r: { rows?: number; issues?: unknown[] }) => `Staged${r.rows != null ? ` ${r.rows} rows` : ''}`); }} />
          </div>}
          {(d.imports ?? []).length === 0 ? <p className="l2">Nothing imported.</p> :
            <table className="ops-mini" aria-label="Imports"><tbody>{(d.imports ?? []).map((i) => <tr key={i.id}><td>{IMPORT_LABEL[i.kind as DevImportKind] ?? i.kind}</td><td>{i.file_name}</td><td>{i.status.toLowerCase()}</td><td>{day(i.created_at, today)}</td>
              <td>{!readOnly && i.status === 'STAGED' && <Button disabled={busy === `ap${i.id}`} onClick={() => post(`ap${i.id}`, { op: 'import_apply', importId: i.id }, 'Applied')}>Apply</Button>}</td></tr>)}</tbody></table>}
          {d.tieout && <p className="l2">{d.tieout.available ? `Books CIP ${money(d.tieout.books_cip_cents ?? 0)} vs. paid cost ${money(d.tieout.projects_cost_cents)} — ${d.tieout.ties ? 'ties' : `off by ${money(d.tieout.difference_cents ?? 0)}`}` : `Books tie-out not available${d.tieout.reason ? '' : ' — Books is not connected'}. Paid cost ${money(d.tieout.projects_cost_cents)}, drawn ${money(d.tieout.projects_drawn_cents)}.`}</p>}
        </Section>
      </>}
    </div>
  );
}

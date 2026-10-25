'use client';

import Link from 'next/link';
import { Button, Tag, money, pct, shortDate, useQuery } from '@meritbooks/merit-ui';
import { useMoneyVis } from '@/components/shell/ShellContext';
import { useAction } from '@/components/job/useAction';
import { Loaded, Sec, num, words } from './common';

/**
 * Commercial job tabs (1120) the job page renders from /api/commercial/*: labor productivity,
 * the buyout log, closeout and the close gate, safety (toolbox talks, JHAs, incidents) with
 * inspections and observations. Each read is the caller's own RLS; money follows the shell.
 */

interface ProductivityRow {
  cost_code_id: string; cost_code: string | null; cost_code_name: string | null; uom: string | null;
  budget_qty: number | null; budget_hours: number | null; installed_qty: number | null; pct_complete: number | null;
  earned_hours: number | null; actual_hours: number | null; productivity_factor: number | null; projected_hours: number | null; variance_hours: number | null;
}

export function ProductivityTab({ jobId }: { jobId: string }) {
  const q = useQuery<{ rows: ProductivityRow[] }>('/api/commercial/productivity', { jobId }, { scope: false });
  return (
    <Sec title="Labor productivity" meta="Earned hours (installed quantity × budget unit hours) against hours used, by cost code">
      <Loaded q={q} what="productivity" empty={(d) => (d.rows.length ? null : { title: 'No quantities to measure yet', body: 'Budget hours and quantities by cost code, and installed quantities from the field, fill this grid.' })}>
        {(d) => (
          <div className="mp-table">
            <table className="tbl-q">
              <thead><tr><th>Cost code</th><th className="n">Installed</th><th className="n">% complete</th><th className="n">Earned h</th><th className="n">Actual h</th><th className="n">Factor</th><th className="n">Projected h</th><th className="n">Over / under</th></tr></thead>
              <tbody>
                {d.rows.map((r) => {
                  const behind = (r.productivity_factor ?? 1) < 0.95;
                  return (
                    <tr key={r.cost_code_id}>
                      <td><span className="code">{r.cost_code}</span> {r.cost_code_name}</td>
                      <td className="n tnum">{num(r.installed_qty)} {r.uom ?? ''}</td>
                      <td className="n tnum">{r.pct_complete == null ? '—' : pct(r.pct_complete)}</td>
                      <td className="n tnum">{num(r.earned_hours)}</td>
                      <td className="n tnum">{num(r.actual_hours)}</td>
                      <td className={behind ? 'n tnum neg' : 'n tnum'}>{num(r.productivity_factor, 2)}</td>
                      <td className="n tnum">{num(r.projected_hours)}</td>
                      <td className={(r.variance_hours ?? 0) < 0 ? 'n tnum neg' : 'n tnum'}>{num(r.variance_hours)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Loaded>
    </Sec>
  );
}

interface BuyoutRow { package_id: string; name: string; csi_division: string | null; status: string; budget_cents: number | null; committed_cents: number | null; need_by: string | null; days_to_need: number | null }

export function BuyoutTab({ jobId, canSeed }: { jobId: string; canSeed: boolean }) {
  const mv = useMoneyVis();
  const { run, busy } = useAction();
  const q = useQuery<{ packages: BuyoutRow[] }>('/api/commercial/buyout', { jobId }, { scope: false });
  const seed = async () => {
    const r = await run<{ seeded: number }>('seed', 'post', '/api/commercial/buyout', { jobId }, (d) => `Added ${d.seeded} buyout ${d.seeded === 1 ? 'package' : 'packages'} from the budget`);
    if (!r.error) await q.refetch();
  };
  const m = (c: number | null) => (c == null ? '—' : money(c, { decimals: 0 }));
  return (
    <Sec title="Buyout" meta="Budget against what is bought, by package" actions={canSeed ? <Button disabled={busy === 'seed'} onClick={() => void seed()}>Seed from the budget</Button> : undefined}>
      <Loaded q={q} what="the buyout log" empty={(d) => (d.packages.length ? null : { title: 'No buyout packages yet', body: 'Seed them from the budget’s subcontract and material cost codes, then buy each one out.' })}>
        {(d) => (
          <div className="mp-table">
            <table className="tbl-q">
              <thead><tr><th>Package</th><th>Status</th><th>Need by</th>{mv.cost && <><th className="n">Budget</th><th className="n">Bought</th><th className="n">Savings / loss</th></>}</tr></thead>
              <tbody>
                {d.packages.map((p) => {
                  const diff = p.budget_cents != null && p.committed_cents != null && p.committed_cents > 0 ? p.budget_cents - p.committed_cents : null;
                  const done = p.status === 'AWARDED' || p.status === 'NOT_NEEDED';
                  const late = p.days_to_need != null && p.days_to_need < 0 && !done;
                  return (
                    <tr key={p.package_id}>
                      <td>{p.csi_division ? <span className="code">{p.csi_division}</span> : null} {p.name}</td>
                      <td>{p.status === 'AWARDED' ? <Tag tone="pos">Bought</Tag> : <Tag tone={late ? 'warn' : undefined}>{words(p.status)}</Tag>}</td>
                      <td className={late ? 'neg' : undefined}>{p.need_by ? shortDate(p.need_by) : '—'}</td>
                      {mv.cost && <><td className="n tnum">{m(p.budget_cents)}</td><td className="n tnum">{m(p.committed_cents)}</td><td className={diff != null && diff < 0 ? 'n tnum neg' : 'n tnum'}>{diff == null ? '—' : money(diff, { decimals: 0, sign: 'delta' })}</td></>}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Loaded>
    </Sec>
  );
}

interface CloseoutItem { id: string; category: string; title: string; required: boolean; status: string; due_on: string | null; warranty_ends_on: string | null }
interface CloseoutData { gate: { ready: boolean; blockers: Array<{ code: string; label: string; count: number }> }; items: CloseoutItem[] }

export function CloseoutTab({ jobId, canEdit }: { jobId: string; canEdit: boolean }) {
  const { run, busy } = useAction();
  const q = useQuery<CloseoutData>('/api/commercial/closeout', { jobId }, { scope: false });
  const post = async (key: string, body: Record<string, unknown>, ok: string) => {
    const r = await run(key, 'post', '/api/commercial/closeout', { jobId, ...body }, ok);
    if (!r.error) await q.refetch();
  };
  return (
    <>
      <Sec title="Close gate" meta="What still blocks closing the job">
        <Loaded q={q} what="the close gate">
          {(d) => d.gate.ready
            ? <p className="t-cap">Nothing blocks closing this job.</p>
            : (
              <ul className="job-open">
                {d.gate.blockers.map((b) => <li key={b.code}><span style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 16px', borderBottom: '1px solid var(--line)' }}><span>{b.label}</span><span className="tnum">{b.count}</span></span></li>)}
              </ul>
            )}
        </Loaded>
      </Sec>
      <Sec title="Closeout package" meta="O&Ms, warranties, as-builts and final waivers"
        actions={canEdit ? <Button disabled={busy === 'gen'} onClick={() => void post('gen', { op: 'generate' }, 'Built the closeout package from the job')}>Generate from the job</Button> : undefined}>
        <Loaded q={q} what="the closeout package" empty={(d) => (d.items.length ? null : { title: 'No closeout items yet', body: 'Generate the package from the job’s subcontracts, submittals and specs.' })}>
          {(d) => (
            <div className="mp-table">
              <table className="tbl-q">
                <thead><tr><th>Item</th><th>Category</th><th>Due</th><th>Status</th>{canEdit && <th />}</tr></thead>
                <tbody>
                  {d.items.map((i) => (
                    <tr key={i.id}>
                      <td>{i.title}{i.required ? null : <span className="l2"> optional</span>}</td>
                      <td>{words(i.category)}</td>
                      <td>{i.due_on ? shortDate(i.due_on) : '—'}</td>
                      <td>{i.status === 'ACCEPTED' || i.status === 'WAIVED' ? <Tag tone="pos">{words(i.status)}</Tag> : <Tag>{words(i.status)}</Tag>}</td>
                      {canEdit && <td>{i.status !== 'ACCEPTED' && i.status !== 'WAIVED' && <Button variant="quiet" disabled={busy === `i:${i.id}`} onClick={() => void post(`i:${i.id}`, { op: 'item', itemId: i.id, status: 'ACCEPTED' }, `${i.title}: accepted`)}>Accept</Button>}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Loaded>
      </Sec>
    </>
  );
}

interface SafetyData {
  talks: Array<{ id: string; held_on: string; topic: string; language: string | null; presenter_name: string | null }>;
  jhas: Array<{ id: string; work_date: string; task_description: string; area: string | null; status: string }>;
  incidents: Array<{ id: string; number: string | null; incident_type: string; occurred_at: string; person_name: string | null; osha_recordable: boolean | null }>;
}
interface InspectionsData { inspections: Array<{ id: string; number: string | null; title: string; category: string | null; inspected_on: string | null; status: string; result: string | null }> }
interface ObservationsData { observations: Array<{ id: string; number: string; obs_type: string; priority: string; title: string; assignee_name: string | null; due_on: string | null; status: string }> }

export function SafetyTab({ jobId }: { jobId: string }) {
  const s = useQuery<SafetyData>('/api/commercial/safety', { jobId }, { scope: false });
  const ins = useQuery<InspectionsData>('/api/commercial/inspections', { jobId }, { scope: false });
  const obs = useQuery<ObservationsData>('/api/commercial/observations', { jobId }, { scope: false });
  return (
    <>
      <Sec title="Inspections" meta="Quality, safety and commissioning checklists">
        <Loaded q={ins} what="inspections" empty={(d) => (d.inspections.length ? null : { title: 'No inspections yet', body: 'Start one from a checklist template in the field app or on the daily report.' })}>
          {(d) => (
            <div className="mp-table"><table className="tbl-q">
              <thead><tr><th>Inspection</th><th>Category</th><th>Date</th><th>Result</th></tr></thead>
              <tbody>{d.inspections.map((i) => (
                <tr key={i.id}><td><span className="code">{i.number}</span> {i.title}</td><td>{words(i.category)}</td><td>{i.inspected_on ? shortDate(i.inspected_on) : '—'}</td>
                  <td>{i.result === 'PASS' ? <Tag tone="pos">Pass</Tag> : i.result === 'FAIL' ? <Tag tone="neg">Fail</Tag> : <Tag>{words(i.result ?? i.status)}</Tag>}</td></tr>
              ))}</tbody>
            </table></div>
          )}
        </Loaded>
      </Sec>
      <Sec title="Observations" meta="Assigned to a sub or a person with a due date">
        <Loaded q={obs} what="observations" empty={(d) => (d.observations.length ? null : { title: 'No observations', body: 'Quality and safety findings land here, numbered on the job.' })}>
          {(d) => (
            <div className="mp-table"><table className="tbl-q">
              <thead><tr><th>Observation</th><th>Type</th><th>Assigned to</th><th>Due</th><th>Status</th></tr></thead>
              <tbody>{d.observations.map((o) => (
                <tr key={o.id}><td><span className="code">{o.number}</span> {o.title}</td><td>{words(o.obs_type)} · {words(o.priority)}</td><td>{o.assignee_name ?? '—'}</td>
                  <td>{o.due_on ? shortDate(o.due_on) : '—'}</td><td>{o.status === 'CLOSED' ? <Tag tone="pos">Closed</Tag> : <Tag tone="warn">{words(o.status)}</Tag>}</td></tr>
              ))}</tbody>
            </table></div>
          )}
        </Loaded>
      </Sec>
      <Sec title="Safety" meta="Toolbox talks, job hazard analyses and incidents (OSHA 300)">
        <Loaded q={s} what="safety records" empty={(d) => (d.talks.length + d.jhas.length + d.incidents.length ? null : { title: 'No safety records yet', body: 'Toolbox talks with sign-in, JHAs and incident reports are recorded from the field.' })}>
          {(d) => (
            <div className="mp-table"><table className="tbl-q">
              <thead><tr><th>Record</th><th>Date</th><th>Detail</th></tr></thead>
              <tbody>
                {d.incidents.map((x) => <tr key={`i:${x.id}`}><td><Tag tone={x.osha_recordable ? 'neg' : 'warn'}>Incident</Tag> <span className="code">{x.number}</span> {words(x.incident_type)}</td><td>{shortDate(x.occurred_at.slice(0, 10))}</td><td>{x.person_name ?? '—'}{x.osha_recordable ? ' · OSHA recordable' : ''}</td></tr>)}
                {d.jhas.map((x) => <tr key={`j:${x.id}`}><td><Tag>JHA</Tag> {x.task_description}</td><td>{shortDate(x.work_date)}</td><td>{[x.area, words(x.status)].filter(Boolean).join(' · ')}</td></tr>)}
                {d.talks.map((x) => <tr key={`t:${x.id}`}><td><Tag>Toolbox talk</Tag> {x.topic}</td><td>{shortDate(x.held_on)}</td><td>{x.presenter_name ?? '—'}</td></tr>)}
              </tbody>
            </table></div>
          )}
        </Loaded>
      </Sec>
      <p className="t-cap"><Link className="link" href="/daily-logs">Daily reports and T&amp;M tickets</Link></p>
    </>
  );
}

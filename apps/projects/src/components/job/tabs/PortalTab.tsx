'use client';

import { useState } from 'react';
import { Button, Field, Select, Tag, Textarea, money, shortDate, toast, useQuery } from '@meritbooks/merit-ui';
import { PortalAccessPanel } from '@/components/portal/staff/PortalAccessPanel';
import { useMoneyVis, useShell } from '@/components/shell/ShellContext';
import { useAction } from '@/components/job/useAction';
import { Loaded, Sec, words } from './common';

/**
 * The job's portal side (1118, staff view): who is invited, the portal message threads
 * (customer / each sub / lender), subs' answers to schedule requests (confirm, decline, propose a
 * date — accept moves the task), sub pay applications sent through the portal, and what portal
 * users did. Every read comes through RLS; replies are held until the company goes live.
 */

type Audience = 'customer' | 'vendor' | 'lender' | 'investor';
interface Msg { id: string; audience: Audience; party_id: string | null; author_kind: string; author_name: string; body: string; created_at: string; staff_read_at: string | null }
interface Resp { id: string; task_id: string; vendor_id: string | null; response: 'confirmed' | 'declined' | 'proposed'; proposed_start: string | null; note: string | null; resolution: string | null; created_at: string }
interface Act { id: string; actor_name: string; action: string; subject_table: string | null; verified_by: string | null; at: string }

const AUDIENCE: Record<Audience, string> = { customer: 'Customer', vendor: 'Subs and vendors', lender: 'Lender', investor: 'Investors' };

export function PortalTab({ jobId, companyId, canEdit, audiences }: { jobId: string; companyId: string; canEdit: boolean; audiences: ReadonlyArray<Audience> }) {
  const mv = useMoneyVis();
  const { readOnly } = useShell();
  const edit = canEdit && !readOnly;
  return (
    <>
      {audiences.map((a) => (
        <Sec key={a} title={`${AUDIENCE[a]} portal access`}>
          <PortalAccessPanel companyId={companyId} audience={a} jobId={jobId} />
        </Sec>
      ))}
      <Threads jobId={jobId} canReply={edit} />
      <DateAnswers jobId={jobId} canResolve={edit} />
      {mv.cost && <PortalPayApps filter={{ jobId }} />}
      <Activity jobId={jobId} />
    </>
  );
}

function Threads({ jobId, canReply }: { jobId: string; canReply: boolean }) {
  const { run, busy } = useAction();
  const q = useQuery<{ messages: Msg[] }>('/api/portal/staff/threads', { jobId }, { scope: false });
  const [to, setTo] = useState<string>('');
  const [body, setBody] = useState('');
  const keys = [...new Set((q.data?.messages ?? []).map((m) => `${m.audience}|${m.party_id ?? ''}`))];
  const send = async () => {
    const [audience, party] = (to || keys[0] || 'customer|').split('|') as [Audience, string];
    if (!body.trim()) return void toast.error('Write the reply first.');
    const r = await run('reply', 'post', '/api/portal/staff/threads', { jobId, audience, partyId: party || null, body: body.trim() }, 'Reply saved. It goes out when the company is live on the portal');
    if (!r.error) {
      setBody('');
      await q.refetch();
    }
  };
  return (
    <Sec title="Portal messages" meta="Customer, each sub and the lender, on this job">
      <Loaded q={q} what="portal messages" empty={(d) => (d.messages.length ? null : { title: 'No portal messages yet', body: 'Messages customers, subs and lenders send from the portal land here, and your replies go back to the same thread.' })}>
        {(d) => (
          <ul className="feed">
            {d.messages.map((m) => (
              <li key={m.id}>
                <span style={{ minWidth: 0 }}>
                  <span className="l1">{m.author_name} <Tag>{AUDIENCE[m.audience]}</Tag>{m.author_kind === 'staff' ? null : !m.staff_read_at ? <> <Tag tone="warn">New</Tag></> : null}</span>
                  <span className="l2" style={{ whiteSpace: 'pre-wrap' }}>{m.body}</span>
                </span>
                <span className="t-cap ink-3">{shortDate(m.created_at.slice(0, 10))}</span>
              </li>
            ))}
          </ul>
        )}
      </Loaded>
      {canReply && (
        <form className="mp-add" onSubmit={(e) => { e.preventDefault(); void send(); }}>
          {keys.length > 1 && (
            <Field label="To">
              <Select value={to || keys[0]} onChange={(e) => setTo(e.target.value)}>
                {keys.map((k) => <option key={k} value={k}>{AUDIENCE[k.split('|')[0] as Audience]}{k.split('|')[1] ? ` · ${k.split('|')[1]!.slice(0, 8)}` : ''}</option>)}
              </Select>
            </Field>
          )}
          <Field label="Reply"><Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={2} /></Field>
          <Button type="submit" variant="primary" disabled={busy === 'reply'}>Send reply</Button>
        </form>
      )}
    </Sec>
  );
}

function DateAnswers({ jobId, canResolve }: { jobId: string; canResolve: boolean }) {
  const { run, busy } = useAction();
  const q = useQuery<{ responses: Resp[] }>('/api/portal/staff/responses', { jobId }, { scope: false });
  const resolve = async (r: Resp, resolution: 'accepted' | 'rejected') => {
    const res = await run(`r:${r.id}`, 'post', '/api/portal/staff/responses', { id: r.id, resolution },
      resolution === 'accepted' ? (r.proposed_start ? `Moved the task to ${shortDate(r.proposed_start)}` : 'Accepted') : 'Declined the proposed date');
    if (!res.error) await q.refetch();
  };
  return (
    <Sec title="Schedule answers from subs" meta="Confirm, can’t make it, or a proposed date">
      <Loaded q={q} what="schedule answers" empty={(d) => (d.responses.length ? null : { title: 'No answers yet', body: 'When a sub confirms, declines or proposes another date for a task, it shows here.' })}>
        {(d) => (
          <div className="mp-table"><table className="tbl-q">
            <thead><tr><th>Answer</th><th>Proposed start</th><th>Note</th><th>When</th><th /></tr></thead>
            <tbody>{d.responses.map((r) => (
              <tr key={r.id}>
                <td>{r.response === 'confirmed' ? <Tag tone="pos">Confirmed</Tag> : r.response === 'declined' ? <Tag tone="neg">Can’t make it</Tag> : <Tag tone="warn">Proposed a date</Tag>}</td>
                <td>{r.proposed_start ? shortDate(r.proposed_start) : '—'}</td>
                <td style={{ whiteSpace: 'normal' }}>{r.note ?? '—'}</td>
                <td>{shortDate(r.created_at.slice(0, 10))}</td>
                <td>
                  {r.resolution ? <Tag>{words(r.resolution)}</Tag> : canResolve && r.response === 'proposed' ? (
                    <span className="btn-row">
                      <Button variant="primary" disabled={busy === `r:${r.id}`} onClick={() => void resolve(r, 'accepted')}>Accept the date</Button>
                      <Button variant="quiet" disabled={busy === `r:${r.id}`} onClick={() => void resolve(r, 'rejected')}>Decline</Button>
                    </span>
                  ) : null}
                </td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Loaded>
    </Sec>
  );
}

interface PayApp { id: string; application_no: number | string | null; vendor_invoice_no: string | null; period_end: string | null; gross_cents: number | null; retainage_cents: number | null; net_cents: number | null; status: string; submitted_at: string | null; decision_note: string | null }

/** Sub pay applications sent through the portal (on a job, or on one commitment). Approve / reject with a reason the sub sees. */
export function PortalPayApps({ filter }: { filter: { jobId?: string; commitmentId?: string } }) {
  const { run, busy } = useAction();
  const { readOnly } = useShell();
  const q = useQuery<{ payApps: PayApp[] }>('/api/portal/staff/pay-apps', filter, { scope: false });
  const [reason, setReason] = useState<Record<string, string>>({});
  const decide = async (p: PayApp, decision: 'approved' | 'rejected') => {
    const note = reason[p.id]?.trim() || null;
    if (decision === 'rejected' && !note) return void toast.error('Say why, so the sub can fix it.');
    const r = await run(`p:${p.id}`, 'post', '/api/portal/staff/pay-apps', { id: p.id, decision, note }, decision === 'approved' ? 'Pay application approved' : 'Pay application sent back');
    if (!r.error) await q.refetch();
  };
  const m = (c: number | null) => (c == null ? '—' : money(c));
  return (
    <Sec title="Sub pay applications" meta="Sent by subs through the portal">
      <Loaded q={q} what="sub pay applications" empty={(d) => (d.payApps.length ? null : { title: 'No pay applications from the portal', body: 'Subs bill against their commitment lines from the portal; each one waits here for review.' })}>
        {(d) => (
          <div className="mp-table"><table className="tbl-q">
            <thead><tr><th>Application</th><th>Period</th><th className="n">Gross</th><th className="n">Retainage</th><th className="n">Net</th><th>Status</th><th /></tr></thead>
            <tbody>{d.payApps.map((p) => {
              const open = p.status === 'submitted' || p.status === 'SUBMITTED';
              return (
                <tr key={p.id}>
                  <td>#{p.application_no ?? '—'}{p.vendor_invoice_no ? <span className="l2"> inv {p.vendor_invoice_no}</span> : null}</td>
                  <td>{p.period_end ? shortDate(p.period_end) : '—'}</td>
                  <td className="n tnum">{m(p.gross_cents)}</td><td className="n tnum">{m(p.retainage_cents)}</td><td className="n tnum"><b>{m(p.net_cents)}</b></td>
                  <td>{open ? <Tag tone="warn">To review</Tag> : <Tag tone={/approved/i.test(p.status) ? 'pos' : undefined}>{words(p.status)}</Tag>}{p.decision_note ? <span className="l2"> {p.decision_note}</span> : null}</td>
                  <td>{open && !readOnly && (
                    <span className="btn-row">
                      <input className="input" aria-label="Reason (shown to the sub)" placeholder="Reason if sending back" value={reason[p.id] ?? ''} onChange={(e) => setReason({ ...reason, [p.id]: e.target.value })} style={{ width: 200 }} />
                      <Button variant="primary" disabled={busy === `p:${p.id}`} onClick={() => void decide(p, 'approved')}>Approve</Button>
                      <Button variant="quiet" disabled={busy === `p:${p.id}`} onClick={() => void decide(p, 'rejected')}>Send back</Button>
                    </span>
                  )}</td>
                </tr>
              );
            })}</tbody>
          </table></div>
        )}
      </Loaded>
    </Sec>
  );
}

function Activity({ jobId }: { jobId: string }) {
  const q = useQuery<{ activity: Act[] }>('/api/portal/staff/activity', { jobId }, { scope: false });
  return (
    <Sec title="Portal activity" meta="What portal users did, and how they were verified">
      <Loaded q={q} what="portal activity" empty={(d) => (d.activity.length ? null : { title: 'Nothing from the portal yet' })}>
        {(d) => (
          <ul className="feed">
            {d.activity.map((a) => (
              <li key={a.id}>
                <span style={{ minWidth: 0 }}><span className="l1">{a.actor_name} {words(a.action)}</span><span className="l2">{[words(a.subject_table), a.verified_by ? `verified by ${words(a.verified_by)}` : null].filter(Boolean).join(' · ')}</span></span>
                <span className="t-cap ink-3">{shortDate(a.at.slice(0, 10))}</span>
              </li>
            ))}
          </ul>
        )}
      </Loaded>
    </Sec>
  );
}

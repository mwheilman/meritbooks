'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Button, ButtonLink, Drawer, Field, Input, KV, MoneyInput, PanelSection, Select, Status, Textarea, WidgetState, api, clockTime, count,
  money, shortDate, toast, type StatusKind,
} from '@meritbooks/merit-ui';
import { ACTIVITY_KINDS, ACTIVITY_WORDS, LEAD_SOURCES, type ActivityKind } from '@/lib/crm/types';
import { boardStages, durationWords, followupState } from '@/lib/crm/stages';
import { weightedOf } from '@/lib/crm/view';
import type { LeadDetail } from '@/lib/crm/detail';
import { MoveDialog } from './MoveDialog';
import { useMoveLead } from './useMoveLead';
import { movable } from './LeadBoard';
import type { OwnerChoice } from './NewLeadPanel';
import './crm.css';

export interface JobTypeChoice {
  key: string;
  label: string;
}

export interface LeadPageProps {
  detail: LeadDetail;
  today: string;
  canEdit: boolean;
  canEstimate: boolean;
  canJob: boolean;
  showMoney: boolean;
  owners: ReadonlyArray<OwnerChoice>;
  jobTypes: ReadonlyArray<JobTypeChoice>;
  readOnly: boolean;
}

const KIND_STATUS: Readonly<Record<string, StatusKind>> = { ready: 'ready', track: 'track', risk: 'risk', overdue: 'overdue' };

function when(iso: string): string {
  return `${shortDate(iso)} · ${clockTime(iso)}`;
}

/** One lead: stage, the person and site, the activity timeline, follow-ups and conversion. */
export function LeadPage({ detail, today, canEdit, canEstimate, canJob, showMoney, owners, jobTypes, readOnly }: LeadPageProps) {
  const router = useRouter();
  const [lead, setLead] = useState(detail.lead);
  useEffect(() => setLead(detail.lead), [detail.lead]);
  const edit = canEdit && !readOnly;
  const stages = boardStages(detail.pipeline.stages);
  const onMoved = useCallback((_id: string, stageId: string) => {
    const s = detail.pipeline.stages.find((x) => x.id === stageId);
    if (s) setLead((l) => ({ ...l, stageId, stageName: s.name, stageKind: s.kind, daysInStage: 0 }));
  }, [detail.pipeline.stages]);
  const refresh = useCallback(() => router.refresh(), [router]);
  const mover = useMoveLead(detail.pipeline.stages, onMoved, refresh);
  const current = stages.findIndex((s) => s.id === lead.stageId);

  return (
    <div className="stack">
      <nav className="crm-stages" aria-label="Stage">
        {stages.map((s, i) => {
          const now = s.id === lead.stageId;
          const past = s.kind === 'open' && lead.stageKind === 'open' && i < current;
          return (
            <button
              key={s.id}
              type="button"
              className={['crm-stage', now ? 'is-now' : '', past ? 'is-past' : '', s.kind === 'won' ? 'is-won' : '', s.kind === 'lost' ? 'is-lost' : ''].filter(Boolean).join(' ')}
              aria-current={now ? 'step' : undefined}
              disabled={!edit || now || mover.busy}
              onClick={() => mover.request(movable(lead), s.id)}
              title={now ? 'Current stage' : `Move to ${s.name}`}
            >
              {s.name}
            </button>
          );
        })}
      </nav>
      {lead.stageKind === 'lost' && lead.lostReason && <p className="t-cap">Lost: {lead.lostReason}</p>}

      <div className="crm-page">
        <div className="stack">
          {edit && <LogActivity leadId={lead.id} onLogged={() => router.refresh()} hasNextStep={!!lead.nextStep} />}
          <section className="crm-box" aria-labelledby="tl-h">
            <div className="crm-box-h"><h2 id="tl-h">Activity</h2><span className="sp" /><span className="t-cap">{count(detail.timeline.length)} entries</span></div>
            <div className="crm-box-b">
              {detail.timeline.length === 0 ? (
                <WidgetState state={{ kind: 'empty', title: 'Nothing logged yet', body: 'Log the first call, text or visit above. The speed-to-lead timer stops at the first outbound touch.' }} />
              ) : (
                <ol className="crm-tl">
                  {detail.timeline.map((t) => (
                    <li key={t.id} className={t.kind === 'stage' ? 'is-stage' : undefined}>
                      <span className="when">{when(t.at)}</span>
                      <span className="what">
                        <span className="k">{t.kind === 'stage' ? 'Stage' : `${ACTIVITY_WORDS[t.kind]}${t.direction ? ` · ${t.direction}` : ''}`}{t.who ? ` · ${t.who}` : ''}</span>
                        {t.subject && <span className="s">{t.subject}</span>}
                        {t.body && <span className="b">{t.body}</span>}
                        {t.outcome && <span className="o">Outcome: {t.outcome}</span>}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </section>
        </div>

        <aside className="crm-side">
          <LeadFacts lead={lead} detail={detail} showMoney={showMoney} edit={edit} owners={owners} onSaved={() => router.refresh()} />
          <section className="crm-box" aria-labelledby="sp-h">
            <div className="crm-box-h"><h2 id="sp-h">Speed to lead</h2></div>
            <div className="crm-box-b">
              {lead.speed ? (
                <Status kind={KIND_STATUS[lead.speed.tone] ?? 'risk'}>{lead.speed.state === 'waiting' ? `No touch yet · waiting ${durationWords(lead.speed.minutes)}` : `First touch ${durationWords(lead.speed.minutes)} after it came in`}</Status>
              ) : (
                <span className="t-cap">Closed before anyone reached out.</span>
              )}
              <p className="t-cap" style={{ marginTop: 6 }}>Target: under 5 minutes. Came in {when(lead.createdAt)}.</p>
            </div>
          </section>
          <Followups leadId={lead.id} items={detail.followups} today={today} edit={edit} owners={owners} onChange={() => router.refresh()} />
          <Convert lead={lead} edit={edit} canEstimate={canEstimate} canJob={canJob} jobTypes={jobTypes} />
        </aside>
      </div>

      <MoveDialog open={!!mover.pending} kind={mover.pending?.reason ?? null} leadTitle={lead.title} stageName={mover.pending?.to.name ?? ''} busy={mover.busy}
        onClose={mover.cancel} onConfirm={(r) => mover.confirm(r)} />
    </div>
  );
}

// ------------------------------------------------------------------ facts + edit

function LeadFacts({ lead, detail, showMoney, edit, owners, onSaved }: { lead: LeadDetail['lead']; detail: LeadDetail; showMoney: boolean; edit: boolean; owners: ReadonlyArray<OwnerChoice>; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const weighted = weightedOf(lead);
  const items = [
    { term: 'Customer', value: lead.customerId ? <Link className="link" href={`/customers/${lead.customerId}`}>{lead.customerName ?? 'Customer'}</Link> : 'Not linked yet' },
    ...(detail.contact ? [{ term: 'Contact', value: <>{detail.contact.name}{detail.contact.phone ? <><br /><a className="link" href={`tel:${detail.contact.phone}`}>{detail.contact.phone}</a></> : null}{detail.contact.email ? <><br /><a className="link" href={`mailto:${detail.contact.email}`}>{detail.contact.email}</a></> : null}{!detail.contact.smsConsent ? <><br /><span className="t-cap">No text consent on file</span></> : null}</> }] : []),
    ...(detail.site ? [{ term: 'Site', value: <>{detail.site.address}{detail.site.accessNotes ? <><br /><span className="t-cap">{detail.site.accessNotes}</span></> : null}</> }] : []),
    ...(showMoney ? [{ term: 'Value', value: lead.amountCents != null ? <span className="tnum">{money(lead.amountCents, { decimals: 0 })}{weighted != null && lead.stageKind === 'open' ? ` · ${money(weighted, { decimals: 0 })} weighted` : ''}</span> : 'Not set' }] : []),
    { term: 'Source', value: [lead.sourceLabel, lead.campaign].filter(Boolean).join(' · ') },
    { term: 'Owner', value: lead.ownerName ?? 'Unassigned' },
    { term: 'Next step', value: lead.nextStep ? `${lead.nextStep}${lead.nextStepOn ? ` · ${shortDate(lead.nextStepOn)}` : ''}` : <span className="neg">None set</span> },
    ...(lead.expectedCloseOn ? [{ term: 'Expected to close', value: shortDate(lead.expectedCloseOn) }] : []),
    { term: 'In this stage', value: `${count(lead.daysInStage)} days` },
  ];
  return (
    <section className="crm-box" aria-labelledby="facts-h">
      <div className="crm-box-h"><h2 id="facts-h">Lead</h2><span className="sp" />{edit && <Button variant="quiet" onClick={() => setOpen(true)}>Edit</Button>}</div>
      <div className="crm-box-b"><KV items={items} /></div>
      {edit && <EditLead open={open} onClose={() => setOpen(false)} lead={lead} owners={owners} showMoney={showMoney} onSaved={onSaved} />}
    </section>
  );
}

function EditLead({ open, onClose, lead, owners, showMoney, onSaved }: { open: boolean; onClose: () => void; lead: LeadDetail['lead']; owners: ReadonlyArray<OwnerChoice>; showMoney: boolean; onSaved: () => void }) {
  const [title, setTitle] = useState(lead.title);
  const [source, setSource] = useState(lead.source ?? '');
  const [campaign, setCampaign] = useState(lead.campaign ?? '');
  const [owner, setOwner] = useState(lead.ownerId ?? '');
  const [value, setValue] = useState<number | null>(lead.amountCents);
  const [close, setClose] = useState(lead.expectedCloseOn ?? '');
  const [next, setNext] = useState(lead.nextStep ?? '');
  const [nextOn, setNextOn] = useState(lead.nextStepOn ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    if (!title.trim()) return setErr('Say what the work is.');
    setBusy(true);
    const r = await api.patch<{ ok: true }>(`/api/crm/leads/${lead.id}`, {
      title: title.trim(), source: source || null, campaign: campaign.trim() || null, ownerMembershipId: owner || null,
      ...(showMoney ? { valueCents: value } : {}), expectedCloseOn: close || null, nextStep: next.trim() || null, nextStepOn: nextOn || null,
    });
    setBusy(false);
    if (r.error) return setErr(r.error.error);
    toast('Saved the lead');
    onClose();
    onSaved();
  };
  return (
    <Drawer open={open} onClose={onClose} eyebrow="Lead" title="Edit lead" width={440}
      foot={<div className="btn-row"><Button variant="primary" chord="mod+enter" bindChord={open} disabled={busy} onClick={() => void save()}>Save</Button><Button variant="quiet" onClick={onClose}>Cancel</Button></div>}>
      <PanelSection>
        <Field label="What is the work?"><Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} /></Field>
        <div className="mp-form-2">
          <Field label="Source"><Select value={source} onChange={(e) => setSource(e.target.value)}><option value="">No source</option>{LEAD_SOURCES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</Select></Field>
          <Field label="Campaign"><Input value={campaign} onChange={(e) => setCampaign(e.target.value)} maxLength={100} /></Field>
        </div>
        {owners.length > 0 && <Field label="Owner"><Select value={owner} onChange={(e) => setOwner(e.target.value)}><option value="">Unassigned</option>{owners.map((o) => <option key={o.membershipId} value={o.membershipId}>{o.name}</option>)}</Select></Field>}
        {showMoney && <Field label="Estimated value"><MoneyInput valueCents={value} onChangeCents={setValue} /></Field>}
        <Field label="Expected to close"><Input type="date" value={close} onChange={(e) => setClose(e.target.value)} /></Field>
        <div className="mp-form-2">
          <Field label="Next step"><Input value={next} onChange={(e) => setNext(e.target.value)} maxLength={300} /></Field>
          <Field label="By"><Input type="date" value={nextOn} onChange={(e) => setNextOn(e.target.value)} /></Field>
        </div>
        {err && <span className="field-error" role="alert">{err}</span>}
      </PanelSection>
    </Drawer>
  );
}

// ------------------------------------------------------------------ log activity

function LogActivity({ leadId, onLogged, hasNextStep }: { leadId: string; onLogged: () => void; hasNextStep: boolean }) {
  const [kind, setKind] = useState<ActivityKind>('call');
  const [direction, setDirection] = useState<'outbound' | 'inbound'>('outbound');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [outcome, setOutcome] = useState('');
  const [next, setNext] = useState('');
  const [nextOn, setNextOn] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const directed = kind === 'call' || kind === 'sms' || kind === 'email' || kind === 'portal_message';
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!subject.trim() && !body.trim() && !outcome.trim()) return setErr('Say what happened.');
    if (!hasNextStep && !next.trim()) return setErr('Every touch ends with a next step. Add one.');
    setErr(null);
    setBusy(true);
    const r = await api.post<{ ok: true }>(`/api/crm/leads/${leadId}/activities`, {
      kind, direction: directed ? direction : null, subject: subject.trim() || null, body: body.trim() || null, outcome: outcome.trim() || null,
      nextStep: next.trim() || null, nextStepOn: nextOn || null,
    });
    setBusy(false);
    if (r.error) return setErr(r.error.error);
    toast(`Logged the ${ACTIVITY_WORDS[kind].toLowerCase()}`);
    setSubject('');
    setBody('');
    setOutcome('');
    setNext('');
    setNextOn('');
    onLogged();
  };
  return (
    <form className="crm-box" aria-labelledby="log-h" onSubmit={(e) => void submit(e)} noValidate>
      <div className="crm-box-h"><h2 id="log-h">Log a touch</h2></div>
      <div className="crm-box-b stack" style={{ gap: 8 }}>
        <div className="crm-filters" role="group" aria-label="Kind">
          {ACTIVITY_KINDS.filter((k) => k !== 'signed_document').map((k) => (
            <button key={k} type="button" className="crm-filter" aria-pressed={kind === k} onClick={() => setKind(k)}>{ACTIVITY_WORDS[k]}</button>
          ))}
          {directed && (
            <>
              <span style={{ width: 12 }} />
              <button type="button" className="crm-filter" aria-pressed={direction === 'outbound'} onClick={() => setDirection('outbound')}>We reached out</button>
              <button type="button" className="crm-filter" aria-pressed={direction === 'inbound'} onClick={() => setDirection('inbound')}>They reached us</button>
            </>
          )}
        </div>
        <Field label="Subject"><Input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} placeholder="Booked the consult, left a voicemail…" /></Field>
        <Field label="Notes"><Textarea rows={3} value={body} onChange={(e) => setBody(e.target.value)} maxLength={4000} /></Field>
        <div className="mp-form-2">
          <Field label="Outcome"><Input value={outcome} onChange={(e) => setOutcome(e.target.value)} maxLength={300} /></Field>
          <div className="mp-form-2">
            <Field label="Next step"><Input value={next} onChange={(e) => setNext(e.target.value)} maxLength={300} /></Field>
            <Field label="By"><Input type="date" value={nextOn} onChange={(e) => setNextOn(e.target.value)} /></Field>
          </div>
        </div>
        {err && <span className="field-error" role="alert">{err}</span>}
        <div className="btn-row"><Button type="submit" variant="primary" disabled={busy} aria-busy={busy || undefined}>Log {ACTIVITY_WORDS[kind].toLowerCase()}</Button></div>
      </div>
    </form>
  );
}

// ------------------------------------------------------------------ follow-ups

function Followups({ leadId, items, today, edit, owners, onChange }: { leadId: string; items: LeadDetail['followups']; today: string; edit: boolean; owners: ReadonlyArray<OwnerChoice>; onChange: () => void }) {
  const [dueOn, setDueOn] = useState('');
  const [kind, setKind] = useState<ActivityKind>('call');
  const [who, setWho] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const open = items.filter((f) => !f.doneAt).sort((a, b) => a.dueOn.localeCompare(b.dueOn));
  const done = items.filter((f) => f.doneAt).sort((a, b) => (b.doneAt ?? '').localeCompare(a.doneAt ?? '')).slice(0, 5);
  const add = async () => {
    if (!dueOn) return setErr('Pick the day.');
    setErr(null);
    setBusy('add');
    const r = await api.post<{ ok: true }>(`/api/crm/leads/${leadId}/followups`, { dueOn, kind, assignedMembershipId: who || null });
    setBusy(null);
    if (r.error) return setErr(r.error.error);
    toast(`Added a follow-up for ${shortDate(dueOn)}`);
    setDueOn('');
    onChange();
  };
  const complete = async (id: string) => {
    setBusy(id);
    const r = await api.post<{ ok: true }>(`/api/crm/followups/${id}`, {});
    setBusy(null);
    if (r.error) return void toast.error(r.error.error);
    toast('Marked the follow-up done');
    onChange();
  };
  return (
    <section className="crm-box" aria-labelledby="fu-h">
      <div className="crm-box-h"><h2 id="fu-h">Follow-ups</h2><span className="sp" /><span className="t-cap">{count(open.length)} open</span></div>
      <div className="crm-box-b">
        {open.length === 0 && done.length === 0 && <p className="t-cap">No follow-ups. Add the next call or visit so it shows on the day.</p>}
        <ul className="crm-fu">
          {[...open, ...done].map((f) => {
            const st = followupState({ due_on: f.dueOn, done_at: f.doneAt }, today);
            return (
              <li key={f.id} className={st === 'done' ? 'is-done' : undefined}>
                <span>
                  <span className={st === 'overdue' ? 'd neg b' : st === 'due' ? 'd b' : 'd'}>{shortDate(f.dueOn)}</span>{' '}
                  {ACTIVITY_WORDS[f.kind as ActivityKind] ?? f.kind}{f.assignee ? ` · ${f.assignee}` : ''}{f.cadence ? ' · cadence' : ''}
                  {st === 'overdue' && <span className="t-cap"> · overdue</span>}
                </span>
                {st !== 'done' && edit ? <Button variant="quiet" disabled={busy === f.id} onClick={() => void complete(f.id)}>Done</Button> : st === 'done' ? <span className="t-cap">Done</span> : <span />}
              </li>
            );
          })}
        </ul>
        {edit && (
          <div className="stack" style={{ gap: 8, marginTop: 12 }}>
            <div className="mp-form-2">
              <Field label="Follow up on"><Input type="date" value={dueOn} min={today} onChange={(e) => setDueOn(e.target.value)} /></Field>
              <Field label="By">
                <Select value={kind} onChange={(e) => setKind(e.target.value as ActivityKind)}>
                  {(['call', 'sms', 'email', 'meeting', 'site_visit'] as const).map((k) => <option key={k} value={k}>{ACTIVITY_WORDS[k]}</option>)}
                </Select>
              </Field>
            </div>
            {owners.length > 1 && (
              <Field label="Who"><Select value={who} onChange={(e) => setWho(e.target.value)}><option value="">The lead’s owner</option>{owners.map((o) => <option key={o.membershipId} value={o.membershipId}>{o.name}</option>)}</Select></Field>
            )}
            {err && <span className="field-error" role="alert">{err}</span>}
            <div className="btn-row"><Button disabled={busy === 'add'} onClick={() => void add()}>Add follow-up</Button></div>
          </div>
        )}
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ convert

function Convert({ lead, edit, canEstimate, canJob, jobTypes }: { lead: LeadDetail['lead']; edit: boolean; canEstimate: boolean; canJob: boolean; jobTypes: ReadonlyArray<JobTypeChoice> }) {
  const router = useRouter();
  const [jt, setJt] = useState(jobTypes[0]?.key ?? '');
  const [busy, setBusy] = useState<'estimate' | 'job' | null>(null);
  if (lead.convertedJobId) {
    return (
      <section className="crm-box" aria-labelledby="cv-h">
        <div className="crm-box-h"><h2 id="cv-h">Became work</h2></div>
        <div className="crm-box-b"><p className="t-body" style={{ marginBottom: 8 }}>This lead is linked to its job; margin traces back to this source.</p><ButtonLink href={`/jobs/${lead.convertedJobId}${lead.convertedEstimateId ? '?tab=estimates' : ''}`}>Open the job</ButtonLink></div>
      </section>
    );
  }
  if (!edit || (!canEstimate && !canJob) || lead.stageKind === 'lost') return null;
  const go = async (op: 'estimate' | 'job') => {
    setBusy(op);
    const r = await api.post<{ href: string }>(`/api/crm/leads/${lead.id}/convert`, { op, jobTypeKey: jt || null });
    setBusy(null);
    if (r.error) return void toast.error(r.error.error);
    toast(op === 'estimate' ? 'Started the estimate' : 'Created the job');
    router.push(r.data?.href ?? `/leads/${lead.id}`);
  };
  return (
    <section className="crm-box" aria-labelledby="cv-h">
      <div className="crm-box-h"><h2 id="cv-h">Turn into work</h2></div>
      <div className="crm-box-b stack" style={{ gap: 8 }}>
        <p className="t-cap">Carries the customer, site and notes. {lead.customerId ? '' : 'The customer is matched against your records first.'}</p>
        {jobTypes.length > 1 && (
          <Field label="Job type"><Select value={jt} onChange={(e) => setJt(e.target.value)}>{jobTypes.map((j) => <option key={j.key} value={j.key}>{j.label}</option>)}</Select></Field>
        )}
        <div className="btn-row">
          {canEstimate && <Button variant="primary" disabled={!!busy} aria-busy={busy === 'estimate' || undefined} onClick={() => void go('estimate')}>Start an estimate</Button>}
          {canJob && <Button disabled={!!busy} aria-busy={busy === 'job' || undefined} onClick={() => void go('job')}>Create the job</Button>}
        </div>
      </div>
    </section>
  );
}

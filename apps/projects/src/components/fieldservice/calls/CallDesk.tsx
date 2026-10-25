'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Button, ButtonLink, Check, Field, InlineNotice, Input, Select, Status, Tag, Textarea, WidgetState, api, count, money, shortDate, toast, useDebounce,
  useQuery,
} from '@meritbooks/merit-ui';
import { useShell } from '@/components/shell/ShellContext';
import { disclosuresFor, duplicateOf, fmtPhone, isoDow, missedDisclosures, missingAnswers, normPhone, zoneForZip } from '@/lib/fieldservice/booking';
import type { BookingSetup } from '@/lib/fieldservice/queries';
import type { CallRow, CallerPop, CapacityCell } from '@/lib/fieldservice/types';
import { CapacityGrid, type CapacityPick } from '../capacity/CapacityGrid';

export interface CallDeskProps {
  companyId: string;
  companyName: string;
  today: string;
  setup: BookingSetup;
  recent: CallRow[];
  requests: CallRow[];
  canOverride: boolean;
  /** Customer AR amounts are shown only when the database returned them (contract value / billing). */
  initialPhone?: string | null;
}

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

type Answers = Record<string, string | boolean>;

/**
 * The call-booking screen (FS-02/03/04/09/10/15): one pop with everything about the caller, a
 * booking form that walks the CSR script, books only into open capacity, and warns before a
 * duplicate job. Requests from the website wait in the inbox holding their slot.
 */
export function CallDesk(p: CallDeskProps) {
  const { readOnly } = useShell();
  const [phone, setPhone] = useState(p.initialPhone ?? '');
  const dPhone = useDebounce(phone, 350);
  const [customerId, setCustomerId] = useState<string | null>(null);
  const popUrl = normPhone(dPhone).length >= 7 || customerId ? '/api/fieldservice/calls/pop' : null;
  const pop = useQuery<{ pop: CallerPop }>(popUrl, { companyId: p.companyId, phone: customerId ? undefined : normPhone(dPhone), customerId: customerId ?? undefined }, { scope: false });
  const caller = pop.data?.pop ?? null;
  useEffect(() => {
    if (!customerId && caller?.customer?.id) setCustomerId(caller.customer.id);
  }, [caller?.customer?.id, customerId]);

  const [jobTypeId, setJobTypeId] = useState('');
  const jt = p.setup.jobTypes.find((j) => j.id === jobTypeId) ?? null;
  const [buId, setBuId] = useState('');
  useEffect(() => { if (jt?.business_unit_id) setBuId(jt.business_unit_id); }, [jt?.business_unit_id]);
  const [campaignId, setCampaignId] = useState('');
  useEffect(() => { if (caller?.tracking_campaign?.id && !campaignId) setCampaignId(caller.tracking_campaign.id); }, [caller?.tracking_campaign?.id, campaignId]);
  const [siteId, setSiteId] = useState('');
  const site = caller?.sites?.find((s) => s.id === siteId) ?? null;
  const [zip, setZip] = useState('');
  const zoneId = useMemo(() => site?.zone_id ?? zoneForZip(p.setup.zones, zip), [site?.zone_id, zip, p.setup.zones]);
  const [from, setFrom] = useState(p.today);
  const days = useMemo(() => Array.from({ length: 5 }, (_, i) => addDays(from, i)), [from]);
  const grid = useQuery<{ cells: CapacityCell[] }>('/api/fieldservice/capacity', { companyId: p.companyId, from, days: '5' }, { scope: false });
  const [pick, setPick] = useState<CapacityPick | null>(null);
  const pickedCell = pick ? grid.data?.cells.find((c) => c.service_day === pick.day && c.arrival_window_id === pick.windowId && c.business_unit_id === buId) ?? null : null;
  const pickedWindow = pick ? p.setup.windows.find((w) => w.id === pick.windowId) ?? null : null;
  const full = !!pickedCell && pickedCell.limited && !pickedCell.is_open;

  const [answers, setAnswers] = useState<Answers>({});
  const [acks, setAcks] = useState<string[]>([]);
  const [summary, setSummary] = useState('');
  const [priority, setPriority] = useState<number | null>(null);
  const [override, setOverride] = useState('');
  const [allowDup, setAllowDup] = useState(false);
  const [notBooked, setNotBooked] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [booked, setBooked] = useState<{ number: string | null; workOrderId: string | null } | null>(null);

  const member = !!caller?.is_member;
  const disclosures = jt ? disclosuresFor(jt, { afterHours: !!pickedWindow?.is_after_hours, member }) : [];
  const missing = missingAnswers(jt?.script, answers);
  const unacked = missedDisclosures(disclosures, acks);
  const dup = duplicateOf(caller, siteId || null);
  const dns = site?.do_not_service ?? false;
  const canBook = !!jt && !!buId && !!pick && !missing.length && !unacked.length && (!dup || allowDup) && (!full || override.trim().length >= 5) && !dns && !readOnly;

  const reset = () => {
    setPhone(''); setCustomerId(null); setJobTypeId(''); setBuId(''); setCampaignId(''); setSiteId(''); setZip(''); setPick(null);
    setAnswers({}); setAcks([]); setSummary(''); setPriority(null); setOverride(''); setAllowDup(false); setNotBooked(''); setErr(null);
  };

  async function book() {
    if (!jt || !pick) return;
    setBusy(true); setErr(null);
    const r = await api.post<{ callNumber: string | null; workOrderId: string | null; workOrderNumber: string | null; override: boolean }>('/api/fieldservice/calls', {
      op: 'book', companyId: p.companyId, channel: 'PHONE', bookingJobTypeId: jt.id, businessUnitId: buId || null, arrivalWindowId: pick.windowId,
      serviceDay: pick.day, customerId: customerId ?? caller?.customer?.id ?? null, siteId: siteId || null, siteZip: !siteId && zip ? zip : null,
      zoneId, campaignId: campaignId || null, summary: summary || null, priority, answers, disclosures: acks,
      caller: { phone: normPhone(phone) || null, name: caller?.customer?.name ?? null }, overrideReason: full ? override : null, allowDuplicate: allowDup,
      requestId: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    });
    setBusy(false);
    void grid.refetch();
    if (r.error) { setErr(r.error.error); return; }
    toast(`Booked ${r.data?.workOrderNumber ?? ''}${r.data?.override ? ' (over capacity)' : ''}`);
    setBooked({ number: r.data?.workOrderNumber ?? null, workOrderId: r.data?.workOrderId ?? null });
  }

  async function logNotBooked() {
    setBusy(true); setErr(null);
    const r = await api.post('/api/fieldservice/calls', {
      op: 'log', companyId: p.companyId, channel: 'PHONE', outcome: 'NOT_BOOKED', reason: notBooked, customerId: customerId ?? null,
      caller: { phone: normPhone(phone) || null }, campaignId: campaignId || null, businessUnitId: buId || null, bookingJobTypeId: jobTypeId || null,
      summary: summary || null,
    });
    setBusy(false);
    if (r.error) { setErr(r.error.error); return; }
    toast('Logged the call as not booked');
    reset();
  }

  return (
    <div className="fs-grid fs-grid--wide">
      <div className="stack">
        <section className="fs-card" aria-label="Caller">
          <div className="fs-card-h"><h2 className="t-section">01 // Caller</h2><span className="sp" /><span className="t-cap">{p.companyName}</span></div>
          <div className="fs-card-b">
            <div className="fs-form">
              <Field label="Caller phone" help="Caller ID fills this; type to search">
                <Input inputMode="tel" autoFocus value={phone} onChange={(e) => { setPhone(e.target.value); setCustomerId(null); setBooked(null); }} placeholder="(515) 555-0101" />
              </Field>
              <Field label="Customer">
                <Select value={customerId ?? ''} onChange={(e) => setCustomerId(e.target.value || null)} disabled={!caller?.matches?.length}>
                  <option value="">{caller?.matches?.length ? 'Pick the caller' : popUrl ? 'No match — new customer' : 'Search by phone first'}</option>
                  {(caller?.matches ?? []).map((m) => <option key={m.customer_id} value={m.customer_id}>{m.name} · {m.matched}</option>)}
                </Select>
              </Field>
            </div>
            {pop.isLoading && <WidgetState state={{ kind: 'loading', label: 'Looking up the caller…', lines: 2 }} />}
            {pop.error && <InlineNotice tone="neg" title="The caller lookup failed.">{pop.error}</InlineNotice>}
            {caller?.tracking_campaign && <p className="t-cap">Called the {caller.tracking_campaign.name} line — campaign set.</p>}
          </div>
        </section>

        {booked ? (
          <section className="fs-card" aria-live="polite">
            <div className="fs-card-b">
              <WidgetState state={{ kind: 'done', title: `Booked ${booked.number ?? ''}`, body: 'The visit is on the dispatch board’s unassigned list with its arrival window.' }} />
              <div className="row" style={{ gap: 8 }}>
                {booked.workOrderId && <ButtonLink href={`/dispatch?wo=${booked.workOrderId}&day=${pick?.day ?? p.today}`} variant="primary">Open on the board</ButtonLink>}
                <Button onClick={reset}>Next call</Button>
              </div>
            </div>
          </section>
        ) : (
          <section className="fs-card" aria-label="Book the call">
            <div className="fs-card-h"><h2 className="t-section">02 // Book</h2></div>
            <div className="fs-card-b">
              <div className="fs-form">
                <Field label="Job type">
                  <Select value={jobTypeId} onChange={(e) => { setJobTypeId(e.target.value); setAnswers({}); setAcks([]); }}>
                    <option value="">Pick what the caller needs</option>
                    {p.setup.jobTypes.filter((j) => j.is_active).map((j) => <option key={j.id} value={j.id}>{j.label}</option>)}
                  </Select>
                </Field>
                <Field label="Business unit">
                  <Select value={buId} onChange={(e) => { setBuId(e.target.value); setPick(null); }}>
                    <option value="">Pick</option>
                    {p.setup.businessUnits.filter((b) => b.is_active).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </Select>
                </Field>
                <Field label="Service location">
                  <Select value={siteId} onChange={(e) => { setSiteId(e.target.value); setPick(null); }} disabled={!caller?.sites?.length}>
                    <option value="">{caller?.sites?.length ? 'Pick the address' : 'New address — type the zip'}</option>
                    {(caller?.sites ?? []).map((s) => <option key={s.id} value={s.id}>{s.address}{s.do_not_service ? ' · DO NOT SERVICE' : ''}</option>)}
                  </Select>
                </Field>
                {!siteId && (
                  <Field label="Zip" help={zoneId ? `Zone ${p.setup.zones.find((z) => z.id === zoneId)?.name ?? ''}` : zip.length === 5 ? 'Outside every zone' : undefined}>
                    <Input inputMode="numeric" maxLength={5} value={zip} onChange={(e) => setZip(e.target.value.replace(/\D/g, ''))} />
                  </Field>
                )}
                <Field label="Campaign / lead source">
                  <Select value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
                    <option value="">Unattributed</option>
                    {p.setup.campaigns.filter((c) => c.is_active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </Select>
                </Field>
                <Field label="Priority">
                  <Select value={String(priority ?? jt?.default_priority ?? 3)} onChange={(e) => setPriority(Number(e.target.value))}>
                    <option value="1">1 · Emergency</option><option value="2">2 · Urgent</option><option value="3">3 · Normal</option><option value="4">4 · Flexible</option>
                  </Select>
                </Field>
                <div className="fs-span">
                  <Field label="What is going on" help="In the caller’s words — the technician reads this before arriving">
                    <Textarea rows={2} maxLength={500} value={summary} onChange={(e) => setSummary(e.target.value)} />
                  </Field>
                </div>
              </div>
              {dns && <InlineNotice tone="neg" title="Do not service this location.">{site?.do_not_service_reason ?? 'A manager flagged this site.'} Check with a manager before booking.</InlineNotice>}
              {dup && (
                <InlineNotice tone="warn" title={`${dup.number} is already open here.`}>
                  {dup.summary}. <Link href={`/dispatch?wo=${dup.work_order_id}`}>Open it</Link> instead, or book a new job anyway.
                  <div style={{ marginTop: 8 }}><Check checked={allowDup} onChange={(e) => setAllowDup(e.target.checked)} label="This is a different problem — book a new job" /></div>
                </InlineNotice>
              )}
            </div>
          </section>
        )}

        {!booked && jt && (
          <section className="fs-card fs-script" aria-label="Call script">
            <div className="fs-card-h"><h2 className="t-section">03 // Script — {jt.label}</h2><span className="sp" />{missing.length > 0 && <Tag tone="warn">{count(missing.length)} to ask</Tag>}</div>
            <div className="fs-card-b">
              {(jt.script.questions ?? []).length === 0 && <p className="t-cap">No questions for this job type.</p>}
              {(jt.script.questions ?? []).map((qn) => (
                <Field key={qn.id} label={`${qn.prompt}${qn.required ? ' *' : ''}`}>
                  {qn.kind === 'yesno' ? (
                    <Select value={answers[qn.id] === true ? 'yes' : answers[qn.id] === false ? 'no' : ''} onChange={(e) => setAnswers({ ...answers, [qn.id]: e.target.value === 'yes' ? true : e.target.value === 'no' ? false : '' })}>
                      <option value="">—</option><option value="yes">Yes</option><option value="no">No</option>
                    </Select>
                  ) : qn.kind === 'choice' ? (
                    <Select value={String(answers[qn.id] ?? '')} onChange={(e) => setAnswers({ ...answers, [qn.id]: e.target.value })}>
                      <option value="">—</option>
                      {(qn.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
                    </Select>
                  ) : (
                    <Input value={String(answers[qn.id] ?? '')} onChange={(e) => setAnswers({ ...answers, [qn.id]: e.target.value })} maxLength={500} />
                  )}
                </Field>
              ))}
              {disclosures.length > 0 && (
                <div className="stack" style={{ marginTop: 12 }}>
                  <span className="eyebrow">Say this</span>
                  {disclosures.map((d) => (
                    <div key={d.id}>
                      <blockquote>{d.rendered}</blockquote>
                      <Check checked={acks.includes(d.id)} onChange={(e) => setAcks(e.target.checked ? [...acks, d.id] : acks.filter((x) => x !== d.id))} label="Told the caller" />
                    </div>
                  ))}
                </div>
              )}
              {member && jt.member_waives_diagnostic && jt.diagnostic_fee_cents != null && <p className="t-cap">Member — the diagnostic fee is waived.</p>}
              {(jt.script.rebuttals ?? []).length > 0 && (
                <details style={{ marginTop: 12 }}>
                  <summary className="t-ui">If they push back</summary>
                  <ul className="fs-list">{(jt.script.rebuttals ?? []).map((r) => <li key={r.objection}><span><span className="l1">“{r.objection}”</span><span className="l2">{r.answer}</span></span></li>)}</ul>
                </details>
              )}
            </div>
          </section>
        )}

        {!booked && (
          <section className="fs-card" aria-label="Arrival window">
            <div className="fs-card-h">
              <h2 className="t-section">04 // Arrival window</h2><span className="sp" />
              <Button variant="quiet" onClick={() => setFrom(addDays(from, -5) < p.today ? p.today : addDays(from, -5))} disabled={from <= p.today}>Earlier</Button>
              <Button variant="quiet" onClick={() => setFrom(addDays(from, 5))}>Later</Button>
            </div>
            <div className="fs-card-b">
              {grid.isLoading && !grid.data && <WidgetState state={{ kind: 'loading', label: 'Loading capacity…', lines: 4 }} />}
              {grid.error && <WidgetState state={{ kind: 'error', title: 'Capacity did not load', body: grid.error, onRetry: () => void grid.refetch(), retryLabel: 'Try again' }} />}
              {grid.data && (
                <CapacityGrid cells={grid.data.cells} windows={p.setup.windows} businessUnitId={buId || null} days={days} today={p.today} value={pick}
                  onPick={(x) => { setPick(x); setOverride(''); }} allowFull={p.canOverride} />
              )}
              {pick && pickedWindow && !(pickedWindow.days_of_week.includes(isoDow(pick.day))) && <InlineNotice tone="warn" title="That window is not offered that day." />}
              {full && (
                <Field label="Over capacity — why book it anyway?" help="Dispatch sees the reason on the call">
                  <Input value={override} onChange={(e) => setOverride(e.target.value)} maxLength={300} placeholder="Member no-heat, GM approved" />
                </Field>
              )}
            </div>
          </section>
        )}

        {!booked && (
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <Button variant="primary" disabled={!canBook || busy} onClick={() => void book()} chord="mod+enter">Book {pick ? `${shortDate(pick.day, p.today)} ${pickedWindow?.label ?? ''}` : ''}</Button>
            {!canBook && jt && (
              <span className="t-cap">
                {[!buId && 'pick the business unit', !pick && 'pick a window', missing.length > 0 && `${missing.length} required question(s)`, unacked.length > 0 && 'read the fee disclosure', dup && !allowDup && 'decide on the open job', full && override.trim().length < 5 && 'give the override reason'].filter(Boolean).join(' · ')}
              </span>
            )}
            <span className="sp" />
            <Input aria-label="Why it did not book" value={notBooked} onChange={(e) => setNotBooked(e.target.value)} placeholder="Why it did not book (price, timing, shopping)" style={{ width: 280 }} />
            <Button disabled={notBooked.trim().length < 3 || busy || readOnly} onClick={() => void logNotBooked()}>Log not booked</Button>
          </div>
        )}
        {err && <InlineNotice tone="neg" title="Not booked." role="alert">{err}</InlineNotice>}
      </div>

      <aside className="stack" aria-label="Caller details">
        <PopPanel pop={caller} today={p.today} />
        <RequestsInbox requests={p.requests} setup={p.setup} today={p.today} readOnly={readOnly} />
        <section className="fs-card" aria-label="Recent calls">
          <div className="fs-card-h"><h2 className="t-section">Recent calls</h2><span className="sp" /><Link className="link t-cap" href="/calls/campaigns">Booking rate by campaign</Link></div>
          {p.recent.length === 0 ? <div className="fs-card-b"><WidgetState state={{ kind: 'empty', title: 'No calls yet today', body: 'Every call you book or log shows here.' }} /></div> : (
            <ul className="fs-list">
              {p.recent.slice(0, 15).map((c) => (
                <li key={c.id}>
                  <span><span className="l1"><span className="code">{c.number}</span> {c.caller_name ?? fmtPhone(c.caller_phone) ?? 'Caller'}</span><span className="l2">{c.summary ?? c.not_booked_reason ?? '—'}</span></span>
                  <span className="sp" />
                  <Status kind={c.status === 'BOOKED' ? 'ready' : c.status === 'NOT_BOOKED' ? 'risk' : 'track'}>{c.status === 'BOOKED' ? 'Booked' : c.status === 'NOT_BOOKED' ? 'Not booked' : c.status === 'CANCELLED' ? 'Cancelled' : 'Open'}</Status>
                  {c.work_order_id && <Link className="link t-cap" href={`/dispatch/visit/${c.work_order_id}`}>Visit</Link>}
                </li>
              ))}
            </ul>
          )}
        </section>
      </aside>
    </div>
  );
}

function PopPanel({ pop, today }: { pop: CallerPop | null; today: string }) {
  if (!pop?.customer) {
    return (
      <section className="fs-card" aria-label="Customer">
        <div className="fs-card-b"><WidgetState state={{ kind: 'empty', title: 'No caller yet', body: 'Type the caller’s number; their history, equipment, membership and balance show here.' }} /></div>
      </section>
    );
  }
  const ar = pop.ar;
  const agr = pop.agreements ?? [];
  return (
    <section className="fs-card" aria-label="Customer">
      <div className="fs-card-h">
        <span><span className="t-head">{pop.customer.name}</span><br /><span className="t-cap">{pop.customer.address ?? fmtPhone(pop.customer.phone)}</span></span>
        <span className="sp" />
        {pop.is_member ? <Tag tone="pos">Member</Tag> : agr.some((a) => a.suspended) ? <Tag tone="warn">Membership on hold</Tag> : <Tag>Not a member</Tag>}
      </div>
      <div className="fs-card-b">
        <div className="fs-flags">
          {ar?.past_due && <Tag tone="neg">Past due{ar.oldest_past_due_days ? ` ${ar.oldest_past_due_days} days` : ''}{ar.amounts_visible && ar.past_due_cents != null ? ` · ${money(ar.past_due_cents)}` : ''}</Tag>}
          {ar?.has_balance && !ar.past_due && <Tag tone="warn">Open balance{ar.amounts_visible && ar.open_cents != null ? ` · ${money(ar.open_cents)}` : ''}</Tag>}
          {ar && !ar.has_balance && ar.available && <Tag>No balance due</Tag>}
          {(pop.sites ?? []).some((s) => s.do_not_service) && <Tag tone="neg">Do-not-service site</Tag>}
          {(pop.open_estimates ?? []).length > 0 && <Tag tone="ai">{count(pop.open_estimates!.length)} open estimate(s)</Tag>}
        </div>
        {pop.summary && <p className="t-cap fs-pre">{pop.summary}</p>}
        {agr.map((a) => (
          <p key={a.agreement_id} className="t-ui"><b>{a.plan}{a.tier ? ` · ${a.tier}` : ''}</b> <span className="t-cap">{a.number} · ends {shortDate(a.ends_on, today)} · {count(a.visits_owed)} visit(s) owed{a.suspended ? ' · payments failing' : ''}</span></p>
        ))}
      </div>
      {(pop.equipment ?? []).length > 0 && (
        <>
          <div className="fs-card-h"><span className="eyebrow">Equipment</span></div>
          <ul className="fs-list">
            {pop.equipment!.slice(0, 6).map((e) => (
              <li key={e.asset_id}><span><span className="l1">{[e.make, e.model].filter(Boolean).join(' ') || e.type || 'Equipment'}</span><span className="l2">{e.age_years != null ? `${e.age_years} yr` : 'age unknown'}{e.refrigerant ? ` · ${e.refrigerant}` : ''}{e.parts_warranty_ends_on && e.parts_warranty_ends_on >= today ? ' · parts warranty' : ''}{e.labor_warranty_ends_on && e.labor_warranty_ends_on >= today ? ' · labor warranty' : ''}</span></span></li>
            ))}
          </ul>
        </>
      )}
      {(pop.recent_visits ?? []).length > 0 && (
        <>
          <div className="fs-card-h"><span className="eyebrow">Last visits</span></div>
          <ul className="fs-list">
            {pop.recent_visits!.map((v) => (
              <li key={v.work_order_id}><span><span className="l1"><span className="code">{v.number}</span> {v.summary}</span><span className="l2">{shortDate(v.when, today)}{v.is_callback ? ' · recall' : ''}{v.resolution ? ` · ${v.resolution}` : ''}</span></span></li>
            ))}
          </ul>
        </>
      )}
      {(pop.open_work ?? []).length > 0 && (
        <>
          <div className="fs-card-h"><span className="eyebrow">Open work</span></div>
          <ul className="fs-list">
            {pop.open_work!.map((w) => <li key={w.work_order_id}><Link className="link" href={`/dispatch/visit/${w.work_order_id}`}><span className="code">{w.number}</span> {w.summary}</Link><span className="sp" /><span className="t-cap">{w.service_day ? shortDate(w.service_day, today) : 'unscheduled'}</span></li>)}
          </ul>
        </>
      )}
    </section>
  );
}

function RequestsInbox({ requests, setup, today, readOnly }: { requests: CallRow[]; setup: BookingSetup; today: string; readOnly: boolean }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<Set<string>>(new Set());
  const label = (id: string | null, list: ReadonlyArray<{ id: string; label?: string; name?: string }>) => (id ? list.find((x) => x.id === id) : undefined);
  async function act(c: CallRow, op: 'convert' | 'close') {
    setBusy(c.id); setErr(null);
    const r = await api.post(`/api/fieldservice/calls/${c.id}`, op === 'convert' ? { op, allowDuplicate: false } : { op, status: 'NOT_BOOKED', reason: 'Declined from the requests inbox' });
    setBusy(null);
    if (r.error) { setErr(r.error.error); return; }
    toast(op === 'convert' ? `Converted ${c.number}` : `Declined ${c.number}`);
    setDone(new Set([...done, c.id]));
  }
  const open = requests.filter((r) => !done.has(r.id));
  return (
    <section className="fs-card" aria-label="Requests inbox">
      <div className="fs-card-h"><h2 className="t-section">Requests</h2><span className="tnum b">{count(open.length)}</span><span className="sp" /><span className="t-cap">Website and marketplace bookings hold their slot until you convert them</span></div>
      {open.length === 0 ? <div className="fs-card-b"><WidgetState state={{ kind: 'empty', title: 'No waiting requests', body: 'Online bookings land here with the window the customer chose.' }} /></div> : (
        <ul className="fs-list">
          {open.map((c) => {
            const hours = Math.round((Date.now() - Date.parse(c.created_at)) / 3_600_000);
            return (
              <li key={c.id}>
                <span>
                  <span className="l1"><span className="code">{c.number}</span> {c.caller_name ?? 'Web customer'} · {fmtPhone(c.caller_phone)}</span>
                  <span className="l2">{label(c.booking_job_type_id, setup.jobTypes)?.label ?? 'Service'} · {c.service_day ? shortDate(c.service_day, today) : ''} {label(c.arrival_window_id, setup.windows)?.label ?? ''} · {c.site_zip ?? ''} · waiting {hours < 1 ? 'under an hour' : `${hours} h`}</span>
                  {c.summary && <span className="l2">{c.summary}</span>}
                </span>
                <span className="sp" />
                {!readOnly && <Button size="md" variant="primary" disabled={busy === c.id} onClick={() => void act(c, 'convert')}>Convert</Button>}
                {!readOnly && <Button size="md" variant="quiet" disabled={busy === c.id} onClick={() => void act(c, 'close')}>Decline</Button>}
              </li>
            );
          })}
        </ul>
      )}
      {err && <div className="fs-card-b"><InlineNotice tone="neg" title="Not changed.">{err}</InlineNotice></div>}
    </section>
  );
}

'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Bands, Button, ButtonLink, Check, ConfirmDialog, Field, Input, KV, MoneyInput, Panel, PanelSection, QueueTable, Select, WidgetState,
  count, money, pct, shortDate, useEscapeKey, type QueueColumn,
} from '@meritbooks/merit-ui';
import { AGREEMENT_STATUS, WO_STATUS } from '@/lib/pm/ops/labels';
import type { AgreementRow, LookupItem, WorkOrderRow } from '@/lib/pm/ops/types';
import type { AgreementList } from '@/lib/pm/ops/field-queries';
import type { JobOption } from '@/lib/pm/ops/scope';
import { useShell, useVocab } from '@/components/shell/ShellContext';
import { lower } from '@/lib/pm/vocab';
import { Failure, JobSelect, PctInput, StatusMark, parseNum } from '../common/bits';
import { Lookup } from '../common/Lookup';
import { useOps } from '../common/useOps';

type Band = 'active' | 'renew' | 'draft' | 'ended';
type Visit = AgreementList['visits'][number];

export interface AgreementsViewProps {
  agreements: AgreementRow[];
  visits: Visit[];
  coveredAssets: Array<{ agreement_id: string; asset_id: string }>;
  assetLabels: Record<string, string>;
  customers: Record<string, string>;
  jobs: JobOption[];
  today: string;
  fixedJobId?: string | null;
}

const CADENCE: Record<AgreementRow['cadence'], string> = { MONTHLY: 'Monthly', QUARTERLY: 'Quarterly', SEMIANNUAL: 'Twice a year', ANNUAL: 'Yearly', CUSTOM: 'Custom' };
const BILLING: Record<AgreementRow['billing_frequency'], string> = { UPFRONT: 'paid up front', MONTHLY: 'a month', QUARTERLY: 'a quarter', ANNUAL: 'a year' };

function addYear(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d.toISOString().slice(0, 10);
}
function daysTo(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export function bandOf(a: AgreementRow, today: string): Band {
  if (a.status === 'DRAFT') return 'draft';
  if (a.status === 'ACTIVE' || a.status === 'SUSPENDED') return daysTo(today, a.ends_on) <= 60 ? 'renew' : 'active';
  return 'ended';
}

export function AgreementsView(p: AgreementsViewProps) {
  const { readOnly } = useShell();
  const [band, setBand] = useState<Band>('active');
  const [cursor, setCursor] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const visitsOf = useMemo(() => {
    const m = new Map<string, Visit[]>();
    for (const x of p.visits) if (x.agreement_id) m.set(x.agreement_id, [...(m.get(x.agreement_id) ?? []), x]);
    return m;
  }, [p.visits]);
  const overdue = p.visits.filter((x) => (x.status === 'NEW' || x.status === 'ON_HOLD') && (x.due_by ?? x.due_on ?? '9999') < p.today);
  const byBand = (b: Band) => p.agreements.filter((a) => bandOf(a, p.today) === b);
  const rows = byBand(band);
  const cur = p.agreements.find((a) => a.id === cursor) ?? null;
  const agreementOf = new Map(p.agreements.map((a) => [a.id, a]));

  const columns: QueueColumn<AgreementRow>[] = [
    { id: 'n', header: 'Number', width: 132, cell: (a) => <span className="code">{a.number}</span> },
    { id: 'plan', header: 'Plan', cell: (a) => <><span className="l1">{a.plan_name}{a.tier ? ` · ${a.tier}` : ''}</span><span className="l2">{p.customers[a.customer_id] ?? 'Customer'}</span></> },
    { id: 'term', header: 'Term', width: 170, cell: (a) => <><span className="l1">{shortDate(a.starts_on, p.today)} to {shortDate(a.ends_on, p.today)}</span><span className="l2">{CADENCE[a.cadence]}{a.auto_renew ? ' · renews' : ''}</span></> },
    {
      id: 'visits', header: 'Visits', width: 150, cell: (a) => {
        const vs = visitsOf.get(a.id) ?? [];
        const done = vs.filter((x) => x.status === 'COMPLETE' || x.status === 'CLOSED').length;
        const late = vs.filter((x) => (x.status === 'NEW' || x.status === 'ON_HOLD') && (x.due_by ?? x.due_on ?? '9999') < p.today).length;
        return <><span className="l1 tnum">{count(done)} of {count(a.visits_per_term ?? vs.length)} done</span><span className={late ? 'l2 neg b' : 'l2'}>{late ? `${count(late)} overdue` : vs.length ? `${count(vs.length)} generated` : 'None generated'}</span></>;
      },
    },
    { id: 'price', header: 'Price', numeric: true, width: 140, cell: (a) => <><span className="l1">{money(a.price_cents)}</span><span className="l2">{BILLING[a.billing_frequency]}</span></> },
    { id: 'st', header: 'Status', width: 120, cell: (a) => <StatusMark mark={AGREEMENT_STATUS[a.status]} /> },
  ];

  return (
    <div className="stack">
      {overdue.length > 0 && (
        <section className="mp-table" aria-label="Agreement visits overdue">
          <div className="row" style={{ padding: '12px 16px', borderBottom: '1px solid var(--line)', gap: 12 }}>
            <span className="t-section">Visits owed and past their window</span><span className="tnum b neg">{count(overdue.length)}</span>
            <span className="t-cap">Book these first; members notice.</span>
          </div>
          <ul className="feed">
            {overdue.slice(0, 12).map((x) => {
              const a = x.agreement_id ? agreementOf.get(x.agreement_id) : null;
              return (
                <li key={x.id}>
                  <span><span className="l1" style={{ fontWeight: 400 }}><span className="code">{x.number}</span> {x.summary}</span><span className="l2">{a ? `${p.customers[a.customer_id] ?? ''} · ${a.number}` : ''} · window ended {shortDate((x.due_by ?? x.due_on)!, p.today)}</span></span>
                  {!readOnly && <ButtonLink variant="quiet" href={`/dispatch?wo=${x.id}`}>Schedule</ButtonLink>}
                </li>
              );
            })}
          </ul>
          {overdue.length > 12 && <p className="t-cap" style={{ padding: 12 }}>And {count(overdue.length - 12)} more on the dispatch board’s unassigned list.</p>}
        </section>
      )}

      <div className="ops-toolbar">
        <div style={{ flex: 1, maxWidth: 760 }}>
          <Bands<Band>
            aria-label="Agreements by status"
            value={band}
            onChange={setBand}
            items={[
              { value: 'active', label: 'Active', count: count(byBand('active').length), caption: money(byBand('active').reduce((s, a) => s + a.price_cents, 0)) + ' per billing period' },
              { value: 'renew', label: 'Ending in 60 days', count: count(byBand('renew').length), caption: 'Renew before they lapse' },
              { value: 'draft', label: 'Draft', count: count(byBand('draft').length), caption: 'Not active yet' },
              { value: 'ended', label: 'Ended', count: count(byBand('ended').length), caption: 'Renewed, expired or cancelled' },
            ]}
          />
        </div>
        <span className="sp" />
        {!readOnly && <Button variant="primary" icon="plus" chord="n" bindChord={!creating} onClick={() => { setCreating(true); setCursor(null); }}>New agreement</Button>}
      </div>

      <div className={creating || cur ? 'ops-split has-panel' : 'ops-split'}>
        <div className="mp-table" style={{ minWidth: 0 }}>
          {rows.length === 0 ? (
            <WidgetState state={p.agreements.length === 0
              ? { kind: 'empty', title: 'No agreements yet', body: 'Add a membership: plan, term, visits a year and price. Activate it, then generate its visits; they land on the dispatch board when due.', action: readOnly ? undefined : <Button variant="primary" onClick={() => setCreating(true)}>New agreement</Button> }
              : { kind: 'done', title: band === 'renew' ? 'Nothing ends in the next 60 days' : 'Nothing in this band', body: 'Switch the band above to see the others.' }} />
          ) : (
            <QueueTable aria-label="Agreements" columns={columns} rows={rows} getRowId={(a) => a.id} cursorId={cursor} onCursorChange={(id) => { setCursor(id); setCreating(false); }} onOpen={(a) => setCursor(a.id)}
              rowState={(a) => ({ done: a.status === 'CANCELLED' || a.status === 'EXPIRED' || a.status === 'RENEWED', attn: (visitsOf.get(a.id) ?? []).some((x) => (x.status === 'NEW' || x.status === 'ON_HOLD') && (x.due_by ?? x.due_on ?? '9999') < p.today) })} />
          )}
        </div>
        {creating ? (
          <NewAgreementPanel jobs={p.jobs} today={p.today} fixedJobId={p.fixedJobId} onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); setCursor(id); setBand('draft'); }} />
        ) : cur ? (
          <AgreementPanel a={cur} visits={visitsOf.get(cur.id) ?? []} assets={p.coveredAssets.filter((x) => x.agreement_id === cur.id).map((x) => ({ id: x.asset_id, label: p.assetLabels[x.asset_id] ?? 'Equipment' }))} customer={p.customers[cur.customer_id] ?? 'Customer'} today={p.today} onClose={() => setCursor(null)} />
        ) : null}
      </div>
    </div>
  );
}

function AgreementPanel({ a, visits, assets, customer, today, onClose }: { a: AgreementRow; visits: Visit[]; assets: Array<{ id: string; label: string }>; customer: string; today: string; onClose: () => void }) {
  const { readOnly } = useShell();
  const v = useVocab();
  const { act, busy, error } = useOps();
  const url = `/api/ops/agreements/${a.id}`;
  const [horizon, setHorizon] = useState('365');
  const [renewPrice, setRenewPrice] = useState<number | null>(null);
  const [renewing, setRenewing] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [cover, setCover] = useState<LookupItem | null>(null);
  const live = a.status === 'ACTIVE' || a.status === 'SUSPENDED';
  return (
    <Panel
      eyebrow={[a.number ?? 'Agreement', AGREEMENT_STATUS[a.status].word]}
      title={a.plan_name}
      meta={`${customer} · ${money(a.price_cents)} ${BILLING[a.billing_frequency]}`}
      onClose={onClose}
      foot={readOnly ? undefined : (
        <div className="btn-row" style={{ width: '100%' }}>
          {(a.status === 'DRAFT' || live) && <Button variant="quiet" onClick={() => setCancelOpen(true)}>Cancel</Button>}
          {a.status === 'DRAFT' && <Button variant="quiet" onClick={() => setDeleteOpen(true)}>Delete draft</Button>}
          <span className="sp" />
          {(a.status === 'ACTIVE' || a.status === 'EXPIRED' || a.status === 'SUSPENDED') && <Button onClick={() => setRenewing(!renewing)}>Renew</Button>}
          {(a.status === 'DRAFT' || a.status === 'SUSPENDED') && <Button variant="primary" disabled={busy === 'activate'} onClick={() => void act('activate', 'post', url, { op: 'activate' }, `Activated ${a.number}`)}>Activate</Button>}
        </div>
      )}
    >
      <PanelSection>
        <KV items={[
          { term: 'Term', value: `${shortDate(a.starts_on, today)} to ${shortDate(a.ends_on, today)}` },
          { term: 'Visits', value: `${CADENCE[a.cadence]}${a.visits_per_term ? `, ${a.visits_per_term} a term` : ''}` },
          { term: 'Visit window', value: `${a.visit_window_days} days · ${a.visit_minutes} minutes each` },
          ...(a.member_discount_pct != null ? [{ term: 'Member discount', value: pct(a.member_discount_pct) }] : []),
          { term: 'Renews automatically', value: a.auto_renew ? 'Yes' : 'No' },
          ...(a.cancel_reason ? [{ term: 'Cancelled because', value: a.cancel_reason }] : []),
        ]} />
        <p className="t-cap" style={{ marginTop: 8 }}>Merit Books bills the agreement on its {lower(v.job)}; price and term lock once it is active and change by renewing.</p>
        {error && <div style={{ marginTop: 8 }}><Failure text={error} /></div>}
      </PanelSection>

      {renewing && !readOnly && (
        <PanelSection title="Renew">
          <form className="mp-form" onSubmit={(e) => { e.preventDefault(); void act('renew', 'post', url, { op: 'renew', priceCents: renewPrice }, `Renewed ${a.number}`).then((r) => { if (r) setRenewing(false); }); }}>
            <p className="t-cap">The next term starts {shortDate(a.ends_on, today)} and runs the same length. Covered equipment carries over.</p>
            <Field label="New price" help="Blank keeps the current price"><MoneyInput valueCents={renewPrice} onChangeCents={setRenewPrice} placeholder={money(a.price_cents)} /></Field>
            <div className="btn-row"><Button onClick={() => setRenewing(false)}>Back</Button><Button type="submit" variant="primary" disabled={busy === 'renew'}>Renew</Button></div>
          </form>
        </PanelSection>
      )}

      <PanelSection title="Visits" meta={`${visits.length} generated`}>
        {a.status === 'ACTIVE' && !readOnly && (
          <form className="row" style={{ gap: 8, marginBottom: 12, alignItems: 'flex-end' }} onSubmit={(e) => { e.preventDefault(); void act<{ created: number }>('gen', 'post', url, { op: 'generate', horizonDays: Number(horizon) }, (d) => (d.created ? `Generated ${d.created} visit${d.created === 1 ? '' : 's'}` : 'Every visit in that horizon already exists')); }}>
            <Field label="Generate visits due in the next">
              <Select value={horizon} onChange={(e) => setHorizon(e.target.value)}>
                <option value="90">90 days</option><option value="180">6 months</option><option value="365">12 months</option><option value="730">2 years</option>
              </Select>
            </Field>
            <Button type="submit" disabled={busy === 'gen'}>Generate</Button>
          </form>
        )}
        {visits.length === 0 ? (
          <p className="t-cap">{a.status === 'ACTIVE' ? 'None yet. Generate them; running it again never duplicates a visit.' : 'Visits are generated once the agreement is active.'}</p>
        ) : (
          <ul className="feed feed--flush">
            {visits.map((x: Visit) => {
              const late = (x.status === 'NEW' || x.status === 'ON_HOLD') && (x.due_by ?? x.due_on ?? '9999') < today;
              return (
                <li key={x.id}>
                  <span>
                    <span className="l1" style={{ fontWeight: 400 }}>Visit {x.visit_seq} · <Link className="nlink" href={`/work-orders?wo=${x.id}`}>{x.number}</Link></span>
                    <span className={late ? 'l2 neg b' : 'l2'}>{x.due_on ? `due ${shortDate(x.due_on, today)}${x.due_by ? ` to ${shortDate(x.due_by, today)}` : ''}` : ''}{late ? ' · overdue' : ''}</span>
                  </span>
                  <span className="t">{WO_STATUS[x.status as WorkOrderRow['status']]?.word ?? x.status}</span>
                </li>
              );
            })}
          </ul>
        )}
      </PanelSection>

      <PanelSection title="Covered equipment">
        <div className="ops-chips">
          {assets.length === 0 && <span className="t-cap">None listed. With one unit covered, generated visits are tied to it.</span>}
          {assets.map((x) => (
            <span key={x.id} className="tag" style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
              {x.label}
              {!readOnly && (a.status === 'DRAFT' || live) && <button type="button" className="btn btn--quiet btn--icon" aria-label={`Remove ${x.label}`} onClick={() => void act('cover', 'post', url, { op: 'uncover', assetId: x.id }, 'Removed the equipment')}>×</button>}
            </span>
          ))}
        </div>
        {!readOnly && (a.status === 'DRAFT' || live) && (
          <form className="row" style={{ gap: 8, marginTop: 8 }} onSubmit={(e) => { e.preventDefault(); if (cover) void act('cover', 'post', url, { op: 'cover', assetId: cover.id }, `Covered ${cover.label}`).then(() => setCover(null)); }}>
            <div style={{ flex: 1 }}><Lookup kind="assets" eager companyId={a.location_id} customerId={a.customer_id} value={cover ? { id: cover.id, label: cover.label } : null} onChange={setCover} placeholder="Add equipment on file" aria-label="Equipment to cover" /></div>
            <Button type="submit" disabled={!cover || busy === 'cover'}>Add</Button>
          </form>
        )}
      </PanelSection>

      <ConfirmDialog open={cancelOpen} onClose={() => setCancelOpen(false)} tone="danger" title={`Cancel ${a.number}`} confirmLabel="Cancel agreement" cancelLabel="Keep it"
        reason={{ label: 'Why', placeholder: 'Moved out of the area', minLength: 0 }}
        onConfirm={async (reason) => { const r = await act('cancel', 'post', url, { op: 'cancel', reason: reason || null, cancelOpenVisits: true }, `Cancelled ${a.number}`); if (!r) throw new Error('Not cancelled.'); }}>
        Visits not yet scheduled are cancelled with it. Refunds and the remaining deferred revenue are handled in Merit Books.
      </ConfirmDialog>
      <ConfirmDialog open={deleteOpen} onClose={() => setDeleteOpen(false)} tone="danger" title="Delete this draft" confirmLabel="Delete draft"
        onConfirm={async () => { const r = await act('delete', 'post', url, { op: 'delete' }, 'Deleted the draft'); if (!r) throw new Error('Not deleted.'); onClose(); }}>
        {a.plan_name} for {customer}. Nothing was billed; it was never active.
      </ConfirmDialog>
    </Panel>
  );
}

function NewAgreementPanel({ jobs, today, fixedJobId, onClose, onCreated }: { jobs: JobOption[]; today: string; fixedJobId?: string | null; onClose: () => void; onCreated: (id: string) => void }) {
  const v = useVocab();
  const { act, busy, error } = useOps();
  const [jobId, setJobId] = useState(fixedJobId ?? '');
  const job = jobs.find((j) => j.id === jobId) ?? null;
  const [customer, setCustomer] = useState<LookupItem | null>(null);
  const [plan, setPlan] = useState('');
  const [tier, setTier] = useState('');
  const [starts, setStarts] = useState(today);
  const [ends, setEnds] = useState(addYear(today));
  const [cadence, setCadence] = useState<AgreementRow['cadence']>('SEMIANNUAL');
  const [perTerm, setPerTerm] = useState('2');
  const [windowDays, setWindowDays] = useState('30');
  const [minutes, setMinutes] = useState('60');
  const [price, setPrice] = useState<number | null>(null);
  const [billing, setBilling] = useState<AgreementRow['billing_frequency']>('ANNUAL');
  const [discount, setDiscount] = useState<number | null>(0.15);
  const [autoRenew, setAutoRenew] = useState(true);
  const [err, setErr] = useState<Record<string, string>>({});
  useEscapeKey(onClose, busy !== 'create', 'New agreement');
  const custValue = customer ? { id: customer.id, label: customer.label } : job?.customerId ? { id: job.customerId, label: job.customer ?? 'Customer' } : null;

  const submit = async () => {
    const e: Record<string, string> = {};
    if (!jobId) e.job = `Pick the ${lower(v.job)} that bills this agreement.`;
    if (!custValue) e.customer = `Pick the ${lower(v.customer)} (from your customer list).`;
    if (!plan.trim()) e.plan = 'Name the plan.';
    if (!starts || !ends || ends <= starts) e.term = 'The term must end after it starts.';
    setErr(e);
    if (Object.keys(e).length) return;
    const r = await act<{ agreementId: string; number: string | null }>('create', 'post', '/api/ops/agreements', {
      jobId, customerId: custValue!.id, planName: plan.trim(), tier: tier.trim() || null, startsOn: starts, endsOn: ends, cadence,
      visitsPerTerm: parseNum(perTerm), visitWindowDays: parseNum(windowDays) ?? 30, visitMinutes: parseNum(minutes) ?? 60,
      priceCents: price ?? 0, billingFrequency: billing, memberDiscountPct: discount, autoRenew,
    }, (d) => `Created ${d.number ?? 'the agreement'} as a draft`);
    if (r) onCreated(r.agreementId);
  };

  return (
    <Panel eyebrow={['New', 'Agreement']} title={plan.trim() || 'New agreement'} meta="Starts as a draft; activate it to generate visits" onClose={onClose}
      foot={<div className="btn-row" style={{ justifyContent: 'flex-end', width: '100%' }}><Button onClick={onClose}>Cancel</Button><Button variant="primary" chord="mod+enter" bindChord disabled={busy === 'create'} onClick={() => void submit()}>Create draft</Button></div>}>
      <PanelSection>
        <form className="mp-form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          {!fixedJobId && <Field label={`${v.job} that bills it`} error={err.job} help="Usually the customer’s recurring-service job"><JobSelect jobs={jobs.filter((j) => j.open)} value={jobId} onChange={(id) => { setJobId(id); setCustomer(null); }} /></Field>}
          <Field label={v.customer} error={err.customer}><Lookup kind="customers" value={custValue} onChange={setCustomer} placeholder="Search your customer list" /></Field>
          <div className="mp-form-2">
            <Field label="Plan" error={err.plan}><Input autoFocus value={plan} onChange={(e) => setPlan(e.target.value)} placeholder="Comfort Club" maxLength={120} /></Field>
            <Field label="Tier"><Input value={tier} onChange={(e) => setTier(e.target.value)} placeholder="Gold" maxLength={60} /></Field>
          </div>
          <div className="mp-form-2">
            <Field label="Starts" error={err.term}><Input type="date" value={starts} onChange={(e) => { setStarts(e.target.value); if (e.target.value) setEnds(addYear(e.target.value)); }} /></Field>
            <Field label="Ends"><Input type="date" value={ends} onChange={(e) => setEnds(e.target.value)} /></Field>
          </div>
          <div className="mp-form-2">
            <Field label="Visits"><Select value={cadence} onChange={(e) => setCadence(e.target.value as AgreementRow['cadence'])}>{(['MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL'] as const).map((c) => <option key={c} value={c}>{CADENCE[c]}</option>)}</Select></Field>
            <Field label="Visits a term"><Input inputMode="numeric" value={perTerm} onChange={(e) => setPerTerm(e.target.value)} /></Field>
          </div>
          <div className="mp-form-2">
            <Field label="Window (days)" help="How long a visit can wait once due"><Input inputMode="numeric" value={windowDays} onChange={(e) => setWindowDays(e.target.value)} /></Field>
            <Field label="Minutes a visit"><Input inputMode="numeric" value={minutes} onChange={(e) => setMinutes(e.target.value)} /></Field>
          </div>
          <div className="mp-form-2">
            <Field label="Price"><MoneyInput valueCents={price} onChangeCents={setPrice} placeholder="0.00" /></Field>
            <Field label="Billed"><Select value={billing} onChange={(e) => setBilling(e.target.value as AgreementRow['billing_frequency'])}><option value="ANNUAL">Yearly</option><option value="MONTHLY">Monthly</option><option value="QUARTERLY">Quarterly</option><option value="UPFRONT">Up front</option></Select></Field>
          </div>
          <Field label="Member discount on repairs"><PctInput value={discount} onChange={setDiscount} placeholder="15" /></Field>
          <Check label="Renews automatically" checked={autoRenew} onChange={(e) => setAutoRenew(e.target.checked)} />
          <Failure text={error} />
          <button type="submit" hidden />
        </form>
      </PanelSection>
    </Panel>
  );
}

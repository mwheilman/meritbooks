'use client';

import { useMemo, useState } from 'react';
import { Button, Check, Field, Input, Panel, PanelSection, Seg, Select, Textarea, useEscapeKey } from '@meritbooks/merit-ui';
import { zonedToUtc, parseHhmm } from '@/lib/pm/ops/dispatch-math';
import { PRIORITY_WORDS, creatableKinds, woKindLabel, woVocab } from '@/lib/pm/ops/labels';
import type { LookupItem, SkillRow, WoKind } from '@/lib/pm/ops/types';
import type { JobOption } from '@/lib/pm/ops/scope';
import { useVocab } from '@/components/shell/ShellContext';
import { CustomerPicker, customerPending, customerPendingMessage, type CustomerValue } from '@/components/jobs/CustomerPicker';
import { lower } from '@/lib/pm/vocab';
import { Failure, JobSelect, parseNum } from '../common/bits';
import { Lookup } from '../common/Lookup';
import { useOps } from '../common/useOps';

export interface NewWorkOrderPanelProps {
  jobs: ReadonlyArray<JobOption>;
  jobTypes: ReadonlyArray<{ companyId: string; key: string; label: string }>;
  companies: ReadonlyArray<{ id: string; name: string }>;
  defaultCompanyId: string | null;
  packKey: string | null;
  skills: ReadonlyArray<SkillRow>;
  tz: string;
  today: string;
  /** Job tab: the job is fixed. */
  fixedJobId?: string | null;
  onClose: () => void;
  onCreated: (id: string) => void;
}

type Payer = 'CUSTOMER' | 'OEM' | 'INTERNAL';

/** One form for the call: who, what, which equipment, how urgent, and when they can be home. */
export function NewWorkOrderPanel(p: NewWorkOrderPanelProps) {
  const v = useVocab();
  const wv = woVocab(v);
  const { act, busy, error } = useOps();
  const kinds = creatableKinds(p.packKey);
  const [kind, setKind] = useState<WoKind>(kinds[0]!);
  const [mode, setMode] = useState<'existing' | 'new'>(p.fixedJobId || p.jobs.length ? 'existing' : 'new');
  const [jobId, setJobId] = useState(p.fixedJobId ?? '');
  const [companyId, setCompanyId] = useState(p.defaultCompanyId ?? p.companies[0]?.id ?? '');
  const typesHere = p.jobTypes.filter((t) => t.companyId === companyId);
  const [jobTypeKey, setJobTypeKey] = useState(typesHere[0]?.key ?? '');
  const [customer, setCustomer] = useState<CustomerValue>({ id: null, name: '' });
  const [summary, setSummary] = useState('');
  const [complaint, setComplaint] = useState('');
  const [priority, setPriority] = useState('3');
  const [asset, setAsset] = useState<LookupItem | null>(null);
  const [minutes, setMinutes] = useState('');
  const [skills, setSkills] = useState<string[]>([]);
  const [day, setDay] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [promised, setPromised] = useState('');
  const [payer, setPayer] = useState<Payer>('CUSTOMER');
  const [payerCustomer, setPayerCustomer] = useState<LookupItem | null>(null);
  const [callback, setCallback] = useState(false);
  const [err, setErr] = useState<Record<string, string>>({});
  useEscapeKey(p.onClose, busy !== 'create', 'New work order');

  const job = useMemo(() => p.jobs.find((j) => j.id === jobId) ?? null, [p.jobs, jobId]);
  const effCompany = mode === 'existing' ? job?.companyId ?? null : companyId;
  const customerId = mode === 'existing' ? job?.customerId ?? null : customer.id;
  const isRo = kind === 'REPAIR_ORDER';

  const submit = async () => {
    const e: Record<string, string> = {};
    if (!summary.trim()) e.summary = 'Say what the work is.';
    if (mode === 'existing' && !jobId) e.job = `Pick the ${lower(v.job)}.`;
    if (mode === 'new' && !jobTypeKey) e.job = `Pick a ${lower(v.job)} type.`;
    if (mode === 'new' && customerPending(customer)) e.customer = customerPendingMessage(customer);
    if (isRo && !asset) e.asset = 'A repair order needs the unit it is for.';
    if (payer === 'OEM' && !payerCustomer) e.payer = 'Pick the manufacturer.';
    const mins = minutes ? parseNum(minutes) : null;
    if (minutes && (mins == null || mins < 0)) e.minutes = 'Minutes, like 90.';
    let requestedStart: string | null = null;
    let requestedEnd: string | null = null;
    if (day) {
      const f = from ? parseHhmm(from) : 8 * 60;
      const t = to ? parseHhmm(to) : null;
      if (f == null) e.window = 'Use a time like 08:00.';
      else {
        requestedStart = zonedToUtc(day, f, p.tz).toISOString();
        if (t != null) {
          if (t <= f) e.window = 'The window ends before it starts.';
          else requestedEnd = zonedToUtc(day, t, p.tz).toISOString();
        }
      }
    }
    setErr(e);
    if (Object.keys(e).length) return;
    const r = await act<{ workOrderId: string; number: string | null }>('create', 'post', '/api/ops/work-orders', {
      jobId: mode === 'existing' ? jobId : null,
      newJob: mode === 'new' ? { companyId, jobTypeKey, name: (customer.name.trim() ? `${customer.name.trim()} · ` : '') + summary.trim().slice(0, 80), customerId: customer.id } : null,
      kind, summary: summary.trim(), priority: Number(priority), assetId: asset?.id ?? null, complaint: complaint.trim() || null,
      requestedStart, requestedEnd, estimatedMinutes: mins, requiredSkills: skills, payerType: payer, payerCustomerId: payer === 'OEM' ? payerCustomer?.id ?? null : null,
      promisedOn: promised || null, isCallback: callback,
    }, (d) => `Created ${d.number ?? lower(wv.one)}`);
    if (r) p.onCreated(r.workOrderId);
  };

  return (
    <Panel
      eyebrow={['New', woKindLabel(kind, v)]}
      title={summary.trim() || `New ${lower(woKindLabel(kind, v))}`}
      meta="The number is assigned when you create it"
      onClose={p.onClose}
      foot={
        <div className="btn-row" style={{ justifyContent: 'flex-end', width: '100%' }}>
          <Button onClick={p.onClose}>Cancel</Button>
          <Button variant="primary" chord="mod+enter" bindChord disabled={busy === 'create'} onClick={() => void submit()}>Create</Button>
        </div>
      }
    >
      <PanelSection>
        <form className="mp-form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <Field label="Kind">
            <Select value={kind} onChange={(e) => setKind(e.target.value as WoKind)}>
              {kinds.map((k) => <option key={k} value={k}>{woKindLabel(k, v)}</option>)}
            </Select>
          </Field>

          {!p.fixedJobId && (
            <Field label={v.job} error={err.job}>
              <Seg<'existing' | 'new'> aria-label={`Which ${lower(v.job)}`} value={mode} onChange={setMode} items={[{ value: 'existing', label: `Existing ${lower(v.job)}` }, { value: 'new', label: `New ${lower(v.job)}` }]} />
            </Field>
          )}
          {mode === 'existing' && !p.fixedJobId && <JobSelect jobs={p.jobs} value={jobId} onChange={(id) => { setJobId(id); setAsset(null); }} />}
          {mode === 'existing' && job && <p className="t-cap">{[job.customer ?? 'No customer on the job yet', job.company].filter(Boolean).join(' · ')}</p>}
          {mode === 'new' && (
            <>
              {p.companies.length > 1 && (
                <Field label="Company">
                  <Select value={companyId} onChange={(e) => { setCompanyId(e.target.value); setJobTypeKey(p.jobTypes.find((t) => t.companyId === e.target.value)?.key ?? ''); }}>
                    {p.companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </Select>
                </Field>
              )}
              <Field label={`${v.job} type`}>
                <Select value={jobTypeKey} onChange={(e) => setJobTypeKey(e.target.value)}>
                  {typesHere.length === 0 && <option value="">No {lower(v.job)} type uses dispatch</option>}
                  {typesHere.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
                </Select>
              </Field>
              <Field label={v.customer} error={err.customer}><CustomerPicker value={customer} onChange={(c) => { setCustomer(c); setAsset(null); }} companyId={companyId || null} invalid={!!err.customer} /></Field>
            </>
          )}

          <Field label="What is the work" error={err.summary}><Input autoFocus value={summary} onChange={(e) => setSummary(e.target.value)} placeholder={isRo ? 'Mower will not start' : 'No cooling upstairs'} maxLength={200} /></Field>
          <Field label={isRo ? 'Complaint (customer’s words)' : 'What the customer said'}><Textarea value={complaint} onChange={(e) => setComplaint(e.target.value)} maxLength={2000} /></Field>

          <Field label={isRo ? 'Unit' : 'Equipment'} error={err.asset} help={customerId ? `Showing equipment on file for this ${lower(v.customer)}` : 'Search by serial, make or model'}>
            <Lookup kind="assets" eager={!!customerId} companyId={effCompany} customerId={customerId} value={asset ? { id: asset.id, label: asset.label } : null} onChange={setAsset} placeholder={isRo ? 'Serial number' : 'Optional'} />
          </Field>

          <Field label="Priority">
            <Seg<string> aria-label="Priority" value={priority} onChange={setPriority} items={[1, 2, 3, 4].map((n) => ({ value: String(n), label: PRIORITY_WORDS[n]! }))} />
          </Field>

          <div className="mp-form-2">
            <Field label="Estimate (minutes)" error={err.minutes}><Input inputMode="numeric" value={minutes} onChange={(e) => setMinutes(e.target.value)} placeholder="90" /></Field>
            {isRo ? <Field label="Promised"><Input type="date" value={promised} onChange={(e) => setPromised(e.target.value)} min={p.today} /></Field> : <span />}
          </div>

          <Field label="Customer’s window" error={err.window} help="When someone can be home">
            <div className="row" style={{ gap: 8 }}>
              <Input type="date" aria-label="Day" value={day} onChange={(e) => setDay(e.target.value)} min={p.today} />
              <Input type="time" aria-label="From" step={900} value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: 120 }} />
              <Input type="time" aria-label="To" step={900} value={to} onChange={(e) => setTo(e.target.value)} style={{ width: 120 }} />
            </div>
          </Field>

          {p.skills.length > 0 && (
            <Field label="Needs a technician with">
              <div className="ops-chips">
                {p.skills.filter((s) => s.is_active).map((s) => (
                  <Check key={s.id} label={s.name} checked={skills.includes(s.code)} onChange={(e) => setSkills(e.target.checked ? [...skills, s.code] : skills.filter((x) => x !== s.code))} />
                ))}
              </div>
            </Field>
          )}

          <Field label="Who pays" error={err.payer}>
            <Seg<Payer> aria-label="Who pays" value={payer} onChange={setPayer} items={[{ value: 'CUSTOMER', label: v.customer }, { value: 'OEM', label: 'Manufacturer warranty' }, { value: 'INTERNAL', label: 'Internal' }]} />
          </Field>
          {payer === 'OEM' && <Lookup kind="customers" value={payerCustomer ? { id: payerCustomer.id, label: payerCustomer.label } : null} onChange={setPayerCustomer} placeholder="The manufacturer, as a customer in Merit Books" aria-label="Manufacturer" />}
          <Check label="Callback on earlier work (no charge, linked to the original)" checked={callback} onChange={(e) => setCallback(e.target.checked)} />
          <Failure text={error} />
          <button type="submit" hidden />
        </form>
      </PanelSection>
    </Panel>
  );
}

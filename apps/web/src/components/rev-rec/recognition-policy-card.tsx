'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Button,
  Check,
  Eyebrow,
  Field,
  InlineNotice,
  Input,
  MoneyInput,
  Search,
  Seg,
  Select,
  Switch,
  Tag,
  money,
  toast,
  useDebounce,
} from '@meritbooks/merit-ui';
import { useQuery } from '@/hooks';
import { useActiveCompany } from '@/lib/hooks/use-active-company';
import type { RevRecMethod } from '@/lib/services/rev-rec';
import type { CompanyRevRecPolicy, PostingMode, RetainagePresentation, RunCadence } from '@/lib/rev-rec/policy';
import { exampleFor } from '@/lib/rev-rec/examples';

/**
 * "How do you recognize revenue?" — the company's revenue-recognition election
 * (FPB-rev-rec-wip §3, §6). Plain-English method choice with a worked example entry in cents
 * (computed by the canonical engine, so it is exactly what the month-end run would book),
 * the three switches, cadence / posting / materiality / retainage, then job-type and job
 * overrides that show "inherits from company". Used on Revenue recognition and Settings.
 */

interface MethodOpt { value: RevRecMethod; label: string; short: string; who: string }
interface JobTypeRule { id: string; jobType: string; method: RevRecMethod; accrueUnderbillings: boolean | null; deferOverbillings: boolean | null }
interface JobRow {
  id: string;
  jobNumber: string | null;
  name: string | null;
  jobType: string | null;
  status: string | null;
  contractCents: number;
  method: RevRecMethod;
  methodOverride: RevRecMethod | null;
  methodSource: 'JOB' | 'REVENUE_TYPE' | 'JOB_TYPE' | 'COMPANY';
  override: { accrueUnderbillings: boolean | null; deferOverbillings: boolean | null; excludeFromWip: boolean; note: string | null } | null;
  resolved: { accrueUnderbillings: boolean; deferOverbillings: boolean; excluded: boolean; accrueSource: string; deferSource: string };
}
interface PolicyResponse {
  methods: MethodOpt[];
  company: { locationId: string; name: string; shortCode: string; defaultMethod: RevRecMethod };
  policy: CompanyRevRecPolicy;
  policyRowExists: boolean;
  projectsEntitled: boolean;
  jobTypes: JobTypeRule[];
  jobs: JobRow[];
}

type Tri = 'inherit' | 'on' | 'off';
const toTri = (v: boolean | null | undefined): Tri => (v == null ? 'inherit' : v ? 'on' : 'off');
const fromTri = (t: Tri): boolean | null => (t === 'inherit' ? null : t === 'on');
const usd = (c: number) => money(c, { symbol: '$', decimals: c % 100 === 0 ? 0 : 2 });
const METHOD_SOURCE_LABEL: Record<JobRow['methodSource'], string> = {
  JOB: 'Set on this job', REVENUE_TYPE: 'From the revenue type', JOB_TYPE: 'From the job type', COMPANY: 'Inherits from company',
};

async function save(body: unknown): Promise<boolean> {
  const res = await fetch('/api/rev-rec/policy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string; details?: string[] };
    toast.error(j.details?.[0] ?? j.error ?? 'Could not save');
    return false;
  }
  return true;
}

function TriSelect({ value, onChange, label, inheritLabel }: { value: Tri; onChange: (t: Tri) => void; label: string; inheritLabel: string }) {
  return (
    <Select aria-label={label} value={value} onChange={(e) => onChange(e.target.value as Tri)}>
      <option value="inherit">{inheritLabel}</option>
      <option value="on">On</option>
      <option value="off">Off</option>
    </Select>
  );
}

export function RecognitionPolicyCard() {
  const { activeCompanyId } = useActiveCompany();
  const [refresh, setRefresh] = useState(0);
  const { data, isLoading, error, refetch } = useQuery<PolicyResponse>(
    '/api/rev-rec/policy',
    { location_id: activeCompanyId },
    { key: `${activeCompanyId}:${refresh}` },
  );

  const [method, setMethod] = useState<RevRecMethod>('PCT_COSTS_INCURRED');
  const [draft, setDraft] = useState<CompanyRevRecPolicy | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!data) return;
    setMethod(data.company.defaultMethod);
    setDraft(data.policy);
  }, [data]);

  const dirty = !!data && !!draft && (method !== data.company.defaultMethod || JSON.stringify(draft) !== JSON.stringify(data.policy) || !data.policyRowExists);
  const example = useMemo(() => (draft ? exampleFor(method, draft) : null), [method, draft]);

  if (isLoading && !data) {
    return (
      <div className="surface wg-loading mb-state-block" aria-busy="true">
        <span className="bar-l" style={{ width: '60%' }} aria-hidden="true" />
        <span className="bar-l" style={{ width: '45%' }} aria-hidden="true" />
        <span className="t-cap" role="status">Loading your revenue policy…</span>
      </div>
    );
  }
  if (error || !data || !draft) {
    return (
      <div className="surface wg-state mb-state-block" role="alert">
        <span className="tag tag--neg">Not loaded</span>
        <span className="t-head">The revenue policy didn’t load</span>
        <span className="t-cap ink-2">{error ?? 'Unknown error'}</span>
        <button type="button" className="btn" onClick={() => void refetch()}>Try again</button>
      </div>
    );
  }

  const set = <K extends keyof CompanyRevRecPolicy>(k: K, v: CompanyRevRecPolicy[K]) => setDraft((d) => (d ? { ...d, [k]: v } : d));

  const savePolicy = async () => {
    setSaving(true);
    const ok = await save({
      kind: 'policy',
      location_id: data.company.locationId,
      default_method: method,
      accrue_underbillings: draft.accrueUnderbillings,
      defer_overbillings: draft.deferOverbillings,
      loss_provision: draft.lossProvision,
      run_cadence: draft.runCadence,
      posting_mode: draft.postingMode,
      materiality_cents: draft.materialityCents,
      retainage_presentation: draft.retainagePresentation,
    });
    setSaving(false);
    if (ok) { toast(`Saved how ${data.company.name} recognizes revenue`); setRefresh((n) => n + 1); }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      {/* 01 — the election */}
      <section className="surface" style={{ padding: 16 }} aria-labelledby="rr-how-h">
        <Eyebrow>{['01', data.company.name]}</Eyebrow>
        <h2 id="rr-how-h" className="t-section" style={{ marginTop: 4 }}>How do you recognize revenue on jobs?</h2>
        <p className="t-body ink-2" style={{ marginTop: 4 }}>
          This is the company default. Job types and individual jobs can differ — set those below.
          {data.projectsEntitled ? ' Contract value, estimates and % complete are fed from Merit Projects.' : ' Contract value, estimates and % complete are entered on each job.'}
        </p>
        <div className="opt-cards" role="radiogroup" aria-label="Recognition method" style={{ marginTop: 12 }}>
          {data.methods.map((m) => (
            <label key={m.value} className="opt-card">
              <input type="radio" name="rr-method" value={m.value} checked={method === m.value} onChange={() => setMethod(m.value)} />
              <span className="t-head">{m.label}</span>
              <p>{m.short}</p>
              <p className="ink-3">{m.who}</p>
            </label>
          ))}
        </div>

        {example && (
          <div className="inset" style={{ marginTop: 16, padding: 12 }} aria-live="polite">
            <Eyebrow>For example</Eyebrow>
            <p className="t-body" style={{ marginTop: 4 }}>{example.sentence}</p>
            {example.entry.length > 0 && (
              <table className="tbl tbl-q tbl-q--compact" style={{ marginTop: 8, maxWidth: 520 }} aria-label="Example entry">
                <thead><tr><th>Account</th><th className="n">Debit</th><th className="n">Credit</th></tr></thead>
                <tbody>
                  {example.entry.map((e) => (
                    <tr key={e.side + e.account}>
                      <td style={e.side === 'CR' ? { paddingLeft: 40 } : undefined}>{e.account}</td>
                      <td className="n tnum">{e.side === 'DR' ? usd(e.amountCents) : ''}</td>
                      <td className="n tnum">{e.side === 'CR' ? usd(e.amountCents) : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </section>

      {/* 02 — what gets booked */}
      <section className="surface" style={{ padding: 16 }} aria-labelledby="rr-book-h">
        <Eyebrow>02</Eyebrow>
        <h2 id="rr-book-h" className="t-section" style={{ marginTop: 4 }}>What we book at each month-end</h2>
        <div className="stack" style={{ marginTop: 12 }}>
          <Switch
            checked={draft.accrueUnderbillings}
            onChange={(e) => set('accrueUnderbillings', e.target.checked)}
            label={<span><b>Accrue revenue for underbillings</b> — book earned-but-not-yet-billed revenue as Unbilled AR (1180).</span>}
          />
          <Switch
            checked={draft.deferOverbillings}
            onChange={(e) => set('deferOverbillings', e.target.checked)}
            label={<span><b>Defer overbillings</b> — hold billed-but-not-yet-earned revenue as Deferred revenue (2410).</span>}
          />
          <Switch
            checked={draft.lossProvision}
            onChange={(e) => set('lossProvision', e.target.checked)}
            label={<span><b>Book expected losses right away</b> — when a job’s estimated cost passes its contract, book the whole expected loss now (GAAP).</span>}
          />
          {!draft.accrueUnderbillings && !draft.deferOverbillings && (
            <InlineNotice tone="warn" title="Revenue will follow billing">
              With both switches off your job revenue equals what you invoice, whatever method you chose. Your accountant may ask for the WIP adjustment at year end.
            </InlineNotice>
          )}
          <p className="t-cap ink-3">Each month-end entry reverses automatically on the 1st of the next month, so billing never double counts.</p>
        </div>
      </section>

      {/* 03 — when and how */}
      <section className="surface" style={{ padding: 16 }} aria-labelledby="rr-when-h">
        <Eyebrow>03</Eyebrow>
        <h2 id="rr-when-h" className="t-section" style={{ marginTop: 4 }}>When and how it runs</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 16, marginTop: 12 }}>
          <Field label="Run" help={draft.runCadence === 'MONTHLY_AT_CLOSE' ? 'Prepared on the 1st and added to the close checklist.' : 'Only when someone clicks Propose on the WIP schedule.'}>
            <Seg<RunCadence>
              aria-label="Run cadence"
              value={draft.runCadence}
              onChange={(v) => set('runCadence', v)}
              items={[{ value: 'MONTHLY_AT_CLOSE', label: 'Monthly at close' }, { value: 'ON_DEMAND', label: 'On demand' }]}
            />
          </Field>
          <Field label="Posting" help={draft.postingMode === 'AUTO_POST' ? 'Posts on its own only when your “Scheduled revenue recognition” autonomy limit also allows it.' : 'A person reviews and approves each month (recommended).'}>
            <Seg<PostingMode>
              aria-label="Posting mode"
              value={draft.postingMode}
              onChange={(v) => set('postingMode', v)}
              items={[{ value: 'PROPOSE', label: 'Propose for approval' }, { value: 'AUTO_POST', label: 'Post automatically' }]}
            />
          </Field>
          <Field label="Skip job adjustments under" help="Small per-job adjustments are left out of the entry and flagged on the schedule. $0 books everything.">
            <MoneyInput valueCents={draft.materialityCents} onChangeCents={(c) => set('materialityCents', c ?? 0)} aria-label="Materiality threshold" />
          </Field>
          <Field label="Retainage on the schedule">
            <Select value={draft.retainagePresentation} onChange={(e) => set('retainagePresentation', e.target.value as RetainagePresentation)}>
              <option value="SEPARATE">Show retainage as its own column</option>
              <option value="INCLUDED_IN_AR">Include it in billed (no column)</option>
            </Select>
          </Field>
        </div>
        <div className="row row--between" style={{ marginTop: 16 }}>
          <span className="t-cap ink-3">{data.policyRowExists ? (dirty ? 'Unsaved changes' : 'Saved') : 'Using the recommended defaults — save to make them yours.'}</span>
          <Button variant="primary" disabled={!dirty || saving} onClick={savePolicy}>{saving ? 'Saving…' : 'Save revenue policy'}</Button>
        </div>
      </section>

      <JobTypeRules data={data} onSaved={() => setRefresh((n) => n + 1)} />
      <JobOverrides data={data} onSaved={() => setRefresh((n) => n + 1)} />
    </div>
  );
}

function JobTypeRules({ data, onSaved }: { data: PolicyResponse; onSaved: () => void }) {
  const [rows, setRows] = useState<Record<string, { method: RevRecMethod; accrue: Tri; defer: Tri }>>({});
  const [newType, setNewType] = useState('');
  const [newMethod, setNewMethod] = useState<RevRecMethod>(data.company.defaultMethod);
  useEffect(() => {
    setRows(Object.fromEntries(data.jobTypes.map((r) => [r.jobType, { method: r.method, accrue: toTri(r.accrueUnderbillings), defer: toTri(r.deferOverbillings) }])));
  }, [data]);

  const saveRow = async (jobType: string, r: { method: RevRecMethod; accrue: Tri; defer: Tri }) => {
    if (await save({ kind: 'job_type', location_id: data.company.locationId, job_type: jobType, method: r.method, accrue_underbillings: fromTri(r.accrue), defer_overbillings: fromTri(r.defer) })) {
      toast(`Saved the ${jobType} rule`);
      onSaved();
    }
  };

  return (
    <section className="surface" style={{ padding: 16 }} aria-labelledby="rr-types-h">
      <Eyebrow>04</Eyebrow>
      <h2 id="rr-types-h" className="t-section" style={{ marginTop: 4 }}>Job types that work differently</h2>
      <p className="t-body ink-2" style={{ marginTop: 4 }}>A job type can use its own method or switches. Anything left on “inherits” follows the company.</p>
      <div className="mb-scroll-x" style={{ marginTop: 12 }}>
        <table className="tbl tbl-q tbl-q--compact" aria-label="Job type rules">
          <thead><tr><th>Job type</th><th>Method</th><th>Underbillings</th><th>Overbillings</th><th className="sr">Save</th></tr></thead>
          <tbody>
            {Object.entries(rows).map(([jt, r]) => (
              <tr key={jt} className="q-row">
                <td>{jt}</td>
                <td>
                  <Select aria-label={`${jt} method`} value={r.method} onChange={(e) => setRows((s) => ({ ...s, [jt]: { ...r, method: e.target.value as RevRecMethod } }))}>
                    {data.methods.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                  </Select>
                </td>
                <td><TriSelect label={`${jt} underbillings`} inheritLabel="Inherits from company" value={r.accrue} onChange={(t) => setRows((s) => ({ ...s, [jt]: { ...r, accrue: t } }))} /></td>
                <td><TriSelect label={`${jt} overbillings`} inheritLabel="Inherits from company" value={r.defer} onChange={(t) => setRows((s) => ({ ...s, [jt]: { ...r, defer: t } }))} /></td>
                <td><Button size="md" onClick={() => saveRow(jt, r)}>Save</Button></td>
              </tr>
            ))}
            <tr className="q-row">
              <td><Input aria-label="New job type" placeholder="e.g. service" value={newType} onChange={(e) => setNewType(e.target.value)} /></td>
              <td>
                <Select aria-label="New job type method" value={newMethod} onChange={(e) => setNewMethod(e.target.value as RevRecMethod)}>
                  {data.methods.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                </Select>
              </td>
              <td className="ink-3">Inherits from company</td>
              <td className="ink-3">Inherits from company</td>
              <td>
                <Button
                  icon="plus"
                  disabled={newType.trim().length === 0}
                  onClick={async () => {
                    await saveRow(newType.trim(), { method: newMethod, accrue: 'inherit', defer: 'inherit' });
                    setNewType('');
                  }}
                >
                  Add
                </Button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

function JobOverrides({ data, onSaved }: { data: PolicyResponse; onSaved: () => void }) {
  const [q, setQ] = useState('');
  const dq = useDebounce(q, 200);
  const [edits, setEdits] = useState<Record<string, { method: RevRecMethod | ''; accrue: Tri; defer: Tri; exclude: boolean }>>({});
  const methodLabel = (m: RevRecMethod) => data.methods.find((x) => x.value === m)?.label ?? m;

  const jobs = useMemo(() => {
    const needle = dq.trim().toLowerCase();
    return needle ? data.jobs.filter((j) => `${j.jobNumber ?? ''} ${j.name ?? ''} ${j.jobType ?? ''}`.toLowerCase().includes(needle)) : data.jobs;
  }, [data.jobs, dq]);

  const current = (j: JobRow) => edits[j.id] ?? {
    method: j.methodOverride ?? '',
    accrue: toTri(j.override?.accrueUnderbillings),
    defer: toTri(j.override?.deferOverbillings),
    exclude: j.override?.excludeFromWip ?? false,
  };
  const patch = (j: JobRow, p: Partial<ReturnType<typeof current>>) => setEdits((s) => ({ ...s, [j.id]: { ...current(j), ...p } }));

  const saveJob = async (j: JobRow) => {
    const e = current(j);
    if (await save({
      kind: 'job', location_id: data.company.locationId, job_id: j.id,
      method_override: e.method === '' ? null : e.method,
      accrue_underbillings: fromTri(e.accrue), defer_overbillings: fromTri(e.defer), exclude_from_wip: e.exclude,
    })) {
      toast(`Saved ${j.jobNumber ?? 'the job'}`);
      setEdits((s) => { const n = { ...s }; delete n[j.id]; return n; });
      onSaved();
    }
  };

  return (
    <section className="surface" style={{ padding: 16 }} aria-labelledby="rr-jobs-h">
      <div className="row row--between" style={{ flexWrap: 'wrap', gap: 12 }}>
        <div>
          <Eyebrow>05</Eyebrow>
          <h2 id="rr-jobs-h" className="t-section" style={{ marginTop: 4 }}>Job exceptions</h2>
        </div>
        <Search value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a job" aria-label="Find a job" style={{ width: 220 }} />
      </div>
      {data.jobs.length === 0 ? (
        <p className="t-body ink-3" style={{ marginTop: 12 }}>No active jobs for this company yet. <Link className="link" href="/jobs">Add a job</Link></p>
      ) : (
        <div className="mb-scroll-x" style={{ marginTop: 12 }}>
          <table className="tbl tbl-q tbl-q--compact" aria-label="Job exceptions" style={{ minWidth: 980 }}>
            <thead><tr><th>Job</th><th>Method</th><th>Underbillings</th><th>Overbillings</th><th>Leave off WIP</th><th className="sr">Save</th></tr></thead>
            <tbody>
              {jobs.map((j) => {
                const e = current(j);
                const changed = !!edits[j.id];
                return (
                  <tr key={j.id} className="q-row">
                    <td style={{ width: 240 }}>
                      <Link className="l1 mb-row-link" href={`/jobs/${j.id}`}>{j.jobNumber ?? '—'} · {j.name ?? 'Job'}</Link>
                      <span className="l2">{j.jobType ?? 'No job type'} · {money(j.contractCents, { symbol: '$', decimals: 0 })}</span>
                    </td>
                    <td>
                      <Select aria-label={`${j.jobNumber} method`} value={e.method} onChange={(ev) => patch(j, { method: ev.target.value as RevRecMethod | '' })}>
                        <option value="">{j.methodSource === 'JOB' ? 'Inherit (remove the job’s own method)' : `${METHOD_SOURCE_LABEL[j.methodSource]}: ${methodLabel(j.method)}`}</option>
                        {data.methods.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                      </Select>
                    </td>
                    <td>
                      <TriSelect label={`${j.jobNumber} underbillings`} inheritLabel={`${j.resolved.accrueSource} (${j.resolved.accrueUnderbillings ? 'on' : 'off'})`} value={e.accrue} onChange={(t) => patch(j, { accrue: t })} />
                    </td>
                    <td>
                      <TriSelect label={`${j.jobNumber} overbillings`} inheritLabel={`${j.resolved.deferSource} (${j.resolved.deferOverbillings ? 'on' : 'off'})`} value={e.defer} onChange={(t) => patch(j, { defer: t })} />
                    </td>
                    <td><Check aria-label={`Leave ${j.jobNumber} off the WIP schedule`} checked={e.exclude} onChange={(ev) => patch(j, { exclude: ev.target.checked })} /></td>
                    <td>{changed ? <Button onClick={() => saveJob(j)}>Save</Button> : j.override || j.methodOverride ? <Tag>Exception</Tag> : null}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

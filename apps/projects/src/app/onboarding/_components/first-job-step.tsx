'use client';

import { useEffect, useState, type MutableRefObject } from 'react';
import { Button, ButtonLink, Field, Input, InlineNotice, MoneyInput, PageHead, Select, money, toast } from '@meritbooks/merit-ui';
import type { CompanyBrief } from '@/lib/onboarding/types';
import { getJson, postJson } from '@/components/imports/api';
import type { CommittedFile } from '@/components/imports/SourcesPanel';
import type { CompanyFlow } from './flow';

interface ImportedJob {
  jobId: string;
  name: string;
  ref: string | null;
  customer: string | null;
  contractCents: number | null;
  billedCents: number | null;
  costCents: number | null;
}

interface RowsResponse { rows: { target_id: string | null; external_ref: string | null; data: Record<string, unknown> }[] }

const num = (v: unknown) => (typeof v === 'number' ? v : null);
const str = (v: unknown) => (typeof v === 'string' ? v : null);

/** Step 6 — "First real job": confirm an imported job's numbers, or quick-create one with three fields. */
export function FirstJobStep({ company, flow, imported, onPatch, onContinue, onBack, primaryRef }: {
  company: CompanyBrief;
  flow: CompanyFlow;
  imported: CommittedFile[];
  onPatch: (p: Partial<CompanyFlow>) => void;
  onContinue: () => void;
  onBack: () => void;
  primaryRef: MutableRefObject<(() => void) | null>;
}) {
  const [jobs, setJobs] = useState<ImportedJob[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [customer, setCustomer] = useState('');
  const [name, setName] = useState('');
  const [price, setPrice] = useState<number | null>(null);
  const [jobType, setJobType] = useState(flow.jobTypes[0]?.key ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { primaryRef.current = onContinue; });

  const jobBatches = imported.filter((f) => f.entity === 'job' && (f.result.counts.CREATED ?? 0) > 0).map((f) => f.result.batch_id);
  const batchKey = jobBatches.join(',');
  useEffect(() => {
    if (!batchKey) { setJobs([]); return; }
    let live = true;
    void (async () => {
      const all: ImportedJob[] = [];
      for (const b of batchKey.split(',')) {
        const r = await getJson<RowsResponse>(`/api/imports/${b}?outcome=CREATED&limit=6`);
        if (!r.ok) { if (live) setLoadError(r.error); continue; }
        for (const x of r.data.rows) {
          if (!x.target_id) continue;
          all.push({ jobId: x.target_id, name: str(x.data.name) ?? 'Job', ref: x.external_ref, customer: str(x.data.customer_name),
            contractCents: num(x.data.contract_cents), billedCents: num(x.data.billed_to_date_cents), costCents: num(x.data.cost_to_date_cents) });
        }
      }
      if (live) setJobs(all.slice(0, 6));
    })();
    return () => { live = false; };
  }, [batchKey]);

  const create = async () => {
    if (!name.trim() || !jobType) { setError('Give the job a name.'); return; }
    setBusy(true); setError(null);
    const r = await postJson<{ jobId: string }>('/api/jobs', { companyId: company.id, jobTypeKey: jobType, name: name.trim(), customerName: customer.trim() || null, contractCents: price });
    setBusy(false);
    if (!r.ok) { setError(r.error); return; }
    onPatch({ firstJobId: r.data.jobId });
    toast(`Created ${name.trim()}`);
    onContinue();
  };

  const jobsWord = flow.preview?.jobsWord.toLowerCase() ?? 'jobs';
  return (
    <>
      <PageHead eyebrow={['Set up', company.name]} title="Your first real job">
        <p className="ob-lede">Check one {jobsWord.replace(/s$/, '')} you brought in, or add one now. Costs and billing post in Merit Books; the numbers here come from your import until Books records them.</p>
      </PageHead>

      <div className="ob-grid2">
        <section className="ob-card" aria-labelledby="fj-imp">
          <div className="ob-card-h"><h3 id="fj-imp">From your import</h3></div>
          {loadError && <div className="ob-card-b"><InlineNotice tone="neg" title={loadError} /></div>}
          {jobs === null ? (
            <div className="ob-skel" aria-busy="true"><span className="t-cap">Loading the jobs you brought in…</span></div>
          ) : jobs.length === 0 ? (
            <div className="ob-card-b"><p>No jobs came in from a file. Add your first one on the right.</p></div>
          ) : (
            <table className="tbl tbl-q tbl-q--flush tbl-q--compact" aria-label="Imported jobs">
              <thead><tr><th>Job</th><th className="num">Contract</th><th className="num">Billed</th><th className="num">Cost</th><th /></tr></thead>
              <tbody>
                {jobs.map((j) => (
                  <tr key={j.jobId} aria-selected={flow.firstJobId === j.jobId}>
                    <td><span className="l1">{j.name}</span><span className="l2">{[j.ref, j.customer].filter(Boolean).join(' · ')}</span></td>
                    <td className="num tnum">{j.contractCents == null ? '—' : money(j.contractCents)}</td>
                    <td className="num tnum">{j.billedCents == null ? '—' : money(j.billedCents)}</td>
                    <td className="num tnum">{j.costCents == null ? '—' : money(j.costCents)}</td>
                    <td>
                      {flow.firstJobId === j.jobId
                        ? <ButtonLink variant="quiet" href={`/jobs/${j.jobId}`}>Open</ButtonLink>
                        : <Button variant="quiet" onClick={() => onPatch({ firstJobId: j.jobId })}>These are right</Button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="ob-card" aria-labelledby="fj-new">
          <div className="ob-card-h"><h3 id="fj-new">Add one now</h3></div>
          <div className="ob-card-b ob-stack">
            <Field label="Customer"><Input value={customer} onChange={(e) => setCustomer(e.currentTarget.value)} placeholder="Name of the customer" /></Field>
            <Field label="What the job is"><Input value={name} onChange={(e) => setName(e.currentTarget.value)} placeholder="Kitchen remodel, furnace replacement…" /></Field>
            <Field label="Price"><MoneyInput valueCents={price} onChangeCents={setPrice} /></Field>
            {flow.jobTypes.length > 1 && (
              <Field label="Kind of job">
                <Select value={jobType} onChange={(e) => setJobType(e.currentTarget.value)}>{flow.jobTypes.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}</Select>
              </Field>
            )}
            {error && <InlineNotice tone="neg" title={error} />}
            <div><Button variant="primary" disabled={busy} onClick={create}>{busy ? 'Creating…' : 'Create the job'}</Button></div>
          </div>
        </section>
      </div>

      <div className="ob-foot">
        <Button variant="quiet" chord="escape" onClick={onBack}>Back</Button>
        <span className="sp" />
        <span className="t-cap">You can change this anytime.</span>
        <Button variant="primary" size="lg" chord="enter" onClick={onContinue}>{flow.firstJobId ? 'Continue' : 'Skip for now'}</Button>
      </div>
    </>
  );
}

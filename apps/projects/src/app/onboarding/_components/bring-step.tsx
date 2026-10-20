'use client';

import { useEffect, useState, type MutableRefObject } from 'react';
import { Button, ButtonLink, Icon, InlineNotice, PageHead, Select, money, toast } from '@meritbooks/merit-ui';
import type { CommitRowResult, CompanyBrief, ParseResponse } from '@/lib/onboarding/types';
import { postForm, postJson } from './api';
import type { CompanyFlow } from './flow';
import { ImportReview } from './import-review';

type AdoptState =
  | { kind: 'idle' } | { kind: 'busy' } | { kind: 'error'; message: string }
  | { kind: 'needs_rpc'; waiting: number } | { kind: 'done'; adopted: number; failed: number };

/** Step 3 — "Bring your work": Books jobs · a file · a sample job · start fresh. */
export function BringStep({ company, flow, onPatch, onContinue, primaryRef }: {
  company: CompanyBrief;
  flow: CompanyFlow;
  onPatch: (p: Partial<CompanyFlow>) => void;
  onContinue: () => void;
  primaryRef: MutableRefObject<(() => void) | null>;
}) {
  const [adopt, setAdopt] = useState<AdoptState>({ kind: 'idle' });
  const [adoptType, setAdoptType] = useState('');
  const [reviewing, setReviewing] = useState(false);
  const [imported, setImported] = useState<number | null>(null);
  const [fileBusy, setFileBusy] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [sampleBusy, setSampleBusy] = useState(false);
  const [sampleError, setSampleError] = useState<string | null>(null);
  useEffect(() => { primaryRef.current = onContinue; });

  const jobsWord = flow.preview?.jobsWord.toLowerCase() ?? 'jobs';
  const sample = flow.preview?.sampleJob ?? null;
  const unadopted = company.unadoptedJobCount;

  const bringBooksJobs = async () => {
    setAdopt({ kind: 'busy' });
    const r = await postJson<{ status: 'done'; adopted: number; failed: number; results: { jobId: string; ok: boolean }[] } | { status: 'needs_rpc'; waiting: number }>(
      '/api/onboarding/adopt', { companyId: company.id, jobTypeKey: adoptType || undefined });
    if (!r.ok) { setAdopt({ kind: 'error', message: r.error }); return; }
    if (r.data.status === 'needs_rpc') { setAdopt({ kind: 'needs_rpc', waiting: r.data.waiting }); return; }
    setAdopt({ kind: 'done', adopted: r.data.adopted, failed: r.data.failed });
    const first = r.data.results.find((x) => x.ok)?.jobId;
    if (first && !flow.firstJobId) onPatch({ firstJobId: first });
    if (r.data.adopted > 0) toast(`Brought over ${r.data.adopted} ${r.data.adopted === 1 ? 'job' : 'jobs'} from Merit Books`);
  };

  const parse = async (file: File) => {
    setFileBusy(true);
    setFileError(null);
    const form = new FormData();
    form.set('file', file);
    form.set('companyId', company.id);
    const r = await postForm<ParseResponse>('/api/onboarding/import/parse', form);
    setFileBusy(false);
    if (!r.ok) { setFileError(r.error); return; }
    onPatch({ file: r.data });
    setReviewing(true);
  };

  const loadSample = async () => {
    setSampleBusy(true);
    setSampleError(null);
    const r = await postJson<{ jobId: string }>('/api/onboarding/sample', { companyId: company.id });
    setSampleBusy(false);
    if (!r.ok) { setSampleError(r.error); return; }
    onPatch({ sampleJobId: r.data.jobId, firstJobId: flow.firstJobId ?? r.data.jobId });
    toast('Loaded the sample job · marked as a sample', { undo: async () => { await removeSample(); } });
  };

  const removeSample = async () => {
    setSampleBusy(true);
    const r = await postJson<{ removed: number; cancelled: number }>('/api/onboarding/sample', { companyId: company.id }, 'DELETE');
    setSampleBusy(false);
    if (!r.ok) { setSampleError(r.error); return; }
    onPatch({ sampleJobId: null, firstJobId: flow.firstJobId === flow.sampleJobId ? null : flow.firstJobId });
    toast(r.data.cancelled > 0 ? 'Cancelled the sample job (Books already points at it)' : 'Removed the sample job');
  };

  const onImported = (results: CommitRowResult[]) => {
    const created = results.filter((r) => r.status === 'created');
    setImported(created.length);
    const first = created[0]?.jobId ?? null;
    if (first && !flow.firstJobId) onPatch({ firstJobId: first });
  };

  const anything = flow.sampleJobId || (imported ?? 0) > 0 || (adopt.kind === 'done' && adopt.adopted > 0);

  return (
    <>
      <PageHead eyebrow={['Set up', company.name]} title="Bring your work">
        <p className="ob-lede">{company.name} is set up. Now put real {jobsWord} in it. Pick any of these, or more than one.</p>
      </PageHead>

      <div className="ob-bring">
        {/* (a) Jobs already in Books */}
        <section className={`ob-card${adopt.kind === 'done' || (unadopted === 0 && company.jobCount > 0) ? ' is-done' : ''}`} aria-labelledby="ob-b1">
          <div className="ob-card-h"><h3 id="ob-b1">Jobs already in Merit Books</h3></div>
          <div className="ob-card-b">
            {company.jobCount === 0 ? (
              <p>No jobs in Books for {company.name} yet. That&apos;s fine; use a file, the sample or start fresh.</p>
            ) : unadopted === 0 ? (
              <p>All {company.jobCount} Books {company.jobCount === 1 ? 'job is' : 'jobs are'} already here.</p>
            ) : adopt.kind === 'done' ? (
              <p>Brought over {adopt.adopted}{adopt.failed ? `; ${adopt.failed} need a look in Jobs` : ''}.</p>
            ) : adopt.kind === 'needs_rpc' ? (
              <InlineNotice tone="warn" title="This one isn't switched on yet.">
                Your {adopt.waiting} Books {adopt.waiting === 1 ? 'job is' : 'jobs are'} safe in Merit Books. Bringing them over needs one more update on our side; they&apos;ll show up here when it lands. Nothing was changed.
              </InlineNotice>
            ) : (
              <>
                <span className="ob-big">{unadopted}</span>
                <p>{unadopted === 1 ? 'job' : 'jobs'} with numbers, customers and contract values from Books. Costs and billing stay in Books.</p>
                {flow.jobTypes.length > 1 && (
                  <Select aria-label="Job type for Books jobs" value={adoptType} onChange={(e) => setAdoptType(e.currentTarget.value)}>
                    <option value="">Match each job&apos;s type</option>
                    {flow.jobTypes.map((t) => <option key={t.key} value={t.key}>All as {t.label}</option>)}
                  </Select>
                )}
                {adopt.kind === 'error' && <InlineNotice tone="neg" title={adopt.message} />}
              </>
            )}
            {unadopted > 0 && adopt.kind !== 'done' && adopt.kind !== 'needs_rpc' && (
              <div className="act"><Button variant="primary" disabled={adopt.kind === 'busy'} onClick={bringBooksJobs}>{adopt.kind === 'busy' ? 'Bringing them over…' : 'Bring them over'}</Button></div>
            )}
          </div>
        </section>

        {/* (b) Drop a file */}
        <section className={`ob-card${(imported ?? 0) > 0 ? ' is-done' : ''}`} aria-labelledby="ob-b2">
          <div className="ob-card-h"><h3 id="ob-b2">Drop a file</h3></div>
          <div className="ob-card-b">
            <p>A job list from Buildertrend, JobTread, simPRO, Innergy, RFMS or any spreadsheet. We match the columns; you check only the unsure ones.</p>
            {imported !== null ? (
              <p><b>{imported}</b> {imported === 1 ? 'job' : 'jobs'} brought in.</p>
            ) : flow.file && !reviewing ? (
              <div className="act"><Button variant="primary" onClick={() => setReviewing(true)}>Use {flow.file.fileName}</Button></div>
            ) : null}
            <label className="ob-drop" style={{ marginTop: 'auto' }}>
              <input type="file" accept=".csv,.xlsx,.xlsm,.txt,.tsv" aria-label="Choose a job list" onChange={(e) => { const f = e.currentTarget.files?.[0]; if (f) void parse(f); }} />
              <Icon name="upload" />
              <span className="l1">{fileBusy ? 'Reading the file…' : flow.file ? 'Choose another file' : 'Choose or drop a file'}</span>
            </label>
            {fileError && <InlineNotice tone="neg" title={fileError} />}
          </div>
        </section>

        {/* (c) Sample job */}
        <section className={`ob-card${flow.sampleJobId ? ' is-done' : ''}`} aria-labelledby="ob-b3">
          <div className="ob-card-h"><h3 id="ob-b3">Start with a sample job</h3></div>
          <div className="ob-card-b">
            {sample ? (
              <p><b>{sample.name}</b> for {sample.customerName}, {money(sample.contractCents, { decimals: 0 })} contract, with a budget and tasks. Marked as a sample; remove it in one click.</p>
            ) : (
              <p>A realistic job for your kind of work, with a budget and tasks. Marked as a sample; remove it in one click.</p>
            )}
            {sampleError && <InlineNotice tone="neg" title={sampleError} />}
            <div className="act">
              {flow.sampleJobId ? (
                <>
                  <ButtonLink href={`/jobs/${flow.sampleJobId}`}>Open it</ButtonLink>
                  <Button variant="quiet" disabled={sampleBusy} onClick={removeSample}>Remove sample</Button>
                </>
              ) : (
                <Button variant="primary" disabled={sampleBusy} onClick={loadSample}>{sampleBusy ? 'Loading…' : 'Load the sample job'}</Button>
              )}
            </div>
          </div>
        </section>

        {/* (d) Start fresh */}
        <section className="ob-card" aria-labelledby="ob-b4">
          <div className="ob-card-h"><h3 id="ob-b4">Start fresh</h3></div>
          <div className="ob-card-b">
            <p>Skip this and add your first job from Jobs. Three fields: customer, what the job is, and the price.</p>
            <div className="act"><Button onClick={onContinue}>Start fresh</Button></div>
          </div>
        </section>
      </div>

      {reviewing && flow.file && imported === null && (
        <ImportReview
          companyId={company.id}
          file={flow.file}
          jobTypes={flow.jobTypes}
          onDone={onImported}
          onCancel={() => { setReviewing(false); onPatch({ file: null }); }}
        />
      )}

      <div className="ob-foot">
        <span className="t-cap">{anything ? 'Nice. You can bring more in any time from Jobs.' : 'Nothing is required here.'}</span>
        <span className="sp" />
        <Button variant="primary" size="lg" chord="enter" onClick={onContinue}>Continue</Button>
      </div>
    </>
  );
}

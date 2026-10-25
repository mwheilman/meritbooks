'use client';

import { useEffect, useState, type MutableRefObject } from 'react';
import { Button, ButtonLink, InlineNotice, PageHead, Select, count, money, toast } from '@meritbooks/merit-ui';
import type { CompanyBrief } from '@/lib/onboarding/types';
import { ENTITY_DEFS } from '@/lib/imports/fields';
import { KIND_LABEL, OpeningPanel } from '@/components/imports/OpeningPanel';
import { ImportProgressPill } from '@/components/imports/ImportProgressPill';
import { SourcesPanel, type CommittedFile } from '@/components/imports/SourcesPanel';
import type { OpeningKind } from '@/lib/imports/types';
import { postJson } from './api';
import type { CompanyFlow } from './flow';

type AdoptState =
  | { kind: 'idle' } | { kind: 'busy' } | { kind: 'error'; message: string }
  | { kind: 'needs_rpc'; waiting: number } | { kind: 'done'; adopted: number; failed: number };

/**
 * Step 4 — "Where does your work live today?": jobs already in Books · your old system (logo tiles,
 * one export at a time, imports keep running in the background) · a sample job · start fresh. What
 * came in shows as cards; mid-stream work, agreements and units hand their opening balances to Books.
 */
export function BringStep({ company, flow, booksUrl, onPatch, onImported, onContinue, primaryRef }: {
  company: CompanyBrief;
  flow: CompanyFlow;
  booksUrl: string;
  onPatch: (p: Partial<CompanyFlow>) => void;
  onImported: (f: CommittedFile) => void;
  onContinue: () => void;
  primaryRef: MutableRefObject<(() => void) | null>;
}) {
  const [adopt, setAdopt] = useState<AdoptState>({ kind: 'idle' });
  const [adoptType, setAdoptType] = useState('');
  const [showSources, setShowSources] = useState(flow.imported.length > 0);
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

  const importedCount = flow.imported.reduce((a, f) => a + (f.result.counts.CREATED ?? 0) + (f.result.counts.MATCHED ?? 0), 0);
  const openingKinds = [...new Set(flow.imported.map((f) => f.openingKind).filter((k): k is OpeningKind => k !== null))];
  const imported = (f: CommittedFile) => {
    onImported(f);
    if (f.result.first_job_id && !flow.firstJobId) onPatch({ firstJobId: f.result.first_job_id });
  };

  const anything = flow.sampleJobId || importedCount > 0 || (adopt.kind === 'done' && adopt.adopted > 0);

  return (
    <>
      <PageHead eyebrow={['Set up', company.name]} title="Where does your work live today?">
        <p className="ob-lede">{company.name} is set up. Now put real {jobsWord} in it. Pick any of these, or more than one. You can change this anytime.</p>
      </PageHead>
      <div className="imp-head-row"><span className="sp" /><ImportProgressPill /></div>

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

        {/* (b) The old system */}
        <section className={`ob-card${importedCount > 0 ? ' is-done' : ''}`} aria-labelledby="ob-b2">
          <div className="ob-card-h"><h3 id="ob-b2">From your old system</h3></div>
          <div className="ob-card-b">
            <p>Buildertrend, JobTread, CoConstruct, ServiceTitan, FieldEdge, simPRO, Housecall Pro, Jobber, c-Systems, Procore, QuickBooks or any spreadsheet. Customers are matched to the ones you have; jobs under way keep their numbers.</p>
            {importedCount > 0 && <p><b className="tnum">{count(importedCount)}</b> records brought in.</p>}
            <div className="act"><Button variant="primary" onClick={() => setShowSources(true)}>{showSources ? 'Pick below' : 'Pick your old system'}</Button></div>
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

      {showSources && (
        <div id="imp-sources" style={{ marginTop: 24 }}>
          <SourcesPanel companyId={company.id} booksUrl={booksUrl} onCommitted={imported} />
        </div>
      )}

      {flow.imported.length > 0 && (
        <div className="imp-whatcame" aria-label="What came in">
          {flow.imported.map((f) => (
            <section key={f.result.batch_id} className="ob-card">
              <div className="ob-card-h"><h3>{ENTITY_DEFS[f.entity].label}</h3></div>
              <div className="ob-card-b">
                <span className="ob-big">{count((f.result.counts.CREATED ?? 0) + (f.result.counts.MATCHED ?? 0) + (f.result.counts.REFERENCE ?? 0) + (f.result.counts.FACT ?? 0) + (f.result.counts.ROSTER ?? 0))}</span>
                <span className="t-cap">{f.fileName}{(f.result.counts.MATCHED ?? 0) > 0 ? ` · ${count(f.result.counts.MATCHED ?? 0)} matched to existing` : ''}{(f.result.counts.ERROR ?? 0) > 0 ? ` · ${count(f.result.counts.ERROR ?? 0)} need a look` : ''}</span>
              </div>
            </section>
          ))}
        </div>
      )}

      {openingKinds.length > 0 && (
        <div className="ob-stack" style={{ marginTop: 24 }} aria-label="Opening balances for Merit Books">
          {openingKinds.map((k) => <OpeningPanel key={k} companyId={company.id} kind={k} booksUrl={booksUrl} />)}
          <p className="t-cap">{openingKinds.map((k) => KIND_LABEL[k]).join(' · ')}: Merit Books records these opening balances through its own import. Projects never posts to the ledger.</p>
        </div>
      )}

      <div className="ob-foot">
        <span className="t-cap">{anything ? 'Nice. You can bring more in any time from Jobs.' : 'Nothing is required here.'}</span>
        <span className="sp" />
        <Button variant="primary" size="lg" chord="enter" onClick={onContinue}>Continue</Button>
      </div>
    </>
  );
}

'use client';

/**
 * WipReview — the jobs/WIP onboarding review surface (design spec §4/§5).
 *
 * "Review, don't enter": the homebuilder DROPS a WIP schedule / job-cost export (CSV
 * or PDF) and we arrive at a proposed set of open jobs with the opening WIP position
 * already computed off the real engine — earned (POC), billed, under/over-billing —
 * and the tie targets that will foot to the GL (Σ costs → WIP, Σ unbilled → 1180,
 * Σ billings-in-excess → 2410). The human confirms; commit creates the jobs and stages
 * the opening WIP totals on the conversion session so the tie-out fires.
 *
 * Degrade-safe: CSV is parsed in-browser and posted as rows (works with AI off); a PDF
 * is sent for drop-and-parse and cleanly degrades to "upload a CSV" when AI is
 * unavailable. All states: loading / empty / error / populated. Accessible: real
 * buttons + labelled DropZone; confidence via text, money in tabular mono.
 *
 * This file lives beside the component kit but does NOT modify it — the shell wires it
 * by section key (the lead adds the section per the wip.ts build report).
 */

import { useCallback, useMemo, useState } from 'react';
import { formatMoney } from '@meritbooks/shared';
import { parseCsv } from '@/lib/import/csv';
import { DropZone } from './drop-zone';
import { ProposalCard } from './proposal-card';
import { confidenceBand } from './helpers';

interface WipJobRow {
  jobNumber: string;
  jobName: string;
  earnedRevenueCents: number;
  billedToDateCents: number;
  underBillingCents: number;
  overBillingCents: number;
  wipStatus: 'OVERBILLED' | 'UNDERBILLED' | 'ON_TARGET';
  pctCompleteDisplay: number;
}

interface WipTotals {
  jobs: number;
  costsToDateCents: number;
  earnedRevenueCents: number;
  billedToDateCents: number;
  unbilledCents: number;
  billingsInExcessCents: number;
  retainageReceivableCents: number;
  retainagePayableCents: number;
  customerDepositsCents: number;
  overbilledJobs: number;
  underbilledJobs: number;
}

// A minimal view of ProposedJob — only what the review renders (kept local so this
// client file doesn't pull the server barrel).
interface ProposedJobView {
  jobNumber: string;
  jobName: string;
  customerName: string | null;
  confidence: Record<string, number>;
  lowConfidenceFields: string[];
  source: 'ai' | 'heuristic' | 'human' | 'unmapped';
}

interface ParseResponse {
  source: 'csv' | 'document';
  aiUsed: boolean;
  jobs: ProposedJobView[];
  blockers: string[];
  totals: WipTotals;
  schedule: { jobs: WipJobRow[] };
  documentNote?: string | null;
  error?: string;
  degraded?: boolean;
}

export interface WipReviewProps {
  /** The company (location) to import jobs into. */
  companyId: string | null;
  /** The conversion session to stage the opening WIP totals onto (optional). */
  sessionId?: string | null;
  asOfDate?: string | null;
  /** Called after a successful commit. */
  onCommitted?: (createdCount: number) => void;
}

async function fileToBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export function WipReview({ companyId, sessionId, asOfDate, onCommitted }: WipReviewProps) {
  const [loading, setLoading] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [parsed, setParsed] = useState<ParseResponse | null>(null);
  const [committedCount, setCommittedCount] = useState<number | null>(null);

  const jobRowByNumber = useMemo(() => {
    const m = new Map<string, WipJobRow>();
    for (const r of parsed?.schedule.jobs ?? []) m.set(r.jobNumber, r);
    return m;
  }, [parsed]);

  const handleFiles = useCallback(async (files: File[]) => {
    const file = files[0];
    if (!file) return;
    setError(null);
    setCommittedCount(null);
    setLoading(true);
    try {
      const isCsv = /\.csv$/i.test(file.name) || file.type === 'text/csv';
      let res: Response;
      if (isCsv) {
        const text = await file.text();
        const { headers, rows } = parseCsv(text);
        if (rows.length === 0) { setError('That CSV has no data rows.'); setLoading(false); return; }
        res = await fetch('/api/onboarding/import/wip', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: 'parse', source: 'csv', rows, headers }),
        });
      } else {
        const base64Data = await fileToBase64(file);
        res = await fetch('/api/onboarding/import/wip', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: 'parse', source: 'document', base64Data, mediaType: file.type || 'application/pdf' }),
        });
      }
      const data = (await res.json()) as ParseResponse;
      if (!res.ok) {
        setError(data.error ?? 'We could not read that file. Try a CSV export of your WIP schedule.');
        setLoading(false);
        return;
      }
      setParsed(data);
    } catch {
      setError('Something went wrong reading that file. Try a CSV export instead.');
    } finally {
      setLoading(false);
    }
  }, []);

  const handleCommit = useCallback(async () => {
    if (!parsed || !companyId) return;
    setCommitting(true);
    setError(null);
    try {
      const res = await fetch('/api/onboarding/import/wip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'commit', companyId, sessionId, asOfDate, jobs: (parsed as unknown as { jobs: unknown[] }).jobs }),
      });
      const data = (await res.json()) as { createdCount?: number; error?: string; blockers?: string[] };
      if (!res.ok) {
        setError(data.error ?? (data.blockers ? data.blockers.join(' ') : 'Could not import the jobs.'));
        setCommitting(false);
        return;
      }
      setCommittedCount(data.createdCount ?? 0);
      onCommitted?.(data.createdCount ?? 0);
    } catch {
      setError('Could not import the jobs. Please try again.');
    } finally {
      setCommitting(false);
    }
  }, [parsed, companyId, sessionId, asOfDate, onCommitted]);

  const totals = parsed?.totals;
  const lowConfidenceJobs = (parsed?.jobs ?? []).filter((j) => j.lowConfidenceFields.length > 0);
  const canCommit = !!parsed && !!companyId && (parsed.blockers?.length ?? 0) === 0 && committedCount === null;

  return (
    <div className="space-y-5">
      {/* Drop target */}
      <DropZone
        label="Drop your WIP schedule or job-cost export"
        hint="CSV or PDF · open jobs with contract, budget/EAC, costs-to-date, billed, retainage — we build the schedule"
        accept=".csv,text/csv,.pdf,application/pdf,image/*"
        onFiles={handleFiles}
        disabled={loading || committing}
      />

      {/* Loading */}
      {loading && (
        <div role="status" aria-live="polite" className="rounded-xl border border-slate-800 bg-surface-900/60 px-4 py-6 text-center text-sm text-slate-400">
          Reading your jobs and building the opening WIP schedule…
        </div>
      )}

      {/* Error */}
      {error && !loading && (
        <div role="alert" className="rounded-xl border border-warning/30 bg-warning/5 px-4 py-3 text-sm text-warning-fg">
          {error}
        </div>
      )}

      {/* Committed */}
      {committedCount !== null && (
        <div role="status" aria-live="polite" className="rounded-xl border border-brand-500/30 bg-brand-500/[0.05] px-4 py-4 text-sm text-brand-300">
          Imported {committedCount} open job{committedCount === 1 ? '' : 's'}. The opening WIP is staged to tie to your WIP asset, Unbilled (1180), and Billings-in-excess (2410) at go-live.
        </div>
      )}

      {/* Populated review */}
      {parsed && committedCount === null && (
        <>
          {parsed.jobs.length === 0 ? (
            <div className="rounded-xl border border-slate-800 bg-surface-900/60 px-4 py-8 text-center text-sm text-slate-400">
              We didn&apos;t find any open jobs in that file. Check that it lists a job number and contract value per row.
            </div>
          ) : (
            <>
              {/* Opening WIP tie summary */}
              {totals && (
                <div className="rounded-2xl border border-slate-800 bg-surface-900 p-4">
                  <h3 className="text-sm font-semibold text-white">Opening WIP — how it ties to your ledger</h3>
                  <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
                    <TieStat label="Costs to date → WIP asset" cents={totals.costsToDateCents} />
                    <TieStat label="Earned revenue (POC)" cents={totals.earnedRevenueCents} muted />
                    <TieStat label="Billed to date" cents={totals.billedToDateCents} muted />
                    <TieStat label="Unbilled → 1180 (asset)" cents={totals.unbilledCents} accent />
                    <TieStat label="Billings in excess → 2410 (liability)" cents={totals.billingsInExcessCents} accent />
                    <TieStat label="Customer deposits → liability" cents={totals.customerDepositsCents} muted />
                    {totals.retainageReceivableCents > 0 && <TieStat label="Retainage receivable" cents={totals.retainageReceivableCents} muted />}
                    {totals.retainagePayableCents > 0 && <TieStat label="Retainage payable" cents={totals.retainagePayableCents} muted />}
                  </dl>
                  <p className="mt-3 text-xs text-slate-500">
                    {totals.jobs} open job{totals.jobs === 1 ? '' : 's'} · {totals.underbilledJobs} underbilled · {totals.overbilledJobs} overbilled.
                    These totals stage to the conversion tie-out; recognition is booked later at the monthly close, not now.
                  </p>
                </div>
              )}

              {/* Blockers (deterministic gate) */}
              {(parsed.blockers?.length ?? 0) > 0 && (
                <div role="alert" className="rounded-xl border border-warning/30 bg-warning/5 px-4 py-3 text-sm text-warning-fg">
                  <p className="font-medium">Before you import:</p>
                  <ul className="mt-1 list-disc space-y-0.5 pl-5">
                    {parsed.blockers.map((b, i) => <li key={i}>{b}</li>)}
                  </ul>
                </div>
              )}

              {/* Jobs that need a look */}
              {lowConfidenceJobs.length > 0 && (
                <div className="space-y-2">
                  <h3 className="text-sm font-semibold text-white">Jobs that need a look</h3>
                  {lowConfidenceJobs.map((j) => (
                    <ProposalCard
                      key={j.jobNumber}
                      title={`${j.jobNumber} — ${j.jobName}`}
                      subtitle={`Missing or uncertain: ${j.lowConfidenceFields.map(labelFor).join(', ')}`}
                      confidence={confidenceBand(Math.min(...Object.values(j.confidence).concat(0)), j.source)}
                    />
                  ))}
                </div>
              )}

              {/* Per-job WIP table */}
              <div className="overflow-x-auto rounded-2xl border border-slate-800">
                <table className="w-full text-sm">
                  <caption className="sr-only">Opening WIP schedule by job</caption>
                  <thead>
                    <tr className="border-b border-slate-800 text-left text-xs uppercase tracking-wide text-slate-500">
                      <th scope="col" className="px-3 py-2 font-medium">Job</th>
                      <th scope="col" className="px-3 py-2 text-right font-medium">% Complete</th>
                      <th scope="col" className="px-3 py-2 text-right font-medium">Earned</th>
                      <th scope="col" className="px-3 py-2 text-right font-medium">Billed</th>
                      <th scope="col" className="px-3 py-2 text-right font-medium">Under / Over</th>
                    </tr>
                  </thead>
                  <tbody>
                    {parsed.jobs.map((j) => {
                      const row = jobRowByNumber.get(j.jobNumber);
                      const under = row?.underBillingCents ?? 0;
                      const over = row?.overBillingCents ?? 0;
                      return (
                        <tr key={j.jobNumber} className="border-b border-slate-900 last:border-0">
                          <td className="px-3 py-2">
                            <div className="text-white">{j.jobNumber}</div>
                            <div className="text-xs text-slate-500">{j.jobName}{j.customerName ? ` · ${j.customerName}` : ''}</div>
                          </td>
                          <td className="px-3 py-2 text-right font-mono tabular-nums text-slate-300">{(row?.pctCompleteDisplay ?? 0).toFixed(1)}%</td>
                          <td className="px-3 py-2 text-right font-mono tabular-nums text-slate-300">{formatMoney(row?.earnedRevenueCents ?? 0)}</td>
                          <td className="px-3 py-2 text-right font-mono tabular-nums text-slate-300">{formatMoney(row?.billedToDateCents ?? 0)}</td>
                          <td className="px-3 py-2 text-right font-mono tabular-nums">
                            {under > 0 ? <span className="text-brand-400">{formatMoney(under)} under</span>
                              : over > 0 ? <span className="text-red-400">{formatMoney(over)} over</span>
                              : <span className="text-slate-500">on target</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Commit */}
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-slate-500">
                  {companyId ? 'Ready to import into your book of record.' : 'Select a company first to import these jobs.'}
                </p>
                <button
                  type="button"
                  onClick={handleCommit}
                  disabled={!canCommit || committing}
                  className={`inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/60 ${
                    !canCommit || committing ? 'cursor-not-allowed bg-slate-700 text-slate-500' : 'bg-brand-500 text-slate-900 hover:bg-brand-400'
                  }`}
                >
                  {committing ? 'Importing…' : `Import ${parsed.jobs.length} job${parsed.jobs.length === 1 ? '' : 's'}`}
                </button>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

function labelFor(field: string): string {
  switch (field) {
    case 'contractValueCents': return 'contract value';
    case 'estimatedCostCents': return 'estimated cost (EAC)';
    case 'costsToDateCents': return 'costs to date';
    case 'billedToDateCents': return 'billed to date';
    default: return field;
  }
}

function TieStat({ label, cents, accent, muted }: { label: string; cents: number; accent?: boolean; muted?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className={`font-mono tabular-nums ${accent ? 'text-brand-300' : muted ? 'text-slate-400' : 'text-white'}`}>{formatMoney(cents)}</dd>
    </div>
  );
}

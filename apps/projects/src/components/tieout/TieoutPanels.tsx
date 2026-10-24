'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button, ButtonLink, Status, WidgetState, clockTime, count, money, shortDate, type StatusKind } from '@meritbooks/merit-ui';
import {
  checkDef, companySummary, diffOf, figureText, fixAction, jobSummary, seesCheck, sortChecks, type TieoutLoad, type TieoutRow, type TieoutStatus,
} from '@/lib/crm/tieout';
import { useMoneyVis } from '@/components/shell/ShellContext';
import '@/components/crm/crm.css';

const STATUS: Readonly<Record<TieoutStatus, { kind: StatusKind; word: string }>> = {
  ok: { kind: 'ready', word: 'Ties' },
  exception: { kind: 'overdue', word: 'Differs' },
  pending: { kind: 'track', word: 'Waiting' },
};

const m = (c: number) => money(c);

function asOfText(iso: string | null): string {
  return iso ? `as of ${shortDate(iso)} ${clockTime(iso)}` : 'checked nightly and on demand';
}

function NotLive({ title }: { title: string }) {
  return <WidgetState state={{ kind: 'empty', title, body: 'The checks against Merit Books start with the next database update. Until then, the seam health on Home shows what was sent.' }} />;
}

/**
 * "Ties to Books" on the job page (SHARED-RECORDS §6): each check with the Projects and Books
 * figures, the difference, the likely cause and the one action that fixes it. Figures follow the
 * caller's money grants at the job's company (rows arrive masked from the server).
 */
export function JobTieoutPanel({ load, jobId }: { load: TieoutLoad; jobId: string }) {
  const router = useRouter();
  const mv = useMoneyVis();
  const head = (
    <div className="tie-head">
      <h2 className="t-section" id="tie-h">Ties to Books</h2>
      {load.kind === 'ready' && (() => {
        const s = jobSummary(load.rows);
        return <>{s.status === 'ok' ? <span className="tie-ok">Ties to Books</span> : <Status kind={STATUS[s.status].kind}>{s.headline}</Status>}<span className="t-cap">{asOfText(s.asOf)}</span></>;
      })()}
      <span className="sp" />
      <Button variant="quiet" onClick={() => router.refresh()}>Check again</Button>
    </div>
  );
  return (
    <section className="sec" aria-labelledby="tie-h" style={{ marginTop: 24 }}>
      {head}
      <div className="surface" style={{ marginTop: 12 }}>
        {load.kind === 'not_live' ? <NotLive title="Not checked yet" />
          : load.kind === 'error' ? <WidgetState state={{ kind: 'error', title: 'The check didn’t run', body: `${load.message} Try again; if it repeats, tell support.`, onRetry: () => router.refresh(), retryLabel: 'Check again' }} />
            : load.rows.length === 0 ? <WidgetState state={{ kind: 'empty', title: 'Nothing to tie out yet', body: 'Checks start once the job has cost, billing, deposits, commitments or time in either app.' }} />
              : <CheckTable rows={sortChecks(load.rows)} jobId={jobId} showFigures={mv.cost || mv.contract} />}
      </div>
    </section>
  );
}

function CheckTable({ rows, jobId, showFigures }: { rows: TieoutRow[]; jobId: string; showFigures: boolean }) {
  const mv = useMoneyVis();
  return (
    <table className="crm-mini" aria-label="Checks against Merit Books">
      <thead>
        <tr>
          <th>Check</th><th>Status</th>
          {showFigures && <><th className="n">Projects</th><th className="n">Books</th><th className="n">Difference</th></>}
          <th>Cause</th><th><span className="sr">Fix</span></th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const def = checkDef(r.checkKey);
          const sees = seesCheck(def, mv);
          const fix = r.status === 'ok' ? null : fixAction({ ...r, jobId });
          return (
            <tr key={r.checkKey}>
              <td className="b">{def.label}</td>
              <td><Status kind={STATUS[r.status].kind}>{STATUS[r.status].word}</Status></td>
              {showFigures && (
                <>
                  <td className="n">{sees || def.unit !== 'money' ? figureText(def, r.projects, m) : '—'}</td>
                  <td className="n">{sees || def.unit !== 'money' ? figureText(def, r.books, m) : '—'}</td>
                  <td className={`n${r.status === 'exception' ? ' neg b' : ''}`}>{sees || def.unit !== 'money' ? figureText(def, diffOf(r), m) : '—'}</td>
                </>
              )}
              <td className="l2">{r.status === 'ok' ? 'Both sides agree' : r.cause ?? def.cause}</td>
              <td>{fix ? <ButtonLink variant="quiet" href={fix.href}>{fix.label}</ButtonLink> : null}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/**
 * The company summary on the management and office homes: per check, how many jobs tie, and the
 * exceptions ranked by dollar difference, each with its fix. Masked per row at the job's company.
 */
export function CompanyTieoutPanel({ load, pendingDuplicates, jobLabels }: { load: TieoutLoad; pendingDuplicates: number | null; jobLabels: Readonly<Record<string, string>> }) {
  const router = useRouter();
  const mv = useMoneyVis();
  const sum = load.kind === 'ready' ? companySummary(load.rows) : null;
  const allOk = !!sum && sum.exceptions.length === 0 && !pendingDuplicates;
  return (
    <section className="sec" aria-labelledby="ctie-h" style={{ marginTop: 24 }}>
      <div className="tie-head">
        <h2 className="t-section" id="ctie-h">Ties to Books</h2>
        {sum && (allOk ? <span className="tie-ok">Every job ties to Books</span> : <Status kind="overdue">{count(sum.exceptions.length)} {sum.exceptions.length === 1 ? 'difference' : 'differences'} to fix</Status>)}
        {sum && <span className="t-cap">{count(sum.jobsTied)} of {count(sum.jobsChecked)} jobs tie</span>}
        <span className="sp" />
        <Button variant="quiet" onClick={() => router.refresh()}>Check again</Button>
      </div>
      <div className="surface" style={{ marginTop: 12 }}>
        {load.kind === 'not_live' ? <NotLive title="Not checked yet" />
          : load.kind === 'error' ? <WidgetState state={{ kind: 'error', title: 'The check didn’t run', body: `${load.message} Try again; if it repeats, tell support.`, onRetry: () => router.refresh(), retryLabel: 'Check again' }} />
            : !sum || sum.jobsChecked === 0 ? <WidgetState state={{ kind: 'empty', title: 'Nothing to tie out yet', body: 'Checks start once jobs have cost, billing or time in either app.' }} />
              : (
                <div className="stack">
                  <table className="crm-mini" aria-label="Checks by kind">
                    <thead><tr><th>Check</th><th className="n">Jobs that tie</th><th className="n">Differ</th><th className="n">Waiting</th>{(mv.cost || mv.contract) && <th className="n">Total difference</th>}</tr></thead>
                    <tbody>
                      {sum.checks.map((c) => {
                        const def = checkDef(c.key);
                        return (
                          <tr key={c.key}>
                            <td className="b">{c.label}</td>
                            <td className="n">{count(c.ok)}</td>
                            <td className={`n${c.exceptions ? ' neg b' : ''}`}>{count(c.exceptions)}</td>
                            <td className="n">{count(c.pending)}</td>
                            {(mv.cost || mv.contract) && <td className="n">{def.unit === 'money' && seesCheck(def, mv) && c.diffAbs != null ? money(c.diffAbs) : '—'}</td>}
                          </tr>
                        );
                      })}
                      {pendingDuplicates != null && (
                        <tr>
                          <td className="b">Customers</td>
                          <td className="n" colSpan={1}>{pendingDuplicates ? '—' : 'All'}</td>
                          <td className={`n${pendingDuplicates ? ' neg b' : ''}`}>{count(pendingDuplicates)}</td>
                          <td className="n">0</td>
                          {(mv.cost || mv.contract) && <td className="n">—</td>}
                        </tr>
                      )}
                    </tbody>
                  </table>
                  {(sum.exceptions.length > 0 || !!pendingDuplicates) && (
                    <table className="crm-mini" aria-label="Differences, largest first">
                      <thead><tr><th>Job</th><th>Check</th><th className="n">Difference</th><th>Cause</th><th><span className="sr">Fix</span></th></tr></thead>
                      <tbody>
                        {sum.exceptions.slice(0, 15).map((r) => {
                          const def = checkDef(r.checkKey);
                          const fix = fixAction(r);
                          return (
                            <tr key={`${r.jobId}:${r.checkKey}`} className="is-link" onClick={() => router.push(`/jobs/${r.jobId}`)}>
                              <td><Link className="link" href={`/jobs/${r.jobId}`} onClick={(e) => e.stopPropagation()}>{jobLabels[r.jobId] ?? 'Job'}</Link></td>
                              <td>{def.label}</td>
                              <td className="n neg b">{seesCheck(def, mv) || def.unit !== 'money' ? figureText(def, diffOf(r), m) : '—'}</td>
                              <td className="l2">{r.cause ?? def.cause}</td>
                              <td>{fix ? <ButtonLink variant="quiet" href={fix.href}>{fix.label}</ButtonLink> : null}</td>
                            </tr>
                          );
                        })}
                        {!!pendingDuplicates && (
                          <tr className="is-link" onClick={() => router.push('/customers/duplicates')}>
                            <td>All jobs</td><td>Customers</td><td className="n">{count(pendingDuplicates)} pairs</td>
                            <td className="l2">Possible duplicate customers are waiting for review.</td>
                            <td><ButtonLink variant="quiet" href="/customers/duplicates">Review duplicates</ButtonLink></td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  )}
                  {sum.exceptions.length > 15 && <p className="t-cap">{count(sum.exceptions.length - 15)} more differences. Open a job to see its checks.</p>}
                </div>
              )}
      </div>
    </section>
  );
}

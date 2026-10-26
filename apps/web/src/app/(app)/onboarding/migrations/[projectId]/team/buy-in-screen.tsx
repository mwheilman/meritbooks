'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Button, ButtonLink, InlineNotice, PageHead, Seg, Status, Textarea, useQuery } from '@meritbooks/merit-ui';
import { useShellLine } from '@/components/layout/shell-context';
import type { BuyInRole } from '@/lib/onboarding/migration/buyin';
import type { BuyInView } from '../../_shared/dto';
import { useAction } from '../../_shared/ui';
import s from '../../migrations.module.css';

const ROLES: Array<{ value: BuyInRole; label: string }> = [
  { value: 'bookkeeper', label: 'Bookkeeper' },
  { value: 'accounting_manager', label: 'Accounting manager' },
  { value: 'controller', label: 'Controller' },
  { value: 'ap_clerk', label: 'AP clerk' },
  { value: 'owner', label: 'Owner' },
];

const hrs = (h: number) => `${h.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} h`;

export function BuyInScreen({ projectId }: { projectId: string }) {
  const [role, setRole] = useState<BuyInRole>('bookkeeper');
  const { data, error, isLoading } = useQuery<BuyInView>('/api/onboarding/migrations/buy-in', { id: projectId, role }, { scope: false });
  const [mismatch, setMismatch] = useState('');
  const { busy, run } = useAction();
  useShellLine(data ? [data.clientName, `Coming from ${data.priorSystem}`, { label: data.timeSaved.savedHours ? `About ${hrs(data.timeSaved.savedHours)} a month back` : 'Time saved appears once volumes exist', strong: true }] : null, data ? `${projectId}:${role}` : 'loading');

  return (
    <div className={s.stack}>
      <PageHead
        eyebrow={['Migration', data?.clientName ?? 'Client', 'Team guide']}
        title="What changes on Monday"
        actions={<ButtonLink href={`/onboarding/migrations/${projectId}`} variant="quiet">Back to the migration</ButtonLink>}
      >
        You keep doing the work you know. The typing goes away. Here’s what stays, what’s automated, where things moved and what’s new — using this client’s own numbers.
      </PageHead>
      <Seg aria-label="Role" value={role} onChange={setRole} items={ROLES} />
      {error && <InlineNotice tone="neg" title="The guide didn’t load.">{error}</InlineNotice>}
      {isLoading && !data && <p className="t-cap" role="status">Loading…</p>}
      {data && (
        <>
          <div className={s.cols2}>
            <section className={s.surface}>
              <div className={s.head}><h3>What stays the same</h3></div>
              <ul className={s.list}>{data.workflow.stays.map((x, i) => <li key={i}><b>{x.title}</b>{x.detail}</li>)}</ul>
            </section>
            <section className={s.surface}>
              <div className={s.head}><h3>What’s automated now</h3></div>
              <ul className={s.list}>{data.workflow.automated.map((x, i) => <li key={i}><b>{x.title}</b>{x.detail}</li>)}</ul>
            </section>
          </div>

          <section className={s.surface} aria-labelledby="saved">
            <div className={s.head}><h3 id="saved">Time back each month</h3><span className={s.muted}>An estimate from this client’s own volumes — the basis is printed on every line</span></div>
            {data.timeSaved.lines.length === 0 ? (
              <p className={s.state}>No volumes yet. Once the bank feed, bills or invoices exist for {data.clientName} (or the agings are staged), the estimate appears here.</p>
            ) : (
              <table className={s.simple}>
                <thead><tr><th>Work</th><th className={s.n}>A month</th><th>Based on</th><th className={s.n}>Today</th><th className={s.n}>In MeritBooks</th><th className={s.n}>Back</th></tr></thead>
                <tbody>
                  {data.timeSaved.lines.map((l) => (
                    <tr key={l.key}>
                      <td>{l.label}<span className={s.sub}>{l.why}</span></td>
                      <td className={s.n}>{l.perMonth.toLocaleString('en-US')}</td>
                      <td className={s.small}>{l.basis}</td>
                      <td className={s.n}>{hrs(l.beforeHours)}</td>
                      <td className={s.n}>{hrs(l.afterHours)}</td>
                      <td className={s.n}>{hrs(l.savedHours)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot><tr><td colSpan={3}>Total</td><td className={s.n}>{hrs(data.timeSaved.beforeHours)}</td><td className={s.n}>{hrs(data.timeSaved.afterHours)}</td><td className={s.n}>{hrs(data.timeSaved.savedHours)}</td></tr></tfoot>
              </table>
            )}
            <p className={`${s.padSm} ${s.small} ${s.muted}`}>
              Time standards (minutes per item, today → MeritBooks): {data.standards.map((t) => `${t.label.toLowerCase()} ${t.beforeMin} → ${t.afterMin}`).join(' · ')}.
            </p>
          </section>

          <div className={s.cols2}>
            <section className={s.surface}>
              <div className={s.head}><h3>Where things moved</h3><span className={s.muted}>from {data.priorSystem}</span></div>
              <table className={s.simple}>
                <thead><tr><th>Before</th><th>In MeritBooks</th></tr></thead>
                <tbody>{data.workflow.moved.map((m, i) => <tr key={i}><td>{m.before}</td><td>{m.after}</td></tr>)}</tbody>
              </table>
              {data.terminology.length > 0 && (
                <>
                  <div className={s.head}><h3>Words that changed</h3></div>
                  <table className={s.simple}><tbody>{data.terminology.map((t, i) => <tr key={i}><td>{t.before}</td><td>{t.after}</td></tr>)}</tbody></table>
                </>
              )}
            </section>
            <section className={s.surface}>
              <div className={s.head}><h3>What’s new for you</h3></div>
              <ul className={s.list}>{data.workflow.newForYou.map((x, i) => <li key={i}><b>{x.title}</b>{x.detail}</li>)}</ul>
            </section>
          </div>

          <section className={s.surface} aria-labelledby="week">
            <div className={s.head}><h3 id="week">Your first week</h3><span className={s.muted}>{data.checklist.filter((c) => c.done).length} of {data.checklist.length} · on {data.clientName}, never a demo company</span></div>
            <ul className={s.list}>
              {data.checklist.map((c) => (
                <li key={c.key} className={s.check}>
                  {c.done ? <Status kind="ready">Done</Status> : <Status kind="track" pip="open">To do</Status>}
                  <span><b>{c.title}</b><span className={s.sub}>{c.detail}</span></span>
                  {!c.done && <Link href={c.href}>Start</Link>}
                </li>
              ))}
            </ul>
          </section>

          <section className={s.surface} aria-labelledby="mismatch">
            <div className={s.head}><h3 id="mismatch">Something doesn’t look right?</h3><span className={s.muted}>It goes to the migration lead with the context attached</span></div>
            <div className={s.padSm}>
              <Textarea aria-label="Report a mismatch" rows={2} value={mismatch} onChange={(e) => setMismatch(e.target.value)} placeholder="Which number, and what you expected." />
              <div className={s.row} style={{ marginTop: 8 }}>
                <Button disabled={mismatch.trim().length < 5 || busy !== null} onClick={async () => { if (await run('mm', '/api/onboarding/migrations/project', { action: 'comment', id: projectId, text: `Mismatch reported: ${mismatch.trim()}`.slice(0, 560) })) setMismatch(''); }}>Report a mismatch</Button>
              </div>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

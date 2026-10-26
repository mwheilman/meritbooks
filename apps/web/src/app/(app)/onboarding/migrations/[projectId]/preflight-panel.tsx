'use client';

import { useMemo, useState } from 'react';
import { Button, InlineNotice, Textarea, useQuery } from '@meritbooks/merit-ui';
import { dollars } from '@/lib/onboarding/migration/format';
import type { FindingRow, PreflightData, WorkspaceData } from '../_shared/dto';
import { SeverityWord, useAction, when } from '../_shared/ui';
import s from '../migrations.module.css';

const ORDER: Record<string, number> = { blocker: 0, warning: 1, info: 2, passed: 3, not_applicable: 4 };
const DISPO_WORD: Record<string, string> = {
  open: 'Not decided',
  fixed_in_source: 'Fix in the old system — re-checked on the next pull',
  carry_as_reconciling_item: 'Handled here — carried as one reconciling item',
  accepted_with_note: 'Accepted',
  not_applicable: 'Not applicable',
};

function Finding({ f, projectId, onSaved }: { f: FindingRow; projectId: string; onSaved: () => void }) {
  const [open, setOpen] = useState(f.severity === 'blocker' && f.disposition === 'open');
  const [note, setNote] = useState(f.disposition_note ?? '');
  const { busy, run } = useAction();
  const decide = async (disposition: string) => {
    if (await run(disposition, '/api/onboarding/migrations/preflight', { action: 'decide', id: projectId, check_id: f.check_id, disposition, note: note.trim() || null })) onSaved();
  };
  const needsNote = note.trim().length < 10;
  return (
    <article className={s.finding} aria-label={f.name}>
      <div className={s.findingHead}>
        <SeverityWord severity={f.severity} />
        <div>
          <b>{f.title}</b>
          <span className={s.sub}>{f.name} · {DISPO_WORD[f.disposition]}{f.disposed_at ? ` · ${when(f.disposed_at)}` : ''}</span>
        </div>
        <div className={s.row}>
          <span className={`${s.n} ${s.strong}`}>{f.amount_cents ? dollars(f.amount_cents) : '—'}</span>
          <Button variant="quiet" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Open'}</Button>
        </div>
      </div>
      {open && (
        <div className={s.findingBody}>
          <p>{f.message}</p>
          {(f.records.sample ?? []).length > 0 && (
            <>
              <span className={s.label}>Behind it{f.records.count ? ` · ${f.records.count}` : ''}</span>
              <ul className={s.sample}>{(f.records.sample ?? []).map((x, i) => <li key={i}>{x}</li>)}</ul>
            </>
          )}
          {f.accounts.length > 0 && <p className={s.small}>Accounts: {f.accounts.join(' · ')}</p>}
          {f.fix && <p className={s.small}><b>Suggested fix.</b> {f.fix}</p>}
          {(f.severity === 'blocker' || f.severity === 'warning' || f.severity === 'info') && (
            <div className={s.stack}>
              <Textarea aria-label="What you decided" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Say what you decided (prints on the certificate). Required to handle it here or accept it." />
              <div className={s.row}>
                <Button disabled={busy !== null} onClick={() => decide('fixed_in_source')}>Fix in the old system</Button>
                <Button disabled={busy !== null || needsNote} onClick={() => decide('carry_as_reconciling_item')} title={needsNote ? 'Write a sentence first' : undefined}>Handle it here</Button>
                {f.severity !== 'blocker' && <Button disabled={busy !== null || needsNote} onClick={() => decide('accepted_with_note')}>Accept</Button>}
                {f.disposition !== 'open' && <Button variant="quiet" disabled={busy !== null} onClick={() => decide('open')}>Reopen</Button>}
              </div>
              {f.severity === 'blocker' && <p className={s.small}>A blocker stops “Prove balances” until it is handled here as one reconciling item, or fixed in the old system and re-checked.</p>}
            </div>
          )}
        </div>
      )}
    </article>
  );
}

export function PreflightPanel({ data, onChanged }: { data: WorkspaceData; onChanged: () => void }) {
  const [key, setKey] = useState(0);
  const { data: pf, error, isLoading } = useQuery<PreflightData>('/api/onboarding/migrations/preflight', { id: data.project.id }, { key: String(key), scope: false });
  const { busy, run } = useAction();
  const reload = () => { setKey((k) => k + 1); onChanged(); };
  const findings = useMemo(() => [...(pf?.findings ?? [])].sort((a, b) => ORDER[a.severity] - ORDER[b.severity] || b.amount_cents - a.amount_cents), [pf]);
  const counts = useMemo(() => {
    const c = { blocker: 0, warning: 0, info: 0, passed: 0, not_applicable: 0, blockerCents: 0, undecided: 0 };
    for (const f of pf?.findings ?? []) {
      c[f.severity]++;
      if (f.severity === 'blocker' && f.disposition !== 'carry_as_reconciling_item') c.blockerCents += f.amount_cents;
      if ((f.severity === 'warning' || f.severity === 'blocker') && f.disposition === 'open') c.undecided++;
    }
    return c;
  }, [pf]);
  const [copied, setCopied] = useState(false);

  if (error) return <InlineNotice tone="neg" title="The checks didn’t load.">{error}</InlineNotice>;
  if (isLoading && !pf) return <p className="t-cap" role="status">Loading the checks…</p>;
  const ran = (pf?.findings.length ?? 0) > 0;
  const runChecks = async () => { if (await run('run', '/api/onboarding/migrations/preflight', { action: 'run', id: data.project.id })) reload(); };

  const reportText = pf
    ? [
        `What we found in ${data.client?.name ?? 'your'} books before we moved them`,
        `We ran 24 checks and ${pf.report.passed} passed outright.`,
        ...(pf.report.fixInSource.length ? ['', 'Please fix these in your current system:'] : []),
        ...pf.report.fixInSource.map((f) => `• ${f.title} — ${f.amount_cents ? dollars(f.amount_cents) : ''}`),
        ...(pf.report.handled.length ? ['', `We’re handling ${pf.report.handled.length} more for you:`] : []),
        ...pf.report.handled.map((f) => `• ${f.title}${f.disposition_note ? ` — ${f.disposition_note}` : ''}`),
        '',
        'Nothing in your old system was changed. MeritBooks only reads.',
      ].join('\n')
    : '';

  return (
    <div className={s.stack}>
      <div className={s.between}>
        <span className={s.ink2}>
          {ran ? `${counts.blocker} blocker${counts.blocker === 1 ? '' : 's'} (${dollars(counts.blockerCents)} open) · ${counts.warning} warnings · ${counts.info} info · ${counts.passed} passed · ${counts.not_applicable} not applicable` : 'The 24 checks run on whatever is staged. Rules only, no AI.'}
        </span>
        <Button variant="primary" onClick={runChecks} disabled={busy === 'run'}>{busy === 'run' ? 'Running 24 checks…' : ran ? 'Run the checks again' : 'Check data quality'}</Button>
      </div>
      {!ran ? (
        <div className={`${s.surface} ${s.state}`}>
          <p>Drop the trial balance and the agings first (Connect systems) — each check says what it needs if something is missing.</p>
        </div>
      ) : (
        <>
          <div className={s.tiles} role="list" aria-label="All 24 checks">
            {(pf?.findings ?? []).map((f) => (
              <div key={f.check_id} className={s.tile} role="listitem">
                <span className={s.tileCode}>{f.check_id}</span>
                <span className={s.tileName}>{f.name}</span>
                <span className={s.tileV}><SeverityWord severity={f.severity} /> {f.amount_cents ? dollars(f.amount_cents) : ''}</span>
              </div>
            ))}
          </div>
          {findings.filter((f) => f.severity === 'blocker' || f.severity === 'warning' || f.severity === 'info').map((f) => (
            <Finding key={f.check_id} f={f} projectId={data.project.id} onSaved={reload} />
          ))}
          {counts.blocker === 0 && counts.undecided === 0 && <InlineNotice title="No blockers, and every warning has a decision.">Next: match the accounts.</InlineNotice>}
          <section className={s.surface} aria-labelledby="client-report">
            <div className={s.head}>
              <h3 id="client-report">Send to the client</h3>
              <span className={s.muted}>What we found in their books before we moved them — a gift, not a gate</span>
              <span className={s.grow} />
              <Button onClick={async () => { await navigator.clipboard.writeText(reportText); setCopied(true); setTimeout(() => setCopied(false), 2000); }}>{copied ? 'Copied' : 'Copy the report'}</Button>
            </div>
            <pre className={s.padSm} style={{ whiteSpace: 'pre-wrap', margin: 0, fontFamily: 'inherit' }}>{reportText}</pre>
          </section>
        </>
      )}
    </div>
  );
}

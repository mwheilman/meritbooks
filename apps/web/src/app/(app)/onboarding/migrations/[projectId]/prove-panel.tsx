'use client';

import { useState } from 'react';
import { Button, ButtonLink, ConfirmDialog, InlineNotice, Status, Tag, api, toast, useQuery } from '@meritbooks/merit-ui';
import { dollars, longDate } from '@/lib/onboarding/migration/format';
import type { CertificateTie, Stage } from '@/lib/onboarding/migration/types';
import type { CertificateView, OpenItemsPayload, WorkspaceData } from '../_shared/dto';
import { amt, useAction, when } from '../_shared/ui';
import s from '../migrations.module.css';

const TIE_STATUS: Record<CertificateTie['status'], { kind: 'ready' | 'blocked' | 'track' | 'risk'; word: string }> = {
  tied: { kind: 'ready', word: 'Ties' },
  difference: { kind: 'blocked', word: 'Difference' },
  waiting: { kind: 'risk', word: 'Waiting' },
  not_applicable: { kind: 'track', word: 'Not applicable' },
};
const EVIDENCE: Record<CertificateTie['evidence'], string> = { evidenced: 'Evidenced', internal_only: 'Internal only', not_applicable: '' };

function TieBlock({ t }: { t: CertificateTie }) {
  const st = TIE_STATUS[t.status];
  return (
    <div className={s.tie}>
      <div className={s.tieHead}>
        <b>{t.label}</b>
        <span><Status kind={st.kind}>{st.word}</Status>{EVIDENCE[t.evidence] ? <span className={s.sub}>{EVIDENCE[t.evidence]}</span> : null}</span>
        <span className={s.ink2}>{t.summary}</span>
      </div>
      {t.lines.length > 0 && (
        <table className={s.tieLines}>
          <thead><tr><th>Figure</th><th>Old books</th><th>MeritBooks</th><th>Difference</th></tr></thead>
          <tbody>
            {t.lines.map((l, i) => (
              <tr key={i}>
                <td>{l.label}</td>
                <td className={s.n}>{amt(l.sourceCents)}</td>
                <td className={s.n}>{amt(l.meritCents)}</td>
                <td className={`${s.n} ${l.differenceCents ? s.neg : ''}`}>{l.differenceCents ? amt(l.differenceCents) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function ProvePanel({ data, focus, onChanged }: { data: WorkspaceData; focus: Stage; onChanged: () => void }) {
  const [key, setKey] = useState(0);
  const { data: cv, error, isLoading } = useQuery<CertificateView>('/api/onboarding/migrations/certificate', { id: data.project.id }, { key: String(key), scope: false });
  const { busy, run } = useAction();
  const [voidOpen, setVoidOpen] = useState(false);
  const [loading, setLoading] = useState<null | 'ar' | 'ap'>(null);
  const pid = data.project.id;
  const reload = () => { setKey((k) => k + 1); onChanged(); };

  const loadOpenItems = async (kind: 'ar' | 'ap') => {
    setLoading(kind);
    try {
      const p = await api.post<OpenItemsPayload>('/api/onboarding/migrations/load', { action: 'open_items', id: pid, kind });
      if (p.error || !p.data) { toast(p.error?.error ?? 'Could not prepare the open items', { tone: 'neg' }); return; }
      // The existing importer creates the open invoices / bills (no GL post — the control is in the opening) and attaches Σ open to the opening.
      const r = await api.post<{ message?: string; error?: string }>(`/api/onboarding/import/${kind}`, { action: 'commit', source: 'manual', companyId: p.data.companyId, parties: p.data.parties, openItems: p.data.openItems });
      if (r.error) { toast(r.error.error, { tone: 'neg' }); return; }
      toast(`Loaded ${p.data.count} open ${kind === 'ar' ? 'invoices' : 'bills'} · ${dollars(p.data.totalCents)}${p.data.skippedUnapplied ? ` · ${p.data.skippedUnapplied} unapplied credits stay in the reconciling item` : ''}`, { tone: 'info' });
      reload();
    } finally {
      setLoading(null);
    }
  };

  if (error) return <InlineNotice tone="neg" title="The ties didn’t compute.">{error}</InlineNotice>;
  if (isLoading && !cv) return <p className="t-cap" role="status">Computing the ties…</p>;
  if (!cv) return null;
  const cert = cv.certificate;
  const live = !!data.project.live_at;
  const iAmPreparer = !data.project.preparer_user_id || data.project.preparer_user_id === data.me;

  return (
    <div className={s.stack}>
      {focus === 'tie_out' && (
        <section className={s.surface} aria-labelledby="load-title">
          <div className={s.head}><h3 id="load-title">Load the opening</h3><span className={s.muted}>Into the existing conversion engine — every run is staged first and posts through the same checks as any journal entry.</span></div>
          <ol className={s.steps}>
            <li>
              <b>Opening balances {data.project.cutover_date ? `as of ${longDate(data.project.cutover_date)}` : ''}</b>
              {data.session ? (data.session.posted ? <Tag tone="pos">Posted</Tag> : <Tag tone="warn">Staged — review and post</Tag>) : <span className={s.muted}>From the staged trial balance and your matches.</span>}
              <div className={s.row} style={{ marginTop: 6 }}>
                {!data.session?.posted && (
                  <Button variant={data.session ? 'default' : 'primary'} disabled={busy !== null} onClick={async () => { if (await run('open', '/api/onboarding/migrations/load', { action: 'stage_opening', id: pid })) reload(); }}>
                    {data.session ? 'Refresh from the matches' : 'Load opening balances'}
                  </Button>
                )}
                {data.session && <ButtonLink href={`/onboarding/conversion?sessionId=${data.session.id}`} variant={data.session.posted ? 'quiet' : 'primary'}>{data.session.posted ? 'See the opening entry' : 'Review, tie out and post'}</ButtonLink>}
              </div>
            </li>
            <li>
              <b>Open invoices (A/R)</b>
              <span className={s.muted}>Loaded once from the ledger’s aging; customers link to the records you chose.</span>
              <div className={s.row} style={{ marginTop: 6 }}><Button disabled={!data.session || loading !== null} onClick={() => loadOpenItems('ar')}>{loading === 'ar' ? 'Loading…' : 'Load open invoices'}</Button></div>
            </li>
            <li>
              <b>Open bills (A/P)</b>
              <div className={s.row} style={{ marginTop: 6 }}><Button disabled={!data.session || loading !== null} onClick={() => loadOpenItems('ap')}>{loading === 'ap' ? 'Loading…' : 'Load open bills'}</Button></div>
            </li>
          </ol>
          <p className={`${s.padSm} ${s.small} ${s.muted}`}>Load the open items after the opening is staged and before it posts, so the opening review includes the subledger ties.</p>
        </section>
      )}

      <section className={s.surface} aria-labelledby="ties-title">
        <div className={s.head}>
          <h3 id="ties-title">Old books minus MeritBooks</h3>
          <span className={s.muted}>at {cv.asOf ? longDate(cv.asOf) : 'the cutover'} · five ties</span>
          <span className={s.grow} />
          <Button variant="quiet" onClick={() => setKey((k) => k + 1)}>Recompute</Button>
        </div>
        {cv.ties.map((t) => <TieBlock key={t.key} t={t} />)}
        <p className={`${s.padSm} ${s.small} ${s.muted}`}>Internal only means the old ledger is the only evidence; it doesn’t block, and it prints on the certificate.</p>
      </section>

      {!cert || cert.status === 'voided' ? (
        <section className={s.surface} aria-labelledby="proof-title">
          <div className={s.head}><h3 id="proof-title">Sign the balance proof</h3><span className={s.muted}>The preparer signs; a different person signs off.</span></div>
          {cv.proof.ready ? (
            <div className={s.padSm}>
              <p>Every tie is zero and every decision is made. Signing prepares the Conversion Certificate for {data.names.reviewer ?? 'the reviewer'}.</p>
              <Button variant="primary" disabled={busy !== null || !iAmPreparer} onClick={async () => { if (await run('sign', '/api/onboarding/migrations/certificate', { action: 'sign_proof', id: pid })) reload(); }}>Sign balance proof</Button>
              {!iAmPreparer && <p className={s.small}>Only {data.names.preparer ?? 'the preparer'} signs the balance proof.</p>}
            </div>
          ) : (
            <>
              <p className={s.padSm}>Locked until these are done:</p>
              <ul className={s.blockers}>{cv.proof.blockers.map((b, i) => <li key={i}>{b}</li>)}</ul>
            </>
          )}
        </section>
      ) : (
        <section className={s.cert} aria-labelledby="cert-title">
          <div className={s.head}>
            <span className={s.label}>Conversion certificate</span>
            <span id="cert-title" className={s.certNum}>{cert.number}</span>
            {cert.version > 1 && <Tag>version {cert.version}</Tag>}
            <span className={s.grow} />
            {cert.status === 'issued' ? <Status kind="ready">Signed off</Status> : <Status kind="risk">Waiting for the reviewer</Status>}
            <ButtonLink href={`/api/onboarding/migrations/certificate/pdf?id=${pid}`} variant="quiet">PDF</ButtonLink>
          </div>
          <div className={s.sig}>
            <div><span className={s.label}>Prepared — balance proof</span>{data.people.find((x) => x.userId === cert.preparedBy)?.name ?? 'Preparer'}<span className={s.sub}>{when(cert.preparedAt)}</span></div>
            <div><span className={s.label}>Signed off — a different person</span>{cert.approvedBy ? data.people.find((x) => x.userId === cert.approvedBy)?.name ?? 'Reviewer' : 'Not yet'}<span className={s.sub}>{when(cert.approvedAt)}</span></div>
          </div>
          <p className={`${s.padSm} ${s.small} ${s.muted}`}>sha256 {cert.contentHash}</p>
          {cert.status === 'prepared' && cv.signOff && (
            <div className={s.padSm}>
              {cv.signOff.ready ? (
                <>
                  <p>Signing off issues the certificate and locks every month up to {longDate(cert.cutoverDate)} for good. QuickBooks (or the old ledger) is archived as a source.</p>
                  <Button variant="primary" disabled={busy !== null} onClick={async () => { if (await run('off', '/api/onboarding/migrations/certificate', { action: 'sign_off', id: pid })) reload(); }}>Sign off and issue</Button>
                </>
              ) : (
                <ul className={s.blockers}>{cv.signOff.blockers.map((b, i) => <li key={i}>{b}</li>)}</ul>
              )}
            </div>
          )}
          {cert.status === 'issued' && !live && (
            <div className={s.padSm}>
              <p>Signed off. Going live makes MeritBooks the book of record for this client; the bookkeeper takes over in the close grid.</p>
              <Button variant="primary" disabled={busy !== null} onClick={async () => { if (await run('live', '/api/onboarding/migrations/certificate', { action: 'go_live', id: pid })) reload(); }}>Go live</Button>
            </div>
          )}
          {live && (
            <InlineNotice title={`Live since ${longDate(data.project.live_at?.slice(0, 10) ?? null)}.`}>
              MeritBooks is the book of record. <ButtonLink href="/close" variant="quiet">Open the close grid</ButtonLink> <ButtonLink href={`/onboarding/migrations/${pid}/team`} variant="quiet">Team guide</ButtonLink>
            </InlineNotice>
          )}
          <div className={s.padSm}><Button variant="quiet" onClick={() => setVoidOpen(true)}>Void certificate…</Button></div>
          <ConfirmDialog
            open={voidOpen}
            onClose={() => setVoidOpen(false)}
            tone="danger"
            title={`Void ${cert.number}?`}
            confirmLabel="Void certificate"
            reason={{ label: 'Why (kept with the voided certificate)', minLength: 10 }}
            onConfirm={async (reason) => { setVoidOpen(false); if (await run('void', '/api/onboarding/migrations/certificate', { action: 'void', id: pid, reason: reason ?? '' })) reload(); }}
          >
            The certificate is kept, marked void. Months already locked stay locked — reopening them is a controller step on Periods.
          </ConfirmDialog>
        </section>
      )}
    </div>
  );
}

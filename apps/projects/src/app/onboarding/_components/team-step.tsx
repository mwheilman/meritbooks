'use client';

import { useEffect, type MutableRefObject } from 'react';
import { Button, ButtonLink, InlineNotice, PageHead } from '@meritbooks/merit-ui';
import type { CompanyBrief, TeamMember } from '@/lib/onboarding/types';

/** Step 4 — "Who runs the work?" Optional. The team comes from Books; invites live there today. */
export function TeamStep({ company, team, booksTeamUrl, busy, error, onFinish, onBack, primaryRef }: {
  company: CompanyBrief;
  team: TeamMember[];
  booksTeamUrl: string;
  busy: boolean;
  error: string | null;
  onFinish: () => void;
  onBack: () => void;
  primaryRef: MutableRefObject<(() => void) | null>;
}) {
  useEffect(() => { primaryRef.current = () => { if (!busy) onFinish(); }; });
  return (
    <>
      <PageHead eyebrow={['Set up', company.name, 'Optional']} title="Who runs the work?">
        <p className="ob-lede">These are the people Merit Books already knows. Project managers, supers and techs get to their jobs from here.</p>
      </PageHead>

      <section className="ob-card" aria-labelledby="ob-team">
        <div className="ob-card-h">
          <h3 id="ob-team">Your team</h3>
          <span className="t-cap tnum">{team.length}</span>
          <span className="sp" />
          <ButtonLink variant="quiet" href={booksTeamUrl} target="_blank" rel="noreferrer" iconAfter="right">Invite in Merit Books</ButtonLink>
        </div>
        {team.length === 0 ? (
          <div className="wg-state">
            <span className="wg-empty-mark" aria-hidden="true" />
            <span className="t-head">No one on the team in Books yet</span>
            <p>Add people in Merit Books under Team. They&apos;ll show up here and can sign in to Projects with the same login.</p>
          </div>
        ) : (
          <table className="tbl tbl-q tbl-q--flush tbl-q--compact" aria-label="Team from Merit Books">
            <colgroup><col /><col style={{ width: 220 }} /><col style={{ width: 260 }} /><col style={{ width: 160 }} /></colgroup>
            <thead><tr><th>Name</th><th>Title</th><th>Email</th><th>Role</th></tr></thead>
            <tbody>
              {team.map((m) => (
                <tr key={m.id}>
                  <td><span className="l1">{m.name}</span></td>
                  <td>{m.title ?? '—'}</td>
                  <td>{m.email ?? '—'}</td>
                  <td>{m.role ? m.role.replace(/_/g, ' ') : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <div style={{ marginTop: 16 }}>
        <InlineNotice title="Invites happen in Merit Books for now.">
          Projects doesn&apos;t send invites yet. Invite people from Books&apos; Team page; they sign in once and land in both.
        </InlineNotice>
      </div>
      {error && <div style={{ marginTop: 16 }}><InlineNotice tone="neg" title={error} /></div>}

      <div className="ob-foot">
        <Button variant="quiet" chord="escape" onClick={onBack}>Back</Button>
        <span className="sp" />
        <Button variant="quiet" disabled={busy} onClick={onFinish}>Skip for now</Button>
        <Button variant="primary" size="lg" chord="enter" disabled={busy} onClick={onFinish}>{busy ? 'Finishing…' : 'Finish'}</Button>
      </div>
    </>
  );
}

'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, ConfirmDialog, Field, Select, Tag, WidgetState, api, count, toast } from '@meritbooks/merit-ui';
import type { JobTeam, JobTeamMember } from './team-data';
import { SLOT_LABEL, TEAM_SLOTS, type TeamSlot } from './team-slots';

/**
 * Who works this job (spec §2, §5). Being on the team is what makes a job "own" for a PM,
 * supervisor or crew member — it decides whose app shows the job and, for a PM, its money.
 * Add and remove go through pm.job_team_upsert / job_team_remove (projects.team:edit).
 */
export function JobTeamPanel({ jobId, team, canEdit }: { jobId: string; team: JobTeam; canEdit: boolean }) {
  const router = useRouter();
  const [who, setWho] = useState('');
  const [slot, setSlot] = useState<TeamSlot>('crew');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [removing, setRemoving] = useState<JobTeamMember | null>(null);

  const add = async () => {
    if (!who) {
      setErr('Pick the person to add.');
      return;
    }
    setErr(null);
    setBusy(true);
    const res = await api.post<{ ok: true }>(`/api/team/jobs/${jobId}`, { membershipId: who, slot });
    setBusy(false);
    if (res.error) {
      setErr(res.error.error);
      return;
    }
    const name = team.candidates.find((c) => c.membershipId === who)?.label.split(' · ')[0] ?? 'Them';
    toast(`Added ${name} as ${SLOT_LABEL[slot].toLowerCase()}`);
    setWho('');
    router.refresh();
  };

  const remove = async (m: JobTeamMember) => {
    const res = await api.delete<{ ok: true }>(`/api/team/jobs/${jobId}/members/${m.membershipId}`);
    if (res.error) {
      toast.error(res.error.error);
      return;
    }
    toast(`Removed ${m.name ?? 'them'} from the team`);
    setRemoving(null);
    router.refresh();
  };

  return (
    <section className="sec" aria-labelledby="job-team" style={{ marginTop: 24 }}>
      <div className="sec-h">
        <h2 className="t-section" id="job-team">Team</h2>
        <span className="t-cap tnum">{count(team.members.length)}</span>
        <span className="sp" />
        <span className="t-cap">People on the team see this job in their app</span>
      </div>

      {team.error ? (
        <WidgetState state={{ kind: 'error', title: 'The team didn’t load', body: `${team.error} Try again; if it repeats, tell support.`, onRetry: () => router.refresh(), retryLabel: 'Try again' }} />
      ) : team.members.length === 0 ? (
        <WidgetState
          state={{
            kind: 'empty',
            title: 'No one is on this job’s team yet',
            body: canEdit
              ? 'Add the project manager, the supervisor and the crew. Each sees the job in their own app, at their own level of money.'
              : 'The project manager or the office adds people to the team.',
          }}
        />
      ) : (
        <table className="tbl tbl-q tbl-q--compact">
          <thead>
            <tr>
              <th>Person</th>
              <th>On this job as</th>
              <th>Projects role</th>
              {canEdit && <th><span className="sr">Action</span></th>}
            </tr>
          </thead>
          <tbody>
            {team.members.map((m) => (
              <tr key={`${m.membershipId}:${m.slot}`} className="q-row">
                <td>
                  <span className="l1">{m.name ?? m.email ?? 'Team member'}</span>
                  {m.email && m.name ? <span className="l2">{m.email}</span> : null}
                </td>
                <td>{SLOT_LABEL[m.slot] ?? m.slot}</td>
                <td>{m.role ? <Tag>{m.role}</Tag> : <span className="ink-3">No Projects role</span>}</td>
                {canEdit && (
                  <td style={{ textAlign: 'right' }}>
                    <Button variant="quiet" onClick={() => setRemoving(m)} aria-label={`Remove ${m.name ?? 'this person'} from the team`}>Remove</Button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {canEdit && !team.error && (
        <form
          className="row"
          style={{ gap: 16, alignItems: 'flex-end', marginTop: 16, flexWrap: 'wrap' }}
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <Field label="Person" error={err ?? undefined} help={team.candidates.length ? undefined : 'Everyone with a Projects role at this company is already on the team.'}>
            <Select value={who} onChange={(e) => setWho(e.target.value)} disabled={!team.candidates.length} style={{ minWidth: 280 }}>
              <option value="">Pick a person…</option>
              {team.candidates.map((c) => <option key={c.membershipId} value={c.membershipId}>{c.label}</option>)}
            </Select>
          </Field>
          <Field label="On this job as">
            <Select value={slot} onChange={(e) => setSlot(e.target.value as TeamSlot)} style={{ minWidth: 180 }}>
              {TEAM_SLOTS.map((s) => <option key={s} value={s}>{SLOT_LABEL[s]}</option>)}
            </Select>
          </Field>
          <Button type="submit" variant="primary" disabled={busy || !team.candidates.length}>{busy ? 'Adding…' : 'Add to team'}</Button>
        </form>
      )}

      <ConfirmDialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        onConfirm={() => (removing ? remove(removing) : undefined)}
        title={`Remove ${removing?.name ?? 'this person'} from the team?`}
        confirmLabel="Remove from team"
        tone="danger"
      >
        {removing && removing.slot === 'pm'
          ? 'They are the project manager on this job. Once removed they stop seeing its money, and the job leaves their app unless they work it another way.'
          : 'The job leaves their app unless they are assigned to work on it another way (a task, a visit or a work order).'}
      </ConfirmDialog>
    </section>
  );
}

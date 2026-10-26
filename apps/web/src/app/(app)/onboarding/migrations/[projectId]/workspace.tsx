'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button, ButtonLink, InlineNotice, PageHead, Tag, Textarea, useQuery } from '@meritbooks/merit-ui';
import { useShellLine } from '@/components/layout/shell-context';
import { stageDefinition } from '@/lib/onboarding/migration/stages';
import { dollars, longDate } from '@/lib/onboarding/migration/format';
import type { Stage } from '@/lib/onboarding/migration/types';
import { STAGES } from '@/lib/onboarding/migration/types';
import type { WorkspaceData } from '../_shared/dto';
import { StageStatusWord, useAction, when } from '../_shared/ui';
import { PlanPanel } from './plan-panel';
import { ConnectPanel } from './connect-panel';
import { PreflightPanel } from './preflight-panel';
import { MatchPanel } from './match-panel';
import { ProvePanel } from './prove-panel';
import { PracticeClosePanel } from './practice-panel';
import s from '../migrations.module.css';

export function Workspace({ projectId }: { projectId: string }) {
  const router = useRouter();
  const params = useSearchParams();
  const [key, setKey] = useState(0);
  const { data, error, isLoading } = useQuery<WorkspaceData>('/api/onboarding/migrations/project', { id: projectId }, { key: String(key), scope: false });
  const requested = params.get('stage') as Stage | null;
  const [tab, setTab] = useState<Stage | null>(requested && (STAGES as readonly string[]).includes(requested) ? requested : null);
  const refresh = () => setKey((k) => k + 1);

  useEffect(() => {
    if (!tab && data) setTab(data.current);
  }, [data, tab]);

  const choose = (st: Stage) => {
    setTab(st);
    const sp = new URLSearchParams(Array.from(params.entries()));
    sp.set('stage', st);
    router.replace(`/onboarding/migrations/${projectId}?${sp.toString()}`, { scroll: false });
  };

  const current = data?.stages.find((x) => x.stage === data.current);
  useShellLine(
    data
      ? [
          data.client?.name ?? 'Client',
          data.project.cutover_date ? `Cutover ${longDate(data.project.cutover_date)}` : 'Cutover not set',
          { label: `${current?.label ?? ''} · day ${Math.max(0, Math.round((Date.now() - new Date(data.project.stage_changed_at).getTime()) / 86_400_000))}`, strong: true },
          ...(data.blockers.totalCents ? [`${dollars(data.blockers.totalCents)} in blockers`] : []),
          ...(data.project.target_go_live ? [`Target go-live ${longDate(data.project.target_go_live)}`] : []),
        ]
      : null,
    data ? `${data.project.id}:${data.current}:${data.blockers.totalCents}` : 'loading',
  );

  if (error) {
    return (
      <InlineNotice tone="neg" title="This migration didn’t load.">
        {error} <Button variant="quiet" onClick={refresh}>Try again</Button> <ButtonLink href="/onboarding/migrations" variant="quiet">Back to the Tower</ButtonLink>
      </InlineNotice>
    );
  }
  if (isLoading && !data) return <p className="t-cap" role="status">Loading the migration…</p>;
  if (!data) return null;

  const active = tab ?? data.current;
  const def = stageDefinition(active);
  const clientName = data.client?.name ?? 'this client';
  const n = def.number;

  return (
    <div className={s.stack}>
      <PageHead
        eyebrow={['Migration', clientName, data.wave ? `${data.wave.name}` : 'Unscheduled']}
        title={`Moving ${clientName} onto MeritBooks`}
        actions={
          <>
            <ButtonLink href="/onboarding/migrations" variant="quiet">Tower</ButtonLink>
            <ButtonLink href={`/onboarding/migrations/${projectId}/team`} variant="quiet">Team guide</ButtonLink>
            {data.certificate && <ButtonLink href={`/api/onboarding/migrations/certificate/pdf?id=${projectId}`} variant="quiet">Certificate PDF</ButtonLink>}
          </>
        }
      >
        Stage {data.stages.findIndex((x) => x.stage === data.current) + 1} of 8 · {current?.label}. Stages can be worked out of order where the data allows. Skipped shows as skipped, never as done.
      </PageHead>

      <div className={s.ws}>
        <nav className={s.rail} aria-label="Migration stages">
          <div role="tablist" aria-orientation="vertical">
            {data.stages.map((st, i) => (
              <button
                key={st.stage}
                type="button"
                role="tab"
                aria-selected={active === st.stage}
                className={`${s.railItem} ${st.status === 'done' ? s.railDone : ''} ${st.status === 'skipped' ? s.railSkipped : ''} ${st.status === 'current' ? s.railCurrent : ''}`}
                onClick={() => choose(st.stage)}
                title={`${stageDefinition(st.stage).whatHappens} Done when: ${stageDefinition(st.stage).doneWhen}`}
              >
                <span className={s.railNum}>{i + 1}</span>
                <span>
                  <span className={s.railLabel}>{st.label}</span>
                  <span className={s.railDetail}>{st.detail}</span>
                  <StageStatusWord status={st.status} />
                </span>
              </button>
            ))}
          </div>
        </nav>

        <main className={s.stack} aria-label={def.label}>
          {data.next.kind !== 'done' && (
            <div className={s.needs}>
              <div className={s.grow}>
                <span className={s.label}>Needs you</span>
                <strong>{data.next.label}</strong>
                <p>{stageDefinition(data.next.stage).doneWhen === def.doneWhen && active === data.next.stage ? `Done when: ${def.doneWhen}` : `In ${stageDefinition(data.next.stage).label}.`}</p>
              </div>
              {active !== data.next.stage && <Button variant="primary" onClick={() => choose(data.next.stage)}>{data.next.label}</Button>}
            </div>
          )}
          <section className={s.surface} aria-labelledby="stage-title">
            <div className={s.head}>
              <h2 id="stage-title">{n} · {def.label}</h2>
              <span className={s.muted}>{def.oneLine}</span>
              <span className={s.grow} />
              <StageStatusWord status={data.stages.find((x) => x.stage === active)?.status ?? 'todo'} />
            </div>
            <dl className={s.kv}>
              <dt>What happens</dt><dd>{def.whatHappens}</dd>
              <dt>Who does it</dt><dd>{def.whoDoesIt}</dd>
              <dt>Done when</dt><dd>{def.doneWhen}</dd>
            </dl>
          </section>
          {active === 'plan' && <PlanPanel data={data} onChanged={refresh} />}
          {active === 'connect' && <ConnectPanel data={data} onChanged={refresh} />}
          {active === 'preflight' && <PreflightPanel data={data} onChanged={refresh} />}
          {active === 'map' && <MatchPanel data={data} onChanged={refresh} />}
          {(active === 'tie_out' || active === 'certified' || active === 'live') && <ProvePanel data={data} focus={active} onChanged={refresh} />}
          {active === 'shadow_close' && <PracticeClosePanel data={data} onChanged={refresh} />}
        </main>

        <aside className={s.side} aria-label="Plan, people and trail">
          <section className={s.surface}>
            <div className={s.head}><h3>The plan</h3><span className={s.grow} /><Button variant="quiet" onClick={() => choose('plan')}>Change</Button></div>
            <dl className={s.kv}>
              <dt>Cutover</dt><dd>{data.project.cutover_date ? `${longDate(data.project.cutover_date)} — MeritBooks takes over the next day` : 'Not set'}</dd>
              <dt>Lead</dt><dd>{data.names.lead ?? '—'}</dd>
              <dt>Preparer</dt><dd>{data.names.preparer ?? 'Not named'}</dd>
              <dt>Reviewer</dt><dd>{data.names.reviewer ?? 'Not named'} <span className={s.muted}>· never the preparer</span></dd>
              <dt>Sources</dt><dd>{data.sources.length ? data.sources.map((x) => <Tag key={x.id}>{x.systemName}</Tag>) : 'None yet'}</dd>
              {data.certificate && (<><dt>Certificate</dt><dd>{data.certificate.number} · {data.certificate.status === 'issued' ? 'signed off' : data.certificate.status === 'prepared' ? 'waiting for the reviewer' : 'voided'}</dd></>)}
            </dl>
          </section>
          <Trail data={data} projectId={projectId} onChanged={refresh} />
        </aside>
      </div>
    </div>
  );
}

function Trail({ data, projectId, onChanged }: { data: WorkspaceData; projectId: string; onChanged: () => void }) {
  const [text, setText] = useState('');
  const { busy, run } = useAction();
  return (
    <section className={s.surface} aria-label="Comments and trail">
      <div className={s.head}><h3>What happened</h3><span className={s.muted}>system and people</span></div>
      <div className={s.padSm}>
        <Textarea aria-label="Add a comment or ask someone" rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="Comment, or ask a teammate (name them) — it stays on this migration, not in email." />
        <div className={s.row} style={{ marginTop: 8 }}>
          <Button disabled={!text.trim() || busy === 'c'} onClick={async () => { if (await run('c', '/api/onboarding/migrations/project', { action: 'comment', id: projectId, text: text.trim() })) { setText(''); onChanged(); } }}>Add comment</Button>
        </div>
      </div>
      {data.events.length === 0 ? (
        <p className={s.padSm + ' ' + s.muted}>Nothing yet.</p>
      ) : (
        <ul className={s.trail}>
          {data.events.map((e) => (
            <li key={e.id}>
              <span>{e.summary}</span>
              <span className={s.sub}>{e.actor_kind === 'system' ? 'MeritBooks' : e.actorName ?? 'Team member'} · {when(e.created_at)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

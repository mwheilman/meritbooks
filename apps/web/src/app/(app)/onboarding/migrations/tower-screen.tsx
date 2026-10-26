'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Bands,
  Button,
  ButtonLink,
  Dialog,
  Field,
  InlineNotice,
  Input,
  PageHead,
  QueueTable,
  Seg,
  Select,
  Status,
  Tag,
  useQuery,
  type QueueColumn,
  type QueueGroup,
} from '@meritbooks/merit-ui';
import { useShellLine } from '@/components/layout/shell-context';
import { STAGE_DEFINITIONS } from '@/lib/onboarding/migration/stages';
import { longDate, wholeDollars } from '@/lib/onboarding/migration/format';
import type { Stage } from '@/lib/onboarding/migration/types';
import type { TowerData, TowerRow } from './_shared/dto';
import { useAction } from './_shared/ui';
import s from './migrations.module.css';

type StageFilter = Stage | 'all';
const GUIDE_KEY = 'mb.migrations.guide.open';

function StageCell({ r }: { r: TowerRow }) {
  return (
    <>
      <span className={s.strong}>{r.stageLabel}</span>
      <span className={s.sub}>
        {r.stage === 'live' ? `since ${longDate(r.liveAt?.slice(0, 10) ?? null)}` : `day ${r.daysInStage}`}
        {r.late && <> · <span className={s.neg}>late</span></>}
      </span>
    </>
  );
}

function SourceChips({ r }: { r: TowerRow }) {
  if (r.sources.length === 0) return <span className={s.muted}>None named</span>;
  return (
    <span className={s.chips}>
      {r.sources.map((src) => (
        <Tag key={src.systemId} tone={src.pulled ? 'default' : src.missing > 0 ? 'warn' : 'default'} title={src.pulled ? 'Pulled' : src.missing > 0 ? `${src.missing} file(s) missing` : 'Not pulled yet'}>
          {src.name}
          {src.path === 'recipe' ? ' · file' : ''}
          {src.pulled ? ' · in' : src.missing > 0 ? ` · ${src.missing} missing` : ' · planned'}
        </Tag>
      ))}
    </span>
  );
}

export function TowerScreen() {
  const [key, setKey] = useState(0);
  const { data, error, isLoading } = useQuery<TowerData>('/api/onboarding/migrations', undefined, { key: String(key), scope: false });
  const [stage, setStage] = useState<StageFilter>('all');
  const [wave, setWave] = useState<string>('all');
  const [preparer, setPreparer] = useState<string>('');
  const [system, setSystem] = useState<string>('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [guideOpen, setGuideOpen] = useState(false);
  const [dialog, setDialog] = useState<null | 'add' | 'wave' | 'cutover' | 'assign'>(null);
  const { busy, run } = useAction();
  const refresh = () => setKey((k) => k + 1);

  useEffect(() => {
    setGuideOpen(typeof window !== 'undefined' && window.localStorage.getItem(GUIDE_KEY) === '1');
  }, []);

  const line = data
    ? [
        new Date(`${data.today}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }),
        ...(data.openWaves[0] ? [`Next wave · ${longDate(data.openWaves[0].cutoverDate)} cutover`] : []),
        { label: `${data.totals.live} of ${data.totals.clients} live`, strong: true },
        `${data.totals.blockerText} in open blockers`,
        ...(data.totals.overSla ? [`${data.totals.overSla} over the stage time`] : []),
      ]
    : null;
  useShellLine(line, data ? `${data.totals.clients}:${data.totals.blockerCents}:${data.totals.live}` : 'loading');

  const systems = useMemo(() => {
    const m = new Map<string, string>();
    for (const w of data?.waves ?? []) for (const r of w.rows) for (const src of r.sources) m.set(src.systemId, src.name);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [data]);

  const filtered = useMemo(() => {
    const keep = (r: TowerRow) =>
      (stage === 'all' || r.stage === stage) &&
      (!preparer || r.preparerUserId === preparer) &&
      (!system || r.sources.some((x) => x.systemId === system));
    return (data?.waves ?? [])
      .filter((w) => wave === 'all' || (w.id ?? 'none') === wave)
      .map((w) => ({ ...w, rows: w.rows.filter(keep) }))
      .filter((w) => w.rows.length > 0);
  }, [data, stage, wave, preparer, system]);

  const groups: QueueGroup<TowerRow>[] = filtered.map((w) => ({
    id: w.id ?? 'unscheduled',
    title: w.cutoverDate ? `${w.name} · ${longDate(w.cutoverDate)} cutover` : 'Unscheduled',
    count: w.rows.length,
    caption: `${w.purpose ? `${w.purpose} · ` : ''}${w.rows.length} client${w.rows.length === 1 ? '' : 's'} · ${w.blockerCents ? `${wholeDollars(w.blockerCents)} in blockers` : 'no dollar blockers'}`,
    rows: w.rows,
  }));
  const visibleCents = filtered.reduce((t, w) => t + w.blockerCents, 0);

  const columns: QueueColumn<TowerRow>[] = [
    {
      id: 'client',
      header: 'Client',
      cell: (r) => (
        <>
          <Link className={s.client} href={`/onboarding/migrations/${r.id}`}>{r.clientName}</Link>
          <span className={s.sub}>{r.clientCode} · cutover {r.cutoverDate ? longDate(r.cutoverDate) : 'Not set'}</span>
        </>
      ),
    },
    { id: 'stage', header: 'Stage', width: 150, cell: (r) => <StageCell r={r} /> },
    { id: 'sources', header: 'Sources', cell: (r) => <SourceChips r={r} /> },
    {
      id: 'blockers',
      header: 'Blockers',
      width: 190,
      cell: (r) => (r.blockerCents ? <span className={s.neg}>{r.blockerPhrase}</span> : <span className={s.muted}>{r.blockerPhrase}</span>),
    },
    {
      id: 'next',
      header: 'Next step',
      width: 200,
      cell: (r) =>
        r.next ? (
          <ButtonLink href={`/onboarding/migrations/${r.id}?stage=${r.next.stage}`} size="md" variant={r.stage === 'live' ? 'quiet' : 'default'}>
            {r.next.label}
          </ButtonLink>
        ) : (
          <ButtonLink href={`/onboarding/migrations/${r.id}`}>Open</ButtonLink>
        ),
    },
    {
      id: 'people',
      header: 'Preparer / reviewer',
      width: 170,
      cell: (r) => (
        <>
          <span>{r.preparer ?? <span className={s.muted}>No preparer</span>}</span>
          <span className={s.sub}>{r.reviewer ? `reviewer ${r.reviewer}` : 'No reviewer yet'}</span>
        </>
      ),
    },
    {
      id: 'golive',
      header: 'Go-live',
      width: 120,
      cell: (r) => (r.stage === 'live' ? <Status kind="ready">Live</Status> : r.targetGoLive ? <span className={s.n}>{longDate(r.targetGoLive)}</span> : <span className={s.muted}>Not set</span>),
    },
  ];

  const toggleGuide = (open: boolean) => {
    setGuideOpen(open);
    try {
      window.localStorage.setItem(GUIDE_KEY, open ? '1' : '0');
    } catch { /* private mode */ }
  };

  const bandItems = [
    { value: 'all' as const, label: 'All stages', count: data?.stageCounts.all ?? 0, caption: 'Every client in migration' },
    ...STAGE_DEFINITIONS.map((d) => ({
      value: d.stage,
      label: (
        <span title={`What happens: ${d.whatHappens}\nWho does it: ${d.whoDoesIt}\nDone when: ${d.doneWhen}`}>
          {d.label}
          <span className={s.srOnly}>. What happens: {d.whatHappens} Who does it: {d.whoDoesIt} Done when: {d.doneWhen}</span>
        </span>
      ),
      count: data?.stageCounts[d.stage] ?? 0,
      caption: d.oneLine,
    })),
  ];

  return (
    <div className={s.stack}>
      <PageHead
        eyebrow={['Clients', 'Onboarding tracker']}
        title="Migration Control Tower"
        actions={
          <>
            <ButtonLink href="/onboarding/migrations/rules" variant="quiet">Mapping rules</ButtonLink>
            <Button variant="quiet" onClick={() => setDialog('wave')}>New wave</Button>
            <Button variant="quiet" onClick={async () => { if (await run('refresh', '/api/onboarding/migrations', { action: 'refresh_all' })) refresh(); }} disabled={busy === 'refresh'}>
              {busy === 'refresh' ? 'Refreshing…' : 'Refresh all'}
            </Button>
            <Button variant="primary" icon="plus" onClick={() => setDialog('add')}>Add clients</Button>
          </>
        }
      >
        Every client moving onto MeritBooks, by cutover date. Each row says exactly what’s next.
      </PageHead>

      {error && <InlineNotice tone="neg" title="The Tower didn’t load.">{error} <Button variant="quiet" onClick={refresh}>Try again</Button></InlineNotice>}
      {isLoading && !data && <p className="t-cap" role="status">Loading the Tower…</p>}

      {data && (
        <>
          <Bands className={s.towerStages} aria-label="Stages" items={bandItems} value={stage} onChange={setStage} />
          <details className={s.disclosure} open={guideOpen} onToggle={(e) => toggleGuide((e.currentTarget as HTMLDetailsElement).open)}>
            <summary>What happens in each stage <span className={s.muted}>— what the work is, who does it, and when it’s done</span></summary>
            <div className={s.guide} role="table" aria-label="What happens in each stage">
              <div className={s.guideHead} role="columnheader">Stage</div>
              {STAGE_DEFINITIONS.map((d) => <div key={d.stage} className={s.guideHead} role="columnheader">{d.number} · {d.label}</div>)}
              <div className={s.guideRow} role="rowheader">What happens</div>
              {STAGE_DEFINITIONS.map((d) => <div key={d.stage} role="cell">{d.whatHappens}</div>)}
              <div className={s.guideRow} role="rowheader">Who does it</div>
              {STAGE_DEFINITIONS.map((d) => <div key={d.stage} role="cell">{d.whoDoesIt}</div>)}
              <div className={s.guideRow} role="rowheader">Done when</div>
              {STAGE_DEFINITIONS.map((d) => <div key={d.stage} role="cell">{d.doneWhen}</div>)}
            </div>
          </details>

          <div className={s.between}>
            <Seg
              aria-label="Waves"
              value={wave}
              onChange={setWave}
              items={[
                { value: 'all', label: 'All waves' },
                ...data.waves.map((w) => ({ value: w.id ?? 'none', label: w.cutoverDate ? `${longDate(w.cutoverDate)}` : 'Unscheduled', count: w.rows.length })),
              ]}
            />
            <div className={s.row}>
              <Select aria-label="System" value={system} onChange={(e) => setSystem(e.target.value)}>
                <option value="">Every system</option>
                {systems.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
              </Select>
              <Select aria-label="Preparer" value={preparer} onChange={(e) => setPreparer(e.target.value)}>
                <option value="">Every preparer</option>
                {data.people.map((p) => <option key={p.userId} value={p.userId}>{p.name}</option>)}
              </Select>
            </div>
          </div>
          <p className={s.waveDef}>A wave is a group of clients moving on the same cutover date. Waves list earliest cutover first; clients without a cutover wait in Unscheduled.</p>

          {data.totals.clients === 0 ? (
            <div className={`${s.surface} ${s.state}`}>
              <h2 className="t-section">No clients are being moved yet</h2>
              <p>Add the clients you’re bringing onto MeritBooks. Each one gets a plan, its systems, 24 data-quality checks, account matching, a balance proof and a Conversion Certificate signed by two people.</p>
              <Button variant="primary" onClick={() => setDialog('add')} disabled={data.notStarted.length === 0}>Add clients</Button>
              {data.notStarted.length === 0 && <p className={s.small}>No clients yet — create them under Add clients (bulk) first.</p>}
            </div>
          ) : groups.length === 0 ? (
            <div className={`${s.surface} ${s.state}`}><p>No clients match these filters.</p><Button variant="quiet" onClick={() => { setStage('all'); setWave('all'); setPreparer(''); setSystem(''); }}>Clear filters</Button></div>
          ) : (
            <div className={s.surface}>
              <QueueTable<TowerRow>
                aria-label="Clients in migration"
                columns={columns}
                groups={groups}
                getRowId={(r) => r.id}
                rowState={(r) => ({ done: r.stage === 'live', attn: r.late })}
                selectable
                selected={selected}
                onSelectedChange={setSelected}
                onOpen={(r) => { window.location.href = `/onboarding/migrations/${r.id}`; }}
                bulkSummary={(rows) => [`${rows.length} selected`, rows.map((r) => r.clientName).slice(0, 3).join(', ') + (rows.length > 3 ? '…' : '')]}
                bulkActions={(rows) => (
                  <>
                    <Button onClick={() => setDialog('cutover')}>Set cutover</Button>
                    <Button onClick={() => setDialog('assign')}>Assign</Button>
                    <Button
                      variant="primary"
                      disabled={busy === 'bulkpf'}
                      onClick={async () => { if (await run('bulkpf', '/api/onboarding/migrations', { action: 'bulk_preflight', project_ids: rows.map((r) => r.id) })) refresh(); }}
                    >
                      Check data quality
                    </Button>
                  </>
                )}
              />
              <div className={s.footer}>
                <span className={s.muted}>Open blockers shown</span>
                <span className={s.strong}>{wholeDollars(visibleCents)}</span>
              </div>
            </div>
          )}

          <AddClientsDialog open={dialog === 'add'} data={data} onClose={() => setDialog(null)} onDone={refresh} />
          <NewWaveDialog open={dialog === 'wave'} onClose={() => setDialog(null)} onDone={refresh} />
          <BulkCutoverDialog open={dialog === 'cutover'} ids={[...selected]} onClose={() => setDialog(null)} onDone={() => { setSelected(new Set()); refresh(); }} />
          <BulkAssignDialog open={dialog === 'assign'} ids={[...selected]} people={data.people} onClose={() => setDialog(null)} onDone={() => { setSelected(new Set()); refresh(); }} />
        </>
      )}
    </div>
  );
}

function AddClientsDialog({ open, data, onClose, onDone }: { open: boolean; data: TowerData; onClose: () => void; onDone: () => void }) {
  const [pick, setPick] = useState<Set<string>>(new Set());
  const [waveId, setWaveId] = useState('');
  const [prep, setPrep] = useState('');
  const [rev, setRev] = useState('');
  const { busy, run } = useAction();
  const sod = !!prep && prep === rev;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add clients to the migration"
      width={620}
      actions={
        <>
          <Button variant="quiet" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={pick.size === 0 || sod || busy === 'add'}
            onClick={async () => {
              const r = await run('add', '/api/onboarding/migrations', { action: 'create', location_ids: [...pick], wave_id: waveId || null, preparer_user_id: prep || null, reviewer_user_id: rev || null });
              if (r) { setPick(new Set()); onClose(); onDone(); }
            }}
          >
            {busy === 'add' ? 'Adding…' : `Add ${pick.size || ''} client${pick.size === 1 ? '' : 's'}`}
          </Button>
        </>
      }
    >
      {data.notStarted.length === 0 ? (
        <p>Every client is already in the migration. New clients are created under <Link href="/onboarding/portfolio">Add clients (bulk)</Link>.</p>
      ) : (
        <div className={s.stack}>
          <div className={s.row}>
            <Button variant="quiet" onClick={() => setPick(new Set(data.notStarted.map((c) => c.id)))}>Select all {data.notStarted.length}</Button>
            <Button variant="quiet" onClick={() => setPick(new Set())}>Clear</Button>
          </div>
          <div className={s.scroll} style={{ maxHeight: 260 }}>
            {data.notStarted.map((c) => (
              <label key={c.id} className={s.choice}>
                <input type="checkbox" checked={pick.has(c.id)} onChange={(e) => { const n = new Set(pick); if (e.target.checked) n.add(c.id); else n.delete(c.id); setPick(n); }} />
                <span><span className={s.choiceT}>{c.name}</span><span className={s.choiceD}>{c.shortCode}</span></span>
              </label>
            ))}
          </div>
          <Field label="Wave (sets the cutover date)">
            <Select value={waveId} onChange={(e) => setWaveId(e.target.value)}>
              <option value="">Unscheduled — set the cutover later</option>
              {data.openWaves.map((w) => <option key={w.id} value={w.id}>{w.name} · {longDate(w.cutoverDate)}</option>)}
            </Select>
          </Field>
          <div className={s.row}>
            <Field label="Preparer">
              <Select value={prep} onChange={(e) => setPrep(e.target.value)}>
                <option value="">Decide later</option>
                {data.people.map((p) => <option key={p.userId} value={p.userId}>{p.name}</option>)}
              </Select>
            </Field>
            <Field label="Reviewer (signs off — never the preparer)" error={sod ? 'Pick someone other than the preparer.' : undefined}>
              <Select value={rev} onChange={(e) => setRev(e.target.value)}>
                <option value="">Decide later</option>
                {data.people.map((p) => <option key={p.userId} value={p.userId}>{p.name}</option>)}
              </Select>
            </Field>
          </div>
        </div>
      )}
    </Dialog>
  );
}

function NewWaveDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState('');
  const [cutover, setCutover] = useState('');
  const [purpose, setPurpose] = useState('');
  const { busy, run } = useAction();
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New wave"
      actions={
        <>
          <Button variant="quiet" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!name.trim() || !cutover || busy === 'wave'} onClick={async () => { if (await run('wave', '/api/onboarding/migrations', { action: 'create_wave', name: name.trim(), cutover_date: cutover, purpose: purpose.trim() || null })) { onClose(); onDone(); } }}>
            Create wave
          </Button>
        </>
      }
    >
      <p className={s.ink2}>A wave is a group of clients moving on the same cutover date. Clients you add to it take its date.</p>
      <div className={s.stack}>
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Wave 2" /></Field>
        <Field label="Cutover date" help="The last day the old system is the book. Usually a month end."><Input type="date" value={cutover} onChange={(e) => setCutover(e.target.value)} /></Field>
        <Field label="Purpose (one line)"><Input value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="Proves the firm mapping set on 3 clean QuickBooks clients" /></Field>
      </div>
    </Dialog>
  );
}

function BulkCutoverDialog({ open, ids, onClose, onDone }: { open: boolean; ids: string[]; onClose: () => void; onDone: () => void }) {
  const [cutover, setCutover] = useState('');
  const { busy, run } = useAction();
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Set the cutover for ${ids.length} client${ids.length === 1 ? '' : 's'}`}
      actions={
        <>
          <Button variant="quiet" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy === 'cut'} onClick={async () => { if (await run('cut', '/api/onboarding/migrations', { action: 'bulk_cutover', project_ids: ids, cutover_date: cutover || null })) { onClose(); onDone(); } }}>
            {cutover ? `Set ${longDate(cutover)}` : 'Clear the cutover'}
          </Button>
        </>
      }
    >
      <p className={s.ink2}>Each client moves to the wave with this date (one is created if needed). Signed-off clients are skipped.</p>
      <Field label="Cutover date"><Input type="date" value={cutover} onChange={(e) => setCutover(e.target.value)} /></Field>
    </Dialog>
  );
}

function BulkAssignDialog({ open, ids, people, onClose, onDone }: { open: boolean; ids: string[]; people: TowerData['people']; onClose: () => void; onDone: () => void }) {
  const [prep, setPrep] = useState('');
  const [rev, setRev] = useState('');
  const { busy, run } = useAction();
  const sod = !!prep && prep === rev;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Assign ${ids.length} client${ids.length === 1 ? '' : 's'}`}
      actions={
        <>
          <Button variant="quiet" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={sod || (!prep && !rev) || busy === 'assign'} onClick={async () => {
            const body: Record<string, unknown> = { action: 'bulk_assign', project_ids: ids };
            if (prep) body.preparer_user_id = prep;
            if (rev) body.reviewer_user_id = rev;
            if (await run('assign', '/api/onboarding/migrations', body)) { onClose(); onDone(); }
          }}>
            Assign
          </Button>
        </>
      }
    >
      <div className={s.stack}>
        <Field label="Preparer"><Select value={prep} onChange={(e) => setPrep(e.target.value)}><option value="">Keep as is</option>{people.map((p) => <option key={p.userId} value={p.userId}>{p.name}</option>)}</Select></Field>
        <Field label="Reviewer" error={sod ? 'The reviewer can’t be the preparer.' : undefined}><Select value={rev} onChange={(e) => setRev(e.target.value)}><option value="">Keep as is</option>{people.map((p) => <option key={p.userId} value={p.userId}>{p.name}</option>)}</Select></Field>
      </div>
    </Dialog>
  );
}


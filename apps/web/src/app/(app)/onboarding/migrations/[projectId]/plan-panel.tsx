'use client';

import { useMemo, useState } from 'react';
import { Button, Field, Input, InlineNotice, Search, Select, Switch, Tag, useQuery } from '@meritbooks/merit-ui';
import { HISTORY_DEPTH_COPY, SHADOW_MODE_COPY } from '@/lib/onboarding/migration/stages';
import { dayAfter, longDate } from '@/lib/onboarding/migration/format';
import { searchSourceSystems, sourceGroups, READ_ONLY_PROMISE } from '@/lib/onboarding/migration/catalog';
import type { ChartStrategy, HistoryDepth, ShadowMode } from '@/lib/onboarding/migration/types';
import type { TowerData, WorkspaceData } from '../_shared/dto';
import { useAction } from '../_shared/ui';
import s from '../migrations.module.css';

const CHART_COPY: Record<ChartStrategy, { label: string; detail: string }> = {
  tenant_standard: { label: 'Your firm’s standard chart', detail: 'Match this client onto the firm’s chart and departments. Answers are remembered for the next client. Recommended for firms.' },
  keep_source_chart: { label: 'Keep this client’s own chart', detail: 'Account numbers carry over as they are. Fastest for a single company.' },
};

/** The last day of the previous month (the default cutover). */
function defaultCutover(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0)).toISOString().slice(0, 10);
}

export function PlanPanel({ data, onChanged }: { data: WorkspaceData; onChanged: () => void }) {
  const p = data.project;
  const locked = p.stage === 'certified' || p.stage === 'live';
  const { data: tower } = useQuery<TowerData>('/api/onboarding/migrations', undefined, { scope: false });
  const [cutover, setCutover] = useState(p.cutover_date ?? '');
  const [depth, setDepth] = useState<HistoryDepth>(p.history_depth);
  const [shadow, setShadow] = useState<ShadowMode>(p.shadow_mode);
  const [chart, setChart] = useState<ChartStrategy>(p.chart_strategy);
  const [goLive, setGoLive] = useState(p.target_go_live ?? '');
  const [lead, setLead] = useState(p.lead_user_id ?? '');
  const [prep, setPrep] = useState(p.preparer_user_id ?? '');
  const [rev, setRev] = useState(p.reviewer_user_id ?? '');
  const [q, setQ] = useState('');
  const { busy, run } = useAction();
  const sod = !!prep && prep === rev;
  const usedIds = new Set(data.sources.map((x) => x.systemId));
  const groups = useMemo(() => {
    if (q.trim()) return [{ group: 'search', label: 'Matches', blurb: '', systems: searchSourceSystems(q) }];
    return sourceGroups();
  }, [q]);

  const save = async () => {
    const body: Record<string, unknown> = { action: 'update_plan', id: p.id, history_depth: depth, shadow_mode: shadow, chart_strategy: chart, target_go_live: goLive || null, lead_user_id: lead || null, preparer_user_id: prep || null, reviewer_user_id: rev || null };
    if ((cutover || null) !== p.cutover_date) body.cutover_date = cutover || null;
    if (await run('save', '/api/onboarding/migrations/project', body)) onChanged();
  };

  return (
    <div className={s.stack}>
      {locked && <InlineNotice title="Signed off — the plan is locked.">Void the certificate to change it.</InlineNotice>}
      <section className={s.surface} aria-labelledby="plan-when">
        <div className={s.head}><h3 id="plan-when">When MeritBooks takes over</h3></div>
        <div className={s.form}>
          <Field
            label="Cutover date"
            help={cutover ? `MeritBooks takes over ${longDate(dayAfter(cutover))}. ${longDate(cutover)} and earlier stay as they were in the old system, and lock for good at sign-off.` : 'The last day the old system is the book. Usually the last day of last month.'}
          >
            <div className={s.row}>
              <Input type="date" value={cutover} onChange={(e) => setCutover(e.target.value)} disabled={locked} />
              {!cutover && <Button variant="quiet" onClick={() => setCutover(defaultCutover())}>Use {longDate(defaultCutover())}</Button>}
            </div>
          </Field>
          <Field label="Target go-live"><Input type="date" value={goLive} onChange={(e) => setGoLive(e.target.value)} disabled={locked} /></Field>
          {data.wave && <p className={`${s.small} ${s.ink2}`}>In {data.wave.name}. A wave is a group of clients moving on the same cutover date — changing the date moves this client to the wave with that date.</p>}
          {!data.wave && tower && tower.openWaves.length > 0 && (
            <Field label="Or join a wave">
              <Select value="" disabled={locked} onChange={async (e) => { if (e.target.value && (await run('wave', '/api/onboarding/migrations/project', { action: 'update_plan', id: p.id, wave_id: e.target.value }))) onChanged(); }}>
                <option value="">Choose a wave…</option>
                {tower.openWaves.map((w) => <option key={w.id} value={w.id}>{w.name} · {longDate(w.cutoverDate)}</option>)}
              </Select>
            </Field>
          )}
        </div>
      </section>

      <section className={s.surface} aria-labelledby="plan-how">
        <div className={s.head}><h3 id="plan-how">How much history, practice close, chart</h3></div>
        <div className={s.form}>
          <fieldset className={s.choices} disabled={locked}>
            <legend className={s.label}>History</legend>
            {(Object.keys(HISTORY_DEPTH_COPY) as HistoryDepth[]).map((k) => (
              <label key={k} className={s.choice}>
                <input type="radio" name="depth" checked={depth === k} onChange={() => setDepth(k)} />
                <span><span className={s.choiceT}>{HISTORY_DEPTH_COPY[k].label}</span><span className={s.choiceD}>{HISTORY_DEPTH_COPY[k].detail}</span></span>
              </label>
            ))}
          </fieldset>
          <fieldset className={s.choices} disabled={locked}>
            <legend className={s.label}>Practice close</legend>
            {(Object.keys(SHADOW_MODE_COPY) as ShadowMode[]).map((k) => (
              <label key={k} className={s.choice}>
                <input type="radio" name="shadow" checked={shadow === k} onChange={() => setShadow(k)} />
                <span><span className={s.choiceT}>{SHADOW_MODE_COPY[k].label}</span><span className={s.choiceD}>{SHADOW_MODE_COPY[k].detail}</span></span>
              </label>
            ))}
          </fieldset>
          <fieldset className={s.choices} disabled={locked}>
            <legend className={s.label}>Chart of accounts</legend>
            {(Object.keys(CHART_COPY) as ChartStrategy[]).map((k) => (
              <label key={k} className={s.choice}>
                <input type="radio" name="chart" checked={chart === k} onChange={() => setChart(k)} />
                <span><span className={s.choiceT}>{CHART_COPY[k].label}</span><span className={s.choiceD}>{CHART_COPY[k].detail}</span></span>
              </label>
            ))}
          </fieldset>
        </div>
      </section>

      <section className={s.surface} aria-labelledby="plan-people">
        <div className={s.head}><h3 id="plan-people">People</h3><span className={s.muted}>The reviewer signs off the certificate and is never the preparer.</span></div>
        <div className={s.form}>
          <Field label="Migration lead"><Select value={lead} onChange={(e) => setLead(e.target.value)} disabled={locked}><option value="">Not named</option>{data.people.map((x) => <option key={x.userId} value={x.userId}>{x.name}</option>)}</Select></Field>
          <Field label="Preparer"><Select value={prep} onChange={(e) => setPrep(e.target.value)} disabled={locked}><option value="">Not named</option>{data.people.map((x) => <option key={x.userId} value={x.userId}>{x.name}</option>)}</Select></Field>
          <Field label="Reviewer" error={sod ? 'The reviewer has to be someone other than the preparer.' : undefined}><Select value={rev} onChange={(e) => setRev(e.target.value)} disabled={locked}><option value="">Not named</option>{data.people.map((x) => <option key={x.userId} value={x.userId}>{x.name}</option>)}</Select></Field>
        </div>
        <div className={s.padSm}>
          <Button variant="primary" onClick={save} disabled={locked || sod || busy === 'save'}>{busy === 'save' ? 'Saving…' : 'Save the plan'}</Button>
        </div>
      </section>

      <section className={s.surface} aria-labelledby="plan-systems">
        <div className={s.head}>
          <h3 id="plan-systems">Which systems does this client use?</h3>
          <span className={s.grow} />
          <Switch
            label="Every system is named"
            checked={p.systems_confirmed}
            disabled={locked || data.sources.length === 0 || busy === 'confirm'}
            onChange={async (e) => { if (await run('confirm', '/api/onboarding/migrations/project', { action: 'update_plan', id: p.id, systems_confirmed: e.target.checked })) onChanged(); }}
          />
        </div>
        <div className={s.padSm}>
          {data.sources.length === 0 ? (
            <p className={s.muted}>None yet. Add the ledger (QuickBooks, Xero, Sage…) and any field system, bank or payroll the client uses. Not sure? Ask the client owner in the comments.</p>
          ) : (
            <ul className={s.list}>
              {data.sources.map((src) => (
                <li key={src.id} className={s.between}>
                  <span><b>{src.systemName}</b><span className={s.sub}>{src.role.replace('_', ' ')} · {src.ongoingFeed ? 'stays connected after go-live' : 'one-time, archived at sign-off'} · {READ_ONLY_PROMISE(src.systemName)}</span></span>
                  <Button variant="quiet" disabled={locked || busy === `rm${src.id}`} onClick={async () => { if (await run(`rm${src.id}`, '/api/onboarding/migrations/project', { action: 'remove_source', id: p.id, source_id: src.id })) onChanged(); }}>Remove</Button>
                </li>
              ))}
            </ul>
          )}
        </div>
        {!locked && (
          <>
            <div className={s.padSm}><Search aria-label="Find a system" value={q} onChange={(e) => setQ(e.target.value)} placeholder="QuickBooks, ServiceTitan, Buildertrend, simPRO, RFMS, c-Systems…" /></div>
            <div className={s.catalog}>
              {groups.map((g) => (
                <div key={g.group} className={s.catalogGroup}>
                  <span className={s.label}>{g.label}</span>
                  {g.systems.map((sys) => (
                    <button
                      key={sys.id}
                      type="button"
                      className={s.catalogBtn}
                      disabled={usedIds.has(sys.id) || busy === `add${sys.id}`}
                      onClick={async () => { if (await run(`add${sys.id}`, '/api/onboarding/migrations/project', { action: 'add_source', id: p.id, system_id: sys.id })) onChanged(); }}
                    >
                      <span><b>{sys.name}</b> <span className={s.muted}>— {sys.oneLine}</span></span>
                      <span>{usedIds.has(sys.id) ? <Tag>Added</Tag> : <Tag tone={sys.tier === 'native_api' ? 'ai' : 'default'}>{sys.tier === 'native_api' ? 'Connect' : 'Export & drop'}</Tag>}</span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </>
        )}
      </section>
    </div>
  );
}

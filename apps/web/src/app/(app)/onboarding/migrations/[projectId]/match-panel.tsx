'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Bands, Button, Conf, InlineNotice, Input, Select, Seg, Tag, useQuery } from '@meritbooks/merit-ui';
import { typeGuard } from '@/lib/onboarding/migration/mapping/cascade';
import { dollars } from '@/lib/onboarding/migration/format';
import type { MappingTarget } from '@/lib/onboarding/migration/types';
import type { MappingData, MappingRow, MasterView, WorkspaceData } from '../_shared/dto';
import { amt, useAction } from '../_shared/ui';
import s from '../migrations.module.css';

type Band = 'decide' | 'check' | 'ready' | 'accepted';

const SOURCE_WORD: Record<string, string> = { rule: 'Your team’s rule', crosswalk: 'Crosswalk', number: 'Same number', name: 'Name', ai: 'AI', human: 'You', unmapped: 'No match' };

function MapRow({ r, targets, projectId, onSaved }: { r: MappingRow; targets: MappingTarget[]; projectId: string; onSaved: () => void }) {
  const [target, setTarget] = useState(r.target_account_id ?? '');
  const [reason, setReason] = useState(r.type_reason ?? '');
  const { busy, run } = useAction();
  const t = targets.find((x) => x.id === target) ?? null;
  const srcType = r.merit_type;
  const guard = t ? typeGuard(srcType, t.type) : 'ok';
  const changed = target !== (r.target_account_id ?? '');
  const accepted = r.status === 'accepted';
  const needsReason = guard === 'block' && reason.trim().length < 10;
  return (
    <tr>
      <td>
        <b>{r.source_number ? `${r.source_number} ` : ''}{r.source_name}</b>
        <span className={s.sub}>{r.source_type ?? srcType ?? ''}{r.detail_type ? ` · ${r.detail_type}` : ''}</span>
      </td>
      <td>
        <Select aria-label={`MeritBooks account for ${r.source_name}`} value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">Choose an account…</option>
          {targets.map((x) => <option key={x.id} value={x.id}>{x.number} {x.name}</option>)}
        </Select>
        {guard !== 'ok' && (
          <span className={s.why}>
            {guard === 'block' ? 'Different account type — needs a reason.' : 'Cost of sales ↔ expense: allowed, check it.'}
          </span>
        )}
        {guard === 'block' && !accepted && <Input aria-label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why this type change is right" />}
        {r.status === 'needs_account' && <Tag tone="warn">Account requested</Tag>}
      </td>
      <td>
        <Conf score={Math.round((r.confidence ?? 0) * 100)} />
        <span className={s.why}>{SOURCE_WORD[r.proposal_source] ?? r.proposal_source}{r.conflict ? ' · clients disagree' : ''} — {r.reason}</span>
      </td>
      <td className={s.n}>{amt(r.balance_cents)}</td>
      <td>
        <div className={s.row}>
          {accepted && !changed ? (
            <Button variant="quiet" disabled={busy !== null} onClick={async () => { if (await run('re', '/api/onboarding/migrations/mapping', { action: 'reopen', id: projectId, key: r.source_account_key })) onSaved(); }}>Reopen</Button>
          ) : (
            <Button
              variant="primary"
              disabled={!target || needsReason || busy !== null}
              onClick={async () => {
                const body = changed || guard !== 'ok'
                  ? { action: 'set', id: projectId, key: r.source_account_key, target_account_id: target, reason: reason.trim() || null }
                  : { action: 'accept', id: projectId, keys: [r.source_account_key] };
                if (await run('acc', '/api/onboarding/migrations/mapping', body)) onSaved();
              }}
            >
              Accept
            </Button>
          )}
          {!accepted && r.status !== 'needs_account' && (
            <Button variant="quiet" disabled={busy !== null} onClick={async () => { if (await run('req', '/api/onboarding/migrations/mapping', { action: 'request_account', id: projectId, key: r.source_account_key, note: null })) onSaved(); }}>Request account</Button>
          )}
        </div>
      </td>
    </tr>
  );
}

export function MatchPanel({ data, onChanged }: { data: WorkspaceData; onChanged: () => void }) {
  const [key, setKey] = useState(0);
  const { data: m, error, isLoading } = useQuery<MappingData>('/api/onboarding/migrations/mapping', { id: data.project.id }, { key: String(key), scope: false });
  const [band, setBand] = useState<Band>('decide');
  const [q, setQ] = useState('');
  const { busy, run } = useAction();
  const reload = () => { setKey((k) => k + 1); onChanged(); };
  const pid = data.project.id;

  const rows = useMemo(() => {
    const all = m?.rows ?? [];
    const inBand = band === 'accepted' ? all.filter((r) => r.status === 'accepted') : all.filter((r) => r.status !== 'accepted' && r.band === band);
    const needle = q.trim().toLowerCase();
    return needle ? inBand.filter((r) => `${r.source_number ?? ''} ${r.source_name}`.toLowerCase().includes(needle)) : inBand;
  }, [m, band, q]);

  if (error) return <InlineNotice tone="neg" title="The matches didn’t load.">{error}</InlineNotice>;
  if (isLoading && !m) return <p className="t-cap" role="status">Loading the matches…</p>;
  if (!m) return null;

  const runMatching = async (useAi: boolean) => { if (await run(useAi ? 'ai' : 'run', '/api/onboarding/migrations/mapping', { action: 'run', id: pid, use_ai: useAi })) reload(); };
  const bandSum = rows.reduce((t, r) => t + Math.abs(r.balance_cents), 0);

  return (
    <div className={s.stack}>
      <div className={s.between}>
        <span className={s.ink2}>
          {m.set ? <>Matching onto <b>{m.set.name}</b> — answers you accept are proposed on the next client. <Link href="/onboarding/migrations/rules">Rules and conflicts</Link></> : 'Run matching to start the firm’s mapping memory.'}
        </span>
        <div className={s.row}>
          {m.aiConfigured && m.rows.some((r) => r.proposal_source === 'unmapped') && <Button onClick={() => runMatching(true)} disabled={busy !== null}>{busy === 'ai' ? 'Asking AI…' : 'Ask AI for the rest'}</Button>}
          <Button variant={m.rows.length ? 'default' : 'primary'} onClick={() => runMatching(false)} disabled={busy !== null}>{busy === 'run' ? 'Matching…' : m.rows.length ? 'Match again' : 'Match accounts'}</Button>
        </div>
      </div>
      {!m.aiConfigured && <p className={s.small + ' ' + s.muted}>AI paused: rules and memory only.</p>}

      {m.rows.length === 0 ? (
        <div className={`${s.surface} ${s.state}`}><p>Drop the trial balance (Connect systems), then match. Your team’s rules, the QuickBooks crosswalk and name matching propose first; AI never sees a balance and is capped below Ready.</p></div>
      ) : (
        <>
          <Bands
            aria-label="Match bands"
            value={band}
            onChange={setBand}
            items={[
              { value: 'decide', label: 'Decide', count: m.totals.decide.count, caption: `Under 70 or a type warning · ${dollars(m.totals.decide.cents)}` },
              { value: 'check', label: 'Check', count: m.totals.check.count, caption: `70–89 · ${dollars(m.totals.check.cents)}` },
              { value: 'ready', label: 'Ready', count: m.totals.ready.count, caption: `90+ · ${dollars(m.totals.ready.cents)}` },
              { value: 'accepted', label: 'Matched', count: m.accepted.count, caption: dollars(m.accepted.cents) },
            ]}
          />
          <div className={s.surface}>
            <div className={s.head}>
              <Input aria-label="Find an account" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find an account" />
              <span className={s.muted}>{rows.length} · {dollars(bandSum)} · largest balance first</span>
              <span className={s.grow} />
              {band === 'ready' && m.totals.ready.count > 0 && (
                <Button variant="primary" disabled={busy !== null} onClick={async () => { if (await run('ready', '/api/onboarding/migrations/mapping', { action: 'accept_ready', id: pid })) reload(); }}>
                  Accept all Ready · {m.totals.ready.count}
                </Button>
              )}
            </div>
            {rows.length === 0 ? (
              <p className={s.state}>Nothing in this band.</p>
            ) : (
              <div className={s.scroll}>
                <table className={s.mapTable}>
                  <thead><tr><th>Old account</th><th>MeritBooks account</th><th>Confidence · why</th><th className={s.n}>Balance at cutover</th><th /></tr></thead>
                  <tbody>{rows.slice(0, 300).map((r) => <MapRow key={`${r.id}:${r.target_account_id}:${r.status}`} r={r} targets={m.targets} projectId={pid} onSaved={reload} />)}</tbody>
                </table>
                {rows.length > 300 && <p className={s.padSm + ' ' + s.muted}>Showing the 300 largest. Accept these and the rest come up.</p>}
              </div>
            )}
          </div>
        </>
      )}
      <Masters projectId={pid} />
    </div>
  );
}

const KIND_LABEL: Record<MasterView['kind'], string> = { customer: 'Customers', vendor: 'Vendors', item: 'Items', dimension: 'Classes & departments' };

function Masters({ projectId }: { projectId: string }) {
  const [key, setKey] = useState(0);
  const { data, error } = useQuery<{ kinds: MasterView[] }>('/api/onboarding/migrations/masters', { id: projectId }, { key: String(key), scope: false });
  const [kind, setKind] = useState<MasterView['kind']>('customer');
  const { busy, run } = useAction();
  const reload = () => setKey((k) => k + 1);
  const view = data?.kinds.find((k) => k.kind === kind) ?? data?.kinds[0] ?? null;
  const act = async (action: string, ids: string[]) => { if (await run(action, '/api/onboarding/migrations/masters', { action, id: projectId, staged_ids: ids })) reload(); };

  return (
    <section className={s.surface} aria-labelledby="masters-title">
      <div className={s.head}>
        <h3 id="masters-title">Customers, vendors, items and classes</h3>
        <span className={s.muted}>Already in Merit? Linked, never created twice.</span>
        <span className={s.grow} />
        <Button onClick={async () => { if (await run('run', '/api/onboarding/migrations/masters', { action: 'run', id: projectId })) reload(); }} disabled={busy !== null}>{busy === 'run' ? 'Matching…' : 'Match against Merit'}</Button>
      </div>
      {error && <InlineNotice tone="neg" title="Couldn’t load.">{error}</InlineNotice>}
      {!data || data.kinds.length === 0 ? (
        <p className={s.state}>Nothing staged yet — customer and vendor lists come from the ledger or a field system.</p>
      ) : (
        <>
          <div className={s.padSm}>
            <Seg aria-label="Record kind" value={view?.kind ?? kind} onChange={setKind} items={data.kinds.map((k) => ({ value: k.kind, label: KIND_LABEL[k.kind], count: k.total }))} />
          </div>
          {view && (
            <>
              <p className={s.padSm + ' ' + s.ink2}>
                {view.matched} already in Merit · {view.proposed} to look at · {view.fresh} new · {view.ignored} ignored
                {view.undecided > 0 && <> · <Button variant="quiet" disabled={busy !== null} onClick={async () => { if (await run('all', '/api/onboarding/migrations/masters', { action: 'accept_all_matches', id: projectId, entity: view.kind })) reload(); }}>Link all proposed matches</Button></>}
              </p>
              <div className={s.scroll} style={{ maxHeight: 420 }}>
                <table className={s.simple}>
                  <thead><tr><th>In the old system</th><th>In Merit</th><th>Why</th><th /></tr></thead>
                  <tbody>
                    {view.rows.map((r) => (
                      <tr key={r.id}>
                        <td><b>{r.name}</b><span className={s.sub}>{r.detail}</span></td>
                        <td>{r.status === 'matched' ? <Tag tone="pos">Already in Merit · {r.matchedName ?? 'linked'}</Tag> : r.status === 'merge_proposed' ? (r.matchedName ? <>Looks like <b>{r.matchedName}</b></> : <Tag tone="warn">Duplicate in this file</Tag>) : r.status === 'ignored' ? <Tag>Ignored</Tag> : <Tag>New</Tag>}</td>
                        <td className={s.small}>{r.reason}{r.confidence ? ` · ${Math.round(r.confidence * 100)}` : ''}</td>
                        <td>
                          {r.status === 'merge_proposed' && !r.decided && (
                            <div className={s.row}>
                              {r.matchedId && <Button disabled={busy !== null} onClick={() => act('link', [r.id])}>Link</Button>}
                              <Button variant="quiet" disabled={busy !== null} onClick={() => act('keep_new', [r.id])}>Keep both</Button>
                              {!r.matchedId && <Button variant="quiet" disabled={busy !== null} onClick={() => act('ignore', [r.id])}>Ignore duplicate</Button>}
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}

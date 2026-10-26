'use client';

import { useMemo, useState } from 'react';
import { Button, ButtonLink, InlineNotice, Input, PageHead, Seg, Select, Status, Tag, useQuery } from '@meritbooks/merit-ui';
import type { RuleView, RulesData } from '../_shared/dto';
import type { MappingTarget } from '@/lib/onboarding/migration/types';
import { useAction, when } from '../_shared/ui';
import s from '../migrations.module.css';

function RuleRow({ r, targets, onSaved }: { r: RuleView; targets: MappingTarget[]; onSaved: () => void }) {
  const [pick, setPick] = useState(r.target?.id ?? '');
  const { busy, run } = useAction();
  return (
    <tr>
      <td><b>{r.sourceLabel ?? r.matchValue}</b><span className={s.sub}>{r.matchKind === 'exact_number' ? 'by account number' : 'by name'} · {r.matchValue}</span></td>
      <td>
        {r.target ? `${r.target.number} ${r.target.name}` : '—'}
        <span className={s.sub}>{r.settledBy ? 'Settled for every client' : `Approved on ${r.evidenceCount} client${r.evidenceCount === 1 ? '' : 's'}`}</span>
      </td>
      <td>
        {r.conflict ? <Status kind="risk">Clients differ</Status> : <Status kind="ready">Agreed</Status>}
        <ul className={s.warnList}>{r.evidence.map((e) => <li key={e.locationId}>{e.clientName}: {e.target ? `${e.target.number} ${e.target.name}` : '—'} · {when(e.decidedAt)}</li>)}</ul>
      </td>
      <td>
        <div className={s.row}>
          <Select aria-label="Settle to" value={pick} onChange={(e) => setPick(e.target.value)}>
            {targets.map((t) => <option key={t.id} value={t.id}>{t.number} {t.name}</option>)}
          </Select>
          <Button disabled={!pick || busy !== null} onClick={async () => { if (await run('settle', '/api/onboarding/migrations/mapping', { action: 'settle_rule', rule_id: r.id, target_account_id: pick })) onSaved(); }}>Settle</Button>
        </div>
      </td>
    </tr>
  );
}

export function RulesScreen() {
  const [setId, setSetId] = useState<string | null>(null);
  const [key, setKey] = useState(0);
  const [q, setQ] = useState('');
  const [only, setOnly] = useState<'conflicts' | 'all'>('conflicts');
  const { data, error, isLoading } = useQuery<RulesData>('/api/onboarding/migrations/rules', setId ? { set_id: setId } : undefined, { key: String(key), scope: false });
  const targets = data?.targets ?? [];
  const rules = useMemo(() => {
    const n = q.trim().toLowerCase();
    return (data?.rules ?? []).filter((r) => (only === 'all' || r.conflict) && (!n || `${r.sourceLabel ?? ''} ${r.matchValue}`.toLowerCase().includes(n)));
  }, [data, q, only]);

  return (
    <div className={s.stack}>
      <PageHead eyebrow={['Clients', 'Mapping rules']} title="Your firm’s mapping memory" actions={<ButtonLink href="/onboarding/migrations" variant="quiet">Tower</ButtonLink>}>
        Every account match your team accepts is remembered and proposed on the next client. Where clients disagree, settle it once.
      </PageHead>
      {error && <InlineNotice tone="neg" title="The rules didn’t load.">{error}</InlineNotice>}
      {isLoading && !data && <p className="t-cap" role="status">Loading…</p>}
      {data && (
        data.sets.length === 0 ? (
          <div className={`${s.surface} ${s.state}`}><p>No rules yet. They start the first time someone accepts a match on a client.</p></div>
        ) : (
          <>
            <div className={s.between}>
              <Seg aria-label="Mapping set" value={setId ?? data.sets[0].id} onChange={(v) => setSetId(v)} items={data.sets.map((x) => ({ value: x.id, label: x.name, count: x.rules }))} />
              <div className={s.row}>
                <Seg aria-label="Show" value={only} onChange={setOnly} items={[{ value: 'conflicts', label: 'Conflicts', count: data.sets.find((x) => x.id === (setId ?? data.sets[0].id))?.conflicts ?? 0 }, { value: 'all', label: 'All rules' }]} />
                <Input aria-label="Find a rule" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find an account" />
              </div>
            </div>
            <div className={s.surface}>
              {rules.length === 0 ? (
                <p className={s.state}>{only === 'conflicts' ? 'No conflicts — every client agrees.' : 'No rules match.'}</p>
              ) : (
                <div className={s.scroll}>
                  <table className={s.mapTable}>
                    <thead><tr><th>Old account</th><th>Rule’s answer</th><th>Clients</th><th>Settle for every client</th></tr></thead>
                    <tbody>{rules.map((r) => <RuleRow key={`${r.id}:${r.target?.id}`} r={r} targets={targets} onSaved={() => setKey((k) => k + 1)} />)}</tbody>
                  </table>
                </div>
              )}
            </div>
            <p className={s.small + ' ' + s.muted}>Settling needs the chart-of-accounts approver role. Only clients you can see are listed under each rule. <Tag>Part 2: publish versions, XLSX import/export</Tag></p>
          </>
        )
      )}
    </div>
  );
}

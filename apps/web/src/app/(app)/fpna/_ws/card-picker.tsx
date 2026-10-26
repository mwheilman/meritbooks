'use client';

/**
 * The card picker (AC-W1): every metric in the registry, searchable by name, key, group and
 * formula; each with its definition, the generated formula and what it needs on file.
 */
import { useMemo, useState } from 'react';
import { Button, Drawer, InlineNotice, Search, Tag, useDebounce, useQuery } from '@meritbooks/merit-ui';
import { searchCatalog } from '@/lib/fpna/workspace/catalog';
import type { CatalogEntry } from '@/lib/fpna/workspace/types';
import type { MetricGroup } from '@/lib/metrics/types';
import s from './fpna.module.css';

interface CatalogResponse {
  metrics: CatalogEntry[];
  groups: Array<{ key: MetricGroup; label: string }>;
}

export function CardPicker({ open, onClose, present, onAdd }: { open: boolean; onClose: () => void; present: ReadonlySet<string>; onAdd: (metric: string) => void }) {
  const q = useQuery<CatalogResponse>(open ? '/api/fpna/workspace/catalog' : null, undefined, { scope: false });
  const [text, setText] = useState('');
  const [group, setGroup] = useState<MetricGroup | null>(null);
  const deb = useDebounce(text, 150);
  const list = useMemo(() => (q.data ? searchCatalog(q.data.metrics, deb, group) : []), [q.data, deb, group]);
  return (
    <Drawer open={open} onClose={onClose} width={520} eyebrow={['Dashboard', 'Add a card']} title="Add a measure" meta={q.data ? `${q.data.metrics.length} measures` : undefined}>
      <Search aria-label="Search measures" placeholder="Search by name, formula or group — e.g. “margin”, “receivables”" value={text} onChange={(e) => setText(e.target.value)} autoFocus />
      {q.data && (
        <div className={s.groupRow} role="group" aria-label="Filter by group">
          <Button variant={group === null ? 'primary' : 'quiet'} onClick={() => setGroup(null)}>All</Button>
          {q.data.groups.map((g) => (
            <Button key={g.key} variant={group === g.key ? 'primary' : 'quiet'} onClick={() => setGroup(group === g.key ? null : g.key)}>{g.label}</Button>
          ))}
        </div>
      )}
      {q.isLoading && <div className={s.skeleton} aria-busy="true" />}
      {q.error && <InlineNotice tone="neg" title="Couldn’t load the measures.">{q.error} <Button variant="quiet" onClick={() => void q.refetch()}>Try again</Button></InlineNotice>}
      {q.data && list.length === 0 && <p className={s.muted}>No measure matches “{deb}”. Try a broader word, or clear the group filter.</p>}
      <ul className={s.pickList}>
        {list.map((m) => (
          <li key={m.key} className={s.pickItem}>
            <span className={s.pickName}>
              {m.name} <Tag>{m.groupLabel}</Tag>
              {m.basis !== 'request' && <Tag>{m.basis.toUpperCase()}</Tag>}
            </span>
            <span>
              {present.has(m.key) ? (
                <span className={s.muted}>On the dashboard</span>
              ) : (
                <Button variant="quiet" aria-label={`Add ${m.name}`} onClick={() => onAdd(m.key)}>Add</Button>
              )}
            </span>
            <span className={s.pickFormula}>{m.definition}</span>
            <span className={s.pickFormula}>
              <b>Formula:</b> {m.formula}
            </span>
            <span className={s.pickReq}>Needs: {m.requiresLabel.join(', ')}</span>
          </li>
        ))}
      </ul>
    </Drawer>
  );
}

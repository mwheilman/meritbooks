'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AppLink, Bands, QueueTable, Tag, WidgetState, count, money, pct, type QueueColumn, type QueueGroup } from '@meritbooks/merit-ui';
import type { BuilderBundle } from '@/lib/residential/queries';
import type { LotBoardRow } from '@/lib/residential/types';
import { LOT_STATUS } from '@/lib/residential/labels';
import { useMoneyVis } from '@/components/shell/ShellContext';
import { StatusMark } from '@/components/ops/common/bits';

type Band = 'building' | 'selling' | 'all';
const BUILDING = new Set(['SOLD', 'STARTED']);
const SELLING = new Set(['AVAILABLE', 'HELD']);

export function BuilderBoard({ bundle: b }: { bundle: BuilderBundle }) {
  const router = useRouter();
  const mv = useMoneyVis();
  const [band, setBand] = useState<Band>('building');
  const specs = useMemo(() => new Map(b.specs.map((s) => [s.lot_id, s])), [b.specs]);
  const inBand = (x: Band) => b.lots.filter((l) => (x === 'building' ? BUILDING.has(l.status) : x === 'selling' ? SELLING.has(l.status) : true));
  const rows = inBand(band);
  const behind = inBand('building').filter((l) => l.behind_standard).length;
  const groups: QueueGroup<LotBoardRow>[] = useMemo(() => {
    const m = new Map<string, LotBoardRow[]>();
    for (const r of rows) m.set(r.community, [...(m.get(r.community) ?? []), r]);
    return [...m.entries()].map(([c, rs]) => ({ id: c, title: c, rows: rs, caption: `${count(rs.filter((r) => r.status === 'STARTED').length)} under construction` }));
  }, [rows]);
  const columns: QueueColumn<LotBoardRow>[] = [
    { id: 'lot', header: 'Lot', width: 110, cell: (r) => <><span className="l1">{r.block ? `${r.block}-` : ''}{r.lot_number}</span>{r.is_spec && <span className="l2">Spec</span>}</> },
    { id: 'plan', header: 'Plan', cell: (r) => (r.plan_code ? `${r.plan_code} · ${r.plan_name ?? ''}` : '—') },
    { id: 'stage', header: 'Stage', width: 180, cell: (r) => r.current_stage ?? '—' },
    { id: 'pct', header: 'Done', width: 80, numeric: true, cell: (r) => (r.pct_complete == null ? '—' : pct(r.pct_complete, { decimals: 0 })) },
    { id: 'cycle', header: 'Cycle', width: 120, numeric: true, cell: (r) => (r.cycle_days == null ? '—' : <span className={r.behind_standard ? 'neg b' : undefined}>{r.cycle_days} d{r.standard_cycle_days ? ` / ${r.standard_cycle_days}` : ''}</span>) },
    ...(mv.contract ? [{ id: 'list', header: 'List', width: 120, numeric: true, cell: (r: LotBoardRow) => { const s = specs.get(r.lot_id); return s?.list_price_cents != null ? money(s.list_price_cents) : '—'; } }] : []),
    { id: 'st', header: 'Status', width: 170, cell: (r) => <><StatusMark mark={LOT_STATUS[r.status]} />{specs.get(r.lot_id)?.aging && <Tag tone="warn">Aging spec</Tag>}</> },
  ];
  if (b.communities.length === 0) {
    return <WidgetState state={{ kind: 'empty', title: 'No communities yet', body: 'Set up land → community → phase → lots, then plans, elevations and the option price book.', action: <AppLink href="/communities">Set up communities</AppLink> }} />;
  }
  return (
    <div className="stack">
      <div className="ops-toolbar">
        <div style={{ flex: 1, maxWidth: 680 }}>
          <Bands<Band> aria-label="Lots" value={band} onChange={setBand} items={[
            { value: 'building', label: 'Starts', count: count(inBand('building').length), caption: behind ? `${count(behind)} behind the standard cycle` : 'Sold and under construction' },
            { value: 'selling', label: 'For sale', count: count(inBand('selling').length), caption: `${count(b.specs.length)} specs` },
            { value: 'all', label: 'Every lot', count: count(b.lots.length) },
          ]} />
        </div>
        <span className="sp" />
        <AppLink href="/communities">Communities, plans and options</AppLink>
      </div>
      {rows.length === 0 ? <WidgetState state={{ kind: 'done', title: 'No lots in this band', body: 'Switch the band above.' }} /> : (
        <div className="mp-table">
          <QueueTable aria-label="Starts board" columns={columns} groups={groups} getRowId={(r) => r.lot_id} openOnClick onOpen={(r) => router.push(`/homes/lots/${r.lot_id}`)}
            rowState={(r) => ({ attn: !!r.behind_standard, done: r.status === 'CLOSED' })} />
        </div>
      )}
    </div>
  );
}

'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Seg } from '@meritbooks/merit-ui';
import type { MeasureAreaRow, MeasureRow, MeasureTotalRow, ProcurementRow, SelectionStatusRow } from '@/lib/pm/ops/types';
import type { JobOption } from '@/lib/pm/ops/scope';
import { useVocab } from '@/components/shell/ShellContext';
import { MeasuresView } from './MeasuresView';
import { ProcurementList } from './ProcurementList';
import { SelectionsList } from './SelectionsList';

export type SelectionsTabKey = 'selections' | 'items' | 'measures';

export interface SelectionsViewProps {
  tabs: SelectionsTabKey[];
  initialTab: SelectionsTabKey;
  selections: SelectionStatusRow[];
  procurement: ProcurementRow[];
  measures: MeasureRow[];
  areas: MeasureAreaRow[];
  totals: MeasureTotalRow[];
  jobs: JobOption[];
  vendors: Record<string, string>;
  storage: Array<{ id: string; code: string; name: string; kind: string }>;
  today: string;
  initialJobId: string | null;
  focusId: string | null;
  fixedJobId?: string | null;
}

export function SelectionsView(p: SelectionsViewProps) {
  const v = useVocab();
  const router = useRouter();
  const [tab, setTab] = useState<SelectionsTabKey>(p.initialTab);
  const pick = (t: SelectionsTabKey) => {
    setTab(t);
    if (!p.fixedJobId) router.replace(t === 'selections' ? '/selections' : `/selections?tab=${t}`, { scroll: false });
  };
  const label: Record<SelectionsTabKey, string> = { selections: v.selections, items: 'Purchasing', measures: 'Measures' };
  return (
    <div className="stack">
      {p.tabs.length > 1 && (
        <Seg<SelectionsTabKey> aria-label="Show" value={tab} onChange={pick} items={p.tabs.map((t) => ({
          value: t, label: label[t],
          count: t === 'selections' ? p.selections.filter((s) => s.status === 'OPEN' || s.status === 'PROPOSED' || s.status === 'REJECTED').length
            : t === 'items' ? p.procurement.filter((x) => !['INSTALLED', 'DELIVERED', 'RETURNED', 'CANCELLED'].includes(x.status)).length
            : p.measures.filter((m) => m.status === 'DRAFT').length || undefined,
        }))} />
      )}
      {tab === 'selections' && <SelectionsList rows={p.selections} jobs={p.jobs} today={p.today} fixedJobId={p.fixedJobId} initialJobId={p.initialJobId} focusId={p.focusId} onProcured={() => p.tabs.includes('items') && pick('items')} />}
      {tab === 'items' && <ProcurementList rows={p.procurement} jobs={p.jobs} vendors={p.vendors} storage={p.storage} today={p.today} fixedJobId={p.fixedJobId} />}
      {tab === 'measures' && <MeasuresView measures={p.measures} areas={p.areas} totals={p.totals} jobs={p.jobs} today={p.today} fixedJobId={p.fixedJobId} initialJobId={p.initialJobId} />}
    </div>
  );
}

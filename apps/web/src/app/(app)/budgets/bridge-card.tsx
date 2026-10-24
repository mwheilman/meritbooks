'use client';

/**
 * One budget bridge (Wave 4B, AC-B15) drawn with the 3C chart kit: ChartCard (table view, export,
 * text alternative) around a WaterfallChart, with the tie caption under it.
 */
import { ChartCard, WaterfallChart, bridgeTable, summarizeBridge } from '@/components/charts';
import type { BridgeOut } from '@/lib/budgets/types';
import { bridgeTieCaption, toChartSteps } from './budget-format';
import s from './budgets.module.css';

export interface BridgeCardProps {
  bridge: BridgeOut;
  index: number;
  eyebrow: string;
  period: string;
  onDrill?: (stepKey: string) => void;
}

export function BridgeCard({ bridge, index, eyebrow, period, onDrill }: BridgeCardProps) {
  const steps = toChartSteps(bridge);
  const metric = bridge.measure === 'contribution' ? 'department contribution' : 'department spend';
  const empty = bridge.steps.length === 0 && bridge.start.cents === 0 && bridge.end.cents === 0;
  return (
    <div>
      <ChartCard
        index={index}
        eyebrow={eyebrow}
        title={bridge.title}
        period={period}
        basis={bridge.measure === 'contribution' ? 'Contribution = revenue − costs, natural sign; higher is better' : 'Spend = costs, natural sign; lower is better'}
        summary={empty ? `No ${metric} to bridge.` : summarizeBridge(metric, steps, 'money')}
        table={bridgeTable(steps, { caption: bridge.title, unit: 'money' })}
        state={empty ? { kind: 'empty', title: 'Nothing to bridge yet', body: bridge.note ?? 'No budget or actuals for this department in the period.' } : undefined}
        footnotes={bridge.note ? [bridge.note] : undefined}
        drillHint={onDrill ? 'Click a step to see its largest accounts' : undefined}
        onRowDrill={onDrill}
        height={300}
      >
        <WaterfallChart steps={steps} unit="money" direction={bridge.direction} onDrill={onDrill} ariaLabel={bridge.title} />
      </ChartCard>
      {!empty && <p className={s.tie}>{bridgeTieCaption(bridge)}</p>}
    </div>
  );
}

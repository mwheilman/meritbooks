'use client';

import Link from 'next/link';
import { Widget, count } from '@meritbooks/merit-ui';
import type { SignalsData } from '@/lib/pm/ops/widget-queries';
import { useWidget, type WidgetPlacement } from './useWidget';
import '../ops.css';

/**
 * Signals: the pack's own measures for this company, read from pm.v_kpis. One row per
 * measure (label, value, what it is compared with, where to act), the ones that need
 * attention first. A ranked list, not a strip of cards.
 */
export function SignalsWidget({ x, y, w = 4, h = 4, companyId, limit = 7 }: WidgetPlacement & { limit?: number }) {
  const { data, error, reload } = useWidget<SignalsData>('signals', companyId);
  const shown = data?.signals.slice(0, limit) ?? [];
  const attn = data?.signals.filter((s) => s.attention).length ?? 0;
  return (
    <Widget
      x={x} y={y} w={w} h={h}
      title="Signals"
      count={attn || undefined}
      meta={data ? (attn ? `${count(attn)} need a look` : 'From your industry pack') : undefined}
      state={
        error ? { kind: 'error', title: 'Signals did not load', body: error, onRetry: () => void reload(), retryLabel: 'Try again' }
          : !data ? { kind: 'loading', label: 'Reading your measures…', lines: 4 }
            : data.signals.length === 0
              ? {
                  kind: 'empty',
                  title: data.packMetrics ? 'Your pack measures show on Insights' : 'No measures picked yet',
                  body: data.packMetrics
                    ? 'The measures your pack names are about margin and billing; they live on Insights. Field, shop, selection and draw measures appear here once your pack uses those modules.'
                    : 'Your industry pack picks the handful of numbers worth watching. Choose a pack in Settings to see them here.',
                }
              : undefined
      }
      foot={data && data.signals.length > limit ? <span>{count(data.signals.length - limit)} more measures in your pack</span> : undefined}
    >
      <ul className="ops-sig" aria-label="Measures">
        {shown.map((s) => (
          <li key={s.metric}>
            <Link href={s.href} aria-label={`${s.label}: ${s.value}. Open ${s.linkLabel}`}>
              <span className="l">{s.label}</span>
              <span className={s.attention ? 'v attn' : 'v'}>{s.value}</span>
              <span className="vs">{s.vs.map((t, i) => <span key={i}>{t}</span>)}</span>
              <span className="go">{s.linkLabel}</span>
            </Link>
          </li>
        ))}
      </ul>
    </Widget>
  );
}

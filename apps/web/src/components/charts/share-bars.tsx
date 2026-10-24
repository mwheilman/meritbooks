'use client';

/**
 * Concentration: ShareBars (ranked rows + one 100% strip) and Donut.
 * "Where the revenue comes from" / customer concentration / share of EBITDA.
 * Anything over the threshold (default 10%) is flagged with a word, not just a
 * colour; a loss-maker is listed hatched OUTSIDE the 100% (a negative can't have
 * a share). Top-N then "All others".
 */
import { useMemo } from 'react';
import { formatValue } from './core/format';
import { useActive, useChartCard, useRoving, useSvgId } from './core/hooks';
import { ChartDefs, fillUrl, seriesClass, fillStyle } from './core/parts';
import { shares, type ShareItem } from './core/series';
import type { ChartUnit, Value } from './core/types';

export interface ShareInput {
  key: string;
  label: string;
  value: Value;
}

export interface ShareBarsProps {
  items: ReadonlyArray<ShareInput>;
  unit?: ChartUnit;
  topN?: number;
  /** Flag shares above this (fraction). Default 0.10. */
  threshold?: number;
  thresholdLabel?: string;
  onDrill?: (key: string) => void;
}

export function ShareBars({ items, unit = 'money', topN = 8, threshold = 0.1, thresholdLabel = 'Concentration', onDrill }: ShareBarsProps) {
  const id = useSvgId('sb');
  const { labelledBy } = useChartCard();
  const s = useMemo(() => shares(items, topN), [items, topN]);
  const [active, setActive] = useActive();
  const roving = useRoving(s.items.length, { initial: 0, onActivate: onDrill ? (i) => onDrill(s.items[i].key) : undefined, onFocusIndex: setActive });
  const maxShare = Math.max(0.0001, ...s.items.map((i) => i.share));
  const maxLoss = Math.max(1, ...s.items.filter((i) => i.loss).map((i) => Math.abs(i.value)));

  const label = (it: ShareItem) =>
    it.loss ? `${it.label}: a loss of ${formatValue(Math.abs(it.value), unit)}` : `${it.label}: ${formatValue(it.value, unit)}, ${formatValue(it.share, 'percent')} of the total${it.share > threshold ? `, above the ${formatValue(threshold, 'percent', { decimals: 0 })} concentration line` : ''}`;

  let acc = 0;
  return (
    <div className="mc-share" role="group" aria-labelledby={labelledBy}>
      {/* the 100% strip */}
      <svg className="mc-share-strip" width="100%" height="12" viewBox="0 0 1000 12" preserveAspectRatio="none" aria-hidden="true">
        <ChartDefs id={id} />
        {s.items
          .filter((i) => !i.loss)
          .map((it, k) => {
            const x = acc * 1000;
            acc += it.share;
            return <rect key={it.key} className={`${it.key === '__other' ? 'mc-s5' : seriesClass(k % 5)}${s.items.indexOf(it) === active ? ' is-on' : ''}`} x={x} y={0} width={Math.max(0, it.share * 1000 - 2)} height={12} />;
          })}
      </svg>
      <ol className="mc-share-list">
        {s.items.map((it, i) => {
          const over = !it.loss && it.share > threshold;
          const props = roving.getProps(i);
          return (
            <li
              key={it.key}
              className={`mc-share-row${i === active ? ' is-on' : ''}${onDrill ? ' is-link' : ''}`}
              role={onDrill ? 'button' : undefined}
              aria-label={label(it)}
              tabIndex={props.tabIndex}
              ref={props.ref}
              onKeyDown={props.onKeyDown}
              onFocus={props.onFocus}
              onBlur={props.onBlur}
              onClick={props.onClick}
              onPointerEnter={() => setActive(i)}
              onPointerLeave={() => setActive(null)}
            >
              <span className="mc-share-l">
                <span className="l1">{it.label}</span>
              </span>
              <span className="mc-share-bar" aria-hidden="true">
                {it.loss ? (
                  <svg width="100%" height="12" viewBox="0 0 100 12" preserveAspectRatio="none">
                    <ChartDefs id={`${id}r${i}`} />
                    <rect className="mc-bar--neg" x={0} y={0} width={(Math.abs(it.value) / maxLoss) * 100} height={12} style={fillStyle(fillUrl(`${id}r${i}`, 'neg'))} />
                  </svg>
                ) : (
                  <i className={it.key === '__other' ? 'mc-s5' : seriesClass(i % 5)} style={{ width: `${(it.share / maxShare) * 100}%` }} />
                )}
                {!it.loss && <b className="mc-share-tick" style={{ left: `${(threshold / maxShare) * 100}%` }} hidden={threshold > maxShare} />}
              </span>
              <span className="mc-share-v tnum">{it.loss ? `(${formatValue(Math.abs(it.value), unit, { compact: true })}) loss` : formatValue(it.value, unit, { compact: true })}</span>
              <span className={`mc-share-p tnum${over ? ' is-over' : ''}`}>{it.loss ? '—' : formatValue(it.share, 'percent')}</span>
              <span className="mc-share-f">{over && <span className="tag tag--warn">{thresholdLabel}</span>}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

// ─────────────────────────────────────────────────────────── Donut

export interface DonutProps {
  items: ReadonlyArray<ShareInput>;
  unit?: ChartUnit;
  topN?: number;
  /** Centre caption ("Revenue"). */
  centerLabel?: string;
  size?: number;
  onDrill?: (key: string) => void;
}

/**
 * Donut — square-capped arcs with a 2px gap; centre shows the total (or the
 * focused slice). Use for ≤ 6 parts; for more, ShareBars reads better.
 */
export function Donut({ items, unit = 'money', topN = 5, centerLabel = 'Total', size = 176, onDrill }: DonutProps) {
  const { labelledBy } = useChartCard();
  const s = useMemo(() => shares(items, topN), [items, topN]);
  const parts = s.items.filter((i) => !i.loss);
  const [active, setActive] = useActive();
  const roving = useRoving(parts.length, { initial: 0, onActivate: onDrill ? (i) => onDrill(parts[i].key) : undefined, onFocusIndex: setActive });
  const r = size / 2 - 4;
  const ri = r - Math.max(14, size * 0.13);
  const c = size / 2;
  let a0 = -Math.PI / 2;
  const gap = parts.length > 1 ? 0.012 : 0;
  const arc = (from: number, to: number, outer: number, inner: number) => {
    const large = to - from > Math.PI ? 1 : 0;
    const p = (ang: number, rad: number) => `${(c + rad * Math.cos(ang)).toFixed(2)},${(c + rad * Math.sin(ang)).toFixed(2)}`;
    return `M${p(from, outer)}A${outer},${outer} 0 ${large} 1 ${p(to, outer)}L${p(to, inner)}A${inner},${inner} 0 ${large} 0 ${p(from, inner)}Z`;
  };
  const a = active !== null ? parts[active] : null;
  return (
    <div className="mc-donut" role="group" aria-labelledby={labelledBy}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="mc-svg">
        {parts.map((it, i) => {
          const sweep = it.share * Math.PI * 2;
          const from = a0 + gap;
          const to = a0 + Math.max(gap * 2, sweep) - gap;
          a0 += sweep;
          const props = roving.getProps(i);
          return (
            <g key={it.key} className="mc-pt" role={onDrill ? 'button' : 'img'} aria-label={`${it.label}: ${formatValue(it.value, unit)}, ${formatValue(it.share, 'percent')}`} {...props} onPointerEnter={() => setActive(i)} onPointerLeave={() => setActive(null)}>
              <path className={`${it.key === '__other' ? 'mc-s5' : seriesClass(i % 5)}${i === active ? ' is-on' : ''}`} d={parts.length === 1 ? `${arc(-Math.PI / 2, Math.PI * 1.5 - 0.0001, r, ri)}` : arc(from, to, i === active ? r + 3 : r, ri)} />
            </g>
          );
        })}
        <text className="mc-donut-v" x={c} y={c - 2} textAnchor="middle">
          {formatValue(a ? a.value : s.total, unit, { compact: true })}
        </text>
        <text className="mc-donut-l" x={c} y={c + 16} textAnchor="middle">
          {a ? `${formatValue(a.share, 'percent')} · ${a.label.length > 16 ? `${a.label.slice(0, 15)}…` : a.label}` : centerLabel}
        </text>
      </svg>
      <ul className="mc-donut-key" aria-hidden="true">
        {parts.map((it, i) => (
          <li key={it.key} className={i === active ? 'is-on' : undefined}>
            <i className={it.key === '__other' ? 'mc-s5' : seriesClass(i % 5)} />
            <span className="l1">{it.label}</span>
            <span className="tnum">{formatValue(it.share, 'percent')}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

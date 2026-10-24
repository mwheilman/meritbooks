'use client';

/**
 * Legend — every encoding named (solid / dashed / tick / hatch / dotted), and
 * each toggleable series is a real button (aria-pressed). Static encodings
 * (hatch = preliminary) are listed but not toggles.
 */
import { Swatch, type SwatchKind } from './core/parts';

export interface LegendItem {
  key: string;
  label: string;
  swatch: SwatchKind;
  /** Can the reader hide this series? Default true for series, false for encodings. */
  toggle?: boolean;
}

export interface LegendProps {
  items: ReadonlyArray<LegendItem>;
  hidden: ReadonlySet<string>;
  onToggle?: (key: string) => void;
  className?: string;
}

export function Legend({ items, hidden, onToggle, className }: LegendProps) {
  if (!items.length) return null;
  return (
    <ul className={className ? `mc-lgd ${className}` : 'mc-lgd'} aria-label="Legend">
      {items.map((it) =>
        it.toggle !== false && onToggle ? (
          <li key={it.key}>
            <button
              type="button"
              className="mc-lgd-b"
              aria-pressed={!hidden.has(it.key)}
              onClick={() => onToggle(it.key)}
              title={hidden.has(it.key) ? `Show ${it.label}` : `Hide ${it.label}`}
            >
              <Swatch kind={it.swatch} />
              <span>{it.label}</span>
            </button>
          </li>
        ) : (
          <li key={it.key} className="mc-lgd-s">
            <Swatch kind={it.swatch} />
            <span>{it.label}</span>
          </li>
        ),
      )}
    </ul>
  );
}

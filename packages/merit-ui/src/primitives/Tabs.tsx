'use client';

import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cx } from '../cx';

export interface TabItem<V extends string = string> {
  value: V;
  label: ReactNode;
  /** Tabular count beside the label (Electric when selected). */
  count?: ReactNode;
  /** id of the tabpanel this tab controls. */
  panelId?: string;
  disabled?: boolean;
}

function rovingKeys<V extends string>(
  e: KeyboardEvent<HTMLElement>,
  items: ReadonlyArray<{ value: V; disabled?: boolean }>,
  current: V,
  onChange: (v: V) => void,
  refs: Map<V, HTMLElement>,
  orientation: 'horizontal' | 'vertical' = 'horizontal',
) {
  const enabled = items.filter((t) => !t.disabled);
  const idx = enabled.findIndex((t) => t.value === current);
  const next = orientation === 'horizontal' ? 'ArrowRight' : 'ArrowDown';
  const prev = orientation === 'horizontal' ? 'ArrowLeft' : 'ArrowUp';
  let target: (typeof enabled)[number] | undefined;
  if (e.key === next) target = enabled[(idx + 1) % enabled.length];
  else if (e.key === prev) target = enabled[(idx - 1 + enabled.length) % enabled.length];
  else if (e.key === 'Home') target = enabled[0];
  else if (e.key === 'End') target = enabled[enabled.length - 1];
  if (!target) return;
  e.preventDefault();
  onChange(target.value);
  refs.get(target.value)?.focus();
}

export interface TabsProps<V extends string> {
  items: ReadonlyArray<TabItem<V>>;
  value: V;
  onChange: (value: V) => void;
  'aria-label': string;
  className?: string;
}

/** .tabs — 40px underline tabs; switch views of the same thing. Arrow keys rove. */
export function Tabs<V extends string>({ items, value, onChange, className, ...aria }: TabsProps<V>) {
  const refs = useRef(new Map<V, HTMLElement>());
  return (
    <div className={cx('tabs', className)} role="tablist" aria-label={aria['aria-label']}>
      {items.map((t) => {
        const selected = t.value === value;
        return (
          <button
            key={t.value}
            ref={(el) => {
              if (el) refs.current.set(t.value, el);
              else refs.current.delete(t.value);
            }}
            type="button"
            role="tab"
            className="tab"
            aria-selected={selected}
            aria-controls={t.panelId}
            tabIndex={selected ? 0 : -1}
            disabled={t.disabled}
            onClick={() => onChange(t.value)}
            onKeyDown={(e) => rovingKeys(e, items, value, onChange, refs.current)}
          >
            {t.label}
            {t.count != null && <span className="n">{t.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

export interface SegProps<V extends string> {
  items: ReadonlyArray<TabItem<V>>;
  value: V;
  onChange: (value: V) => void;
  'aria-label': string;
  className?: string;
}

/** .seg — square segmented control; switches a mode. Selected = Midnight fill. */
export function Seg<V extends string>({ items, value, onChange, className, ...aria }: SegProps<V>) {
  return (
    <div className={cx('seg', className)} role="group" aria-label={aria['aria-label']}>
      {items.map((t) => (
        <button key={t.value} type="button" aria-pressed={t.value === value} disabled={t.disabled} onClick={() => onChange(t.value)}>
          {t.label}
          {t.count != null && <span className="n">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export interface BandItem<V extends string = string> {
  value: V;
  /** Eyebrow: "Decide" / "Check" / "Ready". */
  label: ReactNode;
  /** 20px tabular count. */
  count: ReactNode;
  /** "Under 70, or the AI has a question". */
  caption?: ReactNode;
  /** Optional slash meter (or any mark) under the caption. */
  meter?: ReactNode;
  panelId?: string;
}

export interface BandsProps<V extends string> {
  items: ReadonlyArray<BandItem<V>>;
  value: V;
  onChange: (value: V) => void;
  'aria-label': string;
  className?: string;
}

/** .bands — the queue's judgment bands, each with eyebrow, count, caption and meter. */
export function Bands<V extends string>({ items, value, onChange, className, ...aria }: BandsProps<V>) {
  const refs = useRef(new Map<V, HTMLElement>());
  return (
    <div
      className={cx('bands', className)}
      role="tablist"
      aria-label={aria['aria-label']}
      style={items.length !== 3 ? { gridTemplateColumns: `repeat(${items.length},minmax(0,1fr))` } : undefined}
    >
      {items.map((b) => {
        const selected = b.value === value;
        return (
          <button
            key={b.value}
            ref={(el) => {
              if (el) refs.current.set(b.value, el);
              else refs.current.delete(b.value);
            }}
            type="button"
            role="tab"
            className="band-tab"
            aria-selected={selected}
            aria-controls={b.panelId}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(b.value)}
            onKeyDown={(e) => rovingKeys(e, items, value, onChange, refs.current)}
          >
            <span className="eyebrow">{b.label}</span>
            <span className="v">{b.count}</span>
            {b.caption != null && <span className="t-cap">{b.caption}</span>}
            {b.meter}
          </button>
        );
      })}
    </div>
  );
}

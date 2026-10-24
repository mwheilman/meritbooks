'use client';

/**
 * Chart React plumbing: container measurement (ResizeObserver, no layout shift),
 * stable SVG-safe ids, roving keyboard focus over data points, and the
 * ChartCard context (legend toggles + live announcements).
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react';

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * Width of a container, measured with ResizeObserver. SSR renders at `fallback`
 * (the SVG uses a viewBox so the first paint scales rather than reflows); the
 * container's height is fixed by the caller, so measuring never shifts layout.
 */
export function useContainerWidth<T extends HTMLElement>(fallback = 640): [RefObject<T>, number, boolean] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);
  const [measured, setMeasured] = useState(false);
  useIsoLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => {
      const w = Math.round(el.getBoundingClientRect().width);
      if (w > 0) {
        setWidth(w);
        setMeasured(true);
      }
    };
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => read());
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width, measured];
}

/** A useId() that is safe inside url(#…) references (no colons). */
export function useSvgId(prefix = 'mc'): string {
  const raw = useId();
  return `${prefix}${raw.replace(/[^a-zA-Z0-9]/g, '')}`;
}

type Focusable = HTMLElement | SVGElement;

export interface RovingOptions {
  /** Enter / Space on a point. */
  onActivate?: (index: number) => void;
  /** Focus moved to a point (or left the set: null). */
  onFocusIndex?: (index: number | null) => void;
  /** Start position for the single tab stop (default: last — "opens on latest"). */
  initial?: number;
  /** Skip indexes that have no data (gaps are not focus targets). */
  isFocusable?: (index: number) => boolean;
}

/**
 * Roving tabindex: the set of points is ONE tab stop; ← → (and ↑ ↓) move,
 * Home/End jump, Enter/Space drill, Esc leaves. Gaps are skipped.
 */
export function useRoving(count: number, opts: RovingOptions = {}) {
  const { onActivate, onFocusIndex, isFocusable } = opts;
  const ok = useCallback((i: number) => i >= 0 && i < count && (!isFocusable || isFocusable(i)), [count, isFocusable]);
  const firstOk = useCallback(
    (from: number, step: 1 | -1) => {
      for (let i = from; i >= 0 && i < count; i += step) if (ok(i)) return i;
      return -1;
    },
    [count, ok],
  );
  const [stop, setStop] = useState(() => opts.initial ?? count - 1);
  const refs = useRef<Array<Focusable | null>>([]);

  const current = ok(stop) ? stop : Math.max(firstOk(count - 1, -1), 0);

  const move = useCallback(
    (to: number) => {
      if (to < 0) return;
      setStop(to);
      refs.current[to]?.focus();
    },
    [],
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent, i: number) => {
      switch (e.key) {
        case 'ArrowRight':
        case 'ArrowDown': {
          e.preventDefault();
          const n = firstOk(i + 1, 1);
          if (n >= 0) move(n);
          break;
        }
        case 'ArrowLeft':
        case 'ArrowUp': {
          e.preventDefault();
          const n = firstOk(i - 1, -1);
          if (n >= 0) move(n);
          break;
        }
        case 'Home':
          e.preventDefault();
          move(firstOk(0, 1));
          break;
        case 'End':
          e.preventDefault();
          move(firstOk(count - 1, -1));
          break;
        case 'Enter':
        case ' ':
          if (onActivate) {
            e.preventDefault();
            onActivate(i);
          }
          break;
        case 'Escape':
          (e.currentTarget as Focusable).blur();
          onFocusIndex?.(null);
          break;
        default:
      }
    },
    [count, firstOk, move, onActivate, onFocusIndex],
  );

  const getProps = useCallback(
    (i: number) => ({
      tabIndex: i === current ? 0 : -1,
      ref: (el: Focusable | null) => {
        refs.current[i] = el;
      },
      onKeyDown: (e: KeyboardEvent) => onKeyDown(e, i),
      onFocus: () => {
        setStop(i);
        onFocusIndex?.(i);
      },
      onBlur: () => onFocusIndex?.(null),
      onClick: onActivate ? () => onActivate(i) : undefined,
    }),
    [current, onActivate, onFocusIndex, onKeyDown],
  );

  return { getProps, current };
}

// ─────────────────────────────────────────────────────────── ChartCard context

export interface ChartCardContextValue {
  /** Series keys toggled off in the legend. */
  hidden: ReadonlySet<string>;
  /** Polite live-region announcement. */
  announce: (message: string) => void;
  /** id of the card title + summary, for the SVG's aria-labelledby. */
  labelledBy?: string;
}

const NOOP: ChartCardContextValue = { hidden: new Set<string>(), announce: () => undefined };

export const ChartCardContext = createContext<ChartCardContextValue>(NOOP);

export function useChartCard(): ChartCardContextValue {
  return useContext(ChartCardContext);
}

/** Hidden-series helper honouring both the card legend and an explicit prop. */
export function useHidden(extra?: ReadonlyArray<string>): (key: string) => boolean {
  const { hidden } = useChartCard();
  return useMemo(() => {
    const set = new Set<string>([...hidden, ...(extra ?? [])]);
    return (key: string) => set.has(key);
  }, [hidden, extra]);
}

/** Hover/focus "active index" shared by crosshair and tooltip. */
export function useActive(): [number | null, (i: number | null) => void] {
  const [active, setActive] = useState<number | null>(null);
  return [active, setActive];
}

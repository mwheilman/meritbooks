'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useHotkey } from '../hotkeys/HotkeyProvider';

/** Debounce a value (search boxes): updates after `delay` ms of quiet. */
export function useDebounce<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

/**
 * Close-on-Escape for non-modal surfaces (an in-layout panel, an inline
 * editor). Goes through the hotkey registry, so it can't double-bind Esc with
 * a queue on the same page. Dialogs/drawers/popovers handle Esc themselves.
 */
export function useEscapeKey(onEscape: () => void, enabled = true, owner = 'useEscapeKey'): void {
  useHotkey('escape', () => onEscape(), { enabled, owner, allowInInputs: true });
}

export interface UseListKeynavOptions {
  count: number;
  onOpen: (index: number) => void;
  /** Optional secondary action key (default "e"), e.g. resolve. */
  onAction?: (index: number) => void;
  actionKey?: string;
  enabled?: boolean;
  owner?: string;
}

export interface UseListKeynav {
  activeIndex: number;
  setActiveIndex: (i: number) => void;
  /** Spread on each row: marks the active row and scrolls it into view. */
  rowProps: (index: number) => { 'data-active': boolean; ref: (el: HTMLElement | null) => void };
}

/**
 * J/K cursor over a non-table list (ported from Books inbox/use-list-keynav),
 * now through the one registry. Enter opens, an optional action key acts.
 * The index clamps when the list shrinks.
 */
export function useListKeynav({ count, onOpen, onAction, actionKey = 'e', enabled = true, owner = 'useListKeynav' }: UseListKeynavOptions): UseListKeynav {
  const [activeIndex, setActiveIndex] = useState(-1);
  const rowRefs = useRef(new Map<number, HTMLElement>());

  useEffect(() => {
    setActiveIndex((i) => (i >= count ? count - 1 : i));
  }, [count]);

  useEffect(() => {
    if (activeIndex >= 0) rowRefs.current.get(activeIndex)?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  const on = enabled && count > 0;
  useHotkey('j', () => setActiveIndex((i) => (i < 0 ? 0 : Math.min(i + 1, count - 1))), { enabled: on, owner });
  useHotkey('k', () => setActiveIndex((i) => (i <= 0 ? 0 : i - 1)), { enabled: on, owner });
  useHotkey(
    'enter',
    () => {
      if (activeIndex < 0 || activeIndex >= count) return false;
      onOpen(activeIndex);
      return true;
    },
    {
      enabled: on,
      owner,
      when: () => typeof document === 'undefined' || document.activeElement == null || document.activeElement === document.body,
    },
  );
  useHotkey(
    onAction ? actionKey : null,
    () => {
      if (!onAction || activeIndex < 0 || activeIndex >= count) return false;
      onAction(activeIndex);
      return true;
    },
    { enabled: on && !!onAction, owner },
  );

  const rowProps = useCallback(
    (index: number) => ({
      'data-active': index === activeIndex,
      ref: (el: HTMLElement | null) => {
        if (el) rowRefs.current.set(index, el);
        else rowRefs.current.delete(index);
      },
    }),
    [activeIndex],
  );

  return { activeIndex, setActiveIndex, rowProps };
}

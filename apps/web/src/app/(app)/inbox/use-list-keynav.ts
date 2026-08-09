'use client';

/**
 * LIST KEYBOARD NAV — vim-style j/k to move a highlighted cursor through a list,
 * Enter to open the active row, and an optional secondary action key (e.g. "e" to
 * resolve a safe exception). Read-only over the list; it owns only the cursor.
 *
 * It ignores keystrokes while the caller is typing in an input/select/textarea or
 * a contenteditable, so search boxes and dropdowns keep working. The active index
 * is clamped whenever `count` shrinks (e.g. after a resolve).
 */

import { useCallback, useEffect, useRef, useState } from 'react';

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'SELECT' ||
    tag === 'TEXTAREA' ||
    el.isContentEditable
  );
}

export interface UseListKeynavOptions {
  count: number;
  onOpen: (index: number) => void;
  /** Optional secondary action bound to a key (default "e"), e.g. resolve. */
  onAction?: (index: number) => void;
  actionKey?: string;
  /** Disable the listener (e.g. while loading / on an error state). */
  enabled?: boolean;
}

export interface UseListKeynav {
  activeIndex: number;
  setActiveIndex: (i: number) => void;
  /** Attach to each row: returns props that mark + scroll the active row. */
  rowProps: (index: number) => {
    'data-active': boolean;
    ref: (el: HTMLElement | null) => void;
  };
}

export function useListKeynav({
  count,
  onOpen,
  onAction,
  actionKey = 'e',
  enabled = true,
}: UseListKeynavOptions): UseListKeynav {
  const [activeIndex, setActiveIndex] = useState(-1);
  const rowRefs = useRef<Map<number, HTMLElement>>(new Map());

  // Clamp when the list shrinks so the cursor never points past the end.
  useEffect(() => {
    setActiveIndex((i) => (i >= count ? count - 1 : i));
  }, [count]);

  useEffect(() => {
    if (!enabled) return;
    function onKeyDown(e: KeyboardEvent) {
      if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (count === 0) return;

      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIndex((i) => {
          const next = i < 0 ? 0 : Math.min(i + 1, count - 1);
          rowRefs.current.get(next)?.scrollIntoView({ block: 'nearest' });
          return next;
        });
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex((i) => {
          const next = i <= 0 ? 0 : i - 1;
          rowRefs.current.get(next)?.scrollIntoView({ block: 'nearest' });
          return next;
        });
      } else if (e.key === 'Enter') {
        setActiveIndex((i) => {
          if (i >= 0 && i < count) {
            e.preventDefault();
            onOpen(i);
          }
          return i;
        });
      } else if (onAction && e.key === actionKey) {
        setActiveIndex((i) => {
          if (i >= 0 && i < count) {
            e.preventDefault();
            onAction(i);
          }
          return i;
        });
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [count, enabled, onOpen, onAction, actionKey]);

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

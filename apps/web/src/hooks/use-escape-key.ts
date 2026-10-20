'use client';

import { useEffect, useRef } from 'react';

/**
 * Close-on-Escape for modals/drawers (audit 06 §L.3 L12: the report GL drill-down
 * ignored Esc). Uses the latest callback without re-binding, and only fires for
 * an unmodified Esc that nothing else already handled.
 */
export function useEscapeKey(onEscape: () => void, enabled = true): void {
  const ref = useRef(onEscape);
  ref.current = onEscape;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      ref.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}

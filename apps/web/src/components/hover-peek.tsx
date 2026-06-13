'use client';

import { useRef, useState, useCallback, type ReactNode } from 'react';
import { clsx } from 'clsx';

/**
 * Passive hover-peek: hover a row and, after a short delay, a small summary card
 * appears near the cursor. It is purely passive (pointer-events: none) — it
 * never steals the hover, and vanishes the instant you leave the row. Clicking
 * the row still opens the full DetailDrawer; this is just the at-a-glance peek.
 *
 * Each list renders one <HoverPeekCard> and supplies summary content for the
 * currently-peeked item, drawn from data the row already has (so it's instant).
 */
export function useHoverPeek<T>(delay = 350) {
  const [peek, setPeek] = useState<{ item: T; x: number; y: number } | null>(null);
  const timer = useRef<number | null>(null);
  const pos = useRef({ x: 0, y: 0 });

  const clear = () => { if (timer.current) { window.clearTimeout(timer.current); timer.current = null; } };

  const handlers = useCallback((item: T) => ({
    onMouseEnter: (e: React.MouseEvent) => {
      pos.current = { x: e.clientX, y: e.clientY };
      clear();
      timer.current = window.setTimeout(() => setPeek({ item, x: pos.current.x, y: pos.current.y }), delay);
    },
    onMouseMove: (e: React.MouseEvent) => { pos.current = { x: e.clientX, y: e.clientY }; },
    onMouseLeave: () => { clear(); setPeek(null); },
  }), [delay]);

  return { peek, handlers };
}

const CARD_W = 300;

export function HoverPeekCard({ x, y, visible, title, status, children }: {
  x: number; y: number; visible: boolean;
  title: string; status?: ReactNode; children: ReactNode;
}) {
  if (!visible) return null;
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
  // Place to the right of the cursor; flip left near the right edge. Clamp vertically.
  const left = x + 20 + CARD_W > vw ? Math.max(12, x - CARD_W - 20) : x + 20;
  const top = Math.min(Math.max(12, y + 16), vh - 240);

  return (
    <div
      className="fixed z-[60] pointer-events-none animate-in fade-in duration-100"
      style={{ left, top, width: CARD_W }}
    >
      <div className="rounded-lg border border-slate-700 bg-surface-900/98 shadow-2xl backdrop-blur-sm overflow-hidden">
        <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-slate-800">
          <span className="text-sm font-semibold text-white truncate">{title}</span>
          {status}
        </div>
        <div className="px-3 py-2 space-y-1.5">{children}</div>
      </div>
    </div>
  );
}

export function PeekRow({ label, value, strong }: { label: string; value: ReactNode; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-2xs text-slate-500">{label}</span>
      <span className={clsx('text-xs text-right truncate', strong ? 'text-slate-100 font-medium font-mono tabular-nums' : 'text-slate-300')}>
        {value ?? '--'}
      </span>
    </div>
  );
}

'use client';

import { useRef, useState, useCallback, useEffect, type ReactNode } from 'react';

/**
 * Interactive hover-peek: hover a row and, after a short delay, a card anchored
 * to the row shows a real preview of the document (a mini invoice, a JE
 * T-account, a receipt image…). The card is interactive — a hover bridge keeps
 * it open while you move onto it, where an "Open full" button opens the full
 * DetailDrawer. Detail is fetched on hover and cached, so re-hovering is instant.
 */
export function useHoverPeek<T>(opts?: { openDelay?: number; closeDelay?: number }) {
  const openDelay = opts?.openDelay ?? 350;
  const closeDelay = opts?.closeDelay ?? 200;
  const [peek, setPeek] = useState<{ item: T; rect: DOMRect } | null>(null);
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);

  const cancelOpen = () => { if (openTimer.current) { window.clearTimeout(openTimer.current); openTimer.current = null; } };
  const cancelClose = () => { if (closeTimer.current) { window.clearTimeout(closeTimer.current); closeTimer.current = null; } };

  const rowHandlers = useCallback((item: T) => ({
    onMouseEnter: (e: React.MouseEvent) => {
      cancelClose();
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      cancelOpen();
      openTimer.current = window.setTimeout(() => setPeek({ item, rect }), openDelay);
    },
    onMouseLeave: () => {
      cancelOpen();
      closeTimer.current = window.setTimeout(() => setPeek(null), closeDelay);
    },
  }), [openDelay, closeDelay]);

  const cardHandlers = {
    onMouseEnter: () => cancelClose(),
    onMouseLeave: () => { closeTimer.current = window.setTimeout(() => setPeek(null), closeDelay); },
  };

  const close = useCallback(() => { cancelOpen(); cancelClose(); setPeek(null); }, []);
  return { peek, rowHandlers, cardHandlers, close };
}

// ── Detail fetch with a simple module cache (instant on re-hover) ──────────
const peekCache = new Map<string, unknown>();
export function usePeekDetail<D>(url: string | null) {
  const [data, setData] = useState<D | null>(url && peekCache.has(url) ? (peekCache.get(url) as D) : null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!url) { setData(null); return; }
    if (peekCache.has(url)) { setData(peekCache.get(url) as D); return; }
    let alive = true;
    setLoading(true);
    fetch(url)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive && d) { peekCache.set(url, d); setData(d as D); } })
      .catch(() => {})
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [url]);
  return { data, loading };
}

const CARD_W = 340;

export function HoverPeekCard({ rect, visible, cardHandlers, onOpen, children }: {
  rect: DOMRect | null;
  visible: boolean;
  cardHandlers: { onMouseEnter: () => void; onMouseLeave: () => void };
  onOpen?: () => void;
  children: ReactNode;
}) {
  if (!visible || !rect) return null;
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
  // Anchor to the right of the row; flip to the left if there's no room.
  const left = rect.right + 12 + CARD_W > vw ? Math.max(12, rect.left - CARD_W - 12) : rect.right + 12;
  const top = Math.min(Math.max(12, rect.top - 8), vh - 360);

  return (
    <div className="fixed z-[60] animate-in fade-in zoom-in-95 duration-100" style={{ left, top, width: CARD_W }} {...cardHandlers}>
      <div className="rounded-xl border border-slate-700 bg-surface-900 shadow-2xl overflow-hidden">
        {children}
        {onOpen && (
          <button onClick={onOpen} className="w-full px-3 py-2 border-t border-slate-800 text-xs font-medium text-emerald-400 hover:bg-emerald-500/[0.06] transition-colors text-center">
            Open full →
          </button>
        )}
      </div>
    </div>
  );
}

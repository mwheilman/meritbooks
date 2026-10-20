'use client';

import { useRef, useState, useCallback, useEffect, useLayoutEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { placePeekCard } from '@/lib/peek-position';

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
      // Anchor at the POINTER's x within the row's vertical band. Rows span the
      // full table width, so anchoring to the row's edges pushed the card off to
      // the far left over the sidebar (audit 06 §L.3 L11).
      const row = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const rect = new DOMRect(e.clientX, row.top, 0, row.height);
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
// useLayoutEffect warns during SSR; this component only measures on the client.
const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

export function HoverPeekCard({ rect, visible, cardHandlers, onOpen, children }: {
  rect: DOMRect | null;
  visible: boolean;
  cardHandlers: { onMouseEnter: () => void; onMouseLeave: () => void };
  onOpen?: () => void;
  children: ReactNode;
}) {
  // Measure the rendered card so placement can keep it fully on-screen.
  const cardRef = useRef<HTMLDivElement>(null);
  const [cardH, setCardH] = useState(240);
  useIsoLayoutEffect(() => {
    if (!visible || !cardRef.current) return;
    const h = cardRef.current.offsetHeight;
    if (h && Math.abs(h - cardH) > 1) setCardH(h);
  });

  if (!visible || !rect || typeof document === 'undefined') return null;
  const { left, top } = placePeekCard({
    anchorX: rect.left,
    rowTop: rect.top,
    rowBottom: rect.bottom,
    viewportW: window.innerWidth,
    viewportH: window.innerHeight,
    cardW: CARD_W,
    cardH,
  });

  // Portal to <body> so a transformed/overflowing ancestor can't re-anchor or
  // clip the fixed-position card.
  return createPortal(
    <div ref={cardRef} className="fixed z-[60] animate-in fade-in zoom-in-95 duration-100" style={{ left, top, width: CARD_W, maxHeight: 'calc(100vh - 24px)', overflowY: 'auto' }} {...cardHandlers}>
      <div className="rounded-xl border border-slate-700 bg-surface-900 shadow-2xl overflow-hidden">
        {children}
        {onOpen && (
          <button onClick={onOpen} className="w-full px-3 py-2 border-t border-slate-800 text-xs font-medium text-emerald-400 hover:bg-emerald-500/[0.06] transition-colors text-center">
            Open full →
          </button>
        )}
      </div>
    </div>,
    document.body,
  );
}

'use client';

import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type MutableRefObject, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '../primitives/Button';
import { useIsoLayoutEffect, useMounted } from './focus';

export interface PeekPlacementInput {
  /** Pointer x where the row was entered (viewport px). */
  anchorX: number;
  rowTop: number;
  rowBottom: number;
  viewportW: number;
  viewportH: number;
  cardW: number;
  cardH: number;
  gap?: number;
  margin?: number;
}

/**
 * Place a peek card relative to the POINTER's x on the row and the row's
 * vertical band, clamped inside the viewport (ported from Books lib/peek-position).
 */
export function placePeekCard(i: PeekPlacementInput): { left: number; top: number } {
  const gap = i.gap ?? 12;
  const margin = i.margin ?? 12;
  const maxLeft = Math.max(margin, i.viewportW - i.cardW - margin);
  const maxTop = Math.max(margin, i.viewportH - i.cardH - margin);
  let left = i.anchorX + gap;
  if (left + i.cardW + margin > i.viewportW) left = i.anchorX - gap - i.cardW;
  left = Math.min(Math.max(margin, left), maxLeft);
  let top = i.rowBottom + 4;
  if (top + i.cardH + margin > i.viewportH) {
    const above = i.rowTop - 4 - i.cardH;
    top = above >= margin ? above : top;
  }
  top = Math.min(Math.max(margin, top), maxTop);
  return { left: Math.round(left), top: Math.round(top) };
}

export interface PeekAnchor {
  x: number;
  top: number;
  bottom: number;
}

/**
 * Hover a row; after a short delay a card previews it. A hover bridge keeps
 * the card open while the pointer moves onto it.
 */
export function useHoverPeek<T>(opts: { openDelay?: number; closeDelay?: number } = {}) {
  const openDelay = opts.openDelay ?? 350;
  const closeDelay = opts.closeDelay ?? 200;
  const [peek, setPeek] = useState<{ item: T; anchor: PeekAnchor } | null>(null);
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);

  const clear = (t: MutableRefObject<number | null>) => {
    if (t.current != null) {
      window.clearTimeout(t.current);
      t.current = null;
    }
  };

  useEffect(
    () => () => {
      clear(openTimer);
      clear(closeTimer);
    },
    [],
  );

  const rowHandlers = useCallback(
    (item: T) => ({
      onMouseEnter: (e: ReactMouseEvent<HTMLElement>) => {
        clear(closeTimer);
        clear(openTimer);
        const r = e.currentTarget.getBoundingClientRect();
        const anchor = { x: e.clientX, top: r.top, bottom: r.bottom };
        openTimer.current = window.setTimeout(() => setPeek({ item, anchor }), openDelay);
      },
      onMouseLeave: () => {
        clear(openTimer);
        closeTimer.current = window.setTimeout(() => setPeek(null), closeDelay);
      },
    }),
    [openDelay, closeDelay],
  );

  const cardHandlers = {
    onMouseEnter: () => clear(closeTimer),
    onMouseLeave: () => {
      closeTimer.current = window.setTimeout(() => setPeek(null), closeDelay);
    },
  };

  const close = useCallback(() => {
    clear(openTimer);
    clear(closeTimer);
    setPeek(null);
  }, []);

  return { peek, rowHandlers, cardHandlers, close };
}

export interface HoverPeekCardProps {
  anchor: PeekAnchor | null;
  cardHandlers: { onMouseEnter: () => void; onMouseLeave: () => void };
  /** "Open" in the foot → the full panel/page. */
  onOpen?: () => void;
  openLabel?: string;
  width?: number;
  'aria-label': string;
  children: ReactNode;
}

/** The peek card: a .popover at the pointer, fixed, never over the rail. */
export function HoverPeekCard({ anchor, cardHandlers, onOpen, openLabel = 'Open', width = 340, children, ...aria }: HoverPeekCardProps) {
  const mounted = useMounted();
  const ref = useRef<HTMLDivElement>(null);
  const [h, setH] = useState(240);
  useIsoLayoutEffect(() => {
    const el = ref.current;
    if (el && Math.abs(el.offsetHeight - h) > 1) setH(el.offsetHeight);
  });
  if (!mounted || !anchor) return null;
  const { left, top } = placePeekCard({
    anchorX: anchor.x,
    rowTop: anchor.top,
    rowBottom: anchor.bottom,
    viewportW: window.innerWidth,
    viewportH: window.innerHeight,
    cardW: width,
    cardH: h,
  });
  return createPortal(
    <div
      ref={ref}
      className="popover popover--fixed"
      role="dialog"
      aria-label={aria['aria-label']}
      style={{ left, top, width, maxHeight: 'calc(100vh - 24px)', overflowY: 'auto' }}
      {...cardHandlers}
    >
      {children}
      {onOpen && (
        <div className="popover-foot">
          <span className="sp" />
          <Button variant="quiet" iconAfter="right" onClick={onOpen}>
            {openLabel}
          </Button>
        </div>
      )}
    </div>,
    document.body,
  );
}

'use client';

import {
  forwardRef,
  useCallback,
  useEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type KeyboardEvent,
  type LiHTMLAttributes,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { cx } from '../cx';
import { focusableIn, useIsoLayoutEffect, useMounted } from './focus';

export interface PopoverProps {
  open: boolean;
  onClose: () => void;
  /** The trigger; the popover sits under it and focus returns to it on close. */
  anchorRef: RefObject<HTMLElement>;
  children: ReactNode;
  /** Width in px (switcher 480, pickers 360). */
  width?: number;
  placement?: 'bottom-start' | 'bottom-end';
  /** Gap under the anchor (px). */
  offset?: number;
  role?: 'dialog' | 'listbox' | 'menu';
  'aria-label': string;
  id?: string;
  className?: string;
  /** Focus the first focusable (or [data-autofocus]) on open. Default true. */
  autoFocus?: boolean;
}

interface Place {
  top: number;
  left: number;
  maxHeight: number;
}

function place(anchor: HTMLElement, width: number, placement: 'bottom-start' | 'bottom-end', offset: number): Place {
  const r = anchor.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const margin = 8;
  let left = placement === 'bottom-end' ? r.right - width : r.left;
  left = Math.min(Math.max(margin, left), Math.max(margin, vw - width - margin));
  const top = r.bottom + offset;
  return { top, left, maxHeight: Math.max(160, vh - top - 16) };
}

/**
 * .popover — white, 1px Midnight border, --float. Anchored under its trigger
 * (fixed, through a portal), closes on Esc and outside click, returns focus.
 */
export function Popover({
  open,
  onClose,
  anchorRef,
  children,
  width = 360,
  placement = 'bottom-start',
  offset = 4,
  role = 'dialog',
  id,
  className,
  autoFocus = true,
  ...aria
}: PopoverProps) {
  const mounted = useMounted();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<Place | null>(null);

  const reposition = useCallback(() => {
    const a = anchorRef.current;
    if (a) setPos(place(a, width, placement, offset));
  }, [anchorRef, width, placement, offset]);

  useIsoLayoutEffect(() => {
    if (!open || !mounted) return undefined;
    reposition();
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open, mounted, reposition]);

  // Focus in on open; back to the trigger on close.
  useEffect(() => {
    if (!open || !mounted || !pos) return undefined;
    const root = ref.current;
    if (root && autoFocus) {
      const target = root.querySelector<HTMLElement>('[data-autofocus]') ?? focusableIn(root)[0] ?? root;
      target.focus({ preventScroll: true });
    }
    const anchor = anchorRef.current;
    return () => {
      if (anchor && document.contains(anchor)) anchor.focus({ preventScroll: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mounted, pos !== null]);

  // Outside click closes (the anchor toggles on its own).
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (ref.current?.contains(t) || anchorRef.current?.contains(t)) return;
      onClose();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, onClose, anchorRef]);

  if (!open || !mounted) return null;
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' && !e.defaultPrevented) {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };
  return createPortal(
    <div
      ref={ref}
      id={id}
      className={cx('popover', 'popover--fixed', className)}
      role={role}
      aria-label={aria['aria-label']}
      tabIndex={-1}
      data-hotkeys="off"
      onKeyDown={onKeyDown}
      style={{
        width,
        top: pos?.top ?? -9999,
        left: pos?.left ?? -9999,
        maxHeight: pos?.maxHeight,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

/** .popover-head — 48px search head. Put an <input data-autofocus> inside. */
export function PopoverHead({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('popover-head', className)}>{children}</div>;
}

/** .popover-list — scrolls inside the popover. */
export const PopoverList = forwardRef<HTMLUListElement, HTMLAttributes<HTMLUListElement>>(function PopoverList({ className, style, ...rest }, ref) {
  return <ul ref={ref} className={cx('popover-list', className)} style={{ flex: '1 1 auto', minHeight: 0, ...style }} {...rest} />;
});

/** .popover-group — tracked-caps group label, optional right meta. */
export function PopoverGroup({ label, meta }: { label: ReactNode; meta?: ReactNode }) {
  return (
    <li className="popover-group" role="presentation">
      <span>{label}</span>
      {meta != null && <span>{meta}</span>}
    </li>
  );
}

export interface PopoverItemProps extends Omit<LiHTMLAttributes<HTMLLIElement>, 'children'> {
  /** Keyboard/hover cursor — Sky + 3px Electric inset. */
  active?: boolean;
  /** Right-aligned meta (.r). */
  right?: ReactNode;
  children: ReactNode;
}

/** .popover-item — 40px option row. */
export const PopoverItem = forwardRef<HTMLLIElement, PopoverItemProps>(function PopoverItem({ active, right, children, className, ...rest }, ref) {
  return (
    <li ref={ref} className={cx('popover-item', className)} role="option" aria-selected={!!active} {...rest}>
      {children}
      {right != null && <span className="r">{right}</span>}
    </li>
  );
});

/** .popover-foot — Canvas foot with key hints. */
export function PopoverFoot({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('popover-foot', className)}>{children}</div>;
}

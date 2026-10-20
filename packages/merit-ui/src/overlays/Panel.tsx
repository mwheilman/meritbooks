'use client';

import { useId, useRef, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { cx } from '../cx';
import { Button } from '../primitives/Button';
import { Eyebrow } from '../primitives/Text';
import { Scrim } from './Dialog';
import { useFocusTrap, useMounted } from './focus';

export interface PanelProps {
  /** Accessible name for the region. */
  'aria-label'?: string;
  /** Tracked-caps line over the title ("Check band // 3 of 12"). Array parts join with //. */
  eyebrow?: ReactNode | ReadonlyArray<ReactNode>;
  /** t-head title ("Sunbelt Rentals"). */
  title?: ReactNode;
  /** t-cap line under the title. */
  meta?: ReactNode;
  /** The figure on the right of the head (t-title tabular, Ink). */
  figure?: ReactNode;
  /** Replaces the default head entirely. */
  head?: ReactNode;
  /** Shows the × button. */
  onClose?: () => void;
  /** Sticky footer actions (.panel-foot). */
  foot?: ReactNode;
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

/**
 * .panel — the side panel that sits BESIDE the list it describes (never over
 * the row). Header / scrolling body / sticky foot. Place it in your layout's
 * 400px column (kit S3: grid-template-columns: minmax(0,1fr) 400px).
 */
export function Panel({ eyebrow, title, meta, figure, head, onClose, foot, children, className, style, ...aria }: PanelProps) {
  const titleId = useId();
  return (
    <aside
      className={cx('panel', className)}
      aria-label={aria['aria-label']}
      aria-labelledby={!aria['aria-label'] && title != null ? titleId : undefined}
      style={style}
    >
      {head ?? (
        <div className="panel-head">
          {(eyebrow != null || onClose) && (
            <div className="row row--between">
              {eyebrow != null ? <Eyebrow as="span">{eyebrow}</Eyebrow> : <span />}
              {onClose && <Button variant="quiet" iconOnly icon="x" aria-label="Close panel" onClick={onClose} />}
            </div>
          )}
          {(title != null || figure != null) && (
            <div className="row row--between" style={{ marginTop: eyebrow != null || onClose ? 8 : 0, alignItems: 'flex-end' }}>
              <div>
                {title != null && (
                  <div className="t-head" id={titleId}>
                    {title}
                  </div>
                )}
                {meta != null && <div className="t-cap">{meta}</div>}
              </div>
              {figure != null && (
                <div className="t-title tnum" style={{ color: 'var(--ink)' }}>
                  {figure}
                </div>
              )}
            </div>
          )}
        </div>
      )}
      <div className="panel-body">{children}</div>
      {foot != null && <div className="panel-foot">{foot}</div>}
    </aside>
  );
}

export interface PanelSectionProps {
  /** 12px tracked caps heading. */
  title?: ReactNode;
  /** Right side of the heading (a Tag, a count). */
  meta?: ReactNode;
  children: ReactNode;
}

/** .panel-sec — a section inside a panel body. */
export function PanelSection({ title, meta, children }: PanelSectionProps) {
  return (
    <section className="panel-sec">
      {(title != null || meta != null) && (
        <div className="panel-sec-h">
          {title != null && <h3>{title}</h3>}
          {meta}
        </div>
      )}
      {children}
    </section>
  );
}

export interface DrawerProps extends Omit<PanelProps, 'onClose'> {
  open: boolean;
  onClose: () => void;
  /** Width in px. Kit panels are 400. */
  width?: number;
}

/**
 * A modal side panel over a fixed scrim (the Books DetailDrawer, ported).
 * Prefer an in-layout <Panel> for queues — a drawer covers what it describes.
 */
export function Drawer({ open, onClose, width = 400, ...panel }: DrawerProps) {
  const ref = useRef<HTMLDivElement>(null);
  const mounted = useMounted();
  useFocusTrap(ref, open && mounted);
  if (!open || !mounted) return null;
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' && !e.defaultPrevented) {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };
  return (
    <Scrim onDismiss={onClose} style={{ padding: 0, justifyContent: 'flex-end', alignItems: 'stretch' }}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={panel['aria-label'] ?? (typeof panel.title === 'string' ? panel.title : 'Details')} tabIndex={-1} onKeyDown={onKeyDown} style={{ display: 'flex', width, maxWidth: '100%', height: '100%', boxShadow: 'var(--float)' }}>
        <Panel {...panel} onClose={onClose} style={{ flex: 1, minWidth: 0, ...panel.style }} />
      </div>
    </Scrim>
  );
}

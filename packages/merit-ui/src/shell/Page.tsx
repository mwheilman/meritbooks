import { Fragment, type CSSProperties, type ReactNode } from 'react';
import { cx } from '../cx';
import { Eyebrow } from '../primitives/Text';

export type ContextLineItem = ReactNode | { label: ReactNode; strong?: boolean; tnum?: boolean };

function isItemObject(x: ContextLineItem): x is { label: ReactNode; strong?: boolean; tnum?: boolean } {
  return typeof x === 'object' && x !== null && !Array.isArray(x) && 'label' in (x as object) && !('$$typeof' in (x as object));
}

export interface ContextLineProps {
  /**
   * Date // period // progress // the one fact that matters.
   * ['Mon Oct 19', 'Week 43', { label: '3 jobs over budget', strong: true }]
   */
  items: ReadonlyArray<ContextLineItem>;
  /** Trailing quiet actions ("Customize"). */
  actions?: ReactNode;
  className?: string;
}

/** .ctxline — 32px, the only thing above the primary module. Items joined by the blue //. */
export function ContextLine({ items, actions, className }: ContextLineProps) {
  return (
    <div className={cx('ctxline', className)}>
      {items.map((it, i) => {
        const obj = isItemObject(it) ? it : null;
        const content = obj ? obj.label : (it as ReactNode);
        return (
          <Fragment key={i}>
            {i > 0 && (
              <>
                <span className="sl" aria-hidden="true">
                  {'//'}
                </span>
                <span className="sr">, </span>
              </>
            )}
            {obj?.strong ? <b className={obj.tnum ? 'tnum' : undefined}>{content}</b> : <span className={obj?.tnum ? 'tnum' : undefined}>{content}</span>}
          </Fragment>
        );
      })}
      {actions != null && (
        <>
          <span className="sp" />
          {actions}
        </>
      )}
    </div>
  );
}

/** .page — 24px top, 32px margins, 48px bottom. */
export function Page({ children, className, style }: { children: ReactNode; className?: string; style?: CSSProperties }) {
  return (
    <div className={cx('page', className)} style={style}>
      {children}
    </div>
  );
}

export interface PageHeadProps {
  /** Tracked-caps line over the title. Array parts join with //. */
  eyebrow?: ReactNode | ReadonlyArray<ReactNode>;
  /** Syne 28 Electric page title — one h1 per page. */
  title: ReactNode;
  /** A caption or meta under the title. */
  children?: ReactNode;
  /** Right side: the module's verbs (one primary). */
  actions?: ReactNode;
  className?: string;
}

/** .page-head — eyebrow + t-title on the left, actions bottom-right. */
export function PageHead({ eyebrow, title, children, actions, className }: PageHeadProps) {
  return (
    <div className={cx('page-head', className)}>
      <div>
        {eyebrow != null && <Eyebrow>{eyebrow}</Eyebrow>}
        <h1 className="t-title" style={eyebrow != null ? { marginTop: 4 } : undefined}>
          {title}
        </h1>
        {children}
      </div>
      {actions != null && <div className="btn-row">{actions}</div>}
    </div>
  );
}

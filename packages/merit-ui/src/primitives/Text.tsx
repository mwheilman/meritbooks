import { Fragment, type CSSProperties, type ReactNode } from 'react';
import { cx, isDev } from '../cx';
import { AppLink } from '../provider';

/** The brand's blue "//" separator. */
export function Sl({ className, style }: { className?: string; style?: CSSProperties }) {
  return (
    <span className={cx('sl', className)} aria-hidden="true" style={style}>
      {'//'}
    </span>
  );
}

/** Join parts with the blue "//" (screen readers hear a pause, not "slash slash"). */
export function joinSl(parts: ReadonlyArray<ReactNode>, slStyle?: CSSProperties): ReactNode {
  return parts.map((p, i) => (
    <Fragment key={i}>
      {i > 0 && (
        <>
          <Sl style={slStyle} />
          <span className="sr">, </span>
        </>
      )}
      {p}
    </Fragment>
  ));
}

export interface EyebrowProps {
  /** One part, or several joined by "//": ['02', 'Label'] → 02 // LABEL. */
  children: ReactNode | ReadonlyArray<ReactNode>;
  className?: string;
  as?: 'div' | 'span' | 'p';
}

/** .eyebrow — 12px tracked caps; the guide's "02 // Label". */
export function Eyebrow({ children, className, as: Tag = 'div' }: EyebrowProps) {
  const parts = Array.isArray(children) ? (children as ReadonlyArray<ReactNode>) : [children as ReactNode];
  return <Tag className={cx('eyebrow', className)}>{joinSl(parts)}</Tag>;
}

export interface FigureProps {
  /** Tracked-caps label: "Committed cost · Sep". */
  label: ReactNode;
  /** The formatted value (format it with money()/pct()). */
  value: ReactNode;
  /** Report density sets the value in Syne 28 (no decimals!); dense = DM Sans 600 20 tabular. */
  dense?: boolean;
  /** The comparison line(s): "vs Aug (12,300)", "vs budget …". Required — a number is never alone. */
  vs: ReadonlyArray<ReactNode>;
  /** Where it drills. Required — a number with nowhere to go is cut. */
  href: string;
  /** Link text: the destination's name ("Margin by job"). */
  linkLabel: ReactNode;
  className?: string;
}

/**
 * .fig — value + comparison + destination (§7.9). Not a KPI card: no icon, no
 * coloured delta chip.
 */
export function Figure({ label, value, dense, vs, href, linkLabel, className }: FigureProps) {
  if (isDev() && vs.length === 0) {
    // eslint-disable-next-line no-console
    console.warn('[merit-ui] Figure without a comparison. A number is never alone (§7.9).');
  }
  return (
    <div className={cx('fig', className)}>
      <span className="fig-l">{label}</span>
      <span className={cx('fig-v', 'tnum', dense && 'fig-v--dense')}>{value}</span>
      <span className="fig-vs">
        {vs.map((v, i) => (
          <span key={i}>{v}</span>
        ))}
      </span>
      <AppLink className="link" href={href}>
        {linkLabel}
      </AppLink>
    </div>
  );
}

export interface KVItem {
  term: ReactNode;
  value: ReactNode;
}

/** .kv — label/value pairs, values right-aligned tabular. */
export function KV({ items, className }: { items: ReadonlyArray<KVItem>; className?: string }) {
  return (
    <dl className={cx('kv', className)}>
      {items.map((it, i) => (
        <Fragment key={i}>
          <dt>{it.term}</dt>
          <dd>{it.value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

/** A dotted-leader list that does NOT sum (dates, facts). For money that must tie, use <Evidence>. */
export function Ledger({ rows, className }: { rows: ReadonlyArray<{ label: ReactNode; value: ReactNode }>; className?: string }) {
  return (
    <ul className={cx('ev', className)}>
      {rows.map((r, i) => (
        <li key={i}>
          {r.label}
          <span className="dl" />
          <span className="v">{r.value}</span>
        </li>
      ))}
    </ul>
  );
}

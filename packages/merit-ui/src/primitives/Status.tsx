import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from '../cx';

/**
 * Every pip has a distinct SHAPE plus a word (§7.4) — colour is the third
 * signal, never the only one:
 *   ready  solid spruce square      track  Steel outline
 *   risk   ochre half, cut at 45°   overdue solid brick
 *   blocked brick outline + slash   open   Signal Blue
 *   soft   ochre outline            closed Steel
 */
export type PipKind = 'ready' | 'track' | 'risk' | 'overdue' | 'blocked' | 'open' | 'soft' | 'closed';

/** The shape alone. Always pair it with a word (Status does). */
export function Pip({ kind, className }: { kind: PipKind; className?: string }) {
  return <i className={cx('pip', `pip--${kind}`, className)} aria-hidden="true" />;
}

export type StatusKind = 'ready' | 'track' | 'risk' | 'overdue' | 'blocked';

export const STATUS_WORDS: Readonly<Record<StatusKind, string>> = {
  ready: 'Ready',
  track: 'On track',
  risk: 'At risk',
  overdue: 'Overdue',
  blocked: 'Blocked',
};

export interface StatusProps {
  kind: StatusKind;
  /** The word. Defaults to the kind's word ("At risk"); override with the real state ("Sep open"). */
  children?: ReactNode;
  /** A different pip shape than the kind's (e.g. track text with an open pip: "Sep open"). */
  pip?: PipKind;
  className?: string;
}

/** .status — pip + word, coloured by kind. */
export function Status({ kind, children, pip, className }: StatusProps) {
  return (
    <span className={cx('status', `status--${kind}`, className)}>
      <Pip kind={pip ?? kind} />
      {children ?? STATUS_WORDS[kind]}
    </span>
  );
}

export type TagTone = 'default' | 'ai' | 'pos' | 'neg' | 'warn' | 'solid';

export interface TagProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: TagTone;
}

/** .tag — 20px, square. ai = Sky/Electric · pos/neg/warn washes · solid = Midnight ("Read-only"). */
export function Tag({ tone = 'default', className, ...rest }: TagProps) {
  return <span className={cx('tag', tone !== 'default' && `tag--${tone}`, className)} {...rest} />;
}

export type NoticeTone = 'default' | 'warn' | 'neg' | 'info';

export interface InlineNoticeProps {
  tone?: NoticeTone;
  /** Optional leading icon node (pass <Icon name="plug" />). */
  icon?: ReactNode;
  /** Bold lead sentence: what happened. */
  title?: ReactNode;
  /** What to do next, and any link. */
  children?: ReactNode;
  className?: string;
  /** Announce politely (status) or assertively (alert, for errors). Default by tone. */
  role?: 'status' | 'alert' | 'note';
}

/** .inline-notice — Canvas with a 3px left rule (Steel · ochre · brick · Electric on Sky). */
export function InlineNotice({ tone = 'default', icon, title, children, className, role }: InlineNoticeProps) {
  return (
    <div className={cx('inline-notice', tone !== 'default' && `inline-notice--${tone}`, className)} role={role ?? (tone === 'neg' ? 'alert' : 'status')}>
      {icon}
      <div>
        {title != null && <b>{title}</b>}
        {title != null && children != null && ' '}
        {children}
      </div>
    </div>
  );
}

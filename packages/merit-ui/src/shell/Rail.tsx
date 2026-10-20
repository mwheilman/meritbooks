'use client';

import { createContext, useContext, useId, useState, type ReactNode } from 'react';
import { Lockup } from '../brand/Lockup';
import type { LockupModule } from '../brand/lockups';
import { cx } from '../cx';
import { useHotkey } from '../hotkeys/HotkeyProvider';
import { Icon } from '../icons/Icon';
import type { IconName } from '../icons/names';
import { ChordCaps } from '../primitives/Kbd';
import { AppLink, useMeritUI } from '../provider';
import { activeHref, type FilteredNavGroup } from './nav';

const RailContext = createContext<{ mini: boolean }>({ mini: false });

export interface RailProps {
  /** The module whose product lockup tops the rail. */
  module: LockupModule;
  /** Where the logo goes (home). */
  homeHref?: string;
  /** Collapsed rail: the icon only, links as icons. Match AppShell mini. */
  mini?: boolean;
  /** <RailFoot/>. */
  foot?: ReactNode;
  /** RailGroup / RailLink children (or use <RailNav groups/>). */
  children: ReactNode;
  'aria-label'?: string;
}

/**
 * .rail — Midnight. The module's product lockup (on-dark, 24px) in the 48px
 * logo row, grouped text-only nav, the user in the foot.
 */
export function Rail({ module, homeHref = '/', mini = false, foot, children, ...aria }: RailProps) {
  return (
    <RailContext.Provider value={{ mini }}>
      <aside className="rail" aria-label={aria['aria-label'] ?? 'Primary'}>
        <div className="rail-logo">
          <AppLink href={homeHref} style={{ display: 'flex' }}>
            {mini ? <Lockup module={module} form="icon" height={20} /> : <Lockup module={module} />}
          </AppLink>
        </div>
        <nav className="rail-nav" aria-label="Main">
          {children}
        </nav>
        {foot}
      </aside>
    </RailContext.Provider>
  );
}

export interface RailGroupProps {
  label?: ReactNode;
  children: ReactNode;
}

/** A labelled group of rail links (tracked caps, Slate). */
export function RailGroup({ label, children }: RailGroupProps) {
  const id = useId();
  const { mini } = useContext(RailContext);
  if (label == null || mini) return <div role="group">{children}</div>;
  return (
    <div role="group" aria-labelledby={id}>
      <div className="rail-group" id={id}>
        {label}
      </div>
      {children}
    </div>
  );
}

export interface RailLinkProps {
  href: string;
  children: ReactNode;
  /** Open-work count, or an alert word ("Blocked"). Hidden on hover where keys show. */
  count?: number | string;
  /** Brick alert count. */
  alert?: boolean;
  /** Go-to chord ("g h"): printed on hover AND bound in the registry. */
  keys?: string;
  /** aria-current="page" — Signal bar. */
  active?: boolean;
  /** Mini-rail icon. */
  icon?: IconName;
  onClick?: () => void;
}

/** .rail-link — 32px, label · keys (on hover) · count. */
export function RailLink({ href, children, count, alert, keys, active, icon, onClick }: RailLinkProps) {
  const { mini } = useContext(RailContext);
  const { navigate } = useMeritUI();
  const label = typeof children === 'string' ? children : undefined;
  useHotkey(keys, () => navigate(href), { owner: `Rail · ${label ?? href}`, description: label ? `Go to ${label}` : undefined });
  if (mini) {
    return (
      <AppLink className="rail-icon" href={href} aria-current={active ? 'page' : undefined} aria-label={label} title={label} onClick={onClick}>
        {icon ? <Icon name={icon} /> : <span aria-hidden="true">{label?.[0] ?? '·'}</span>}
      </AppLink>
    );
  }
  return (
    <AppLink className="rail-link" href={href} aria-current={active ? 'page' : undefined} onClick={onClick}>
      {children}
      {keys && (
        <span className="keys" aria-hidden="true">
          <ChordCaps chord={keys} />
        </span>
      )}
      {count != null && count !== 0 && <span className={cx('count', alert && 'count--alert')}>{count}</span>}
    </AppLink>
  );
}

export interface RailNavProps {
  /** Output of filterNav(). */
  groups: ReadonlyArray<FilteredNavGroup>;
  /** Current pathname (usePathname()) — picks the one active link. */
  pathname: string;
  /** Label for the More fold button. */
  moreLabel?: string;
}

/** Render a filtered nav tree: groups, links, keys, counts, and each group's More fold. */
export function RailNav({ groups, pathname, moreLabel = 'More' }: RailNavProps) {
  const current = activeHref(groups, pathname);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  return (
    <>
      {groups.map((g) => {
        const showMore = open[g.id] || g.more.some((m) => m.href === current);
        return (
          <RailGroup key={g.id} label={g.label}>
            {g.items.map((it) => (
              <RailLink key={it.id ?? it.href} href={it.href} count={it.count} alert={it.alert} keys={it.keys} icon={it.icon} active={it.href === current}>
                {it.label}
              </RailLink>
            ))}
            {g.more.length > 0 &&
              (showMore ? (
                g.more.map((it) => (
                  <RailLink key={it.id ?? it.href} href={it.href} count={it.count} alert={it.alert} keys={it.keys} icon={it.icon} active={it.href === current}>
                    {it.label}
                  </RailLink>
                ))
              ) : (
                <button type="button" className="rail-link" style={{ width: '100%' }} aria-expanded={false} onClick={() => setOpen((o) => ({ ...o, [g.id]: true }))}>
                  {moreLabel}
                  <span className="count">{g.more.length}</span>
                </button>
              ))}
          </RailGroup>
        );
      })}
    </>
  );
}

export interface RailFootProps {
  /** Eyebrow ("Week 43", "September close"). */
  eyebrow?: ReactNode;
  /** Period line: value + muted "of" part ("Day 12" <span>of 15</span>). */
  period?: { value: ReactNode; of?: ReactNode };
  user?: { initials: string; name: ReactNode; role?: ReactNode };
  children?: ReactNode;
}

/** .rail-foot — period and the user. (No bell, no user menu in the bar.) */
export function RailFoot({ eyebrow, period, user, children }: RailFootProps) {
  return (
    <div className="rail-foot">
      {eyebrow != null && <div className="eyebrow">{eyebrow}</div>}
      {period && (
        <div className="rail-period">
          {period.value} {period.of != null && <span>{period.of}</span>}
        </div>
      )}
      {children}
      {user && (
        <div className="rail-user">
          <span className="avatar" aria-hidden="true">
            {user.initials}
          </span>
          <span>
            {user.name}
            {user.role != null && <small>{user.role}</small>}
          </span>
        </div>
      )}
    </div>
  );
}

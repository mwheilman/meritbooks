'use client';

import { forwardRef, Fragment, type ReactNode } from 'react';
import { cx } from '../cx';
import { ariaKeyshortcuts } from '../hotkeys/chords';
import { useHotkey } from '../hotkeys/HotkeyProvider';
import { Icon } from '../icons/Icon';
import type { IconName } from '../icons/names';
import { ChordCaps } from '../primitives/Kbd';
import { Pip, type PipKind } from '../primitives/Status';
import { AppLink } from '../provider';

/** .bar — the 48px Midnight top bar (Electric for own, Steel for consolidated). */
export function Bar({ children, className }: { children: ReactNode; className?: string }) {
  return <header className={cx('bar', className)}>{children}</header>;
}

export interface ContextChipProps {
  /** Where you are working: "Heartland Heating & Cooling", "Merit Management Group". */
  name: ReactNode;
  /** Muted meta: "C-103 · Sep open", "Workspace". */
  meta?: ReactNode;
  /** Leading mark: a pip (company status) or an icon (grid = workspace, layers = consolidated). */
  pip?: PipKind;
  icon?: IconName;
  /** Tag: own → "Own books" (Electric / Warm on the blue bar); ro → "Read-only". */
  tag?: { kind: 'own' | 'ro'; label?: ReactNode };
  /** The switcher's open state (aria-expanded) and id (aria-controls). */
  expanded?: boolean;
  controls?: string;
  onOpen: () => void;
  /** Bind ⌘J (default true). */
  bindChord?: boolean;
}

/** .ctx — the context chip; opens the switcher with ⌘J. */
export const ContextChip = forwardRef<HTMLButtonElement, ContextChipProps>(function ContextChip(
  { name, meta, pip, icon, tag, expanded = false, controls, onOpen, bindChord = true },
  ref,
) {
  useHotkey(bindChord ? 'mod+j' : null, () => onOpen(), { owner: 'ContextChip', description: 'Switch company or view' });
  return (
    <button
      ref={ref}
      className="ctx"
      type="button"
      aria-haspopup="dialog"
      aria-expanded={expanded}
      aria-controls={controls}
      aria-keyshortcuts={ariaKeyshortcuts('mod+j')}
      onClick={onOpen}
    >
      {pip ? <Pip kind={pip} /> : icon ? <Icon name={icon} /> : null}
      <span className="ctx-name">{name}</span>
      {meta != null && <span className="ctx-meta tnum">{meta}</span>}
      {tag && <span className={cx('ctx-tag', `ctx-tag--${tag.kind}`)}>{tag.label ?? (tag.kind === 'own' ? 'Own books' : 'Read-only')}</span>}
      <Icon name="down" />
      <ChordCaps chord="mod+j" />
    </button>
  );
});

export interface Crumb {
  label: ReactNode;
  href?: string;
}

/** .crumbs — "Jobs / J-1042 Ankeny clinic / <b>Budget</b>". The last crumb is the page. */
export function Crumbs({ items }: { items: ReadonlyArray<Crumb> }) {
  return (
    <nav className="crumbs" aria-label="Breadcrumb">
      {items.map((c, i) => {
        const last = i === items.length - 1;
        return (
          <Fragment key={i}>
            {i > 0 && ' / '}
            {last ? (
              <b aria-current="page">{c.label}</b>
            ) : c.href ? (
              <AppLink href={c.href}>{c.label}</AppLink>
            ) : (
              c.label
            )}
          </Fragment>
        );
      })}
    </nav>
  );
}

export interface CmdkTriggerProps {
  /** "Jump to job, vendor, cost code…" — name what the user can reach. */
  label?: ReactNode;
  onOpen: () => void;
  /** Bind ⌘K (default true). */
  bindChord?: boolean;
}

/** .cmdk — the command bar trigger (⌘K). */
export function CmdkTrigger({ label = 'Jump to job, vendor, cost code…', onOpen, bindChord = true }: CmdkTriggerProps) {
  useHotkey(bindChord ? 'mod+k' : null, () => onOpen(), { owner: 'CmdkTrigger', description: 'Jump to…' });
  return (
    <button className="cmdk" type="button" aria-haspopup="dialog" aria-keyshortcuts={ariaKeyshortcuts('mod+k')} onClick={onOpen}>
      <Icon name="search" />
      <span>{label}</span>
      <ChordCaps chord="mod+k" />
    </button>
  );
}

/** .sync — "Synced 9:38 AM". Honest: say "Sync paused 2h" when it is. */
export function SyncStatus({ children }: { children: ReactNode }) {
  return (
    <span className="sync" role="status">
      <i aria-hidden="true" />
      {children}
    </span>
  );
}

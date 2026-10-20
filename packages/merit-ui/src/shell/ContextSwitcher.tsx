'use client';

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { PRODUCT_NAMES, type LockupModule } from '../brand/lockups';
import { Icon } from '../icons/Icon';
import type { IconName } from '../icons/names';
import { Keys } from '../primitives/Kbd';
import { Pip, Tag, type PipKind } from '../primitives/Status';
import { Popover, PopoverFoot, PopoverGroup, PopoverHead, PopoverItem, PopoverList } from '../overlays/Popover';

export interface SwitcherItem {
  id: string;
  /** Display label (name + muted code). */
  label: ReactNode;
  /** Plain text the filter matches: name, number, code ("heartland heating cooling c-103 hhc"). */
  text: string;
  /** Leading company-status pip … */
  pip?: PipKind;
  /** … or icon (grid = workspace, layers = consolidated, book/hammer = products). */
  icon?: IconName;
  /** Icon tone: blue for consolidated groups. */
  iconTone?: 'blue' | 'ink-2';
  /** Second line (.l2). */
  sub?: ReactNode;
  /** Right meta: open count, status word, tags. */
  right?: ReactNode;
  /** Mark "You are here". */
  current?: boolean;
  /** Where choosing it goes (a product switch, a company home). */
  href?: string;
}

export interface SwitcherGroup {
  id: string;
  label: string;
  /** Right side of the group header ("3", "13 · type to filter"). */
  meta?: ReactNode;
  items: ReadonlyArray<SwitcherItem>;
}

export interface ContextSwitcherProps {
  open: boolean;
  onClose: () => void;
  /** The ContextChip (anchor + focus return). */
  anchorRef: RefObject<HTMLElement>;
  /** Row before the groups (the workspace). */
  lead?: SwitcherItem;
  /** Recent · Pinned · My companies · All · Consolidated · Products (order is the caller's). */
  groups: ReadonlyArray<SwitcherGroup>;
  onSelect: (item: SwitcherItem) => void;
  placeholder?: string;
  /** Foot note on the right ("Keeps you on Job board"). */
  footNote?: ReactNode;
  id?: string;
  width?: number;
}

function matches(item: SwitcherItem, q: string): boolean {
  if (!q) return true;
  const hay = item.text.toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((tok) => hay.includes(tok));
}

/**
 * The ⌘J switcher (S7): a 480px popover under the chip. Type to filter,
 * ↑↓ to move, ↵ to open, Esc to close. Every row says how it's going (pip +
 * count), so the switcher doubles as a triage list. The chosen context is a
 * hint — the server still checks access.
 */
export function ContextSwitcher({
  open,
  onClose,
  anchorRef,
  lead,
  groups,
  onSelect,
  placeholder = 'Find a company by name, number or code',
  footNote,
  id,
  width = 480,
}: ContextSwitcherProps) {
  const uid = useId();
  const listId = `${uid}-list`;
  const [q, setQ] = useState('');
  const [cursor, setCursor] = useState(0);
  const itemRefs = useRef(new Map<string, HTMLLIElement>());

  const visible = useMemo(() => {
    const gs = groups.map((g) => ({ ...g, items: g.items.filter((it) => matches(it, q)) })).filter((g) => g.items.length > 0);
    const leadVisible = lead && matches(lead, q) ? lead : undefined;
    const flat: SwitcherItem[] = [...(leadVisible ? [leadVisible] : []), ...gs.flatMap((g) => g.items)];
    return { gs, lead: leadVisible, flat };
  }, [groups, lead, q]);

  // Reset only when it opens (not when the caller re-renders new group arrays
  // while it's open); start the cursor on the first item that isn't "here".
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      setQ('');
      const all = [...(lead ? [lead] : []), ...groups.flatMap((g) => g.items)];
      const first = all.findIndex((it) => !it.current);
      setCursor(first < 0 ? 0 : first);
    }
    wasOpen.current = open;
  }, [open, lead, groups]);

  useEffect(() => {
    setCursor((c) => Math.min(c, Math.max(0, visible.flat.length - 1)));
  }, [visible.flat.length]);

  const active = visible.flat[cursor];
  useEffect(() => {
    if (active) itemRefs.current.get(active.id)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const choose = (item: SwitcherItem | undefined) => {
    if (!item) return;
    onSelect(item);
    onClose();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const n = visible.flat.length;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (n) setCursor((c) => (c + 1) % n);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (n) setCursor((c) => (c - 1 + n) % n);
    } else if (e.key === 'Home') {
      e.preventDefault();
      setCursor(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setCursor(Math.max(0, n - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(active);
    }
  };

  const optId = (it: SwitcherItem) => `${uid}-o-${it.id}`;

  const row = (it: SwitcherItem) => (
    <PopoverItem
      key={it.id}
      id={optId(it)}
      ref={(el) => {
        if (el) itemRefs.current.set(it.id, el);
        else itemRefs.current.delete(it.id);
      }}
      active={active?.id === it.id}
      aria-current={it.current ? 'true' : undefined}
      onMouseMove={() => {
        const i = visible.flat.findIndex((f) => f.id === it.id);
        if (i >= 0 && i !== cursor) setCursor(i);
      }}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => choose(it)}
      right={it.current ? <Tag>You are here</Tag> : it.right}
    >
      {it.pip ? <Pip kind={it.pip} /> : it.icon ? <Icon name={it.icon} className={it.iconTone ?? 'ink-2'} /> : null}
      <span style={{ minWidth: 0 }}>
        {it.label}
        {it.sub != null && <span className="l2">{it.sub}</span>}
      </span>
    </PopoverItem>
  );

  return (
    <Popover open={open} onClose={onClose} anchorRef={anchorRef} width={width} aria-label="Switch context" id={id}>
      <PopoverHead>
        <Icon name="search" className="ink-3" />
        <input
          data-autofocus
          type="search"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={active ? optId(active) : undefined}
          aria-autocomplete="list"
          aria-label={placeholder}
          placeholder={placeholder}
          autoComplete="off"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setCursor(0);
          }}
          onKeyDown={onKeyDown}
        />
        <kbd className="kbd">Esc</kbd>
      </PopoverHead>
      <PopoverList role="listbox" id={listId} aria-label="Contexts">
        {visible.lead && row(visible.lead)}
        {visible.gs.map((g) => (
          <PopoverGroupBlock key={g.id} group={g} render={row} />
        ))}
        {visible.flat.length === 0 && (
          <li className="popover-group" role="presentation">
            <span>Nothing matches “{q}”. Try a company number or code.</span>
          </li>
        )}
      </PopoverList>
      <PopoverFoot>
        <Keys chord="↑ ↓">move</Keys>
        <Keys chord="enter">open</Keys>
        <Keys chord="escape">close</Keys>
        {footNote != null && (
          <>
            <span className="sp" />
            <span>{footNote}</span>
          </>
        )}
      </PopoverFoot>
    </Popover>
  );
}

function PopoverGroupBlock({ group, render }: { group: SwitcherGroup; render: (it: SwitcherItem) => ReactNode }) {
  return (
    <>
      <PopoverGroup label={group.label} meta={group.meta} />
      {group.items.map(render)}
    </>
  );
}

export interface ProductLink {
  module: LockupModule;
  href: string;
  /** Right meta ("12 open"). */
  right?: ReactNode;
}

const PRODUCT_ICONS: Partial<Record<LockupModule, IconName>> = {
  books: 'book',
  projects: 'hammer',
  crm: 'users',
  fpa: 'sliders',
  hr: 'users',
  inventory: 'box',
  payroll: 'dollar',
  platform: 'grid',
};

/**
 * The "Products" group: move between Merit Books, Merit Projects … in the same
 * context. Written names are the two-word product names (§1.3).
 */
export function productsGroup(current: LockupModule, products: ReadonlyArray<ProductLink>): SwitcherGroup {
  return {
    id: 'products',
    label: 'Products',
    items: products.map((p) => ({
      id: `product-${p.module}`,
      label: PRODUCT_NAMES[p.module],
      text: `${PRODUCT_NAMES[p.module]} product ${p.module}`.toLowerCase(),
      icon: PRODUCT_ICONS[p.module] ?? 'grid',
      iconTone: 'ink-2' as const,
      href: p.href,
      right: p.right,
      current: p.module === current,
    })),
  };
}

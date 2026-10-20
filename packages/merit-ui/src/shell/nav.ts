/**
 * Rail navigation model + filterNav() (IA-SPEC §3.6.2 progressive disclosure).
 *
 *   1. Permission first — an item the user can't view is never rendered; a
 *      group with nothing visible disappears. FAILS CLOSED: an item with a
 *      capability and no `can` function is hidden. (UI only — the server's
 *      page guard is the security boundary.)
 *   2. Context — items/groups can be limited to shell contexts. Processing
 *      items are REMOVED (not disabled) in a consolidated view.
 *   3. Activation (A) — module items show when the company uses the module,
 *      and never hide while they hold open work (count > 0).
 *   4. More fold (M) — rare items move to the group's `more` list unless they
 *      hold open work, which promotes them above the fold.
 *   5. Order is stable; hidden items leave no gaps.
 */
import type { IconName } from '../icons/names';

/** The bar states of guide §6.1. A job is a page object, not a context. */
export type ShellContext = 'client' | 'own' | 'consolidated' | 'workspace' | 'platform';

/** C core (always) · A activated by module use · M behind the group's "More". */
export type Disclosure = 'C' | 'A' | 'M';

export interface NavItem {
  /** Stable id (defaults to href). */
  id?: string;
  label: string;
  href: string;
  /** Capability the user needs to see it (checked with `can`). */
  capability?: string;
  /** Open-work count, or a word for alerts ("Blocked"). */
  count?: number | string;
  /** Show the count as an alert (brick). */
  alert?: boolean;
  /** Go-to chord printed on hover and bound in the registry ("g h"). */
  keys?: string;
  disclosure?: Disclosure;
  /** For A items: the module that activates it ("field", "selections"). */
  module?: string;
  /** Only in these contexts. */
  contexts?: ReadonlyArray<ShellContext>;
  /** Processing work (posting, approving): removed in consolidated views. */
  processing?: boolean;
  /** Mini-rail icon only (the full rail is text-only). */
  icon?: IconName;
}

export interface NavGroup {
  id: string;
  /** Tracked-caps group label. Omit for the ungrouped top block. */
  label?: string;
  items: ReadonlyArray<NavItem>;
  contexts?: ReadonlyArray<ShellContext>;
}

export interface FilteredNavGroup {
  id: string;
  label?: string;
  items: NavItem[];
  /** Items folded behind "More". */
  more: NavItem[];
}

export interface NavFilter {
  context: ShellContext;
  /** Capability check. Missing → every capability-gated item is hidden. */
  can?: (capability: string) => boolean;
  /** Modules the company uses (activates A items). */
  modulesInUse?: ReadonlyArray<string>;
  /** Put M items inline instead of folding them (e.g. when the user expanded "More"). */
  expandMore?: boolean;
}

function hasOpenWork(item: NavItem): boolean {
  return typeof item.count === 'number' ? item.count > 0 : typeof item.count === 'string' && item.count.length > 0;
}

function visible(item: NavItem, f: NavFilter): boolean {
  if (item.capability !== undefined && !(f.can?.(item.capability) ?? false)) return false;
  if (item.contexts && !item.contexts.includes(f.context)) return false;
  if (f.context === 'consolidated' && item.processing) return false;
  if (item.disclosure === 'A') {
    const used = item.module !== undefined && (f.modulesInUse ?? []).includes(item.module);
    if (!used && !hasOpenWork(item)) return false;
  }
  return true;
}

/** Apply permission, context, activation and the More fold. Pure. */
export function filterNav(groups: ReadonlyArray<NavGroup>, f: NavFilter): FilteredNavGroup[] {
  const out: FilteredNavGroup[] = [];
  for (const g of groups) {
    if (g.contexts && !g.contexts.includes(f.context)) continue;
    const items: NavItem[] = [];
    const more: NavItem[] = [];
    for (const item of g.items) {
      if (!visible(item, f)) continue;
      if (item.disclosure === 'M' && !f.expandMore && !hasOpenWork(item)) more.push(item);
      else items.push(item);
    }
    if (items.length === 0 && more.length === 0) continue;
    out.push({ id: g.id, label: g.label, items, more });
  }
  return out;
}

/** Normalise a path for matching: no query/hash, no trailing slash. */
function cleanPath(p: string): string {
  const base = p.split(/[?#]/)[0] ?? '';
  return base.length > 1 ? base.replace(/\/+$/, '') : base;
}

/**
 * The href of the single active item for `pathname`: an exact match, else the
 * longest prefix on a "/" boundary ("/jobs/J-1042/budget" → "/jobs").
 */
export function activeHref(groups: ReadonlyArray<{ items: ReadonlyArray<NavItem>; more?: ReadonlyArray<NavItem> }>, pathname: string): string | null {
  const path = cleanPath(pathname);
  let best: string | null = null;
  let bestLen = -1;
  for (const g of groups) {
    for (const item of [...g.items, ...(g.more ?? [])]) {
      const href = cleanPath(item.href);
      const match = path === href || (href !== '/' && path.startsWith(`${href}/`));
      if (match && href.length > bestLen) {
        best = item.href;
        bestLen = href.length;
      }
    }
  }
  return best;
}

/** Every go-to chord in a nav tree, for a shortcut sheet or a conflict check. */
export function navChords(groups: ReadonlyArray<{ items: ReadonlyArray<NavItem> }>): Array<{ keys: string; label: string; href: string }> {
  return groups.flatMap((g) => g.items.filter((i) => i.keys).map((i) => ({ keys: i.keys as string, label: i.label, href: i.href })));
}

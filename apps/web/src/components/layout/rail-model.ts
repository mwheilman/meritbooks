/**
 * The Books rail, as data (Redesign R1). Pure — the shell renders the result with
 * merit-ui <RailNav>. Applies, in this order, exactly the filters the old sidebar
 * applied, then hands the survivors to merit-ui filterNav() for the "More" fold:
 *
 *   1. plane filter      — which hat (lib/planes.ts: books / practice / platform)
 *   2. company gate      — in Books with no client picked, only Home (Dashboard +
 *                          Inbox) shows; processing starts after a client is chosen
 *   3. industry packs    — pack groups (requiresPack) only for clients that switched
 *                          the pack on (useIndustryPacks)
 *   4. role permissions  — filterNavByPermissions (fail-SAFE; the server guards fail
 *                          closed — the rail is a usability lens, not the boundary)
 *   5. More fold         — IA-SPEC §3.6.2 'M' items fold unless they hold open work
 */
import { filterNav, type FilteredNavGroup, type NavGroup as KitNavGroup, type ShellContext } from '@meritbooks/merit-ui';
import { navigation, type NavGroup } from '@/lib/navigation';
import { PLANES, type Plane } from '@/lib/planes';
import { featureForHref, filterNavByPermissions, type ViewProbe } from '@/components/layout/nav-permissions';
import type { IndustryPacks } from '@/lib/hooks/use-industry-packs';

/** The only Home items reachable before a client is picked (cross-client by design). */
export const WORKSPACE_SAFE_HREFS: readonly string[] = ['/dashboard', '/inbox'];

export interface RailCounts {
  /** /api/inbox total — the old header bell's live count, now on the rail. */
  inbox?: number;
  /** Any CRITICAL item in the inbox → brick count. */
  inboxAlert?: boolean;
}

export interface RailInput {
  plane: Plane;
  /** Books plane with no single client selected. */
  mustSelectCompany: boolean;
  packs: IndustryPacks;
  hasPermissionData: boolean;
  canView: ViewProbe;
  context: ShellContext;
  counts?: RailCounts;
  /** Source tree (tests inject fixtures). */
  groups?: NavGroup[];
}

function slug(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** Steps 1–4: the old sidebar's filters, unchanged in behaviour. */
export function visibleNavGroups(input: Omit<RailInput, 'context' | 'counts'>): NavGroup[] {
  const groups = input.groups ?? navigation;
  const planeGroups = PLANES[input.plane].groups;
  const gated = groups
    .filter((g) => planeGroups.includes(g.label))
    .filter((g) => !input.mustSelectCompany || g.label === 'Home')
    .map((g) =>
      input.mustSelectCompany && g.label === 'Home'
        ? { ...g, items: g.items.filter((i) => WORKSPACE_SAFE_HREFS.includes(i.href)) }
        : g,
    )
    .filter((g) => !g.requiresPack || input.packs[g.requiresPack]);
  const permitted = filterNavByPermissions(gated, { hasPermissionData: input.hasPermissionData, canView: input.canView });
  return permitted
    .map((g) => {
      const items = g.items.filter((i) => isDeepLinkVisible(i.href, input.hasPermissionData, input.canView));
      return items.length === g.items.length ? g : { ...g, items };
    })
    .filter((g) => g.label === 'Home' || g.items.length > 0);
}

/**
 * A deep link into a tab (`/team?tab=performance`) is gated by its page's feature (the
 * page guard checks the path, not the query) — the exact-href map can't see it, so it is
 * resolved by path here. Same fail-safe as nav-permissions: no usable data → shown.
 */
export function isDeepLinkVisible(href: string, hasPermissionData: boolean, canView: ViewProbe): boolean {
  const q = href.indexOf('?');
  if (q < 0 || !hasPermissionData) return true;
  const feature = featureForHref(href.slice(0, q));
  return !feature || canView(feature);
}

/** Steps 1–5, as merit-ui FilteredNavGroup[] for <RailNav>. */
export function buildRail(input: RailInput): FilteredNavGroup[] {
  const kit: KitNavGroup[] = visibleNavGroups(input).map((g) => ({
    id: slug(g.label),
    // The Home block reads as the ungrouped top of the rail (kit S1/S2 boards label it "Home").
    label: g.label,
    items: g.items.map((i) => ({
      id: i.href,
      label: i.label,
      href: i.href,
      icon: i.icon,
      keys: i.keys,
      disclosure: i.disclosure,
      ...(i.href === '/inbox' && input.counts?.inbox ? { count: input.counts.inbox > 99 ? '99+' : input.counts.inbox, alert: !!input.counts.inboxAlert } : {}),
    })),
  }));
  return filterNav(kit, { context: input.context });
}

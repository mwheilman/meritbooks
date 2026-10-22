'use client';

/**
 * THE BOOKS SHELL (Redesign R1) — the Merit Suite frame from packages/merit-ui:
 * Midnight rail with the Merit Books lockup and the grouped nav · 48px bar with the
 * ⌘J context chip, crumbs, ⌘K (CPA Desk) and ⌘/ (search) · 32px context line ·
 * the page. No banner, no greeting (kit rule 9).
 *
 * The bar wears the IA-SPEC §3.1 context state (kit §6.1):
 *   client        a client's books                      Midnight bar, period pip
 *   own           the tenant's OWN books                Electric bar + "Own books"
 *   workspace     all clients (no client picked) or the Team & settings plane
 *   consolidated  the consolidation view across clients Steel bar + double rule, read-only
 *   platform      the operator console                  Midnight bar
 *
 * Behaviour kept from the old sidebar/header: the plane filter, the "pick a client
 * first" gate, role-permission filtering, the industry-pack gate, the Access nav
 * entries, the live inbox count (was the bell), ⌘K owned by the CPA Desk command
 * bar, ⌘/ search, the Clerk user menu.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { UserButton } from '@clerk/nextjs';
import {
  AppShell,
  Bar,
  ChordCaps,
  CmdkTrigger,
  ContextChip,
  ContextLine,
  ContextSwitcher,
  Crumbs,
  Icon,
  Page,
  Rail,
  RailFoot,
  RailNav,
  SyncStatus,
  Tag,
  activeHref,
  clockTime,
  dayDate,
  productsGroup,
  toast,
  useHotkey,
  type ContextLineItem,
  type Crumb,
  type Density,
  type PipKind,
  type ShellContext,
  type SwitcherGroup,
  type SwitcherItem,
} from '@meritbooks/merit-ui';
import { usePlane } from '@/lib/hooks/use-plane';
import { useActiveCompany } from '@/lib/hooks/use-active-company';
import { useMe } from '@/lib/hooks/use-me';
import { useIndustryPacks } from '@/lib/hooks/use-industry-packs';
import { ALL_COMPANIES } from '@/lib/company-scope';
import { PLANES, type Plane } from '@/lib/planes';
import { getShellClientContext, type ShellClientContext, type ShellPeriodStatus } from '@/lib/shell/actions';
import { getWorkboard, type CompanyBoard } from '@/app/(app)/dashboard/actions';
import { openCommandBar, isSearchChord } from '@/components/nl/command-bar-events';
import { CommandBar } from '@/components/nl/command-bar';
import { SearchPalette } from '@/components/layout/search-palette';
import { HelpButtonFloating } from '@/components/help/help-button';
import { ToastContainer } from '@/components/ui/toast';
import { ErrorBoundary } from '@/components/error-boundary';
import { LegacyIsland } from '@/components/layout/legacy-scope';
import { buildRail, visibleNavGroups } from '@/components/layout/rail-model';
import { crumbsFor } from '@/components/layout/crumbs';
import { ShellSlotsProvider } from '@/components/layout/shell-context';
import { useInboxCount } from '@/components/layout/use-inbox-count';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const PERIOD_WORD: Record<ShellPeriodStatus, string> = { OPEN: 'open', SOFT_CLOSE: 'soft close', HARD_CLOSE: 'closed', NO_PERIOD: 'no period' };
const PERIOD_PIP: Record<ShellPeriodStatus, PipKind> = { OPEN: 'open', SOFT_CLOSE: 'soft', HARD_CLOSE: 'closed', NO_PERIOD: 'track' };

/** Owners and finance leaders read; everyone else works (kit: density by ROLE). */
const REPORT_ROLES = new Set(['cfo', 'company_admin']);

const RECENTS_KEY = 'mb.switcher.recents';
const MINI_KEY = 'mb.rail.mini';
const PROJECTS_URL = process.env.NEXT_PUBLIC_PROJECTS_URL;

type View = 'client' | 'all' | 'practice' | 'platform' | 'consolidated';

function monthName(ym: string | undefined): string | null {
  if (!ym) return null;
  const m = Number(ym.split('-')[1]);
  return MONTHS[m - 1] ?? null;
}

function initials(first: string | undefined, last: string | undefined, fallback: string): string {
  const s = `${(first ?? '').trim()[0] ?? ''}${(last ?? '').trim()[0] ?? ''}`.toUpperCase();
  return s || fallback.slice(0, 2).toUpperCase();
}

function readRecents(): string[] {
  try {
    const v = JSON.parse(window.localStorage.getItem(RECENTS_KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 5) : [];
  } catch {
    return [];
  }
}

function pushRecent(id: string) {
  try {
    const next = [id, ...readRecents().filter((x) => x !== id)].slice(0, 5);
    window.localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable */
  }
}

/** Per-client period status + own-books flag for the chip (cached per client id). */
function useClientContext(id: string | null): ShellClientContext | null {
  const cache = useRef(new Map<string, ShellClientContext | null>());
  const [ctx, setCtx] = useState<ShellClientContext | null>(null);
  useEffect(() => {
    if (!id) {
      setCtx(null);
      return;
    }
    if (cache.current.has(id)) {
      setCtx(cache.current.get(id) ?? null);
      return;
    }
    let alive = true;
    setCtx(null);
    void getShellClientContext(id)
      .then((c) => {
        cache.current.set(id, c);
        if (alive) setCtx(c);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [id]);
  return ctx;
}

/** "Loaded 9:38 AM" — honest about when the page's data was read. */
function useLoadedAt(pathname: string): string | null {
  const [at, setAt] = useState<string | null>(null);
  useEffect(() => setAt(clockTime(new Date())), [pathname]);
  return at;
}

export function BooksShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname() ?? '/';
  const { plane, available, setPlane } = usePlane();
  const { activeCompanyId, activeCompany, isAll, companies, setActiveCompany } = useActiveCompany();
  const { permissions, can, user, orgName } = useMe();
  const packs = useIndustryPacks();
  const inbox = useInboxCount(true);
  const clientCtx = useClientContext(plane === 'books' && !isAll ? activeCompanyId : null);
  const loadedAt = useLoadedAt(pathname);

  const chipRef = useRef<HTMLButtonElement>(null);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [mini, setMini] = useState(false);
  const [today, setToday] = useState<Date | null>(null);
  const [recents, setRecents] = useState<string[]>([]);
  const [board, setBoard] = useState<{ at: number; byId: Map<string, CompanyBoard> } | null>(null);
  // Page-provided slots, remembered with the path they were set for so a stale
  // value never leaks onto the next page.
  const [line, setLineState] = useState<{ path: string; items: ReadonlyArray<ContextLineItem> } | null>(null);
  const [pageCrumbs, setPageCrumbsState] = useState<{ path: string; crumbs: ReadonlyArray<Crumb> } | null>(null);

  useEffect(() => {
    setToday(new Date());
    setRecents(readRecents());
    try {
      setMini(window.localStorage.getItem(MINI_KEY) === '1');
    } catch {
      /* default: full rail */
    }
  }, []);

  const toggleMini = useCallback(() => {
    setMini((m) => {
      try {
        window.localStorage.setItem(MINI_KEY, m ? '0' : '1');
      } catch {
        /* ignore */
      }
      return !m;
    });
  }, []);
  useHotkey('[', toggleMini, { owner: 'Books rail', description: 'Collapse or expand the rail' });

  // ⌘/ opens search (⌘K is owned by the CPA Desk command bar — never bind it twice).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (isSearchChord(e)) {
        e.preventDefault();
        setSearchOpen((o) => !o);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ── Context ─────────────────────────────────────────────────────────────────
  const onConsolidation = pathname === '/consolidation' || pathname.startsWith('/consolidation/');
  const view: View =
    plane === 'platform' ? 'platform' : plane === 'practice' ? 'practice' : isAll ? (onConsolidation ? 'consolidated' : 'all') : 'client';
  const own = view === 'client' && clientCtx?.id === activeCompanyId && clientCtx.isOwnBooks;
  const context: ShellContext =
    view === 'client' ? (own ? 'own' : 'client') : view === 'consolidated' ? 'consolidated' : view === 'platform' ? 'platform' : 'workspace';
  const density: Density = user?.role && REPORT_ROLES.has(user.role) ? 'report' : 'cockpit';
  const org = orgName ?? 'Your workspace';
  const n = companies.length;

  // ── Rail ────────────────────────────────────────────────────────────────────
  const mustSelectCompany = plane === 'books' && isAll;
  const hasPermissionData = permissions !== null && Object.keys(permissions.featurePermissions).length > 0;
  const canView = useCallback((featureId: string) => can(featureId, 'view'), [can]);
  const railGroups = useMemo(
    () =>
      buildRail({
        plane,
        mustSelectCompany,
        packs,
        hasPermissionData,
        canView,
        context,
        counts: inbox ? { inbox: inbox.total, inboxAlert: inbox.critical } : undefined,
      }),
    [plane, mustSelectCompany, packs, hasPermissionData, canView, context, inbox],
  );

  // ── Chip ────────────────────────────────────────────────────────────────────
  const period = clientCtx && clientCtx.id === activeCompanyId ? clientCtx : null;
  const periodLabel = period ? `${monthName(period.month) ?? ''} ${PERIOD_WORD[period.periodStatus]}`.trim() : null;
  const chip =
    view === 'client'
      ? {
          name: activeCompany?.name ?? 'Loading client…',
          meta: [activeCompany?.shortCode, periodLabel].filter(Boolean).join(' · ') || undefined,
          pip: period ? PERIOD_PIP[period.periodStatus] : ('track' as PipKind),
          tag: own ? { kind: 'own' as const } : undefined,
        }
      : view === 'consolidated'
        ? { name: org, meta: `Consolidated · ${n} ${n === 1 ? 'client' : 'clients'}`, icon: 'layers' as const, tag: { kind: 'ro' as const } }
        : view === 'practice'
          ? { name: org, meta: PLANES.practice.label, icon: 'users' as const }
          : view === 'platform'
            ? { name: 'Merit Platform', meta: PLANES.platform.tagline, icon: 'grid' as const }
            : { name: org, meta: `All clients · ${n}`, icon: 'grid' as const };

  // ── Switcher ────────────────────────────────────────────────────────────────
  // Triage data for the rows (pip + open count): read once when the switcher
  // opens, then reused for a minute.
  useEffect(() => {
    if (!switcherOpen) return;
    setRecents(readRecents());
    if (board && Date.now() - board.at < 60_000) return;
    let alive = true;
    void getWorkboard()
      .then((wb) => {
        if (alive && wb.status === 'ok') setBoard({ at: Date.now(), byId: new Map(wb.companies.map((c) => [c.id, c])) });
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [switcherOpen, board]);

  const clientRow = useCallback(
    (c: { id: string; name: string; shortCode: string }, group: string): SwitcherItem => {
      const b = board?.byId.get(c.id);
      const pip: PipKind = b
        ? b.periodStatus === 'HARD_CLOSE'
          ? 'closed'
          : b.needsAttention > 0
            ? 'risk'
            : b.periodStatus === 'SOFT_CLOSE'
              ? 'soft'
              : 'open'
        : 'track';
      return {
        id: `${group}:${c.id}`,
        label: (
          <>
            {c.name}
            {c.shortCode ? <span className="ink-3"> {c.shortCode}</span> : null}
          </>
        ),
        text: `${c.name} ${c.shortCode}`.toLowerCase(),
        pip,
        right: b ? (
          b.totalOpen > 0 ? (
            <span className="tnum">{b.totalOpen.toLocaleString()} open</span>
          ) : (
            <span>Clear</span>
          )
        ) : undefined,
        sub: b?.isOwnBooks ? 'Own books' : undefined,
        current: view === 'client' && c.id === activeCompanyId,
      };
    },
    [board, view, activeCompanyId],
  );

  const switcherGroups = useMemo<SwitcherGroup[]>(() => {
    const out: SwitcherGroup[] = [];
    const recentRows = recents
      .map((id) => companies.find((c) => c.id === id))
      .filter((c): c is NonNullable<typeof c> => !!c)
      .map((c) => clientRow(c, 'recent'));
    if (recentRows.length > 0 && n > 5) out.push({ id: 'recent', label: 'Recent', items: recentRows });
    out.push({
      id: 'clients',
      label: 'Your clients',
      meta: `${n} · type to filter`,
      items: companies.map((c) => clientRow(c, 'client')),
    });
    const views: SwitcherItem[] = [];
    if (n > 1) {
      views.push({
        id: 'view:consolidated',
        label: `${org}, consolidated`,
        text: `${org} consolidated consolidation eliminations group`.toLowerCase(),
        icon: 'layers',
        iconTone: 'blue',
        sub: `Read-only across ${n} clients · eliminations`,
        current: view === 'consolidated',
      });
    }
    if (available.includes('practice')) {
      views.push({
        id: 'view:practice',
        label: PLANES.practice.label,
        text: 'team settings access roles practice workspace clients'.toLowerCase(),
        icon: 'users',
        sub: PLANES.practice.tagline,
        current: view === 'practice',
      });
    }
    if (available.includes('platform')) {
      views.push({
        id: 'view:platform',
        label: 'Merit Platform',
        text: 'platform operator console tenants',
        icon: 'grid',
        sub: PLANES.platform.tagline,
        current: view === 'platform',
      });
    }
    if (views.length) out.push({ id: 'views', label: 'Views', items: views });
    if (PROJECTS_URL) {
      out.push(
        productsGroup('books', [
          { module: 'books', href: '/dashboard' },
          { module: 'projects', href: PROJECTS_URL },
        ]),
      );
    }
    return out;
  }, [recents, companies, clientRow, n, org, view, available]);

  const lead = useMemo<SwitcherItem>(
    () => ({
      id: 'workspace',
      label: org,
      text: `${org} workspace all clients home`.toLowerCase(),
      icon: 'grid',
      sub: `Workspace · all ${n} ${n === 1 ? 'client' : 'clients'}`,
      current: view === 'all',
    }),
    [org, n, view],
  );

  /** Navigate only when the current page doesn't exist in the target plane's rail. */
  const goIfOutside = useCallback(
    (target: Plane, fallback: string) => {
      const groups = visibleNavGroups({ plane: target, mustSelectCompany: false, packs, hasPermissionData, canView });
      if (!activeHref(groups, pathname)) router.push(fallback);
      else router.refresh();
    },
    [packs, hasPermissionData, canView, pathname, router],
  );

  const onSelect = useCallback(
    (item: SwitcherItem) => {
      if (item.href) {
        if (/^https?:/.test(item.href)) window.location.assign(item.href);
        else router.push(item.href);
        return;
      }
      if (item.current) return;
      if (item.id === 'workspace') {
        setPlane('books');
        setActiveCompany(ALL_COMPANIES);
        if (pathname === '/inbox' || pathname.startsWith('/reports')) router.refresh();
        else router.push('/dashboard');
        toast(`Switched to ${org}, all clients`);
        return;
      }
      if (item.id === 'view:consolidated') {
        setPlane('books');
        setActiveCompany(ALL_COMPANIES);
        router.push('/consolidation');
        return;
      }
      if (item.id === 'view:practice') {
        setPlane('practice');
        goIfOutside('practice', '/team');
        return;
      }
      if (item.id === 'view:platform') {
        setPlane('platform');
        router.push('/platform');
        return;
      }
      const id = item.id.replace(/^(recent|client):/, '');
      const company = companies.find((c) => c.id === id);
      if (!company) return;
      setPlane('books');
      setActiveCompany(id);
      pushRecent(id);
      goIfOutside('books', '/dashboard');
      toast(`Switched to ${company.name}`);
    },
    [router, setPlane, setActiveCompany, pathname, org, companies, goIfOutside],
  );

  // ── Bar & line ──────────────────────────────────────────────────────────────
  const crumbs = pageCrumbs && pageCrumbs.path === pathname ? pageCrumbs.crumbs : crumbsFor(pathname);
  const monthNow = today ? MONTHS[today.getMonth()] : null;
  const defaultLine: ContextLineItem[] = [
    today ? dayDate(today) : '',
    view === 'client'
      ? `${monthName(period?.month) ?? monthNow ?? ''} books${period ? ` · period ${PERIOD_WORD[period.periodStatus]}` : ''}`
      : view === 'consolidated'
        ? `Consolidated · ${n} clients · read-only`
        : view === 'practice'
          ? 'Team, access and settings'
          : view === 'platform'
            ? 'Platform console'
            : `${monthNow ?? ''} · all ${n} ${n === 1 ? 'client' : 'clients'}`,
    inbox
      ? inbox.total > 0
        ? { label: `${inbox.total.toLocaleString()} ${inbox.total === 1 ? 'item needs' : 'items need'} you`, strong: true }
        : 'Inbox clear'
      : '',
  ].filter((x) => x !== '');
  const lineItems = line && line.path === pathname ? line.items : defaultLine;

  const slots = useMemo(
    () => ({
      setLine: (items: ReadonlyArray<ContextLineItem> | null) => setLineState(items ? { path: window.location.pathname, items } : null),
      setCrumbs: (c: ReadonlyArray<Crumb> | null) => setPageCrumbsState(c ? { path: window.location.pathname, crumbs: c } : null),
      openSwitcher: () => setSwitcherOpen(true),
    }),
    [],
  );

  const userName = user ? [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email : null;
  const footEyebrow =
    view === 'client' ? (activeCompany?.name ?? 'Client') : view === 'all' ? 'All clients' : view === 'consolidated' ? 'Consolidated' : PLANES[plane].label;
  const footPeriod =
    view === 'client' && period
      ? { value: monthName(period.month) ?? '', of: PERIOD_WORD[period.periodStatus] }
      : view === 'all' || view === 'consolidated'
        ? { value: `${n} ${n === 1 ? 'client' : 'clients'}`, of: monthNow ?? undefined }
        : undefined;

  return (
    <ShellSlotsProvider value={slots}>
      <AppShell
        context={context}
        density={density}
        mini={mini}
        rail={
          <Rail
            module="books"
            homeHref="/dashboard"
            mini={mini}
            foot={
              <RailFoot eyebrow={mini ? undefined : footEyebrow} period={mini ? undefined : footPeriod}>
                <div className="rail-user">
                  <UserButton appearance={{ elements: { avatarBox: { width: 32, height: 32, borderRadius: 0 } } }} />
                  {!mini && (
                    <span>
                      {userName ?? 'Signed in'}
                      {user?.roleLabel ? <small>{user.roleLabel}</small> : null}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  className="mb-rail-toggle"
                  onClick={toggleMini}
                  aria-label={mini ? 'Expand the rail' : 'Collapse the rail'}
                  aria-pressed={mini}
                  aria-keyshortcuts="["
                  title={mini ? 'Expand the rail ([)' : 'Collapse the rail ([)'}
                >
                  <Icon name={mini ? 'right' : 'left'} />
                  {!mini && <span>Collapse</span>}
                  {!mini && <ChordCaps chord="[" />}
                </button>
              </RailFoot>
            }
          >
            <RailNav groups={railGroups} pathname={pathname} />
            {mustSelectCompany && !mini && (
              <div className="mb-rail-note" role="note">
                <div className="eyebrow">Pick a client</div>
                <p>Work happens in one client at a time, so nothing posts to the wrong books.</p>
                <button type="button" className="btn btn--dark" onClick={() => setSwitcherOpen(true)}>
                  Choose a client <ChordCaps chord="mod+j" />
                </button>
              </div>
            )}
          </Rail>
        }
        bar={
          <Bar>
            <ContextChip
              ref={chipRef}
              name={chip.name}
              meta={chip.meta}
              pip={'pip' in chip ? chip.pip : undefined}
              icon={'icon' in chip ? chip.icon : undefined}
              tag={'tag' in chip ? chip.tag : undefined}
              expanded={switcherOpen}
              onOpen={() => setSwitcherOpen((o) => !o)}
            />
            <Crumbs items={crumbs} />
            <CmdkTrigger label="Ask CPA Desk or jump to a page…" onOpen={() => openCommandBar()} bindChord={false} />
            <button type="button" className="btn btn--dark mb-bar-search" onClick={() => setSearchOpen(true)} aria-keyshortcuts="Meta+/ Control+/" aria-label="Search everything">
              <Icon name="search" />
              <span>Search</span>
              <ChordCaps chord="mod+/" />
            </button>
            <SyncStatus>{loadedAt ? `Loaded ${loadedAt}` : 'Loading…'}</SyncStatus>
          </Bar>
        }
      >
        <ContextLine
          items={lineItems}
          actions={view === 'consolidated' ? <Tag>Read-only</Tag> : undefined}
        />
        <Page>
          <ErrorBoundary label="page">{children}</ErrorBoundary>
        </Page>
      </AppShell>

      <ContextSwitcher
        open={switcherOpen}
        onClose={() => setSwitcherOpen(false)}
        anchorRef={chipRef}
        lead={lead}
        groups={switcherGroups}
        onSelect={onSelect}
        placeholder="Find a client by name or code"
        footNote="Keeps you on this page when it can"
      />

      {/* Still legacy-styled overlays: bridged so they read as Merit on every page. */}
      <LegacyIsland>
        <SearchPalette open={searchOpen} onClose={() => setSearchOpen(false)} />
        <CommandBar />
      </LegacyIsland>
      <HelpButtonFloating />
      <ToastContainer />
    </ShellSlotsProvider>
  );
}

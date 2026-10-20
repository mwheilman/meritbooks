'use client';

import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { UserButton } from '@clerk/nextjs';
import {
  AppShell, Bar, CmdkTrigger, ContextChip, ContextSwitcher, Crumbs, Rail, RailFoot, RailNav, SyncStatus, Tag,
  api, productsGroup, toast,
  type Crumb, type Density, type FilteredNavGroup, type ShellContext, type SwitcherGroup, type SwitcherItem,
} from '@meritbooks/merit-ui';
import type { Vocabulary } from '@/lib/pm/vocab';
import { CommandPalette } from './CommandPalette';
import { crumbsFor } from './crumbs';
import { ShellProvider, useLoadedAt, type ShellCompany } from './ShellContext';

export interface AppFrameProps {
  context: ShellContext;
  density: Density;
  nav: FilteredNavGroup[];
  orgName: string;
  companies: ShellCompany[];
  activeCompanyId: string | null;
  view: 'company' | 'workspace' | 'consolidated';
  user: { name: string; role: string };
  week: { label: string; range: string };
  booksUrl: string;
  vocab: Vocabulary;
  readOnly: boolean;
  children: ReactNode;
}

export function AppFrame(p: AppFrameProps) {
  const router = useRouter();
  const pathname = usePathname() ?? '/';
  const chipRef = useRef<HTMLButtonElement>(null);
  const cmdkRef = useRef<HTMLSpanElement>(null);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [pageCrumbs, setPageCrumbs] = useState<ReadonlyArray<Crumb> | null>(null);
  const loadedAt = useLoadedAt(pathname);

  const active = p.companies.find((c) => c.id === p.activeCompanyId) ?? null;
  const installed = p.companies.filter((c) => c.installed);

  const lead: SwitcherItem = {
    id: 'workspace',
    label: p.orgName,
    text: `${p.orgName} workspace all companies`.toLowerCase(),
    icon: 'grid',
    sub: `Workspace · all ${p.companies.length} ${p.companies.length === 1 ? 'company' : 'companies'}`,
    current: p.view === 'workspace',
  };

  const groups = useMemo<SwitcherGroup[]>(() => {
    const out: SwitcherGroup[] = [
      {
        id: 'companies',
        label: 'Companies',
        meta: String(p.companies.length),
        items: p.companies.map((c) => ({
          id: c.id,
          label: (
            <>
              {c.name}
              {c.shortCode ? <span className="ink-3"> {c.shortCode}</span> : null}
            </>
          ),
          text: `${c.name} ${c.shortCode ?? ''}`.toLowerCase(),
          pip: c.installed ? 'track' : 'soft',
          right: c.installed ? undefined : <Tag tone="warn">Set up</Tag>,
          current: c.id === p.activeCompanyId,
        })),
      },
    ];
    if (installed.length > 1) {
      out.push({
        id: 'consolidated',
        label: 'Consolidated',
        items: [
          {
            id: 'consolidated',
            label: `${p.orgName}, consolidated`,
            text: `${p.orgName} consolidated roll-up`.toLowerCase(),
            icon: 'layers',
            iconTone: 'blue',
            sub: `Read-only roll-up of ${installed.length} companies`,
            current: p.view === 'consolidated',
          },
        ],
      });
    }
    out.push(productsGroup('projects', [
      { module: 'books', href: p.booksUrl },
      { module: 'projects', href: '/' },
    ]));
    return out;
  }, [p.companies, p.activeCompanyId, p.view, p.orgName, p.booksUrl, installed.length]);

  const onSelect = useCallback(
    async (item: SwitcherItem) => {
      if (item.href) {
        if (/^https?:/.test(item.href)) window.location.assign(item.href);
        else router.push(item.href);
        return;
      }
      if (item.current) return;
      const res = await api.post<{ ok: true; label: string }>('/api/context', { target: item.id });
      if (res.error) {
        toast.error(res.error.error);
        return;
      }
      toast(`Switched to ${res.data?.label ?? 'the workspace'}`);
      router.refresh();
    },
    [router],
  );

  const navigate = useCallback((href: string) => router.push(href), [router]);

  const chip =
    p.view === 'company' && active
      ? { name: active.name, meta: active.shortCode ?? undefined, pip: 'track' as const }
      : p.view === 'consolidated'
        ? { name: p.orgName, meta: 'Consolidated', icon: 'layers' as const, tag: { kind: 'ro' as const } }
        : { name: p.orgName, meta: 'Workspace', icon: 'grid' as const };

  const crumbs = pageCrumbs ?? crumbsFor(pathname, p.vocab);
  const shellValue = useMemo(
    () => ({ vocab: p.vocab, companies: p.companies, activeCompanyId: p.activeCompanyId, readOnly: p.readOnly, setCrumbs: setPageCrumbs }),
    [p.vocab, p.companies, p.activeCompanyId, p.readOnly],
  );

  return (
    <ShellProvider value={shellValue}>
      <AppShell
        context={p.context}
        density={p.density}
        rail={
          <Rail
            module="projects"
            foot={
              <RailFoot eyebrow="This week" period={{ value: p.week.label, of: p.week.range }}>
                <div className="rail-user">
                  <UserButton appearance={{ elements: { avatarBox: { width: 32, height: 32, borderRadius: 0 } } }} />
                  <span>
                    {p.user.name}
                    <small>{p.user.role}</small>
                  </span>
                </div>
              </RailFoot>
            }
          >
            <RailNav groups={p.nav} pathname={pathname} />
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
            <span ref={cmdkRef} style={{ marginLeft: 'auto', display: 'flex' }}>
              <CmdkTrigger label={`Jump to ${p.vocab.job.toLowerCase()}, customer, page…`} onOpen={() => setPaletteOpen((o) => !o)} />
            </span>
            <SyncStatus>{loadedAt ? `Loaded ${loadedAt}` : 'Loading…'}</SyncStatus>
          </Bar>
        }
      >
        {p.children}
      </AppShell>
      <ContextSwitcher
        open={switcherOpen}
        onClose={() => setSwitcherOpen(false)}
        anchorRef={chipRef}
        lead={lead}
        groups={groups}
        onSelect={(it) => void onSelect(it)}
        footNote="Keeps you on this page"
      />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        anchorRef={cmdkRef}
        nav={p.nav}
        jobsLabel={p.vocab.jobs}
        onNavigate={navigate}
      />
    </ShellProvider>
  );
}

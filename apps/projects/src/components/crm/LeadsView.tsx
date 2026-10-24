'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  Button, Field, Input, Keybar, QueueTable, Search, Seg, Select, Status, WidgetState, count, money, shortDate, type QueueColumn, type StatusKind,
} from '@meritbooks/merit-ui';
import type { Pipeline } from '@/lib/crm/types';
import { durationWords } from '@/lib/crm/stages';
import {
  DEFAULT_FILTER, PRESET_FILTERS, applyFilter, filterParams, parseFilter, parseSaved, sameFilter, sourcesIn,
  type LeadFilter, type LeadView, type SavedFilter,
} from '@/lib/crm/view';
import { LeadBoard, movable } from './LeadBoard';
import { MoveDialog } from './MoveDialog';
import { NewLeadPanel, type CompanyOption, type OwnerChoice } from './NewLeadPanel';
import { useMoveLead } from './useMoveLead';
import './crm.css';

export type LeadsMode = 'board' | 'list';

export interface LeadsViewProps {
  leads: LeadView[];
  /** The board's pipeline (the company's default); null in a multi-company view → list only. */
  pipeline: Pipeline | null;
  pipelines: ReadonlyArray<Pipeline>;
  me: string | null;
  canCreate: boolean;
  canEdit: boolean;
  showMoney: boolean;
  companies: ReadonlyArray<CompanyOption>;
  defaultCompanyId: string | null;
  owners: ReadonlyArray<OwnerChoice>;
  readOnly: boolean;
}

const SAVED_KEY = 'mp.leads.saved-filters';
const MODE_KEY = 'mp.leads.mode';

function speedKind(t: string): StatusKind {
  return t === 'ready' ? 'ready' : t === 'track' ? 'track' : t === 'risk' ? 'risk' : 'overdue';
}

/**
 * Leads (BP-39): the board for the company's default pipeline and a list with saved filters.
 * Filters live in the URL (shareable); the viewer's own saved filters in this browser.
 */
export function LeadsView({ leads: initial, pipeline, pipelines, me, canCreate, canEdit, showMoney, companies, defaultCompanyId, owners, readOnly }: LeadsViewProps) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [leads, setLeads] = useState(initial);
  useEffect(() => setLeads(initial), [initial]);
  const [mode, setMode] = useState<LeadsMode>(pipeline && sp.get('view') !== 'list' ? 'board' : 'list');
  const [filter, setFilter] = useState<LeadFilter>(() => parseFilter(sp));
  const [saved, setSaved] = useState<SavedFilter[]>([]);
  const [adding, setAdding] = useState(sp.get('new') === '1');

  useEffect(() => {
    try {
      setSaved(parseSaved(window.localStorage.getItem(SAVED_KEY)));
      const m = window.localStorage.getItem(MODE_KEY);
      if (pipeline && !sp.get('view') && (m === 'board' || m === 'list')) setMode(m);
    } catch {
      /* storage blocked: presets only */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const writeUrl = useCallback((f: LeadFilter, m: LeadsMode) => {
    const p = new URLSearchParams(filterParams(f));
    if (m === 'list' && pipeline) p.set('view', 'list');
    const co = sp.get('company');
    if (co) p.set('company', co);
    const qs = p.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [pathname, router, sp, pipeline]);

  const choose = (f: LeadFilter) => {
    setFilter(f);
    writeUrl(f, mode);
  };
  const setModeAndSave = (m: LeadsMode) => {
    setMode(m);
    writeUrl(filter, m);
    try { window.localStorage.setItem(MODE_KEY, m); } catch { /* ignore */ }
  };
  const persist = (list: SavedFilter[]) => {
    setSaved(list);
    try { window.localStorage.setItem(SAVED_KEY, JSON.stringify(list)); } catch { /* ignore */ }
  };
  const [naming, setNaming] = useState<string | null>(null);
  const saveCurrent = () => {
    const label = (naming ?? '').trim();
    if (!label) return;
    persist([...saved.filter((s) => !sameFilter(s.filter, filter)), { id: `f${Date.now()}`, label: label.slice(0, 60), filter }]);
    setNaming(null);
  };

  const onMoved = useCallback((leadId: string, stageId: string) => {
    const st = pipelines.flatMap((p) => p.stages).find((s) => s.id === stageId);
    setLeads((ls) => ls.map((l) => (l.id === leadId && st ? { ...l, stageId, stageName: st.name, stageKind: st.kind, daysInStage: 0 } : l)));
  }, [pipelines]);
  // after a move settles, take the server's view (stage history, days in stage)
  const refresh = useCallback(() => router.refresh(), [router]);
  const mover = useMoveLead(pipeline?.stages ?? pipelines.flatMap((p) => p.stages), onMoved, refresh);

  const shown = useMemo(() => {
    const base = mode === 'board' && pipeline ? leads.filter((l) => l.pipelineId === pipeline.id) : leads;
    // the board shows every stage; its state filter is "all"
    return applyFilter(base, mode === 'board' ? { ...filter, state: 'all' } : filter, me);
  }, [leads, filter, mode, pipeline, me]);
  const sources = useMemo(() => sourcesIn(leads), [leads]);
  const allFilters = [...PRESET_FILTERS, ...saved];
  const active = allFilters.find((s) => sameFilter(s.filter, filter)) ?? null;

  const columns: QueueColumn<LeadView>[] = [
    { id: 'lead', header: 'Lead', cell: (l) => <><span className="l1">{l.title}</span><span className="l2">{[l.customerName ?? l.contactName, l.site, l.company].filter(Boolean).join(' · ') || 'No customer yet'}</span></> },
    { id: 'stage', header: 'Stage', width: 168, cell: (l) => <><span className="l1">{l.stageName}</span><span className="l2">{l.stageKind === 'open' ? `${l.daysInStage}d in stage` : l.closedAt ? shortDate(l.closedAt) : ''}</span></> },
    { id: 'src', header: 'Source', width: 160, cell: (l) => <span className="l2">{l.sourceLabel}{l.campaign ? ` · ${l.campaign}` : ''}</span> },
    { id: 'owner', header: 'Owner', width: 128, cell: (l) => <span className="l2">{l.ownerName ?? 'Unassigned'}</span> },
    ...(showMoney ? [{ id: 'val', header: 'Value', numeric: true, width: 112, cell: (l: LeadView) => (l.amountCents != null ? money(l.amountCents, { decimals: 0 }) : '—') }] : []),
    {
      id: 'speed', header: 'Speed to lead', width: 176,
      cell: (l) => (l.speed ? <Status kind={speedKind(l.speed.tone)}>{l.speed.state === 'waiting' ? `Waiting ${durationWords(l.speed.minutes)}` : `Answered in ${durationWords(l.speed.minutes)}`}</Status> : <span className="l2">—</span>),
    },
    {
      id: 'next', header: 'Next step', width: 184,
      cell: (l) => (l.followupsDue ? <span className={l.followupsOverdue ? 'neg b' : 'b'}>{count(l.followupsDue)} follow-up{l.followupsDue === 1 ? '' : 's'} due</span>
        : l.needsNextStep ? <span className="neg">No next step</span>
          : l.nextStep ? <><span className="l1">{l.nextStep}</span><span className="l2">{l.nextStepOn ? shortDate(l.nextStepOn) : ''}</span></> : <span className="l2">—</span>),
    },
  ];

  const empty = initial.length === 0;
  return (
    <div className="stack">
      <div className="crm-tools">
        <Field label="Search leads">
          <Search slashToFocus value={filter.q} onChange={(e) => choose({ ...filter, q: e.target.value })} placeholder="Name, customer, address, source" aria-label="Search leads" />
        </Field>
        <Field label="Source">
          <Select value={filter.source} onChange={(e) => choose({ ...filter, source: e.target.value })}>
            <option value="">Every source</option>
            {sources.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </Select>
        </Field>
        <span className="sp" />
        {pipeline && (
          <Seg<LeadsMode> aria-label="Show leads as" value={mode} onChange={setModeAndSave} items={[{ value: 'board', label: 'Board' }, { value: 'list', label: 'List' }]} />
        )}
        {canCreate && !readOnly && <Button variant="primary" chord="n" bindChord={!adding} onClick={() => setAdding(true)}>New lead</Button>}
      </div>

      <div className="crm-filters" role="group" aria-label="Saved filters">
        {allFilters.filter((s) => mode === 'list' || (s.filter.state === 'open')).map((s) => (
          <span key={s.id} style={{ display: 'inline-flex' }}>
            <button type="button" className="crm-filter" aria-pressed={active?.id === s.id} onClick={() => choose(s.filter)}>{s.label}</button>
            {!s.preset && <button type="button" className="crm-filter" aria-label={`Remove saved filter ${s.label}`} onClick={() => persist(saved.filter((x) => x.id !== s.id))}>×</button>}
          </span>
        ))}
        {!active && !sameFilter(filter, DEFAULT_FILTER) && naming === null && <button type="button" className="crm-filter" onClick={() => setNaming(filter.q ? `“${filter.q}”` : '')}>Save this filter</button>}
        {naming !== null && (
          <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
            <Input aria-label="Name this filter" value={naming} maxLength={60} autoFocus placeholder="Name this filter" style={{ width: 200 }}
              onChange={(e) => setNaming(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); saveCurrent(); } if (e.key === 'Escape') { e.stopPropagation(); setNaming(null); } }} />
            <Button onClick={saveCurrent} disabled={!naming.trim()}>Save</Button>
            <Button variant="quiet" onClick={() => setNaming(null)}>Cancel</Button>
          </span>
        )}
      </div>

      {empty ? (
        <div className="surface">
          <WidgetState state={{
            kind: 'empty', title: 'No leads yet',
            body: 'Add the first call or web inquiry with who it is, what they want and how they found you. Each lead keeps a speed-to-lead timer and its follow-ups.',
            action: canCreate && !readOnly ? <Button variant="primary" onClick={() => setAdding(true)}>New lead</Button> : undefined,
          }} />
        </div>
      ) : mode === 'board' && pipeline ? (
        <LeadBoard pipeline={pipeline} leads={shown} canEdit={canEdit && !readOnly} showMoney={showMoney} onMove={mover.request} />
      ) : (
        <div className="mp-table">
          {shown.length === 0 ? (
            <WidgetState state={{ kind: 'done', title: 'No lead matches this filter', body: 'Clear the search or pick another saved filter.', action: <Button onClick={() => choose(DEFAULT_FILTER)}>Show all open leads</Button> }} />
          ) : (
            <QueueTable aria-label="Leads" columns={columns} rows={shown} getRowId={(l) => l.id} openOnClick onOpen={(l) => router.push(`/leads/${l.id}`)}
              rowState={(l) => ({ attn: (l.speed?.state === 'waiting' && l.speed.tone === 'overdue') || l.followupsOverdue > 0, done: l.stageKind !== 'open' })} />
          )}
        </div>
      )}
      {!empty && (
        <Keybar
          hints={mode === 'board' ? [{ chord: 'alt+right', label: 'next stage' }, { chord: 'alt+left', label: 'previous stage' }, { chord: 'enter', label: 'open' }, { chord: '/', label: 'search' }] : [{ chord: 'j k', label: 'move' }, { chord: 'enter', label: 'open' }, { chord: '/', label: 'search' }]}
          note={`${count(shown.length)} of ${count(mode === 'board' && pipeline ? leads.filter((l) => l.pipelineId === pipeline.id).length : leads.length)} leads`}
        />
      )}

      <MoveDialog
        open={!!mover.pending}
        kind={mover.pending?.reason ?? null}
        leadTitle={mover.pending?.lead.title ?? ''}
        stageName={mover.pending?.to.name ?? ''}
        busy={mover.busy}
        onClose={mover.cancel}
        onConfirm={(r) => mover.confirm(r)}
      />
      {canCreate && (
        <NewLeadPanel open={adding} onClose={() => setAdding(false)} companies={companies} defaultCompanyId={defaultCompanyId} owners={owners} me={me} showValue={showMoney} />
      )}
    </div>
  );
}

export { movable };

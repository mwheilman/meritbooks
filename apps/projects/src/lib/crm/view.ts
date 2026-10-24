/**
 * The lead as the board, list and lead page draw it, and the saved filters over it. Pure and
 * client-safe. Money (value, weighted value) is null unless the caller holds
 * projects.contract_value at the lead's company — the server builds it that way, so a masked
 * figure never reaches the browser.
 */
import { sourceLabel, type StageKind } from './types';
import type { Speed } from './stages';

export interface LeadView {
  id: string;
  title: string;
  companyId: string;
  company: string | null;
  pipelineId: string;
  stageId: string;
  stageName: string;
  stageKind: StageKind;
  probability: number;
  customerId: string | null;
  customerName: string | null;
  contactName: string | null;
  site: string | null;
  source: string | null;
  sourceLabel: string;
  campaign: string | null;
  ownerId: string | null;
  ownerName: string | null;
  /** Null when masked or unknown. */
  amountCents: number | null;
  nextStep: string | null;
  nextStepOn: string | null;
  expectedCloseOn: string | null;
  daysInStage: number;
  speed: Speed | null;
  followupsDue: number;
  followupsOverdue: number;
  needsNextStep: boolean;
  lostReason: string | null;
  convertedJobId: string | null;
  convertedEstimateId: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export function weightedOf(l: Pick<LeadView, 'amountCents' | 'probability'>): number | null {
  return l.amountCents == null ? null : Math.round(l.amountCents * l.probability);
}

// ------------------------------------------------------------------ filters

export type OwnerFilter = 'all' | 'me' | 'none';
export type StateFilter = 'open' | 'won' | 'lost' | 'all';
export type FlagFilter = 'none' | 'untouched' | 'followups' | 'no_next_step';

export interface LeadFilter {
  q: string;
  owner: OwnerFilter;
  state: StateFilter;
  source: string;
  flag: FlagFilter;
}

export const DEFAULT_FILTER: LeadFilter = { q: '', owner: 'all', state: 'open', source: '', flag: 'none' };

export interface SavedFilter {
  id: string;
  label: string;
  filter: LeadFilter;
  /** Built in (not removable). */
  preset?: boolean;
}

export const PRESET_FILTERS: ReadonlyArray<SavedFilter> = [
  { id: 'open', label: 'All open leads', filter: DEFAULT_FILTER, preset: true },
  { id: 'mine', label: 'My open leads', filter: { ...DEFAULT_FILTER, owner: 'me' }, preset: true },
  { id: 'untouched', label: 'Waiting for a first touch', filter: { ...DEFAULT_FILTER, flag: 'untouched' }, preset: true },
  { id: 'followups', label: 'Follow-ups due', filter: { ...DEFAULT_FILTER, flag: 'followups' }, preset: true },
  { id: 'no_next_step', label: 'No next step', filter: { ...DEFAULT_FILTER, flag: 'no_next_step' }, preset: true },
  { id: 'unassigned', label: 'Unassigned', filter: { ...DEFAULT_FILTER, owner: 'none' }, preset: true },
  { id: 'won', label: 'Won', filter: { ...DEFAULT_FILTER, state: 'won' }, preset: true },
  { id: 'lost', label: 'Lost', filter: { ...DEFAULT_FILTER, state: 'lost' }, preset: true },
];

const OWNERS: ReadonlyArray<OwnerFilter> = ['all', 'me', 'none'];
const STATES: ReadonlyArray<StateFilter> = ['open', 'won', 'lost', 'all'];
const FLAGS: ReadonlyArray<FlagFilter> = ['none', 'untouched', 'followups', 'no_next_step'];

function pick<T extends string>(v: string | null | undefined, list: ReadonlyArray<T>, d: T): T {
  return list.includes(v as T) ? (v as T) : d;
}

/** From the URL (?q=&owner=&state=&source=&flag=), unknown values → defaults. */
export function parseFilter(p: { get(k: string): string | null }): LeadFilter {
  return {
    q: (p.get('q') ?? '').slice(0, 80),
    owner: pick(p.get('owner'), OWNERS, 'all'),
    state: pick(p.get('state'), STATES, 'open'),
    source: (p.get('source') ?? '').slice(0, 40),
    flag: pick(p.get('flag'), FLAGS, 'none'),
  };
}

/** To URL params, defaults left out. */
export function filterParams(f: LeadFilter): Record<string, string> {
  const out: Record<string, string> = {};
  if (f.q) out.q = f.q;
  if (f.owner !== 'all') out.owner = f.owner;
  if (f.state !== 'open') out.state = f.state;
  if (f.source) out.source = f.source;
  if (f.flag !== 'none') out.flag = f.flag;
  return out;
}

export function sameFilter(a: LeadFilter, b: LeadFilter): boolean {
  return a.q === b.q && a.owner === b.owner && a.state === b.state && a.source === b.source && a.flag === b.flag;
}

function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function applyFilter(rows: ReadonlyArray<LeadView>, f: LeadFilter, me: string | null): LeadView[] {
  const q = norm(f.q);
  return rows.filter((l) => {
    if (f.state !== 'all' && l.stageKind !== f.state) return false;
    if (f.owner === 'me' && (!me || l.ownerId !== me)) return false;
    if (f.owner === 'none' && l.ownerId) return false;
    if (f.source && l.source !== f.source) return false;
    if (f.flag === 'untouched' && !(l.speed?.state === 'waiting')) return false;
    if (f.flag === 'followups' && l.followupsDue === 0) return false;
    if (f.flag === 'no_next_step' && !l.needsNextStep) return false;
    if (q) {
      const hay = norm([l.title, l.customerName, l.contactName, l.site, l.sourceLabel, l.campaign, l.ownerName].filter(Boolean).join(' '));
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/** Sources that occur in the rows, for the source picker. */
export function sourcesIn(rows: ReadonlyArray<LeadView>): Array<{ key: string; label: string }> {
  const seen = new Map<string, string>();
  for (const r of rows) if (r.source && !seen.has(r.source)) seen.set(r.source, sourceLabel(r.source));
  return [...seen].map(([key, label]) => ({ key, label })).sort((a, b) => a.label.localeCompare(b.label));
}

/** Saved filters a viewer added (localStorage, a per-viewer convenience): validated on read. */
export function parseSaved(raw: string | null): SavedFilter[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.flatMap((x): SavedFilter[] => {
      if (typeof x !== 'object' || x === null) return [];
      const o = x as { id?: unknown; label?: unknown; filter?: unknown };
      if (typeof o.id !== 'string' || typeof o.label !== 'string' || typeof o.filter !== 'object' || o.filter === null) return [];
      const fo = o.filter as Record<string, unknown>;
      const filter = parseFilter({ get: (k) => (typeof fo[k] === 'string' ? (fo[k] as string) : null) });
      return [{ id: o.id.slice(0, 40), label: o.label.slice(0, 60), filter }];
    }).slice(0, 20);
  } catch {
    return [];
  }
}

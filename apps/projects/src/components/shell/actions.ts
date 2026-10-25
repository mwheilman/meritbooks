/**
 * The ⌘K action registry (UX seat §3f: "every action in the app is registered"). Pure: the palette
 * asks for the actions the caller may take here, in the company's words. Each action is a link
 * to the screen that does it (a create form opened by ?new=1, or a job tab), so it never does
 * work the page guard and RLS have not checked.
 */
import type { Vocabulary } from '@/lib/pm/vocab';
import { lower } from '@/lib/pm/vocab';

export interface PaletteAction {
  id: string;
  label: string;
  /** Extra words that match ("create", "add", "co"). */
  keywords: string;
  href: string;
  /** Go-to chord or hotkey shown beside it. */
  keys?: string;
  /** Only on a job page. */
  jobScoped?: boolean;
}

interface Def {
  id: string;
  label: (v: Vocabulary) => string;
  keywords: string;
  href: (jobId: string | null) => string;
  /** Any of these grants (projects.cap:action). */
  any: ReadonlyArray<string>;
  keys?: string;
  job?: boolean;
}

const DEFS: ReadonlyArray<Def> = [
  // ---- create (c)
  { id: 'new-job', label: (v) => `New ${lower(v.job)}`, keywords: 'create add job project order', href: () => '/jobs?new=1', any: ['projects.jobs:create'] },
  { id: 'new-lead', label: () => 'New lead', keywords: 'create add call inquiry prospect', href: () => '/leads?new=1', any: ['projects.leads:create'] },
  { id: 'new-wo', label: (v) => `New ${lower(v.work_order)}`, keywords: 'create add work order visit service call dispatch', href: () => '/work-orders?new=1', any: ['projects.dispatch:edit', 'projects.production:create'] },
  { id: 'new-deal', label: () => 'New deal', keywords: 'create add sale unit', href: () => '/deals?new=1', any: ['projects.store:create'] },
  { id: 'receive-stock', label: () => 'Receive stock', keywords: 'unit inventory receive', href: () => '/stock?new=1', any: ['projects.store:create'] },
  // ---- on this job
  { id: 'job-co', label: (v) => `New ${lower(v.change_order)} on this ${lower(v.job)}`, keywords: 'create change order co change event', href: (j) => `/jobs/${j}?tab=change-orders`, any: ['projects.change_orders:create'], job: true },
  { id: 'job-bill', label: (v) => `Request ${lower(v.billing)} on this ${lower(v.job)}`, keywords: 'invoice bill pay app deposit', href: (j) => `/jobs/${j}?tab=billing`, any: ['projects.billing:create'], job: true },
  { id: 'job-po', label: (v) => `New ${lower(v.commitment)} on this ${lower(v.job)}`, keywords: 'purchase order subcontract commitment po', href: (j) => `/jobs/${j}?tab=commitments`, any: ['projects.commitments:create'], job: true },
  { id: 'job-schedule', label: (v) => `Open this ${lower(v.job)}'s schedule`, keywords: 'gantt tasks schedule', href: (j) => `/jobs/${j}?tab=schedule`, any: ['projects.jobs:view'], job: true },
  { id: 'job-log', label: (v) => `Write a ${lower(v.daily_log)}`, keywords: 'daily log report diary', href: (j) => `/jobs/${j}?tab=logs`, any: ['projects.jobs:edit'], job: true },
  { id: 'job-time', label: () => 'Time on this job', keywords: 'hours clock timesheet', href: (j) => `/jobs/${j}?tab=time`, any: ['projects.time:view', 'projects.time:create'], job: true },
  { id: 'job-team', label: (v) => `People on this ${lower(v.job)}`, keywords: 'team directory crew members', href: (j) => `/jobs/${j}?tab=team`, any: ['projects.jobs:view'], job: true },
  // ---- go
  { id: 'approve', label: () => 'Approve the next item', keywords: 'approvals approve review queue', href: () => '/approvals', any: ['projects.change_orders:approve', 'projects.billing:approve', 'projects.commitments:approve', 'projects.estimates:approve', 'projects.time:approve', 'projects.selections:approve'], keys: 'g r' },
  { id: 'inbox', label: () => 'Open my inbox', keywords: 'notifications mentions messages', href: () => '/inbox', any: [] },
  { id: 'my-time', label: () => 'My time', keywords: 'clock in timesheet hours', href: () => '/time', any: ['projects.time:create', 'projects.time:view'], keys: 'g t' },
  { id: 'team', label: () => 'Team and roles', keywords: 'people roles invite preview', href: () => '/settings?area=team', any: ['projects.settings:view'] },
];

export interface ActionContext {
  grants: ReadonlyArray<string>;
  vocab: Vocabulary;
  /** Set on a job page. */
  jobId: string | null;
  readOnly: boolean;
}

const WRITE = /:(create|edit|delete|approve|post|release|configure)$/;

/** Actions this caller may take here (job actions only on a job page; no writes in read-only views). */
export function paletteActions(c: ActionContext): PaletteAction[] {
  const has = (g: string) => c.grants.includes('*') || c.grants.includes(g);
  return DEFS.filter((d) => (d.job ? !!c.jobId : true))
    .filter((d) => d.any.length === 0 || d.any.some(has))
    .filter((d) => !c.readOnly || d.any.length === 0 || d.any.some((g) => !WRITE.test(g) && has(g)))
    .map((d) => ({ id: d.id, label: d.label(c.vocab), keywords: d.keywords, href: d.href(c.jobId), keys: d.keys, jobScoped: d.job }));
}

/** /jobs/<uuid>… → the job id. */
export function jobIdFromPath(pathname: string): string | null {
  const m = /^\/jobs\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#]|$)/i.exec(pathname);
  return m ? m[1]!.toLowerCase() : null;
}

/** Every term in the query appears somewhere in the text (case-insensitive). */
export function matches(text: string, q: string): boolean {
  const hay = text.toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((t) => hay.includes(t));
}

/**
 * Continuous tie-outs (SHARED-RECORDS §6): per job and per company, does Merit Projects agree
 * with Merit Books? Reads pm.v_job_tieout (job_id, check_key, projects_cents, books_cents,
 * diff_cents, status ok|exception|pending, cause, action). Pure and client-safe.
 *
 * Masking: each check's figures belong to a money class — job cost and commitments are cost
 * (projects.financials), billing and deposits are contract amounts (projects.contract_value).
 * Without the class the check still shows its status and the fix, but no figures, and its cause
 * is the plain generic one (the database's cause text may quote dollars). Time, messages and
 * customers carry no money.
 */
import type { MoneyVis } from '@/components/money/visibility';

export type TieoutStatus = 'ok' | 'exception' | 'pending';
export type CheckUnit = 'money' | 'hours' | 'count';

export interface CheckDef {
  key: string;
  label: string;
  money: 'cost' | 'contract' | null;
  unit: CheckUnit;
  /** The cause shown when the figures are masked or the database gave none. */
  cause: string;
  order: number;
}

export const CHECKS: ReadonlyArray<CheckDef> = [
  { key: 'job_cost', label: 'Job cost', money: 'cost', unit: 'money', cause: 'Projects’ cost roll-up and the job’s lines in the Books ledger differ.', order: 1 },
  { key: 'billing', label: 'Billing', money: 'contract', unit: 'money', cause: 'A billing request has no invoice in Books yet, or the amounts differ.', order: 2 },
  { key: 'deposits', label: 'Deposits', money: 'contract', unit: 'money', cause: 'Deposits held in Books don’t equal requested less applied.', order: 3 },
  { key: 'commitments', label: 'Commitments', money: 'cost', unit: 'money', cause: 'Bills matched in Books don’t agree with what was billed against the commitment.', order: 4 },
  { key: 'time', label: 'Time', money: null, unit: 'hours', cause: 'Approved hours and payroll-allocated hours differ after the payroll run.', order: 5 },
  { key: 'events', label: 'Messages to Books', money: null, unit: 'count', cause: 'A message to Books was rejected or has had no answer for over an hour.', order: 6 },
  { key: 'customers', label: 'Customers', money: null, unit: 'count', cause: 'Possible duplicate customers are waiting for review.', order: 7 },
];

const BY_KEY = new Map(CHECKS.map((c) => [c.key, c]));

export function checkDef(key: string): CheckDef {
  return BY_KEY.get(key) ?? { key, label: key.replace(/_/g, ' ').replace(/^./, (m) => m.toUpperCase()), money: null, unit: 'count', cause: 'The two sides disagree.', order: 99 };
}

export interface TieoutRow {
  jobId: string;
  checkKey: string;
  projects: number | null;
  books: number | null;
  diff: number | null;
  status: TieoutStatus;
  cause: string | null;
  action: string | null;
  asOf: string | null;
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

export type TieoutLoad =
  | { kind: 'ready'; rows: TieoutRow[] }
  | { kind: 'not_live' }
  | { kind: 'error'; message: string };

export function parseTieout(data: unknown): TieoutRow[] {
  if (!Array.isArray(data)) return [];
  return data.flatMap((r): TieoutRow[] => {
    if (typeof r !== 'object' || r === null) return [];
    const o = r as Record<string, unknown>;
    const status = o.status === 'ok' || o.status === 'exception' || o.status === 'pending' ? o.status : null;
    if (typeof o.job_id !== 'string' || typeof o.check_key !== 'string' || !status) return [];
    return [{
      jobId: o.job_id, checkKey: o.check_key, projects: num(o.projects_cents), books: num(o.books_cents), diff: num(o.diff_cents),
      status, cause: str(o.cause), action: str(o.action), asOf: str(o.as_of),
    }];
  });
}

/** May this caller see this check's figures? */
export function seesCheck(def: CheckDef, mv: Pick<MoneyVis, 'cost' | 'contract'>): boolean {
  return def.money === null || (def.money === 'cost' ? mv.cost : mv.contract);
}

/** Figures nulled and cause generalised where the caller lacks the check's money class. */
export function maskTieout(rows: ReadonlyArray<TieoutRow>, mv: Pick<MoneyVis, 'cost' | 'contract'>): TieoutRow[] {
  return rows.map((r) => {
    const def = checkDef(r.checkKey);
    if (seesCheck(def, mv)) return { ...r };
    return { ...r, projects: null, books: null, diff: null, cause: r.status === 'ok' ? null : def.cause };
  });
}

export function diffOf(r: Pick<TieoutRow, 'projects' | 'books' | 'diff'>): number | null {
  if (r.diff != null) return r.diff;
  return r.projects != null && r.books != null ? r.projects - r.books : null;
}

// ------------------------------------------------------------------ fix actions

export interface FixAction {
  label: string;
  href: string;
}

export function fixAction(r: Pick<TieoutRow, 'action' | 'checkKey' | 'jobId'>): FixAction | null {
  const job = `/jobs/${r.jobId}`;
  const a = (r.action ?? '').trim();
  if (a.startsWith('/')) return { label: 'Open', href: a };
  switch (a) {
    case 'resend': return { label: 'Resend to Books', href: `${job}?tab=billing` };
    case 'issue_invoice':
    case 'open_invoice':
    case 'open_billing': return { label: 'Open billing', href: `${job}?tab=billing` };
    case 'apply_deposit':
    case 'open_deposits': return { label: 'Open deposits', href: `${job}?tab=billing` };
    case 'open_bill':
    case 'match_bill':
    case 'open_commitment': return { label: 'Open the bill', href: `${job}?tab=commitments` };
    case 'approve_time': return { label: 'Approve the time', href: `/time?job=${r.jobId}` };
    case 'check_costs':
    case 'open_job_cost': return { label: 'Open job cost', href: `${job}?tab=job-cost` };
    case 'review_duplicates': return { label: 'Review duplicates', href: '/customers/duplicates' };
    case '': break;
    default: return { label: a.replace(/_/g, ' ').replace(/^./, (m) => m.toUpperCase()), href: job };
  }
  const def = checkDef(r.checkKey);
  if (def.key === 'time') return { label: 'Open time', href: `/time?job=${r.jobId}` };
  if (def.key === 'customers') return { label: 'Review duplicates', href: '/customers/duplicates' };
  if (def.key === 'commitments') return { label: 'Open commitments', href: `${job}?tab=commitments` };
  if (def.key === 'job_cost') return { label: 'Open job cost', href: `${job}?tab=job-cost` };
  return { label: 'Open billing', href: `${job}?tab=billing` };
}

// ------------------------------------------------------------------ roll-ups

export interface JobTieSummary {
  status: TieoutStatus;
  exceptions: number;
  pending: number;
  asOf: string | null;
  /** "Ties to Books" · "2 checks differ" · "Checking" · "Not checked yet" */
  headline: string;
}

export function jobSummary(rows: ReadonlyArray<TieoutRow>): JobTieSummary {
  const exceptions = rows.filter((r) => r.status === 'exception').length;
  const pending = rows.filter((r) => r.status === 'pending').length;
  const asOf = rows.map((r) => r.asOf).filter((x): x is string => !!x).sort().pop() ?? null;
  if (!rows.length) return { status: 'pending', exceptions: 0, pending: 0, asOf, headline: 'Not checked yet' };
  if (exceptions) return { status: 'exception', exceptions, pending, asOf, headline: `${exceptions} ${exceptions === 1 ? 'check differs' : 'checks differ'} from Books` };
  if (pending) return { status: 'pending', exceptions, pending, asOf, headline: 'Waiting on Books' };
  return { status: 'ok', exceptions: 0, pending: 0, asOf, headline: 'Ties to Books' };
}

export function sortChecks<R extends Pick<TieoutRow, 'checkKey' | 'status'>>(rows: ReadonlyArray<R>): R[] {
  const rank: Record<TieoutStatus, number> = { exception: 0, pending: 1, ok: 2 };
  return [...rows].sort((a, b) => rank[a.status] - rank[b.status] || checkDef(a.checkKey).order - checkDef(b.checkKey).order);
}

export interface CompanyCheck {
  key: string;
  label: string;
  ok: number;
  exceptions: number;
  pending: number;
  /** Sum of absolute differences on the exceptions; null when masked or not money. */
  diffAbs: number | null;
}

export interface CompanyTie {
  checks: CompanyCheck[];
  /** Exceptions, largest dollar difference first (masked ones after, by check order). */
  exceptions: TieoutRow[];
  jobsChecked: number;
  jobsTied: number;
}

export function companySummary(rows: ReadonlyArray<TieoutRow>): CompanyTie {
  const keys = [...new Set(rows.map((r) => r.checkKey))].sort((a, b) => checkDef(a).order - checkDef(b).order);
  const checks = keys.map((key): CompanyCheck => {
    const rs = rows.filter((r) => r.checkKey === key);
    const ex = rs.filter((r) => r.status === 'exception');
    const def = checkDef(key);
    const diffs = ex.map(diffOf);
    return {
      key, label: def.label, ok: rs.filter((r) => r.status === 'ok').length, exceptions: ex.length, pending: rs.filter((r) => r.status === 'pending').length,
      diffAbs: def.unit === 'money' && diffs.length && diffs.every((d) => d != null) ? diffs.reduce<number>((s, d) => s + Math.abs(d ?? 0), 0) : def.unit === 'money' && !ex.length ? 0 : null,
    };
  });
  const exceptions = rows.filter((r) => r.status === 'exception').sort((a, b) => {
    const da = diffOf(a);
    const dbv = diffOf(b);
    const ma = checkDef(a.checkKey).unit === 'money' && da != null ? Math.abs(da) : -1;
    const mb = checkDef(b.checkKey).unit === 'money' && dbv != null ? Math.abs(dbv) : -1;
    return mb - ma || checkDef(a.checkKey).order - checkDef(b.checkKey).order;
  });
  const jobs = new Set(rows.map((r) => r.jobId));
  const bad = new Set(rows.filter((r) => r.status !== 'ok').map((r) => r.jobId));
  return { checks, exceptions, jobsChecked: jobs.size, jobsTied: [...jobs].filter((j) => !bad.has(j)).length };
}

/** A check's figure as text: dollars, hours (stored ×100) or a count. */
export function figureText(def: CheckDef, v: number | null, money: (cents: number) => string): string {
  if (v == null) return '—';
  if (def.unit === 'money') return money(v);
  if (def.unit === 'hours') return `${(v / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} h`;
  return v.toLocaleString('en-US');
}

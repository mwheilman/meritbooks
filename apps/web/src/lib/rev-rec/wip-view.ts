/**
 * The WIP schedule as the screen / export see it — the response DTO for /api/rev-rec/wip
 * (and the CSV). Adds account labels to the proposed entries and the next scheduled run.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { JournalEntryLineInput } from '@/lib/services/gl-posting';
import type { WipSchedule, WipRunRow } from './wip-run-service';
import type { WipLine, WipTotals, TieOut } from './wip-engine';
import { METHOD_COPY, type CompanyRevRecPolicy } from './policy';
import { neutralizeCell } from '@/lib/access-governance/csv';

export interface WipEntryLineView {
  accountNumber: string;
  accountName: string;
  jobId: string | null;
  jobNumber: string | null;
  debitCents: number;
  creditCents: number;
  memo: string | null;
}

export interface WipEntryView {
  kind: 'ADJUSTMENT' | 'REVERSAL' | 'RECLASS';
  date: string;
  lines: WipEntryLineView[];
  totalCents: number;
}

export interface WipLineView extends Omit<WipLine, 'policy' | 'balances'> {
  methodLabel: string;
  accrueUnderbillings: boolean;
  deferOverbillings: boolean;
  glUnbilledCents: number;
  glDeferredCents: number;
}

export interface WipScheduleView {
  locationId: string;
  company: WipSchedule['company'];
  periodKey: string;
  asOf: string;
  reversalDate: string;
  policy: CompanyRevRecPolicy;
  policyRowExists: boolean;
  lines: WipLineView[];
  totals: WipTotals;
  tieOut: TieOut | null;
  entries: WipEntryView[];
  issues: WipSchedule['entries']['issues'];
  setupIssues: string[];
  accounts: WipSchedule['accounts'];
  period: WipSchedule['period'];
  nextPeriod: WipSchedule['nextPeriod'];
  currentRun: WipRunRow | null;
  priorRun: WipRunRow | null;
  history: WipRunRow[];
  /** When the scheduler next proposes (ISO), or null for ON_DEMAND. */
  nextScheduledRun: string | null;
}

/** Default period: the month just ended (the one being closed), 'YYYY-MM'. */
export function defaultPeriod(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
}

/** 07:00 UTC on the 1st of the month after `now` — the revrec.monthly cron. */
export function nextMonthlyRun(now: Date): string {
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 7, 0, 0));
  const next = now.getTime() < first.getTime() ? first : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 7, 0, 0));
  return next.toISOString();
}

export async function toScheduleView(db: SupabaseClient, orgId: string, s: WipSchedule, now = new Date()): Promise<WipScheduleView> {
  const ids = new Set<string>();
  for (const l of [...s.entries.adjustment, ...s.entries.reclass]) ids.add(l.account_id);
  const labels = new Map<string, { number: string; name: string }>();
  if (ids.size > 0) {
    const { data } = await db.from('accounts').select('id, account_number, name').eq('org_id', orgId).in('id', [...ids]);
    for (const a of (data ?? []) as { id: string; account_number: string; name: string }[]) labels.set(a.id, { number: a.account_number, name: a.name });
  }
  const jobNo = new Map(s.lines.map((l) => [l.jobId, l.jobNumber]));
  const view = (kind: WipEntryView['kind'], date: string, ls: JournalEntryLineInput[]): WipEntryView => ({
    kind,
    date,
    lines: ls.map((l) => ({
      accountNumber: labels.get(l.account_id)?.number ?? '—',
      accountName: labels.get(l.account_id)?.name ?? 'Unknown account',
      jobId: l.job_id ?? null,
      jobNumber: l.job_id ? jobNo.get(l.job_id) ?? null : null,
      debitCents: l.debit_cents,
      creditCents: l.credit_cents,
      memo: l.memo ?? null,
    })),
    totalCents: ls.reduce((sum, l) => sum + l.debit_cents, 0),
  });
  const entries: WipEntryView[] = [];
  if (s.entries.reclass.length) entries.push(view('RECLASS', s.asOf, s.entries.reclass));
  if (s.entries.adjustment.length) {
    entries.push(view('ADJUSTMENT', s.asOf, s.entries.adjustment));
    entries.push(view('REVERSAL', s.reversalDate, s.entries.reversal));
  }

  return {
    locationId: s.locationId,
    company: s.company,
    periodKey: s.periodKey,
    asOf: s.asOf,
    reversalDate: s.reversalDate,
    policy: s.policy,
    policyRowExists: s.policyRowExists,
    lines: s.lines.map(({ policy, balances, ...rest }) => ({
      ...rest,
      methodLabel: METHOD_COPY[rest.method].label,
      accrueUnderbillings: policy.accrueUnderbillings,
      deferOverbillings: policy.deferOverbillings,
      glUnbilledCents: balances.permUnbilledCents + balances.wipUnbilledCents,
      glDeferredCents: balances.permDeferredCents + balances.wipDeferredCents,
    })),
    totals: s.totals,
    tieOut: s.tieOut,
    entries,
    issues: s.entries.issues,
    setupIssues: s.setupIssues,
    accounts: s.accounts,
    period: s.period,
    nextPeriod: s.nextPeriod,
    currentRun: s.currentRun,
    priorRun: s.priorRun,
    history: s.history,
    nextScheduledRun: s.policy.runCadence === 'MONTHLY_AT_CLOSE' ? nextMonthlyRun(now) : null,
  };
}

/**
 * One CSV cell. Text that a spreadsheet would evaluate (first non-blank = + - @, or a leading
 * tab / CR — e.g. a job named "=HYPERLINK(…)") is neutralized with a leading apostrophe
 * (lib/access-governance/csv). Plain numbers — including negatives like "-1250.00" — stay
 * numeric so the export still sums.
 */
export const csvCell = (v: string | number | null | undefined): string => {
  const raw = v == null ? '' : String(v);
  const t = typeof v === 'number' || /^-?\d+(\.\d+)?$/.test(raw) ? raw : neutralizeCell(raw);
  return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};
const dollars = (c: number) => (c / 100).toFixed(2);

/** The WIP schedule as CSV (dollars with 2 decimals; one row per job + a totals row). */
export function scheduleCsv(v: WipScheduleView): string {
  const head = [
    'Job', 'Name', 'Method', 'Contract', 'EAC', 'Cost to date', '% complete', 'Earned', 'Billed', 'Retainage',
    'Underbilled', 'Overbilled', 'Loss provision', 'Est. gross profit', 'Fade/gain vs prior', 'Booked: unbilled', 'Booked: deferred',
    'Booked: loss', 'Note',
  ];
  const rows = v.lines.map((l) => [
    l.jobNumber, l.jobName, l.methodLabel, dollars(l.contractCents), dollars(l.eacCents), dollars(l.costToDateCents),
    (l.pctComplete * 100).toFixed(1), dollars(l.earnedCents), dollars(l.billedCents), dollars(l.retainageCents),
    dollars(l.underCents), dollars(l.overCents), dollars(l.lossProvisionCents), dollars(l.estGrossProfitCents),
    l.fadeGainCents == null ? '' : dollars(l.fadeGainCents), dollars(l.targetUnderCents), dollars(l.targetOverCents), dollars(l.targetLossCents),
    l.excluded ? 'Excluded from WIP' : l.belowMateriality ? 'Below materiality' : '',
  ]);
  const t = v.totals;
  rows.push([
    'TOTAL', `${t.jobs} jobs`, '', dollars(t.contractCents), dollars(t.eacCents), dollars(t.costToDateCents), '',
    dollars(t.earnedCents), dollars(t.billedCents), dollars(t.retainageCents), dollars(t.underCents), dollars(t.overCents),
    dollars(t.lossProvisionCents), '', dollars(t.fadeGainCents), dollars(t.targetUnderCents), dollars(t.targetOverCents), dollars(t.targetLossCents), '',
  ]);
  const meta = [
    [`WIP schedule — ${v.company?.name ?? ''} — ${v.periodKey} (as of ${v.asOf})`],
    v.tieOut
      ? [`Tie-out: Unbilled schedule ${dollars(v.tieOut.unbilled.scheduleCents)} vs GL ${dollars(v.tieOut.unbilled.glJobsCents)} (diff ${dollars(v.tieOut.unbilled.differenceCents)}); Deferred schedule ${dollars(v.tieOut.deferred.scheduleCents)} vs GL ${dollars(v.tieOut.deferred.glJobsCents)} (diff ${dollars(v.tieOut.deferred.differenceCents)})`]
      : ['Tie-out unavailable'],
    [],
  ];
  return [...meta, head, ...rows].map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
}

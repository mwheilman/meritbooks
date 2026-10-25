/**
 * Pure logic behind the commercial screens (Wave C): spec-book parsing, G703 totals and the
 * portal export formats, the retainage ledger both sides, buyout roll-ups, the billing calendar
 * grid, OSHA rates, the workforce board grid, job-cost drill-down grouping, closeout by sub and
 * the letter templates. No I/O; client-safe. Money is integer cents throughout.
 */
import { divisionOf } from './field';

// ------------------------------------------------------------------ specifications (CGC-62)

export const MASTERFORMAT_DIVISIONS: Readonly<Record<string, string>> = {
  '00': 'Procurement and contracting', '01': 'General requirements', '02': 'Existing conditions', '03': 'Concrete', '04': 'Masonry',
  '05': 'Metals', '06': 'Wood, plastics and composites', '07': 'Thermal and moisture protection', '08': 'Openings', '09': 'Finishes',
  '10': 'Specialties', '11': 'Equipment', '12': 'Furnishings', '13': 'Special construction', '14': 'Conveying equipment',
  '21': 'Fire suppression', '22': 'Plumbing', '23': 'HVAC', '25': 'Integrated automation', '26': 'Electrical', '27': 'Communications',
  '28': 'Electronic safety and security', '31': 'Earthwork', '32': 'Exterior improvements', '33': 'Utilities', '34': 'Transportation',
  '35': 'Waterway and marine', '40': 'Process interconnections', '41': 'Material processing and handling', '42': 'Process heating, cooling and drying',
  '43': 'Process gas and liquid handling', '44': 'Pollution and waste control', '46': 'Water and wastewater', '48': 'Electrical power generation',
};

export interface ParsedSection {
  number: string;
  title: string;
  division: string;
  /** true = a MasterFormat number (NN NN NN); false = a project's own numbering. */
  csi: boolean;
}

const CSI6 = /^(?:section\s+)?(\d{2})\s?(\d{2})\s?(\d{2})(?:\.(\d{1,2}))?\s*[-–—:.]?\s+(.+)$/i;
const OTHER = /^(?:section\s+)?([A-Z]{0,3}\d{1,3}(?:[.-]\d{1,3}){0,3})\s*[-–—:]?\s+(.+)$/i;

/**
 * Auto-section a project manual's table of contents: one section per line, MasterFormat
 * numbers normalized to "09 21 16" (or "09 21 16.13"), other numbering kept as written.
 * Page numbers / dot leaders at the end are dropped; duplicates keep the first title.
 */
export function parseSpecToc(text: string): ParsedSection[] {
  const out: ParsedSection[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\.{3,}\s*\d+\s*$/, '').replace(/\s+\d+\s*$/, (m) => (/[a-z]/i.test(raw) ? '' : m)).replace(/\s+/g, ' ').trim();
    if (line.length < 4) continue;
    let sec: ParsedSection | null = null;
    const c = CSI6.exec(line);
    if (c) {
      const number = `${c[1]} ${c[2]} ${c[3]}${c[4] ? `.${c[4].padStart(2, '0')}` : ''}`;
      sec = { number, title: cleanTitle(c[5]!), division: c[1]!, csi: true };
    } else {
      const o = OTHER.exec(line);
      if (o && /[a-z]/i.test(o[2]!)) sec = { number: o[1]!.toUpperCase(), title: cleanTitle(o[2]!), division: divisionOf(o[1]!) || o[1]!.replace(/[^0-9].*$/, '').padStart(2, '0'), csi: false };
    }
    if (!sec || !sec.title || seen.has(sec.number)) continue;
    seen.add(sec.number);
    out.push(sec);
  }
  return out;
}

function cleanTitle(t: string): string {
  const s = t.replace(/\s*[-–—]\s*$/, '').trim();
  // ALL CAPS titles from a spec book read better in sentence case
  if (s.length > 3 && s === s.toUpperCase() && /[A-Z]/.test(s)) return s.charAt(0) + s.slice(1).toLowerCase();
  return s.slice(0, 200);
}

export function divisionName(div: string | null | undefined): string {
  if (!div) return 'Other';
  return MASTERFORMAT_DIVISIONS[div.padStart(2, '0').slice(0, 2)] ?? `Division ${div}`;
}

// ------------------------------------------------------------------ G703 / G702 (CGC-41)

/** A billing_request_lines row as the continuation sheet reads it (null = masked). */
export interface SheetLine {
  id: string;
  line_no: number;
  description: string;
  line_type: string;
  sov_line_id: string | null;
  scheduled_value_cents: number | null;
  previous_work_cents: number | null;
  this_period_work_cents: number | null;
  stored_materials_cents: number | null;
  previous_stored_cents: number | null;
  total_completed_cents: number | null;
  pct_complete: number | null;
  balance_to_finish_cents: number | null;
  retainage_rate: number | null;
  retainage_work_to_date_cents: number | null;
  retainage_stored_to_date_cents: number | null;
  retainage_this_period_cents: number | null;
  /** Set when the line came from an approved change order. */
  change_order?: string | null;
}

export interface SheetTotals {
  scheduled: number;
  previous: number;
  thisPeriod: number;
  stored: number;
  completed: number;
  balance: number;
  retainage: number;
  retainageThisPeriod: number;
  pct: number | null;
}

const n0 = (v: number | null | undefined) => Number(v ?? 0);

/** Column totals for the continuation sheet (C, D, E, F, G, G/C, H, I). STANDARD lines only. */
export function sheetTotals(lines: ReadonlyArray<SheetLine>): SheetTotals {
  const std = lines.filter((l) => l.line_type === 'STANDARD');
  const t = std.reduce((s, l) => ({
    scheduled: s.scheduled + n0(l.scheduled_value_cents),
    previous: s.previous + n0(l.previous_work_cents) + n0(l.previous_stored_cents),
    thisPeriod: s.thisPeriod + n0(l.this_period_work_cents),
    stored: s.stored + n0(l.stored_materials_cents),
    completed: s.completed + n0(l.total_completed_cents),
    balance: s.balance + n0(l.balance_to_finish_cents),
    retainage: s.retainage + n0(l.retainage_work_to_date_cents) + n0(l.retainage_stored_to_date_cents),
    retainageThisPeriod: s.retainageThisPeriod + n0(l.retainage_this_period_cents),
  }), { scheduled: 0, previous: 0, thisPeriod: 0, stored: 0, completed: 0, balance: 0, retainage: 0, retainageThisPeriod: 0 });
  return { ...t, pct: t.scheduled > 0 ? t.completed / t.scheduled : null };
}

/** An edited continuation line, as the revise / draft RPC takes it. */
export interface LineEdit {
  sov_line_id: string;
  pct_complete?: number;
  work_to_date_cents?: number;
  stored_materials_cents?: number;
}

/**
 * The edits to send for a revision: one per changed line, in the shape pm.generate_sov_billing
 * reads (work to date, never "this period", so a resubmit is idempotent). Unchanged lines are
 * left out — the RPC carries them forward.
 */
export function lineEdits(lines: ReadonlyArray<SheetLine>, edits: Readonly<Record<string, { workToDate?: number | null; stored?: number | null }>>): LineEdit[] {
  const out: LineEdit[] = [];
  for (const l of lines) {
    const e = edits[l.id];
    if (!e || !l.sov_line_id) continue;
    const curWork = n0(l.previous_work_cents) + n0(l.this_period_work_cents);
    const curStored = n0(l.stored_materials_cents);
    const w = e.workToDate ?? curWork;
    const s = e.stored ?? curStored;
    if (w === curWork && s === curStored) continue;
    out.push({ sov_line_id: l.sov_line_id, work_to_date_cents: w, stored_materials_cents: s });
  }
  return out;
}

export interface LineCheck { id: string; problem: string }

/** The refusals pm.generate_sov_billing would raise, checked before sending. */
export function checkLineEdits(lines: ReadonlyArray<SheetLine>, edits: Readonly<Record<string, { workToDate?: number | null; stored?: number | null }>>): LineCheck[] {
  const out: LineCheck[] = [];
  for (const l of lines) {
    const e = edits[l.id];
    if (!e) continue;
    const w = e.workToDate ?? n0(l.previous_work_cents) + n0(l.this_period_work_cents);
    const s = e.stored ?? n0(l.stored_materials_cents);
    if (w < n0(l.previous_work_cents)) out.push({ id: l.id, problem: `Line ${l.line_no}: work to date cannot drop below what was billed before.` });
    else if (s < 0) out.push({ id: l.id, problem: `Line ${l.line_no}: stored materials cannot be negative.` });
    else if (w + s > n0(l.scheduled_value_cents)) out.push({ id: l.id, problem: `Line ${l.line_no}: completed and stored exceed the scheduled value.` });
  }
  return out;
}

export const PAY_APP_STEPS = [
  { stage: 'PENCIL', label: 'Pencil' },
  { stage: 'PENCIL_SENT', label: 'Pencil sent' },
  { stage: 'CERTIFIED', label: 'Certified' },
  { stage: 'FINAL', label: 'Final' },
] as const;

/** Which step the stepper marks done / current (REVISE sits on "Pencil sent" as blocked). */
export function payAppStep(stage: string | null | undefined): { index: number; blocked: boolean } {
  if (stage === 'REVISE') return { index: 1, blocked: true };
  const i = PAY_APP_STEPS.findIndex((s) => s.stage === stage);
  return { index: i < 0 ? 0 : i, blocked: false };
}

// ------------------------------------------------------------------ custom formats / portal export (CGC-43)

export type ExportFormat = 'AIA_G703' | 'TEXTURA' | 'GCPAY' | 'PROCORE_PAY' | 'GC_FORM';
export const EXPORT_FORMATS: ReadonlyArray<{ value: ExportFormat; label: string; detail: string }> = [
  { value: 'AIA_G703', label: 'G703-style continuation sheet', detail: 'Columns A–I, one row per line, totals last' },
  { value: 'TEXTURA', label: 'Textura import', detail: 'Line, description, scheduled, previous, this period, stored, % complete, retainage' },
  { value: 'GCPAY', label: 'GCPay import', detail: 'Item, description, scheduled value, work this period, materials stored, retention' },
  { value: 'PROCORE_PAY', label: 'Procore Pay import', detail: 'Cost code-style line number, work completed this period, materials presently stored' },
  { value: 'GC_FORM', label: 'GC form (generic)', detail: 'Description, contract value, % complete to date, amount this period' },
];

export interface ExportMeta {
  applicationNo: number | null;
  periodEnd: string | null;
  jobLabel: string;
  revision: number;
}

/**
 * One CSV cell. Text that a spreadsheet would run as a formula (= + - @, or a leading tab / CR)
 * is neutralized with a leading apostrophe (CSV injection, security review L2); plain numbers —
 * including negatives like a deduct alternate — stay numbers. Quotes, commas and line breaks are quoted.
 */
export function csvCell(v: string | number | null): string {
  if (v === null) return '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const dollars = (c: number | null | undefined) => (c == null ? '' : (Number(c) / 100).toFixed(2));
const pct2 = (p: number | null | undefined) => (p == null ? '' : (Number(p) * 100).toFixed(2));

/**
 * The pay application in a portal's import layout (CSV). Money in dollars with two decimals
 * (portals import dollars), percent as 0–100. STANDARD lines only; totals row on the G703 form.
 */
export function exportPayApp(format: ExportFormat, lines: ReadonlyArray<SheetLine>, meta: ExportMeta): { fileName: string; body: string } {
  const std = lines.filter((l) => l.line_type === 'STANDARD');
  const rows: Array<Array<string | number | null>> = [];
  const work = (l: SheetLine) => n0(l.this_period_work_cents);
  const ret = (l: SheetLine) => n0(l.retainage_work_to_date_cents) + n0(l.retainage_stored_to_date_cents);
  switch (format) {
    case 'AIA_G703': {
      rows.push(['A Item', 'B Description of work', 'C Scheduled value', 'D From previous application', 'E This period', 'F Materials presently stored',
        'G Total completed and stored', 'G/C %', 'H Balance to finish', 'I Retainage']);
      for (const l of std) {
        rows.push([l.line_no, l.description, dollars(l.scheduled_value_cents), dollars(n0(l.previous_work_cents) + n0(l.previous_stored_cents)), dollars(work(l)),
          dollars(l.stored_materials_cents), dollars(l.total_completed_cents), pct2(l.pct_complete), dollars(l.balance_to_finish_cents), dollars(ret(l))]);
      }
      const t = sheetTotals(std);
      rows.push(['', 'Totals', dollars(t.scheduled), dollars(t.previous), dollars(t.thisPeriod), dollars(t.stored), dollars(t.completed), pct2(t.pct), dollars(t.balance), dollars(t.retainage)]);
      break;
    }
    case 'TEXTURA':
      rows.push(['Line Number', 'Description', 'Scheduled Value', 'Previous Work Completed', 'Work Completed This Period', 'Materials Stored', 'Percent Complete', 'Retainage']);
      for (const l of std) rows.push([l.line_no, l.description, dollars(l.scheduled_value_cents), dollars(l.previous_work_cents), dollars(work(l)), dollars(l.stored_materials_cents), pct2(l.pct_complete), dollars(ret(l))]);
      break;
    case 'GCPAY':
      rows.push(['Item', 'Description', 'Scheduled Value', 'Work This Period', 'Materials Stored', 'Retention']);
      for (const l of std) rows.push([l.line_no, l.description, dollars(l.scheduled_value_cents), dollars(work(l)), dollars(l.stored_materials_cents), dollars(ret(l))]);
      break;
    case 'PROCORE_PAY':
      rows.push(['Line Item', 'Description', 'Scheduled Value', 'Work Completed This Period', 'Materials Presently Stored', 'Total Completed And Stored To Date', 'Retainage']);
      for (const l of std) rows.push([String(l.line_no).padStart(3, '0'), l.description, dollars(l.scheduled_value_cents), dollars(work(l)), dollars(l.stored_materials_cents), dollars(l.total_completed_cents), dollars(ret(l))]);
      break;
    case 'GC_FORM':
      rows.push(['Description', 'Contract Value', 'Percent Complete To Date', 'Amount This Period']);
      for (const l of std) rows.push([l.description, dollars(l.scheduled_value_cents), pct2(l.pct_complete), dollars(work(l) + n0(l.stored_materials_cents) - n0(l.previous_stored_cents))]);
      break;
  }
  const head = [`# ${meta.jobLabel}`, `# Application ${meta.applicationNo ?? '—'}${meta.revision > 1 ? ` revision ${meta.revision}` : ''}, period ending ${meta.periodEnd ?? '—'}`];
  const slug = meta.jobLabel.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'pay-app';
  return {
    fileName: `${slug}-app-${meta.applicationNo ?? 'x'}${meta.revision > 1 ? `-r${meta.revision}` : ''}-${format.toLowerCase()}.csv`,
    body: [...head, ...rows.map((r) => r.map(csvCell).join(','))].join('\n') + '\n',
  };
}

// ------------------------------------------------------------------ retainage, both sides (CGC-49)

export interface RetainageBothRow {
  job_id: string;
  location_id: string;
  receivable_held_cents: number | null;
  receivable_released_cents: number | null;
  receivable_outstanding_cents: number | null;
  payable_held_cents: number | null;
  payable_released_cents: number | null;
  payable_outstanding_cents: number | null;
  substantial_completion_on: string | null;
  receivable_release_eligible: boolean | null;
}

export interface PayableRetainageRow {
  job_id: string;
  /** The commitment's company (response masking checks money there). */
  location_id?: string;
  commitment_id: string;
  number: string | null;
  vendor_id: string | null;
  held_cents: number | null;
  released_cents: number | null;
  outstanding_cents: number | null;
  final_waiver_verified: boolean | null;
}

export interface RetainageByParty { key: string; label: string; jobs: number; held: number; released: number; outstanding: number; eligible: number }

/** Receivable retainage grouped by who holds it (the owner, or for a sub the GC). */
export function receivableByCustomer(rows: ReadonlyArray<RetainageBothRow>, customerOf: (jobId: string) => { id: string | null; name: string | null }): RetainageByParty[] {
  const m = new Map<string, RetainageByParty>();
  for (const r of rows) {
    const c = customerOf(r.job_id);
    const key = c.id ?? 'none';
    const g = m.get(key) ?? { key, label: c.name ?? 'No customer', jobs: 0, held: 0, released: 0, outstanding: 0, eligible: 0 };
    g.jobs += 1;
    g.held += n0(r.receivable_held_cents);
    g.released += n0(r.receivable_released_cents);
    g.outstanding += n0(r.receivable_outstanding_cents);
    if (r.receivable_release_eligible) g.eligible += n0(r.receivable_outstanding_cents);
    m.set(key, g);
  }
  return [...m.values()].sort((a, b) => b.outstanding - a.outstanding || a.label.localeCompare(b.label));
}

export type PayableReleaseState = 'RELEASED' | 'READY' | 'NEEDS_FINAL_WAIVER' | 'NONE_HELD';

/** Sub release gate: retainage is released to a sub only once their final waiver is verified. */
export function payableReleaseState(r: Pick<PayableRetainageRow, 'held_cents' | 'outstanding_cents' | 'final_waiver_verified'>): PayableReleaseState {
  if (n0(r.held_cents) === 0) return 'NONE_HELD';
  if (n0(r.outstanding_cents) <= 0) return 'RELEASED';
  return r.final_waiver_verified ? 'READY' : 'NEEDS_FINAL_WAIVER';
}

// ------------------------------------------------------------------ buyout (CGC-30)

export interface BuyoutPackage {
  package_id: string;
  job_id: string;
  name: string;
  csi_division: string | null;
  status: string;
  sort: number | null;
  lead_time_days: number | null;
  budget_cents: number | null;
  committed_cents: number | null;
  need_by: string | null;
  days_to_need: number | null;
}

export interface BuyoutSummary {
  packages: number;
  bought: number;
  open: number;
  budget: number;
  committed: number;
  /** Budget of the bought packages minus what they were bought for (positive = savings). */
  savings: number;
  /** Bought budget ÷ total budget (packages marked not needed are left out). */
  pctBought: number | null;
  atRisk: number;
  late: number;
}

const DONE = new Set(['AWARDED', 'NOT_NEEDED']);

/** An unbought package is at risk inside 14 days of its need date, late past it. */
export function buyoutRisk(p: Pick<BuyoutPackage, 'status' | 'days_to_need'>): 'LATE' | 'AT_RISK' | null {
  if (DONE.has(p.status) || p.days_to_need == null) return null;
  if (p.days_to_need < 0) return 'LATE';
  return p.days_to_need <= 14 ? 'AT_RISK' : null;
}

export function buyoutSummary(rows: ReadonlyArray<BuyoutPackage>): BuyoutSummary {
  const live = rows.filter((r) => r.status !== 'NOT_NEEDED');
  const bought = live.filter((r) => r.status === 'AWARDED');
  const budget = live.reduce((s, r) => s + n0(r.budget_cents), 0);
  const boughtBudget = bought.reduce((s, r) => s + n0(r.budget_cents), 0);
  return {
    packages: rows.length,
    bought: bought.length,
    open: live.length - bought.length,
    budget,
    committed: live.reduce((s, r) => s + n0(r.committed_cents), 0),
    savings: boughtBudget - bought.reduce((s, r) => s + n0(r.committed_cents), 0),
    pctBought: budget > 0 ? boughtBudget / budget : null,
    atRisk: rows.filter((r) => buyoutRisk(r) === 'AT_RISK').length,
    late: rows.filter((r) => buyoutRisk(r) === 'LATE').length,
  };
}

// ------------------------------------------------------------------ billing calendar (CGC-102)

export interface CalendarRow {
  job_id: string;
  job_number: string | null;
  job_name: string | null;
  customer_name: string | null;
  billing_form: string;
  billing_portal_url: string | null;
  billing_cutoff_day: number;
  next_cutoff: string;
  pencil_due: string;
  current_status: string | null;
  current_stage: string | null;
  portal_status: string | null;
  retainage_outstanding_cents: number | null;
}

export type CalendarState = 'PAID' | 'APPROVED' | 'SUBMITTED' | 'PENCIL' | 'LATE' | 'DUE_SOON' | 'NOT_STARTED';

/** Where this period's billing stands for one job, in the words a sub's billing clerk uses. */
export function calendarState(r: Pick<CalendarRow, 'current_status' | 'current_stage' | 'portal_status' | 'next_cutoff' | 'pencil_due'>, today: string): CalendarState {
  if (r.portal_status === 'PAID') return 'PAID';
  if (r.current_status === 'ISSUED' || r.current_status === 'UNISSUED' || r.current_stage === 'FINAL' || r.portal_status === 'ACCEPTED') return 'APPROVED';
  if (r.portal_status === 'SUBMITTED' || r.current_stage === 'CERTIFIED' || r.current_stage === 'PENCIL_SENT' || r.current_status === 'EMITTED') return 'SUBMITTED';
  if (r.current_stage === 'PENCIL' || r.current_stage === 'REVISE' || r.current_status === 'DRAFT') return r.next_cutoff < today ? 'LATE' : 'PENCIL';
  if (r.next_cutoff < today) return 'LATE';
  return r.pencil_due <= addDaysIso(today, 3) ? 'DUE_SOON' : 'NOT_STARTED';
}

export interface CalendarDay { date: string; inMonth: boolean; cutoffs: string[]; pencils: string[] }

/** A Monday-first month grid (6 weeks) with each job's cutoff and pencil-due marked. */
export function monthGrid(month: string, rows: ReadonlyArray<Pick<CalendarRow, 'job_id' | 'next_cutoff' | 'pencil_due' | 'billing_cutoff_day'>>): CalendarDay[] {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const first = new Date(Date.UTC(y, m - 1, 1));
  const lead = (first.getUTCDay() + 6) % 7;
  const start = new Date(Date.UTC(y, m - 1, 1 - lead));
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const days: CalendarDay[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getTime() + i * 86_400_000);
    const iso = d.toISOString().slice(0, 10);
    const inMonth = d.getUTCMonth() === m - 1;
    const cutoffs: string[] = [];
    const pencils: string[] = [];
    for (const r of rows) {
      // the cutoff day repeats monthly (clamped to month end); the pencil is due lead days before
      const cut = Math.min(r.billing_cutoff_day, last);
      const lead = Math.max(0, Math.round((Date.parse(`${r.next_cutoff}T00:00:00Z`) - Date.parse(`${r.pencil_due}T00:00:00Z`)) / 86_400_000));
      const cutIso = `${month}-${String(cut).padStart(2, '0')}`;
      if (inMonth && d.getUTCDate() === cut) cutoffs.push(r.job_id);
      if (addDaysIso(cutIso, -lead) === iso) pencils.push(r.job_id);
    }
    days.push({ date: iso, inMonth, cutoffs, pencils });
  }
  return days;
}

export function addDaysIso(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** Monday of the week containing `iso`. */
export function mondayOf(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return addDaysIso(iso, -((d.getUTCDay() + 6) % 7));
}

export function weekStarts(fromIso: string, n: number): string[] {
  const m = mondayOf(fromIso);
  return Array.from({ length: n }, (_, i) => addDaysIso(m, i * 7));
}

// ------------------------------------------------------------------ OSHA (CGC-79)

/** TRIR / DART per 200,000 hours (OSHA's 100 full-time workers), null without hours. */
export function oshaRate(cases: number, hours: number | null | undefined): number | null {
  const h = Number(hours ?? 0);
  return h > 0 ? Math.round((cases * 200000 / h) * 100) / 100 : null;
}

/** Fields of an incident that identify the person or describe the injury (OSHA privacy cases). */
export interface IncidentPrivate {
  privacy_case: boolean;
  person_name: string | null;
  job_title: string | null;
  description: string;
  body_part: string | null;
  injury_nature: string | null;
  object_substance?: string | null;
  witnesses?: unknown[];
  wc_claim_ref?: string | null;
}

/**
 * A privacy case (29 CFR 1904.29(b)(7)) shown to someone who does not manage safety: no name, no
 * job title, no injury detail, no witnesses or claim number (security review L5). Others pass through.
 */
export function redactPrivacyCase<T extends IncidentPrivate>(i: T, mayView: boolean): T {
  if (!i.privacy_case || mayView) return i;
  return {
    ...i, person_name: null, job_title: null, description: 'Privacy case — details are limited to the safety manager.', body_part: null, injury_nature: null,
    ...(Object.hasOwn(i, 'object_substance') ? { object_substance: null } : {}), ...(Object.hasOwn(i, 'witnesses') ? { witnesses: [] } : {}),
    ...(Object.hasOwn(i, 'wc_claim_ref') ? { wc_claim_ref: null } : {}),
  };
}

export interface IncidentFacts {
  incident_type: string;
  is_employee: boolean;
  days_away: number;
  days_restricted: number;
  injury_nature: string | null;
}

/**
 * A starting point for the recordable determination (29 CFR 1904.7), for the safety manager to
 * confirm: days away or restricted work make it recordable with that classification; a near miss
 * or property damage is not an injury case; anything else asks for review.
 */
export function suggestRecordable(i: IncidentFacts): { recordable: boolean | null; classification: string | null; why: string } {
  if (!['INJURY', 'ILLNESS'].includes(i.incident_type)) return { recordable: false, classification: null, why: 'Not an injury or illness — it goes on no OSHA log.' };
  if (!i.is_employee) return { recordable: false, classification: null, why: 'Not our employee — their employer records it.' };
  if (i.days_away > 0) return { recordable: true, classification: 'DAYS_AWAY', why: `${i.days_away} days away from work.` };
  if (i.days_restricted > 0) return { recordable: true, classification: 'RESTRICTED_OR_TRANSFER', why: `${i.days_restricted} days of restricted work or job transfer.` };
  if (/first aid|bandage|ice|wash/i.test(i.injury_nature ?? '')) return { recordable: false, classification: null, why: 'Reads like first aid only — confirm no medical treatment beyond first aid.' };
  return { recordable: null, classification: 'OTHER_RECORDABLE', why: 'Recordable if it needed medical treatment beyond first aid, or a physician diagnosed a significant injury.' };
}

// ------------------------------------------------------------------ workforce board (CGC-92)

export interface Assignment { id: string; job_id: string; employee_id: string; request_id: string | null; role: string; week_start: string; days: number; per_diem: boolean; travel: boolean; status: string }
export interface Employee { id: string; name: string; title: string | null }
export interface BoardCell { assignments: Assignment[]; days: number }
export interface BoardRow { employee: Employee; cells: BoardCell[]; booked: number }

/** People × weeks; days over 5 in a week is a double booking. Released rows are left off. */
export function workforceGrid(employees: ReadonlyArray<Employee>, assignments: ReadonlyArray<Assignment>, weeks: ReadonlyArray<string>): { rows: BoardRow[]; bench: number[] } {
  const live = assignments.filter((a) => a.status !== 'RELEASED');
  const rows = employees.map((e) => {
    const cells = weeks.map((w) => {
      const xs = live.filter((a) => a.employee_id === e.id && a.week_start === w);
      return { assignments: xs, days: xs.reduce((s, a) => s + a.days, 0) };
    });
    return { employee: e, cells, booked: cells.filter((c) => c.days > 0).length };
  }).sort((a, b) => b.booked - a.booked || a.employee.name.localeCompare(b.employee.name));
  const bench = weeks.map((_, i) => rows.filter((r) => r.cells[i]!.days === 0).length);
  return { rows, bench };
}

export interface CrewRequest { id: string; job_id: string; role: string; headcount: number; start_week: string; end_week: string; status: string; trade: string | null }

/** Filled heads per request week (assignments linked to the request, or same job + role that week). */
export function requestFill(req: CrewRequest, assignments: ReadonlyArray<Assignment>, weeks: ReadonlyArray<string>): Array<{ week: string; filled: number; need: number }> {
  return weeks.filter((w) => w >= req.start_week && w <= req.end_week).map((w) => ({
    week: w,
    need: req.headcount,
    filled: assignments.filter((a) => a.status !== 'RELEASED' && a.week_start === w && (a.request_id === req.id || (a.request_id == null && a.job_id === req.job_id && a.role === req.role))).length,
  }));
}

// ------------------------------------------------------------------ job cost drill-down (CGC-55)

export interface CostDetailRow {
  id: string;
  occurred_on: string | null;
  cost_code_id: string | null;
  cost_code: string | null;
  cost_type: string | null;
  amount_cents: number | null;
  lifecycle: string;
  gate: string | null;
  source_ref: string;
  gl_entry_id: string | null;
  vendor_id: string | null;
  description: string | null;
  commitment_line_id: string | null;
  commitment_number: string | null;
}

export type CostSource = 'AP_BILL' | 'PAYROLL' | 'BANK' | 'JOURNAL' | 'EQUIPMENT' | 'OTHER';

/** What produced a cost line, from the Books gate and source reference. */
export function costSource(r: Pick<CostDetailRow, 'gate' | 'source_ref' | 'cost_type'>): CostSource {
  const ref = r.source_ref.toUpperCase();
  if (r.gate === 'PAYABLE_APPROVAL' || /^(AP|BILL)/.test(ref)) return 'AP_BILL';
  if (r.gate === 'TIMESHEET_PAYROLL' || /^(PR|PAYROLL|TIME)/.test(ref)) return 'PAYROLL';
  if (r.gate === 'BANKFEED_CATEGORIZATION' || /^(BANK|TXN)/.test(ref)) return 'BANK';
  if (/^(EQ|EQUIP)/.test(ref) || r.cost_type === 'EQUIPMENT') return 'EQUIPMENT';
  if (/^(JE|GL)/.test(ref)) return 'JOURNAL';
  return 'OTHER';
}

export const COST_SOURCE_WORDS: Readonly<Record<CostSource, { word: string; books: string }>> = {
  AP_BILL: { word: 'AP bill', books: '/bills' },
  PAYROLL: { word: 'Payroll', books: '/payroll' },
  BANK: { word: 'Bank or card', books: '/bank-feed' },
  JOURNAL: { word: 'Journal entry', books: '/journal-entries' },
  EQUIPMENT: { word: 'Equipment charge', books: '/journal-entries' },
  OTHER: { word: 'Other', books: '/journal-entries' },
};

export type CostGroupBy = 'code' | 'type' | 'month' | 'source';

export interface CostGroup { key: string; label: string; total: number; pending: number; rows: CostDetailRow[] }

/** Group the cost lines for the drill-down; groups by total, largest first (month: newest first). */
export function groupCosts(rows: ReadonlyArray<CostDetailRow>, by: CostGroupBy, codeName: (id: string | null) => string | null = () => null): CostGroup[] {
  const m = new Map<string, CostGroup>();
  for (const r of rows) {
    let key: string;
    let label: string;
    if (by === 'code') { key = r.cost_code_id ?? 'none'; label = r.cost_code ? [r.cost_code, codeName(r.cost_code_id)].filter(Boolean).join(' ') : 'No cost code'; }
    else if (by === 'type') { key = r.cost_type ?? 'none'; label = r.cost_type ? r.cost_type.charAt(0) + r.cost_type.slice(1).toLowerCase() : 'No cost type'; }
    else if (by === 'month') { key = (r.occurred_on ?? '').slice(0, 7) || 'none'; label = key === 'none' ? 'No date' : key; }
    else { const s = costSource(r); key = s; label = COST_SOURCE_WORDS[s].word; }
    const g = m.get(key) ?? { key, label, total: 0, pending: 0, rows: [] };
    g.total += n0(r.amount_cents);
    if (r.lifecycle === 'PENDING') g.pending += n0(r.amount_cents);
    g.rows.push(r);
    m.set(key, g);
  }
  const gs = [...m.values()];
  return by === 'month' ? gs.sort((a, b) => b.key.localeCompare(a.key)) : gs.sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));
}

// ------------------------------------------------------------------ closeout (CGC-103)

export interface CloseoutItemLite { id: string; category: string; title: string; vendor_id: string | null; required: boolean; status: string; due_on: string | null }

export const CLOSEOUT_DONE = new Set(['ACCEPTED', 'WAIVED']);

/** Status by sub (and "General" for the contractor's own items): done / required, what's late. */
export function closeoutBySub(items: ReadonlyArray<CloseoutItemLite>, vendorName: (id: string) => string, today: string): Array<{ key: string; label: string; done: number; required: number; late: number; items: CloseoutItemLite[] }> {
  const m = new Map<string, { key: string; label: string; done: number; required: number; late: number; items: CloseoutItemLite[] }>();
  for (const i of items) {
    const key = i.vendor_id ?? 'general';
    const g = m.get(key) ?? { key, label: i.vendor_id ? vendorName(i.vendor_id) : 'General (our own)', done: 0, required: 0, late: 0, items: [] };
    if (i.required) {
      g.required += 1;
      if (CLOSEOUT_DONE.has(i.status)) g.done += 1;
      else if (i.due_on && i.due_on < today) g.late += 1;
    }
    g.items.push(i);
    m.set(key, g);
  }
  return [...m.values()].sort((a, b) => (a.key === 'general' ? -1 : b.key === 'general' ? 1 : (a.done / Math.max(a.required, 1)) - (b.done / Math.max(b.required, 1)) || a.label.localeCompare(b.label)));
}

/** Where to fix each close-gate blocker (CGC-106). */
export const GATE_FIX: Readonly<Record<string, { label: string; href: (jobId: string) => string; owner: string }>> = {
  FINAL_BILLING: { label: 'Bill the final application and retainage', href: (j) => `/jobs/${j}?tab=billing`, owner: 'Project accountant' },
  BILLING_IN_FLIGHT: { label: 'Finish the billing in Merit Books', href: (j) => `/jobs/${j}?tab=billing`, owner: 'Project accountant' },
  COMMITMENTS_OPEN: { label: 'Close the commitments', href: (j) => `/jobs/${j}?tab=commitments`, owner: 'Project manager' },
  FINAL_WAIVERS: { label: 'Collect final lien waivers', href: () => '/compliance?tab=waivers', owner: 'Project accountant' },
  RECEIVED_NOT_BILLED: { label: 'Clear receipts not yet invoiced', href: (j) => `/jobs/${j}?tab=commitments`, owner: 'Purchasing' },
  PAYABLE_RETAINAGE: { label: 'Release sub retainage', href: () => '/retainage-ledger?tab=payable', owner: 'Project accountant' },
  SUB_PAY_APPS: { label: 'Finish sub pay application review', href: () => '/compliance?tab=payapps', owner: 'Project manager' },
  TM_UNBILLED: { label: 'Bill the signed T&M tickets', href: () => '/daily-logs?tab=tm', owner: 'Project manager' },
  CHANGES_OPEN: { label: 'Resolve the open change events', href: (j) => `/jobs/${j}?tab=change-events`, owner: 'Project manager' },
  PUNCH_OPEN: { label: 'Close the punch list', href: (j) => `/jobs/${j}?tab=punch`, owner: 'Superintendent' },
  CLOSEOUT_ITEMS: { label: 'Collect the closeout documents', href: (j) => `/closeout?job=${j}`, owner: 'Project manager' },
};

// ------------------------------------------------------------------ correspondence (CGC-67)

export const CORR_TYPES: ReadonlyArray<{ value: string; label: string; prefix: string }> = [
  { value: 'LETTER', label: 'Letter', prefix: 'LTR' }, { value: 'NOTICE_OF_DELAY', label: 'Notice of delay', prefix: 'NOD' },
  { value: 'NOTICE_OF_CLAIM', label: 'Notice of claim', prefix: 'NOC' }, { value: 'BACKCHARGE_NOTICE', label: 'Backcharge notice', prefix: 'BCN' },
  { value: 'NOTICE_OF_DEFAULT', label: 'Notice of default', prefix: 'NDF' }, { value: 'NOTICE_TO_PROCEED', label: 'Notice to proceed', prefix: 'NTP' },
  { value: 'NOTICE_OF_DISPUTE', label: 'Notice of dispute', prefix: 'NDS' }, { value: 'MEMO', label: 'Memo', prefix: 'MEM' },
  { value: 'EMAIL', label: 'Email (logged)', prefix: 'EML' }, { value: 'OTHER', label: 'Other', prefix: 'COR' },
];

/** A letter waits on a response when one is required, it went out (or came in), and none is logged. */
export function awaitingResponse(c: { response_required_by: string | null; responded_on: string | null; status: string }): boolean {
  return !!c.response_required_by && !c.responded_on && (c.status === 'SENT' || c.status === 'RECEIVED');
}

export interface LetterFacts { jobLabel: string; toName: string | null; toCompany: string | null; fromName: string | null; date: string; event: string | null; days: number | null }

/** A plain first draft for the notice types the contract usually requires in writing. */
export function letterDraft(type: string, f: LetterFacts): { subject: string; body: string } {
  const to = [f.toName, f.toCompany].filter(Boolean).join(', ') || 'To whom it may concern';
  const sign = `\n\nSincerely,\n${f.fromName ?? ''}`.trimEnd();
  const ev = f.event?.trim() || '[describe the event]';
  switch (type) {
    case 'NOTICE_OF_DELAY':
      return { subject: `Notice of delay — ${f.jobLabel}`, body: `${to}:\n\nThis is written notice under the contract that the work on ${f.jobLabel} has been delayed by ${ev}, beginning ${f.date}.${f.days ? ` We presently estimate the impact at ${f.days} working days.` : ''} We reserve our right to an extension of the contract time and to recover the costs of the delay, and will submit the supporting schedule analysis when the impact is known.${sign}` };
    case 'NOTICE_OF_CLAIM':
      return { subject: `Notice of claim — ${f.jobLabel}`, body: `${to}:\n\nPlease accept this as written notice of a claim on ${f.jobLabel} arising from ${ev}, first observed on ${f.date}. Pricing and the time impact will follow within the period the contract allows. This notice preserves our rights; it is not the full measure of the claim.${sign}` };
    case 'BACKCHARGE_NOTICE':
      return { subject: `Backcharge notice — ${f.jobLabel}`, body: `${to}:\n\nOn ${f.date} we found ${ev} on ${f.jobLabel}. Under your subcontract you are notified that unless it is corrected within 48 hours, we will correct it and backcharge the cost, with our markup, against your subcontract.${sign}` };
    case 'NOTICE_OF_DEFAULT':
      return { subject: `Notice of default — ${f.jobLabel}`, body: `${to}:\n\nYou are in default of your obligations on ${f.jobLabel}: ${ev}. Cure the default within the period your agreement provides from the date of this notice (${f.date}), or we will exercise the remedies available to us.${sign}` };
    case 'NOTICE_TO_PROCEED':
      return { subject: `Notice to proceed — ${f.jobLabel}`, body: `${to}:\n\nYou are directed to proceed with ${ev} on ${f.jobLabel}, effective ${f.date}.${sign}` };
    case 'NOTICE_OF_DISPUTE':
      return { subject: `Notice of dispute — ${f.jobLabel}`, body: `${to}:\n\nWe dispute ${ev} on ${f.jobLabel}. We are proceeding with the work as directed under protest and reserve all rights.${sign}` };
    default:
      return { subject: f.jobLabel, body: `${to}:\n\n${ev}${sign}` };
  }
}

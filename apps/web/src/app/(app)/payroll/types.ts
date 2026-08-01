/**
 * Shared payroll types for the /payroll run-workflow UI (GATE 12.3, Phase A).
 *
 * These mirror the sibling API's JSON shapes. Fields the engine may not always
 * return are optional so the UI degrades gracefully rather than crashing.
 */

/**
 * The run lifecycle (FPB §5). The API surface exposes the shorter
 * Draft→Previewed→Approved→Released→Processing→Paid/Failed set; the extra
 * terminal states are tolerated so a run that the engine reports as POSTED /
 * RECONCILED / RETURNED / REJECTED / VOID still renders sensibly.
 */
export type RunStatus =
  | 'DRAFT'
  | 'PREVIEWED'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'RELEASED'
  | 'PROCESSING'
  | 'PAID'
  | 'POSTED'
  | 'RECONCILED'
  | 'FAILED'
  | 'RETURNED'
  | 'REJECTED'
  | 'VOID';

export interface RunListItem {
  id: string;
  status: RunStatus;
  periodStart: string;
  periodEnd: string;
  payDate: string;
  grossCents: number;
  netCents: number;
  employeeCount: number;
  provider: string | null;
}

export interface RunsResponse {
  runs: RunListItem[];
}

/** One employee's provider-computed gross-to-net line on a run. */
export interface RunEmployeeLine {
  employeeId: string;
  name: string;
  grossCents: number;
  netCents: number;
  employeeTaxCents: number;
  employerTaxCents: number;
  deductionsCents: number;
  benefitsCents: number;
}

export interface RunDetail {
  id: string;
  status: RunStatus;
  periodStart: string;
  periodEnd: string;
  payDate: string;
  memo?: string | null;
  provider?: string | null;
  grossCents: number;
  netCents: number;
  employeeTaxCents?: number;
  employerTaxCents?: number;
  deductionsCents?: number;
  benefitsCents?: number;
  employeeCount?: number;
  /** Total that debits the tenant bank: net + all taxes + garnishments. */
  fundingCents?: number;
  preparedBy?: string | null;
  approvedBy?: string | null;
  releasedBy?: string | null;
  /** Set once the run posts to the GL — used to surface the posted entry. */
  glEntryId?: string | null;
}

export interface RunDetailResponse {
  run: RunDetail;
  employees: RunEmployeeLine[];
}

/** An employee available to add to a run (roster picker). */
export interface EmployeeOption {
  id: string;
  name: string;
  payBasis?: 'HOURLY' | 'SALARY';
  baseRateCents?: number | null;
  annualSalaryCents?: number | null;
  standardHours?: number | null;
  isContractor?: boolean;
  departmentName?: string | null;
}

/** Optional pay-schedule row for the create form. */
export interface PayScheduleOption {
  id: string;
  label: string;
  frequency?: string;
}

/** Format a YYYY-MM-DD date for display, UTC-safe. */
export function fmtDate(d: string | null | undefined): string {
  if (!d) return '—';
  const parsed = new Date(`${d}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return d;
  return parsed.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** The earning line types a runner can add to an employee input. */
export const EARNING_TYPES = [
  { value: 'SALARY', label: 'Salary' },
  { value: 'BONUS', label: 'Bonus' },
  { value: 'COMMISSION', label: 'Commission' },
  { value: 'OVERTIME', label: 'Overtime' },
  { value: 'REIMBURSEMENT', label: 'Reimbursement' },
] as const;

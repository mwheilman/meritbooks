/**
 * Lender draw math on integer cents, mirroring the SQL in 1107 so the screen and the
 * views can never disagree (unit-tested against hand-computed view rows):
 *
 *   v_draw_line_status   drawn = Σ approved on FUNDED draws; open = Σ coalesce(approved, requested)
 *                        on DRAFT/SUBMITTED/INSPECTION/APPROVED/RETURNED; remaining = revised − drawn − open;
 *                        retainage held = Σ held − Σ released on FUNDED draws
 *   v_draw_schedule_status
 *                        cost to complete = Σ max(revised − drawn, 0) + retainage held
 *                        gap = cost to complete − (commitment − funded) − max(equity required − equity applied, 0)
 *   pm.approve_draw      held per line = round(approved × retainage %) on lines where retainage applies;
 *                        net = approved − held + released; equity first up to what remains; loan = net − equity
 *
 * G703 columns (AIA continuation sheet): C scheduled value · D from previous draws · E this
 * draw · G completed to date (D + E) · G ÷ C · H balance to finish (C − G) · I retainage.
 */
import { money } from '@meritbooks/merit-ui';
import type { DrawCategory, DrawLineStatusRow, DrawScheduleStatusRow, DrawStatus, InspectionStatus } from './types';

/** Postgres round() on numeric: half away from zero. */
export function pgRound(x: number): number {
  return Math.sign(x) * Math.round(Math.abs(x));
}

export interface G703Line {
  id: string;
  lineNo: number;
  description: string;
  category: DrawCategory;
  scheduled: number; // C
  previous: number; // D
  thisDraw: number; // E
  completed: number; // G = D + E
  pct: number | null; // G ÷ C
  balance: number; // H = C − G
  retainage: number; // I
}

export interface G703Totals {
  scheduled: number;
  previous: number;
  thisDraw: number;
  completed: number;
  pct: number | null;
  balance: number;
  retainage: number;
}

export function g703Line(r: DrawLineStatusRow): G703Line {
  const scheduled = r.revised_cents;
  const previous = r.drawn_cents;
  const thisDraw = r.open_request_cents;
  const completed = previous + thisDraw;
  return {
    id: r.draw_budget_line_id,
    lineNo: r.line_no,
    description: r.description,
    category: r.category,
    scheduled,
    previous,
    thisDraw,
    completed,
    pct: scheduled > 0 ? completed / scheduled : null,
    balance: scheduled - completed, // = remaining_cents in the view
    retainage: r.retainage_held_cents,
  };
}

export function g703(rows: ReadonlyArray<DrawLineStatusRow>): { lines: G703Line[]; totals: G703Totals } {
  const lines = [...rows].sort((a, b) => a.line_no - b.line_no).map(g703Line);
  const sum = (f: (l: G703Line) => number) => lines.reduce((s, l) => s + f(l), 0);
  const scheduled = sum((l) => l.scheduled);
  const completed = sum((l) => l.completed);
  return {
    lines,
    totals: {
      scheduled,
      previous: sum((l) => l.previous),
      thisDraw: sum((l) => l.thisDraw),
      completed,
      pct: scheduled > 0 ? completed / scheduled : null,
      balance: sum((l) => l.balance),
      retainage: sum((l) => l.retainage),
    },
  };
}

/** Raw facts for one line, as the SQL view aggregates them (for parity tests and previews). */
export interface LineFacts {
  revised: number;
  draws: ReadonlyArray<{ status: DrawStatus; requested: number; approved: number | null; held: number; released: number }>;
}

/** v_draw_line_status for one budget line, computed from its draw lines. */
export function lineStatus(f: LineFacts): { drawn: number; open: number; remaining: number; held: number } {
  const OPEN: ReadonlySet<DrawStatus> = new Set(['DRAFT', 'SUBMITTED', 'INSPECTION', 'APPROVED', 'RETURNED']);
  let drawn = 0;
  let open = 0;
  let held = 0;
  for (const d of f.draws) {
    if (d.status === 'FUNDED') {
      drawn += d.approved ?? 0;
      held += d.held - d.released;
    } else if (OPEN.has(d.status)) {
      open += d.approved ?? d.requested;
    }
  }
  return { drawn, open, remaining: f.revised - drawn - open, held };
}

export interface BalanceInput {
  lines: ReadonlyArray<{ revised: number; drawn: number; retainageHeld: number }>;
  loanCommitment: number;
  loanFunded: number;
  equityRequired: number;
  equityApplied: number;
}

export interface Balance {
  costToComplete: number;
  loanRemaining: number;
  equityRemaining: number;
  /** > 0 = out of balance by this much; ≤ 0 = in balance with −gap to spare. */
  gap: number;
}

/** The in-balance test, exactly as v_draw_schedule_status computes it. */
export function inBalance(b: BalanceInput): Balance {
  const remaining = b.lines.reduce((s, l) => s + Math.max(l.revised - l.drawn, 0), 0);
  const held = b.lines.reduce((s, l) => s + l.retainageHeld, 0);
  const costToComplete = remaining + held;
  const loanRemaining = b.loanCommitment - b.loanFunded;
  const equityRemaining = Math.max(b.equityRequired - b.equityApplied, 0);
  return { costToComplete, loanRemaining, equityRemaining, gap: costToComplete - loanRemaining - equityRemaining };
}

export function balanceOf(s: Pick<DrawScheduleStatusRow, 'cost_to_complete_cents' | 'loan_remaining_cents' | 'equity_remaining_cents' | 'in_balance_gap_cents'>): Balance {
  return { costToComplete: s.cost_to_complete_cents, loanRemaining: s.loan_remaining_cents, equityRemaining: s.equity_remaining_cents, gap: s.in_balance_gap_cents };
}

/** The in-balance result in plain words, with the gap stated. */
export function balanceSentence(b: Balance): { tone: 'pos' | 'neg'; title: string; body: string } {
  const sources = b.loanRemaining + b.equityRemaining;
  if (b.gap > 0) {
    return {
      tone: 'neg',
      title: `Out of balance by ${money(b.gap)}`,
      body: `Cost to complete is ${money(b.costToComplete)}, but the undisbursed loan (${money(b.loanRemaining)}) and remaining equity (${money(b.equityRemaining)}) cover only ${money(sources)}. Reallocate the loan budget, add equity, or cut cost before the lender sees the next draw.`,
    };
  }
  return {
    tone: 'pos',
    title: b.gap === 0 ? 'In balance' : `In balance, ${money(-b.gap)} to spare`,
    body: `The undisbursed loan (${money(b.loanRemaining)}) and remaining equity (${money(b.equityRemaining)}) cover the ${money(b.costToComplete)} cost to complete.`,
  };
}

export interface ApprovalPreview {
  approved: number;
  held: number;
  released: number;
  net: number;
  equity: number;
  loan: number;
}

/** What pm.approve_draw will pin, so the lender-facing numbers are visible before approving. */
export function previewApproval(input: {
  lines: ReadonlyArray<{ approved: number; released: number; retainageApplies: boolean }>;
  retainagePct: number;
  equityFirst: boolean;
  equityRequired: number;
  equityUsedOnOtherDraws: number;
}): ApprovalPreview {
  let approved = 0;
  let held = 0;
  let released = 0;
  for (const l of input.lines) {
    approved += l.approved;
    held += l.retainageApplies ? pgRound(l.approved * input.retainagePct) : 0;
    released += l.released;
  }
  const net = approved - held + released;
  const equity = input.equityFirst ? Math.min(Math.max(input.equityRequired - input.equityUsedOnOtherDraws, 0), Math.max(net, 0)) : 0;
  return { approved, held, released, net, equity, loan: net - equity };
}

/** The draw package checklist, in the order the lender reads it (keys from v_draw_summary). */
export const PACKAGE_ITEMS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'draw_summary', label: 'Draw summary (sources and uses)' },
  { key: 'cover_letter', label: 'Cover letter, signed' },
  { key: 'pay_applications', label: 'Pay applications (G702/G703)' },
  { key: 'invoices', label: 'Invoices above the threshold' },
  { key: 'lien_waivers_conditional', label: 'Conditional lien waivers, this draw' },
  { key: 'lien_waivers_unconditional_prior', label: 'Unconditional lien waivers, prior draw' },
  { key: 'change_order_log', label: 'Change order log' },
  { key: 'interest_reserve_statement', label: 'Interest reserve statement' },
  { key: 'insurance_certificates', label: 'Insurance certificates' },
  { key: 'inspection_report', label: 'Inspection report' },
  { key: 'title_update', label: 'Title update (date-down)' },
];

export const DRAW_STATUS_WORDS: Readonly<Record<DrawStatus, string>> = {
  DRAFT: 'Draft', SUBMITTED: 'Submitted', INSPECTION: 'Inspected', APPROVED: 'Lender approved', FUNDED: 'Funded', RETURNED: 'Returned', CANCELLED: 'Cancelled',
};

export const INSPECTION_WORDS: Readonly<Record<InspectionStatus, string>> = {
  NOT_REQUESTED: 'Not requested', NOT_REQUIRED: 'Not required', PENDING: 'Waiting on the inspector', PASSED: 'Passed', CONDITIONAL: 'Passed with conditions', FAILED: 'Failed',
};

export const CATEGORY_WORDS: Readonly<Record<DrawCategory, string>> = {
  LAND: 'Land', HARD: 'Hard cost', SOFT: 'Soft cost', FINANCING: 'Financing', INTEREST_RESERVE: 'Interest reserve', CONTINGENCY: 'Contingency', DEVELOPER_FEE: 'Developer fee', OTHER: 'Other',
};

/** What the draw can do next, given status and the inspection rule. */
export function drawActions(status: DrawStatus, inspection: InspectionStatus, requiresInspection: boolean): Array<'edit' | 'submit' | 'inspect' | 'approve' | 'return' | 'fund' | 'cancel'> {
  switch (status) {
    case 'DRAFT':
    case 'RETURNED':
      return ['edit', 'submit', 'cancel'];
    case 'SUBMITTED':
    case 'INSPECTION': {
      const out: Array<'inspect' | 'approve' | 'return'> = ['inspect'];
      if (!requiresInspection || inspection === 'PASSED' || inspection === 'CONDITIONAL') out.push('approve');
      out.push('return');
      return out;
    }
    case 'APPROVED':
      return ['fund'];
    default:
      return [];
  }
}

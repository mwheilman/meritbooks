import { describe, expect, it } from 'vitest';
import {
  PACKAGE_ITEMS, balanceSentence, drawActions, g703, inBalance, lineStatus, pgRound, previewApproval,
} from '@/lib/pm/ops/draw-math';
import type { DrawLineStatusRow } from '@/lib/pm/ops/types';

/**
 * Hand-computed from the 1107 view definitions:
 *   v_draw_line_status: drawn = Σ approved on FUNDED; open = Σ coalesce(approved, requested) on
 *   DRAFT/SUBMITTED/INSPECTION/APPROVED/RETURNED; remaining = revised − drawn − open; held = Σ held − released (FUNDED).
 */
const LINE_A = {
  revised: 10_000_000,
  draws: [
    { status: 'FUNDED' as const, requested: 3_200_000, approved: 3_000_000, held: 300_000, released: 0 },
    { status: 'SUBMITTED' as const, requested: 2_000_000, approved: null, held: 0, released: 0 },
    { status: 'CANCELLED' as const, requested: 500_000, approved: null, held: 0, released: 0 },
  ],
};
const LINE_B = {
  revised: 5_000_000,
  draws: [
    { status: 'FUNDED' as const, requested: 5_000_000, approved: 5_000_000, held: 250_000, released: 250_000 },
    { status: 'APPROVED' as const, requested: 1_200_000, approved: 1_000_000, held: 0, released: 0 },
  ],
};

function viewRow(id: string, lineNo: number, f: typeof LINE_A | typeof LINE_B): DrawLineStatusRow {
  const s = lineStatus(f);
  return {
    job_id: 'j', draw_schedule_id: 's', draw_budget_line_id: id, line_no: lineNo, description: id, category: 'HARD',
    original_cents: f.revised, revised_cents: f.revised, drawn_cents: s.drawn, open_request_cents: s.open, remaining_cents: s.remaining,
    pct_drawn: f.revised ? s.drawn / f.revised : null, retainage_held_cents: s.held,
  };
}

describe('v_draw_line_status semantics', () => {
  it('counts approved on funded draws as drawn, approved-else-requested on open draws, and skips cancelled', () => {
    expect(lineStatus(LINE_A)).toEqual({ drawn: 3_000_000, open: 2_000_000, remaining: 5_000_000, held: 300_000 });
  });
  it('lets remaining go negative when a line is over-requested (the view does not clamp)', () => {
    expect(lineStatus(LINE_B)).toEqual({ drawn: 5_000_000, open: 1_000_000, remaining: -1_000_000, held: 0 });
  });
});

describe('G703 continuation sheet', () => {
  const sheet = g703([viewRow('b', 2, LINE_B), viewRow('a', 1, LINE_A)]);
  it('orders by line number and computes D + E = G, C − G = H', () => {
    expect(sheet.lines.map((l) => l.id)).toEqual(['a', 'b']);
    const a = sheet.lines[0]!;
    expect(a).toMatchObject({ scheduled: 10_000_000, previous: 3_000_000, thisDraw: 2_000_000, completed: 5_000_000, balance: 5_000_000, retainage: 300_000 });
    expect(a.pct).toBeCloseTo(0.5);
  });
  it('balance to finish equals the view remaining_cents on every line', () => {
    for (const l of sheet.lines) {
      const row = [viewRow('a', 1, LINE_A), viewRow('b', 2, LINE_B)].find((r) => r.draw_budget_line_id === l.id)!;
      expect(l.balance).toBe(row.remaining_cents);
    }
  });
  it('totals foot across the columns', () => {
    expect(sheet.totals).toMatchObject({ scheduled: 15_000_000, previous: 8_000_000, thisDraw: 3_000_000, completed: 11_000_000, balance: 4_000_000, retainage: 300_000 });
    expect(sheet.totals.pct).toBeCloseTo(11 / 15);
  });
  it('has no percent when nothing is scheduled', () => {
    expect(g703([]).totals.pct).toBeNull();
  });
});

describe('in-balance test (v_draw_schedule_status)', () => {
  const input = {
    lines: [
      { revised: 10_000_000, drawn: 3_000_000, retainageHeld: 300_000 },
      { revised: 5_000_000, drawn: 5_000_000, retainageHeld: 0 },
      { revised: 1_000_000, drawn: 1_200_000, retainageHeld: 0 }, // overdrawn: max(revised − drawn, 0) = 0
    ],
    loanCommitment: 9_000_000,
    loanFunded: 2_700_000,
    equityRequired: 2_000_000,
    equityApplied: 1_500_000,
  };
  it('cost to complete = Σ max(revised − drawn, 0) + retainage held; gap = cost − undisbursed loan − remaining equity', () => {
    expect(inBalance(input)).toEqual({ costToComplete: 7_300_000, loanRemaining: 6_300_000, equityRemaining: 500_000, gap: 500_000 });
  });
  it('remaining equity never goes below zero', () => {
    expect(inBalance({ ...input, equityApplied: 2_500_000 }).equityRemaining).toBe(0);
  });
  it('states the gap in plain words', () => {
    const out = balanceSentence(inBalance(input));
    expect(out.tone).toBe('neg');
    expect(out.title).toBe('Out of balance by 5,000.00');
    expect(out.body).toContain('cover only 68,000.00');
    expect(balanceSentence({ costToComplete: 100, loanRemaining: 100, equityRemaining: 0, gap: 0 }).title).toBe('In balance');
    expect(balanceSentence({ costToComplete: 100, loanRemaining: 12_445, equityRemaining: 0, gap: -12_345 })).toMatchObject({ tone: 'pos', title: 'In balance, 123.45 to spare' });
  });
});

describe('approve_draw preview', () => {
  it('holds round(approved × retainage) per line, half away from zero, only where retainage applies', () => {
    const p = previewApproval({
      lines: [
        { approved: 1_000_001, released: 0, retainageApplies: true }, // 100,000.1 → 100,000
        { approved: 15, released: 0, retainageApplies: true }, // 1.5 → 2
        { approved: 400_000, released: 5_000, retainageApplies: false },
      ],
      retainagePct: 0.1,
      equityFirst: true,
      equityRequired: 2_000_000,
      equityUsedOnOtherDraws: 1_500_000,
    });
    expect(p.held).toBe(100_002);
    expect(p.approved).toBe(1_400_016);
    expect(p.net).toBe(1_400_016 - 100_002 + 5_000);
    expect(p.equity).toBe(500_000);
    expect(p.loan).toBe(p.net - 500_000);
  });
  it('without equity first the loan takes it all', () => {
    const p = previewApproval({ lines: [{ approved: 1_000, released: 0, retainageApplies: false }], retainagePct: 0.1, equityFirst: false, equityRequired: 5_000, equityUsedOnOtherDraws: 0 });
    expect(p).toMatchObject({ equity: 0, loan: 1_000 });
  });
  it('pgRound is half away from zero', () => {
    expect(pgRound(2.5)).toBe(3);
    expect(pgRound(-2.5)).toBe(-3);
    expect(pgRound(-2.4)).toBe(-2);
  });
});

describe('draw lifecycle and package', () => {
  it('offers approve only once a required inspection passed', () => {
    expect(drawActions('SUBMITTED', 'PENDING', true)).toEqual(['inspect', 'return']);
    expect(drawActions('INSPECTION', 'CONDITIONAL', true)).toEqual(['inspect', 'approve', 'return']);
    expect(drawActions('SUBMITTED', 'NOT_REQUESTED', false)).toEqual(['inspect', 'approve', 'return']);
    expect(drawActions('APPROVED', 'PASSED', true)).toEqual(['fund']);
    expect(drawActions('FUNDED', 'PASSED', true)).toEqual([]);
    expect(drawActions('RETURNED', 'FAILED', true)).toEqual(['edit', 'submit', 'cancel']);
  });
  it('lists the eleven package items the view checks', () => {
    expect(PACKAGE_ITEMS.map((i) => i.key).sort()).toEqual([
      'change_order_log', 'cover_letter', 'draw_summary', 'inspection_report', 'insurance_certificates', 'interest_reserve_statement', 'invoices',
      'lien_waivers_conditional', 'lien_waivers_unconditional_prior', 'pay_applications', 'title_update',
    ]);
  });
});

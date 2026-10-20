/**
 * Wave 2G — payroll release is governed by the MONEY-APPROVAL record, not the run row
 * (security review HIGH: a preparer could PATCH payroll_runs to APPROVED, edit per-person
 * net pay and release alone).
 *
 *   - preparer ≠ releaser and approver ≠ releaser, on the run AND on the approval;
 *   - the approval must be APPROVED, for THIS run, with matching parties + amount;
 *   - the lines must still hash to the digest captured at approval;
 *   - the approval is CLAIMED before the provider is called; a lost claim never pays;
 *   - a provider failure hands the claim back; a recording failure after the provider
 *     accepted is raised (never swallowed) and never rolls the claim back;
 *   - approveRun captures the lines digest on the approval.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fakeSupabase, type FakeCall, type FakeDb } from '@/test/fake-supabase';
import type { PayrollEngine } from '@/lib/payroll/engine/types';

const ap = vi.hoisted(() => ({
  loadApproval: vi.fn(),
  claimApprovalForRelease: vi.fn(),
  revertReleaseClaim: vi.fn(),
  finalizeReleaseClaim: vi.fn(),
  createApproval: vi.fn(),
  submitForApproval: vi.fn(),
  approve: vi.fn(),
  order: [] as string[],
}));
vi.mock('@/lib/money/approvals', () => ({
  loadApproval: ap.loadApproval,
  claimApprovalForRelease: ap.claimApprovalForRelease,
  revertReleaseClaim: ap.revertReleaseClaim,
  finalizeReleaseClaim: ap.finalizeReleaseClaim,
  createApproval: ap.createApproval,
  submitForApproval: ap.submitForApproval,
  approve: ap.approve,
}));

import {
  approveRun,
  payrollLinesDigest,
  releaseRun,
  RunPreparerCannotApproveError,
  RunReleaseConflictError,
  RunReleaseRecordingError,
  RunReleaserCannotApproveError,
  RunTamperedError,
  type PayrollLineAmounts,
  type PayrollRunRow,
} from './run';

const LINES: Array<PayrollLineAmounts & { provider_ref: string | null }> = [
  { employee_id: 'e1', gross_cents: 600_00, net_cents: 420_00, employee_tax_cents: 120_00, employer_tax_cents: 60_00, deductions_cents: 30_00, benefits_cents: 30_00, provider_ref: null },
  { employee_id: 'e2', gross_cents: 400_00, net_cents: 280_00, employee_tax_cents: 80_00, employer_tax_cents: 40_00, deductions_cents: 20_00, benefits_cents: 20_00, provider_ref: null },
];

const run = (over: Partial<PayrollRunRow> = {}): PayrollRunRow => ({
  id: 'run1', org_id: 'org1', location_id: 'loc1', pay_schedule_id: null, provider: null, provider_run_id: null,
  period_start: '2026-08-01', period_end: '2026-08-15', pay_date: '2026-08-20', status: 'APPROVED',
  gross_cents: 1_000_00, net_cents: 700_00, employer_tax_cents: 100_00, employee_tax_cents: 200_00,
  benefits_cents: 50_00, deductions_cents: 50_00, approval_id: 'appr1', gl_entry_id: null,
  prepared_by: 'prep', approved_by: 'appr', released_by: null, memo: null, ...over,
});

function world(r: PayrollRunRow, lines = LINES): FakeDb {
  return fakeSupabase((c: FakeCall) => {
    if (c.table === 'payroll_runs' && c.op === 'select') return { data: r, error: null };
    if (c.table === 'payroll_runs' && c.op === 'update') {
      ap.order.push('run_update');
      return { data: { ...r, ...(c.payload as object) }, error: null };
    }
    if (c.table === 'payroll_run_employees' && c.op === 'select') return { data: lines, error: null };
    return { data: null, error: null };
  });
}

async function approvalFor(over: Record<string, unknown> = {}) {
  return {
    id: 'appr1', orgId: 'org1', kind: 'PAYROLL_RUN', subjectTable: 'payroll_runs', subjectId: 'run1',
    amountCents: 1_000_00, status: 'APPROVED', preparedBy: 'prep', approvedBy: 'appr', releasedBy: null,
    providerCorrelationId: null, rejectReason: null,
    metadata: { lines_digest: await payrollLinesDigest(LINES) },
    ...over,
  };
}

function engine(submit: () => Promise<{ providerRunId: string }>): PayrollEngine {
  return {
    name: 'test',
    submitRun: vi.fn(async () => { ap.order.push('submit'); return submit(); }),
  } as unknown as PayrollEngine;
}

beforeEach(() => {
  vi.clearAllMocks();
  ap.order = [];
  ap.claimApprovalForRelease.mockImplementation(async () => { ap.order.push('claim'); return 'CLAIMED'; });
  ap.finalizeReleaseClaim.mockImplementation(async () => { ap.order.push('finalize'); });
  ap.revertReleaseClaim.mockImplementation(async () => { ap.order.push('revert'); });
});

describe('releaseRun — separation of duties', () => {
  it('the preparer can never release (before any read of the approval)', async () => {
    const w = world(run());
    const eng = engine(async () => ({ providerRunId: 'p1' }));
    await expect(releaseRun(w.client, 'org1', 'run1', 'prep', eng)).rejects.toBeInstanceOf(RunPreparerCannotApproveError);
    expect(ap.loadApproval).not.toHaveBeenCalled();
    expect(eng.submitRun).not.toHaveBeenCalled();
  });

  it('the approver can never release', async () => {
    const w = world(run());
    await expect(releaseRun(w.client, 'org1', 'run1', 'appr', engine(async () => ({ providerRunId: 'p1' }))))
      .rejects.toBeInstanceOf(RunReleaserCannotApproveError);
  });

  it('a forged run row (approved_by edited) does not match the approval → refused, nothing claimed', async () => {
    // The exploit: run.approved_by set to a colleague so the preparer can "release".
    ap.loadApproval.mockResolvedValue(await approvalFor({ approvedBy: 'real_approver' }));
    const w = world(run({ approved_by: 'colleague' }));
    const eng = engine(async () => ({ providerRunId: 'p1' }));
    await expect(releaseRun(w.client, 'org1', 'run1', 'rel', eng)).rejects.toBeInstanceOf(RunTamperedError);
    expect(ap.claimApprovalForRelease).not.toHaveBeenCalled();
    expect(eng.submitRun).not.toHaveBeenCalled();
  });

  it('the releaser who is the approval\'s approver is refused even if the run row says otherwise', async () => {
    ap.loadApproval.mockResolvedValue(await approvalFor({ approvedBy: 'rel' }));
    const w = world(run({ approved_by: 'rel' }));
    await expect(releaseRun(w.client, 'org1', 'run1', 'rel', engine(async () => ({ providerRunId: 'p1' }))))
      .rejects.toBeInstanceOf(RunReleaserCannotApproveError);
  });
});

describe('releaseRun — what moves is what was approved', () => {
  it('an approval that is not APPROVED (still pending) cannot be released', async () => {
    ap.loadApproval.mockResolvedValue(await approvalFor({ status: 'PENDING_APPROVAL', approvedBy: null }));
    const w = world(run());
    await expect(releaseRun(w.client, 'org1', 'run1', 'rel', engine(async () => ({ providerRunId: 'p1' })))).rejects.toThrow(/not APPROVED/);
    expect(ap.claimApprovalForRelease).not.toHaveBeenCalled();
  });

  it('edited per-person net pay (digest mismatch) is refused before the claim', async () => {
    ap.loadApproval.mockResolvedValue(await approvalFor());
    const edited = LINES.map((l, i) => (i === 0 ? { ...l, net_cents: 520_00, employee_tax_cents: 20_00 } : l));
    const w = world(run({ net_cents: 800_00 }), edited);
    const eng = engine(async () => ({ providerRunId: 'p1' }));
    await expect(releaseRun(w.client, 'org1', 'run1', 'rel', eng)).rejects.toBeInstanceOf(RunTamperedError);
    expect(ap.claimApprovalForRelease).not.toHaveBeenCalled();
    expect(eng.submitRun).not.toHaveBeenCalled();
  });

  it('lines that no longer add up to the run totals are refused', async () => {
    ap.loadApproval.mockResolvedValue(await approvalFor({ metadata: {} }));
    const w = world(run({ net_cents: 999_00 }));
    await expect(releaseRun(w.client, 'org1', 'run1', 'rel', engine(async () => ({ providerRunId: 'p1' })))).rejects.toBeInstanceOf(RunTamperedError);
  });

  it('a gross amount different from the approved amount is refused', async () => {
    ap.loadApproval.mockResolvedValue(await approvalFor({ amountCents: 900_00 }));
    const w = world(run());
    await expect(releaseRun(w.client, 'org1', 'run1', 'rel', engine(async () => ({ providerRunId: 'p1' })))).rejects.toBeInstanceOf(RunTamperedError);
  });
});

describe('releaseRun — claim before money, never swallow', () => {
  it('happy path: claim → provider → finalize → run update, in that order', async () => {
    ap.loadApproval.mockResolvedValue(await approvalFor());
    const w = world(run());
    const out = await releaseRun(w.client, 'org1', 'run1', 'rel', engine(async () => ({ providerRunId: 'prov-9' })));
    expect(ap.order).toEqual(['claim', 'submit', 'finalize', 'run_update']);
    expect(ap.claimApprovalForRelease).toHaveBeenCalledWith(w.client, 'org1', 'appr1', 'rel', { preparedBy: 'prep', approvedBy: 'appr' });
    expect(ap.finalizeReleaseClaim).toHaveBeenCalledWith(w.client, 'org1', 'appr1', 'rel', 'prov-9');
    expect(out.status).toBe('RELEASED');
  });

  it('a lost claim (concurrent release) never calls the provider', async () => {
    ap.loadApproval.mockResolvedValue(await approvalFor());
    ap.claimApprovalForRelease.mockResolvedValue('ALREADY_CLAIMED');
    const w = world(run());
    const eng = engine(async () => ({ providerRunId: 'p1' }));
    await expect(releaseRun(w.client, 'org1', 'run1', 'rel', eng)).rejects.toBeInstanceOf(RunReleaseConflictError);
    expect(eng.submitRun).not.toHaveBeenCalled();
  });

  it('a provider failure hands the claim back and rethrows', async () => {
    ap.loadApproval.mockResolvedValue(await approvalFor());
    const w = world(run());
    await expect(releaseRun(w.client, 'org1', 'run1', 'rel', engine(async () => { throw new Error('bank down'); })))
      .rejects.toThrow(/bank down/);
    expect(ap.order).toEqual(['claim', 'submit', 'revert']);
  });

  it('a recording failure after the provider accepted is raised and the claim is NOT reverted', async () => {
    ap.loadApproval.mockResolvedValue(await approvalFor());
    ap.finalizeReleaseClaim.mockRejectedValue(new Error('db timeout'));
    const w = world(run());
    const err = await releaseRun(w.client, 'org1', 'run1', 'rel', engine(async () => ({ providerRunId: 'prov-7' }))).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunReleaseRecordingError);
    expect((err as RunReleaseRecordingError).providerRunId).toBe('prov-7');
    expect(ap.revertReleaseClaim).not.toHaveBeenCalled();
  });
});

describe('approveRun — fingerprints the approved lines', () => {
  it('stores the lines digest on the money approval', async () => {
    ap.createApproval.mockResolvedValue({ id: 'appr1' });
    const w = world(run({ status: 'PREVIEWED', approved_by: null, approval_id: null }));
    await approveRun(w.client, 'org1', 'run1', 'appr');
    const input = ap.createApproval.mock.calls[0][2] as { metadata: { lines_digest: string; line_count: number } };
    expect(input.metadata.lines_digest).toBe(await payrollLinesDigest(LINES));
    expect(input.metadata.line_count).toBe(2);
    expect(ap.approve).toHaveBeenCalledWith(w.client, 'org1', 'appr1', 'appr');
  });

  it('the digest ignores row order but not amounts', async () => {
    expect(await payrollLinesDigest([...LINES].reverse())).toBe(await payrollLinesDigest(LINES));
    expect(await payrollLinesDigest([{ ...LINES[0], net_cents: 1 }, LINES[1]])).not.toBe(await payrollLinesDigest(LINES));
  });
});

import { describe, it, expect } from 'vitest';
import { scheduledOutstandingAsOf, type DebtScheduleLine } from './outstanding';
import { summarizeRegister, type RegisterInstrument } from './register';

const line = (period: number, period_date: string, principal: number, balance: number): DebtScheduleLine => ({
  period,
  period_date,
  payment_cents: principal,
  interest_cents: 0,
  principal_cents: principal,
  principal_balance_cents: balance,
});

describe('debt outstanding as of a date (audit L7)', () => {
  // 12-period revolver from 2024-09-17, fully amortized by 2025-09-17.
  const revolver: DebtScheduleLine[] = Array.from({ length: 12 }, (_, i) => {
    const p = i + 1;
    const m = ((8 + p) % 12) + 1;
    const y = 2024 + Math.floor((8 + p) / 12);
    return line(p, `${y}-${String(m).padStart(2, '0')}-17`, 3_333_333, Math.max(0, 40_000_000 - p * 3_333_333 - (p === 12 ? 4 : 0)));
  });

  it('a matured revolver is $0 outstanding (board showed $400K original principal)', () => {
    const r = scheduledOutstandingAsOf(revolver, '2026-10-31', 40_000_000);
    expect(r.outstandingCents).toBe(0);
    expect(r.fromSchedule).toBe(true);
    expect(r.nextPayment).toBeNull();
  });

  it('before the first period the opening balance is outstanding', () => {
    expect(scheduledOutstandingAsOf(revolver, '2024-09-30', 40_000_000).outstandingCents).toBe(40_000_000);
  });

  it('mid-schedule: balance after the latest elapsed period; next payment is the following one', () => {
    const r = scheduledOutstandingAsOf(revolver, '2025-01-20', 40_000_000);
    expect(r.outstandingCents).toBe(40_000_000 - 4 * 3_333_333);
    expect(r.nextPayment?.period).toBe(5);
  });

  it('no schedule falls back to recorded principal', () => {
    expect(scheduledOutstandingAsOf([], '2026-10-31', 12_345).outstandingCents).toBe(12_345);
  });

  it('register total ties to /debt: $897,787.39 outstanding, not $1,460,000.00 original', () => {
    const inst = (id: string, balanceCents: number, rate: number, monthly: number): RegisterInstrument => ({
      id, name: id, lender: '', type: '', status: 'ACTIVE', originalCents: 0, balanceCents, interestRate: rate,
      maturityDate: null, monthlyPaymentCents: monthly, annualPaymentCents: monthly * 12, paymentType: null,
      locationId: null, locationName: '', locationCode: '', fromSchedule: true,
    });
    // Live: acquisition note 89,778,739 outstanding at 10/31/2026; revolver matured → 0.
    const s = summarizeRegister([inst('note', 89_778_739, 7.5, 1_264_000), inst('revolver', 0, 9, 316_667)]);
    expect(s.totalBalanceCents).toBe(89_778_739);
    expect(s.instrumentCount).toBe(1);
    expect(s.totalMonthlyPaymentCents).toBe(1_264_000); // matured loan carries no service
    expect(s.weightedAvgRate).toBe(7.5);
  });
});

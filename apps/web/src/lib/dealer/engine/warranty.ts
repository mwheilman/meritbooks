/**
 * Manufacturer warranty claims (FPB §3.8) — pure.
 *
 *   DRAFT → SUBMITTED (receivable recognized ON_SUBMIT, or at RO close ON_RO_CLOSE)
 *         → PARTIAL (credit < open) → PAID | WRITTEN_OFF (short-pay accepted / rejected)
 *         → REJECTED → RESUBMITTED | WRITTEN_OFF
 *   DEBITED: a later manufacturer chargeback against an already-settled claim.
 *
 * GL by role: recognition DR Warranty receivable / CR Warranty labor sales (labor +
 * sublet + freight + other, SERVICE) / CR Warranty parts sales (parts at reimbursed
 * price, PARTS), and — when the client relieves parts here — DR Parts COGS / CR Parts
 * inventory at cost. Settlement by statement credit DR AP control (the OEM vendor);
 * by cash DR Operating bank; CR Warranty receivable. Short-pay / write-off DR Warranty
 * policy expense / CR Warranty receivable. Debit DR policy expense / CR AP control.
 */

import { applyBps, compactLegs, divRoundHalfUp, type JournalPlan } from '../journal';
import { DealerEngineError, type OemSettlementMethod, type WarrantyStatus } from '../types';

export interface ClaimComponentsInput {
  /** Hours as entered (e.g. 2.0, '1.75'); kept to hundredths. */
  laborHours: number | string;
  laborRateCents: number;
  partsCostCents: number;
  partsMarkupBps: number;
  subletCents: number;
  freightCents: number;
  otherCents: number;
}

export interface ClaimComponents {
  laborHoursHundredths: number;
  laborCents: number;
  partsCents: number;
  subletCents: number;
  freightCents: number;
  otherCents: number;
  claimedCents: number;
}

export function hoursToHundredths(h: number | string): number {
  const n = typeof h === 'string' ? Number(h) : h;
  if (!Number.isFinite(n) || n < 0) throw new DealerEngineError(`Invalid labor hours '${h}'`);
  return Math.round(n * 100);
}

/** Labor = hours × warranty rate; parts = cost × (1 + markup). Each rounded half-up. */
export function computeClaim(input: ClaimComponentsInput): ClaimComponents {
  const ints: [string, number][] = [
    ['laborRateCents', input.laborRateCents],
    ['partsCostCents', input.partsCostCents],
    ['partsMarkupBps', input.partsMarkupBps],
    ['subletCents', input.subletCents],
    ['freightCents', input.freightCents],
    ['otherCents', input.otherCents],
  ];
  for (const [k, v] of ints) if (!Number.isInteger(v) || v < 0) throw new DealerEngineError(`${k} must be a non-negative integer`);
  const hh = hoursToHundredths(input.laborHours);
  const labor = Number(divRoundHalfUp(BigInt(hh) * BigInt(input.laborRateCents), 100n));
  const parts = input.partsCostCents + applyBps(input.partsCostCents, input.partsMarkupBps);
  return {
    laborHoursHundredths: hh,
    laborCents: labor,
    partsCents: parts,
    subletCents: input.subletCents,
    freightCents: input.freightCents,
    otherCents: input.otherCents,
    claimedCents: labor + parts + input.subletCents + input.freightCents + input.otherCents,
  };
}

/** The DB CHECK claimed = Σ components, checked before writing. */
export function assertClaimFoots(c: {
  labor_cents: number;
  parts_cents: number;
  sublet_cents: number;
  freight_cents: number;
  other_cents: number;
  claimed_cents: number;
}): void {
  const sum = c.labor_cents + c.parts_cents + c.sublet_cents + c.freight_cents + c.other_cents;
  if (sum !== c.claimed_cents) throw new DealerEngineError(`Claimed ${c.claimed_cents} ≠ sum of components ${sum}`);
}

export function recognitionPlan(input: {
  laborCents: number;
  partsCents: number;
  subletCents: number;
  freightCents: number;
  otherCents: number;
  partsCostCents: number;
  relieveParts: boolean;
  memo: string;
}): JournalPlan {
  const laborSide = input.laborCents + input.subletCents + input.freightCents + input.otherCents;
  const claimed = laborSide + input.partsCents;
  if (claimed <= 0) throw new DealerEngineError('A warranty claim must claim something');
  const parts = input.relieveParts ? input.partsCostCents : 0;
  return {
    entryType: 'WARRANTY_CLAIM',
    memo: input.memo,
    primaryDept: 'SERVICE',
    legs: compactLegs([
      { role: 'WARRANTY_RECEIVABLE', effect: 'increase', amountCents: claimed, memo: 'Warranty claim receivable' },
      { role: 'WARRANTY_LABOR_SALES', effect: 'increase', amountCents: laborSide, deptRole: 'SERVICE', memo: 'Warranty labor (incl. sublet/freight/other)' },
      { role: 'WARRANTY_PARTS_SALES', effect: 'increase', amountCents: input.partsCents, deptRole: 'PARTS', memo: 'Warranty parts' },
      { role: 'INVENTORY_COGS', effect: 'increase', amountCents: parts, deptRole: 'PARTS', memo: 'Warranty parts at cost' },
      { role: 'INVENTORY_ASSET', effect: 'decrease', amountCents: parts, deptRole: 'PARTS', memo: 'Parts used on warranty repair' },
    ]),
  };
}

/** Manufacturer credit or cash received against a receivable (warranty or incentive). */
export function receivableSettlementPlan(input: {
  receivableRole: 'WARRANTY_RECEIVABLE' | 'OEM_INCENTIVE_RECEIVABLE';
  amountCents: number;
  method: OemSettlementMethod;
  memo: string;
}): JournalPlan {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) throw new DealerEngineError('Settlement must be positive cents');
  const credit = input.method === 'STATEMENT_CREDIT';
  return {
    entryType: input.receivableRole === 'WARRANTY_RECEIVABLE' ? 'WARRANTY_CLAIM' : 'OEM_INCENTIVE',
    memo: input.memo,
    primaryDept: input.receivableRole === 'WARRANTY_RECEIVABLE' ? 'SERVICE' : 'WG_NEW',
    legs: [
      credit
        ? { role: 'AP_CONTROL', effect: 'decrease', amountCents: input.amountCents, memo: 'Manufacturer statement credit' }
        : { role: 'OPERATING_BANK', effect: 'increase', amountCents: input.amountCents, memo: 'Manufacturer payment received' },
      { role: input.receivableRole, effect: 'decrease', amountCents: input.amountCents, memo: 'Receivable settled' },
    ],
  };
}

/** Accepted short-pay or written-off rejection: DR policy expense / CR receivable. */
export function warrantyWriteOffPlan(amountCents: number, memo: string): JournalPlan {
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw new DealerEngineError('Write-off must be positive cents');
  return {
    entryType: 'WARRANTY_CLAIM',
    memo,
    primaryDept: 'SERVICE',
    legs: [
      { role: 'WARRANTY_POLICY_EXPENSE', effect: 'increase', amountCents, deptRole: 'SERVICE', memo: 'Warranty short-pay / rejection' },
      { role: 'WARRANTY_RECEIVABLE', effect: 'decrease', amountCents, memo: 'Receivable written off' },
    ],
  };
}

/** Post-audit chargeback by the manufacturer: DR policy expense / CR AP control. */
export function warrantyDebitPlan(amountCents: number, memo: string): JournalPlan {
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw new DealerEngineError('Debit must be positive cents');
  return {
    entryType: 'WARRANTY_CLAIM',
    memo,
    primaryDept: 'SERVICE',
    legs: [
      { role: 'WARRANTY_POLICY_EXPENSE', effect: 'increase', amountCents, deptRole: 'SERVICE', memo: 'Manufacturer warranty chargeback' },
      { role: 'AP_CONTROL', effect: 'increase', amountCents, memo: 'Debit on manufacturer statement' },
    ],
  };
}

/** Status after money lands: fully covered → PAID / WRITTEN_OFF; else PARTIAL. */
export function statusAfterSettlement(c: {
  claimed_cents: number;
  settled_cents: number;
  written_off_cents: number;
}): WarrantyStatus {
  const covered = c.settled_cents + c.written_off_cents;
  if (covered > c.claimed_cents) throw new DealerEngineError('Settlement exceeds the claim');
  if (covered < c.claimed_cents) return 'PARTIAL';
  return c.written_off_cents > 0 && c.settled_cents === 0 ? 'WRITTEN_OFF' : 'PAID';
}

export function openCents(c: { claimed_cents: number; settled_cents: number; written_off_cents: number }): number {
  return c.claimed_cents - c.settled_cents - c.written_off_cents;
}

const SETTLEABLE: readonly WarrantyStatus[] = ['SUBMITTED', 'PARTIAL', 'RESUBMITTED'];
export function assertSettleable(status: WarrantyStatus): void {
  if (!SETTLEABLE.includes(status)) throw new DealerEngineError(`A ${status} claim cannot receive a settlement`);
}

const RESOLVABLE: readonly WarrantyStatus[] = ['SUBMITTED', 'PARTIAL', 'REJECTED', 'RESUBMITTED'];
export function assertResolvable(status: WarrantyStatus): void {
  if (!RESOLVABLE.includes(status)) throw new DealerEngineError(`A ${status} claim cannot be resolved`);
}

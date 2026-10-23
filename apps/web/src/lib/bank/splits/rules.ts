/**
 * Split rules (FPB-bank-feed-splits §4/§6, AC-8) — pure matching + application.
 *
 * A rule is a remembered % allocation keyed by vendor and/or a description pattern,
 * scoped to one company (the bank / card owner) or org-wide. Matching precedence:
 *   1. vendor + this company     2. vendor, org-wide
 *   3. pattern + this company    4. pattern, org-wide
 * (longer patterns win ties). The rule only PROPOSES; a human approves.
 */

import { z } from 'zod';
import { allocateByPercent, FULL_BP } from './allocate';

export const splitAllocationSchema = z.object({
  percent_bp: z.number().int().min(1).max(FULL_BP),
  account_id: z.string().uuid(),
  allocation_location_id: z.string().uuid(),
  department_id: z.string().uuid().nullable().optional(),
  class_id: z.string().uuid().nullable().optional(),
  job_id: z.string().uuid().nullable().optional(),
  cost_code_id: z.string().uuid().nullable().optional(),
  memo: z.string().max(500).nullable().optional(),
});
export type SplitAllocation = z.infer<typeof splitAllocationSchema>;

export const splitAllocationsSchema = z
  .array(splitAllocationSchema)
  .min(1)
  .max(50)
  .refine((a) => a.reduce((s, x) => s + x.percent_bp, 0) === FULL_BP, 'Rule percentages must add up to 100%.');

export interface SplitRuleRow {
  id: string;
  name: string;
  location_id: string | null;
  vendor_id: string | null;
  description_pattern: string | null;
  allocations: unknown;
  is_active: boolean;
  times_applied?: number;
}

/** Lower-case, strip punctuation, collapse whitespace (shared by save + match). */
export function normalizePattern(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

export interface RuleMatchInput {
  vendorId: string | null;
  description: string;
  locationId: string;
}

function rank(rule: SplitRuleRow, m: RuleMatchInput, desc: string): number | null {
  if (!rule.is_active) return null;
  if (rule.location_id && rule.location_id !== m.locationId) return null;
  const local = rule.location_id === m.locationId;
  if (rule.vendor_id) {
    if (!m.vendorId || rule.vendor_id !== m.vendorId) return null;
    // A vendor rule with a pattern must also match the pattern.
    if (rule.description_pattern && !desc.includes(normalizePattern(rule.description_pattern))) return null;
    return local ? 4000 : 3000;
  }
  const p = rule.description_pattern ? normalizePattern(rule.description_pattern) : '';
  if (!p || !desc.includes(p)) return null;
  return (local ? 2000 : 1000) + Math.min(p.length, 200);
}

/** The best active rule for a transaction, or null. Rules with invalid allocations are skipped. */
export function matchSplitRule<R extends SplitRuleRow>(rules: ReadonlyArray<R>, m: RuleMatchInput): R | null {
  const desc = normalizePattern(m.description);
  let best: { rule: R; score: number } | null = null;
  for (const r of rules) {
    const score = rank(r, m, desc);
    if (score == null) continue;
    if (!splitAllocationsSchema.safeParse(r.allocations).success) continue;
    if (!best || score > best.score) best = { rule: r, score };
  }
  return best?.rule ?? null;
}

export interface AppliedSplitLine extends SplitAllocation {
  line_no: number;
  amount_cents: number;
}

/** Apply a rule's % allocation to a transaction total (remainder to the last line). */
export function applySplitAllocations(totalCents: number, allocations: ReadonlyArray<SplitAllocation>): AppliedSplitLine[] {
  const amounts = allocateByPercent(totalCents, allocations.map((a) => a.percent_bp));
  return allocations.map((a, i) => ({ ...a, line_no: i + 1, amount_cents: amounts[i] }));
}

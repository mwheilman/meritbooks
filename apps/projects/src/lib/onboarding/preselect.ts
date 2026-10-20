/**
 * Step 0 — "Which companies run jobs?" preselection, and the Books-derived pack guess
 * shown on step 1 as a suggestion (never auto-picked). Pure.
 *
 * A company is preselected when any of these hold (review 02 §2 C8):
 *   - it already has core.jobs rows;
 *   - Books recognizes its revenue over time (PCT_COSTS_INCURRED, PCT_COMPLETE,
 *     COMPLETED_CONTRACT, MILESTONE);
 *   - its Books industry reads like contracting, building, installing or servicing.
 * The management company is never offered (tenant.ts already drops it; we guard too).
 */
import { classify, getPack } from '@meritbooks/industry-packs';
import type { BooksGuess } from './types';

export const JOB_REV_REC_METHODS = ['PCT_COSTS_INCURRED', 'PCT_COMPLETE', 'COMPLETED_CONTRACT', 'MILESTONE'] as const;

const REV_REC_WORDS: Record<string, string> = {
  PCT_COSTS_INCURRED: 'percent complete (cost to cost)',
  PCT_COMPLETE: 'percent complete',
  COMPLETED_CONTRACT: 'completed contract',
  MILESTONE: 'milestones',
};

const JOB_INDUSTRY_RE =
  /\b(construct\w*|contract\w*|build\w*|builder|remodel\w*|renovat\w*|roof\w*|plumb\w*|hvac|heating|cooling|electric\w*|mechanical|concrete|floor\w*|carpet|cabinet\w*|millwork|carpent\w*|paint\w*|landscap\w*|excavat\w*|develop\w*|homes?|interior\w*|design|install\w*|service|repair\w*|fabricat\w*|manufactur\w*|kitchen|bath|siding|window\w*|drywall|masonry|dealer\w*|equipment)\b/i;

export interface PreselectInput {
  name: string;
  industry: string | null;
  revRecMethod: string | null;
  jobCount: number;
  isManagementCompany?: boolean;
}

export interface PreselectResult {
  eligible: boolean;
  selected: boolean;
  reasons: string[];
}

export function preselectCompany(c: PreselectInput): PreselectResult {
  if (c.isManagementCompany) return { eligible: false, selected: false, reasons: ['Management company'] };
  const reasons: string[] = [];
  if (c.jobCount > 0) reasons.push(`${c.jobCount} ${c.jobCount === 1 ? 'job' : 'jobs'} already in Merit Books`);
  const method = (c.revRecMethod ?? '').toUpperCase();
  if ((JOB_REV_REC_METHODS as readonly string[]).includes(method)) {
    reasons.push(`Books recognizes revenue by ${REV_REC_WORDS[method]}`);
  }
  const m = c.industry ? JOB_INDUSTRY_RE.exec(c.industry) : null;
  if (m) reasons.push(`Industry in Books: "${c.industry!.trim()}"`);
  return { eligible: true, selected: reasons.length > 0, reasons };
}

/** Preselection for a list; when nothing qualifies, preselect every eligible company (nobody starts at zero). */
export function preselectCompanies<T extends PreselectInput & { id: string }>(list: T[]): Map<string, PreselectResult> {
  const out = new Map<string, PreselectResult>();
  for (const c of list) out.set(c.id, preselectCompany(c));
  const eligible = list.filter((c) => out.get(c.id)!.eligible);
  if (eligible.length > 0 && eligible.every((c) => !out.get(c.id)!.selected)) {
    for (const c of eligible) out.set(c.id, { eligible: true, selected: true, reasons: ['Nothing in Books says otherwise'] });
  }
  return out;
}

/** The pack Books' data points at, as a suggestion chip. Null when Books says nothing useful. */
export function booksGuess(c: { name: string; industry: string | null; revRecMethod: string | null; jobCount: number }): BooksGuess | null {
  const r = classify({ companyIndustry: c.industry ?? undefined, revRecMethod: c.revRecMethod ?? undefined, companyName: c.name });
  const top = r.candidates[0];
  if (!top || r.abstain) return null;
  const pack = getPack(top.packKey);
  if (!pack) return null;
  const reasons = [...top.reasons];
  if (c.jobCount > 0) reasons.push(`${c.jobCount} ${c.jobCount === 1 ? 'job' : 'jobs'} in Books`);
  return { packKey: top.packKey, label: pack.tile.label, confidence: Math.round(top.confidence * 100), reasons };
}

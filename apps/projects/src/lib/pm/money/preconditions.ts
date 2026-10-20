/**
 * Named billing preconditions (pm.billing_preconditions and the PRECONDITION_* raises in
 * 1102) → one plain sentence and where to fix it. Pure (unit-tested).
 *
 * `fix.tab` is a job-page tab; `fix.href` a page. Sentences are the Merit voice: what is
 * wrong, in the customer's terms, never the code.
 */
import type { JobTab } from '@/lib/pm/guards';

export interface PreconditionCopy {
  sentence: string;
  fix?: { label: string; tab?: JobTab; href?: string };
}

export const PRECONDITION_COPY: Readonly<Record<string, PreconditionCopy>> = {
  PRECONDITION_NOT_FOUND: { sentence: 'This billing request is no longer in this workspace.' },
  PRECONDITION_NOT_DRAFT: { sentence: 'It has already been approved; only drafts and rejected requests can be sent.' },
  PRECONDITION_NO_CUSTOMER: { sentence: 'The job has no customer for Merit Books to invoice.', fix: { label: 'Choose the customer', tab: 'overview' } },
  PRECONDITION_NO_CONTRACT: { sentence: 'The job has no active contract to bill against.', fix: { label: 'Set the contract', tab: 'contract' } },
  PRECONDITION_NO_LINES: { sentence: 'The request has no lines to bill.' },
  PRECONDITION_NONPOSITIVE: { sentence: 'The amount due is zero or less, so there is nothing to invoice.' },
  PRECONDITION_RETAINAGE_TIE: { sentence: 'The retainage line does not tie to the retainage on the lines; void this draft and draft it again.' },
  PRECONDITION_OVER_CONTRACT: { sentence: 'Billed to date would pass the revised contract; approve a change order first.', fix: { label: 'Review change orders', tab: 'change-orders' } },
  PRECONDITION_RETAINAGE_EXCEEDS_HELD: { sentence: 'The release is more than the retainage still held on this job.' },
  PRECONDITION_COMPLIANCE: { sentence: 'A required certificate of insurance or lien waiver on this job is missing or expired.', fix: { label: 'Open commitments', tab: 'commitments' } },
  PRECONDITION_DRAW: { sentence: 'The lender’s draw conditions, such as the inspection, are not met yet.', fix: { label: 'Open draws', href: '/draws' } },
  PRECONDITION_BOOKS_SEAM_V2: { sentence: 'Merit Books does not book retainage releases yet, so this release stays here until it does.' },
  PRECONDITION_NOTHING_TO_BILL: { sentence: 'There is nothing new to bill: earned to date is not above what has been billed.' },
  PRECONDITION_SOV_NOT_ACTIVE: { sentence: 'Activate the schedule of values before drafting a pay application.' },
  PRECONDITION_NO_RETAINAGE: { sentence: 'No retainage is outstanding on this job.' },
  PRECONDITION_DEPOSIT_EXCEEDS_CONTRACT: { sentence: 'Deposits requested would be more than the revised contract.' },
  PRECONDITION_ALLOWANCE_CO: { sentence: 'Approve the allowance change order before billing the overage.', fix: { label: 'Review change orders', tab: 'change-orders' } },
};

export function preconditionCopy(code: string): PreconditionCopy {
  return PRECONDITION_COPY[code] ?? { sentence: `A billing check (${code.replace(/^PRECONDITION_/, '').replace(/_/g, ' ').toLowerCase()}) is not met yet.` };
}

/** "PRECONDITION_FAILED: PRECONDITION_NO_CUSTOMER,PRECONDITION_OVER_CONTRACT" detail → codes. */
export function parsePreconditionList(detail: string): string[] {
  return detail.split(/[,\s]+/).map((s) => s.trim()).filter((s) => /^PRECONDITION_[A-Z0-9_]+$/.test(s));
}

/** Several failures → one paragraph ("The job has no customer… Billed to date would…"). */
export function preconditionsSentence(codes: ReadonlyArray<string>): string {
  if (codes.length === 0) return 'Ready to send.';
  return codes.map((c) => preconditionCopy(c).sentence).join(' ');
}

/** Link for a precondition's fix, relative to a job. */
export function preconditionFixHref(code: string, jobId: string): string | null {
  const f = preconditionCopy(code).fix;
  if (!f) return null;
  if (f.href) return f.href;
  return `/jobs/${jobId}?tab=${f.tab ?? 'overview'}`;
}

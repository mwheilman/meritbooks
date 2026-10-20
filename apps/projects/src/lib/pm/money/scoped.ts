import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Scope } from '@/lib/scope';
import { scopedJobs } from '@/lib/pm/scoped';
import { listCommitmentStatus, listCommitments, vendorNames } from './queries';
import { commitmentTotals, totalsFor, type CommitmentTotals } from './summaries';
import type { CommitmentStatus, CommitmentType } from './types';

export interface ScopedCommitmentRow {
  id: string;
  number: string;
  type: CommitmentType;
  title: string | null;
  status: CommitmentStatus;
  vendorId: string | null;
  vendorName: string | null;
  jobId: string;
  jobLabel: string;
  company: string | null;
  retainagePct: number;
  createdBy: string | null;
  approvedAt: string | null;
  holdReason: string | null;
  t: CommitmentTotals;
}

/** Commitments in the scope's companies with their v_commitment_status totals and job labels. */
export async function scopedCommitments(db: SupabaseClient, scope: Scope, statuses?: ReadonlyArray<CommitmentStatus>): Promise<ScopedCommitmentRow[]> {
  const [jobs, commitments] = await Promise.all([scopedJobs(db, scope), listCommitments(db, { companyIds: scope.companyIds, statuses })]);
  const inScope = commitments.filter((c) => jobs.byId.has(c.job_id));
  const [status, names] = await Promise.all([
    listCommitmentStatus(db, { companyIds: scope.companyIds, commitmentIds: inScope.map((c) => c.id) }),
    vendorNames(db, inScope.map((c) => c.vendor_id)),
  ]);
  const totals = commitmentTotals(status);
  return inScope.map((c) => ({
    id: c.id, number: c.number, type: c.commitment_type, title: c.title, status: c.status, vendorId: c.vendor_id,
    vendorName: (c.vendor_id && names[c.vendor_id]) || totals.get(c.id)?.vendorName || null,
    jobId: c.job_id, jobLabel: jobs.label(c.job_id) ?? 'Job', company: jobs.company(c.job_id), retainagePct: c.retainage_pct,
    createdBy: c.created_by, approvedAt: c.approved_at, holdReason: c.hold_reason, t: totalsFor(totals, c),
  }));
}

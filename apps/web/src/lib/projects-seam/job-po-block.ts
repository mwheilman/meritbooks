/**
 * G14 (migration 194): when a client uses Merit Projects, Projects owns job purchase orders
 * (commitments) — Books does not create purchase_orders for job-tagged spend for that client;
 * it matches the vendor's bills to the Projects commitment. Non-job POs, and clients without
 * Projects, keep Books POs exactly as before. The DB trigger `guard_job_po_projects` enforces
 * the same rule for any writer; this helper gives the API a clear, linkable message first.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { hasModule } from '@/lib/services/entitlements';

export const JOB_PO_BLOCK_CODE = 'JOB_PO_OWNED_BY_PROJECTS';

/** Where a person creates the commitment instead (Merit Projects, Commitments). */
export function projectsCommitmentsUrl(): string {
  const base = (process.env.NEXT_PUBLIC_PROJECTS_URL ?? '').replace(/\/+$/, '');
  return `${base || ''}/commitments`;
}

export interface JobPoBlock {
  error: string;
  code: typeof JOB_PO_BLOCK_CODE;
  projects_url: string;
}

/** null = allowed. A body for a 409 when any line names a job and the org uses Projects. */
export async function jobPoBlock(db: SupabaseClient, orgId: string, lineJobIds: ReadonlyArray<string | null | undefined>): Promise<JobPoBlock | null> {
  if (!lineJobIds.some((j) => !!j)) return null;
  if (!(await hasModule(db, orgId, 'projects').catch(() => false))) return null;
  return {
    error:
      'This company uses Merit Projects, so job purchase orders are created there (Projects › Commitments). ' +
      'Books matches the vendor bills to those commitments automatically. Remove the job from the lines to raise a non-job PO here.',
    code: JOB_PO_BLOCK_CODE,
    projects_url: projectsCommitmentsUrl(),
  };
}

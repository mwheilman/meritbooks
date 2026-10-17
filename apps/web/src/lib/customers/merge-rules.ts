/**
 * Ownership-matrix decision for core.jobs.customer_id (a Core-identity FK). Books
 * may re-point it only when it owns core.jobs — i.e. the tenant is standalone
 * (Projects NOT entitled). Pure so the rule is unit-testable.
 */
export function shouldRepointJobs(projectsEntitled: boolean, jobsReferencing: number): boolean {
  return !projectsEntitled && jobsReferencing > 0;
}

export const dynamic = 'force-dynamic';

/**
 * RETIRED standalone unbilled (1180) accrual — an ALIAS into the canonical month-end WIP step
 * (FPB-rev-rec-wip §4: "retire the standalone manual accrual or make it an alias into the
 * unified step"). Underbillings are now booked by the WIP run's self-reversing entry; this
 * path previews / proposes exactly that. Same contract as /api/rev-rec/run.
 */
export { GET, POST } from '../run/route';

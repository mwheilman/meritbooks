export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { listOpenReviews } from '@/lib/crm/duplicates';

/** Open pairs in the shared duplicate queue (core.duplicate_reviews), strongest first. */
export const GET = route({ access: { cap: 'projects.customers', action: 'view' }, mask: false }, async ({ db }) => ({ reviews: await listOpenReviews(db) }));

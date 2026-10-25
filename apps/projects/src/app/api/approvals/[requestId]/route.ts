export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { loadRequest } from '@/lib/approvals/server';

/** GET /api/approvals/:id — one request: chain, history, context (money masked by the engine). */
export const GET = route({ access: 'none', mask: false }, async ({ db, params }) => loadRequest(db, params.requestId!));

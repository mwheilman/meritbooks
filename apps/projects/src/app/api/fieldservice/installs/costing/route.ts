import { z } from 'zod';
import { route } from '@/lib/api';
import { fsCall } from '@/lib/fieldservice/rpc';
import type { InstallCosting } from '@/lib/fieldservice/completion-types';
import { Uuid } from '@/lib/pm/ops/schemas';

/**
 * GET /api/fieldservice/installs/costing?projectId= — estimated vs actual (FS-85): estimate cost by
 * category against Books job cost (pending + cleared), committed POs, billed, margin and the
 * variances in plain words. Needs job financials (guarded in the RPC); the strict money mask stays
 * on, so a cost-only persona never sees the contract figures.
 */
export const GET = route({ access: { cap: 'projects.financials', action: 'view' }, query: z.object({ projectId: Uuid }) }, async ({ db, query }) =>
  fsCall<InstallCosting>(db, 'fs_install_costing', { p_project: query.projectId }));

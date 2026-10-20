export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { searchCustomers } from '@/lib/pm/people';

/** Customer picker (core.customers via RLS). */
export const GET = route(
  { query: z.object({ q: z.string().max(80).default(''), companyId: z.string().uuid().optional() }) },
  async ({ db, query }) => ({ customers: (await searchCustomers(db, query.q, query.companyId ?? null, 8)).map((c) => ({ id: c.id, name: c.display_name || c.name })) }),
);

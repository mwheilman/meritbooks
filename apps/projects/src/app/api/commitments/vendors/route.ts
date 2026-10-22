export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { searchVendors } from '@/lib/pm/money/queries';

/** Vendor picker over core.vendors (RLS). default_retainage_pct is a percent; the client converts it. */
export const GET = route({ access: { cap: 'projects.commitments', action: 'view' }, mask: false, query: z.object({ q: z.string().max(80).default('') }) }, async ({ db, query }) => ({
  vendors: (await searchVendors(db, query.q, 8)).map((v) => ({
    id: v.id, name: v.display_name || v.name, email: v.email, city: v.city,
    retainagePct: v.default_retainage_pct != null ? Math.min(Math.max(Number(v.default_retainage_pct), 0), 100) / 100 : 0,
  })),
}));

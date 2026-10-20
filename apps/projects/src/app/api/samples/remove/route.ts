import { z } from 'zod';
import { assertCompany, must, route } from '@/lib/api';

/** Remove a company's sample job (referenced ones are cancelled instead, by the function). */
export const POST = route({ body: z.object({ companyId: z.string().uuid() }) }, async ({ db, body, tenant }) => {
  assertCompany(tenant, body.companyId);
  const out = must(await db.schema('pm').rpc('remove_sample_data', { p_location: body.companyId }), 'remove sample') as { removed: number; cancelled: number } | null;
  return { removed: out?.removed ?? 0, cancelled: out?.cancelled ?? 0 };
});

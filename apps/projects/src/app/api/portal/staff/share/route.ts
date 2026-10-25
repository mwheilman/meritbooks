export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { shareDocument } from '@/lib/portal/staff';

/** POST — share a document with portal audiences ([] = stop sharing). Cost documents never reach customers / investors. */
const Body = z.object({ fileId: z.string().uuid(), audiences: z.array(z.enum(['customer', 'vendor', 'lender', 'investor'])).max(4) });

export const POST = route({ access: { cap: 'projects.documents', action: 'edit' }, mask: false, body: Body }, async ({ db, body }) => ({
  ok: true, audiences: await shareDocument(db, body.fileId, body.audiences),
}));

export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { sheetDetail } from '@/lib/documents/drawings';

/** GET /api/documents/drawings/sheets/:sheetId — the sheet and every revision (current first; signed links, 1 h). */
export const GET = route({ access: { cap: 'projects.documents', action: 'view' }, mask: false }, async ({ db, params }) => sheetDetail(db, params.sheetId!));

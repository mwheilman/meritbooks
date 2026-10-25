export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { NO_STORE, portalHandler, portalJson } from '@/lib/portal/http';
import { portalRpc } from '@/lib/portal/db';
import { isPortalObjectPath, portalStorage } from '@/lib/portal/storage';
import { isUuid } from '@/lib/portal/tokens';

/**
 * PUBLIC (session cookie): GET ?orgId&kind=document|photo|upload&id — one object the person may see.
 * portal.file_grant re-checks access and mints a 2-minute read of that one key; the bytes come
 * through here on the anon key and are never cached.
 */
export const GET = portalHandler({}, async ({ req, session }) => {
  const p = req.nextUrl.searchParams;
  const org = p.get('orgId'); const kind = p.get('kind'); const id = p.get('id');
  if (!isUuid(org) || !isUuid(id) || !['document', 'photo', 'upload'].includes(kind ?? '')) return portalJson(404, { error: 'Not found.', code: 'forbidden' });
  const g = await portalRpc<{ path: string; file_name: string; mime_type: string }>('file_grant', { p_session: session, p_org: org, p_kind: kind, p_id: id });
  if (!isPortalObjectPath(g.path, org)) return portalJson(404, { error: 'Not found.', code: 'forbidden' });
  const bytes = await portalStorage().download(g.path);
  if (!bytes) return portalJson(503, { error: 'The file is not available right now.', code: 'unavailable' });
  const safe = (g.file_name || 'file').replace(/[^\w .()-]+/g, '_').slice(0, 120);
  const type = /^(application\/pdf|image\/(jpeg|png|webp|heic))$/.test(g.mime_type) ? g.mime_type : 'application/octet-stream';
  return new NextResponse(bytes, {
    status: 200,
    headers: { ...NO_STORE, 'Content-Type': type, 'Content-Disposition': `inline; filename="${safe}"`, 'X-Content-Type-Options': 'nosniff',
               'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox" },
  });
});

import 'server-only';
/** Shared glue for the /api/field routes: the FieldCtx from route()'s context, and HTTP answers. */
import { NextResponse } from 'next/server';
import type { RouteContext } from '@/lib/api';
import { APP_TZ } from '@/lib/time';
import type { CommandResult } from './contract';
import type { FieldCtx } from './apply';
import { createFieldStore } from './store';

export function fieldCtx<B, Q>(rc: RouteContext<B, Q>): FieldCtx {
  const names = new Map(rc.tenant.companies.map((c) => [c.id, c.name]));
  return {
    store: createFieldStore(rc.db, { userId: rc.userId, orgId: rc.tenant.orgId }),
    access: rc.access,
    userId: rc.userId,
    orgId: rc.tenant.orgId,
    companyName: (id) => names.get(id) ?? null,
    now: new Date(),
    defaultTz: APP_TZ,
  };
}

/**
 * One command's answer on the single-command routes: applied/duplicate 200, refused 403/422,
 * passing failure 503 (the phone keeps it and retries). The body is always the CommandResult.
 */
export function commandResponse(r: CommandResult): NextResponse {
  const status = r.outcome === 'applied' || r.outcome === 'duplicate' ? 200
    : r.outcome === 'retry' ? 503
    : r.code === 'FORBIDDEN' || r.code === 'PUNCH_NOT_ALLOWED' || r.code === 'CREW_CLOCK_NOT_ALLOWED' ? 403
    : 422;
  return NextResponse.json(r, { status, headers: { 'Cache-Control': 'no-store' } });
}

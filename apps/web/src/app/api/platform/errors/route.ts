/**
 * GET  /api/platform/errors  — ops-health read model (grouped by digest)
 * PATCH /api/platform/errors — resolve / re-open a group (or a single row)
 *
 * Cross-tenant by design (the operator sees failures across every tenant), so it
 * runs on the admin (service-role) client — but ONLY after the request is
 * confirmed to be PLATFORM STAFF. Non-staff → 403, unauthenticated → 401. Fails
 * closed, mirroring /api/platform/overview.
 *
 * Grouping is done in JS over a bounded recent window (Supabase JS has no GROUP
 * BY): fetch the most-recent N rows in the window, fold by digest, and return
 * counts + first/last-seen + a sample. A separate pair of head-count queries
 * gives the 24h / 7d error-rate summary.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/server';
import { resolvePlatformStaff } from '../_lib/platform-auth';

const DAY_MS = 86_400_000;
const WINDOW_DAYS: Record<string, number> = { '24h': 1, '7d': 7, '30d': 30 };
const LEVELS = new Set(['ERROR', 'WARN', 'FATAL']);
const SOURCES = new Set(['api', 'ui', 'job', 'webhook']);
const SEVERITY: Record<string, number> = { WARN: 1, ERROR: 2, FATAL: 3 };
const FETCH_CAP = 5000;

interface LogRow {
  id: string;
  org_id: string | null;
  occurred_at: string;
  level: string;
  source: string;
  route: string | null;
  message: string;
  digest: string | null;
  resolved: boolean;
  user_id: string | null;
}

export interface ErrorGroup {
  digest: string;
  count: number;
  level: string; // most severe level seen in the group
  source: string;
  route: string | null;
  message: string; // latest occurrence's (scrubbed) message
  firstSeen: string;
  lastSeen: string;
  resolved: boolean; // true only if every occurrence in-window is resolved
  affectedOrgs: number;
  sampleId: string;
}

async function gate(): Promise<NextResponse | null> {
  const { clerkUserId, isPlatformStaff } = await resolvePlatformStaff();
  if (!clerkUserId) return NextResponse.json({ error: 'Unauthorized', code: 'UNAUTHENTICATED' }, { status: 401 });
  if (!isPlatformStaff) {
    return NextResponse.json({ error: 'Forbidden — platform staff only', code: 'NOT_PLATFORM_STAFF' }, { status: 403 });
  }
  return null;
}

export async function GET(req: Request) {
  const denied = await gate();
  if (denied) return denied;

  const { searchParams } = new URL(req.url);
  const windowKey = WINDOW_DAYS[searchParams.get('window') ?? '7d'] ? (searchParams.get('window') as string) : '7d';
  const days = WINDOW_DAYS[windowKey] ?? 7;
  const levelParam = searchParams.get('level');
  const level = levelParam && LEVELS.has(levelParam) ? levelParam : null;
  const sourceParam = searchParams.get('source');
  const source = sourceParam && SOURCES.has(sourceParam) ? sourceParam : null;
  const routeQ = (searchParams.get('route') ?? '').trim().slice(0, 200);
  const status = searchParams.get('status') ?? 'open'; // open | resolved | all

  const sinceIso = new Date(Date.now() - days * DAY_MS).toISOString();

  try {
    const admin = createAdminSupabase();

    let q = admin
      .from('app_error_log')
      .select('id, org_id, occurred_at, level, source, route, message, digest, resolved, user_id')
      .gte('occurred_at', sinceIso)
      .order('occurred_at', { ascending: false })
      .limit(FETCH_CAP);
    if (level) q = q.eq('level', level);
    if (source) q = q.eq('source', source);
    if (routeQ) q = q.ilike('route', `%${routeQ}%`);
    if (status === 'open') q = q.eq('resolved', false);
    else if (status === 'resolved') q = q.eq('resolved', true);

    const { data, error } = await q;
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as LogRow[];

    // Fold by digest (fall back to a synthetic key when digest is null).
    const map = new Map<string, { g: ErrorGroup; orgs: Set<string>; allResolved: boolean }>();
    const byLevel: Record<string, number> = { WARN: 0, ERROR: 0, FATAL: 0 };
    for (const r of rows) {
      if (r.level in byLevel) byLevel[r.level] += 1;
      const key = r.digest ?? `nodigest:${r.level}:${r.route ?? ''}:${r.message.slice(0, 60)}`;
      const existing = map.get(key);
      if (!existing) {
        map.set(key, {
          g: {
            digest: r.digest ?? key,
            count: 1,
            level: r.level,
            source: r.source,
            route: r.route,
            message: r.message, // rows are DESC → first seen is the latest occurrence
            firstSeen: r.occurred_at,
            lastSeen: r.occurred_at,
            resolved: r.resolved,
            affectedOrgs: 0,
            sampleId: r.id,
          },
          orgs: new Set(r.org_id ? [r.org_id] : []),
          allResolved: r.resolved,
        });
      } else {
        existing.g.count += 1;
        if ((SEVERITY[r.level] ?? 0) > (SEVERITY[existing.g.level] ?? 0)) existing.g.level = r.level;
        if (r.occurred_at < existing.g.firstSeen) existing.g.firstSeen = r.occurred_at;
        if (r.occurred_at > existing.g.lastSeen) existing.g.lastSeen = r.occurred_at;
        if (r.org_id) existing.orgs.add(r.org_id);
        existing.allResolved = existing.allResolved && r.resolved;
      }
    }

    const groups: ErrorGroup[] = [...map.values()]
      .map(({ g, orgs, allResolved }) => ({ ...g, affectedOrgs: orgs.size, resolved: allResolved }))
      .sort((a, b) => {
        const sev = (SEVERITY[b.level] ?? 0) - (SEVERITY[a.level] ?? 0);
        if (sev !== 0) return sev;
        if (b.count !== a.count) return b.count - a.count;
        return b.lastSeen.localeCompare(a.lastSeen);
      });

    // Error-rate summary (open events only, independent of the current filters).
    const [c24, c7] = await Promise.all([
      admin
        .from('app_error_log')
        .select('id', { count: 'exact', head: true })
        .gte('occurred_at', new Date(Date.now() - DAY_MS).toISOString())
        .eq('resolved', false),
      admin
        .from('app_error_log')
        .select('id', { count: 'exact', head: true })
        .gte('occurred_at', new Date(Date.now() - 7 * DAY_MS).toISOString())
        .eq('resolved', false),
    ]);

    return NextResponse.json({
      window: { key: windowKey, days, since: sinceIso },
      filters: { level, source, route: routeQ || null, status },
      summary: {
        totalEvents: rows.length,
        distinctIssues: groups.length,
        capped: rows.length >= FETCH_CAP,
        byLevel,
        openLast24h: c24.count ?? 0,
        openLast7d: c7.count ?? 0,
      },
      groups,
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[platform/errors]', e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Failed to load error log', code: 'INTERNAL_ERROR' },
      { status: 500 },
    );
  }
}

interface PatchBody {
  digest?: unknown;
  id?: unknown;
  resolved?: unknown;
}

export async function PATCH(req: Request) {
  const denied = await gate();
  if (denied) return denied;

  let body: PatchBody = {};
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'PARSE_ERROR' }, { status: 400 });
  }

  const resolved = body.resolved === true;
  const digest = typeof body.digest === 'string' && body.digest ? body.digest : null;
  const id = typeof body.id === 'string' && body.id ? body.id : null;
  if (!digest && !id) {
    return NextResponse.json(
      { error: 'Provide a `digest` (group) or `id` (single row) to update', code: 'VALIDATION_ERROR' },
      { status: 422 },
    );
  }

  try {
    const admin = createAdminSupabase();
    let upd = admin.from('app_error_log').update({ resolved }).select('id');
    upd = digest ? upd.eq('digest', digest) : upd.eq('id', id as string);
    const { data, error } = await upd;
    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true, resolved, updated: (data ?? []).length });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[platform/errors PATCH]', e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Failed to update', code: 'INTERNAL_ERROR' },
      { status: 500 },
    );
  }
}

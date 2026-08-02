export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { z } from 'zod';
import {
  getLearnedPreference,
  listPreferences,
  recordObservation,
  clearPreference,
  type PreferenceScope,
} from '@/lib/learning/preferences';

/**
 * The generic learned-preference / memory store surface (M14, generalized).
 *
 *   GET    ?scope&key   → the learned winner for one preference (resolved).
 *   GET    ?scope       → all learned preferences in a scope (for a settings view).
 *   GET                 → every learned preference for the org.
 *   POST   {scope,key,sample} → record ONE observation of the user's choice; the
 *                               store re-derives the typical value + confidence.
 *   DELETE ?scope&key   → forget one learned preference.
 *
 * Learning INFORMS defaults; it never auto-acts (canon §3). Writes are restricted to
 * client-safe, personalization-only scopes — server-derived learnings such as
 * CLOSE_CADENCE are recorded server-side (close orchestration), never by the client.
 * Everything is org-scoped by RLS + an explicit org filter, and DEGRADE-SAFE: if the
 * table is absent, reads return empty and writes no-op.
 */

// Scopes a browser client may write via this route (pure personalization).
const WRITABLE_SCOPES = ['REPORT_PREFS', 'TONE'] as const;
type WritableScope = (typeof WRITABLE_SCOPES)[number];

const scopeParam = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[A-Z0-9_]+$/, 'scope must be an UPPER_SNAKE namespace');
const keyParam = z.string().min(1).max(200);

export async function GET(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  const { searchParams } = new URL(request.url);
  const scopeRaw = searchParams.get('scope');
  const keyRaw = searchParams.get('key');

  const scope = scopeRaw ? scopeParam.safeParse(scopeRaw) : null;
  if (scopeRaw && !scope?.success) {
    return NextResponse.json({ error: 'Invalid scope', code: 'BAD_REQUEST' }, { status: 422 });
  }

  // Single learned preference.
  if (scopeRaw && keyRaw) {
    const key = keyParam.safeParse(keyRaw);
    if (!key.success) return NextResponse.json({ error: 'Invalid key', code: 'BAD_REQUEST' }, { status: 422 });
    const pref = await getLearnedPreference(supabase, orgId, scopeRaw as PreferenceScope, key.data);
    return NextResponse.json(pref ?? { value: null, confidence: 0, observations: 0 });
  }

  // A scope (or the whole store) → a list for a management view.
  const prefs = await listPreferences(supabase, orgId, scopeRaw ? (scopeRaw as PreferenceScope) : undefined);
  return NextResponse.json({ preferences: prefs });
}

const postSchema = z.object({
  scope: z.enum(WRITABLE_SCOPES),
  key: keyParam,
  // A flat object (or scalar) describing the observed choice — kept as jsonb.
  sample: z.union([
    z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
    z.string(),
    z.number(),
    z.boolean(),
  ]),
});

export async function POST(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const parsed = postSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Validation failed', code: 'VALIDATION_ERROR' },
      { status: 422 },
    );
  }
  const { scope, key, sample } = parsed.data;
  const ok = await recordObservation(supabase, orgId, scope as WritableScope, key, sample);
  // A false here is the degrade-safe path (store absent) — not an error the user acts on.
  return NextResponse.json({ ok });
}

export async function DELETE(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  const { searchParams } = new URL(request.url);
  const scope = scopeParam.safeParse(searchParams.get('scope'));
  const key = keyParam.safeParse(searchParams.get('key'));
  if (!scope.success || !key.success) {
    return NextResponse.json({ error: 'scope and key are required', code: 'BAD_REQUEST' }, { status: 422 });
  }
  const ok = await clearPreference(supabase, orgId, scope.data as PreferenceScope, key.data);
  return NextResponse.json({ ok });
}
